import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MUSIC_VOLUME, FANREN_MUSIC_TRACKS } from "../secretary-music-catalog.mjs";
import { readMediaDirectoryCached } from "./workbench-media-directory-cache.mjs";

export const DEFAULT_MUSIC_LIBRARY_DIR = "";

const MUSIC_TYPES = new Map([
  [".m4a", { mime: "audio/mp4", browserReady: true }],
  [".mp3", { mime: "audio/mpeg", browserReady: true }],
  [".aac", { mime: "audio/aac", browserReady: true }],
  [".wav", { mime: "audio/wav", browserReady: true }],
  [".flac", { mime: "audio/flac", browserReady: true }],
  [".ogg", { mime: "audio/ogg", browserReady: true }],
  [".opus", { mime: "audio/ogg", browserReady: true }],
  [".webm", { mime: "audio/webm", browserReady: true }],
  [".aiff", { mime: "audio/aiff", browserReady: false }],
  [".aif", { mime: "audio/aiff", browserReady: false }],
]);

function musicLibraryError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function normalizeMusicPath(value = "") {
  // SMB 上的文件名可能保持 NFD；只在展示时 NFC，不改实际相对路径。
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.includes("\0") || raw.includes("\\") || path.isAbsolute(raw)) throw musicLibraryError("音乐路径不合法");
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) throw musicLibraryError("音乐路径越过了音乐库边界");
  return normalized === "." ? "" : normalized;
}

async function resolveExistingPath(libraryDir, relativePath = "") {
  if (!libraryDir) throw musicLibraryError("音乐库还没配置", 503);
  let libraryReal;
  try {
    libraryReal = await fs.realpath(libraryDir);
  } catch {
    throw musicLibraryError("音乐库还没配置", 503);
  }
  const normalized = normalizeMusicPath(relativePath);
  let targetReal;
  try {
    targetReal = await fs.realpath(path.join(libraryReal, ...normalized.split("/").filter(Boolean)));
  } catch {
    throw musicLibraryError("找不到这首歌或文件夹", 404);
  }
  const inside = path.relative(libraryReal, targetReal);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw musicLibraryError("音乐路径越过了音乐库边界");
  }
  return { libraryReal, targetReal, normalized };
}

function musicType(fileName) {
  return MUSIC_TYPES.get(path.extname(fileName).toLowerCase()) || null;
}

function cleanTrackTitle(fileName) {
  return path.basename(fileName, path.extname(fileName))
    .replace(/^\s*\d{1,4}\s*[-_.、）)]\s*/, "")
    .trim()
    .normalize("NFC");
}

function knownTrack(title) {
  return FANREN_MUSIC_TRACKS.find((track) => track.title === title);
}

function trackMetadata(relativePath, absolutePath, info, type) {
  const name = path.basename(absolutePath).normalize("NFC");
  const title = cleanTrackTitle(name);
  const known = knownTrack(title);
  const folder = path.posix.dirname(relativePath);
  return {
    kind: "track",
    id: relativePath,
    name,
    title,
    path: relativePath,
    folder: folder === "." ? "" : folder,
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    format: path.extname(name).slice(1).toUpperCase(),
    browserReady: type.browserReady,
    duration: known?.duration || 0,
  };
}

export async function readMusicFileMetadata(libraryDir, relativeFile) {
  const resolved = await resolveExistingPath(libraryDir, relativeFile);
  const type = musicType(resolved.targetReal);
  if (!type) throw musicLibraryError("这个文件不是支持的音乐格式", 415);
  const info = await fs.stat(resolved.targetReal);
  if (!info.isFile()) throw musicLibraryError("这不是音乐文件");
  return trackMetadata(resolved.normalized, resolved.targetReal, info, type);
}

async function readMusicDirectoryFresh(libraryDir, relativeDir = "") {
  const resolved = await resolveExistingPath(libraryDir, relativeDir);
  const directoryInfo = await fs.stat(resolved.targetReal);
  if (!directoryInfo.isDirectory()) throw musicLibraryError("这不是音乐文件夹");
  const rows = await fs.readdir(resolved.targetReal, { withFileTypes: true });
  const entries = [];
  for (const row of rows) {
    if (!row.name || row.name.startsWith(".") || row.isSymbolicLink()) continue;
    const relativePath = [resolved.normalized, row.name].filter(Boolean).join("/");
    if (row.isDirectory()) {
      entries.push({ kind: "directory", name: row.name.normalize("NFC"), path: relativePath });
      continue;
    }
    const type = row.isFile() ? musicType(row.name) : null;
    if (!type) continue;
    const absolute = path.join(resolved.targetReal, row.name);
    entries.push(trackMetadata(relativePath, absolute, await fs.stat(absolute), type));
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  });
  return {
    available: true,
    name: "音乐库",
    path: resolved.normalized,
    breadcrumbs: resolved.normalized ? resolved.normalized.split("/") : [],
    entries,
    defaultVolume: DEFAULT_MUSIC_VOLUME,
  };
}

async function musicDirectorySignature(libraryDir, relativeDir = "") {
  const resolved = await resolveExistingPath(libraryDir, relativeDir);
  const info = await fs.stat(resolved.targetReal);
  if (!info.isDirectory()) throw musicLibraryError("这不是音乐文件夹");
  return `${info.mtimeMs}:${info.ctimeMs}`;
}

export async function readMusicDirectory(libraryDir, relativeDir = "", options = {}) {
  const normalized = normalizeMusicPath(relativeDir);
  return readMediaDirectoryCached({
    kind: "music",
    libraryDir,
    relativeDir: normalized,
    force: Boolean(options.force),
    cacheDir: options.cacheDir,
    now: options.now,
    probe: () => musicDirectorySignature(libraryDir, normalized),
    readFresh: () => readMusicDirectoryFresh(libraryDir, normalized),
  });
}

async function findDefaultFolder(libraryDir, relativeDir = "", depth = 0, options = {}) {
  if (depth > 24) return null;
  const current = await readMusicDirectory(libraryDir, relativeDir, options);
  const tracks = current.entries.filter((entry) => entry.kind === "track");
  let firstTrackFolder = tracks.length ? { folder: current.path, tracks, directory: current } : null;
  for (const directory of current.entries.filter((entry) => entry.kind === "directory")) {
    const nested = await findDefaultFolder(libraryDir, directory.path, depth + 1, options);
    firstTrackFolder ||= nested;
  }
  return firstTrackFolder;
}

export async function readDefaultMusicQueue(libraryDir, options = {}) {
  const result = await findDefaultFolder(libraryDir, "", 0, options);
  if (!result?.tracks.length) return { available: false, tracks: [], selectedPath: "", defaultVolume: DEFAULT_MUSIC_VOLUME };
  const preferred = result.tracks[0];
  return { available: true, folder: result.folder, tracks: result.tracks, selectedPath: preferred.path, directory: result.directory, defaultVolume: DEFAULT_MUSIC_VOLUME };
}

export function parseByteRange(value, size) {
  if (!value) return null;
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return false;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end == null) return false;
  if (start == null) {
    const suffix = Math.min(end, size);
    start = size - suffix;
    end = size - 1;
  } else {
    end = end == null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
  return { start, end };
}

export async function streamMusicTrack(request, response, libraryDir, relativeFile) {
  const resolved = await resolveExistingPath(libraryDir, relativeFile);
  const type = musicType(resolved.targetReal);
  if (!type) throw musicLibraryError("这个文件不是支持的音乐格式", 415);
  const info = await fs.stat(resolved.targetReal);
  if (!info.isFile()) throw musicLibraryError("这不是音乐文件");
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
  response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(resolved.targetReal))}`);
  if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(resolved.targetReal, { start, end }).pipe(response);
}
