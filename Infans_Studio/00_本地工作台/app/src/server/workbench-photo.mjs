import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { parseByteRange } from "./workbench-music.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_PHOTO_LIBRARY_DIR = "";
export const DEFAULT_PHOTO_CACHE_DIR = "";
export const DEFAULT_PHOTO_INDEX_DIR = "";

const IMAGE_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".hif", "image/heif"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".bmp", "image/bmp"],
]);
const VIDEO_TYPES = new Map([
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
]);
const LIVE_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".heic", ".heif", ".hif"]);
const LIVE_VIDEO_EXTENSIONS = new Set([".mov"]);
const SKIP_DIRECTORIES = new Set(["@eaDir", "#recycle", "#snapshot"]);
// 索引是永久的本机派生数据：普通浏览永远读现有索引，不按时间自动重扫 NAS。
// 新照片只由界面上的“检查更新”做目录级增量合并；完整重建必须明确请求。
const PHOTO_INDEX_VERSION = 2;
const DEFAULT_PAGE_SIZE = 144;
const MAX_PAGE_SIZE = 240;
const THUMBNAIL_SIZES = Object.freeze({ small: 320, medium: 720, large: 2048 });
const THUMBNAIL_CONCURRENCY = 3;
const MAX_PHOTO_ACTION_ITEMS = 500;

const memoryIndexes = new Map();
const thumbnailPromises = new Map();
const thumbnailQueue = [];
let activeThumbnailJobs = 0;

function photoError(message, status = 400, code = "PHOTO_LIBRARY_ERROR") {
  return new WorkbenchWriteError(message, status, code);
}

function photoScanError() {
  return photoError("相册未能完整读取，已保留原索引。连接恢复后请再检查更新。", 503, "PHOTO_SCAN_INCOMPLETE");
}

function stableId(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function cacheKey(libraryDir, cacheDir) {
  return `${path.resolve(libraryDir)}\0${path.resolve(cacheDir)}`;
}

export function photoIndexPath(libraryDir, cacheDir) {
  if (!DEFAULT_PHOTO_CACHE_DIR) {
    return path.join(cacheDir || ".", `index-${stableId(path.resolve(libraryDir || "."))}.json`);
  }
  const indexDir = path.resolve(cacheDir) === path.resolve(DEFAULT_PHOTO_CACHE_DIR)
    ? DEFAULT_PHOTO_INDEX_DIR
    : cacheDir;
  return path.join(indexDir, `index-${stableId(path.resolve(libraryDir))}.json`);
}

function legacyPhotoIndexPath(libraryDir, cacheDir) {
  return path.join(cacheDir, `index-${stableId(path.resolve(libraryDir))}.json`);
}

export function normalizePhotoPath(value = "") {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.includes("\0") || raw.includes("\\") || path.isAbsolute(raw)) {
    throw photoError("照片路径不合法", 400, "PHOTO_PATH_INVALID");
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw photoError("照片路径越过了相册边界", 400, "PHOTO_PATH_OUTSIDE");
  }
  return normalized === "." ? "" : normalized;
}

function mediaType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (IMAGE_TYPES.has(extension)) return { kind: "image", extension, mime: IMAGE_TYPES.get(extension) };
  if (VIDEO_TYPES.has(extension)) return { kind: "video", extension, mime: VIDEO_TYPES.get(extension) };
  return null;
}

function yearMonthFromFolder(relativePath) {
  const parts = path.posix.dirname(relativePath).split("/").filter(Boolean);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (/^20\d{2}$/.test(parts[index]) && /^(?:0[1-9]|1[0-2])$/.test(parts[index + 1])) {
      return `${parts[index]}-${parts[index + 1]}`;
    }
  }
  return "";
}

function capturedAtFor(relativePath, info) {
  const modified = Number.isFinite(info.mtimeMs) ? new Date(info.mtimeMs) : new Date();
  const folderMonth = yearMonthFromFolder(relativePath);
  if (!folderMonth) return { capturedAt: modified.toISOString(), dateSource: "modified" };
  const modifiedMonth = `${modified.getFullYear()}-${String(modified.getMonth() + 1).padStart(2, "0")}`;
  if (modifiedMonth === folderMonth) return { capturedAt: modified.toISOString(), dateSource: "modified" };
  const day = Math.min(Math.max(modified.getDate(), 1), 28);
  return { capturedAt: `${folderMonth}-${String(day).padStart(2, "0")}T12:00:00.000Z`, dateSource: "folder" };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

async function collectCandidateFiles(libraryReal) {
  const candidates = [];
  const stack = [{ absolute: libraryReal, relative: "", depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > 32) continue;
    let rows;
    try {
      rows = await fs.readdir(current.absolute, { withFileTypes: true });
    } catch {
      throw photoScanError();
    }
    for (const row of rows) {
      if (!row.name || row.name.startsWith(".") || row.isSymbolicLink()) continue;
      if (SKIP_DIRECTORIES.has(row.name)) continue;
      const relative = [current.relative, row.name].filter(Boolean).join("/");
      const absolute = path.join(current.absolute, row.name);
      if (row.isDirectory()) {
        stack.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      const type = row.isFile() ? mediaType(row.name) : null;
      if (type) candidates.push({ absolute, relative, type });
    }
  }
  return candidates;
}

function shouldIndexRelativePath(relative) {
  if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) return false;
  const parts = relative.split("/").filter(Boolean);
  if (!parts.length || parts.length > 32) return false;
  return !parts.some((part) => part.startsWith(".") || SKIP_DIRECTORIES.has(part));
}

async function collectCandidateFileStatsNative(libraryReal) {
  if (process.platform !== "darwin") return null;
  const phoneRoot = path.join(libraryReal, "MobileBackup", "iPhone");
  let yearRoots = [];
  try {
    yearRoots = (await fs.readdir(phoneRoot, { withFileTypes: true }))
      .filter((row) => row.isDirectory() && /^20\d{2}$/.test(row.name))
      .map((row) => path.join(phoneRoot, row.name));
  } catch {
    yearRoots = [];
  }
  const findArguments = (root, extraPrunes = []) => {
    const prunes = [
      ["-name", ".*"],
      ...[...SKIP_DIRECTORIES].map((name) => ["-name", name]),
      ...extraPrunes.map((absolute) => ["-path", absolute]),
    ];
    const pruneExpression = prunes.flatMap((predicate, index) => index ? ["-o", ...predicate] : predicate);
    return [
      "-x", root,
      "(", ...pruneExpression, ")", "-prune", "-o",
      "-type", "f",
      "-exec", "/usr/bin/stat", "-f", "%N%t%z%t%m", "{}", "+",
    ];
  };
  const jobs = yearRoots.length
    ? [findArguments(libraryReal, yearRoots), ...yearRoots.map((root) => findArguments(root))]
    : [findArguments(libraryReal)];
  const outputs = await mapWithConcurrency(jobs, 2, async (args) => {
    const result = await execFileAsync("/usr/bin/find", args, {
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  });
  const rows = [];
  for (const line of outputs.join("").split("\n")) {
    const mtimeSeparator = line.lastIndexOf("\t");
    const sizeSeparator = line.lastIndexOf("\t", mtimeSeparator - 1);
    if (sizeSeparator < 1 || mtimeSeparator <= sizeSeparator) continue;
    const absolute = line.slice(0, sizeSeparator);
    const relative = path.relative(libraryReal, absolute).split(path.sep).join("/");
    if (!shouldIndexRelativePath(relative)) continue;
    const type = mediaType(relative);
    if (!type) continue;
    const size = Number.parseInt(line.slice(sizeSeparator + 1, mtimeSeparator), 10);
    const modifiedSeconds = Number.parseInt(line.slice(mtimeSeparator + 1), 10);
    if (!Number.isFinite(size) || !Number.isFinite(modifiedSeconds)) continue;
    rows.push({
      absolute,
      relative,
      type,
      info: { size, mtimeMs: modifiedSeconds * 1000 },
    });
  }
  return rows;
}

function baseItem(file) {
  const normalizedName = path.basename(file.relative).normalize("NFC");
  const folder = path.posix.dirname(file.relative);
  const date = capturedAtFor(file.relative, file.info);
  return {
    id: stableId(file.relative),
    name: normalizedName,
    folder: folder === "." ? "" : folder.normalize("NFC"),
    kind: file.type.kind,
    bytes: file.info.size,
    capturedAt: date.capturedAt,
    dateSource: date.dateSource,
    format: file.type.extension.slice(1).toUpperCase(),
    screenshot: file.type.extension === ".png" || /(?:screenshot|截屏|截图|スクリーンショット)/iu.test(normalizedName),
    imagePath: file.type.kind === "image" ? file.relative : "",
    videoPath: file.type.kind === "video" ? file.relative : "",
    sourceMtimeMs: file.info.mtimeMs,
  };
}

export function pairPhotoMedia(files) {
  const byStem = new Map();
  const consumed = new Set();
  for (const file of files) {
    const extension = file.type.extension;
    if (!LIVE_IMAGE_EXTENSIONS.has(extension) && !LIVE_VIDEO_EXTENSIONS.has(extension)) continue;
    const folder = path.posix.dirname(file.relative);
    const baseName = path.basename(file.relative);
    const stem = baseName.slice(0, -extension.length).normalize("NFC").toLocaleLowerCase("en-US");
    const key = `${folder}/${stem}`;
    const bucket = byStem.get(key) || { images: [], videos: [] };
    (file.type.kind === "image" ? bucket.images : bucket.videos).push(file);
    byStem.set(key, bucket);
  }

  const items = [];
  for (const bucket of byStem.values()) {
    if (!bucket.images.length || !bucket.videos.length) continue;
    const image = bucket.images.toSorted((left, right) => right.info.size - left.info.size)[0];
    const video = bucket.videos.toSorted((left, right) => right.info.size - left.info.size)[0];
    consumed.add(image.relative);
    consumed.add(video.relative);
    const item = baseItem(image);
    items.push({
      ...item,
      kind: "live",
      bytes: image.info.size + video.info.size,
      format: `${item.format} + ${video.type.extension.slice(1).toUpperCase()}`,
      videoPath: video.relative,
      sourceMtimeMs: Math.max(image.info.mtimeMs, video.info.mtimeMs),
    });
  }
  for (const file of files) {
    if (!consumed.has(file.relative)) items.push(baseItem(file));
  }
  items.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)
    || left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
  return items;
}

function addDirectoryAndAncestors(target, relative = "") {
  target.add("");
  const parts = String(relative || "").split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    target.add(current);
  }
}

function directoryPathsForIndex(index) {
  const paths = new Set([""]);
  for (const entry of Array.isArray(index?.directories) ? index.directories : []) {
    if (typeof entry?.path === "string") addDirectoryAndAncestors(paths, entry.path);
  }
  for (const item of Array.isArray(index?.items) ? index.items : []) {
    addDirectoryAndAncestors(paths, item.folder);
  }
  return paths;
}

function absolutePhotoDirectory(libraryReal, relative = "") {
  return path.join(libraryReal, ...String(relative || "").split("/").filter(Boolean));
}

async function statPhotoDirectories(libraryReal, relativePaths) {
  const rows = await mapWithConcurrency([...relativePaths], 12, async (relative) => {
    try {
      const info = await fs.stat(absolutePhotoDirectory(libraryReal, relative));
      return info.isDirectory() ? [relative, info.mtimeMs] : [relative, null];
    } catch (error) {
      // 只有明确不存在才视为删除；断线、权限与 I/O 故障不能清空旧年份。
      if (error?.code === "ENOENT") return [relative, null];
      throw photoScanError();
    }
  });
  return new Map(rows);
}

async function scanDirectPhotoDirectory(libraryReal, relative = "") {
  const absolute = absolutePhotoDirectory(libraryReal, relative);
  let rows;
  try {
    rows = await fs.readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { relative, exists: false, childDirectories: [], files: [] };
    throw photoScanError();
  }
  const childDirectories = [];
  const candidates = [];
  for (const row of rows) {
    if (!row.name || row.name.startsWith(".") || row.isSymbolicLink() || SKIP_DIRECTORIES.has(row.name)) continue;
    const childRelative = [relative, row.name].filter(Boolean).join("/");
    if (row.isDirectory()) {
      childDirectories.push(childRelative);
      continue;
    }
    const type = row.isFile() ? mediaType(row.name) : null;
    if (type) candidates.push({ absolute: path.join(absolute, row.name), relative: childRelative, type });
  }
  const files = await mapWithConcurrency(candidates, 6, async (candidate) => {
    try {
      const info = await fs.stat(candidate.absolute);
      return info.isFile() ? { ...candidate, info } : null;
    } catch {
      throw photoScanError();
    }
  });
  return {
    relative,
    exists: true,
    childDirectories,
    files: files.filter(Boolean),
  };
}

async function scanNewPhotoDirectoryTree(libraryReal, roots, knownDirectories) {
  const queue = [...roots];
  const visited = new Set();
  const results = [];
  while (queue.length) {
    const relative = queue.shift();
    if (visited.has(relative) || relative.split("/").filter(Boolean).length > 32) continue;
    visited.add(relative);
    const result = await scanDirectPhotoDirectory(libraryReal, relative);
    if (!result.exists) continue;
    results.push(result);
    for (const child of result.childDirectories) {
      if (!knownDirectories.has(child)) queue.push(child);
    }
  }
  return results;
}

function folderIsInside(folder, parent) {
  return folder === parent || Boolean(parent && folder.startsWith(`${parent}/`));
}

function sameIndexedItem(left, right) {
  return left.name === right.name
    && left.folder === right.folder
    && left.kind === right.kind
    && left.bytes === right.bytes
    && left.capturedAt === right.capturedAt
    && left.format === right.format
    && left.screenshot === right.screenshot
    && left.imagePath === right.imagePath
    && left.videoPath === right.videoPath
    && left.sourceMtimeMs === right.sourceMtimeMs;
}

function indexDelta(previousItems, nextItems, mode) {
  const previous = new Map(previousItems.map((item) => [item.id, item]));
  const next = new Map(nextItems.map((item) => [item.id, item]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, item] of next) {
    const before = previous.get(id);
    if (!before) added += 1;
    else if (!sameIndexedItem(before, item)) changed += 1;
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) removed += 1;
  }
  return { mode, added, removed, changed };
}

function sortPhotoItems(items) {
  items.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt)
    || left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
  return items;
}

async function ensurePrivateCacheDirectory(cacheDir) {
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await fs.chmod(cacheDir, 0o700).catch(() => undefined);
}

async function writeIndexFile(filePath, payload) {
  await ensurePrivateCacheDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, filePath);
}

async function scanPhotoIndex(libraryDir, cacheDir) {
  let libraryReal;
  try {
    libraryReal = await fs.realpath(libraryDir);
  } catch {
    throw photoError("相册还没配置本地目录", 503, "PHOTO_LIBRARY_UNAVAILABLE");
  }
  let rows = null;
  try {
    rows = await collectCandidateFileStatsNative(libraryReal);
  } catch {
    rows = null;
  }
  if (!rows) {
    const candidates = await collectCandidateFiles(libraryReal);
    rows = await mapWithConcurrency(candidates, 6, async (candidate) => {
      try {
        const info = await fs.stat(candidate.absolute);
        return info.isFile() ? { ...candidate, info } : null;
      } catch {
        throw photoScanError();
      }
    });
  }
  const items = pairPhotoMedia(rows.filter(Boolean));
  const directoryMtimes = await statPhotoDirectories(libraryReal, directoryPathsForIndex({ items }));
  const generatedAt = new Date().toISOString();
  const payload = {
    version: PHOTO_INDEX_VERSION,
    generatedAt,
    libraryReal,
    directories: [...directoryMtimes.entries()]
      .filter(([, mtimeMs]) => Number.isFinite(mtimeMs))
      .map(([relative, mtimeMs]) => ({ path: relative, mtimeMs })),
    items,
    lastUpdate: { mode: "full", added: items.length, removed: 0, changed: 0 },
  };
  await writeIndexFile(photoIndexPath(libraryDir, cacheDir), payload);
  return payload;
}

async function refreshPhotoIndex(libraryDir, cacheDir, previousIndex) {
  let libraryReal;
  try {
    libraryReal = await fs.realpath(libraryDir);
  } catch {
    throw photoError("相册还没配置本地目录", 503, "PHOTO_LIBRARY_UNAVAILABLE");
  }
  if (!previousIndex || previousIndex.libraryReal !== libraryReal) return scanPhotoIndex(libraryDir, cacheDir);

  const knownDirectories = directoryPathsForIndex(previousIndex);
  const previousMtimes = new Map((previousIndex.directories || []).map((entry) => [entry.path, entry.mtimeMs]));
  const baselineMs = Date.parse(previousIndex.generatedAt || "");
  const currentMtimes = await statPhotoDirectories(libraryReal, knownDirectories);
  const missingDirectories = [];
  const changedDirectories = [];
  for (const relative of knownDirectories) {
    const currentMtime = currentMtimes.get(relative);
    if (!Number.isFinite(currentMtime)) {
      missingDirectories.push(relative);
      continue;
    }
    const previousMtime = previousMtimes.get(relative);
    const changed = Number.isFinite(previousMtime)
      ? currentMtime !== previousMtime
      : !Number.isFinite(baselineMs) || currentMtime > baselineMs;
    if (changed) changedDirectories.push(relative);
  }

  const directResults = await mapWithConcurrency(changedDirectories, 4, (relative) => scanDirectPhotoDirectory(libraryReal, relative));
  const newRoots = [];
  for (const result of directResults) {
    if (!result.exists) continue;
    for (const child of result.childDirectories) {
      if (!knownDirectories.has(child)) newRoots.push(child);
    }
  }
  const newTreeResults = await scanNewPhotoDirectoryTree(libraryReal, newRoots, knownDirectories);
  const scannedResults = [...directResults.filter((result) => result.exists), ...newTreeResults];
  const replacedFolders = new Set(scannedResults.map((result) => result.relative));
  const nextItems = previousIndex.items.filter((item) => {
    if (replacedFolders.has(item.folder)) return false;
    return !missingDirectories.some((relative) => folderIsInside(item.folder, relative));
  });
  for (const result of scannedResults) nextItems.push(...pairPhotoMedia(result.files));
  sortPhotoItems(nextItems);

  const nextDirectoryPaths = new Set([...knownDirectories]);
  for (const relative of missingDirectories) {
    for (const candidate of [...nextDirectoryPaths]) {
      if (folderIsInside(candidate, relative)) nextDirectoryPaths.delete(candidate);
    }
  }
  for (const result of newTreeResults) addDirectoryAndAncestors(nextDirectoryPaths, result.relative);
  for (const item of nextItems) addDirectoryAndAncestors(nextDirectoryPaths, item.folder);
  const nextMtimes = await statPhotoDirectories(libraryReal, nextDirectoryPaths);
  const lastUpdate = indexDelta(previousIndex.items, nextItems, "incremental");
  const payload = {
    version: PHOTO_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    libraryReal,
    directories: [...nextMtimes.entries()]
      .filter(([, mtimeMs]) => Number.isFinite(mtimeMs))
      .map(([relative, mtimeMs]) => ({ path: relative, mtimeMs })),
    items: nextItems,
    lastUpdate,
  };
  await writeIndexFile(photoIndexPath(libraryDir, cacheDir), payload);
  return payload;
}

async function readDiskIndex(libraryDir, cacheDir) {
  const targetPath = photoIndexPath(libraryDir, cacheDir);
  const legacyPath = legacyPhotoIndexPath(libraryDir, cacheDir);
  for (const filePath of [...new Set([targetPath, legacyPath])]) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (![1, PHOTO_INDEX_VERSION].includes(parsed?.version) || !Array.isArray(parsed.items)) continue;
      if (filePath !== targetPath) await writeIndexFile(targetPath, parsed);
      return parsed;
    } catch {
      // 继续尝试旧缓存位置；两处都没有时才建立新索引。
    }
  }
  return null;
}

async function loadPhotoIndex(libraryDir, cacheDir, refresh = "none") {
  const key = cacheKey(libraryDir, cacheDir);
  const existing = memoryIndexes.get(key);
  if (refresh === "none" && existing?.payload) return existing.payload;
  if (existing?.promise) return existing.promise;

  const promise = (async () => {
    if (refresh === "full") return scanPhotoIndex(libraryDir, cacheDir);
    const disk = existing?.payload || await readDiskIndex(libraryDir, cacheDir);
    if (refresh === "incremental") return disk
      ? refreshPhotoIndex(libraryDir, cacheDir, disk)
      : scanPhotoIndex(libraryDir, cacheDir);
    return disk || scanPhotoIndex(libraryDir, cacheDir);
  })();
  memoryIndexes.set(key, { payload: existing?.payload || null, loadedAt: existing?.loadedAt || 0, promise });
  try {
    const payload = await promise;
    memoryIndexes.set(key, { payload, loadedAt: Date.now(), promise: null });
    return payload;
  } catch (error) {
    memoryIndexes.set(key, { payload: existing?.payload || null, loadedAt: existing?.loadedAt || 0, promise: null });
    throw error;
  }
}

export function clearPhotoLibraryCache() {
  memoryIndexes.clear();
}

async function removeItemsFromPhotoIndex(libraryDir, cacheDir, removedItems) {
  const index = await loadPhotoIndex(libraryDir, cacheDir);
  const removedIds = new Set(removedItems.map((item) => item.id));
  const items = index.items.filter((item) => !removedIds.has(item.id));
  const payload = {
    ...index,
    items,
    lastUpdate: indexDelta(index.items, items, "local"),
  };
  await writeIndexFile(photoIndexPath(libraryDir, cacheDir), payload);
  memoryIndexes.set(cacheKey(libraryDir, cacheDir), { payload, loadedAt: Date.now(), promise: null });
  return payload;
}

function publicItem(item) {
  return {
    id: item.id,
    name: item.name,
    folder: item.folder,
    kind: item.kind,
    bytes: item.bytes,
    capturedAt: item.capturedAt,
    dateSource: item.dateSource,
    format: item.format,
    screenshot: item.screenshot,
    hasMotion: item.kind === "live",
  };
}

function filterItems(items, { kind = "all", folder = "", query = "" } = {}) {
  const safeFolder = normalizePhotoPath(folder);
  const needle = String(query || "").trim().normalize("NFC").toLocaleLowerCase("zh-Hans-CN");
  return items.filter((item) => {
    if (kind === "photo" && item.kind !== "image") return false;
    if (kind === "video" && item.kind !== "video") return false;
    if (kind === "live" && item.kind !== "live") return false;
    if (kind === "screenshot" && !item.screenshot) return false;
    if (safeFolder && item.folder !== safeFolder && !item.folder.startsWith(`${safeFolder}/`)) return false;
    if (needle && !`${item.name} ${item.folder}`.normalize("NFC").toLocaleLowerCase("zh-Hans-CN").includes(needle)) return false;
    return true;
  });
}

function coverIds(items, limit = 4) {
  return items.toSorted((left, right) => Number(left.kind === "video") - Number(right.kind === "video"))
    .slice(0, limit)
    .map((item) => item.id);
}

function summarizePeriods(items, size) {
  const groups = new Map();
  for (const item of items) {
    const key = item.capturedAt.slice(0, size);
    const current = groups.get(key) || [];
    current.push(item);
    groups.set(key, current);
  }
  return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([key, rows]) => ({
    key,
    count: rows.length,
    coverIds: coverIds(rows),
  }));
}

function facetsFor(items) {
  const counts = { all: items.length, photo: 0, video: 0, live: 0, screenshot: 0 };
  const folders = new Map();
  for (const item of items) {
    if (item.kind === "image") counts.photo += 1;
    if (item.kind === "video") counts.video += 1;
    if (item.kind === "live") counts.live += 1;
    if (item.screenshot) counts.screenshot += 1;
    folders.set(item.folder, (folders.get(item.folder) || 0) + 1);
  }
  return {
    counts,
    folders: [...folders.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-Hans-CN", { numeric: true })).map(([folder, count]) => ({ folder, count })),
  };
}

export async function readPhotoLibrary({
  libraryDir = DEFAULT_PHOTO_LIBRARY_DIR,
  cacheDir = DEFAULT_PHOTO_CACHE_DIR,
  view = "month",
  anchor = "",
  cursor = 0,
  limit = DEFAULT_PAGE_SIZE,
  kind = "all",
  folder = "",
  query = "",
  force = false,
  refresh = "none",
} = {}) {
  if (!libraryDir) throw photoError("相册还没配置", 503, "PHOTO_LIBRARY_UNCONFIGURED");
  if (!["year", "month", "day", "all"].includes(view)) throw photoError("相册层级不合法", 400, "PHOTO_VIEW_INVALID");
  if (!["all", "photo", "video", "live", "screenshot"].includes(kind)) throw photoError("媒体筛选不合法", 400, "PHOTO_FILTER_INVALID");
  const refreshMode = force ? "full" : refresh;
  if (!["none", "incremental", "full"].includes(refreshMode)) throw photoError("相册更新方式不合法", 400, "PHOTO_REFRESH_INVALID");
  const index = await loadPhotoIndex(libraryDir, cacheDir, refreshMode);
  const facets = facetsFor(index.items);
  const filtered = filterItems(index.items, { kind, folder, query });
  const years = summarizePeriods(filtered, 4);
  const months = summarizePeriods(filtered, 7);
  const newestMonth = months[0]?.key || new Date().toISOString().slice(0, 7);
  const newestYear = years[0]?.key || newestMonth.slice(0, 4);
  const selectedYear = /^20\d{2}$/.test(String(anchor)) ? String(anchor) : String(anchor).slice(0, 4) || newestYear;
  const selectedMonth = /^20\d{2}-(?:0[1-9]|1[0-2])$/.test(String(anchor)) ? String(anchor) : newestMonth;
  let periods = [];
  let rows = [];
  let resolvedAnchor = anchor;
  if (view === "year") {
    periods = years;
    resolvedAnchor = years[0]?.key || newestYear;
  } else if (view === "month") {
    periods = summarizePeriods(filtered.filter((item) => item.capturedAt.startsWith(selectedYear)), 7);
    resolvedAnchor = selectedYear;
  } else if (view === "day") {
    rows = filtered.filter((item) => item.capturedAt.startsWith(selectedMonth));
    resolvedAnchor = selectedMonth;
  } else {
    rows = filtered;
    resolvedAnchor = filtered[0]?.capturedAt.slice(0, 10) || "";
  }
  const safeCursor = Math.max(0, Number.parseInt(String(cursor), 10) || 0);
  const safeLimit = Math.min(MAX_PAGE_SIZE, Math.max(24, Number.parseInt(String(limit), 10) || DEFAULT_PAGE_SIZE));
  const page = rows.slice(safeCursor, safeCursor + safeLimit);
  const nextCursor = safeCursor + page.length < rows.length ? String(safeCursor + page.length) : null;
  return {
    available: true,
    name: "照片库",
    source: "personal",
    generatedAt: index.generatedAt,
    indexUpdate: index.lastUpdate || null,
    total: filtered.length,
    libraryTotal: index.items.length,
    view,
    anchor: resolvedAnchor,
    periods,
    entries: page.map(publicItem),
    nextCursor,
    availableYears: years.map((period) => period.key),
    availableMonths: months.map((period) => period.key),
    facets,
  };
}

async function itemForId(libraryDir, cacheDir, id) {
  const safeId = String(id || "").trim();
  if (!/^[a-f0-9]{20}$/i.test(safeId)) throw photoError("照片编号不合法", 400, "PHOTO_ID_INVALID");
  const index = await loadPhotoIndex(libraryDir, cacheDir);
  const item = index.items.find((entry) => entry.id === safeId);
  if (!item) throw photoError("找不到这张照片或视频", 404, "PHOTO_NOT_FOUND");
  return { item, libraryReal: index.libraryReal };
}

function normalizePhotoIds(ids) {
  if (!Array.isArray(ids) || !ids.length) throw photoError("请先选择照片", 400, "PHOTO_SELECTION_EMPTY");
  const normalized = [...new Set(ids.map((id) => String(id || "").trim()))];
  if (normalized.length > MAX_PHOTO_ACTION_ITEMS) {
    throw photoError(`一次最多处理 ${MAX_PHOTO_ACTION_ITEMS} 项`, 400, "PHOTO_SELECTION_TOO_LARGE");
  }
  if (normalized.some((id) => !/^[a-f0-9]{20}$/i.test(id))) {
    throw photoError("照片编号不合法", 400, "PHOTO_ID_INVALID");
  }
  return normalized;
}

async function itemsForIds(libraryDir, cacheDir, ids) {
  const normalized = normalizePhotoIds(ids);
  const index = await loadPhotoIndex(libraryDir, cacheDir);
  const byId = new Map(index.items.map((item) => [item.id, item]));
  const items = normalized.map((id) => byId.get(id));
  if (items.some((item) => !item)) throw photoError("有照片已经移动，请检查更新后再试", 409, "PHOTO_SELECTION_STALE");
  return { items, libraryReal: index.libraryReal };
}

function itemMediaPaths(item) {
  return [...new Set([item.imagePath, item.videoPath].filter(Boolean))];
}

function localTimestamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}-${value.hour}${value.minute}${value.second}`;
}

function uniqueExportName(fileName, usedNames) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidate = fileName;
  let suffix = 2;
  while (usedNames.has(candidate.toLocaleLowerCase("en-US"))) {
    candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLocaleLowerCase("en-US"));
  return candidate;
}

export async function exportPhotoMediaToDesktop({
  libraryDir = DEFAULT_PHOTO_LIBRARY_DIR,
  cacheDir = DEFAULT_PHOTO_CACHE_DIR,
  ids,
  exportRoot = "",
  now = new Date(),
} = {}) {
  if (!exportRoot) throw photoError("相册还没配置导出目录", 503, "PHOTO_EXPORT_UNCONFIGURED");
  const { items, libraryReal } = await itemsForIds(libraryDir, cacheDir, ids);
  const batchDir = path.join(exportRoot, localTimestamp(now));
  await fs.mkdir(batchDir, { recursive: true, mode: 0o700 });
  await fs.chmod(batchDir, 0o700).catch(() => undefined);
  const usedNames = new Set();
  const exported = [];
  try {
    for (const item of items) {
      for (const relativePath of itemMediaPaths(item)) {
        const source = await resolveIndexedFile(libraryReal, relativePath);
        const fileName = uniqueExportName(path.basename(relativePath), usedNames);
        const destination = path.join(batchDir, fileName);
        await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
        await fs.chmod(destination, 0o600).catch(() => undefined);
        exported.push(destination);
      }
    }
  } catch (error) {
    await Promise.all(exported.map((filePath) => fs.rm(filePath, { force: true }).catch(() => undefined)));
    await fs.rmdir(batchDir).catch(() => undefined);
    throw error;
  }
  return {
    exported: true,
    itemCount: items.length,
    fileCount: exported.length,
    directory: batchDir,
  };
}

export async function movePhotoMediaToTrash({
  libraryDir = DEFAULT_PHOTO_LIBRARY_DIR,
  cacheDir = DEFAULT_PHOTO_CACHE_DIR,
  ids,
  now = new Date(),
} = {}) {
  const { items, libraryReal } = await itemsForIds(libraryDir, cacheDir, ids);
  const batchName = localTimestamp(now);
  const batchDir = path.join(libraryReal, ".infans-photo-trash", batchName);
  const moved = [];
  try {
    for (const item of items) {
      for (const relativePath of itemMediaPaths(item)) {
        const source = await resolveIndexedFile(libraryReal, relativePath);
        const destination = path.join(batchDir, ...relativePath.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.rename(source, destination);
        moved.push({ source, destination, relativePath });
      }
    }
    await fs.writeFile(path.join(batchDir, "manifest.json"), `${JSON.stringify({
      version: 1,
      movedAt: now.toISOString(),
      items: items.map((item) => ({ id: item.id, name: item.name, paths: itemMediaPaths(item) })),
    }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    for (const row of moved.toReversed()) {
      await fs.mkdir(path.dirname(row.source), { recursive: true }).catch(() => undefined);
      await fs.rename(row.destination, row.source).catch(() => undefined);
    }
    await fs.rm(batchDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await removeItemsFromPhotoIndex(libraryDir, cacheDir, items);
  return {
    trashed: true,
    itemCount: items.length,
    fileCount: moved.length,
    recoveryFolder: path.relative(libraryReal, batchDir).split(path.sep).join("/"),
  };
}

async function resolveIndexedFile(libraryReal, relativePath) {
  const normalized = normalizePhotoPath(relativePath);
  let absolute;
  try {
    absolute = await fs.realpath(path.join(libraryReal, ...normalized.split("/").filter(Boolean)));
  } catch {
    throw photoError("找不到这份照片或视频", 404, "PHOTO_FILE_NOT_FOUND");
  }
  const inside = path.relative(libraryReal, absolute);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw photoError("照片路径越过了相册边界", 400, "PHOTO_PATH_OUTSIDE");
  }
  return absolute;
}

async function generateImageThumbnail(source, target, pixels) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp.jpg`;
  try {
    await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", String(pixels), source, "--out", temporary], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function generateVideoThumbnail(source, target, pixels, cacheDir) {
  const previewDir = await fs.mkdtemp(path.join(cacheDir, "quicklook-"));
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp.jpg`;
  try {
    await execFileAsync("/usr/bin/qlmanage", ["-t", "-s", String(pixels), "-o", previewDir, source], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    const generated = (await fs.readdir(previewDir)).find((fileName) => /\.(?:png|jpe?g)$/i.test(fileName));
    if (!generated) throw photoError("暂时生成不了这个视频封面", 415, "PHOTO_THUMBNAIL_UNAVAILABLE");
    await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", String(pixels), path.join(previewDir, generated), "--out", temporary], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    await fs.rm(previewDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function sendCachedImage(response, filePath) {
  const info = await fs.stat(filePath);
  response.statusCode = 200;
  response.setHeader("Content-Type", "image/jpeg");
  response.setHeader("Content-Length", String(info.size));
  response.setHeader("Cache-Control", "private, max-age=86400");
  response.setHeader("X-Content-Type-Options", "nosniff");
  createReadStream(filePath).pipe(response);
}

function drainThumbnailQueue() {
  while (activeThumbnailJobs < THUMBNAIL_CONCURRENCY && thumbnailQueue.length) {
    const job = thumbnailQueue.shift();
    activeThumbnailJobs += 1;
    void job.run().then(job.resolve, job.reject).finally(() => {
      activeThumbnailJobs -= 1;
      drainThumbnailQueue();
    });
  }
}

function withThumbnailSlot(run) {
  return new Promise((resolve, reject) => {
    thumbnailQueue.push({ run, resolve, reject });
    drainThumbnailQueue();
  });
}

export async function sendPhotoThumbnail(response, {
  libraryDir = DEFAULT_PHOTO_LIBRARY_DIR,
  cacheDir = DEFAULT_PHOTO_CACHE_DIR,
  id,
  size = "small",
} = {}) {
  const pixels = THUMBNAIL_SIZES[size];
  if (!pixels) throw photoError("缩略图尺寸不合法", 400, "PHOTO_THUMBNAIL_SIZE_INVALID");
  const { item, libraryReal } = await itemForId(libraryDir, cacheDir, id);
  const relativeSource = item.imagePath || item.videoPath;
  const source = await resolveIndexedFile(libraryReal, relativeSource);
  await ensurePrivateCacheDirectory(cacheDir);
  const target = path.join(cacheDir, `${item.id}-${Math.round(item.sourceMtimeMs)}-${size}.jpg`);
  try {
    await fs.access(target);
  } catch {
    let generation = thumbnailPromises.get(target);
    if (!generation) {
      generation = withThumbnailSlot(async () => {
        try {
          await fs.access(target);
        } catch {
          if (item.imagePath) await generateImageThumbnail(source, target, pixels);
          else await generateVideoThumbnail(source, target, pixels, cacheDir);
        }
      }).finally(() => thumbnailPromises.delete(target));
      thumbnailPromises.set(target, generation);
    }
    await generation;
  }
  return sendCachedImage(response, target);
}

export async function streamPhotoMedia(request, response, {
  libraryDir = DEFAULT_PHOTO_LIBRARY_DIR,
  cacheDir = DEFAULT_PHOTO_CACHE_DIR,
  id,
  motion = false,
  download = false,
} = {}) {
  const { item, libraryReal } = await itemForId(libraryDir, cacheDir, id);
  const relativeSource = motion && item.videoPath ? item.videoPath : item.imagePath || item.videoPath;
  const absolute = await resolveIndexedFile(libraryReal, relativeSource);
  const info = await fs.stat(absolute);
  if (!info.isFile()) throw photoError("找不到这份照片或视频", 404, "PHOTO_FILE_NOT_FOUND");
  const type = mediaType(absolute);
  if (!type) throw photoError("这个媒体格式不受支持", 415, "PHOTO_FORMAT_UNSUPPORTED");
  const range = parseByteRange(request.headers.range, info.size);
  if (range === false) {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${info.size}`);
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  response.statusCode = range ? 206 : 200;
  response.setHeader("Content-Type", type.mime);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Length", String(end - start + 1));
  response.setHeader("Cache-Control", "private, max-age=3600");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(absolute))}`);
  if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(absolute, { start, end }).pipe(response);
}
