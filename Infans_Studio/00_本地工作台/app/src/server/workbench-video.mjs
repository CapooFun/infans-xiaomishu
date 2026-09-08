import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseByteRange } from "./workbench-music.mjs";
import { readMediaDirectoryCached } from "./workbench-media-directory-cache.mjs";

export const DEFAULT_VIDEO_LIBRARY_DIR = "";

const VIDEO_TYPES = new Map([
  [".mp4", { mime: "video/mp4", browserReady: true }],
  [".m4v", { mime: "video/mp4", browserReady: true }],
  [".mov", { mime: "video/quicktime", browserReady: true }],
  [".webm", { mime: "video/webm", browserReady: true }],
  [".ogv", { mime: "video/ogg", browserReady: true }],
  [".mkv", { mime: "video/x-matroska", browserReady: false }],
  [".avi", { mime: "video/x-msvideo", browserReady: false }],
]);

function videoLibraryError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function normalizeVideoPath(value = "") {
  // 保留 NAS 文件名的原始 Unicode 形式；macOS/SMB 上 NFD 名称改成 NFC 会找不到原文件。
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.includes("\0") || raw.includes("\\") || path.isAbsolute(raw)) throw videoLibraryError("视频路径不合法");
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) throw videoLibraryError("视频路径越过了片库边界");
  return normalized === "." ? "" : normalized;
}

async function resolveExistingPath(libraryDir, relativePath = "") {
  if (!libraryDir) throw videoLibraryError("视频库还没配置", 503);
  let libraryReal;
  try {
    libraryReal = await fs.realpath(libraryDir);
  } catch {
    throw videoLibraryError("视频库还没配置", 503);
  }
  const normalized = normalizeVideoPath(relativePath);
  let targetReal;
  try {
    targetReal = await fs.realpath(path.join(libraryReal, ...normalized.split("/").filter(Boolean)));
  } catch {
    throw videoLibraryError("找不到这个文件或文件夹", 404);
  }
  const inside = path.relative(libraryReal, targetReal);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw videoLibraryError("视频路径越过了片库边界");
  }
  return { libraryReal, targetReal, normalized };
}

function videoType(fileName) {
  return VIDEO_TYPES.get(path.extname(fileName).toLowerCase()) || null;
}

export async function readVideoFileMetadata(libraryDir, relativeFile) {
  const resolved = await resolveExistingPath(libraryDir, relativeFile);
  const type = videoType(resolved.targetReal);
  if (!type) throw videoLibraryError("这个文件不是支持的视频格式", 415);
  const info = await fs.stat(resolved.targetReal);
  if (!info.isFile()) throw videoLibraryError("这不是视频文件");
  const folder = path.posix.dirname(resolved.normalized);
  return {
    kind: "video",
    name: path.basename(resolved.targetReal).normalize("NFC"),
    path: resolved.normalized,
    folder: folder === "." ? "" : folder,
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    format: path.extname(resolved.targetReal).slice(1).toUpperCase(),
    browserReady: type.browserReady,
  };
}

async function readVideoDirectoryFresh(libraryDir, relativeDir = "") {
  const resolved = await resolveExistingPath(libraryDir, relativeDir);
  const directoryInfo = await fs.stat(resolved.targetReal);
  if (!directoryInfo.isDirectory()) throw videoLibraryError("这不是视频文件夹");
  const rows = await fs.readdir(resolved.targetReal, { withFileTypes: true });
  const entries = [];
  for (const row of rows) {
    if (!row.name || row.name.startsWith(".") || row.isSymbolicLink()) continue;
    const relativePath = [resolved.normalized, row.name].filter(Boolean).join("/");
    if (row.isDirectory()) {
      entries.push({ kind: "directory", name: row.name.normalize("NFC"), path: relativePath });
      continue;
    }
    const type = row.isFile() ? videoType(row.name) : null;
    if (!type) continue;
    const info = await fs.stat(path.join(resolved.targetReal, row.name));
    entries.push({
      kind: "video",
      name: row.name.normalize("NFC"),
      path: relativePath,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      format: path.extname(row.name).slice(1).toUpperCase(),
      browserReady: type.browserReady,
    });
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  });
  return {
    available: true,
    name: "视频库",
    path: resolved.normalized,
    breadcrumbs: resolved.normalized ? resolved.normalized.split("/") : [],
    entries,
  };
}

async function videoDirectorySignature(libraryDir, relativeDir = "") {
  const resolved = await resolveExistingPath(libraryDir, relativeDir);
  const info = await fs.stat(resolved.targetReal);
  if (!info.isDirectory()) throw videoLibraryError("这不是视频文件夹");
  return `${info.mtimeMs}:${info.ctimeMs}`;
}

export async function readVideoDirectory(libraryDir, relativeDir = "", options = {}) {
  const normalized = normalizeVideoPath(relativeDir);
  return readMediaDirectoryCached({
    kind: "video",
    libraryDir,
    relativeDir: normalized,
    force: Boolean(options.force),
    cacheDir: options.cacheDir,
    now: options.now,
    probe: () => videoDirectorySignature(libraryDir, normalized),
    readFresh: () => readVideoDirectoryFresh(libraryDir, normalized),
  });
}

export async function streamVideoFile(request, response, libraryDir, relativeFile) {
  const resolved = await resolveExistingPath(libraryDir, relativeFile);
  const type = videoType(resolved.targetReal);
  if (!type) throw videoLibraryError("这个文件不是支持的视频格式", 415);
  const info = await fs.stat(resolved.targetReal);
  if (!info.isFile()) throw videoLibraryError("这不是视频文件");
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
