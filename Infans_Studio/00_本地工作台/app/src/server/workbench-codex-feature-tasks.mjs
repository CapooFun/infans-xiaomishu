import fs from "node:fs/promises";
import path from "node:path";
import { cleanCodexTaskTitle, isInternalCodexTask } from "./workbench-codex-task-policy.mjs";

const INDEX_PATH = "00_本地工作台/派生数据/agent-observability-index.json";
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CURSOR_WINDOW_ID = /^(?:cursor-conversation:[0-9a-f-]{8,}|cursor:(?!account:)[a-z0-9._+-]+)$/iu;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 3;

function cleanTaskTitle(value) {
  return cleanCodexTaskTitle(value) || "未命名窗口";
}

function isoTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function wikiWindowKind(id, task) {
  const kind = String(task?.kind || "").trim();
  if (kind === "codex" && CODEX_THREAD_ID.test(id) && !isInternalCodexTask(task)) return "codex";
  if (kind === "cursor" && CURSOR_WINDOW_ID.test(id)) return "cursor";
  return "";
}

function wikiWindowUrl(id, kind) {
  return kind === "codex" ? `codex://threads/${encodeURIComponent(id)}` : null;
}

export async function readCodexFeatureTasks(vaultRoot, { projectId = "", featureId = "", limit = DEFAULT_LIMIT } = {}) {
  const normalizedProjectId = String(projectId || "").trim();
  const normalizedFeatureId = String(featureId || "").trim();
  if (!normalizedFeatureId) return { updatedAt: null, tasks: [] };

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(vaultRoot, INDEX_PATH), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return { updatedAt: null, tasks: [] };
    throw error;
  }

  const tasks = Object.entries(parsed?.tasks || {}).flatMap(([id, task]) => {
    const kind = wikiWindowKind(id, task);
    if (!kind) return [];
    const featureMatches = Array.isArray(task.featureMatches) ? task.featureMatches : [];
    const feature = featureMatches.find((match) => (
      String(match?.id || "") === normalizedFeatureId
      && (!normalizedProjectId || String(match?.projectId || "") === normalizedProjectId)
    ));
    if (!feature) return [];
    const relevance = Number.isFinite(Number(feature.relevance)) ? Number(feature.relevance) : null;
    const title = cleanTaskTitle(task.title || task.sourceWindowTitle);
    if (feature.basis !== "verified" && relevance !== null && relevance < 60) return [];
    return [{
      id,
      title,
      agent: kind === "cursor" ? "Cursor" : "Codex",
      kind,
      reference: String(task.reference || id.replace(/[^a-z0-9]/giu, "").slice(-6)).trim().slice(-12),
      updatedAt: isoTime(task.sourceUpdatedAt || task.updatedAt),
      relevance,
      url: wikiWindowUrl(id, kind),
    }];
  }).sort((a, b) => {
    const relevance = (Number(b.relevance) || 0) - (Number(a.relevance) || 0);
    if (relevance) return relevance;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });

  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
  return { updatedAt: isoTime(parsed?.updatedAt), tasks: tasks.slice(0, safeLimit) };
}

export { cleanTaskTitle };
