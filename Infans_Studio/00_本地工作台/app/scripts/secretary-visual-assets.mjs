import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { resolveWritableVaultPath, withVaultFileWrite } from "../src/server/workbench-file-write-guard.mjs";
import {
  SECRETARY_VISUAL_ASSET_MANIFEST_PATH,
  SECRETARY_VISUAL_ASSET_PROJECT_ID,
  SECRETARY_VISUAL_ASSET_ROOT,
  isSecretaryVisualRuntimePath,
  validateSecretaryVisualAssetManifest,
} from "../src/server/workbench-secretary-visual-assets.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VAULT_ROOT = path.resolve(scriptDir, "../../..");
const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".icns", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".psd", ".avif", ".mov", ".mp4", ".webm"]);
const TEXT_EXTENSIONS = new Set([".md", ".json", ".webmanifest", ".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".html", ".swift", ".plist", ".pbxproj", ".sh", ".py", ".toml", ".yaml", ".yml"]);
const LEDGER_PATH = path.posix.join(SECRETARY_VISUAL_ASSET_ROOT, "迁移记录", "2026-09-02_小秘书视觉资产迁移前账本.md");
const AVATAR_REVIEW_PATH = path.posix.join(SECRETARY_VISUAL_ASSET_ROOT, "迁移记录", "2026-09-02_头像审核索引.md");
const CANDIDATE_ASSET_ROOT = path.posix.join(SECRETARY_VISUAL_ASSET_ROOT, "候选");
const REFERENCE_ASSET_ROOT = path.posix.join(SECRETARY_VISUAL_ASSET_ROOT, "来源", "2026-08-29_凡人角色动画参考帧");
const PRIVATE_FORMAL_PATHS = new Set();

function isCandidateAssetPath(relative) {
  return relative === CANDIDATE_ASSET_ROOT || relative.startsWith(`${CANDIDATE_ASSET_ROOT}/`);
}

const SUBJECT_PATTERNS = [
  ["用户", /UserChatAvatar/iu],
  ["银月", /yinyue|银月/iu],
  ["梅凝", /meining|梅凝/iu],
];

const SUBJECT_SLUGS = new Map([
  ["小秘书", "secretary"], ["小秘书视觉系统", "visual-system"], ["用户", "user"],
  ["银月", "yinyue"], ["梅凝", "meining"],
]);
const KIND_SLUGS = new Map([
  ["产品与入口图标", "icon"], ["头像", "avatar"], ["聊天立绘", "portrait"], ["场景与房间", "room"], ["桌宠与图集", "pet"],
  ["动画与姿态", "animation"], ["功能反馈与入口", "entry"], ["视觉参考与验收", "reference"], ["页面功能素材", "page-asset"], ["页面背景与场景", "scene"],
]);

const FORMAL_PATHS = new Set([
  ...PRIVATE_FORMAL_PATHS,
  "00_本地工作台/app/native/yinyue-real-photo-source.v1.jpg",
  "00_本地工作台/app/native/yinyue-real-avatar-source.v1.png",
  "00_本地工作台/app/native/yinyue-real-ios-app-icon-source.v1.png",
  "00_本地工作台/app/native/yinyue-real-chat-background-landscape-source.v1.png",
  "00_本地工作台/app/native/secretary-app-icon-yinyue-v2.png",
  "00_本地工作台/app/native/secretary-pet/yinyue-pet-approved-source.png",
  "00_本地工作台/chrome-extension-发给秘书/assets/secretary-extension-icon-source.png",
  "00_本地工作台/app/public/theme/schedule-yinyue.v1.avif",
  "00_本地工作台/app/public/theme/schedule-yinyue-day.v1.avif",
  "00_本地工作台/app/public/theme/secretary-room-yinyue-young.v1.png",
  "00_本地工作台/app/public/theme/secretary-avatar-yinyue.v1.png",
  "00_本地工作台/app/public/theme/secretary-avatar-yinyue-chat.v2.png",
  "00_本地工作台/app/public/theme/refresh-portrait-yinyue.v1.png",
  "00_本地工作台/app/public/theme/avatar-meining.v2.png",
  "00_本地工作台/app/public/theme/chat-meining.v2.png",
  "00_本地工作台/app/public/theme/schedule-meining-original.v1.avif",
  "00_本地工作台/app/public/theme/schedule-meining-original-day.v1.avif",
  "00_本地工作台/app/public/theme/codex-pet-qingyi-idle.avif",
]);

function slash(value) { return String(value || "").replaceAll("\\", "/").replace(/^\.\//u, ""); }
function escapeTable(value) { return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>"); }
function slug(value) {
  return String(value || "asset").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "asset";
}

function isIgnored(relative) {
  const parts = relative.split("/");
  return parts.some((part) => [".git", ".codex", ".cursor", ".agents", ".codex-work", "node_modules", "dist", "build", "DerivedData", "coverage", "__pycache__"].includes(part))
    || relative === "00_本地工作台/本人草稿" || relative.startsWith("00_本地工作台/本人草稿/")
    || parts.some((part) => part === ".dist" || part.startsWith(".dist-refresh-"))
    || relative.startsWith("00_本地工作台/app/public/ai-tools/")
    || relative.startsWith("00_本地工作台/app/public/music/")
    || relative.startsWith("00_本地工作台/派生数据/")
    || (relative.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)
      && !isCandidateAssetPath(relative)
      && relative !== REFERENCE_ASSET_ROOT
      && !relative.startsWith(`${REFERENCE_ASSET_ROOT}/`)
      && !PRIVATE_FORMAL_PATHS.has(relative));
}

function isInScope(relative) {
  if (isIgnored(relative)) return false;
  return relative.startsWith("00_本地工作台/UI设计参考/")
    || PRIVATE_FORMAL_PATHS.has(relative)
    || relative.startsWith(`${REFERENCE_ASSET_ROOT}/`)
    || isCandidateAssetPath(relative)
    || relative.startsWith("00_本地工作台/30_证据/2026-08-12_梅凝浮动宠物/")
    || relative.startsWith("00_本地工作台/30_证据/2026-08-23_银月浮动宠物/")
    || relative.startsWith("00_本地工作台/30_证据/2026-08-24_银月图标候选/")
    || relative.startsWith("00_本地工作台/app/native/")
    || relative.startsWith("00_本地工作台/app/public/theme/")
    || /00_本地工作台\/app\/public\/(?:apple-touch-icon|favicon-|secretary-icon-)/u.test(relative)
    || relative.startsWith("00_本地工作台/chrome-extension-发给秘书/")
    || relative.startsWith("00_本地工作台/codex-marketplace/plugins/yinyue-read-aloud/assets/")
    || relative.startsWith("00_本地工作台/主题壁纸/")
    || relative.startsWith("00_本地工作台/小秘书.app/Contents/Resources/")
    || relative.startsWith("00_本地工作台/10_设计/50_视觉资产/小秘书/来源/2026-08-29_凡人角色动画参考帧/");
}

async function walk(root, relative = "", output = []) {
  const absolute = path.join(root, relative);
  let entries;
  try { entries = await fs.readdir(absolute, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = slash(path.posix.join(relative, entry.name));
    const leadsToCandidateAssets = CANDIDATE_ASSET_ROOT.startsWith(`${child}/`);
    const leadsToReferenceAssets = child === REFERENCE_ASSET_ROOT || REFERENCE_ASSET_ROOT.startsWith(`${child}/`);
    const leadsToPrivateFormalAssets = [...PRIVATE_FORMAL_PATHS].some((item) => item.startsWith(`${child}/`));
    if (isIgnored(child) && !leadsToCandidateAssets && !leadsToReferenceAssets && !leadsToPrivateFormalAssets) continue;
    if (entry.isDirectory()) await walk(root, child, output);
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

async function metadata(absolute, extension) {
  if ([".mov", ".mp4", ".webm"].includes(extension)) {
    try {
      const { stdout } = await execFileAsync("/usr/bin/avmediainfo", [absolute]);
      const dimensions = stdout.match(/Presentation Dimensions:\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/u)
        || stdout.match(/Dimensions:\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/u);
      if (dimensions) {
        return { width: Math.round(Number(dimensions[1])) || null, height: Math.round(Number(dimensions[2])) || null, hasAlpha: null };
      }
    } catch { /* fall through to the keyed Spotlight fallback */ }
    try {
      const { stdout } = await execFileAsync("/usr/bin/mdls", ["-name", "kMDItemPixelWidth", "-name", "kMDItemPixelHeight", absolute]);
      return {
        width: Number(stdout.match(/kMDItemPixelWidth\s*=\s*(\d+)/u)?.[1]) || null,
        height: Number(stdout.match(/kMDItemPixelHeight\s*=\s*(\d+)/u)?.[1]) || null,
        hasAlpha: null,
      };
    } catch { return { width: null, height: null, hasAlpha: null }; }
  }
  try {
    const info = await sharp(absolute, { animated: true, limitInputPixels: false }).metadata();
    return { width: info.width || null, height: info.height || null, hasAlpha: info.hasAlpha ?? null };
  } catch {
    try {
      const { stdout } = await execFileAsync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", absolute]);
      return {
        width: Number(stdout.match(/pixelWidth:\s*(\d+)/u)?.[1]) || null,
        height: Number(stdout.match(/pixelHeight:\s*(\d+)/u)?.[1]) || null,
        hasAlpha: stdout.match(/hasAlpha:\s*(yes|no)/iu)?.[1]?.toLowerCase() === "yes",
      };
    } catch { return { width: null, height: null, hasAlpha: null }; }
  }
}

async function trackedPaths(vaultRoot) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/git", ["-C", vaultRoot, "ls-files", "-z"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    return new Set(stdout.toString("utf8").split("\0").filter(Boolean).map(slash));
  } catch { return new Set(); }
}

function subjectFor(paths) {
  const source = paths.join("\n");
  if (/codex-pet-qingyi-idle/iu.test(source)) return "梅凝";
  for (const [subject, pattern] of SUBJECT_PATTERNS) if (pattern.test(source)) return subject;
  if (/native\/secretary-pet|小秘书\.app\/Contents\/Resources\/secretary-pet/iu.test(source)) return "银月";
  if (/appicon|secretary-icon|favicon|apple-touch|secretary-app-icon/iu.test(source)) return "小秘书";
  return "小秘书视觉系统";
}

function kindFor(paths) {
  const source = paths.join("\n").toLowerCase();
  if (/appicon|app-icon|secretary-(?:app-)?icon|favicon|apple-touch|extension-icon|yinyue-(?:16|32|48|128)\.png|assets\/icon\.svg/u.test(source)) return "产品与入口图标";
  if (/chat-background|background/u.test(source)) return "页面背景与场景";
  if (/avatar|portrait|肖像/u.test(source)) return "头像";
  if (/chat-|stage|立绘/u.test(source)) return "聊天立绘";
  if (/room|房间/u.test(source)) return "场景与房间";
  if (/\.mov$|\.gif$|keyframes|animation/u.test(source)) return "动画与姿态";
  if (/pet|桌宠|小人|atlas/u.test(source)) return "桌宠与图集";
  if (/refresh|share-background/u.test(source)) return "功能反馈与入口";
  if (/contact-sheet|validation|ui设计参考|风格参考|参考帧|reference/u.test(source)) return "视觉参考与验收";
  if (/theme\/photos\//u.test(source)) return "页面功能素材";
  return "页面背景与场景";
}

function assetClassFor(paths) {
  const source = paths.join("\n").toLowerCase();
  if (paths.every((item) => /小秘书\.app\/contents\/resources|previews\/|contact-sheet|video-contact-sheet/iu.test(item))) return "cache";
  if (/approved-source|identity-source|icon-source|source(?:-|\.)|用户原图|主题壁纸|中转站/u.test(source)) return "source";
  if (paths.some((item) => FORMAL_PATHS.has(item))) return "master";
  return "derivative";
}

function governanceFor(paths) {
  if (paths.some((item) => FORMAL_PATHS.has(item))) return "formal";
  const source = paths.join("\n").toLowerCase();
  if (/候选|中转站|ui设计参考|reference|参考帧|workshop|luoyu/u.test(source)) return "candidate";
  if (/30_证据|小秘书\.app\/contents\/resources|secretary-app-icon\.png|\.v1\.|\.v2\.|\.v3/u.test(source)) return "legacy-reference";
  return "needs-confirmation";
}

function categoryFor(kind, governanceStatus) {
  if (governanceStatus === "candidate") return "候选";
  if (kind === "产品与入口图标") return "功能入口";
  if (["头像", "聊天立绘"].includes(kind)) return "角色";
  if (kind === "场景与房间" || kind === "页面背景与场景" || kind === "页面功能素材") return "场景与房间";
  if (kind === "桌宠与图集" || kind === "动画与姿态") return "桌宠与动画";
  if (kind === "功能反馈与入口") return "功能入口";
  return "迁移记录";
}

function provenanceFor(paths) {
  const source = paths.join("\n");
  if (/UserChatAvatar/iu.test(source)) return { origin: "user-provided", creator: "user", license: "private-local", aiGenerated: false, reviewStatus: "confirmed" };
  if (/落雨无声|luoyu|工坊预览|workshop/iu.test(source)) return { origin: "third-party-reference", creator: "Wallpaper Engine · 落雨无声（路径或角色登记提供）", license: "needs-confirmation", aiGenerated: "unknown", reviewStatus: "partial" };
  if (/BV[0-9A-Za-z]+|凡人修仙传/iu.test(source)) return { origin: "third-party-reference", creator: "《凡人修仙传》相关素材（具体授权待核）", license: "reference-only-needs-confirmation", aiGenerated: false, reviewStatus: "partial" };
  if (/AI|候选|yinyue-extension-icon-source|secretary-app-icon-yinyue/iu.test(source)) return { origin: "ai-or-local-derived", creator: "本地生成或整理（具体生成记录待补）", license: "private-local", aiGenerated: "likely", reviewStatus: "partial" };
  return { origin: "unknown", creator: null, license: "needs-confirmation", aiGenerated: "unknown", reviewStatus: "unknown" };
}

function privacyFor(paths) {
  const source = paths.join("\n");
  if (/用户原图|私人|UserChatAvatar/iu.test(source)) return { level: "private-local", containsPrivatePhoto: true, publishable: false };
  if (/app\/public|chrome-extension|codex-marketplace/iu.test(source)) return { level: "runtime-visible", containsPrivatePhoto: false, publishable: "needs-confirmation" };
  return { level: "private-local", containsPrivatePhoto: false, publishable: "needs-confirmation" };
}

function consumerKind(relative) {
  if (relative.includes("/tests/")) return "test";
  if (relative.endsWith(".md")) return "documentation";
  if (relative.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)) return "asset-record";
  if (relative.includes("/scripts/")) return "build-script";
  if (relative.includes(".xcodeproj/") || relative.endsWith("Contents.json") || relative.endsWith("manifest.json") || relative.endsWith(".webmanifest")) return "manifest";
  if (relative.startsWith("00_本地工作台/小秘书.app/")) return "packaged-runtime";
  return "runtime-source";
}

function consumerDevice(relative) {
  if (relative.includes("InfansHealthSyncWatch")) return "Watch";
  if (relative.includes("InfansShareExtension")) return "iPhone/iPad Share Extension";
  if (relative.includes("InfansHealthSync")) return "iPhone/iPad";
  if (relative.includes("chrome-extension")) return "Chrome";
  if (relative.includes("codex-marketplace")) return "Codex";
  if (relative.includes("native/SecretaryApp") || relative.includes("小秘书.app")) return "Mac";
  if (relative.includes("app/public") || relative.includes("app/src")) return "Web/PWA";
  return "治理与证据";
}

async function textCorpus(vaultRoot, allFiles) {
  const rows = [];
  for (const relative of allFiles) {
    if (isIgnored(relative) || isDerivedEvidence(relative) || !isConsumerScope(relative) || !TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    try {
      const stat = await fs.stat(path.join(vaultRoot, relative));
      if (stat.size > 2 * 1024 * 1024) continue;
      rows.push({ path: relative, text: await fs.readFile(path.join(vaultRoot, relative), "utf8") });
    } catch { /* 单个文本损坏不阻断盘点。 */ }
  }
  return rows;
}

function isConsumerScope(relative) {
  return relative.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)
    || ["00_本地工作台/app/index.html", "00_本地工作台/app/package.json", "00_本地工作台/app/vite.config.ts"].includes(relative)
    || /^00_本地工作台\/app\/(?:src|scripts|tests|public|native)\//u.test(relative)
    || /^00_本地工作台\/(?:chrome-extension-[^/]+|codex-marketplace|小秘书\.app\/Contents)\//u.test(relative);
}

function isDerivedEvidence(relative) {
  if (/(?:^|\/)(?:30_证据|迁移记录|预览|审阅|previews?|screenshots?)(?:\/|$)/iu.test(relative)) return true;
  if (!relative.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)) return false;
  const name = path.basename(relative);
  return /^(?:asset-manifest|curation|generation-records|acceptance-and-wiring|index\.html)/iu.test(name)
    || /(?:^|[-_.])(?:before|audit|receipt|verification|proposal|qa-result|contact-sheet)(?:[-_.]|$)/iu.test(name)
    || /(?:核查|回执|恢复清单|接线建议|验收矩阵)/u.test(name);
}

function consumerEvidence(text, paths, uniqueBasenames) {
  for (const token of paths.flatMap((relative) => referenceTokens(relative, uniqueBasenames))) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    // A basename inside another qualified path is not evidence for this file.
    if (new RegExp(`(?<![\\p{L}\\p{N}_.\\-/])${escaped}(?![\\p{L}\\p{N}_.\\-/])`, "u").test(text)) return token;
  }
  return null;
}

function referenceTokens(relative, uniqueBasenames) {
  const tokens = [relative];
  if (relative.startsWith("00_本地工作台/app/")) tokens.push(relative.slice("00_本地工作台/app/".length));
  if (relative.startsWith("00_本地工作台/app/public/")) tokens.push(`/${relative.slice("00_本地工作台/app/public/".length)}`);
  const basename = path.basename(relative);
  if (uniqueBasenames.has(basename)) {
    tokens.push(basename);
  }
  return [...new Set(tokens.filter((token) => token.length > 5))];
}

function addConsumer(consumers, row, evidence) {
  if (!row || consumers.some((item) => item.path === row.path && item.evidence === evidence)) return;
  consumers.push({ path: row.path, kind: consumerKind(row.path), device: consumerDevice(row.path), evidence });
}

function isAssetCatalogContents(relative) {
  return relative.includes(".xcassets/") && path.posix.basename(relative) === "Contents.json";
}

function addImplicitAssetCatalogConsumers(consumers, currentPaths, corpus) {
  const rowsByPath = new Map(corpus.map((row) => [row.path, row]));
  for (const currentPath of currentPaths.filter((item) => item.includes(".xcassets/"))) {
    const contentsPath = path.posix.join(path.posix.dirname(currentPath), "Contents.json");
    const contents = rowsByPath.get(contentsPath);
    let images;
    try { images = JSON.parse(contents?.text || "null")?.images; } catch { continue; }
    if (!Array.isArray(images) || !images.some((item) => item.filename === path.posix.basename(currentPath))) continue;
    addConsumer(consumers, contents, `asset-catalog:${path.posix.basename(path.posix.dirname(currentPath))}`);
    if (!currentPath.includes(".appiconset/")) continue;
    const projectPrefix = currentPath.slice(0, currentPath.indexOf("/InfansHealthSync/") + "/InfansHealthSync".length);
    const projectPath = `${projectPrefix}/InfansHealthSync.xcodeproj/project.pbxproj`;
    const project = rowsByPath.get(projectPath);
    if (project?.text.includes("ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon")) {
      addConsumer(consumers, project, "ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon");
    }
  }
}

async function officialMediaPaths(vaultRoot, relative = SECRETARY_VISUAL_ASSET_ROOT, output = []) {
  let entries;
  try { entries = await fs.readdir(path.join(vaultRoot, relative), { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return output; throw error; }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || [".git", ".infans", "node_modules"].includes(entry.name)) continue;
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await officialMediaPaths(vaultRoot, child, output);
    else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(child);
  }
  return output;
}

function plannedPath(assetId, subject, kind, assetClass, governanceStatus, canonicalPath) {
  if (!["source", "master"].includes(assetClass)) return null;
  if (canonicalPath.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)) return canonicalPath;
  const category = categoryFor(kind, governanceStatus === "formal" ? "formal" : "candidate");
  const basename = path.basename(canonicalPath).replace(/[^\p{L}\p{N}._-]+/gu, "-");
  return path.posix.join(SECRETARY_VISUAL_ASSET_ROOT, category, subject, kind, `${assetId}-${basename}`);
}

function referenceStatus(consumers, assetClass) {
  if (consumers.some((consumer) => ["runtime-source", "manifest", "build-script", "packaged-runtime"].includes(consumer.kind))) return "referenced";
  if (consumers.length || ["source", "master"].includes(assetClass)) return "unknown";
  return "unreferenced";
}

function buildSummary(assets) {
  const countBy = (key) => Object.fromEntries([...new Set(assets.map((asset) => asset[key]))]
    .sort((left, right) => String(left).localeCompare(String(right), "zh-CN"))
    .map((value) => [value, assets.filter((asset) => asset[key] === value).length]));
  return {
    assetCount: assets.length,
    fileCount: assets.reduce((sum, asset) => sum + asset.currentPaths.length, 0),
    byGovernanceStatus: countBy("governanceStatus"),
    byAssetClass: countBy("assetClass"),
    byReferenceStatus: countBy("referenceStatus"),
  };
}

function applyKnownLineage(assets) {
  const find = (pattern) => assets.find((asset) => asset.currentPaths.some((item) => pattern.test(item)));
  const link = (masterPattern, childPatterns) => {
    const master = find(masterPattern);
    if (!master) return;
    for (const pattern of childPatterns) {
      for (const child of assets.filter((asset) => asset.assetId !== master.assetId && asset.currentPaths.some((item) => pattern.test(item)))) {
        if (!master.derivatives.includes(child.assetId)) master.derivatives.push(child.assetId);
        child.derivedFrom ||= master.assetId;
      }
    }
  };
  link(/yinyue-real-avatar-source\.v1\.png$/u, [/secretary-avatar-yinyue-chat\.v3\.png$/u]);
  link(/yinyue-real-ios-app-icon-source\.v1\.png$/u, [/InfansHealthSync\/Assets\.xcassets\/AppIcon\.appiconset\/AppIcon\.png$/u]);
  link(/secretary-app-icon-yinyue-v2\.png$/u, [/secretary-app-icon\.png$/u]);
  link(/yinyue-extension-icon-source\.png$/u, [/icons\/yinyue-(?:16|32|48|128)\.png$/u]);
  link(/yinyue-pet-approved-source\.png$/u, [/identity-source\.(?:png|webp)$/u, /secretary-pet-atlas\.png$/u]);
  for (const asset of assets) asset.derivatives.sort();
}

async function applySceneRecompositions(assets, vaultRoot) {
  const recordPath = `${CANDIDATE_ASSET_ROOT}/场景构图/2026-09-03/candidate-records.v1.json`;
  let records;
  try { records = JSON.parse(await fs.readFile(path.join(vaultRoot, recordPath), "utf8")).records; }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  const find = (relative) => assets.find(asset => asset.currentPaths.includes(relative));
  for (const record of records) {
    const input = find(record.input), source = find(record.source), runtime = find(record.runtime);
    if (!input || !source || !runtime) throw new Error(`场景构图缺少来源或派生：${record.name}`);
    const replaced = record.replaces ? find(record.replaces) : input;
    if (!replaced) throw new Error(`场景构图缺少被替换版本：${record.name}`);
    source.derivedFrom = input.assetId;
    input.derivatives = [...new Set([...input.derivatives, source.assetId])].sort();
    source.derivatives = [...new Set([...source.derivatives, runtime.assetId])].sort();
    runtime.derivedFrom = source.assetId;
    for (const asset of [source, runtime]) {
      asset.stage = "candidate";
      asset.governanceStatus = "candidate";
      asset.provenance = {origin:"ai-generated",creator:"imagegen",aiGenerated:true,license:"needs-confirmation",reviewStatus:record.rejected ? "rejected" : "pending",recordPath};
      asset.review = record.rejected
        ? {needsCapoo:false,decision:"rejected-by-capoo",reason:record.feedback}
        : {needsCapoo:true,decision:"authorized-recomposition-pending-visual-review"};
    }
    runtime.replaces = [replaced.assetId];
  }
}

function applyFormalConsumerVerification(assets) {
  const activeConsumerKinds = new Set(["runtime-source", "manifest", "build-script", "packaged-runtime"]);
  for (const asset of assets.filter((item) => item.governanceStatus === "formal")) {
    const runtimePaths = asset.currentPaths.filter((item) => isSecretaryVisualRuntimePath(item));
    const activeConsumers = asset.consumers.filter((item) => activeConsumerKinds.has(item.kind));
    const exceptions = [];
    if (!runtimePaths.length) exceptions.push("no-runtime-mirror");
    if (!activeConsumers.length) exceptions.push("consumer-reference-unresolved");
    asset.migration.consumersUpdated = exceptions.length === 0;
    asset.migration.consumerStatus = exceptions.length === 0
      ? "runtime-mirrors-and-consumers-verified"
      : "explicit-exception";
    asset.migration.consumerExceptions = exceptions;
    if (exceptions.length && !asset.exceptions.includes("consumer-update-pending")) {
      asset.exceptions.push("consumer-update-pending");
      asset.exceptions.sort();
    }
  }
}

async function verifiedFileRow(vaultRoot, relative, expectedHash, tracked) {
  const absolute = path.resolve(vaultRoot, relative);
  const buffer = await fs.readFile(absolute);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (hash !== expectedHash) throw new Error(`正式母版摘要不一致：${relative}`);
  const stat = await fs.stat(absolute);
  const extension = path.extname(relative).toLowerCase();
  return {
    path: relative,
    bytes: stat.size,
    format: extension.slice(1).toUpperCase(),
    ...(await metadata(absolute, extension)),
    hash,
    gitStatus: tracked.has(relative) ? "tracked" : "untracked",
  };
}

async function adoptExistingFormalSources(assets, vaultRoot, tracked) {
  let migrated = 0;
  for (const asset of assets.filter((item) => item.governanceStatus === "formal" && item.plannedCanonicalPath)) {
    const migrationSourcePath = asset.canonicalPath;
    let official;
    try {
      official = await verifiedFileRow(vaultRoot, asset.plannedCanonicalPath, asset.hash.slice(7), tracked);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const baseline = asset.files[0];
    if (official.width !== baseline.width || official.height !== baseline.height || official.format !== baseline.format) {
      throw new Error(`正式母版媒体事实不一致：${asset.plannedCanonicalPath}`);
    }
    asset.currentPaths = [asset.plannedCanonicalPath, ...asset.currentPaths.filter((item) => item !== asset.plannedCanonicalPath)];
    asset.files = [official, ...asset.files.filter((item) => item.path !== asset.plannedCanonicalPath)];
    asset.canonicalPath = asset.plannedCanonicalPath;
    asset.assetClass = "master";
    asset.plannedDisposition = "official-master-current";
    asset.migration = {
      status: "formal-baseline-migrated",
      oldToNewVerified: true,
      consumersUpdated: false,
      syncDirection: "official-source-to-runtime-only",
      sourcePath: migrationSourcePath,
    };
    migrated += 1;
  }
  return migrated;
}

export async function buildSecretaryVisualAssetManifest({ vaultRoot = DEFAULT_VAULT_ROOT, snapshotDate } = {}) {
  vaultRoot = path.resolve(vaultRoot);
  let original;
  try { original = await fs.readFile(path.join(vaultRoot, SECRETARY_VISUAL_ASSET_MANIFEST_PATH), "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (original === undefined) return bootstrapSecretaryVisualAssetManifest({ vaultRoot, snapshotDate: snapshotDate || "2026-09-02" });
  const baseline = JSON.parse(original);
  const validation = await validateSecretaryVisualAssetManifest(baseline, { requireFiles: false });
  if (!validation.ok) throw new Error(`拒绝重建无效原件：${validation.errors.join("；")}`);
  const date = snapshotDate || baseline.snapshotDate;
  const allFiles = await walk(vaultRoot);
  const tracked = await trackedPaths(vaultRoot);
  const corpus = await textCorpus(vaultRoot, allFiles);
  const registeredPaths = new Set(baseline.assets.flatMap((asset) => asset.currentPaths));
  // Registered paths remain authoritative, including official sources outside scan roots.
  const possibleMedia = new Set([...registeredPaths, ...await officialMediaPaths(vaultRoot), ...allFiles.filter((relative) => isInScope(relative) && MEDIA_EXTENSIONS.has(path.extname(relative).toLowerCase()))]);
  const registeredOwners = new Map(baseline.assets.flatMap((asset) => asset.currentPaths.map((relative) => [relative, asset.assetId])));
  const basenameOwners = new Map();
  for (const relative of possibleMedia) {
    const name = path.basename(relative);
    const owners = basenameOwners.get(name) || new Set();
    owners.add(registeredOwners.get(relative) || `unregistered:${relative}`);
    basenameOwners.set(name, owners);
  }
  const uniqueBasenames = new Set([...basenameOwners].filter(([, owners]) => owners.size === 1).map(([name]) => name));
  const assets = [];
  for (const previous of baseline.assets) {
    const asset = structuredClone(previous);
    asset.files = [];
    for (const relative of asset.currentPaths) {
      await resolveWritableVaultPath(vaultRoot, relative);
      asset.files.push(await verifiedFileRow(vaultRoot, relative, asset.hash.slice(7), tracked));
    }
    asset.consumers = [];
    for (const row of corpus) {
      if (asset.currentPaths.includes(row.path) || isAssetCatalogContents(row.path)) continue;
      const evidence = consumerEvidence(row.text, asset.currentPaths, uniqueBasenames);
      if (evidence) addConsumer(asset.consumers, row, evidence);
    }
    addImplicitAssetCatalogConsumers(asset.consumers, asset.currentPaths, corpus);
    asset.consumers.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
    asset.referenceStatus = referenceStatus(asset.consumers, asset.assetClass);
    asset.lastVerified = date;
    assets.push(asset);
  }
  const discoveries = [];
  for (const relative of [...possibleMedia].filter((item) => !registeredPaths.has(item)).sort()) {
    const buffer = await fs.readFile(path.join(vaultRoot, relative));
    discoveries.push({ path: relative, hash: `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`, classification: isDerivedEvidence(relative) ? "preview-or-evidence" : "unregistered-media" });
  }
  // Discovery is a report, never permission to resurrect rejected/deleted candidates.
  await adoptExistingFormalSources(assets.filter((asset) => asset.canonicalPath !== asset.plannedCanonicalPath && asset.migration?.status !== "formal-baseline-migrated"), vaultRoot, tracked);
  applyFormalConsumerVerification(assets);
  const manifest = {
    ...baseline,
    phase: baseline.phase === "pre-migration" && assets.some((asset) => asset.governanceStatus === "formal") && assets.filter((asset) => asset.governanceStatus === "formal").every((asset) => asset.migration?.status === "formal-baseline-migrated") ? "formal-baseline-migrated" : baseline.phase,
    snapshotDate: date,
    assets,
    summary: buildSummary(assets),
    rebuildReport: { policy: "registered-paths-and-hashes-only; discoveries-require-registration", discoveries },
  };
  // Do not return a mixed snapshot if another writer changed its authority while scanning.
  if (await fs.readFile(path.join(vaultRoot, SECRETARY_VISUAL_ASSET_MANIFEST_PATH), "utf8") !== original) {
    throw new Error("视觉资产原件在重建期间变化，请基于最新清单重试");
  }
  return manifest;
}

async function bootstrapSecretaryVisualAssetManifest({ vaultRoot = DEFAULT_VAULT_ROOT, snapshotDate = "2026-09-02" } = {}) {
  vaultRoot = path.resolve(vaultRoot);
  const allFiles = await walk(vaultRoot);
  const mediaPaths = allFiles.filter((relative) => MEDIA_EXTENSIONS.has(path.extname(relative).toLowerCase()) && isInScope(relative)).sort((left, right) => left.localeCompare(right, "zh-CN"));
  const tracked = await trackedPaths(vaultRoot);
  const corpus = await textCorpus(vaultRoot, allFiles);
  const files = [];
  for (const relative of mediaPaths) {
    const absolute = path.join(vaultRoot, relative);
    const buffer = await fs.readFile(absolute);
    const stat = await fs.stat(absolute);
    const extension = path.extname(relative).toLowerCase();
    files.push({
      path: relative,
      bytes: stat.size,
      format: extension.slice(1).toUpperCase(),
      ...(await metadata(absolute, extension)),
      hash: crypto.createHash("sha256").update(buffer).digest("hex"),
      gitStatus: tracked.has(relative) ? "tracked" : "untracked",
    });
  }
  const byHash = new Map();
  for (const file of files) byHash.set(file.hash, [...(byHash.get(file.hash) || []), file]);
  const basenameHashes = new Map();
  for (const file of files) {
    const name = path.basename(file.path);
    const hashes = basenameHashes.get(name) || new Set();
    hashes.add(file.hash);
    basenameHashes.set(name, hashes);
  }
  const uniqueBasenames = new Set([...basenameHashes].filter(([, hashes]) => hashes.size === 1).map(([name]) => name));
  const assets = [];
  for (const [hash, groupedFiles] of byHash) {
    const currentPaths = groupedFiles.map((file) => file.path).sort((left, right) => left.localeCompare(right, "zh-CN"));
    const subject = subjectFor(currentPaths);
    const kind = kindFor(currentPaths);
    const assetClass = assetClassFor(currentPaths);
    const governanceStatus = governanceFor(currentPaths);
    const canonicalPath = [...currentPaths].sort((left, right) => {
      const score = (value) => (FORMAL_PATHS.has(value) ? -40 : 0) + (/source|原图|主题壁纸/u.test(value) ? -20 : 0) + (/小秘书\.app|30_证据/u.test(value) ? 20 : 0) + value.length / 1000;
      return score(left) - score(right) || left.localeCompare(right, "zh-CN");
    })[0];
    const assetId = `secvis-${SUBJECT_SLUGS.get(subject) || slug(subject)}-${KIND_SLUGS.get(kind) || slug(kind)}-${hash.slice(0, 12)}`;
    const consumers = [];
    const pathSet = new Set(currentPaths);
    for (const row of corpus) {
      if (pathSet.has(row.path) || isAssetCatalogContents(row.path)) continue;
      const matched = consumerEvidence(row.text, currentPaths, uniqueBasenames);
      if (matched) addConsumer(consumers, row, matched);
    }
    addImplicitAssetCatalogConsumers(consumers, currentPaths, corpus);
    consumers.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
    const provenance = provenanceFor(currentPaths);
    const exceptions = [];
    if (currentPaths.length > 1) exceptions.push("exact-duplicate-paths");
    if (provenance.reviewStatus !== "confirmed") exceptions.push("provenance-needs-review");
    if (!consumers.length) exceptions.push("consumer-unknown");
    if (governanceStatus !== "formal") exceptions.push("formal-status-needs-capoo");
    if (groupedFiles.some((file) => file.width === null || file.height === null || file.hasAlpha === null)) exceptions.push("media-metadata-partial");
    assets.push({
      assetId,
      subject,
      kind,
      assetClass,
      stage: governanceStatus === "formal" ? "approved" : "candidate",
      governanceStatus,
      canonicalPath,
      plannedCanonicalPath: plannedPath(assetId, subject, kind, assetClass, governanceStatus, canonicalPath),
      plannedDisposition: governanceStatus === "formal" ? "copy-master-after-review" : governanceStatus === "candidate" ? "keep-candidate-until-review" : "keep-current-path-and-map-only",
      currentPaths,
      files: groupedFiles.sort((left, right) => left.path.localeCompare(right.path, "zh-CN")),
      derivatives: [],
      derivedFrom: null,
      consumers,
      referenceStatus: referenceStatus(consumers, assetClass),
      focalPoint: null,
      provenance,
      privacy: privacyFor(currentPaths),
      hash: `sha256:${hash}`,
      replaces: [],
      replacedBy: null,
      migration: { status: "not-migrated", oldToNewVerified: false, consumersUpdated: false },
      review: { needsCapoo: governanceStatus !== "formal" || ["头像", "聊天立绘", "产品与入口图标"].includes(kind), decision: governanceStatus === "formal" ? "current-formal-baseline" : null },
      exceptions: [...new Set(exceptions)].sort(),
      lastVerified: snapshotDate,
    });
  }
  assets.sort((left, right) => left.assetId.localeCompare(right.assetId));
  const migratedFormalCount = await adoptExistingFormalSources(assets, vaultRoot, tracked);
  applyKnownLineage(assets);
  await applySceneRecompositions(assets, vaultRoot);
  applyFormalConsumerVerification(assets);
  const formalCount = assets.filter((asset) => asset.governanceStatus === "formal").length;
  const phase = formalCount > 0 && migratedFormalCount === formalCount ? "formal-baseline-migrated" : "pre-migration";
  return {
    schemaVersion: 1,
    project: { id: SECRETARY_VISUAL_ASSET_PROJECT_ID, name: "小秘书", type: "non-game-local-design-assets" },
    snapshotDate,
    phase,
    authority: "00_本地工作台/10_设计/50_视觉资产/小秘书_视觉识别与资产治理规范.md",
    sourcePlan: {
      officialRoot: SECRETARY_VISUAL_ASSET_ROOT,
      migrationPolicy: "先复制或生成正式母版并核验，再分批改消费者；本清单阶段不移动、不删除、不替换旧素材。",
      categories: ["产品品牌", "角色", "场景与房间", "桌宠与动画", "功能入口", "候选", "迁移记录"],
      currentPathsRemainRuntimeTruth: true,
    },
    exclusions: [
      { path: "00_本地工作台/app/public/ai-tools/", reason: "第三方工具 Logo 属于工具目录，不属于小秘书 VI" },
      { path: "00_本地工作台/app/public/music/", reason: "音乐封面属于音乐内容，不属于小秘书 VI" },
      { path: "00_本地工作台/派生数据/secretary-runtime/attachments/", reason: "私人聊天附件不是产品视觉资产，且不得进入美术清单" },
      { path: `${SECRETARY_VISUAL_ASSET_ROOT}/`, reason: "正式母版和迁移记录由治理流程接管，防止把运行镜像重复盘点；其中候选目录仍纳入生成索引" },
    ],
    statusDefinitions: {
      formal: "已有明确权威原件或正式源图证据；仍可保留具体设备与观感复验门。",
      candidate: "明确候选、参考或中转素材；未经使用者确认不得晋升。",
      "legacy-reference": "现行或历史路径中的运行派生、证据或旧版本；先保留并追溯，不等于已退役。",
      "needs-confirmation": "无法仅凭现有证据确认来源、正式性或用途；不猜测。",
    },
    summary: buildSummary(assets),
    assets,
  };
}

export function renderMigrationLedger(manifest) {
  const rows = manifest.assets.flatMap((asset) => asset.currentPaths.map((currentPath, index) => {
    const file = asset.files.find((item) => item.path === currentPath) || asset.files[index] || {};
    const dimensions = file.width && file.height ? `${file.width}×${file.height}` : "待核";
    return `| ${escapeTable(asset.assetId)} | ${escapeTable(asset.governanceStatus)} | ${escapeTable(asset.subject)} | ${escapeTable(asset.kind)} | ${escapeTable(asset.assetClass)} | ${escapeTable(currentPath)} | ${escapeTable(asset.plannedCanonicalPath || "保留运行位置，仅登记映射")} | ${escapeTable(`${dimensions} · ${file.format || "?"} · ${file.hasAlpha === null ? "透明待核" : file.hasAlpha ? "有透明" : "无透明"} · ${file.bytes || 0} B`)} | ${asset.consumers.length} | ${escapeTable(asset.hash.slice(7, 19))} |`;
  }));
  const status = manifest.summary.byGovernanceStatus;
  return `---
description: 小秘书视觉资产统一迁移前的逐文件路径、摘要、分类、消费者和计划去向账本
date: ${manifest.snapshotDate}
tags: [本地工作台, 小秘书, 视觉资产, 迁移账本, 项目美术库]
sensitivity: S1
---

# 小秘书视觉资产迁移前账本

> 本账本由 \`asset-manifest.v1.json\` 派生，记录迁移前事实。当前阶段不移动、不删除、不替换任何旧素材；路径仍以“当前路径”为运行事实。正式／候选判断以视觉治理权威和明确来源证据为准，机器引用不等于使用者审美认可。

## 快照结论

- 覆盖 ${manifest.summary.fileCount} 个文件，按内容哈希归并为 ${manifest.summary.assetCount} 件资产。
- 正式 ${status.formal || 0} 件；候选 ${status.candidate || 0} 件；旧引用 ${status["legacy-reference"] || 0} 件；待确认 ${status["needs-confirmation"] || 0} 件。
- 当前阶段为 \`${manifest.phase}\`；${status.formal || 0} 件既有正式基线在完成回读后以官方源为 canonicalPath，其余状态没有晋升。消费者没有批量替换，旧路径没有删除或移动。
- 明确排除 AI 工具 Logo、音乐封面和私人聊天附件；它们不属于小秘书 VI 事实层。

## 统一官方源目录方案

\`00_本地工作台/10_设计/50_视觉资产/小秘书/\` 是未来正式母版与不可重建来源的唯一根目录。目录只承接原件；\`app/public/\`、Xcode Asset Catalog、Watch、Chrome 和桌宠运行目录继续作为派生消费者。

| 目录 | 归属 |
|---|---|
| 产品品牌 | 小秘书产品图标与通用品牌母版 |
| 角色 | 银月、梅凝的头像和立绘母版 |
| 场景与房间 | 首页、房间、页面背景和功能场景母版 |
| 桌宠与动画 | 桌宠原始来源、姿态、图集与动画母版 |
| 功能入口 | Watch、Chrome、分享、通知等入口母版 |
| 候选 | 未经本人确认的 AI 生成、抓帧与方案图 |
| 迁移记录 | 账本、审核索引和旧到新回读证据 |

## 分类口径

- \`formal\`：已有明确权威原件或“正式源图”证据，仍可能需要具体设备观感复验。
- \`candidate\`：文件本身位于候选、参考或中转范围。
- \`legacy-reference\`：现行／历史运行派生、证据或旧版本；“旧”不等于可删。
- \`needs-confirmation\`：来源、用途或正式身份不足以证明，保持待确认。

## 逐文件清单

| assetId | 状态 | 人物／产品 | 用途 | 层级 | 当前路径 | 计划去向 | 文件事实 | 已知消费者 | SHA-256 前缀 |
|---|---|---|---|---|---|---|---|---:|---|
${rows.join("\n")}

## 当前例外与后续门

1. 清单中的 \`plannedCanonicalPath\` 只是迁移计划，不表示文件已经存在于新位置。
2. 没有消费者的条目可能是真正未引用，也可能由目录打包、Xcode 或人工流程隐式消费；在消费者批次前保持“未知”。
3. 第三方截图、Wallpaper Engine 素材和《凡人修仙传》相关来源只作本机参考，授权与公开使用边界仍需逐项核对。
4. 头像、立绘、AppIcon 和小尺寸入口的好看程度、人物气质与长期使用感受保留给使用者；机器只检查路径、摘要、尺寸、透明度和引用。
5. 下一批迁移必须按资产 ID 分批复制母版、回读哈希、更新指定消费者，再证明旧引用退出；在此之前不得归档或删除旧文件。
`;
}

export function renderAvatarReview(manifest) {
  const visualKinds = new Set(["头像", "聊天立绘", "产品与入口图标", "功能反馈与入口"]);
  const assets = manifest.assets.filter((asset) => visualKinds.has(asset.kind));
  const rows = assets.map((asset) => {
    const preview = asset.currentPaths.find((item) => !/\.svg$/iu.test(item)) || asset.canonicalPath;
    const use = asset.consumers.filter((item) => ["runtime-source", "manifest", "build-script", "packaged-runtime"].includes(item.kind)).slice(0, 3).map((item) => item.device).filter(Boolean);
    return `| ![[${preview}|72]] | \`${asset.assetId}\` | ${escapeTable(asset.subject)} | ${escapeTable(asset.kind)} | ${escapeTable(asset.governanceStatus)} | ${escapeTable([...new Set(use)].join("、") || "引用待确认")} | ${asset.review.needsCapoo ? "需要" : "不需要"} |`;
  });
  return `---
description: 用稳定素材编号审核小秘书、银月、梅凝与来访角色头像和入口图标的缩略图索引
date: ${manifest.snapshotDate}
tags: [本地工作台, 小秘书, 头像, 视觉审核, 候选素材]
sensitivity: S1
---

# 小秘书头像与入口图标审核索引

> 本页只把清单中的头像、聊天立绘和入口图标集中展示，方便按稳定 \`assetId\` 指认。这里不做自动晋升：40px 清晰度、圆形／方形裁切、人物气质与是否长期舒服，必须由使用者看实际入口后确认。

| 预览 | assetId | 人物／产品 | 用途 | 当前治理状态 | 已知使用端 | 使用者复核 |
|---|---|---|---|---|---|---|
${rows.join("\n")}

## 审核时只判断四件事

1. 40px 圆形和方形里是否仍能辨认人物，脸部是否被裁掉。
2. 角色气质更适合“可爱亲近”还是“成熟正式”，不要求所有人同一画风。
3. 指定 \`assetId\` 是否继续作为当前正式基线、降为候选，或由另一素材取代。
4. 认可母版不等于认可所有派生；Watch、通知、Chrome、PWA、Mac、iPhone/iPad 仍分别看小尺寸结果。
`;
}

export async function writeSecretaryVisualAssetArtifacts({ vaultRoot = DEFAULT_VAULT_ROOT, snapshotDate } = {}) {
  return withVaultFileWrite(vaultRoot, SECRETARY_VISUAL_ASSET_MANIFEST_PATH, async (manifestTarget) => {
    const original = await fs.readFile(manifestTarget, "utf8").catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
    const manifest = await buildSecretaryVisualAssetManifest({ vaultRoot, snapshotDate });
    const validation = await validateSecretaryVisualAssetManifest(manifest, { vaultRoot });
    if (!validation.ok) throw new Error(`拒绝写入无效视觉资产清单：${validation.errors.join("；")}`);
    const outputs = [
      [SECRETARY_VISUAL_ASSET_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`],
      [LEDGER_PATH, renderMigrationLedger(manifest)],
      [AVATAR_REVIEW_PATH, renderAvatarReview(manifest)],
    ];
    for (const [relative, content] of outputs) {
      const absolute = path.resolve(vaultRoot, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      const target = relative === SECRETARY_VISUAL_ASSET_MANIFEST_PATH ? manifestTarget : await resolveWritableVaultPath(vaultRoot, relative);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
        await resolveWritableVaultPath(vaultRoot, relative);
        if (relative === SECRETARY_VISUAL_ASSET_MANIFEST_PATH) {
          const current = await fs.readFile(target, "utf8").catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
          if (current !== original) throw new Error("视觉资产原件在写入前变化，拒绝覆盖");
        }
        await fs.rename(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    return { manifest, validation, outputs: outputs.map(([relative]) => relative) };
  });
}

export async function migrateFormalAssetBaselines({ vaultRoot = DEFAULT_VAULT_ROOT, snapshotDate, dryRun = true } = {}) {
  vaultRoot = path.resolve(vaultRoot);
  const manifest = await buildSecretaryVisualAssetManifest({ vaultRoot, snapshotDate });
  const formal = manifest.assets.filter((asset) => asset.governanceStatus === "formal");
  const rows = [];
  for (const asset of formal) {
    if (!asset.plannedCanonicalPath) throw new Error(`${asset.assetId} 缺少正式母版计划路径`);
    if (asset.migration?.oldToNewVerified === true && asset.canonicalPath === asset.plannedCanonicalPath) {
      const current = await verifiedFileRow(vaultRoot, asset.canonicalPath, asset.hash.slice(7), new Set());
      rows.push({assetId:asset.assetId,source:asset.migration.sourcePath || asset.canonicalPath,target:asset.canonicalPath,hash:asset.hash,width:current.width,height:current.height,status:"already-verified"});
      continue;
    }
    const source = asset.migration?.sourcePath || (!asset.canonicalPath.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)
      ? asset.canonicalPath
      : asset.currentPaths.find((item) => !item.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)));
    if (!source) throw new Error(`${asset.assetId} 缺少可回读的迁移前路径`);
    const sourceRow = await verifiedFileRow(vaultRoot, source, asset.hash.slice(7), new Set());
    const target = asset.plannedCanonicalPath;
    let status = "would-copy";
    try {
      const targetRow = await verifiedFileRow(vaultRoot, target, asset.hash.slice(7), new Set());
      if (targetRow.width !== sourceRow.width || targetRow.height !== sourceRow.height || targetRow.format !== sourceRow.format) {
        throw new Error(`正式母版回读不一致：${target}`);
      }
      status = "already-verified";
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!dryRun) {
        const absoluteTarget = path.resolve(vaultRoot, target);
        await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
        await fs.copyFile(path.resolve(vaultRoot, source), absoluteTarget, fsConstants.COPYFILE_EXCL);
        const targetRow = await verifiedFileRow(vaultRoot, target, asset.hash.slice(7), new Set());
        if (targetRow.width !== sourceRow.width || targetRow.height !== sourceRow.height || targetRow.format !== sourceRow.format) {
          throw new Error(`正式母版回读不一致：${target}`);
        }
        status = "copied-and-verified";
      }
    }
    rows.push({ assetId: asset.assetId, source, target, hash: asset.hash, width: sourceRow.width, height: sourceRow.height, status });
  }
  if (!dryRun) await writeSecretaryVisualAssetArtifacts({ vaultRoot, snapshotDate });
  return {
    ok: true,
    dryRun,
    formalCount: formal.length,
    copied: rows.filter((row) => row.status === "copied-and-verified").length,
    alreadyVerified: rows.filter((row) => row.status === "already-verified").length,
    wouldCopy: rows.filter((row) => row.status === "would-copy").length,
    rows,
  };
}

export async function inspectFormalAssetSync({ vaultRoot = DEFAULT_VAULT_ROOT } = {}) {
  vaultRoot = path.resolve(vaultRoot);
  const manifest = JSON.parse(await fs.readFile(path.resolve(vaultRoot, SECRETARY_VISUAL_ASSET_MANIFEST_PATH), "utf8"));
  const rows = [];
  for (const asset of manifest.assets.filter((item) => item.governanceStatus === "formal")) {
    if (!asset.canonicalPath.startsWith(`${SECRETARY_VISUAL_ASSET_ROOT}/`)) throw new Error(`${asset.assetId} 尚未建立官方正式母版`);
    const source = await verifiedFileRow(vaultRoot, asset.canonicalPath, asset.hash.slice(7), new Set());
    for (const target of asset.currentPaths.filter((item) => item !== asset.canonicalPath && isSecretaryVisualRuntimePath(item))) {
      let status = "in-sync";
      let actualHash = null;
      try {
        const buffer = await fs.readFile(path.resolve(vaultRoot, target));
        actualHash = `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
        if (actualHash !== asset.hash) status = "drift";
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        status = "missing";
      }
      rows.push({ assetId: asset.assetId, source: asset.canonicalPath, target, expectedHash: asset.hash, actualHash, width: source.width, height: source.height, status });
    }
  }
  return {
    ok: rows.every((row) => row.status === "in-sync"),
    mode: "read-only-drift-check",
    direction: "official-source-to-runtime-only",
    writeAllowed: false,
    targetCount: rows.length,
    inSync: rows.filter((row) => row.status === "in-sync").length,
    drift: rows.filter((row) => row.status === "drift").length,
    missing: rows.filter((row) => row.status === "missing").length,
    rows,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const migrateFormal = args.includes("--migrate-formal");
  const checkFormalSync = args.includes("--check-formal-sync");
  const dryRun = args.includes("--dry-run");
  const dateIndex = args.indexOf("--snapshot-date");
  const snapshotDate = dateIndex >= 0 ? args[dateIndex + 1] : undefined;
  if (migrateFormal) {
    process.stdout.write(`${JSON.stringify(await migrateFormalAssetBaselines({ snapshotDate, dryRun }), null, 2)}\n`);
    return;
  }
  if (checkFormalSync) {
    const result = await inspectFormalAssetSync();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const result = write
    ? await writeSecretaryVisualAssetArtifacts({ snapshotDate })
    : { manifest: await buildSecretaryVisualAssetManifest({ snapshotDate }) };
  process.stdout.write(`${JSON.stringify({ summary: result.manifest.summary, rebuildReport: result.manifest.rebuildReport, outputs: result.outputs || [] }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
