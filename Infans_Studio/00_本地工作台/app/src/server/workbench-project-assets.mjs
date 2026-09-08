import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DEFAULT_ART_PROJECT_SOURCES } from "./workbench-art-library.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { parseByteRange } from "./workbench-music.mjs";

export const PROJECT_ASSET_CONFIG = ".infans/asset-library.v1.json";
export const PROJECT_ASSET_CATALOG = ".infans/asset-catalog.v1.json";
export const PROJECT_ASSET_ANNOTATIONS = ".infans/asset-annotations.v1.jsonl";
const KINDS = new Set(["font", "text", "audio", "video"]);
const FILE_TYPES = {
  font: { ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".ttc": "font/collection" },
  audio: { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac", ".opus": "audio/ogg" },
  video: { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".ogv": "video/ogg", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo" },
};
const EMPTY_ANNOTATION = Object.freeze({ note: "", needsAttention: false, revision: null });
const MAX_CATALOG_BYTES = 24 * 1024 * 1024;
const MAX_ANNOTATION_BYTES = 8 * 1024 * 1024;
const fail = (message, status = 400, code = "PROJECT_ASSET_INVALID") => new WorkbenchWriteError(message, status, code);
const clean = (value, max = 1200) => typeof value === "string" ? value.trim().slice(0, max) : "";
const inside = (root, target) => { const rel = path.relative(root, target); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

function relativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw fail("素材路径不合法");
  return value;
}

// The registered project owns the catalog; no browser-provided path reaches the filesystem.
async function resolvePath(root, relative, { missingLeaf = false } = {}) {
  const parts = relativePath(relative).split("/");
  let target = root;
  for (let index = 0; index < parts.length; index += 1) {
    target = path.join(target, parts[index]);
    const stat = await fs.lstat(target).catch((error) => {
      if (missingLeaf && index === parts.length - 1 && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw fail("素材路径不能经过符号链接", 403, "PROJECT_ASSET_PATH_DENIED");
    if (index < parts.length - 1 && !stat?.isDirectory()) throw fail("素材来源目录无效");
  }
  if (!inside(root, target)) throw fail("素材路径超出项目", 403, "PROJECT_ASSET_PATH_DENIED");
  return target;
}

async function readBounded(root, relative, maxBytes, optional = false) {
  let handle;
  try {
    const target = await resolvePath(root, relative);
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw fail("素材清单或说明记录过大，请在项目中检查来源", 422);
    return await handle.readFile("utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  } finally { await handle?.close(); }
}

function parseJson(raw, label) {
  try { return JSON.parse(raw); } catch { throw fail(`${label}无法解析，请在所属项目修复后重试`, 422, "PROJECT_ASSET_CATALOG_INVALID"); }
}

function sourceRows(value) {
  return Array.isArray(value) ? value.slice(0, 100).map((row) => ({
    path: relativePath(row.path),
    ...(Number.isInteger(row.line) && row.line > 0 ? { line: row.line } : {}),
    ...(typeof row.pointer === "string" ? { pointer: clean(row.pointer, 600) } : {}),
  })) : [];
}

function objectLinks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) throw fail("素材对象关联无效", 422);
  return value.map((row) => {
    const objectId = clean(row?.objectId, 300);
    if (!objectId || !clean(row.label, 300) || !["intended", "referenced", "registered", "source"].includes(row.relation)) throw fail("素材对象或关联类型无效", 422);
    const sources = sourceRows(row.sources);
    if (!sources.length) throw fail("素材对象关联缺少来源依据", 422);
    return { objectId, label: clean(row.label, 300), type: clean(row.type, 100), role: clean(row.role, 300), relation: row.relation, sources };
  });
}

function categoryPath(item) {
  if (item.categoryPath === undefined) return [clean(item.category, 200) || "未分类"];
  if (!Array.isArray(item.categoryPath) || !item.categoryPath.length || item.categoryPath.length > 12
    || item.categoryPath.some((part) => typeof part !== "string" || !part.trim() || part.length > 200 || /[/\\\0]/u.test(part) || [".", ".."].includes(part.trim()))) throw fail("素材目录层级无效", 422);
  return item.categoryPath.map((part) => part.trim());
}

function directoryTree(items) {
  const roots = new Map();
  for (const item of items) {
    let siblings = roots;
    item.categoryPath.forEach((label, index) => {
      if (!siblings.has(label)) siblings.set(label, { path: item.categoryPath.slice(0, index + 1).join("/"), label, count: 0, children: new Map() });
      const node = siblings.get(label);
      node.count += 1;
      siblings = node.children;
    });
  }
  const rows = (nodes) => [...nodes.values()].map((node) => ({ ...node, children: rows(node.children) }));
  return rows(roots);
}

function normalizeCatalog(raw, projectId) {
  if (raw?.schemaVersion !== 1 || raw.project?.id !== projectId || !Array.isArray(raw.items) || raw.items.length > 100000) {
    throw fail("项目素材清单的版本、归属或条目不正确", 422, "PROJECT_ASSET_CATALOG_INVALID");
  }
  const localeIds = new Set();
  const locales = (Array.isArray(raw.locales) ? raw.locales : []).map((row) => {
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,31}$/u.test(row.id || "") || localeIds.has(row.id)) throw fail("语言清单包含无效或重复语言", 422);
    localeIds.add(row.id);
    return { id: row.id, label: clean(row.label, 80) || row.id };
  });
  const ids = new Set();
  const items = raw.items.map((item) => {
    if (!KINDS.has(item?.kind) || typeof item.id !== "string" || !item.id || item.id.length > 300 || ids.has(item.id)) throw fail("素材清单包含无效或重复条目", 422);
    ids.add(item.id);
    let file = {};
    if (item.kind !== "text") {
      const filePath = relativePath(item.path);
      if (filePath.split("/").some((part) => part.startsWith(".") || ["node_modules", "dist", "build"].includes(part))) throw fail("素材路径包含不允许读取的工程目录", 403);
      const extension = path.extname(filePath).toLowerCase();
      const mimeType = FILE_TYPES[item.kind][extension];
      if (!mimeType) throw fail("素材种类与文件格式不一致", 422);
      file = { path: filePath, format: extension.slice(1).toUpperCase(), mimeType };
    }
    const metadata = {};
    for (const key of ["family", "weight", "style", "codec", "sampleRate", "channels", "duration", "width", "height", "copyright"]) {
      const value = item.metadata?.[key];
      if (typeof value === "string") metadata[key] = clean(value, 1600);
      else if (typeof value === "number" && Number.isFinite(value) && value >= 0) metadata[key] = value;
    }
    const values = Object.fromEntries(locales.map(({ id }) => [id, typeof item.values?.[id] === "string" ? item.values[id].slice(0, 30000) : ""]));
    return {
      id: item.id, kind: item.kind, name: clean(item.name, 300) || (item.kind === "text" ? clean(item.key, 300) : path.basename(item.path)),
      category: clean(item.category, 200) || "未分类", categoryPath: categoryPath(item), links: objectLinks(item.links), purpose: clean(item.purpose),
      zone: ["formal", "candidate", "archive"].includes(item.zone) ? item.zone : "unknown",
      ...file, sources: sourceRows(item.sources), references: sourceRows(item.references), metadata,
      ...(item.license && typeof item.license === "object" ? { license: { label: clean(item.license.label, 4000), ...(item.license.path ? { path: relativePath(item.license.path) } : {}) } } : {}),
      ...(item.kind === "text" ? { key: clean(item.key, 600) || item.id, values } : {}),
    };
  });
  if (raw.artLinks !== undefined && (!Array.isArray(raw.artLinks) || raw.artLinks.length > 100000)) throw fail("美术关联索引无效", 422);
  const artPaths = new Set();
  const artLinks = (raw.artLinks || []).map((row) => {
    const filePath = relativePath(row.path);
    if (artPaths.has(filePath)) throw fail("美术关联索引存在重复路径", 422);
    artPaths.add(filePath);
    return { id: `art:${filePath}`, kind: "art", path: filePath, name: clean(row.name, 300) || path.basename(filePath),
      zone: ["formal", "candidate", "archive", "platform"].includes(row.zone) ? row.zone : "unknown", links: objectLinks(row.links) };
  });
  return { artLinks, project: { id: projectId, name: clean(raw.project.name, 200) || projectId }, generatedAt: clean(raw.generatedAt, 100),
    sourceFingerprint: clean(raw.sourceFingerprint, 200), locales, coverage: (Array.isArray(raw.coverage) ? raw.coverage : []).map((line) => clean(line, 1600)), items };
}

export function createProjectAssetService({ sources = DEFAULT_ART_PROJECT_SOURCES, resolveArtItems } = {}) {
  const cache = new Map();
  const writes = new Map();

  async function load(projectId) {
    if (!Object.hasOwn(sources, projectId)) return null;
    const root = await fs.realpath(sources[projectId].root);
    const configRaw = await readBounded(root, PROJECT_ASSET_CONFIG, 1024 * 1024, true);
    if (configRaw === null) return null;
    const config = parseJson(configRaw, "素材登记");
    if (config.schemaVersion !== 1 || config.project?.id !== projectId || config.catalogPath !== PROJECT_ASSET_CATALOG) throw fail("项目素材登记不符合接入契约", 422);
    const catalogPath = await resolvePath(root, PROJECT_ASSET_CATALOG);
    const stat = await fs.stat(catalogPath);
    const stamp = `${root}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    let catalog = cache.get(projectId);
    if (catalog?.stamp !== stamp) {
      catalog = { stamp, data: normalizeCatalog(parseJson(await readBounded(root, PROJECT_ASSET_CATALOG, MAX_CATALOG_BYTES), "素材目录"), projectId) };
      cache.set(projectId, catalog);
    }
    return { root, ...catalog.data };
  }

  async function annotations(root, projectId) {
    const raw = await readBounded(root, PROJECT_ASSET_ANNOTATIONS, MAX_ANNOTATION_BYTES, true);
    const result = new Map();
    for (const line of (raw || "").split("\n").filter(Boolean)) {
      const row = parseJson(line, "素材说明记录");
      if (row.schemaVersion !== 1 || row.projectId !== projectId || typeof row.itemId !== "string" || typeof row.revision !== "string" || typeof row.note !== "string" || typeof row.needsAttention !== "boolean") throw fail("素材说明记录格式或项目归属无效，请在项目内核对", 422);
      result.set(row.itemId, { note: row.note, needsAttention: row.needsAttention, revision: row.revision });
    }
    return result;
  }

  async function fileFacts(root, item) {
    if (item.kind === "text") return item;
    try {
      const stat = await fs.stat(await resolvePath(root, item.path));
      if (!stat.isFile()) return { ...item, fileAvailable: false };
      return { ...item, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), fileAvailable: true };
    } catch (error) {
      if (error.code === "ENOENT") return { ...item, fileAvailable: false };
      throw error;
    }
  }

  async function browse({ projectId, kind = "font", q = "", category = "", directory = "", zone = "", attention = false, missing = false, offset = 0, limit = 60 } = {}) {
    if (!KINDS.has(kind)) throw fail("请选择有效的素材类型");
    if (zone && !["formal", "candidate", "archive", "unknown"].includes(zone)) throw fail("素材状态无效");
    const catalog = await load(projectId).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const counts = { font: 0, text: 0, audio: 0, video: 0 };
    const zoneCounts = { formal: 0, candidate: 0, archive: 0, unknown: 0 };
    if (!catalog) return { available: false, project: { id: projectId || "", name: "" }, coverage: [], locales: [], counts, zoneCounts, directories: [], categories: [], items: [], total: 0, offset: 0, hasMore: false, message: "这个项目尚未接入这组素材。完成项目内的素材整理后即可在这里浏览。" };
    const notes = await annotations(catalog.root, projectId);
    const categoryCounts = new Map();
    const search = clean(q, 300).toLocaleLowerCase();
    const kindRows = catalog.items.filter((item) => {
      counts[item.kind] += 1;
      if (item.kind !== kind) return false;
      categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + 1);
      zoneCounts[item.zone] += 1;
      return true;
    });
    const zoneRows = kindRows.filter((item) => !zone || item.zone === zone);
    const rows = zoneRows.map((item) => ({ ...item, annotation: notes.get(item.id) || { ...EMPTY_ANNOTATION } })).filter((item) => {
      if (category && category !== item.category) return false;
      const itemDirectory = item.categoryPath.join("/");
      if (directory && directory !== itemDirectory && !itemDirectory.startsWith(`${directory}/`)) return false;
      if (attention && !item.annotation.needsAttention) return false;
      if (missing && (kind !== "text" || !catalog.locales.some(({ id }) => !item.values[id]?.trim()))) return false;
      return !search || [item.name, ...item.categoryPath, item.purpose, item.key, item.path, item.annotation.note, ...item.links.map((link) => `${link.label} ${link.role}`), ...Object.values(item.values || {})].join("\n").toLocaleLowerCase().includes(search);
    });
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.min(120, Math.max(1, Math.floor(Number(limit) || 60)));
    const items = await Promise.all(rows.slice(start, start + size).map((item) => fileFacts(catalog.root, item)));
    return { available: true, project: catalog.project, generatedAt: catalog.generatedAt, coverage: catalog.coverage, locales: catalog.locales,
      counts, zoneCounts, directories: directoryTree(zoneRows), categories: [...categoryCounts].map(([name, count]) => ({ name, count })), items, total: rows.length, offset: start, hasMore: start + items.length < rows.length };
  }

  async function links({ projectId, itemId, assetPath } = {}) {
    const catalog = await load(projectId);
    if (!catalog) return { links: [] };
    const item = itemId ? catalog.items.find((row) => row.id === itemId) : catalog.artLinks.find((row) => row.path === assetPath);
    return { links: item?.links || [] };
  }

  async function related({ projectId, objectId, offset = 0, limit = 30 } = {}) {
    const catalog = await load(projectId);
    const rows = catalog ? [...catalog.items, ...catalog.artLinks].filter((item) => item.links.some((link) => link.objectId === objectId)) : [];
    if (!rows.length) throw fail("这个对象尚无素材关联", 404);
    const link = rows[0].links.find((row) => row.objectId === objectId);
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.min(120, Math.max(1, Math.floor(Number(limit) || 30)));
    const page = rows.slice(start, start + size);
    const artPaths = page.filter((row) => row.kind === "art").map((row) => row.path);
    const artItems = artPaths.length && resolveArtItems ? await resolveArtItems({ projectId, paths: artPaths }) : [];
    const artByPath = new Map(artItems.map((item) => [item.path, item]));
    const notes = await annotations(catalog.root, projectId);
    const items = await Promise.all(page.map(async (item) => {
      const result = item.kind === "art" ? { ...item, fileAvailable: false, ...artByPath.get(item.path) } : await fileFacts(catalog.root, { ...item, annotation: notes.get(item.id) || { ...EMPTY_ANNOTATION } });
      return { ...result, links: item.links.filter((row) => row.objectId === objectId) };
    }));
    return { object: { id: objectId, label: link.label, type: link.type }, items, total: rows.length, offset: start, hasMore: start + items.length < rows.length };
  }

  async function save(input) {
    const { projectId, itemId, expectedRevision } = input || {};
    if (!Object.hasOwn(input || {}, "expectedRevision") || (expectedRevision !== null && typeof expectedRevision !== "string")) throw fail("保存说明需要当前修订，请刷新后重试");
    if (input.note === undefined && input.needsAttention === undefined) throw fail("没有需要保存的修改");
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 1200)) throw fail("说明限 1200 字");
    if (input.needsAttention !== undefined && typeof input.needsAttention !== "boolean") throw fail("标记状态无效");
    const catalog = await load(projectId);
    if (!catalog || !catalog.items.some((item) => item.id === itemId)) throw fail("这个素材不在已登记项目清单中", 404);
    const previous = (await annotations(catalog.root, projectId)).get(itemId) || EMPTY_ANNOTATION;
    if (previous.revision !== expectedRevision) {
      const error = fail("这条素材的说明或标记已在别处更新。草稿已保留，请核对后重试。", 409, "PROJECT_ASSET_CONFLICT");
      error.annotation = previous;
      throw error;
    }
    const annotation = { note: input.note === undefined ? previous.note : input.note.trim(), needsAttention: input.needsAttention ?? previous.needsAttention, revision: crypto.randomUUID() };
    const history = await readBounded(catalog.root, PROJECT_ASSET_ANNOTATIONS, MAX_ANNOTATION_BYTES, true);
    const append = `${history && !history.endsWith("\n") ? "\n" : ""}${JSON.stringify({ schemaVersion: 1, projectId, itemId, ...annotation, updatedAt: new Date().toISOString() })}\n`;
    const target = await resolvePath(catalog.root, PROJECT_ASSET_ANNOTATIONS, { missingLeaf: true });
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw fail("说明记录不是普通文件", 403);
      if (stat.size + Buffer.byteLength(append) > MAX_ANNOTATION_BYTES) throw fail("项目说明记录已达到容量限制，请先在项目中整理历史", 422);
      await handle.writeFile(append);
      await handle.sync();
    } finally { await handle.close(); }
    return { itemId, annotation };
  }

  function saveAnnotation(input) {
    const key = input?.projectId;
    const operation = (writes.get(key) || Promise.resolve()).then(() => save(input));
    const settled = operation.catch(() => {});
    writes.set(key, settled);
    void settled.then(() => { if (writes.get(key) === settled) writes.delete(key); });
    return operation;
  }

  async function streamFile(request, response, { projectId, itemId }) {
    const catalog = await load(projectId);
    const item = catalog?.items.find((row) => row.id === itemId && row.kind !== "text");
    if (!item) throw fail("找不到这个已登记素材", 404);
    let handle;
    try {
      const target = await resolvePath(catalog.root, item.path);
      handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw fail("素材不是普通文件", 404);
      const range = parseByteRange(request.headers.range, stat.size);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (range === false) {
        response.statusCode = 416;
        response.setHeader("Content-Range", `bytes */${stat.size}`);
        response.end();
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? stat.size - 1;
      response.statusCode = range ? 206 : 200;
      response.setHeader("Content-Type", item.mimeType);
      response.setHeader("Content-Length", String(Math.max(0, end - start + 1)));
      response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(item.path))}`);
      if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      if (request.method === "HEAD" || stat.size === 0) { response.end(); return; }
      await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
    } catch (error) {
      if (error.code === "ENOENT") throw fail("原素材已移动或缺失，请在项目中重建清单", 404, "PROJECT_ASSET_FILE_MISSING");
      if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
    } finally { await handle?.close(); }
  }

  return { browse, links, related, saveAnnotation, streamFile };
}
