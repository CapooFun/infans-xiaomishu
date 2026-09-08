import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MANIFEST_NAME = "封面清单.json";
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_COVERS = 400;
const SUBJECT_ID_RE = /^[1-9]\d{0,8}$/;
const IMAGE_MIMES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const manifestCache = new Map();

function coverError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeCoverPath(value, subjectId) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || raw.includes("\\") || path.isAbsolute(raw)) {
    throw coverError("动漫封面清单中的文件路径不合法");
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) throw coverError("动漫封面文件越过了支持库目录");
  const extension = path.extname(normalized).toLowerCase();
  if (!IMAGE_MIMES.has(extension)) throw coverError("动漫封面格式不受支持");
  if (normalized !== `images/${subjectId}${extension}`) throw coverError("动漫封面文件名与条目编号不一致");
  return { normalized, mime: IMAGE_MIMES.get(extension) };
}

async function resolveCover(root, entry) {
  const subjectId = String(entry?.subjectId || "");
  if (!SUBJECT_ID_RE.test(subjectId)) throw coverError("动漫封面清单包含不合格的条目编号");
  const { normalized, mime } = normalizeCoverPath(entry?.file, subjectId);
  const candidate = path.join(root, ...normalized.split("/"));
  let linkInfo;
  try {
    linkInfo = await fs.lstat(candidate);
  } catch {
    throw coverError("动漫封面文件不在支持库中", 404);
  }
  if (linkInfo.isSymbolicLink()) throw coverError("动漫封面不能使用符号链接");
  const real = await fs.realpath(candidate);
  if (!inside(root, real)) throw coverError("动漫封面文件越过了支持库目录");
  const info = await fs.stat(real);
  if (!info.isFile()) throw coverError("动漫封面路径不是文件");
  return { subjectId, path: real, bytes: info.size, mime };
}

async function readManifest(libraryDir) {
  let root;
  try {
    root = await fs.realpath(libraryDir);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("not directory");
  } catch {
    return { root: null, covers: [], warnings: [] };
  }
  const manifestPath = path.join(root, MANIFEST_NAME);
  let info;
  try {
    info = await fs.stat(manifestPath);
  } catch {
    return { root, covers: [], warnings: [] };
  }
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
    return { root, covers: [], warnings: ["动漫封面清单不存在或过大"] };
  }
  const signature = `${info.size}:${info.mtimeMs}`;
  const cached = manifestCache.get(root);
  if (cached?.signature === signature) return cached.catalog;
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return { root, covers: [], warnings: ["动漫封面清单不是有效 JSON"] };
  }
  if (!Array.isArray(raw?.covers)) return { root, covers: [], warnings: ["动漫封面清单缺少 covers 数组"] };
  if (raw.covers.length > MAX_COVERS) return { root, covers: [], warnings: ["动漫封面清单条目过多"] };

  const covers = [];
  const warnings = [];
  const idPaths = new Map();
  const titles = new Set();
  for (const rawEntry of raw.covers) {
    const title = String(rawEntry?.title || "").trim();
    if (!title) {
      warnings.push("动漫封面清单包含无标题条目");
      continue;
    }
    try {
      const file = await resolveCover(root, rawEntry);
      if (titles.has(title)) {
        warnings.push(`动漫封面条目重复：${title}`);
        continue;
      }
      const existingPath = idPaths.get(file.subjectId);
      if (existingPath && existingPath !== file.path) {
        warnings.push(`动漫封面条目编号冲突：${title}`);
        continue;
      }
      idPaths.set(file.subjectId, file.path);
      titles.add(title);
      covers.push({ title, ...file });
    } catch (error) {
      warnings.push(`${title}：${error instanceof Error ? error.message : "封面无法读取"}`);
    }
  }
  const catalog = { root, covers, warnings };
  manifestCache.set(root, { signature, catalog });
  return catalog;
}

export async function readAnimeCoverCatalog(libraryDir) {
  const catalog = await readManifest(libraryDir);
  return {
    available: catalog.covers.length > 0,
    covers: catalog.covers.map((cover) => ({
      title: cover.title,
      subjectId: Number(cover.subjectId),
      coverUrl: `/api/anime-cover/${cover.subjectId}`,
    })),
    warnings: catalog.warnings,
  };
}

export function matchAnimeCover(covers, item) {
  const title = String(item?.title || "").trim();
  const direct = covers.find((cover) => cover.title === title);
  if (direct) return direct;
  const subjectId = String(item?.metadataSource || "").match(/\bBangumi\s*#([1-9]\d{0,8})\b/i)?.[1];
  if (!subjectId) return undefined;
  return covers.find((cover) => String(cover.subjectId) === subjectId);
}

export async function streamAnimeCover(request, response, libraryDir, subjectId) {
  if (!SUBJECT_ID_RE.test(String(subjectId || ""))) throw coverError("动漫条目编号不合法");
  const catalog = await readManifest(libraryDir);
  const cachedCover = catalog.covers.find((entry) => entry.subjectId === String(subjectId));
  if (!cachedCover) throw coverError("找不到这张动漫封面", 404);
  const linkInfo = await fs.lstat(cachedCover.path).catch(() => null);
  if (!linkInfo?.isFile() || linkInfo.isSymbolicLink()) throw coverError("动漫封面文件不可读取", 404);
  const livePath = await fs.realpath(cachedCover.path);
  if (!catalog.root || !inside(catalog.root, livePath)) throw coverError("动漫封面文件越过了支持库目录");
  const liveInfo = await fs.stat(livePath);
  const cover = { ...cachedCover, path: livePath, bytes: liveInfo.size };
  response.statusCode = 200;
  response.setHeader("Content-Type", cover.mime);
  response.setHeader("Content-Length", String(cover.bytes));
  response.setHeader("Cache-Control", "private, max-age=86400");
  response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(cover.path))}`);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(cover.path).pipe(response);
}
