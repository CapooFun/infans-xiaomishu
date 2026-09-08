import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { artPurpose } from "./art-purpose.mjs";
import { createArtIntakeService } from "./workbench-art-intake.mjs";
import {
  SECRETARY_VISUAL_ASSET_PROJECT_ID,
  SECRETARY_VISUAL_ASSET_ROOT,
  CORE_VISUAL_SUBJECTS,
  deriveSecretaryVisualAssetCatalog,
  loadSecretaryVisualAssetCatalog,
  previewSecretaryVisualReplacement,
} from "./workbench-secretary-visual-assets.mjs";

export { deriveSecretaryVisualAssetCatalog, loadSecretaryVisualAssetCatalog };

const execFileAsync = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const ART_LIBRARY_SCHEMA_VERSION = 1;
export const ART_LIBRARY_INDEX_VERSION = 3;
export const ART_LIBRARY_CONFIG_PATH = ".infans/art-library.v1.json";
export const ART_LIBRARY_DECISIONS_PATH = ".infans/art-decisions.v1.jsonl";
export const ART_LIBRARY_MOVES_PATH = ".infans/art-moves.v1.jsonl";
export const ART_LIBRARY_ANNOTATIONS_PATH = ".infans/art-annotations.v1.jsonl";
export const ART_LIBRARY_TAGS_PATH = ".infans/art-tags.v1.json";
export const ART_SEMANTIC_CATALOG_PATH = ".infans/art-semantic-catalog.v1.json";
export const DEFAULT_ART_LIBRARY_CACHE_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "com.ifans.secretary",
  "art-library",
);

export const DEFAULT_ART_PROJECT_SOURCES = Object.freeze({});

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".ico", ".psd",
]);
const REFERENCE_EXTENSIONS = new Set([
  ".tscn", ".tres", ".gd", ".godot", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".html", ".json", ".yaml", ".yml",
]);
const MIME_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"],
  [".gif", "image/gif"], [".svg", "image/svg+xml"], [".bmp", "image/bmp"], [".tif", "image/tiff"],
  [".tiff", "image/tiff"], [".heic", "image/heic"], [".heif", "image/heif"], [".ico", "image/x-icon"],
  [".psd", "image/vnd.adobe.photoshop"], [".avif", "image/avif"],
]);
const DEFAULT_IGNORED_SEGMENTS = new Set([
  ".git", ".godot", ".next", ".cache", "node_modules", "dist", "build", "coverage", "tmp", "temp", "logs", "log",
]);
const MANUAL_CONCLUSIONS = new Set(["unjudged", "formal", "candidate", "reference", "rejected"]);
const WORKFLOW_STATUSES = new Set(["normal", "pending-archive", "archived", "recycle"]);
const VIEW_IDS = new Set(["groups", "pending", "files", "platform"]);
const ART_ZONES = new Set(["formal", "candidate", "archive", "platform"]);
const ANNOTATION_PROVENANCE = new Set(["ai-draft", "capoo-confirmed"]);
const memoryIndexes = new Map();
const thumbnailJobs = new Map();
let lastThumbnailPruneAt = 0;
const THUMBNAIL_CACHE_MAX_BYTES = 300 * 1024 * 1024;
const THUMBNAIL_CACHE_TARGET_BYTES = 260 * 1024 * 1024;

function artError(message, status = 400, code = "ART_LIBRARY_ERROR") {
  return new WorkbenchWriteError(message, status, code);
}

function stableId(value, length = 20) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

function slash(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//u, "");
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeProjectId(value) {
  const id = cleanText(value).toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*$/u.test(id) ? id : null;
}

function safeRelative(value, label = "路径") {
  const normalized = slash(cleanText(value));
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").includes("..") || /^[a-z]:\//iu.test(normalized)) {
    throw artError(`${label}必须是项目内相对路径`, 400, "ART_LIBRARY_PATH_INVALID");
  }
  return normalized;
}

function safeSubpath(value, label = "目录") {
  const normalized = slash(cleanText(value));
  if (!normalized) return "";
  return safeRelative(normalized, label);
}

function safeCategoryPath(value) {
  const normalized = slash(cleanText(value));
  if (!normalized) return [];
  const parts = normalized.split("/");
  if (parts.some((part) => !/^[a-z0-9][a-z0-9-]*$/u.test(part))) {
    throw artError("内容分类路径无效", 400, "ART_SEMANTIC_CATEGORY_INVALID");
  }
  return parts;
}

function startsWithCategory(candidate, prefix) {
  return prefix.every((part, index) => candidate?.[index] === part);
}

function semanticTreeNode(nodes, target, trail = []) {
  for (const node of nodes) {
    const pathParts = [...trail, node.id];
    if (pathParts.length === target.length && startsWithCategory(pathParts, target)) return { node, pathParts };
    const nested = semanticTreeNode(Array.isArray(node.children) ? node.children : [], target, pathParts);
    if (nested) return nested;
  }
  return null;
}

function decorateSemanticTree(nodes, entities, assets, trail = []) {
  return nodes.map((node) => {
    const pathParts = [...trail, node.id];
    const children = decorateSemanticTree(Array.isArray(node.children) ? node.children : [], entities, assets, pathParts);
    const entityIds = new Set(entities.filter((entity) => startsWithCategory(entity.categoryPath, pathParts)).map((entity) => entity.id));
    return {
      id: node.id,
      label: cleanText(node.label) || node.id,
      path: pathParts.join("/"),
      entityCount: entityIds.size,
      assetCount: assets.filter((asset) => startsWithCategory(asset.categoryPath, pathParts)
        || asset.entityIds?.some((entityId) => entityIds.has(entityId))).length,
      children,
    };
  });
}

function safeZoneFilter(value) {
  const zone = String(value || "").trim();
  return zone === "formal" || zone === "candidate" || zone === "archive" ? zone : "";
}

function assetMatchesZone(asset, zone) {
  if (!zone) return true;
  const live = asset.libraryItem?.zone;
  if (live) return live === zone;
  return Array.isArray(asset.sourceZones) && asset.sourceZones.includes(zone);
}

function filterCatalogByZone(entities, assets, zone) {
  if (!zone) return { entities, assets };
  const filteredAssets = assets.filter((asset) => assetMatchesZone(asset, zone));
  const assetIds = new Set(filteredAssets.map((asset) => asset.id));
  return {
    assets: filteredAssets,
    entities: entities.map((entity) => ({
      ...entity,
      assetRelations: (entity.assetRelations || []).filter((relation) => assetIds.has(relation.assetId)),
    })).filter((entity) => entity.assetRelations.length > 0),
  };
}

function pruneEmptySemanticTree(nodes) {
  return (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
    const children = pruneEmptySemanticTree(node.children);
    if (!node.entityCount && !node.assetCount && !children.length) return [];
    return [{ ...node, children }];
  });
}

function decorateAndMaybePruneTree(categoryTree, entities, assets, zone) {
  const tree = decorateSemanticTree(categoryTree, entities, assets);
  return zone ? pruneEmptySemanticTree(tree) : tree;
}

function resolveSemanticTreeSelection(tree, requestedPath, allowFallback) {
  const preferred = requestedPath.length ? requestedPath : [tree[0]?.id].filter(Boolean);
  return semanticTreeNode(tree, preferred) || (allowFallback ? semanticTreeNode(tree, [tree[0]?.id].filter(Boolean)) : null);
}

function selectionChildSummaries(node) {
  return (node?.children || []).map((child) => ({
    id: child.id,
    label: child.label,
    path: child.path,
    entityCount: child.entityCount,
    assetCount: child.assetCount,
  }));
}

function emptySemanticSelection(label = "") {
  return { id: "", label, path: "", breadcrumbs: [], children: [], entityCount: 0, assetCount: 0 };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realInside(rootReal, relative, label) {
  const candidate = await fs.realpath(path.join(rootReal, safeRelative(relative, label)));
  if (!isInside(rootReal, candidate)) throw artError(`${label}逃离了项目目录`, 400, "ART_LIBRARY_PATH_ESCAPE");
  return candidate;
}

function configFingerprint(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function defaultProjectLabel(projectId) {
  if (projectId === SECRETARY_VISUAL_ASSET_PROJECT_ID) return "小秘书";
  return "示例项目";
}

function parseConfig(input, projectId) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schemaVersion !== ART_LIBRARY_SCHEMA_VERSION) {
    throw artError("项目美术库配置不是受支持的 v1", 422, "ART_LIBRARY_CONFIG_INVALID");
  }
  const configuredId = safeProjectId(input.project?.id);
  if (configuredId !== projectId) throw artError("项目美术库配置与服务器登记不一致", 422, "ART_LIBRARY_PROJECT_MISMATCH");
  if (!Array.isArray(input.scanRoots) || !input.scanRoots.length) {
    throw artError("项目美术库至少需要一个扫描根目录", 422, "ART_LIBRARY_SCAN_ROOT_MISSING");
  }
  const rootIds = new Set();
  const scanRoots = input.scanRoots.map((entry, index) => {
    const id = safeProjectId(entry?.id);
    if (!id || rootIds.has(id)) throw artError(`第 ${index + 1} 个扫描根目录缺少唯一 ID`, 422, "ART_LIBRARY_SCAN_ROOT_INVALID");
    rootIds.add(id);
    const role = ["runtime", "archive", "source", "platform"].includes(entry.role) ? entry.role : "source";
    const inferredZone = role === "runtime" ? "formal" : role === "archive" ? "archive" : role === "platform" ? "platform" : "candidate";
    const zone = ART_ZONES.has(entry.zone) ? entry.zone : inferredZone;
    return {
      id,
      path: safeRelative(entry.path, `扫描根目录“${id}”`),
      label: cleanText(entry.label) || id,
      role,
      zone,
      movable: zone !== "platform" && entry.movable !== false,
      destination: zone !== "platform" && entry.destination !== false,
      engineIgnore: entry.engineIgnore === true,
      category: cleanText(entry.category) || cleanText(entry.label) || "未分类",
    };
  });
  const referenceScan = input.referenceScan && typeof input.referenceScan === "object" ? input.referenceScan : {};
  const referenceRoots = Array.isArray(referenceScan.roots)
    ? referenceScan.roots.map((item) => safeRelative(item, "引用扫描路径"))
    : [];
  const completeForZones = Array.isArray(referenceScan.completeForZones)
    ? referenceScan.completeForZones.filter((zone) => ["formal", "candidate", "archive"].includes(zone))
    : referenceScan.completeForRuntime === true
      ? ["formal"]
      : [];
  return {
    schemaVersion: ART_LIBRARY_SCHEMA_VERSION,
    project: { id: projectId, name: cleanText(input.project?.name) || defaultProjectLabel(projectId) },
    scanRoots,
    ignore: Array.isArray(input.ignore) ? input.ignore.map(slash).filter(Boolean) : [],
    categories: Array.isArray(input.categories) ? input.categories.map(cleanText).filter(Boolean) : [],
    archiveTarget: input.archiveTarget ? safeRelative(input.archiveTarget, "归档目标") : null,
    tagLibrary: input.tagLibrary ? safeRelative(input.tagLibrary, "标签库") : null,
    referenceScan: {
      roots: referenceRoots,
      completeForRuntime: referenceScan.completeForRuntime === true,
      completeForZones: [...new Set(completeForZones)],
    },
    platformSets: Array.isArray(input.platformSets) ? input.platformSets.flatMap((item) => {
      const id = safeProjectId(item?.id);
      const rule = cleanText(item?.rule);
      if (!id || !rule) return [];
      return [{ id, name: cleanText(item.name) || id, rule, scanRootIds: Array.isArray(item.scanRootIds) ? item.scanRootIds.filter((value) => rootIds.has(value)) : [] }];
    }) : [],
  };
}

async function loadProject(projectId, sources) {
  const source = sources[projectId];
  if (!source) throw artError("这个项目没有登记到美术库", 404, "ART_LIBRARY_PROJECT_NOT_FOUND");
  const rootReal = await fs.realpath(path.resolve(source.root));
  const configPath = path.join(rootReal, ART_LIBRARY_CONFIG_PATH);
  const raw = await fs.readFile(configPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") throw artError(`项目尚未配置 ${ART_LIBRARY_CONFIG_PATH}`, 404, "ART_LIBRARY_CONFIG_MISSING");
    throw error;
  });
  const config = parseConfig(JSON.parse(raw), projectId);
  const scanRoots = [];
  for (const item of config.scanRoots) {
    const absolute = path.join(rootReal, item.path);
    if (!isInside(rootReal, absolute)) throw artError(`扫描根目录“${item.label}”逃离了项目目录`, 400, "ART_LIBRARY_PATH_ESCAPE");
    try {
      const real = await realInside(rootReal, item.path, `扫描根目录“${item.label}”`);
      if (!(await fs.stat(real)).isDirectory()) throw artError(`扫描根目录“${item.label}”不是文件夹`, 422, "ART_LIBRARY_SCAN_ROOT_INVALID");
      scanRoots.push({ ...item, real, exists: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      scanRoots.push({ ...item, real: absolute, exists: false });
    }
  }
  return { projectId, rootReal, configPath, config, scanRoots, fingerprint: configFingerprint(raw) };
}

function ignored(relative, config) {
  const normalized = slash(relative);
  const segments = normalized.split("/");
  if (segments.some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment))) return true;
  return config.ignore.some((pattern) => {
    const simple = slash(pattern).replace(/^\*\*\//u, "").replace(/\/\*\*$/u, "");
    if (!simple) return false;
    if (pattern.includes("*")) {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
      return new RegExp(`^${escaped}$`, "u").test(normalized);
    }
    return normalized === simple || normalized.startsWith(`${simple}/`) || segments.includes(simple);
  });
}

async function walkDirectory(rootReal, directory, config, rows, scanRoot) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    const relative = slash(path.relative(rootReal, absolute));
    if (ignored(relative, config)) continue;
    if (entry.isDirectory()) {
      await walkDirectory(rootReal, absolute, config, rows, scanRoot);
      continue;
    }
    if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const stat = await fs.stat(absolute);
    rows.push({ absolute, relative, scanRoot, bytes: stat.size, modifiedMs: Math.trunc(stat.mtimeMs) });
  }
}

async function listAssetFiles(project) {
  const rows = [];
  for (const scanRoot of project.scanRoots) {
    if (scanRoot.exists) await walkDirectory(project.rootReal, scanRoot.real, project.config, rows, scanRoot);
  }
  rows.sort((left, right) => left.relative.localeCompare(right.relative, "zh-CN"));
  return rows;
}

function pngMetadata(buffer) {
  if (buffer.length < 26 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return null;
  const colorType = buffer[25];
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    hasAlpha: colorType === 4 || colorType === 6 || buffer.includes(Buffer.from("tRNS")),
  };
}

function jpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7), hasAlpha: false };
    }
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    offset += length + 2;
  }
  return null;
}

function webpMetadata(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
      hasAlpha: Boolean(buffer[20] & 0x10),
    };
  }
  if (kind === "VP8L" && buffer[20] === 0x2f) {
    return {
      width: 1 + buffer[21] + ((buffer[22] & 0x3f) << 8),
      height: 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10),
      hasAlpha: true,
    };
  }
  const frame = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
  if (frame >= 0 && frame + 7 <= buffer.length) {
    return { width: buffer.readUInt16LE(frame + 3) & 0x3fff, height: buffer.readUInt16LE(frame + 5) & 0x3fff, hasAlpha: false };
  }
  return null;
}

function svgMetadata(buffer) {
  const text = buffer.toString("utf8", 0, Math.min(buffer.length, 256_000));
  if (!/<svg\b/iu.test(text)) return null;
  const width = Number(text.match(/\bwidth=["']([\d.]+)/iu)?.[1]);
  const height = Number(text.match(/\bheight=["']([\d.]+)/iu)?.[1]);
  const viewBox = text.match(/\bviewBox=["'][\s]*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/iu);
  return { width: width || Number(viewBox?.[1]) || null, height: height || Number(viewBox?.[2]) || null, hasAlpha: true };
}

function basicImageMetadata(buffer, extension) {
  if (extension === ".png") return pngMetadata(buffer);
  if (extension === ".jpg" || extension === ".jpeg") return jpegMetadata(buffer);
  if (extension === ".webp") return webpMetadata(buffer);
  if (extension === ".svg") return svgMetadata(buffer);
  if (extension === ".gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), hasAlpha: buffer.includes(Buffer.from([0x21, 0xf9, 0x04])) };
  }
  if (extension === ".bmp" && buffer.length >= 30) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)), hasAlpha: buffer.readUInt16LE(28) === 32 };
  }
  if (extension === ".ico" && buffer.length >= 8) {
    return { width: buffer[6] || 256, height: buffer[7] || 256, hasAlpha: true };
  }
  if (extension === ".psd" && buffer.length >= 26 && buffer.toString("ascii", 0, 4) === "8BPS") {
    return { width: buffer.readUInt32BE(18), height: buffer.readUInt32BE(14), hasAlpha: buffer.readUInt16BE(12) > 3 };
  }
  return null;
}

async function sipsMetadata(absolute) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", absolute], { maxBuffer: 64 * 1024 });
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/u)?.[1]);
    const height = Number(stdout.match(/pixelHeight:\s*(\d+)/u)?.[1]);
    const alphaText = stdout.match(/hasAlpha:\s*(yes|no)/iu)?.[1]?.toLowerCase();
    return { width: width || null, height: height || null, hasAlpha: alphaText === "yes" ? true : alphaText === "no" ? false : null };
  } catch {
    return { width: null, height: null, hasAlpha: null };
  }
}

function qualityTags(relative, role) {
  const normalized = slash(relative).toLowerCase();
  const tags = [];
  if (/(^|\/)(rejected|reject|denied|\u5426\u51b3)(\/|$)/u.test(normalized)) tags.push("rejected-history");
  if (/(^|\/)(sources?|raw|originals?)(\/|$)/u.test(normalized)) tags.push("source");
  if (/(qa|preview|contact[_ -]?sheet|\u9a8c\u6536|\u9884\u89c8|\u9ed1\u767d)/u.test(normalized)) tags.push("qa");
  if (role === "runtime") tags.push("runtime");
  if (role === "archive") tags.push("archive");
  if (role === "platform") tags.push("platform-delivery");
  return [...new Set(tags)];
}

function groupInfo(projectId, row) {
  const relativeToScan = slash(path.relative(row.scanRoot.real, row.absolute));
  const parent = slash(path.dirname(relativeToScan));
  const groupPath = parent === "." ? row.scanRoot.path : slash(path.join(row.scanRoot.path, parent));
  const label = parent === "." ? row.scanRoot.label : path.basename(parent);
  return { id: stableId(`${projectId}\0${row.scanRoot.id}\0${groupPath}`), path: groupPath, label };
}

async function inspectAsset(project, row) {
  const extension = path.extname(row.relative).toLowerCase();
  const buffer = await fs.readFile(row.absolute);
  const metadata = basicImageMetadata(buffer, extension) || await sipsMetadata(row.absolute);
  const group = groupInfo(project.projectId, row);
  const relativeToRoot = slash(path.relative(row.scanRoot.real, row.absolute));
  const subdirectory = slash(path.dirname(relativeToRoot)) === "." ? "" : slash(path.dirname(relativeToRoot));
  return {
    id: stableId(`${project.projectId}\0${row.relative}`),
    relativePath: row.relative,
    name: path.basename(row.relative),
    directory: slash(path.dirname(row.relative)) === "." ? "" : slash(path.dirname(row.relative)),
    relativeToRoot,
    subdirectory,
    bytes: row.bytes,
    modifiedMs: row.modifiedMs,
    modifiedAt: new Date(row.modifiedMs).toISOString(),
    format: extension.slice(1).toUpperCase() || "UNKNOWN",
    mimeType: MIME_TYPES.get(extension) || "application/octet-stream",
    width: metadata?.width || null,
    height: metadata?.height || null,
    hasAlpha: metadata?.hasAlpha ?? null,
    hash: crypto.createHash("sha256").update(buffer).digest("hex"),
    scanRootId: row.scanRoot.id,
    scanRootLabel: row.scanRoot.label,
    role: row.scanRoot.role,
    zone: row.scanRoot.zone,
    category: row.scanRoot.category,
    groupId: group.id,
    groupPath: group.path,
    groupLabel: group.label,
    qualityTags: qualityTags(row.relative, row.scanRoot.role),
  };
}

async function mapConcurrent(rows, limit, worker) {
  const output = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(rows[index], index);
    }
  }));
  return output;
}

async function gitTrackedPaths(project) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/git", ["-C", project.rootReal, "ls-files", "-z"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    return { repository: true, paths: new Set(stdout.toString("utf8").split("\0").filter(Boolean).map(slash)) };
  } catch {
    return { repository: false, paths: new Set() };
  }
}

async function referenceCorpus(project) {
  const files = [];
  let complete = true;
  const visit = async (absolute) => {
    let stat;
    try { stat = await fs.stat(absolute); } catch { complete = false; return; }
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const child = path.join(absolute, entry.name);
        const relative = slash(path.relative(project.rootReal, child));
        if (ignored(relative, project.config)) continue;
        await visit(child);
      }
      return;
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || !REFERENCE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) return;
    try {
      files.push({
        path: slash(path.relative(project.rootReal, absolute)),
        text: (await fs.readFile(absolute, "utf8")).replaceAll("\\", "/").toLowerCase(),
      });
    } catch { complete = false; }
  };
  for (const relative of project.config.referenceScan.roots) {
    const absolute = path.join(project.rootReal, relative);
    if (!isInside(project.rootReal, absolute)) { complete = false; continue; }
    await visit(absolute);
  }
  return { files, complete };
}

function referenceCandidates(item) {
  const relative = item.relativePath.toLowerCase();
  const candidates = [relative, `res://${relative}`];
  if (relative.startsWith("public/")) candidates.push(`/${relative.slice("public/".length)}`);
  return candidates;
}

function applySystemFacts(items, git, references, config) {
  const byHash = new Map();
  for (const item of items) {
    const list = byHash.get(item.hash) || [];
    list.push(item);
    byHash.set(item.hash, list);
  }
  for (const item of items) {
    item.gitStatus = git.repository ? (git.paths.has(item.relativePath) ? "tracked" : "untracked") : "not-repository";
    const candidates = referenceCandidates(item).filter((candidate) => candidate.length > 4);
    item.references = references.files
      .filter((source) => candidates.some((candidate) => source.text.includes(candidate)))
      .map((source) => ({ path: source.path, kind: referenceKind(source.path) }));
    item.referenceStatus = item.references.length
      ? "using"
      : config.referenceScan.completeForZones.includes(item.zone) && references.complete
        ? "unreferenced"
        : "unknown";
    const duplicates = byHash.get(item.hash) || [];
    item.duplicate = duplicates.length > 1;
    item.duplicateCount = duplicates.length;
    item.duplicateOf = duplicates.length > 1
      ? duplicates.find((candidate) => candidate.id !== item.id)?.relativePath || null
      : null;
  }
}

function referenceKind(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".tscn") return "scene";
  if (extension === ".tres") return "resource";
  if (extension === ".gd") return "script";
  if (extension === ".godot") return "project";
  return "source";
}

async function buildIndex(project, previous = null) {
  const listed = await listAssetFiles(project);
  const previousByPath = new Map((previous?.items || []).map((item) => [item.relativePath, item]));
  const changedRows = listed.filter((row) => {
    const old = previousByPath.get(row.relative);
    return !old || old.bytes !== row.bytes || old.modifiedMs !== row.modifiedMs || old.scanRootId !== row.scanRoot.id;
  });
  const changed = new Map((await mapConcurrent(changedRows, 6, (row) => inspectAsset(project, row))).map((item) => [item.relativePath, item]));
  const items = listed.map((row) => changed.get(row.relative) || previousByPath.get(row.relative)).filter(Boolean);
  const intakeRows = await intakeRecords(project);
  for (const item of items) {
    const registered = intakeRows.find(row => row.currentPath === item.relativePath && row.sha256 === item.hash);
    if (registered) { item.id = registered.assetId; item.intake = { subject:registered.brief.subject, purpose:registered.brief.purpose, batchId:registered.brief.batchId }; }
  }
  const currentPaths = new Set(listed.map((row) => row.relative));
  const removed = [...previousByPath.keys()].filter((relative) => !currentPaths.has(relative)).length;
  const [git, references] = await Promise.all([gitTrackedPaths(project), referenceCorpus(project)]);
  applySystemFacts(items, git, references, project.config);
  return {
    version: ART_LIBRARY_INDEX_VERSION,
    projectId: project.projectId,
    projectName: project.config.project.name,
    root: project.rootReal,
    configFingerprint: project.fingerprint,
    generatedAt: new Date().toISOString(),
    items,
    update: {
      mode: previous ? "incremental" : "full",
      added: changedRows.filter((row) => !previousByPath.has(row.relative)).length,
      changed: changedRows.filter((row) => previousByPath.has(row.relative)).length,
      removed,
    },
  };
}

async function intakeRecords(project) {
  let registry;
  try { registry = JSON.parse(await fs.readFile(path.join(project.rootReal,".infans/art-intake-records.v1.json"),"utf8")); }
  catch(e) { if(e.code === "ENOENT")return [];throw e; }
  const moves=await readMoveRows(project),undone=new Set(moves.filter(r=>r.type==="undo").map(r=>r.batchId));
  return (registry.batches||[]).flatMap(batch=>batch.assets.map(asset=>{
    let currentPath=asset.path;
    for(const move of moves)if(move.type==="move"&&!undone.has(move.batchId)&&move.hash===asset.sha256&&move.sourcePath===currentPath)currentPath=move.destinationPath;
    return {...asset,currentPath,brief:batch.brief};
  }));
}

function mergeIntakeCatalog(catalog,index) {
  for(const item of index.items.filter(i=>i.intake)) {
    if(catalog.assets.some(a=>a.path===item.relativePath))continue;
    const {subject,purpose}=item.intake;
    let entity=catalog.entities.find(e=>e.displayName===subject || e.gameId===subject);
    if(!entity) {
      const rootId="declared-production",subjectId=`subject-${stableId(subject,8)}`,purposeId=`purpose-${stableId(purpose,8)}`;
      let root=catalog.categoryTree.find(n=>n.id===rootId);if(!root){root={id:rootId,label:"制作单用途",children:[]};catalog.categoryTree.push(root);}
      let node=root.children.find(n=>n.id===subjectId);if(!node){node={id:subjectId,label:subject,children:[]};root.children.push(node);}
      if(!node.children.some(n=>n.id===purposeId))node.children.push({id:purposeId,label:purpose,children:[]});
      const id=`declared:${subjectId}:${purposeId}`;
      entity=catalog.entities.find(e=>e.id===id);
      if(!entity){entity={id,gameId:id,displayName:`${subject}·${purpose}`,entityType:"制作对象",categoryPath:[rootId,subjectId,purposeId],sourceFiles:[".infans/art-intake-records.v1.json"],fields:{purpose},confidence:"declared-purpose",assetRelations:[]};catalog.entities.push(entity);}
    }
    entity.assetRelations.push({assetId:item.id,assetPath:item.relativePath,role:purpose,sourceFile:".infans/art-intake-records.v1.json",confidence:"declared-purpose"});
    catalog.assets.push({id:item.id,path:item.relativePath,fileName:item.name,categoryPath:entity.categoryPath,semanticSource:"art-intake",sourceZones:[item.zone],usageStatus:item.referenceStatus,entityIds:[entity.id],references:[],intended:true});
  }
}

function indexPath(cacheDir, projectId) {
  return path.join(cacheDir, "indexes", `${projectId}.v1.json`);
}

async function writeIndex(cacheDir, index) {
  const target = indexPath(cacheDir, index.projectId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(index)}\n`, "utf8");
  await fs.rename(temporary, target);
  memoryIndexes.set(`${cacheDir}\0${index.projectId}`, index);
  return index;
}

async function readDiskIndex(cacheDir, project) {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(cacheDir, project.projectId), "utf8"));
    if (parsed?.version !== ART_LIBRARY_INDEX_VERSION || parsed.projectId !== project.projectId || parsed.configFingerprint !== project.fingerprint || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readDiskIndexSummary(cacheDir, project) {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(cacheDir, project.projectId), "utf8"));
    if (parsed?.projectId !== project.projectId || parsed.configFingerprint !== project.fingerprint || !Array.isArray(parsed.items)) return null;
    return { generatedAt: parsed.generatedAt || null, total: parsed.items.length };
  } catch { return null; }
}

async function loadIndex(cacheDir, project, refresh = false) {
  const key = `${cacheDir}\0${project.projectId}`;
  const memory = memoryIndexes.get(key);
  if (!refresh && memory?.configFingerprint === project.fingerprint) return memory;
  const disk = memory?.configFingerprint === project.fingerprint ? memory : await readDiskIndex(cacheDir, project);
  if (!refresh && disk) { memoryIndexes.set(key, disk); return disk; }
  return writeIndex(cacheDir, await buildIndex(project, disk));
}

async function readDecisions(project) {
  let raw = "";
  try { raw = await fs.readFile(path.join(project.rootReal, ART_LIBRARY_DECISIONS_PATH), "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const latest = new Map();
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.schemaVersion !== 1 || typeof row.assetId !== "string") continue;
      const previous = latest.get(row.assetId) || {};
      latest.set(row.assetId, {
        ...previous,
        ...(MANUAL_CONCLUSIONS.has(row.manualConclusion) ? { manualConclusion: row.manualConclusion } : {}),
        ...(WORKFLOW_STATUSES.has(row.workflowStatus) ? { workflowStatus: row.workflowStatus } : {}),
        decidedAt: row.decidedAt || previous.decidedAt || null,
      });
    } catch { /* 不让单行损坏阻断整个库的只读浏览。 */ }
  }
  return latest;
}

function overlayDecision(item, decision) {
  return {
    ...item,
    manualConclusion: decision?.manualConclusion || "unjudged",
    workflowStatus: decision?.workflowStatus || (item.role === "archive" ? "archived" : "normal"),
    decidedAt: decision?.decidedAt || null,
  };
}

async function readAnnotationRows(project) {
  let raw = "";
  try { raw = await fs.readFile(path.join(project.rootReal, ART_LIBRARY_ANNOTATIONS_PATH), "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return raw.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line);
      return row?.schemaVersion === 1
        && typeof row.assetUid === "string"
        && typeof row.relativePath === "string"
        && typeof row.contentHash === "string"
        ? [row]
        : [];
    } catch { return []; }
  });
}

async function readTagLibrary(project) {
  if (!project.config.tagLibrary) return { configured: false, rules: [], path: null };
  const relativePath = project.config.tagLibrary;
  let raw = "";
  try { raw = await fs.readFile(path.join(project.rootReal, relativePath), "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; return { configured: false, rules: [], path: relativePath }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw artError(`项目标签库 ${relativePath} 不是有效 JSON`, 422, "ART_LIBRARY_TAGS_INVALID"); }
  if (parsed?.schemaVersion !== 1 || safeProjectId(parsed.projectId) !== project.projectId || !Array.isArray(parsed.rules)) {
    throw artError(`项目标签库 ${relativePath} 不是受支持的 v1`, 422, "ART_LIBRARY_TAGS_INVALID");
  }
  const rules = parsed.rules.flatMap((entry) => {
    const id = safeProjectId(entry?.id);
    const match = entry?.match && typeof entry.match === "object" ? entry.match : {};
    const groups = Array.isArray(entry?.groups) ? entry.groups.flatMap((group) => {
      const label = cleanAnnotation(group?.label, 40);
      const tags = cleanAnnotationTags(group?.tags);
      return label && tags.length ? [{ label, tags }] : [];
    }) : [];
    if (!id || !groups.length) return [];
    return [{
      id,
      pathPrefix: slash(cleanText(match.pathPrefix)).toLowerCase(),
      pathContainsAny: Array.isArray(match.pathContainsAny) ? match.pathContainsAny.map((value) => slash(cleanText(value)).toLowerCase()).filter(Boolean).slice(0, 16) : [],
      filenameIncludesAny: Array.isArray(match.filenameIncludesAny) ? match.filenameIncludesAny.map((value) => cleanText(value).toLowerCase()).filter(Boolean).slice(0, 16) : [],
      filenamePrefix: cleanText(match.filenamePrefix).toLowerCase(),
      groups,
    }];
  });
  return { configured: true, rules, path: relativePath };
}

function overlayTagSuggestions(item, tagLibrary) {
  const relative = slash(item.relativePath).toLowerCase();
  const filename = path.basename(relative);
  const groups = new Map();
  for (const rule of tagLibrary.rules) {
    if (rule.pathPrefix && !relative.startsWith(rule.pathPrefix)) continue;
    if (rule.pathContainsAny.length && !rule.pathContainsAny.some((value) => relative.includes(value))) continue;
    if (rule.filenameIncludesAny.length && !rule.filenameIncludesAny.some((value) => filename.includes(value))) continue;
    if (rule.filenamePrefix && !filename.startsWith(rule.filenamePrefix)) continue;
    for (const group of rule.groups) {
      const tags = groups.get(group.label) || [];
      for (const tag of group.tags) if (!tags.includes(tag)) tags.push(tag);
      groups.set(group.label, tags);
    }
  }
  return { ...item, suggestedTagGroups: [...groups].map(([label, tags]) => ({ label, tags })) };
}

function annotationLookup(rows, moveRows) {
  const latestByUid = new Map();
  const uidByPath = new Map();
  const uidsByHash = new Map();
  for (const row of rows) {
    latestByUid.set(row.assetUid, row);
    uidByPath.set(slash(row.relativePath), row.assetUid);
    const hashUids = uidsByHash.get(row.contentHash) || new Set();
    hashUids.add(row.assetUid);
    uidsByHash.set(row.contentHash, hashUids);
  }
  const undone = new Set(moveRows.filter((row) => row.type === "undo").map((row) => row.batchId));
  for (const row of moveRows) {
    if (row.type !== "move" || undone.has(row.batchId)) continue;
    const uid = uidByPath.get(slash(row.sourcePath));
    if (uid) uidByPath.set(slash(row.destinationPath), uid);
  }
  return { latestByUid, uidByPath, uidsByHash };
}

function overlayAnnotation(item, lookup) {
  let uid = lookup.uidByPath.get(item.relativePath) || null;
  if (!uid) {
    const hashUids = lookup.uidsByHash.get(item.hash);
    if (hashUids?.size === 1) uid = [...hashUids][0];
  }
  const row = uid ? lookup.latestByUid.get(uid) : null;
  return {
    ...item,
    assetUid: uid,
    annotation: row ? {
      purpose: cleanText(row.purpose),
      subject: cleanText(row.subject),
      form: cleanText(row.form),
      scene: cleanText(row.scene),
      avoid: cleanText(row.avoid),
      tags: cleanAnnotationTags(row.tags),
      needsAttention: row.needsAttention === true,
      attentionChangedAt: row.attentionChangedAt || null,
      provenance: ANNOTATION_PROVENANCE.has(row.provenance) ? row.provenance : "ai-draft",
      updatedAt: row.updatedAt || null,
    } : null,
  };
}

function overlaySecretaryAnnotation(item, lookup) {
  const stored = overlayAnnotation(item, lookup);
  if (!stored.annotation) return item;
  return {
    ...stored,
    annotation: {
      ...item.annotation,
      ...stored.annotation,
    },
  };
}

function annotationText(item) {
  const note = item.annotation;
  return note ? [note.purpose, note.subject, note.form, note.scene, note.avoid, ...(note.tags || [])].filter(Boolean).join("\n") : "";
}

function formalAssetKind(item) {
  const relative = item.relativePath.toLowerCase();
  const filename = path.basename(relative, path.extname(relative));
  const exact = [
    [/^assets\/backgrounds\//u, "场景背景", "场景", /combat/u.test(filename) ? "战斗场景" : /main[_-]?menu/u.test(filename) ? "主菜单" : /reincarnation/u.test(filename) ? "转生界面" : "场景界面"],
    [/^assets\/map\//u, "地图地形与装饰素材", "地图", "地图探索"],
    [/^assets\/ui\/map\//u, "地图界面素材", "界面", "地图界面"],
    [/^assets\/ui\/inventory\//u, "背包与仓储界面素材", "界面", "背包与仓储"],
    [/^assets\/ui\/main_menu\//u, "主菜单界面素材", "界面", "主菜单"],
    [/^assets\/ui\//u, "游戏界面组件", "界面", "对应功能界面"],
    [/^assets\/vfx\//u, "视觉特效素材", "特效", "战斗或场景表现"],
    [/^assets\/textures\/buffs\//u, "战斗状态与 Buff 图标", "状态效果", "战斗界面"],
    [/^assets\/textures\/skills\//u, "法术与技能表现素材", "法术技能", "战斗与技能界面"],
    [/^assets\/textures\/characters\/protagonist\//u, "主角角色素材", "主角", "角色与战斗表现"],
    [/^assets\/textures\/characters\/(enemies|enemy)\//u, "敌人角色素材", "敌人", "战斗表现"],
    [/^assets\/textures\/characters\//u, "角色素材", "角色", "角色与战斗表现"],
    [/^assets\/textures\/items\/pills\//u, "丹药物品图标", "丹药", "背包、掉落与物品界面"],
    [/^assets\/textures\/items\/equipment\//u, "装备物品图标", "装备", "背包、掉落与装备界面"],
    [/^assets\/textures\/items\/talismans\//u, "符箓物品图标", "符箓", "背包、掉落与物品界面"],
    [/^assets\/textures\/items\/seeds\//u, "种子物品图标", "种子", "背包与种植系统"],
    [/^assets\/textures\/items\/herbs\//u, "药草物品图标", "药草", "采集、背包与炼丹系统"],
    [/^assets\/textures\/items\/materials\//u, "材料物品图标", "材料", "采集、掉落与背包界面"],
    [/^assets\/textures\/items\/books\//u, "功法或书籍图标", "功法书籍", "背包与功法系统"],
    [/^assets\/textures\/items\//u, "游戏物品素材", "物品", "背包、掉落与物品界面"],
    [/^assets\/textures\/locations\//u, "地点与场所素材", "地点", "地图与场所展示"],
    [/^assets\/textures\/common\//u, "通用游戏纹理", "通用素材", "多处共用"],
    [/^assets\/world\/interaction_placeholders\/event_/u, "世界交互事件占位图标", "世界事件", "地图交互"],
    [/^assets\/world\/interaction_placeholders\/resource_/u, "世界资源点占位图标", "资源点", "地图交互"],
    [/^assets\/textures\/generated\//u, "游戏内生成素材", "综合素材", "对应系统界面"],
  ];
  const matched = exact.find(([pattern]) => pattern.test(relative));
  if (matched) return { label: matched[1], subject: matched[2], scene: matched[3] };
  return { label: "正式工程图片素材", subject: "待细分", scene: "游戏运行时" };
}

function formalAnnotationDraft(item) {
  const kind = formalAssetKind(item);
  const useFact = item.referenceStatus === "using"
    ? "当前已检测到工程引用"
    : item.referenceStatus === "unreferenced"
      ? "当前未检测到工程直接引用"
      : "当前引用位置仍需核对";
  return {
    purpose: `${kind.label}；${useFact}。具体对象与最终使用位置待你校正。`,
    subject: kind.subject,
    form: "",
    scene: kind.scene,
    avoid: "",
  };
}

function cleanAnnotation(value, limit) {
  return cleanText(value).slice(0, limit);
}

function cleanAnnotationTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => cleanAnnotation(tag, 40)).filter(Boolean))].slice(0, 16);
}

function hasAnnotationContent(note) {
  return Boolean(note && ([note.purpose, note.subject, note.form, note.scene, note.avoid].some(Boolean) || note.tags?.length));
}

async function appendAnnotationRows(project, rows) {
  if (!rows.length) return;
  const target = path.join(project.rootReal, ART_LIBRARY_ANNOTATIONS_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

async function loadPlatformRule(ruleId) {
  const safe = safeProjectId(ruleId);
  if (!safe) return null;
  const file = path.join(moduleDir, "art-platforms", `${safe}.json`);
  if (!isInside(path.join(moduleDir, "art-platforms"), file)) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed?.schemaVersion === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function slotSpecStatus(item, slot) {
  const format = item.format.toLowerCase();
  const formatOk = !Array.isArray(slot.formats) || slot.formats.includes(format);
  let dimensionsOk = false;
  if (!Number.isFinite(item.width) || !Number.isFinite(item.height)) return "fail";
  if (slot.eitherWidth || slot.eitherHeight) dimensionsOk = item.width === slot.eitherWidth || item.height === slot.eitherHeight;
  else if (slot.width && slot.height) dimensionsOk = item.width === slot.width && item.height === slot.height;
  else if (slot.minWidth && slot.minHeight && slot.aspectRatio) {
    dimensionsOk = item.width >= slot.minWidth && item.height >= slot.minHeight && Math.abs((item.width / item.height) - slot.aspectRatio) < 0.01;
  } else if (slot.maxWidth || slot.maxHeight) {
    dimensionsOk = (!slot.maxWidth || item.width <= slot.maxWidth) && (!slot.maxHeight || item.height <= slot.maxHeight);
  }
  return dimensionsOk && formatOk ? "pass" : "fail";
}

function platformSnapshot(config, items, rules) {
  return config.platformSets.map((set) => {
    const rule = rules.get(set.rule);
    if (!rule) return { id: set.id, name: set.name, available: false, slots: [], source: null };
    const candidates = items.filter((item) => set.scanRootIds.includes(item.scanRootId));
    return {
      id: set.id,
      name: set.name,
      available: true,
      source: rule.source,
      verifiedAt: rule.verifiedAt,
      note: rule.note,
      slots: rule.slots.map((slot) => {
        const matching = candidates.filter((item) => slotSpecStatus(item, slot) === "pass");
        return {
          ...slot,
          candidates: matching.slice(0, 8),
          checks: {
            specification: matching.length >= (slot.minimumCount || 1) ? "pass" : "missing",
            characterIdentity: "human-review",
            logo: "human-review",
            visualConsistency: "human-review",
          },
        };
      }),
    };
  });
}

function createGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.groupId) || {
      id: item.groupId,
      label: item.groupLabel,
      path: item.groupPath,
      category: item.category,
      scanRootLabel: item.scanRootLabel,
      role: item.role,
      items: [],
    };
    group.items.push(item);
    groups.set(item.groupId, group);
  }
  return [...groups.values()].map((group) => {
    group.items.sort((left, right) => {
      const score = (item) => (item.qualityTags.includes("qa") ? 2 : 0) + (item.qualityTags.includes("source") ? 1 : 0) + (item.qualityTags.includes("rejected-history") ? 4 : 0);
      return score(left) - score(right) || left.name.localeCompare(right.name, "zh-CN");
    });
    const conclusions = Object.fromEntries([...MANUAL_CONCLUSIONS].map((status) => [status, group.items.filter((item) => item.manualConclusion === status).length]));
    return {
      id: group.id,
      label: group.label,
      path: group.path,
      category: group.category,
      scanRootLabel: group.scanRootLabel,
      role: group.role,
      count: group.items.length,
      cover: group.items[0],
      samples: group.items.slice(0, 4),
      conclusions,
      duplicateCount: group.items.filter((item) => item.duplicate).length,
      usingCount: group.items.filter((item) => item.referenceStatus === "using").length,
      pendingCount: group.items.filter((item) => item.manualConclusion === "unjudged" || item.workflowStatus === "pending-archive").length,
      qualityTags: [...new Set(group.items.flatMap((item) => item.qualityTags))],
    };
  }).sort((left, right) => right.pendingCount - left.pendingCount || left.path.localeCompare(right.path, "zh-CN"));
}

function filterItems(items, query) {
  const search = cleanText(query.q).toLowerCase();
  return items.filter((item) => {
    if (search && !`${item.name}\n${item.relativePath}\n${item.category}\n${item.groupLabel}\n${annotationText(item)}`.toLowerCase().includes(search)) return false;
    if (query.conclusion && item.manualConclusion !== query.conclusion) return false;
    if (query.workflow && item.workflowStatus !== query.workflow) return false;
    if (query.system === "using" && item.referenceStatus !== "using") return false;
    if (query.system === "unreferenced" && item.referenceStatus !== "unreferenced") return false;
    if (query.system === "unknown" && item.referenceStatus !== "unknown") return false;
    if (query.system === "duplicate" && !item.duplicate) return false;
    if (query.system === "attention" && item.annotation?.needsAttention !== true) return false;
    if (query.system === "spec-mismatch" && item.specStatus !== "mismatch") return false;
    return true;
  });
}

function summaryStats(items) {
  return {
    total: items.length,
    groups: new Set(items.map((item) => item.groupId)).size,
    unjudged: items.filter((item) => item.manualConclusion === "unjudged").length,
    formal: items.filter((item) => item.manualConclusion === "formal").length,
    candidate: items.filter((item) => item.manualConclusion === "candidate").length,
    using: items.filter((item) => item.referenceStatus === "using").length,
    unreferenced: items.filter((item) => item.referenceStatus === "unreferenced").length,
    duplicates: items.filter((item) => item.duplicate).length,
    referenceUnknown: items.filter((item) => item.referenceStatus === "unknown").length,
    attention: items.filter((item) => item.annotation?.needsAttention === true).length,
  };
}

function usageArea(referencePath) {
  const normalized = slash(referencePath);
  const parts = normalized.split("/");
  const top = parts[0] || "project";
  const second = parts[1] || "";
  const common = {
    combat: "战斗",
    grotto: "洞府",
    main: "主流程",
    map: "地图探索",
    ui: "界面",
    sandbox: "沙盒",
    debug: "调试与测试",
    test: "调试与测试",
    tests: "调试与测试",
    tools: "调试与测试",
  };
  if (top === "scenes") return { id: `area/${second || "scenes"}`, label: common[second] || second || "场景", order: 1 };
  if (top === "scripts") return { id: `area/${second || "scripts"}`, label: common[second] || second || "脚本", order: 2 };
  if (top === "resources") return { id: `area/${second || "resources"}`, label: common[second] || second || "资源", order: 3 };
  if (normalized === "project.godot") return { id: "project", label: "项目设置", order: 4 };
  return { id: `${top}/${second}`, label: second || top || "其他引用", order: 5 };
}

function usageSourceLabel(referencePath) {
  const extension = path.extname(referencePath);
  return path.basename(referencePath, extension).replaceAll("_", " ").replaceAll("-", " ");
}

function zoneLabel(zone) {
  return zone === "formal" ? "正式素材" : zone === "candidate" ? "AI 候选素材" : zone === "archive" ? "归档素材" : "平台交付";
}

function directoryRows(items, scanRoot) {
  const rows = new Map();
  for (const item of items) {
    if (item.scanRootId !== scanRoot.id || !item.subdirectory) continue;
    const parts = item.subdirectory.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const subpath = parts.slice(0, depth).join("/");
      const row = rows.get(subpath) || {
        id: stableId(`${scanRoot.id}\0${subpath}`),
        rootId: scanRoot.id,
        path: subpath,
        label: parts[depth - 1],
        parent: parts.slice(0, depth - 1).join("/"),
        depth,
        count: 0,
        directCount: 0,
        sample: item,
        samples: [],
      };
      row.count += 1;
      if (depth === parts.length) row.directCount += 1;
      if (row.samples.length < 3 && !row.samples.some((sample) => sample.id === item.id)) row.samples.push(item);
      rows.set(subpath, row);
    }
  }
  return [...rows.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
}

function zoneNavigation(project, items) {
  const zones = ["formal", "candidate", "archive"].map((zone) => {
    const roots = project.scanRoots.filter((root) => root.zone === zone).map((root) => {
      const rootItems = items.filter((item) => item.scanRootId === root.id);
      return {
        id: root.id,
        path: root.path,
        label: root.label,
        exists: root.exists,
        movable: root.movable,
        destination: root.destination,
        engineIgnore: root.engineIgnore,
        count: rootItems.length,
        directCount: rootItems.filter((item) => !item.subdirectory).length,
        directories: directoryRows(items, root),
      };
    });
    return {
      id: zone,
      label: zoneLabel(zone),
      description: zone === "formal"
        ? "已经获得本人认可的项目素材"
        : zone === "candidate"
          ? "尚未获得正式认可；仍可在游戏中试装使用"
          : "已经退出当前使用、但仍保留价值的素材",
      configured: roots.length > 0,
      count: roots.reduce((sum, root) => sum + root.count, 0),
      roots,
    };
  });
  const destinations = Object.fromEntries(zones.map((zone) => [zone.id, zone.roots.filter((root) => root.movable && root.destination).flatMap((root) => [
    { rootId: root.id, subdirectory: "", path: root.path, label: root.label, exists: root.exists },
    ...root.directories.map((directory) => ({
      rootId: root.id,
      subdirectory: directory.path,
      path: slash(path.join(root.path, directory.path)),
      label: `${root.label} / ${directory.path}`,
      exists: root.exists,
    })),
  ])]));
  return { zones, destinations };
}

function secretaryZone(asset) {
  if (asset.stage === "deprecated" || asset.governanceStatus === "legacy-reference") return "archive";
  if (asset.governanceStatus === "formal") return "formal";
  return "candidate";
}

function secretaryReferenceStatus(asset) {
  return asset.referenceStatus === "referenced" ? "using" : asset.referenceStatus === "unreferenced" ? "unreferenced" : "unknown";
}

function secretaryCurationLabel(asset) {
  return ({
    selected: "本轮保留",
    archive: "本轮归档",
    fallback: "临时兜底",
    retired: "角色退役",
  })[asset.curationState] || "尚未取舍";
}

function hasSemanticUsageEvidence(asset) {
  return asset?.usageStatus === "used"
    && Array.isArray(asset.references)
    && asset.references.some((reference) => cleanText(reference?.file || reference?.path));
}

function secretaryLibraryProject(catalog, vaultRoot, _displayMode = false) {
  const assets = catalog.assets.filter((asset) => CORE_VISUAL_SUBJECTS.has(asset.subject));
  const duplicateCounts = new Map();
  for (const asset of assets) duplicateCounts.set(asset.hash, (duplicateCounts.get(asset.hash) || 0) + 1);
  const items = assets.map((asset) => {
    const zone = secretaryZone(asset);
    const curationLabel = secretaryCurationLabel(asset);
    const file = asset.files.find((candidate) => candidate.path === asset.canonicalPath) || asset.files[0] || {};
    const directory = slash(path.dirname(asset.canonicalPath)) === "." ? "" : slash(path.dirname(asset.canonicalPath));
    const references = asset.consumers.map((consumer) => ({ path: consumer.path, kind: "source" }));
    const devices = [...new Set(asset.consumers.map((consumer) => consumer.device).filter(Boolean))];
    return {
      id: asset.assetId,
      name: path.basename(asset.canonicalPath),
      relativePath: asset.canonicalPath,
      relativeToRoot: asset.canonicalPath,
      subdirectory: directory,
      directory,
      bytes: file.bytes || 0,
      modifiedMs: Date.parse(`${catalog.snapshotDate}T00:00:00+09:00`),
      modifiedAt: `${catalog.snapshotDate}T00:00:00+09:00`,
      format: file.format || path.extname(asset.canonicalPath).slice(1).toUpperCase() || "UNKNOWN",
      mimeType: MIME_TYPES.get(path.extname(asset.canonicalPath).toLowerCase()) || "application/octet-stream",
      width: file.width ?? asset.width ?? null,
      height: file.height ?? asset.height ?? null,
      hasAlpha: file.hasAlpha ?? asset.hasAlpha ?? null,
      hash: asset.hash.replace(/^sha256:/u, ""),
      scanRootId: `secretary-${zone}`,
      scanRootLabel: zoneLabel(zone),
      role: zone === "formal" ? "runtime" : zone === "archive" ? "archive" : "source",
      zone,
      category: asset.kind,
      groupId: stableId(`${SECRETARY_VISUAL_ASSET_PROJECT_ID}\0${directory}`),
      groupPath: directory,
      groupLabel: path.basename(directory) || asset.subject,
      qualityTags: [...new Set([asset.assetClass, asset.governanceStatus, curationLabel, asset.provenance?.aiGenerated === true || asset.provenance?.aiGenerated === "likely" ? "ai-generated" : null].filter(Boolean))],
      gitStatus: file.gitStatus === "tracked" ? "tracked" : file.gitStatus === "untracked" ? "untracked" : "not-repository",
      referenceStatus: secretaryReferenceStatus(asset),
      duplicate: (duplicateCounts.get(asset.hash) || 0) > 1,
      duplicateCount: duplicateCounts.get(asset.hash) || 1,
      duplicateOf: null,
      references,
      assetUid: asset.assetId,
      annotation: {
        purpose: asset.kind,
        subject: asset.subject,
        form: asset.assetClass,
        scene: devices.join("、"),
        avoid: asset.curationState === "fallback"
          ? "只作为当前唯一可用类型的技术兜底，待有合格替代后撤下"
          : asset.governanceStatus === "formal" ? "" : "未经 Capoo 确认不得替换正式母版",
        tags: [...new Set([asset.subject, asset.kind, curationLabel, asset.governanceStatus, ...devices])],
        needsAttention: false,
        provenance: "ai-draft",
        updatedAt: `${catalog.snapshotDate}T00:00:00+09:00`,
        attentionChangedAt: null,
      },
      suggestedTagGroups: [
        { label: "对象", tags: [asset.subject] },
        { label: "用途", tags: [asset.kind] },
        { label: "状态", tags: [curationLabel, zoneLabel(zone), secretaryReferenceStatus(asset) === "using" ? "使用中" : asset.governanceStatus] },
      ],
      manualConclusion: asset.curationState === "selected" && zone === "formal"
        ? "formal"
        : asset.curationState === "archive" || asset.curationState === "retired" || zone === "archive" ? "reference" : "candidate",
      workflowStatus: zone === "archive" ? "archived" : "normal",
      decidedAt: null,
      specStatus: "not-applicable",
      secretaryAsset: asset,
      moveTargets: Object.fromEntries(["formal", "candidate", "archive"].map(zone => [zone,
        `${SECRETARY_VISUAL_ASSET_ROOT}/${zone === "formal" ? "角色" : zone === "candidate" ? "候选" : "归档"}/${asset.subject}/${artPurpose(asset.kind)}/${path.basename(asset.canonicalPath)}`])),
    };
  });
  const scanRoots = ["formal", "candidate", "archive"].map((zone) => ({
    id: `secretary-${zone}`,
    path: "",
    label: zoneLabel(zone),
    role: zone === "formal" ? "runtime" : zone === "archive" ? "archive" : "source",
    zone,
    movable: true,
    destination: true,
    engineIgnore: false,
    exists: true,
  }));
  return {
    project: {
      projectId: SECRETARY_VISUAL_ASSET_PROJECT_ID,
      rootReal: vaultRoot,
      config: { project: { ...catalog.project, name: "小秘书" } },
      scanRoots,
    },
    assets,
    items,
  };
}

const FORMAL_SECRETARY_ORDER = ["银月", "梅凝"];
const INTERN_SECRETARY_ORDER = [];

function secretaryPurposeLabel(value) {
  const purpose = artPurpose(value);
  if (/^(?:首页)?页面背景|^背景图/u.test(purpose)) return "背景图";
  if (/^房间角色图|^陪伴房间/u.test(purpose)) return "陪伴房间";
  if (/^iPhone 默认壁纸/u.test(purpose)) return "iPhone 默认壁纸";
  if (/^iPad 默认壁纸/u.test(purpose)) return "iPad 默认壁纸";
  if (/^网页\/PWA 与 macOS App 图标/u.test(purpose)) return "入口图标";
  if (/^iPhone\/iPad App 图标/u.test(purpose)) return "App 图标";
  if (/^浏览器扩展图标/u.test(purpose)) return "图标";
  return purpose;
}

function secretarySemanticPlacements(asset) {
  const purpose = secretaryPurposeLabel(asset.kind);
  if (asset.subject === "我" || asset.subject === "本人") return [{ rootId: "profile", rootLabel: "本人", subjectId: "profile-user", subjectLabel: "我", purpose }];
  if (FORMAL_SECRETARY_ORDER.includes(asset.subject)) {
    return [{ rootId: "formal-secretaries", rootLabel: "正式秘书", subjectId: `role-${stableId(asset.subject, 8)}`, subjectLabel: asset.subject, purpose }];
  }
  if (!["小秘书", "小秘书视觉系统"].includes(asset.subject)) {
    return [{ rootId: "intern-secretaries", rootLabel: "实习秘书", subjectId: `role-${stableId(asset.subject, 8)}`, subjectLabel: asset.subject, purpose }];
  }
  if (/^(?:首页)?页面背景/u.test(asset.kind)) return [{ rootId: "platforms", rootLabel: "平台素材", subjectId: "platform-web", subjectLabel: "网页", purpose }];
  if (/^iPhone 默认壁纸|^iPad 默认壁纸|^iPhone\/iPad App 图标/u.test(asset.kind)) {
    return [{ rootId: "platforms", rootLabel: "平台素材", subjectId: "platform-mobile", subjectLabel: "iPhone 与 iPad App", purpose }];
  }
  if (/^浏览器扩展图标/u.test(asset.kind)) {
    return [{ rootId: "platforms", rootLabel: "平台素材", subjectId: "platform-extension", subjectLabel: "浏览器扩展", purpose }];
  }
  if (/^网页\/PWA 与 macOS App 图标/u.test(asset.kind)) {
    return [
      { rootId: "platforms", rootLabel: "平台素材", subjectId: "platform-web", subjectLabel: "网页", purpose: "网页 / PWA 图标" },
      { rootId: "platforms", rootLabel: "平台素材", subjectId: "platform-macos", subjectLabel: "macOS App", purpose: "App 图标" },
    ];
  }
  return [{ rootId: "platforms", rootLabel: "平台素材", subjectId: "platform-shared", subjectLabel: "全平台共用", purpose }];
}

function secretaryTreeOrder(left, right) {
  const platformOrder = ["网页", "macOS App", "iPhone 与 iPad App", "浏览器扩展", "全平台共用"];
  const labels = [...platformOrder, ...FORMAL_SECRETARY_ORDER, ...INTERN_SECRETARY_ORDER, "我"];
  const leftIndex = labels.indexOf(left.label);
  const rightIndex = labels.indexOf(right.label);
  if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? labels.length : leftIndex) - (rightIndex < 0 ? labels.length : rightIndex);
  return left.label.localeCompare(right.label, "zh-CN");
}

function secretarySemanticCatalog(library) {
  const roots = new Map([
    ["platforms", { id: "platforms", label: "平台素材", children: new Map() }],
    ["formal-secretaries", { id: "formal-secretaries", label: "正式秘书", children: new Map() }],
    ["intern-secretaries", { id: "intern-secretaries", label: "实习秘书", children: new Map() }],
    ["profile", { id: "profile", label: "本人", children: new Map() }],
  ]);
  const semanticAssets = [];
  const entityRows = new Map();
  for (const item of library.items) {
    const asset = item.secretaryAsset;
    const devices = [...new Set(asset.consumers.map((consumer) => consumer.device).filter(Boolean))];
    const references = asset.consumers
      .filter((consumer) => cleanText(consumer?.path) && cleanText(consumer?.evidence))
      .map((consumer) => ({ file: consumer.path }));
    const placements = secretarySemanticPlacements(asset);
    const entityIds = [];
    for (const placement of placements) {
      const kindId = `kind-${stableId(placement.purpose, 8)}`;
      const root = roots.get(placement.rootId);
      const subject = root.children.get(placement.subjectId) || { id: placement.subjectId, label: placement.subjectLabel, children: new Map() };
      subject.children.set(kindId, { id: kindId, label: placement.purpose });
      root.children.set(placement.subjectId, subject);
      const categoryPath = [placement.rootId, placement.subjectId, kindId];
      const entityId = `entity:${placement.rootId}:${placement.subjectId}:${kindId}`;
      entityIds.push(entityId);
      const entity = entityRows.get(entityId) || {
        id: entityId,
        entityType: ["formal-secretaries", "intern-secretaries"].includes(placement.rootId) ? "secretary" : placement.rootId === "profile" ? "player" : "product",
        gameId: entityId,
        displayName: ["formal-secretaries", "intern-secretaries"].includes(placement.rootId) ? `${placement.subjectLabel} · ${placement.purpose}` : placement.purpose,
        categoryPath,
        sourceFiles: [],
        fields: { purpose: placement.purpose, devices },
        confidence: "asset-manifest",
        assetRelations: [],
      };
      if (!entity.sourceFiles.includes(asset.canonicalPath)) entity.sourceFiles.push(asset.canonicalPath);
      entity.assetRelations.push({ assetId: asset.assetId, assetPath: asset.canonicalPath, role: placement.purpose,
        sourceFile: references[0]?.file || `${SECRETARY_VISUAL_ASSET_ROOT}/asset-manifest.v1.json`, confidence: references.length ? "detected-reference" : "declared-purpose" });
      entityRows.set(entityId, entity);
    }
    const semanticAsset = {
      id: asset.assetId,
      path: asset.canonicalPath,
      fileName: item.name,
      categoryPath: entityRows.get(entityIds[0]).categoryPath,
      semanticSource: "asset-manifest",
      sourceZones: [item.zone],
      usageStatus: item.referenceStatus === "using" && references.length ? "used" : item.referenceStatus,
      entityIds,
      references,
      libraryItem: item,
    };
    semanticAssets.push(semanticAsset);
  }
  const categoryTree = [...roots.values()].filter((root) => root.children.size).map((root) => ({
    id: root.id,
    label: root.label,
    children: [...root.children.values()].sort(secretaryTreeOrder).map((subject) => ({
      id: subject.id,
      label: subject.label,
      children: [...subject.children.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
    })),
  }));
  return { schemaVersion: 1, categoryTree, entities: [...entityRows.values()], assets: semanticAssets, sourceFingerprint: null, conflicts: { duplicateEntityIds: [], missingAssetPaths: [] } };
}

function secretarySemanticSnapshot(library, input = {}) {
  const catalog = secretarySemanticCatalog(library);
  const zone = safeZoneFilter(input.zone);
  const filtered = filterCatalogByZone(catalog.entities, catalog.assets, zone);
  const tree = decorateAndMaybePruneTree(catalog.categoryTree, filtered.entities, filtered.assets, zone);
  const requestedPath = safeCategoryPath(input.category);
  const selection = resolveSemanticTreeSelection(tree, requestedPath, Boolean(zone));
  if (!selection) {
    if (zone) {
      return {
        available: true,
        project: { id: SECRETARY_VISUAL_ASSET_PROJECT_ID, name: "小秘书" },
        schemaVersion: 1,
        sourceFingerprint: catalog.sourceFingerprint,
        tree: [],
        selection: emptySemanticSelection(zoneLabel(zone)),
        entities: [],
        assets: [],
        truncated: { entities: false, assets: false },
        conflicts: catalog.conflicts,
      };
    }
    throw artError("找不到这个内容分类", 404, "ART_SEMANTIC_CATEGORY_NOT_FOUND");
  }
  const categoryPath = selection.pathParts;
  const matchingEntities = filtered.entities.filter((entity) => startsWithCategory(entity.categoryPath, categoryPath));
  const matchingEntityIds = new Set(matchingEntities.map((entity) => entity.id));
  const matchingAssets = filtered.assets.filter((asset) => startsWithCategory(asset.categoryPath, categoryPath)
    || asset.entityIds?.some((entityId) => matchingEntityIds.has(entityId)));
  const limit = Math.min(Math.max(Number(input.limit) || 180, 24), 240);
  const visibleAssets = matchingAssets.slice(0, limit);
  const visibleAssetIds = new Set(visibleAssets.map((asset) => asset.id));
  return {
    available: true,
    project: { id: SECRETARY_VISUAL_ASSET_PROJECT_ID, name: "小秘书" },
    schemaVersion: 1,
    sourceFingerprint: catalog.sourceFingerprint,
    tree,
    selection: {
      id: selection.node.id,
      label: selection.node.label,
      path: categoryPath.join("/"),
      breadcrumbs: categoryPath.map((_, index) => {
        const resolved = semanticTreeNode(tree, categoryPath.slice(0, index + 1));
        return { path: categoryPath.slice(0, index + 1).join("/"), label: resolved?.node?.label || categoryPath[index] };
      }),
      children: selectionChildSummaries(selection.node),
      entityCount: matchingEntities.length,
      assetCount: matchingAssets.length,
    },
    entities: matchingEntities.slice(0, 120).map((entity) => ({ ...entity, assetRelations: entity.assetRelations.filter((relation) => visibleAssetIds.has(relation.assetId)) })),
    assets: visibleAssets,
    truncated: { entities: matchingEntities.length > 120, assets: matchingAssets.length > limit },
    conflicts: catalog.conflicts,
  };
}

async function readMoveRows(project) {
  let raw = "";
  try { raw = await fs.readFile(path.join(project.rootReal, ART_LIBRARY_MOVES_PATH), "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return raw.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const row = JSON.parse(line);
      return row?.schemaVersion === 1 && typeof row.type === "string" ? [row] : [];
    } catch { return []; }
  });
}

function latestUndoableMove(rows) {
  const undone = new Set(rows.filter((row) => row.type === "undo").map((row) => row.batchId));
  const latest = [...rows].reverse().find((row) => row.type === "move" && !undone.has(row.batchId));
  if (!latest) return null;
  const batch = rows.filter((row) => row.type === "move" && row.batchId === latest.batchId);
  return {
    batchId: latest.batchId,
    movedAt: latest.movedAt,
    count: batch.length,
    targetZone: latest.targetZone,
    sourceZones: [...new Set(batch.map((row) => row.sourceZone))],
  };
}

async function appendMoveRows(project, rows) {
  const target = path.join(project.rootReal, ART_LIBRARY_MOVES_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

async function thumbnailCacheFiles(directory, output = []) {
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await thumbnailCacheFiles(absolute, output);
    else if (entry.isFile()) {
      try {
        const stat = await fs.stat(absolute);
        output.push({ absolute, bytes: stat.size, touchedAt: Math.max(stat.atimeMs, stat.mtimeMs) });
      } catch { /* 文件可能刚好被并发替换 */ }
    }
  }
  return output;
}

async function maybePruneThumbnailCache(cacheDir) {
  const now = Date.now();
  if (now - lastThumbnailPruneAt < 60 * 60_000) return;
  lastThumbnailPruneAt = now;
  const files = await thumbnailCacheFiles(path.join(cacheDir, "thumbnails"));
  let total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total <= THUMBNAIL_CACHE_MAX_BYTES) return;
  files.sort((left, right) => left.touchedAt - right.touchedAt);
  for (const file of files) {
    if (total <= THUMBNAIL_CACHE_TARGET_BYTES) break;
    await fs.rm(file.absolute, { force: true }).catch(() => undefined);
    total -= file.bytes;
  }
}

function thumbnailPreset(value) {
  return ({
    tiny: { pixels: 240, quality: 58 },
    small: { pixels: 480, quality: 66 },
    medium: { pixels: 720, quality: 70 },
    preview: { pixels: 1280, quality: 76 },
    large: { pixels: 1280, quality: 76 },
  })[value] || { pixels: 480, quality: 66 };
}

export function createArtLibraryService(options = {}) {
  const sources = options.sources || DEFAULT_ART_PROJECT_SOURCES;
  const cacheDir = path.resolve(options.cacheDir || DEFAULT_ART_LIBRARY_CACHE_DIR);
  const vaultRoot = options.vaultRoot ? path.resolve(options.vaultRoot) : null;
  const intake = createArtIntakeService({ vaultRoot, sources });
  const secretaryMetadataRoot = vaultRoot
    ? path.resolve(options.secretaryMetadataRoot || path.join(vaultRoot, SECRETARY_VISUAL_ASSET_ROOT))
    : null;

  function secretaryAnnotationProject(catalog) {
    return {
      rootReal: secretaryMetadataRoot,
      config: { project: { ...catalog.project, name: "小秘书" } },
    };
  }

  async function loadSecretaryLibrary(displayMode = false) {
    if (!vaultRoot || !secretaryMetadataRoot) throw artError("小秘书视觉资产没有登记 Vault 根目录", 503, "SECRETARY_VISUAL_ROOT_UNAVAILABLE");
    const { catalog } = await loadSecretaryVisualAssetCatalog(vaultRoot);
    const library = secretaryLibraryProject(catalog, vaultRoot, displayMode);
    const project = secretaryAnnotationProject(catalog);
    const rows = await readAnnotationRows(project);
    const annotations = annotationLookup(rows, []);
    library.items = library.items.map((item) => overlaySecretaryAnnotation(item, annotations));
    return { catalog, library, project, rows };
  }

  async function projects(input = {}) {
    const output = [];
    if (vaultRoot) {
      try {
        const { catalog } = await loadSecretaryVisualAssetCatalog(vaultRoot);
        const library = secretaryLibraryProject(catalog, vaultRoot, input.displayMode === true);
        output.push({ id: catalog.project.id, name: "小秘书", kind: "non-game-visual", configured: true, indexedAt: catalog.snapshotDate, total: library.items.length });
      } catch (error) {
        output.push({ id: SECRETARY_VISUAL_ASSET_PROJECT_ID, name: "小秘书", kind: "non-game-visual", configured: false, indexedAt: null, total: 0, error: error instanceof Error ? error.message : "读取失败" });
      }
    }
    for (const id of Object.keys(sources)) {
      try {
        const project = await loadProject(id, sources);
        const memory = memoryIndexes.get(`${cacheDir}\0${id}`);
        const disk = memory || await readDiskIndexSummary(cacheDir, project);
        output.push({ id, name: project.config.project.name, configured: true, indexedAt: disk?.generatedAt || null, total: disk?.items?.length ?? disk?.total ?? 0 });
      } catch (error) {
        output.push({ id, name: defaultProjectLabel(id), configured: false, indexedAt: null, total: 0, error: error instanceof Error ? error.message : "读取失败" });
      }
    }
    return output;
  }

  async function snapshot(query = {}) {
    const allProjects = await projects({ displayMode: query.displayMode === true });
    const requested = safeProjectId(query.projectId) || allProjects.find((item) => item.configured)?.id;
    if (!requested) return { available: false, projects: allProjects, items: [], groups: [], platformSets: [] };
    if (requested === SECRETARY_VISUAL_ASSET_PROJECT_ID) {
      const { catalog, library } = await loadSecretaryLibrary(query.displayMode === true);
      const navigation = zoneNavigation(library.project, library.items);
      const descriptions = {
        formal: "已确认的正式母版；当前是否在用另看引用标记",
        candidate: "AI 生成或其他待确认候选；未确认前不替换正式素材",
        archive: "旧引用与历史素材；是否仍在用以引用标记为准",
      };
      for (const zone of navigation.zones) zone.description = descriptions[zone.id] || zone.description;
      const limit = Math.min(Math.max(Number(query.limit) || 180, 24), 240);
      const cursor = Math.max(Number(query.cursor) || 0, 0);
      const filtered = filterItems(library.items, query);
      return {
        available: true,
        projects: allProjects,
        project: { id: catalog.project.id, name: "小秘书", root: library.project.rootReal, kind: "non-game-visual" },
        generatedAt: `${catalog.snapshotDate}T00:00:00+09:00`,
        indexUpdate: { mode: "manifest", added: 0, changed: 0, removed: 0 },
        view: "files",
        stats: summaryStats(library.items),
        filteredTotal: filtered.length,
        groups: [],
        items: filtered.slice(cursor, cursor + limit),
        nextCursor: cursor + limit < filtered.length ? cursor + limit : null,
        categories: [...new Set(library.items.map((item) => item.category))],
        zones: navigation.zones,
        destinations: Object.fromEntries(["formal", "candidate", "archive"].map(zone => [zone, [{rootId:`secretary-${zone}`,path:SECRETARY_VISUAL_ASSET_ROOT,subdirectory:"by-purpose",label:`${zoneLabel(zone)} / 按对象与用途`}]])),
        lastMove: null,
        platformSets: [],
        policy: { readOnly: false, attentionWritable: true, annotationWritable: true, manifestDerived: true, noDeleteOrReferenceRewrite: true, officialSourceToRuntimeOnly: true },
      };
    }
    const project = await loadProject(requested, sources);
    const index = await loadIndex(cacheDir, project, query.refresh === true);
    const [decisions, annotationRows, moveRows, tagLibrary] = await Promise.all([readDecisions(project), readAnnotationRows(project), readMoveRows(project), readTagLibrary(project)]);
    const annotations = annotationLookup(annotationRows, moveRows);
    const decorated = index.items.map((item) => overlayTagSuggestions(overlayAnnotation(overlayDecision(item, decisions.get(item.id)), annotations), tagLibrary));
    const rules = new Map();
    for (const set of project.config.platformSets) rules.set(set.rule, await loadPlatformRule(set.rule));
    for (const item of decorated) {
      const sets = project.config.platformSets.filter((set) => set.scanRootIds.includes(item.scanRootId));
      if (!sets.length) { item.specStatus = "not-applicable"; continue; }
      item.specStatus = sets.some((set) => (rules.get(set.rule)?.slots || []).some((slot) => slotSpecStatus(item, slot) === "pass")) ? "pass" : "mismatch";
    }
    const view = VIEW_IDS.has(query.view) ? query.view : "groups";
    let filtered = filterItems(decorated, query);
    if (view === "pending") filtered = filtered.filter((item) => item.manualConclusion === "unjudged" || item.workflowStatus === "pending-archive" || item.duplicate);
    if (view === "platform") {
      const platformRootIds = new Set(project.config.platformSets.flatMap((set) => set.scanRootIds));
      filtered = filtered.filter((item) => platformRootIds.has(item.scanRootId));
    }
    const limit = Math.min(Math.max(Number(query.limit) || 180, 24), 240);
    const cursor = Math.max(Number(query.cursor) || 0, 0);
    const groups = createGroups(filtered);
    const navigation = zoneNavigation(project, decorated);
    return {
      available: true,
      projects: allProjects,
      project: { id: requested, name: project.config.project.name, root: project.rootReal },
      generatedAt: index.generatedAt,
      indexUpdate: index.update,
      view,
      stats: summaryStats(decorated),
      filteredTotal: filtered.length,
      groups: view === "groups" ? groups.slice(cursor, cursor + limit) : [],
      groupTotal: groups.length,
      items: view === "groups" ? [] : filtered.slice(cursor, cursor + limit),
      nextCursor: cursor + limit < (view === "groups" ? groups.length : filtered.length) ? cursor + limit : null,
      categories: project.config.categories,
      zones: navigation.zones,
      destinations: navigation.destinations,
      lastMove: latestUndoableMove(moveRows),
      tagLibrary: { configured: tagLibrary.configured, path: tagLibrary.path },
      platformSets: platformSnapshot(project.config, decorated, rules),
      policy: {
        localFileActionsOnly: true,
        noDeleteOrReferenceRewrite: true,
        locationDefinesStatus: true,
        candidateRuntimeEligible: true,
      },
    };
  }

  async function browse(input = {}) {
    const projectId = safeProjectId(input.projectId);
    const rootId = safeProjectId(input.rootId);
    if (!projectId || !rootId) throw artError("目录浏览参数不完整", 400, "ART_LIBRARY_BROWSE_INVALID");
    const directory = safeSubpath(input.directory, "浏览目录");
    if (projectId === SECRETARY_VISUAL_ASSET_PROJECT_ID) {
      const { library } = await loadSecretaryLibrary(input.displayMode === true);
      const scanRoot = library.project.scanRoots.find((root) => root.id === rootId);
      if (!scanRoot) throw artError("这个素材目录没有登记", 404, "ART_LIBRARY_ROOT_NOT_FOUND");
      const search = cleanText(input.q).toLowerCase();
      const within = (item) => !directory || item.subdirectory === directory || item.subdirectory.startsWith(`${directory}/`);
      const matchingRootItems = filterItems(library.items.filter((item) => item.scanRootId === rootId), input).filter(within);
      const files = search ? matchingRootItems : matchingRootItems.filter((item) => item.subdirectory === directory);
      const directories = directoryRows(matchingRootItems, scanRoot).filter((row) => row.parent === directory);
      const filteredZoneTotal = filterItems(library.items.filter((item) => item.zone === scanRoot.zone), input).length;
      const limit = Math.min(Math.max(Number(input.limit) || 240, 24), 360);
      const parts = directory ? directory.split("/") : [];
      return {
        project: { id: projectId, name: "小秘书", root: library.project.rootReal },
        root: { id: scanRoot.id, path: scanRoot.path, label: scanRoot.label, zone: scanRoot.zone, exists: true },
        directory,
        breadcrumbs: [{ path: "", label: scanRoot.label }, ...parts.map((_, index) => ({ path: parts.slice(0, index + 1).join("/"), label: parts[index] }))],
        directories,
        items: files.slice(0, limit),
        total: files.length,
        filteredZoneTotal,
        filter: { system: cleanText(input.system), query: cleanText(input.q) },
        truncated: files.length > limit,
      };
    }
    const project = await loadProject(projectId, sources);
    const scanRoot = project.scanRoots.find((root) => root.id === rootId && root.zone !== "platform");
    if (!scanRoot) throw artError("这个素材目录没有登记", 404, "ART_LIBRARY_ROOT_NOT_FOUND");
    const index = await loadIndex(cacheDir, project, false);
    const [decisions, annotationRows, moveRows, tagLibrary] = await Promise.all([readDecisions(project), readAnnotationRows(project), readMoveRows(project), readTagLibrary(project)]);
    const annotations = annotationLookup(annotationRows, moveRows);
    const decoratedItems = index.items.map((item) => overlayTagSuggestions(overlayAnnotation(overlayDecision(item, decisions.get(item.id)), annotations), tagLibrary));
    const rootItems = decoratedItems.filter((item) => item.scanRootId === rootId);
    const search = cleanText(input.q).toLowerCase();
    const within = (item) => !directory || item.subdirectory === directory || item.subdirectory.startsWith(`${directory}/`);
    const matchingRootItems = filterItems(rootItems, input).filter(within);
    const files = search ? matchingRootItems : matchingRootItems.filter((item) => item.subdirectory === directory);
    const directories = directoryRows(matchingRootItems, scanRoot).filter((row) => row.parent === directory);
    const filteredZoneTotal = filterItems(decoratedItems.filter((item) => item.zone === scanRoot.zone), input).length;
    const limit = Math.min(Math.max(Number(input.limit) || 240, 24), 360);
    const parts = directory ? directory.split("/") : [];
    return {
      project: { id: projectId, name: project.config.project.name, root: project.rootReal },
      root: { id: scanRoot.id, path: scanRoot.path, label: scanRoot.label, zone: scanRoot.zone, exists: scanRoot.exists },
      directory,
      breadcrumbs: [{ path: "", label: scanRoot.label }, ...parts.map((_, index) => ({ path: parts.slice(0, index + 1).join("/"), label: parts[index] }))],
      directories,
      items: files.slice(0, limit),
      total: files.length,
      filteredZoneTotal,
      filter: { system: cleanText(input.system), query: cleanText(input.q) },
      truncated: files.length > limit,
    };
  }

  async function usage(input = {}) {
    const projectId = safeProjectId(input.projectId);
    if (!projectId) throw artError("使用清单缺少项目", 400, "ART_LIBRARY_USAGE_INVALID");
    const project = await loadProject(projectId, sources);
    const index = await loadIndex(cacheDir, project, false);
    const [decisions, annotationRows, moveRows, tagLibrary] = await Promise.all([
      readDecisions(project), readAnnotationRows(project), readMoveRows(project), readTagLibrary(project),
    ]);
    const annotations = annotationLookup(annotationRows, moveRows);
    const items = index.items
      .map((item) => overlayTagSuggestions(overlayAnnotation(overlayDecision(item, decisions.get(item.id)), annotations), tagLibrary))
      .filter((item) => item.referenceStatus === "using" && item.references?.length);
    const areas = new Map();
    for (const item of items) {
      for (const reference of item.references) {
        const areaMeta = usageArea(reference.path);
        const area = areas.get(areaMeta.id) || { ...areaMeta, sources: new Map() };
        const source = area.sources.get(reference.path) || {
          path: reference.path,
          label: usageSourceLabel(reference.path),
          kind: reference.kind,
          items: [],
        };
        if (!source.items.some((candidate) => candidate.id === item.id)) source.items.push(item);
        area.sources.set(reference.path, source);
        areas.set(areaMeta.id, area);
      }
    }
    const groups = [...areas.values()].map((area) => {
      const sources = [...area.sources.values()]
        .map((source) => ({ ...source, count: source.items.length, attentionCount: source.items.filter((item) => item.annotation?.needsAttention).length }))
        .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
      const areaItems = new Map(sources.flatMap((source) => source.items.map((item) => [item.id, item])));
      return {
        id: area.id,
        label: area.label,
        count: areaItems.size,
        attentionCount: [...areaItems.values()].filter((item) => item.annotation?.needsAttention).length,
        sources,
        order: area.order,
      };
    }).sort((left, right) => left.order - right.order || left.label.localeCompare(right.label, "zh-CN"));
    const recentMinutes = Math.min(Math.max(Number(input.recentMinutes) || 30, 5), 240);
    const cutoff = Date.now() - recentMinutes * 60_000;
    const attentionItems = items.filter((item) => item.annotation?.needsAttention);
    const recentItems = attentionItems.filter((item) => {
      const changedAt = Date.parse(item.annotation?.attentionChangedAt || "");
      return Number.isFinite(changedAt) && changedAt >= cutoff;
    });
    return {
      project: { id: projectId, name: project.config.project.name },
      generatedAt: index.generatedAt,
      recentMinutes,
      stats: {
        assets: items.length,
        sources: new Set(items.flatMap((item) => item.references.map((reference) => reference.path))).size,
        groups: groups.length,
        attention: attentionItems.length,
        recent: recentItems.length,
      },
      recentItems,
      groups,
    };
  }

  async function semantic(input = {}) {
    const projectId = safeProjectId(input.projectId);
    if (!projectId) throw artError("内容索引缺少项目", 400, "ART_SEMANTIC_PROJECT_INVALID");
    if (projectId === SECRETARY_VISUAL_ASSET_PROJECT_ID) {
      const { library } = await loadSecretaryLibrary(input.displayMode === true);
      return secretarySemanticSnapshot(library, input);
    }
    const project = await loadProject(projectId, sources);
    const catalogPath = path.join(project.rootReal, ART_SEMANTIC_CATALOG_PATH);
    let catalog;
    try {
      catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw artError("这个项目尚未提供中文内容索引", 404, "ART_SEMANTIC_CATALOG_MISSING");
      if (error instanceof SyntaxError) throw artError("项目中文内容索引不是有效 JSON", 422, "ART_SEMANTIC_CATALOG_INVALID");
      throw error;
    }
    if (catalog?.schemaVersion !== 1 || catalog?.project?.id !== projectId || !Array.isArray(catalog.categoryTree) || !Array.isArray(catalog.entities) || !Array.isArray(catalog.assets)) {
      throw artError("项目中文内容索引不是小秘书支持的 v1", 422, "ART_SEMANTIC_CATALOG_UNSUPPORTED");
    }
    const index = await loadIndex(cacheDir, project, false);
    mergeIntakeCatalog(catalog,index);
    const [decisions, annotationRows, moveRows, tagLibrary] = await Promise.all([
      readDecisions(project), readAnnotationRows(project), readMoveRows(project), readTagLibrary(project),
    ]);
    const annotations = annotationLookup(annotationRows, moveRows);
    const libraryItemsByPath = new Map(index.items.map((item) => {
      const decorated = overlayTagSuggestions(overlayAnnotation(overlayDecision(item, decisions.get(item.id)), annotations), tagLibrary);
      return [decorated.relativePath, decorated];
    }));
    const catalogAssets = catalog.assets.map((asset) => ({ ...asset, libraryItem: libraryItemsByPath.get(asset.path) || null }));
    const zone = safeZoneFilter(input.zone);
    const filtered = filterCatalogByZone(catalog.entities, catalogAssets, zone);
    const tree = decorateAndMaybePruneTree(catalog.categoryTree, filtered.entities, filtered.assets, zone);
    const requestedPath = safeCategoryPath(input.category);
    const selection = resolveSemanticTreeSelection(tree, requestedPath, Boolean(zone));
    if (!selection) {
      if (zone) {
        return {
          available: true,
          project: { id: projectId, name: project.config.project.name },
          schemaVersion: catalog.schemaVersion,
          sourceFingerprint: catalog.sourceFingerprint || null,
          tree: [],
          selection: emptySemanticSelection(zoneLabel(zone)),
          entities: [],
          assets: [],
          truncated: { entities: false, assets: false },
          conflicts: catalog.conflicts,
        };
      }
      throw artError("找不到这个内容分类", 404, "ART_SEMANTIC_CATEGORY_NOT_FOUND");
    }
    const categoryPath = selection.pathParts;
    const matchingEntities = filtered.entities
      .filter((entity) => startsWithCategory(entity.categoryPath, categoryPath))
      .sort((left, right) => String(left.displayName || "").localeCompare(String(right.displayName || ""), "zh-CN") || String(left.gameId || "").localeCompare(String(right.gameId || ""), "zh-CN"));
    const evidencedAssetIds = new Set(filtered.assets.filter(asset=>hasSemanticUsageEvidence(asset)||asset.intended===true).map((asset) => asset.id));
    const entityAssetIds = new Set(matchingEntities.flatMap((entity) => (entity.assetRelations || [])
      .filter((relation) => evidencedAssetIds.has(relation.assetId))
      .map((relation) => relation.assetId)));
    const matchingAssets = filtered.assets
      .filter((asset) => startsWithCategory(asset.categoryPath, categoryPath) || entityAssetIds.has(asset.id))
      .sort((left, right) => Number(entityAssetIds.has(right.id)) - Number(entityAssetIds.has(left.id))
        || Number(right.usageStatus === "used") - Number(left.usageStatus === "used")
        || String(left.fileName || "").localeCompare(String(right.fileName || ""), "zh-CN"));
    const limit = Math.min(Math.max(Number(input.limit) || 180, 24), 240);
    const visibleAssets = matchingAssets.slice(0, limit).map((asset) => ({
      id: asset.id,
      path: asset.path,
      fileName: asset.fileName,
      categoryPath: asset.categoryPath,
      semanticSource: asset.semanticSource,
      sourceZones: asset.sourceZones,
      usageStatus: asset.usageStatus,
      entityIds: asset.entityIds,
      references: asset.references,
      libraryItem: asset.libraryItem || null,
    }));
    const visibleAssetIds = new Set(visibleAssets.map((asset) => asset.id));
    return {
      available: true,
      project: { id: projectId, name: project.config.project.name },
      schemaVersion: catalog.schemaVersion,
      sourceFingerprint: catalog.sourceFingerprint || null,
      tree,
      selection: {
        id: selection.node.id,
        label: selection.node.label,
        path: categoryPath.join("/"),
        breadcrumbs: categoryPath.map((_, index) => {
          const resolved = semanticTreeNode(tree, categoryPath.slice(0, index + 1));
          return { path: categoryPath.slice(0, index + 1).join("/"), label: resolved?.node?.label || categoryPath[index] };
        }),
        children: selectionChildSummaries(selection.node),
        entityCount: matchingEntities.length,
        assetCount: matchingAssets.length,
      },
      entities: matchingEntities.slice(0, 120).map((entity) => ({
        id: entity.id,
        entityType: entity.entityType,
        gameId: entity.gameId,
        displayName: entity.displayName,
        categoryPath: entity.categoryPath,
        sourceFiles: entity.sourceFiles,
        fields: entity.fields,
        confidence: entity.confidence,
        assetRelations: (entity.assetRelations || []).filter((relation) => visibleAssetIds.has(relation.assetId) && evidencedAssetIds.has(relation.assetId)),
      })),
      assets: visibleAssets,
      truncated: { entities: matchingEntities.length > 120, assets: matchingAssets.length > limit },
      conflicts: catalog.conflicts,
    };
  }

  async function resolveLinkedItems({ projectId, paths }) {
    const project = await loadProject(projectId, sources);
    const index = await loadIndex(cacheDir, project, false);
    const requested = new Set(paths);
    return index.items.filter((item) => requested.has(item.relativePath)).map((item) => ({
      id: item.id, path: item.relativePath, name: item.name, zone: item.zone, fileAvailable: true,
      previewUrl: `/api/tools/art-library/thumb?${new URLSearchParams({ project: projectId, id: item.id, size: "preview" })}`,
      originalUrl: `/api/tools/art-library/preview?${new URLSearchParams({ project: projectId, id: item.id })}`,
    }));
  }

  async function resolveItem(projectId, assetId) {
    if (projectId === SECRETARY_VISUAL_ASSET_PROJECT_ID) {
      const { library, project } = await loadSecretaryLibrary(false);
      const item = library.items.find((candidate) => candidate.id === assetId);
      if (!item) throw artError("素材不在小秘书视觉清单中", 404, "ART_LIBRARY_ASSET_NOT_FOUND");
      const absolute = path.resolve(vaultRoot, item.relativePath);
      const relative = path.relative(vaultRoot, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw artError("素材路径已离开 Vault", 403, "ART_LIBRARY_ASSET_ESCAPE");
      return { project, index: null, item, absolute };
    }
    const project = await loadProject(projectId, sources);
    const index = await loadIndex(cacheDir, project, false);
    const item = index.items.find((candidate) => candidate.id === assetId);
    if (!item) throw artError("素材不在当前索引中", 404, "ART_LIBRARY_ASSET_NOT_FOUND");
    const absolute = path.join(project.rootReal, item.relativePath);
    const real = await fs.realpath(absolute);
    if (!isInside(project.rootReal, real)) throw artError("素材路径已离开项目", 403, "ART_LIBRARY_ASSET_ESCAPE");
    return { project, index, item, absolute: real };
  }

  async function appendDecision(input) {
    const projectId = safeProjectId(input?.projectId);
    const assetId = cleanText(input?.assetId);
    if (!projectId || !assetId) throw artError("人工标记缺少项目或素材", 400, "ART_LIBRARY_DECISION_INVALID");
    const conclusion = input.manualConclusion == null ? null : cleanText(input.manualConclusion);
    const workflow = input.workflowStatus == null ? null : cleanText(input.workflowStatus);
    if (conclusion && !MANUAL_CONCLUSIONS.has(conclusion)) throw artError("人工结论不受支持", 400, "ART_LIBRARY_CONCLUSION_INVALID");
    if (workflow && !WORKFLOW_STATUSES.has(workflow)) throw artError("整理流程状态不受支持", 400, "ART_LIBRARY_WORKFLOW_INVALID");
    if (!conclusion && !workflow) throw artError("这次没有可记录的人工判断", 400, "ART_LIBRARY_DECISION_EMPTY");
    const { project, item } = await resolveItem(projectId, assetId);
    const row = {
      schemaVersion: 1,
      decisionId: crypto.randomUUID(),
      decidedAt: new Date().toISOString(),
      assetId: item.id,
      relativePath: item.relativePath,
      ...(conclusion ? { manualConclusion: conclusion } : {}),
      ...(workflow ? { workflowStatus: workflow } : {}),
    };
    const target = path.join(project.rootReal, ART_LIBRARY_DECISIONS_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
    return { ok: true, decision: row };
  }

  async function appendAnnotation(input = {}) {
    const projectId = safeProjectId(input.projectId);
    const assetId = cleanText(input.assetId);
    if (!projectId || !assetId) throw artError("素材说明缺少项目或素材", 400, "ART_LIBRARY_ANNOTATION_INVALID");
    const resolved = await resolveItem(projectId, assetId);
    const purposeOnly = input.mode === "purpose";
    if (purposeOnly && (typeof input.purpose !== "string" || typeof input.expectedPurpose !== "string")) {
      throw artError("说明编辑缺少正文或原有内容，请重新打开素材", 400, "ART_LIBRARY_PURPOSE_INVALID");
    }
    const [rows, moveRows] = await Promise.all([readAnnotationRows(resolved.project), readMoveRows(resolved.project)]);
    const lookup = annotationLookup(rows, moveRows);
    const current = projectId === SECRETARY_VISUAL_ASSET_PROJECT_ID
      ? overlaySecretaryAnnotation(resolved.item, lookup)
      : overlayAnnotation(resolved.item, lookup);
    if (purposeOnly && cleanText(input.expectedPurpose) !== (current.annotation?.purpose || "")) {
      throw artError("说明已在别处更新。请保留这次输入，重新打开素材后核对。", 409, "ART_LIBRARY_PURPOSE_CONFLICT");
    }
    // A one-line edit preserves older structured notes and the latest attention state.
    const source = purposeOnly ? { ...current.annotation, purpose: input.purpose } : input;
    const fields = {
      purpose: cleanAnnotation(source.purpose, 1200),
      subject: cleanAnnotation(source.subject, 80),
      form: cleanAnnotation(source.form, 120),
      scene: cleanAnnotation(source.scene, 180),
      avoid: cleanAnnotation(source.avoid, 400),
      tags: cleanAnnotationTags(source.tags),
    };
    if (!purposeOnly && !hasAnnotationContent(fields)) throw artError("素材说明或标签不能全部为空", 400, "ART_LIBRARY_ANNOTATION_EMPTY");
    const row = {
      schemaVersion: 1,
      annotationId: crypto.randomUUID(),
      assetUid: current.assetUid || crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
      relativePath: resolved.item.relativePath,
      contentHash: resolved.item.hash,
      provenance: "capoo-confirmed",
      needsAttention: current.annotation?.needsAttention === true,
      attentionChangedAt: current.annotation?.attentionChangedAt || null,
      ...fields,
    };
    await appendAnnotationRows(resolved.project, [row]);
    return { ok: true, assetUid: row.assetUid, annotation: overlayAnnotation(resolved.item, annotationLookup([...rows, row], moveRows)).annotation };
  }

  async function setAssetsAttention(input = {}) {
    const projectId = safeProjectId(input.projectId);
    const assetIds = [...new Set((Array.isArray(input.assetIds) ? input.assetIds : [input.assetId]).map(cleanText).filter(Boolean))];
    if (!projectId || !assetIds.length || assetIds.length > 500 || typeof input.needsAttention !== "boolean") {
      throw artError("待处理标记缺少项目、素材或明确状态", 400, "ART_LIBRARY_ATTENTION_INVALID");
    }
    let project;
    let indexedItems;
    if (projectId === SECRETARY_VISUAL_ASSET_PROJECT_ID) {
      const secretary = await loadSecretaryLibrary(false);
      project = secretary.project;
      indexedItems = secretary.library.items;
    } else {
      project = await loadProject(projectId, sources);
      const index = await loadIndex(cacheDir, project, false);
      indexedItems = index.items;
    }
    const itemsById = new Map(indexedItems.map((item) => [item.id, item]));
    const items = assetIds.map((assetId) => itemsById.get(assetId));
    if (items.some((item) => !item)) throw artError("有素材不在当前索引中", 404, "ART_LIBRARY_ASSET_NOT_FOUND");
    const [rows, moveRows] = await Promise.all([readAnnotationRows(project), readMoveRows(project)]);
    const lookup = annotationLookup(rows, moveRows);
    const attentionChangedAt = new Date().toISOString();
    const appended = items.map((item) => {
      const current = projectId === SECRETARY_VISUAL_ASSET_PROJECT_ID
        ? overlaySecretaryAnnotation(item, lookup)
        : overlayAnnotation(item, lookup);
      const note = current.annotation || { purpose: "", subject: "", form: "", scene: "", avoid: "", tags: [], provenance: "capoo-confirmed" };
      return {
        schemaVersion: 1,
        annotationId: crypto.randomUUID(),
        assetUid: current.assetUid || crypto.randomUUID(),
        updatedAt: attentionChangedAt,
        attentionChangedAt,
        relativePath: item.relativePath,
        contentHash: item.hash,
        provenance: note.provenance,
        purpose: note.purpose,
        subject: note.subject,
        form: note.form,
        scene: note.scene,
        avoid: note.avoid,
        tags: note.tags,
        needsAttention: input.needsAttention,
      };
    });
    await appendAnnotationRows(project, appended);
    const nextLookup = annotationLookup([...rows, ...appended], moveRows);
    const updated = items.map((item) => {
      const result = projectId === SECRETARY_VISUAL_ASSET_PROJECT_ID
        ? overlaySecretaryAnnotation(item, nextLookup)
        : overlayAnnotation(item, nextLookup);
      return { assetId: item.id, assetUid: result.assetUid, annotation: result.annotation };
    });
    return { ok: true, count: updated.length, attentionChangedAt, items: updated };
  }

  async function setAssetAttention(input = {}) {
    const result = await setAssetsAttention(input);
    return { ok: true, assetUid: result.items[0].assetUid, annotation: result.items[0].annotation };
  }

  async function seedFormalAnnotations(input = {}) {
    const projectId = safeProjectId(input.projectId);
    if (!projectId) throw artError("生成素材说明缺少项目", 400, "ART_LIBRARY_ANNOTATION_SEED_INVALID");
    const project = await loadProject(projectId, sources);
    const index = await loadIndex(cacheDir, project, input.refresh === true);
    const [rows, moveRows] = await Promise.all([readAnnotationRows(project), readMoveRows(project)]);
    const lookup = annotationLookup(rows, moveRows);
    const formal = index.items.filter((item) => item.zone === "formal");
    const missing = formal.filter((item) => !hasAnnotationContent(overlayAnnotation(item, lookup).annotation));
    const updatedAt = new Date().toISOString();
    const drafts = missing.map((item) => {
      const current = overlayAnnotation(item, lookup);
      return {
        schemaVersion: 1,
        annotationId: crypto.randomUUID(),
        assetUid: current.assetUid || crypto.randomUUID(),
        updatedAt,
        relativePath: item.relativePath,
        contentHash: item.hash,
        provenance: "ai-draft",
        tags: [],
        needsAttention: current.annotation?.needsAttention === true,
        attentionChangedAt: current.annotation?.attentionChangedAt || null,
        ...formalAnnotationDraft(item),
      };
    });
    await appendAnnotationRows(project, drafts);
    return { ok: true, projectId, created: drafts.length, preserved: formal.length - missing.length, formalTotal: formal.length, path: ART_LIBRARY_ANNOTATIONS_PATH };
  }

  async function moveAssets(input = {}) {
    if (input.projectId === SECRETARY_VISUAL_ASSET_PROJECT_ID) return intake.moveSecretary(input);
    const projectId = safeProjectId(input.projectId);
    const targetRootId = safeProjectId(input.targetRootId);
    const assetIds = [...new Set(Array.isArray(input.assetIds) ? input.assetIds.map(cleanText).filter(Boolean) : [])];
    if (!projectId || !targetRootId || !assetIds.length || assetIds.length > 100) {
      throw artError("移动素材需要 1 至 100 个有效文件", 400, "ART_LIBRARY_MOVE_INVALID");
    }
    const targetSubdirectory = safeSubpath(input.targetSubdirectory, "目标目录");
    const preserveSubdirectories = input.preserveSubdirectories === true;
    const project = await loadProject(projectId, sources);
    const targetRoot = project.scanRoots.find((root) => root.id === targetRootId && root.movable && ["formal", "candidate", "archive"].includes(root.zone));
    if (!targetRoot) throw artError("目标目录没有登记为可移动素材区", 400, "ART_LIBRARY_MOVE_TARGET_INVALID");
    const index = await loadIndex(cacheDir, project, false);
    const items = assetIds.map((id) => index.items.find((item) => item.id === id));
    if (items.some((item) => !item)) throw artError("有素材已经不在当前索引中，请先检查更新", 409, "ART_LIBRARY_MOVE_STALE");
    const sourceRoots = new Map(project.scanRoots.map((root) => [root.id, root]));
    for (const item of items) {
      const sourceRoot = sourceRoots.get(item.scanRootId);
      if (!sourceRoot?.movable || item.zone === "platform") throw artError(`${item.name} 不属于可移动素材区`, 400, "ART_LIBRARY_MOVE_SOURCE_INVALID");
      if (item.zone === targetRoot.zone) throw artError(`${item.name} 已经位于${zoneLabel(targetRoot.zone)}`, 409, "ART_LIBRARY_MOVE_SAME_ZONE");
      if (item.referenceStatus !== "unreferenced") {
        const reason = item.referenceStatus === "using" ? "仍被游戏引用" : "引用状态无法确认";
        throw artError(`${item.name} ${reason}，不能由小秘书在 Godot 外部移动；请先解除引用，或从 Godot FileSystem 完成迁移`, 409, "ART_LIBRARY_MOVE_REFERENCE_BLOCKED");
      }
    }
    const destinationRoot = path.join(project.rootReal, targetRoot.path, targetSubdirectory);
    if (!isInside(project.rootReal, destinationRoot)) throw artError("目标目录逃离了项目", 400, "ART_LIBRARY_MOVE_TARGET_ESCAPE");
    const plans = items.map((item) => {
      const destinationDirectory = preserveSubdirectories && item.subdirectory
        ? path.join(destinationRoot, item.subdirectory)
        : destinationRoot;
      if (!isInside(project.rootReal, destinationDirectory)) throw artError("镜像目录逃离了项目", 400, "ART_LIBRARY_MOVE_TARGET_ESCAPE");
      const destination = path.join(destinationDirectory, item.name);
      return {
        item,
        source: path.join(project.rootReal, item.relativePath),
        destination,
        destinationRelative: slash(path.relative(project.rootReal, destination)),
      };
    });
    if (new Set(plans.map((plan) => plan.destination)).size !== plans.length) throw artError("所选素材中存在同名文件，不能移动到同一目录", 409, "ART_LIBRARY_MOVE_NAME_CONFLICT");
    for (const plan of plans) {
      try {
        await fs.access(plan.destination);
        throw artError(`目标目录已经有 ${plan.item.name}`, 409, "ART_LIBRARY_MOVE_CONFLICT");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const completed = [];
    try {
      if (targetRoot.engineIgnore) {
        const ignorePath = path.join(project.rootReal, targetRoot.path, ".gdignore");
        await fs.mkdir(path.dirname(ignorePath), { recursive: true });
        await fs.writeFile(ignorePath, "", { flag: "a" });
      }
      for (const plan of plans) {
        await fs.mkdir(path.dirname(plan.destination), { recursive: true });
        await fs.rename(plan.source, plan.destination);
        completed.push(plan);
      }
    } catch (error) {
      for (const plan of completed.reverse()) await fs.rename(plan.destination, plan.source).catch(() => undefined);
      throw error;
    }
    const batchId = crypto.randomUUID();
    const movedAt = new Date().toISOString();
    await appendMoveRows(project, plans.map((plan) => ({
      schemaVersion: 1,
      type: "move",
      operationId: crypto.randomUUID(),
      batchId,
      movedAt,
      hash: plan.item.hash,
      sourcePath: plan.item.relativePath,
      destinationPath: plan.destinationRelative,
      sourceZone: plan.item.zone,
      targetZone: targetRoot.zone,
    })));
    const refreshedProject = await loadProject(projectId, sources);
    await loadIndex(cacheDir, refreshedProject, true);
    return { ok: true, batchId, movedAt, count: plans.length, targetZone: targetRoot.zone };
  }

  async function undoMove(input = {}) {
    const projectId = safeProjectId(input.projectId);
    const batchId = cleanText(input.batchId);
    if (!projectId || !batchId) throw artError("撤销移动缺少项目或批次", 400, "ART_LIBRARY_UNDO_INVALID");
    const project = await loadProject(projectId, sources);
    const rows = await readMoveRows(project);
    const latest = latestUndoableMove(rows);
    if (!latest || latest.batchId !== batchId) throw artError("只能撤销最近一次尚未撤销的移动", 409, "ART_LIBRARY_UNDO_NOT_LATEST");
    const batch = rows.filter((row) => row.type === "move" && row.batchId === batchId);
    const index = await loadIndex(cacheDir, project, false);
    const currentByPath = new Map(index.items.map((item) => [item.relativePath, item]));
    for (const row of batch) {
      const current = currentByPath.get(row.destinationPath);
      if (current?.referenceStatus !== "unreferenced") {
        throw artError(`${path.basename(row.destinationPath)} 已被游戏引用或引用状态不明，不能从 Godot 外部自动撤销`, 409, "ART_LIBRARY_UNDO_REFERENCE_BLOCKED");
      }
      const source = path.join(project.rootReal, safeRelative(row.sourcePath, "撤销来源"));
      const destination = path.join(project.rootReal, safeRelative(row.destinationPath, "撤销目标"));
      try { await fs.access(source); throw artError(`原位置已经存在 ${path.basename(source)}`, 409, "ART_LIBRARY_UNDO_CONFLICT"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      const actualHash = crypto.createHash("sha256").update(await fs.readFile(destination)).digest("hex");
      if (actualHash !== row.hash) throw artError(`${path.basename(destination)} 移动后已被修改，不能自动撤销`, 409, "ART_LIBRARY_UNDO_CHANGED");
    }
    const completed = [];
    try {
      for (const row of [...batch].reverse()) {
        const source = path.join(project.rootReal, row.sourcePath);
        const destination = path.join(project.rootReal, row.destinationPath);
        await fs.mkdir(path.dirname(source), { recursive: true });
        await fs.rename(destination, source);
        completed.push({ source, destination });
      }
    } catch (error) {
      for (const plan of completed.reverse()) await fs.rename(plan.source, plan.destination).catch(() => undefined);
      throw error;
    }
    await appendMoveRows(project, [{ schemaVersion: 1, type: "undo", batchId, undoneAt: new Date().toISOString() }]);
    const refreshedProject = await loadProject(projectId, sources);
    await loadIndex(cacheDir, refreshedProject, true);
    return { ok: true, batchId, count: batch.length };
  }

  async function openItem(input = {}) {
    const projectId = safeProjectId(input.projectId);
    const assetId = cleanText(input.assetId);
    const action = input.action === "reveal" ? "reveal" : input.action === "open" ? "open" : null;
    if (!projectId || !assetId || !action) throw artError("打开素材参数不完整", 400, "ART_LIBRARY_OPEN_INVALID");
    const resolved = await resolveItem(projectId, assetId);
    await execFileAsync("/usr/bin/open", action === "reveal" ? ["-R", resolved.absolute] : [resolved.absolute], { maxBuffer: 64 * 1024 });
    return { ok: true, action };
  }

  async function previewVisualReplacement(input = {}) {
    if (!vaultRoot || safeProjectId(input.projectId) !== SECRETARY_VISUAL_ASSET_PROJECT_ID) {
      throw artError("替换预览只适用于小秘书视觉资产", 400, "SECRETARY_VISUAL_REPLACEMENT_PROJECT_INVALID");
    }
    const { manifest } = await loadSecretaryVisualAssetCatalog(vaultRoot);
    return previewSecretaryVisualReplacement(manifest, cleanText(input.assetId));
  }

  async function sendThumbnail(response, input = {}) {
    const projectId = safeProjectId(input.projectId);
    const assetId = cleanText(input.assetId);
    const preset = thumbnailPreset(input.size);
    const size = preset.pixels;
    if (!projectId || !assetId) throw artError("缩略图参数不完整", 400, "ART_LIBRARY_THUMB_INVALID");
    const resolved = await resolveItem(projectId, assetId);
    const thumbDir = path.join(cacheDir, "thumbnails", projectId);
    const thumb = path.join(thumbDir, `${assetId}-${resolved.item.hash.slice(0, 12)}-${size}-q${preset.quality}.webp`);
    const jobKey = `${thumb}\0${resolved.absolute}`;
    try { await fs.access(thumb, fsConstants.R_OK); } catch {
      let job = thumbnailJobs.get(jobKey);
      if (!job) {
        job = (async () => {
          await fs.mkdir(thumbDir, { recursive: true });
          const temporary = `${thumb}.${process.pid}.${Date.now()}.tmp.webp`;
          const intermediate = `${thumb}.${process.pid}.${Date.now()}.source.png`;
          try {
            try {
              await sharp(resolved.absolute).rotate().resize({ width: size, height: size, fit: "inside", withoutEnlargement: true }).webp({ quality: preset.quality, alphaQuality: 80, effort: 4 }).toFile(temporary);
            } catch {
              await execFileAsync("/usr/bin/sips", ["-Z", String(size), "-s", "format", "png", resolved.absolute, "--out", intermediate], { maxBuffer: 512 * 1024 });
              await sharp(intermediate).webp({ quality: preset.quality, alphaQuality: 80, effort: 4 }).toFile(temporary);
            }
            await fs.rename(temporary, thumb);
          } finally {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
            await fs.rm(intermediate, { force: true }).catch(() => undefined);
          }
        })().finally(() => thumbnailJobs.delete(jobKey));
        thumbnailJobs.set(jobKey, job);
      }
      await job;
    }
    void maybePruneThumbnailCache(cacheDir).catch(() => undefined);
    const stat = await fs.stat(thumb);
    response.statusCode = 200;
    response.setHeader("Content-Type", "image/webp");
    response.setHeader("Content-Length", stat.size);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.setHeader("ETag", `\"${resolved.item.hash.slice(0, 24)}-${size}\"`);
    createReadStream(thumb).pipe(response);
  }

  async function streamOriginal(request, response, input = {}) {
    const projectId = safeProjectId(input.projectId);
    const assetId = cleanText(input.assetId);
    if (!projectId || !assetId) throw artError("预览参数不完整", 400, "ART_LIBRARY_PREVIEW_INVALID");
    const resolved = await resolveItem(projectId, assetId);
    response.statusCode = 200;
    response.setHeader("Content-Type", resolved.item.mimeType);
    response.setHeader("Content-Length", resolved.item.bytes);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(resolved.item.name)}`);
    if (request.method === "HEAD") return response.end();
    createReadStream(resolved.absolute).pipe(response);
  }

  // Notes and attention share an append-only record. Serialize their read/modify/write
  // operations so simultaneous saves cannot overwrite each other's fields.
  const annotationWrites = new Map();
  function serializeAnnotationWrite(operation) {
    return (input = {}) => {
      const key = safeProjectId(input.projectId) || "";
      const previous = annotationWrites.get(key) || Promise.resolve();
      const result = previous.catch(() => undefined).then(() => operation(input));
      annotationWrites.set(key, result);
      const clear = () => { if (annotationWrites.get(key) === result) annotationWrites.delete(key); };
      void result.then(clear, clear);
      return result;
    };
  }

  return {
    projects, snapshot, browse, usage, semantic, resolveLinkedItems, appendDecision,
    appendAnnotation: serializeAnnotationWrite(appendAnnotation),
    setAssetAttention: serializeAnnotationWrite(setAssetAttention),
    setAssetsAttention: serializeAnnotationWrite(setAssetsAttention),
    seedFormalAnnotations: serializeAnnotationWrite(seedFormalAnnotations),
    moveAssets, undoMove, openItem, previewVisualReplacement, sendThumbnail, streamOriginal, resolveItem,
  };
}
