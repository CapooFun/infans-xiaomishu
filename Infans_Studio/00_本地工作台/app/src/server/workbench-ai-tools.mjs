import fs from "node:fs/promises";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { AI_TOOL_CATALOG_PATH, AI_TOOL_QUARTERLY_REPORT_DIR, AI_TOOL_USAGE_DERIVED, WEB_BOOKMARK_CATALOG_PATH, WEB_BOOKMARK_USAGE_DERIVED } from "./vault-paths.mjs";

const CATEGORIES = new Set(["model", "art", "video", "audio", "coding", "research", "3d-game", "document", "asset", "network", "interesting", "course", "game-career", "niche-content", "other"]);
const RECENT_USE_DAYS = 30;

function absolute(root, relativePath) {
  return path.resolve(root, relativePath);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== null) return fallback;
    throw error;
  }
}

function cleanTool(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const name = String(raw.name || "").trim();
  const summary = String(raw.summary || "").trim();
  const category = CATEGORIES.has(raw.category) ? raw.category : "other";
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id) || !name || !summary) return null;
  let url;
  try {
    url = new URL(String(raw.url || ""));
    if (!new Set(["https:", "http:"]).has(url.protocol)) return null;
  } catch {
    return null;
  }
  const browserSources = Array.isArray(raw.browserSources)
    ? [...new Set(raw.browserSources.filter((item) => item === "safari" || item === "chrome"))]
    : [];
  return {
    id,
    name: name.slice(0, 80),
    url: url.toString(),
    kind: raw.kind === "software" ? "software" : "web",
    category,
    summary: summary.slice(0, 220),
    logoText: String(raw.logoText || name.slice(0, 2)).trim().slice(0, 3).toUpperCase(),
    logoPath: `/ai-tools/icons/${id}.png`,
    origin: raw.origin === "bookmark" ? "bookmark" : "recommendation",
    browserSources,
    discoveryStatus: raw.discoveryStatus === "recent" ? "recent" : "baseline",
    releaseStatus: raw.releaseStatus === "new" ? "new" : "established",
    checkedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.checkedAt || "")) ? raw.checkedAt : null,
  };
}

function cleanUsage(raw) {
  if (!raw || typeof raw !== "object" || !raw.everUsed) return null;
  const firstUsedAt = Number.isFinite(Date.parse(raw.firstUsedAt)) ? new Date(raw.firstUsedAt).toISOString() : null;
  const lastUsedAt = Number.isFinite(Date.parse(raw.lastUsedAt)) ? new Date(raw.lastUsedAt).toISOString() : firstUsedAt;
  if (!lastUsedAt) return null;
  return {
    everUsed: true,
    firstUsedAt: firstUsedAt || lastUsedAt,
    lastUsedAt,
    useCount: Math.max(1, Math.min(1_000_000, Number.parseInt(raw.useCount, 10) || 1)),
    note: String(raw.note || "").trim().slice(0, 180) || null,
  };
}

function statusFor(tool, usage, now) {
  if (usage?.everUsed) {
    const recentBoundary = now.getTime() - RECENT_USE_DAYS * 24 * 60 * 60 * 1000;
    return Date.parse(usage.lastUsedAt) >= recentBoundary ? "recently-used" : "used-before";
  }
  if (tool.discoveryStatus === "recent") return "recently-discovered";
  return "to-try";
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return {};
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) return {};
  return Object.fromEntries(markdown.slice(4, end).split("\n").flatMap((line) => {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) return [];
    return [[match[1], match[2].replace(/^['\"]|['\"]$/g, "").trim()]];
  }));
}

function reportHighlights(markdown) {
  const section = markdown.match(/\n##\s+本季要看\s*\n([\s\S]*?)(?=\n##\s+|$)/)?.[1] || "";
  return section.split("\n")
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => line.slice(0, 240));
}

async function readLatestQuarterlyReport(root) {
  const reportDir = absolute(root, AI_TOOL_QUARTERLY_REPORT_DIR);
  let entries;
  try {
    entries = await fs.readdir(reportDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const candidates = entries.filter((entry) => entry.isFile() && /^\d{4}-Q[1-4]\.md$/.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name));
  for (const entry of candidates) {
    const markdown = await fs.readFile(path.join(reportDir, entry.name), "utf8");
    const meta = parseFrontmatter(markdown);
    if (meta.reportStatus !== "complete") continue;
    const highlights = reportHighlights(markdown);
    return {
      period: meta.period || entry.name.replace(/\.md$/, ""),
      generatedAt: Number.isFinite(Date.parse(meta.generatedAt)) ? new Date(meta.generatedAt).toISOString() : null,
      title: meta.title || `${meta.period || entry.name.replace(/\.md$/, "")} AI 工具迭代摘要`,
      summary: String(meta.summary || highlights[0] || "已完成本季度工具迭代检查。").slice(0, 260),
      highlights,
    };
  }
  return null;
}

export function aiToolCatalogPath(root) {
  return absolute(root, AI_TOOL_CATALOG_PATH);
}

export function aiToolUsagePath(root) {
  return absolute(root, AI_TOOL_USAGE_DERIVED);
}

export function webBookmarkCatalogPath(root) {
  return absolute(root, WEB_BOOKMARK_CATALOG_PATH);
}

export function webBookmarkUsagePath(root) {
  return absolute(root, WEB_BOOKMARK_USAGE_DERIVED);
}

export async function readAiTools(root, now = new Date()) {
  const [catalog, usageStore, quarterlyReport] = await Promise.all([
    readJson(aiToolCatalogPath(root)),
    readJson(aiToolUsagePath(root), { schemaVersion: 1, tools: {} }),
    readLatestQuarterlyReport(root),
  ]);
  const usageById = usageStore?.tools && typeof usageStore.tools === "object" ? usageStore.tools : {};
  const tools = (Array.isArray(catalog?.tools) ? catalog.tools : []).map(cleanTool).filter(Boolean).map((tool) => {
    const usage = cleanUsage(usageById[tool.id]);
    return { ...tool, usage, status: statusFor(tool, usage, now) };
  });
  const order = { "recently-used": 0, "used-before": 1, "recently-discovered": 2, "to-try": 3 };
  tools.sort((a, b) => {
    const bucket = order[a.status] - order[b.status];
    if (bucket) return bucket;
    if (a.usage?.lastUsedAt || b.usage?.lastUsedAt) return String(b.usage?.lastUsedAt || "").localeCompare(String(a.usage?.lastUsedAt || ""));
    return a.name.localeCompare(b.name, "zh-CN");
  });
  return {
    schemaVersion: 1,
    updatedAt: catalog?.updatedAt || null,
    recentUseDays: RECENT_USE_DAYS,
    scan: catalog?.scan || null,
    quarterlyReport,
    tools,
  };
}

export async function readWebBookmarks(root, now = new Date()) {
  const [catalog, usageStore] = await Promise.all([
    readJson(webBookmarkCatalogPath(root)),
    readJson(webBookmarkUsagePath(root), { schemaVersion: 1, tools: {} }),
  ]);
  const usageById = usageStore?.tools && typeof usageStore.tools === "object" ? usageStore.tools : {};
  const tools = (Array.isArray(catalog?.bookmarks) ? catalog.bookmarks : []).map(cleanTool).filter(Boolean).map((tool) => {
    const usage = cleanUsage(usageById[tool.id]);
    return { ...tool, usage, status: statusFor(tool, usage, now) };
  });
  const order = { "recently-used": 0, "used-before": 1, "recently-discovered": 2, "to-try": 3 };
  tools.sort((a, b) => {
    const bucket = order[a.status] - order[b.status];
    if (bucket) return bucket;
    if (a.usage?.lastUsedAt || b.usage?.lastUsedAt) return String(b.usage?.lastUsedAt || "").localeCompare(String(a.usage?.lastUsedAt || ""));
    return a.name.localeCompare(b.name, "zh-CN");
  });
  return {
    schemaVersion: 1,
    updatedAt: catalog?.updatedAt || null,
    recentUseDays: RECENT_USE_DAYS,
    scan: null,
    quarterlyReport: null,
    tools,
  };
}

function cleanNote(raw) {
  const note = String(raw || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 180);
  if (!note) return null;
  if (/(?:password|passwd|token|secret|api[_ -]?key|sk-[a-z0-9_-]{8,})\s*[:=]/i.test(note)) {
    throw new WorkbenchWriteError("使用印象不能包含凭据", 400, "AI_TOOL_NOTE_SENSITIVE");
  }
  return note;
}

export async function recordAiToolUse(root, payload = {}, now = new Date()) {
  const id = String(payload.id || "").trim();
  const catalog = await readJson(aiToolCatalogPath(root));
  const ids = new Set((Array.isArray(catalog?.tools) ? catalog.tools : []).map((item) => cleanTool(item)?.id).filter(Boolean));
  if (!ids.has(id)) throw new WorkbenchWriteError("找不到这张工具卡片", 404, "AI_TOOL_NOT_FOUND");
  const target = aiToolUsagePath(root);
  const store = await readJson(target, { schemaVersion: 1, tools: {} });
  const previous = cleanUsage(store?.tools?.[id]);
  const usedAt = now.toISOString();
  const note = cleanNote(payload.note);
  const next = {
    schemaVersion: 1,
    updatedAt: usedAt,
    tools: {
      ...(store?.tools && typeof store.tools === "object" ? store.tools : {}),
      [id]: {
        everUsed: true,
        firstUsedAt: previous?.firstUsedAt || usedAt,
        lastUsedAt: usedAt,
        useCount: (previous?.useCount || 0) + 1,
        ...(note || previous?.note ? { note: note || previous.note } : {}),
      },
    },
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.infans-tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
  return readAiTools(root, now);
}

export async function recordWebBookmarkUse(root, payload = {}, now = new Date()) {
  const id = String(payload.id || "").trim();
  const catalog = await readJson(webBookmarkCatalogPath(root));
  const ids = new Set((Array.isArray(catalog?.bookmarks) ? catalog.bookmarks : []).map((item) => cleanTool(item)?.id).filter(Boolean));
  if (!ids.has(id)) throw new WorkbenchWriteError("找不到这张网页收藏卡片", 404, "WEB_BOOKMARK_NOT_FOUND");
  const target = webBookmarkUsagePath(root);
  const store = await readJson(target, { schemaVersion: 1, tools: {} });
  const previous = cleanUsage(store?.tools?.[id]);
  const usedAt = now.toISOString();
  const next = {
    schemaVersion: 1,
    updatedAt: usedAt,
    tools: {
      ...(store?.tools && typeof store.tools === "object" ? store.tools : {}),
      [id]: {
        everUsed: true,
        firstUsedAt: previous?.firstUsedAt || usedAt,
        lastUsedAt: usedAt,
        useCount: (previous?.useCount || 0) + 1,
        ...(previous?.note ? { note: previous.note } : {}),
      },
    },
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.infans-tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
  return readWebBookmarks(root, now);
}
