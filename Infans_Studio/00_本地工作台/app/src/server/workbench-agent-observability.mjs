import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readProjectManagement } from "./workbench-project-management.mjs";
import { readProductFeatureTree } from "./workbench-product-features.mjs";
import { cleanCodexTaskTitle, codexTaskIdentity, isInternalCodexTask } from "./workbench-codex-task-policy.mjs";

const FEATURE_TREE_PATH = "00_本地工作台/10_设计/小秘书_产品功能树.md";
const CURSOR_RUNS_PATH = "00_本地工作台/30_证据/AI定时任务运行包";
const LINKS_PATH = "00_本地工作台/派生数据/agent-observability-links.json";
const EXTERNAL_LEDGER_PATH = "00_本地工作台/派生数据/agent-observability-external.jsonl";
const CURSOR_BATCH_LEDGER_PATH = "00_本地工作台/派生数据/agent-observability-cursor-batches.jsonl";
const CURSOR_ACCOUNT_LEDGER_PATH = "00_本地工作台/派生数据/agent-observability-cursor-account.jsonl";
const CURSOR_WINDOW_TITLES_PATH = "00_本地工作台/派生数据/agent-observability-cursor-window-titles.json";
const SNAPSHOT_CACHE_PATH = "00_本地工作台/派生数据/agent-observability-cache.json";
const ATTRIBUTION_INDEX_PATH = "00_本地工作台/派生数据/agent-observability-index.json";
const SNAPSHOT_CACHE_SCHEMA = 18;
const CURSOR_ACCOUNT_SYNC_MAX_AGE_MS = 30 * 60 * 1000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const TAIL_BYTES = 128 * 1024;
const SNAPSHOT_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const codexSnapshotCache = new Map();
const codexIdentityCache = new Map();
const snapshotRefreshes = new Map();
const ATTRIBUTION_INDEX_TASKS = Symbol("agent-observability-attribution-index-tasks");
const INTERNAL_CODEX_IDS = Symbol("agent-observability-internal-codex-ids");

const CURSOR_ROLE_FEATURE_IDS = Object.freeze({
  "health-daily": ["automation-reviews"],
  "monthly-review": ["automation-reviews"],
  "training-review": ["automation-reviews"],
  "japan-activities": ["tools-game-dungeon"],
  "market-brief": ["automation-market-brief"],
  "world-brief": ["automation-world-brief", "markets-world-lanes", "markets-japan-reading"],
  "workbench-daily-health": ["automation-daily-release"],
  "workbench-daily-release": ["automation-daily-release"],
  "ai-tools-quarterly": ["automation-ai-tools-quarterly"],
  "cursor-usage-probe": ["tools-agent-observability"],
});

const PERSONAL_LIFE_PROJECT_ID = "personal-life-operations";
const PERSONAL_LIFE_CATALOG = Object.freeze([
  { id: `project:${PERSONAL_LIFE_PROJECT_ID}`, name: "个人生活运营", moduleId: "", moduleName: "生活事务", projectId: PERSONAL_LIFE_PROJECT_ID, projectName: "个人生活运营", treeId: "", worklineId: "", nodeKind: "project", classificationText: "个人生活运营 现实生活事务 个人事务" },
  { id: "personal-life-travel", name: "出行与票务", moduleId: "personal-life", moduleName: "生活事务", projectId: PERSONAL_LIFE_PROJECT_ID, projectName: "个人生活运营", treeId: "", worklineId: "", nodeKind: "feature", classificationText: "订票 门票 电影票 机票 车票 酒店 旅行 行程 路线 攻略 出行" },
  { id: "personal-life-shopping", name: "购物与订购", moduleId: "personal-life", moduleName: "生活事务", projectId: PERSONAL_LIFE_PROJECT_ID, projectName: "个人生活运营", treeId: "", worklineId: "", nodeKind: "feature", classificationText: "购物 买东西 商品 比价 下单 退货 快递 配送 订购" },
  { id: "personal-life-appointments", name: "预约与手续", moduleId: "personal-life", moduleName: "生活事务", projectId: PERSONAL_LIFE_PROJECT_ID, projectName: "个人生活运营", treeId: "", worklineId: "", nodeKind: "feature", classificationText: "预约 手续 证件 申请 缴费 取消预约 生活行政" },
  { id: "personal-life-devices", name: "生活设备协助", moduleId: "personal-life", moduleName: "生活事务", projectId: PERSONAL_LIFE_PROJECT_ID, projectName: "个人生活运营", treeId: "", worklineId: "", nodeKind: "feature", classificationText: "电脑 手机 平板 网络 家电 故障 排查 设置 遥控 日常设备" },
  { id: "personal-life-general", name: "一般生活事务", moduleId: "personal-life", moduleName: "生活事务", projectId: PERSONAL_LIFE_PROJECT_ID, projectName: "个人生活运营", treeId: "", worklineId: "", nodeKind: "feature", classificationText: "餐厅 吃什么 去哪玩 日常生活 现实方案 比较 选择 个人事务" },
]);

function zeroUsage() {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function addUsage(target, value) {
  if (!value) return target;
  const fieldStatus = { ...(target.fieldStatus || {}) };
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"]) {
    const next = value.fieldStatus?.[key] || (value[key] == null ? "unknown" : "known");
    const previous = fieldStatus[key];
    fieldStatus[key] = !previous || previous === next ? next : "partial";
  }
  target.fieldStatus = fieldStatus;
  target.inputTokens += numberOrZero(value?.inputTokens);
  target.cachedInputTokens += numberOrZero(value?.cachedInputTokens);
  target.outputTokens += numberOrZero(value?.outputTokens);
  // Missing reasoning must stay missing: never coerce null/undefined into a fake 0 contribution.
  if (value?.reasoningTokens != null) target.reasoningTokens += numberOrZero(value.reasoningTokens);
  target.totalTokens += numberOrZero(value?.totalTokens);
  return target;
}

export function normalizeCursorAccountModel(model) {
  return String(model || "Cursor").trim().toLowerCase().replace(/^cursor-/u, "");
}

export function cursorAccountSourcePriority(source) {
  const value = String(source || "");
  if (value === "cursor-local-session") return 40;
  if (/local-session|local_session/iu.test(value)) return 30;
  if (/dashboard-csv|account-csv|_csv$/iu.test(value)) return 10;
  return 0;
}

export function cursorAccountOverlapFingerprint(row = {}) {
  const atMs = Date.parse(row.at || "");
  const atKey = Number.isFinite(atMs)
    ? new Date(Math.floor(atMs / 1000) * 1000).toISOString()
    : String(row.at || "").trim();
  const usage = row.usage && typeof row.usage === "object" ? row.usage : {};
  return [
    atKey,
    normalizeCursorAccountModel(row.model),
    numberOrZero(usage.inputTokens),
    numberOrZero(usage.outputTokens),
    numberOrZero(usage.totalTokens),
  ].join("\0");
}

function cursorAccountRowRichness(row = {}) {
  return (row.conversationId ? 8 : 0)
    + (row.chargedCents != null ? 2 : 0)
    + (row.listedCents != null ? 1 : 0)
    + (Number(row.schemaVersion) || 0);
}

/** Prefer local session over CSV when the same Usage event was collected twice. Keeps raw rows on disk. */
export function dedupeCursorAccountRows(rows = []) {
  const byFingerprint = new Map();
  const seenEventIds = new Set();
  let suppressedDuplicateCount = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const eventId = String(row.eventId || "").trim();
    if (eventId && seenEventIds.has(eventId)) {
      suppressedDuplicateCount += 1;
      continue;
    }
    if (eventId) seenEventIds.add(eventId);
    const fingerprint = cursorAccountOverlapFingerprint(row);
    const group = byFingerprint.get(fingerprint) || [];
    group.push(row);
    byFingerprint.set(fingerprint, group);
  }
  const deduped = [];
  for (const group of byFingerprint.values()) {
    const ordered = group.toSorted((left, right) => cursorAccountSourcePriority(right.source) - cursorAccountSourcePriority(left.source)
      || cursorAccountRowRichness(right) - cursorAccountRowRichness(left));
    const kept = [];
    const overlapClaimed = new Set();
    for (const row of ordered) {
      const duplicate = kept.find((candidate) => {
        if (String(candidate.source || "") === String(row.source || "")) return false;
        if (cursorAccountSourcePriority(candidate.source) <= cursorAccountSourcePriority(row.source)) return false;
        const leftConversation = String(candidate.conversationId || "").trim();
        const rightConversation = String(row.conversationId || "").trim();
        if (leftConversation && rightConversation && leftConversation !== rightConversation) return false;
        return !overlapClaimed.has(candidate);
      });
      if (duplicate) {
        overlapClaimed.add(duplicate);
        suppressedDuplicateCount += 1;
      } else kept.push(row);
    }
    deduped.push(...kept);
  }
  deduped.sort((left, right) => Date.parse(left.at || "") - Date.parse(right.at || ""));
  return { rows: deduped, suppressedDuplicateCount, eventCountBefore: rows.length, eventCountAfter: deduped.length };
}

function normalizeCodexUsage(last = {}) {
  last ||= {};
  const inputTokens = numberOrZero(last.input_tokens);
  const outputTokens = numberOrZero(last.output_tokens);
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, numberOrZero(last.cached_input_tokens)),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, numberOrZero(last.reasoning_output_tokens)),
    totalTokens: numberOrZero(last.total_tokens) || inputTokens + outputTokens,
    fieldStatus: {
      inputTokens: last.input_tokens == null ? "unknown" : "known",
      cachedInputTokens: last.cached_input_tokens == null ? "unknown" : "known",
      outputTokens: last.output_tokens == null ? "unknown" : "known",
      reasoningTokens: last.reasoning_output_tokens == null ? "unknown" : "known",
      totalTokens: last.total_tokens != null || (last.input_tokens != null && last.output_tokens != null) ? "known" : "unknown",
    },
  };
}

export function normalizeExternalUsage(usage = {}) {
  usage ||= {};
  const has = (...keys) => keys.some((key) => usage[key] != null && usage[key] !== "" && Number.isFinite(Number(usage[key])));
  const inputTokens = numberOrZero(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens);
  const outputTokens = numberOrZero(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens);
  const cached = numberOrZero(
    usage.cached_input_tokens
      ?? usage.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.cachedInputTokens,
  );
  const totalWasProvided = has("total_tokens", "totalTokens");
  const inputWasProvided = has("input_tokens", "prompt_tokens", "inputTokens");
  const outputWasProvided = has("output_tokens", "completion_tokens", "outputTokens");
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, cached),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, numberOrZero(
      usage.reasoning_tokens
        ?? usage.completion_tokens_details?.reasoning_tokens
        ?? usage.output_tokens_details?.reasoning_tokens
        ?? usage.reasoningTokens,
    )),
    totalTokens: numberOrZero(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens,
    costUsd: numberOrZero(usage.total_cost ?? usage.cost ?? usage.costUsd),
    fieldStatus: {
      inputTokens: has("input_tokens", "prompt_tokens", "inputTokens") ? "known" : "unknown",
      cachedInputTokens: has("cached_input_tokens", "cached_tokens", "cachedInputTokens")
        || usage.prompt_tokens_details?.cached_tokens != null || usage.input_tokens_details?.cached_tokens != null ? "known" : "unknown",
      outputTokens: has("output_tokens", "completion_tokens", "outputTokens") ? "known" : "unknown",
      reasoningTokens: has("reasoning_tokens", "reasoningTokens")
        || usage.completion_tokens_details?.reasoning_tokens != null || usage.output_tokens_details?.reasoning_tokens != null ? "known" : "unknown",
      totalTokens: totalWasProvided || (inputWasProvided && outputWasProvided)
        ? "known"
        : inputWasProvided || outputWasProvided
          ? "partial"
          : "unknown",
      ...Object.fromEntries(Object.entries(usage.fieldStatus || {}).filter(([key, value]) => ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"].includes(key) && ["known", "partial", "unknown"].includes(value))),
    },
  };
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}


function startOfTokyoDay(ms) {
  const day = dateKey(ms);
  if (!day) return Number(ms) || Date.now();
  return Date.parse(`${day}T00:00:00+09:00`);
}

export function resolveObservabilityPeriod(options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const hours = Number(options.hours);
  if (hours === 24) {
    return {
      cacheKey: "24h",
      days: 1,
      hours: 24,
      nowMs,
      cutoffMs: nowMs - 24 * HOUR_MS,
      trendDays: 2,
      periodDays: 1,
      periodHours: 24,
    };
  }
  const days = Math.min(90, Math.max(1, Number(options.days) || 30));
  return {
    cacheKey: String(days),
    days,
    hours: null,
    nowMs,
    cutoffMs: startOfTokyoDay(nowMs - (days - 1) * DAY_MS),
    trendDays: days,
    periodDays: days,
    periodHours: null,
  };
}


function nullableNumber(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function usageFromCursorTokenUsage(tokenUsage, options = {}) {
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const fresh = nullableNumber(tokenUsage.inputTokens);
  const cacheRead = nullableNumber(tokenUsage.cacheReadTokens);
  const cacheWrite = nullableNumber(tokenUsage.cacheWriteTokens);
  const output = nullableNumber(tokenUsage.outputTokens);
  if (fresh == null && cacheRead == null && cacheWrite == null && output == null && nullableNumber(tokenUsage.totalTokens) == null) {
    return null;
  }
  const inputTokens = (fresh || 0) + (cacheRead || 0) + (cacheWrite || 0);
  const outputTokens = output || 0;
  const totalTokens = nullableNumber(tokenUsage.totalTokens) ?? (inputTokens + outputTokens);
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, cacheRead || 0),
    cacheWriteTokens: cacheWrite,
    outputTokens,
    reasoningTokens: nullableNumber(tokenUsage.reasoningTokens) ?? null,
    totalTokens,
  };
}

function readLocalCursorConversationTitles() {
  const dbPath = path.join(os.homedir(), "Library/Application Support/Cursor/User/globalStorage/conversation-search.db");
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return new Map();
  }
  try {
    const titles = new Map();
    for (const row of db.prepare("SELECT id, title FROM conversations").all()) {
      const id = String(row.id || "").trim();
      const title = String(row.title || "").replace(/\s+/gu, " ").trim();
      if (!id || !title) continue;
      titles.set(id, title);
      if (id.startsWith("bc-")) titles.set(id.slice(3), title);
      else titles.set(`bc-${id}`, title);
    }
    return titles;
  } catch {
    return new Map();
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export function isWeakCursorWindowTitle(title) {
  const text = String(title || "").replace(/\s+/gu, " ").trim();
  if (!text) return true;
  if (/^(new chat|untitled|chat|conversation|agent|cursor)\b/iu.test(text)) return true;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(text)) return true;
  if (/^DOMPath:/iu.test(text) || /^@\//u.test(text) || /^html\b/iu.test(text)) return true;
  if (/^今天是日本时间/u.test(text)) return true;
  if (/^当前(?:东京|日本)?时间/u.test(text)) return true;
  if (/^不要使用任何工具/u.test(text)) return true;
  const han = [...text].filter((char) => /[\u4e00-\u9fff]/u.test(char)).length;
  const latin = [...text].filter((char) => /[A-Za-z]/u.test(char)).length;
  // "Job search for 袁存凯" still reads as an English auto title.
  if (han > 0 && latin > han * 2) return true;
  if (han > 0) return false;
  return /^[A-Za-z0-9][A-Za-z0-9 _\-:/.,'’()+#]*$/u.test(text);
}

function extractCursorUserQueryText(raw) {
  const source = String(raw || "");
  const queryMatch = source.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/iu);
  let text = queryMatch ? queryMatch[1] : source;
  text = text
    .replace(/<\/?timestamp\b[^>]*>/giu, " ")
    .replace(/<\/?[a-z][^>]*>/giu, " ")
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}[^.。！？\n]*/gu, " ")
    .replace(/\bDOMPath:[^\n]*/gu, " ")
    .replace(/\b(?:html|body|div|span|button|input)#[\w.-]+[^\n]*/gu, " ")
    .replace(/(?:^|\s)@(?:\/Users|\/home|\/tmp)[^\n]*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (/^You are an? (?:AI|assistant)\b/iu.test(text) || /\bALWAYS follow(?: these)? (?:system )?rules\b/iu.test(text.slice(0, 160))) return "";
  if (/^DOMPath:/iu.test(text) || /^@\//u.test(text)) return "";
  return text;
}

function isPrivateOrPersonaBootstrap(text) {
  const sample = String(text || "").slice(0, 320);
  return /你是[「『"]?梅凝|青衣梅凝|梅凝小秘书|当前值班人物|一对一帮用户把事情办明白|特殊内容/u.test(sample);
}

export function deriveCursorWindowTitle(sourceText) {
  const text = extractCursorUserQueryText(sourceText);
  if (!text) return "";
  if (isPrivateOrPersonaBootstrap(text)) return "人物值班会话";
  if (/^You are producing\b/iu.test(text) && /JLPT/iu.test(text)) {
    const level = text.match(/\bN[1-5]\b/u)?.[0] || "";
    return level ? `JLPT ${level} 机读数据` : "JLPT 机读数据";
  }
  if (/先完整阅读下列本地规则原件/u.test(text)) {
    if (/身心|日评|健康/u.test(text)) return "身心日评定时任务";
    if (/月度|复盘/u.test(text)) return "月度复盘定时任务";
    if (/训练/u.test(text)) return "训练复盘定时任务";
    if (/市场|简报/u.test(text)) return "市场简报定时任务";
    if (/工作台|收口|版本/u.test(text)) return "工作台每日收口";
    if (/日本活动/u.test(text)) return "日本活动定时任务";
    if (/Cursor|用量|探针/iu.test(text)) return "Cursor用量探针";
    return "定时任务";
  }

  const jlptLevel = text.match(/\bJLPT\s*(N[2-5])\b/iu)?.[1]?.toUpperCase() || text.match(/\b(N[2-5])\b/u)?.[1]?.toUpperCase();
  if (jlptLevel && /JLPT|精校|校对|质检|质量|真题|考场/iu.test(text)) {
    if (/精校|校对/u.test(text)) return `JLPT ${jlptLevel} 精校`;
    if (/质检|质量|inspection|quality/iu.test(text)) return `JLPT ${jlptLevel} 质检`;
    return `JLPT ${jlptLevel} 任务`;
  }

  const englishMap = [
    [/game name brainstorm/iu, "游戏起名"],
    [/character stuck/iu, "角色卡住"],
    [/item info card/iu, "物品信息卡"],
    [/task completion and documentation/iu, "任务收口与文档"],
    [/japanese examiner review/iu, "日语考官复查"],
    [/independent quality check/iu, "独立质检"],
    [/development environment setup/iu, "开发环境搭建"],
    [/quality inspection/iu, "质量检查"],
    [/JLPT N2 quality inspection/iu, "JLPT N2 质检"],
    [/JLPT N3 independent quality check/iu, "JLPT N3 质检"],
  ];
  for (const [pattern, title] of englishMap) {
    if (pattern.test(text)) return title;
  }

  let compact = text
    .replace(/^今天是日本时间[\s\S]{0,48}?[。．.]\s*/u, "")
    .replace(/^当前(?:东京|日本)?时间[\s\S]{0,48}?[。．.]\s*/u, "")
    .replace(/^(?:请你|请帮我|麻烦你|麻烦|帮我|我想|我要|你帮我|帮忙|先|再|请)/u, "")
    .replace(/^(?:看看|看下|检查一下|改一下|修一下)/u, "")
    .replace(/^[（(][^）)]{0,12}[）)]\s*/u, "")
    .trim();
  compact = compact.split(/[。！？\n；;]/u)[0] || compact;
  compact = compact.replace(/[，,].{12,}$/u, "").trim();
  if (!compact || compact.length < 2) compact = text.replace(/^今天是日本时间[\s\S]{0,48}?[。．.]\s*/u, "").trim() || text;

  const chars = [...compact.replace(/\s+/gu, "")];
  if (chars.length >= 4) {
    const hasHan = /[\u4e00-\u9fff]/u.test(compact);
    const limit = hasHan ? 16 : 28;
    let title = chars.slice(0, limit).join("");
    title = title.replace(/[的了吗呢吧啊哦嗯]+$/u, "").trim();
    if ([...title].length >= 4) return title;
  }

  const englishWords = compact.match(/[A-Za-z][A-Za-z0-9\-]{2,}/gu) || [];
  if (englishWords.length) {
    const joined = englishWords.slice(0, 4).join(" ");
    return joined.length > 28 ? `${joined.slice(0, 28).trim()}…` : joined;
  }
  return "";
}

function messageTextFromTranscriptRow(row) {
  const message = row?.message;
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(message.text || "");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (part.type === "text" || part.type === "user_query" || !part.type) return String(part.text || "");
    return "";
  }).join("\n");
}

function firstUserQueryFromTranscriptFile(filePath) {
  let text = "";
  try {
    // Transcripts are usually small enough; sync read keeps title resolution simple.
    text = fsSync.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
  for (const line of text.split(/\r?\n/u)) {
    if (!line.includes('"role"') || !line.includes("user")) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (String(row?.role || "") !== "user") continue;
    const derived = deriveCursorWindowTitle(messageTextFromTranscriptRow(row));
    if (derived) return derived;
  }
  return "";
}

function listCursorAgentTranscriptFiles() {
  const root = path.join(os.homedir(), ".cursor", "projects");
  const files = new Map();
  let entries = [];
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  const queue = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name, "agent-transcripts"));
  for (const dir of queue) {
    let children = [];
    try { children = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const id = child.name;
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)) continue;
      const filePath = path.join(dir, id, `${id}.jsonl`);
      if (!fsSync.existsSync(filePath)) continue;
      const previous = files.get(id);
      try {
        const stat = fsSync.statSync(filePath);
        if (!previous || stat.mtimeMs >= previous.mtimeMs) files.set(id, { filePath, mtimeMs: stat.mtimeMs });
      } catch { /* ignore */ }
    }
  }
  return files;
}

async function readDerivedCursorWindowTitles(root) {
  const parsed = await readJson(path.join(root, CURSOR_WINDOW_TITLES_PATH), { schemaVersion: 1, titles: {} });
  const titles = new Map();
  for (const [id, value] of Object.entries(parsed?.titles || {})) {
    const title = typeof value === "string" ? value : String(value?.title || "").trim();
    if (!id || !title) continue;
    titles.set(id, title);
  }
  return { titles, raw: parsed };
}

async function writeDerivedCursorWindowTitles(root, titlesMap) {
  const filePath = path.join(root, CURSOR_WINDOW_TITLES_PATH);
  const titles = {};
  for (const [id, title] of titlesMap.entries()) {
    const clean = String(title || "").replace(/\s+/gu, " ").trim();
    if (!id || !clean) continue;
    titles[id] = { title: clean, source: "transcript-user-query", updatedAt: new Date().toISOString() };
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), titles }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function resolveCursorConversationTitles(root, conversationIds = []) {
  const localTitles = readLocalCursorConversationTitles();
  const { titles: derivedTitles } = await readDerivedCursorWindowTitles(root);
  const wanted = [...new Set((conversationIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const missing = wanted.filter((id) => {
    const local = localTitles.get(id) || "";
    const derived = derivedTitles.get(id) || "";
    return isWeakCursorWindowTitle(local) && isWeakCursorWindowTitle(derived);
  });

  if (missing.length) {
    const transcripts = listCursorAgentTranscriptFiles();
    let changed = false;
    for (const id of missing) {
      const hit = transcripts.get(id);
      let title = "";
      if (hit) title = firstUserQueryFromTranscriptFile(hit.filePath);
      if (!title) {
        const local = String(localTitles.get(id) || "").trim();
        if (local) title = deriveCursorWindowTitle(local);
      }
      if (!title) continue;
      derivedTitles.set(id, title);
      changed = true;
    }
    if (changed) await writeDerivedCursorWindowTitles(root, derivedTitles);
  }

  const merged = new Map();
  const ids = wanted.length ? wanted : [...new Set([...localTitles.keys(), ...derivedTitles.keys()])];
  for (const id of ids) {
    const local = String(localTitles.get(id) || "").trim();
    const derived = String(derivedTitles.get(id) || "").trim();
    const polishedLocal = isWeakCursorWindowTitle(local) ? deriveCursorWindowTitle(local) : "";
    const title = !isWeakCursorWindowTitle(local) ? local
      : !isWeakCursorWindowTitle(derived) ? derived
        : !isWeakCursorWindowTitle(polishedLocal) ? polishedLocal
          : derived || local;
    if (!title) continue;
    merged.set(id, title);
    if (id.startsWith("bc-")) merged.set(id.slice(3), title);
    else merged.set(`bc-${id}`, title);
  }
  return merged;
}

const CURSOR_ROLE_TITLES = Object.freeze({
  "health-daily": "身心日评",
  "monthly-review": "月度复盘",
  "training-review": "训练复盘",
  "japan-activities": "日本活动",
  "market-brief": "金融简报",
  "world-brief": "世界资讯",
  "workbench-daily-health": "每日轻量检查",
  "workbench-daily-release": "版本收口",
  "ai-tools-quarterly": "AI 工具季度盘点",
  "cursor-usage-probe": "用量探针",
});


function toIsoFromUnix(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Date(numeric * 1000).toISOString() : null;
}

async function parseCodexTokenEvents(filePath, cutoffMs) {
  const usage = zeroUsage();
  const days = new Map();
  let latestContextWindow = null;
  let latestRateLimit = null;
  try {
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"type":"token_count"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const event = row?.payload;
      if (event?.type !== "token_count") continue;
      const timestamp = Date.parse(row.timestamp || "");
      if (Number.isFinite(timestamp) && timestamp < cutoffMs) continue;
      const delta = normalizeCodexUsage(event.info?.last_token_usage);
      addUsage(usage, delta);
      const day = dateKey(row.timestamp);
      if (day) addUsage(days.get(day) || (days.set(day, zeroUsage()), days.get(day)), delta);
      const contextWindow = Number(event.info?.model_context_window);
      if (Number.isFinite(contextWindow) && contextWindow > 0) latestContextWindow = contextWindow;
      if (event.rate_limits && typeof event.rate_limits === "object") latestRateLimit = event.rate_limits;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { usage, days, latestContextWindow, latestRateLimit };
}

async function readLatestCodexSnapshot(filePath) {
  let stat;
  try { stat = await fs.stat(filePath); } catch (error) {
    if (error?.code === "ENOENT") return { usage: zeroUsage(), days: new Map(), latestContextWindow: null, latestRateLimit: null };
    throw error;
  }
  const cached = codexSnapshotCache.get(filePath);
  if (cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs) return cached.value;
  const handle = await fs.open(filePath, "r");
  try {
    const length = Math.min(stat.size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes('"type":"token_count"') || !line.includes('"total_token_usage"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const event = row?.payload;
      if (event?.type !== "token_count" || !event.info?.total_token_usage) continue;
      const usage = normalizeCodexUsage(event.info.total_token_usage);
      const days = new Map();
      const day = dateKey(row.timestamp);
      if (day) days.set(day, { ...usage });
      const value = {
        usage,
        days,
        latestContextWindow: numberOrZero(event.info.model_context_window) || null,
        latestRateLimit: event.rate_limits && typeof event.rate_limits === "object" ? event.rate_limits : null,
      };
      codexSnapshotCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, value });
      return value;
    }
  } finally {
    await handle.close();
  }
  const value = { usage: zeroUsage(), days: new Map(), latestContextWindow: null, latestRateLimit: null };
  codexSnapshotCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}

async function mapWithConcurrency(items, limit, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return result;
}

function openCodexState(codexHome, stateDbPath) {
  const candidate = stateDbPath || path.join(codexHome, "state_5.sqlite");
  return new DatabaseSync(candidate, { readOnly: true });
}

async function readCodexThreadNames(codexHome) {
  try {
    const source = await fs.readFile(path.join(codexHome, "session_index.jsonl"), "utf8");
    const names = new Map();
    for (const line of source.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const id = String(row?.id || "").trim();
        const name = String(row?.thread_name || "").replace(/\s+/gu, " ").trim();
        if (id && name) names.set(id, name);
      } catch {
        // Append-only index may end with one incomplete line while Codex is writing it.
      }
    }
    return names;
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
}

async function readCodexSessionIdentity(filePath) {
  if (!filePath) return {};
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const cached = codexIdentityCache.get(filePath);
    if (cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs) return cached.value;
    // Read only the bounded header; never search transcript bodies for parent IDs.
    const buffer = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0];
    let value = {};
    try {
      const row = JSON.parse(firstLine);
      if (row?.type === "session_meta") {
        value = { source: row.payload?.source, parent_thread_id: row.payload?.parent_thread_id };
      }
    } catch { /* Missing or truncated metadata must not turn transcript text into identity. */ }
    codexIdentityCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, value });
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readCodex(rootOptions, cutoffMs) {
  const codexHome = rootOptions.codexHome || path.join(os.homedir(), ".codex");
  const threadNames = await readCodexThreadNames(codexHome);
  let db;
  try {
    db = openCodexState(codexHome, rootOptions.stateDbPath);
  } catch {
    return { available: false, usage: zeroUsage(), chains: [], trend: new Map(), contextWindow: null, rateLimit: null };
  }
  try {
    const threadColumns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((row) => String(row.name)));
    const indexedTextColumns = ["first_user_message", "preview", "source", "thread_source"].filter((column) => threadColumns.has(column));
    const threads = db.prepare(`
      SELECT id, title, model, reasoning_effort, created_at, updated_at, rollout_path, archived, cwd, project_id${indexedTextColumns.length ? `, ${indexedTextColumns.join(", ")}` : ""}
      FROM threads
    `).all();
    const edges = db.prepare("SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges").all();
    const byId = new Map(threads.map((row) => [String(row.id), row]));
    const parentByChild = new Map(edges.map((edge) => [String(edge.child_thread_id), String(edge.parent_thread_id)]));
    const identities = new Map(await mapWithConcurrency(threads, 24, async (row) => [
      String(row.id), codexTaskIdentity(row, await readCodexSessionIdentity(row.rollout_path)),
    ]));
    for (const [id, identity] of identities) {
      if (!identity.parentId) continue;
      // Conflicting structural evidence is unresolved, never a guessed attribution.
      if (parentByChild.has(id) && parentByChild.get(id) !== identity.parentId) parentByChild.set(id, "");
      else parentByChild.set(id, identity.parentId);
    }
    const internalIds = new Set([...identities].filter(([id, identity]) => identity.internal || parentByChild.has(id)).map(([id]) => id));
    const active = threads.filter((row) => Number(row.updated_at) * 1000 >= cutoffMs && row.rollout_path);
    const parsed = await mapWithConcurrency(active, 24, async (row) => [
      String(row.id),
      Number(row.created_at) * 1000 >= cutoffMs
        ? await readLatestCodexSnapshot(String(row.rollout_path))
        : await parseCodexTokenEvents(String(row.rollout_path), cutoffMs),
    ]);
    const usageByThread = new Map(parsed);
    const chainByRoot = new Map();
    const trend = new Map();
    let contextWindow = null;
    let rateLimit = null;
    const usage = zeroUsage();
    const unattributedInternalUsage = zeroUsage();
    let unattributedInternalCount = 0;

    const rootFor = (threadId) => {
      const visited = new Set();
      let current = threadId;
      while (parentByChild.has(current)) {
        if (visited.has(current)) return null;
        visited.add(current);
        current = parentByChild.get(current);
        if (!byId.has(current)) return null;
      }
      return internalIds.has(current) ? null : current;
    };

    for (const [threadId, parsedThread] of usageByThread) {
      if (!parsedThread.usage.totalTokens) continue;
      addUsage(usage, parsedThread.usage);
      for (const [day, usage] of parsedThread.days) addUsage(trend.get(day) || (trend.set(day, zeroUsage()), trend.get(day)), usage);
      if (parsedThread.latestContextWindow) contextWindow = parsedThread.latestContextWindow;
      if (parsedThread.latestRateLimit) rateLimit = parsedThread.latestRateLimit;
      const rootId = rootFor(threadId);
      if (!rootId) {
        addUsage(unattributedInternalUsage, parsedThread.usage);
        unattributedInternalCount += 1;
        continue;
      }
      const rootThread = byId.get(rootId) || byId.get(threadId);
      let chain = chainByRoot.get(rootId);
      if (!chain) {
        chain = {
          id: rootId,
          kind: "codex",
          agent: "Codex",
          model: String(rootThread?.model || "Codex"),
          reasoningEffort: String(rootThread?.reasoning_effort || ""),
          startedAt: toIsoFromUnix(rootThread?.created_at),
          updatedAt: toIsoFromUnix(rootThread?.updated_at),
          selfUsage: zeroUsage(),
          childUsage: zeroUsage(),
          totalUsage: zeroUsage(),
          childCount: 0,
          sourceQuality: "local-count",
          sourceWindowTitle: threadNames.get(rootId) || String(rootThread?.title || "").trim(),
          classificationTexts: [],
          classificationEvidence: [],
          classificationCwds: [],
          sourceProjectIds: [],
          sourceFeatureIds: [],
        };
        chainByRoot.set(rootId, chain);
      }
      addUsage(threadId === rootId ? chain.selfUsage : chain.childUsage, parsedThread.usage);
      addUsage(chain.totalUsage, parsedThread.usage);
      const sourceThread = rootThread || {};
      // Approval transcripts may quote unrelated tasks. Only the user root supplies attribution text.
      for (const [evidence, value] of [
        ["title", threadNames.get(rootId) || sourceThread.title],
        ["first-user-message", sourceThread.first_user_message],
        ["preview", sourceThread.preview],
      ]) {
        const classificationText = String(value || "").trim().slice(0, 20_000);
        if (classificationText && !chain.classificationTexts.includes(classificationText)) chain.classificationTexts.push(classificationText);
        if (classificationText && !chain.classificationEvidence.includes(evidence)) chain.classificationEvidence.push(evidence);
      }
      const classificationCwd = String(sourceThread.cwd || "").trim();
      if (classificationCwd && !chain.classificationCwds.includes(classificationCwd)) {
        chain.classificationCwds.push(classificationCwd);
        if (!chain.classificationEvidence.includes("cwd")) chain.classificationEvidence.push("cwd");
      }
      const sourceProjectId = String(sourceThread.project_id || "").trim();
      if (sourceProjectId && !chain.sourceProjectIds.includes(sourceProjectId)) {
        chain.sourceProjectIds.push(sourceProjectId);
        if (!chain.classificationEvidence.includes("project-id")) chain.classificationEvidence.push("project-id");
      }
      if (threadId !== rootId) chain.childCount += 1;
      const updatedAt = toIsoFromUnix(byId.get(threadId)?.updated_at);
      if (updatedAt && (!chain.updatedAt || updatedAt > chain.updatedAt)) chain.updatedAt = updatedAt;
    }

    const chains = [...chainByRoot.values()].sort((left, right) => right.totalUsage.totalTokens - left.totalUsage.totalTokens);
    return { available: true, usage, chains, trend, contextWindow, rateLimit, internalIds, unattributedInternalUsage, unattributedInternalCount };
  } finally {
    db.close();
  }
}

function parseFrontmatter(markdown = "") {
  const match = String(markdown).match(/^---\n([\s\S]*?)\n---/u);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (/^"[\s\S]*"$/u.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"');
    result[key] = value;
  }
  return result;
}

async function listMarkdownFiles(directory) {
  const files = [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listMarkdownFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(candidate);
  }
  return files;
}

function flattenCursorUsageRecord(record = {}) {
  const nested = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage) ? record.usage : {};
  return {
    ...record,
    ...nested,
    usageSource: record.usageSource || record.source || nested.usageSource || "",
  };
}

function cursorUsageFromRecord(record, measured) {
  if (!measured) return null;
  const flat = flattenCursorUsageRecord(record);
  const freshInputTokens = numberOrZero(flat.freshInputTokens);
  const cacheReadTokens = numberOrZero(flat.cacheReadTokens ?? flat.cachedInputTokens);
  const cacheWriteTokens = numberOrZero(flat.cacheWriteTokens);
  const outputTokens = numberOrZero(flat.outputTokens);
  const inputTokens = numberOrZero(flat.inputTokens) || (freshInputTokens + cacheReadTokens + cacheWriteTokens);
  const totalTokens = numberOrZero(flat.totalTokens) || (inputTokens + outputTokens);
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return {
      inputTokens,
    cachedInputTokens: Math.min(inputTokens, cacheReadTokens),
      outputTokens,
      reasoningTokens: 0,
    totalTokens,
    fieldStatus: { inputTokens: "known", cachedInputTokens: "known", outputTokens: "known", reasoningTokens: "unknown", totalTokens: "known" },
  };
}

async function readJsonlRecords(filePath, cutoffMs, timestampKey = "at") {
  const rows = [];
  try {
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const stamp = Date.parse(row[timestampKey] || row.finishedAt || row.startedAt || "");
      if (Number.isFinite(cutoffMs) && (!Number.isFinite(stamp) || stamp < cutoffMs)) continue;
      rows.push(row);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return rows;
}

async function readCursorRuns(root, cutoffMs) {
  const files = await listMarkdownFiles(path.join(root, CURSOR_RUNS_PATH));
  const ledgerRows = await readJsonlRecords(path.join(root, CURSOR_BATCH_LEDGER_PATH), cutoffMs, "finishedAt");
  const ledgerByRunId = new Map();
  for (const row of ledgerRows) {
    const runId = String(row.runId || "").trim();
    if (runId) ledgerByRunId.set(runId, row);
  }
  const seenRunIds = new Set();
  const runs = [];

  function pushCursorRun(record, extras = {}) {
    const flat = flattenCursorUsageRecord(record);
    const roleId = String(flat.roleId || extras.roleId || "");
    const startedAt = Date.parse(flat.startedAt || extras.startedAt || "");
    const finishedAt = Date.parse(flat.finishedAt || extras.finishedAt || flat.updatedAt || "");
    const measured = Boolean(flat.usageSource === "cursor-headless-json" || extras.measured);
    const totalUsage = cursorUsageFromRecord(flat, measured);
    const runKey = String(record.runId || extras.runId || record.id || "").replace(/^cursor:/, "");
    const roleTitle = CURSOR_ROLE_TITLES[roleId] || (roleId ? roleId : "");
    runs.push({
      id: `cursor:${runKey}`,
      kind: "cursor",
      agent: "Cursor",
      roleId,
      roleName: roleTitle || roleId,
      trigger: String(record.trigger || extras.trigger || "unknown"),
      adapter: String(record.adapter || extras.adapter || "cursor-cli"),
      model: String(record.model || extras.model || "Cursor"),
      startedAt: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : (record.startedAt || extras.startedAt),
      updatedAt: Number.isFinite(finishedAt)
        ? new Date(finishedAt).toISOString()
        : (Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : record.updatedAt),
      durationMs: Number.isFinite(finishedAt) && Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : null,
      processState: String(record.processState || extras.processState || "unknown"),
      exitCode: Number.isFinite(Number(record.exitCode ?? extras.exitCode)) ? Number(record.exitCode ?? extras.exitCode) : null,
      selfUsage: totalUsage,
      childUsage: totalUsage ? zeroUsage() : null,
      totalUsage,
      childCount: 0,
      hasChildren: false,
      usageMode: "this-run",
      countsTowardSourceTotal: false, // filled later based on whether account authority exists
      sourceQuality: measured ? "cli-reported" : "runtime-only",
      sourceWindowTitle: roleTitle || null,
      classificationTexts: [roleTitle || roleId].filter(Boolean),
      classificationEvidence: ["role-binding"],
      classificationCwds: [],
      sourceProjectIds: [],
      sourceFeatureIds: CURSOR_ROLE_FEATURE_IDS[roleId] || [],
    });
  }

  for (const file of files) {
    let frontmatter;
    try { frontmatter = parseFrontmatter(await fs.readFile(file, "utf8")); } catch { continue; }
    const startedAt = Date.parse(frontmatter.startedAt || "");
    if (!Number.isFinite(startedAt) || startedAt < cutoffMs) continue;
    const runId = String(frontmatter.runId || path.basename(file, ".md"));
    const ledger = ledgerByRunId.get(runId);
    seenRunIds.add(runId);
    const merged = ledger ? { ...frontmatter, ...flattenCursorUsageRecord(ledger), runId } : frontmatter;
    const measured = merged.usageSource === "cursor-headless-json";
    pushCursorRun(merged, { runId, measured, startedAt: frontmatter.startedAt, finishedAt: frontmatter.finishedAt || ledger?.finishedAt });
  }

  for (const row of ledgerRows) {
    const runId = String(row.runId || "").trim();
    if (!runId || seenRunIds.has(runId)) continue;
    const startedAt = Date.parse(row.startedAt || row.finishedAt || "");
    if (Number.isFinite(cutoffMs) && (!Number.isFinite(startedAt) || startedAt < cutoffMs)) continue;
    const flat = flattenCursorUsageRecord(row);
    pushCursorRun(flat, { runId, measured: flat.usageSource === "cursor-headless-json" });
  }

  return runs.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function scheduledRunsLedger(allRuns = []) {
  const runs = allRuns
    .filter((run) => run.trigger !== "manual" && run.roleId !== "cursor-usage-probe")
    .map((run) => ({
      id: run.id,
      roleId: run.roleId,
      roleName: run.roleName || CURSOR_ROLE_TITLES[run.roleId] || run.roleId,
      agent: run.agent || (run.kind === "codex" ? "Codex" : "Cursor"),
      trigger: run.trigger || "unknown",
      model: run.model || "unknown",
      startedAt: run.startedAt || null,
      updatedAt: run.updatedAt || null,
      durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
      processState: String(run.processState || ""),
      exitCode: Number.isFinite(run.exitCode) ? run.exitCode : null,
      measured: Boolean(run.totalUsage),
      usage: run.totalUsage || null,
    }));
  return {
    runCount: runs.length,
    measuredRunCount: runs.filter((run) => run.measured).length,
    usage: runs.reduce((usage, run) => addUsage(usage, run.usage), zeroUsage()),
    runs,
  };
}

function tomlString(body, key) {
  const match = String(body || "").match(new RegExp(`^${key}\\s*=\\s*"([^"\\n]*)"\\s*$`, "m"));
  return match?.[1] || "";
}

async function readCodexScheduledTurns(filePath, automations, cutoffMs, fallback = {}) {
  const runs = [];
  let active = null;
  try {
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const payload = row?.payload || {};
      const timestamp = row.timestamp || null;
      if (row.type === "event_msg" && payload.type === "task_started") {
        active = { turnId: String(payload.turn_id || ""), startedAt: timestamp, updatedAt: timestamp, usage: zeroUsage(), hasUsage: false, seenCumulative: new Set(), automation: null, model: fallback.model || "Codex", reasoningEffort: fallback.reasoningEffort || null };
        continue;
      }
      if (!active) continue;
      active.updatedAt = timestamp || active.updatedAt;
      if (row.type === "turn_context") {
        active.model = String(payload.model || payload.model_info?.model || active.model);
        active.reasoningEffort = payload.reasoning_effort || payload.effort || active.reasoningEffort;
        continue;
      }
      if (row.type === "response_item" && payload.type === "function_call_output" && payload.name === "automation_update") {
        const automationId = String(payload.output || "").match(/<automation_id>([^<]+)<\/automation_id>/u)?.[1]?.trim();
        if (automationId && automations.has(automationId)) active.automation = automations.get(automationId);
        continue;
      }
      if (row.type === "event_msg" && payload.type === "token_count" && active.automation) {
        const last = payload.info?.last_token_usage;
        const cumulative = payload.info?.total_token_usage;
        const signature = cumulative ? JSON.stringify(cumulative) : null;
        if (last && (!signature || !active.seenCumulative.has(signature))) {
          addUsage(active.usage, normalizeCodexUsage(last));
          active.hasUsage = true;
          if (signature) active.seenCumulative.add(signature);
        }
        continue;
      }
      if (row.type === "event_msg" && (payload.type === "task_complete" || payload.type === "task_failed" || payload.type === "turn_aborted")) {
        if (active.automation && (!payload.turn_id || !active.turnId || payload.turn_id === active.turnId)) {
          const updatedAt = timestamp;
          const startedMs = Date.parse(active.startedAt || "");
          const updatedMs = Date.parse(updatedAt || "");
          if ((!Number.isFinite(cutoffMs) || updatedMs >= cutoffMs) && Number.isFinite(updatedMs)) {
            const hasUsage = active.hasUsage;
            runs.push({
              id: `codex-scheduled:${active.automation.id}:${active.turnId || updatedAt}`,
              kind: "codex",
              agent: "Codex",
              roleId: active.automation.roleId,
              roleName: active.automation.name,
              trigger: "codex-heartbeat",
              model: active.model,
              reasoningEffort: active.reasoningEffort,
              startedAt: active.startedAt,
              updatedAt,
              durationMs: Number.isFinite(startedMs) ? Math.max(0, updatedMs - startedMs) : null,
              processState: payload.type === "task_complete" ? "exited" : "failed",
              exitCode: payload.type === "task_complete" ? 0 : 1,
              totalUsage: hasUsage ? active.usage : null,
            });
          }
        }
        active = null;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (active?.automation && Date.parse(active.updatedAt || "") >= cutoffMs) {
    runs.push({
      id: `codex-scheduled:${active.automation.id}:${active.turnId || active.startedAt}`,
      kind: "codex", agent: "Codex", roleId: active.automation.roleId, roleName: active.automation.name,
      trigger: "codex-heartbeat", model: active.model, reasoningEffort: active.reasoningEffort,
      startedAt: active.startedAt, updatedAt: active.updatedAt, durationMs: null,
      processState: "unknown", exitCode: null, totalUsage: active.hasUsage ? active.usage : null,
    });
  }
  return runs;
}

async function readCodexScheduledRuns(root, options, cutoffMs) {
  const codexHome = options.codexHome || path.join(os.homedir(), ".codex");
  const automationDir = path.join(codexHome, "automations");
  const bindings = await readJson(path.join(root, "00_本地工作台/40_数据/agent-runtime-bindings.json"), { adapters: {}, roles: {} });
  const roleByAutomation = new Map();
  for (const [roleId, role] of Object.entries(bindings.roles || {})) {
    const adapter = bindings.adapters?.[role?.adapter];
    if (adapter?.kind === "heartbeat" && adapter.automationId) roleByAutomation.set(adapter.automationId, roleId);
  }
  roleByAutomation.set("ai", roleByAutomation.get("ai") || "agent-task-readonly-verifier");
  const automations = new Map();
  let entries = [];
  try { entries = await fs.readdir(automationDir, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let body = "";
    try { body = await fs.readFile(path.join(automationDir, entry.name, "automation.toml"), "utf8"); } catch { continue; }
    const id = tomlString(body, "id");
    const threadId = tomlString(body, "target_thread_id");
    if (!id || !threadId || tomlString(body, "status") !== "ACTIVE" || tomlString(body, "kind") !== "heartbeat") continue;
    automations.set(id, { id, threadId, name: tomlString(body, "name") || id, roleId: roleByAutomation.get(id) || `codex-automation-${id}` });
  }
  if (!automations.size) return [];
  let db;
  try { db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"), { readOnly: true }); } catch { return []; }
  try {
    const rows = db.prepare("SELECT id, rollout_path, model, reasoning_effort FROM threads").all();
    const byThread = new Map(rows.map((row) => [String(row.id), row]));
    const runs = [];
    for (const automation of automations.values()) {
      const thread = byThread.get(automation.threadId);
      if (!thread?.rollout_path) continue;
      runs.push(...await readCodexScheduledTurns(String(thread.rollout_path), new Map([[automation.id, automation]]), cutoffMs, {
        model: thread.model,
        reasoningEffort: thread.reasoning_effort,
      }));
    }
    return runs;
  } finally {
    db.close();
  }
}

function usageTrend(rows = []) {
  const trend = new Map();
  for (const row of rows) {
    const day = dateKey(row.at || row.updatedAt);
    if (!day || !row.usage) continue;
    addUsage(trend.get(day) || (trend.set(day, zeroUsage()), trend.get(day)), row.usage);
  }
  return trend;
}

async function readJson(pathname, fallback) {
  try { return JSON.parse(await fs.readFile(pathname, "utf8")); } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function readLinks(root) {
  const parsed = await readJson(path.join(root, LINKS_PATH), { schemaVersion: 1, links: {} });
  return parsed && typeof parsed.links === "object" && !Array.isArray(parsed.links) ? parsed.links : {};
}

function flattenNodeText(nodes = []) {
  return nodes.flatMap((node) => [node.name || node.text || "", node.description || "", ...flattenNodeText(node.children || [])]);
}

async function featureCatalog(root) {
  const management = await readProjectManagement(root);
  const catalog = management.projects.flatMap((project) => {
    const rootEntry = {
      id: `project:${project.projectId}`,
      name: `${project.name} Wiki`,
      moduleId: "",
      moduleName: "项目 Wiki",
      projectId: project.projectId,
      projectName: project.name,
      treeId: "",
      worklineId: "",
      nodeKind: "project",
      classificationText: `${project.name} ${project.projectId}`,
    };
    const internal = (project.featureTree?.modules || []).flatMap((module) => module.features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      moduleId: module.id,
      moduleName: module.name,
      projectId: project.projectId,
      projectName: project.name,
      treeId: "",
      worklineId: "",
      nodeKind: "feature",
      classificationText: [feature.name, feature.description, ...flattenNodeText(feature.points || [])].join(" "),
    })));
    const external = (project.projectHub?.featureTrees || []).flatMap((tree) => {
      const workline = (project.projectHub?.worklines || []).find((item) => item.view?.kind === "featureTree" && item.view.treeId === tree.id);
      return (tree.modules || []).flatMap((module) => (module.features || []).map((feature) => ({
        id: feature.id,
        name: feature.name,
        moduleId: module.id,
        moduleName: module.name,
        projectId: project.projectId,
        projectName: project.name,
        treeId: tree.id,
        worklineId: workline?.id || "",
        nodeKind: "feature",
        classificationText: [feature.name, feature.description, ...flattenNodeText(feature.children || [])].join(" "),
      })));
    });
    return internal.length || external.length ? [rootEntry, ...internal, ...external] : [];
  });
  if (catalog.length) return [...PERSONAL_LIFE_CATALOG, ...catalog];
  const tree = await readProductFeatureTree(root, FEATURE_TREE_PATH);
  const fallbackFeatures = (tree?.modules || []).flatMap((module) => module.features.map((feature) => ({
    id: feature.id,
    name: feature.name,
    moduleId: module.id,
    moduleName: module.name,
    projectId: "infans-ai-system",
    projectName: "小秘书",
    treeId: "",
    worklineId: "",
    nodeKind: "feature",
    classificationText: [feature.name, feature.description, ...flattenNodeText(feature.points || [])].join(" "),
  })));
  return fallbackFeatures.length ? [...PERSONAL_LIFE_CATALOG, {
    id: "project:infans-ai-system",
    name: "小秘书 Wiki",
    moduleId: "",
    moduleName: "项目 Wiki",
    projectId: "infans-ai-system",
    projectName: "小秘书",
    treeId: "",
    worklineId: "",
    nodeKind: "project",
    classificationText: "小秘书 infans-ai-system",
  }, ...fallbackFeatures] : [...PERSONAL_LIFE_CATALOG];
}

async function readExternalLedger(root, cutoffMs) {
  const rows = [];
  const lifetimeRows = [];
  const eventIds = new Set();
  try {
    const input = createReadStream(path.join(root, EXTERNAL_LEDGER_PATH), { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const eventId = String(row.eventId || "").trim();
      if (eventId && eventIds.has(eventId)) continue;
      if (eventId) eventIds.add(eventId);
      const normalized = normalizeExternalUsage({ ...(row.usage || {}), costUsd: row.costUsd });
      const normalizedRow = {
        ...row,
        provider: String(row.provider || "external"),
        model: String(row.model || "unknown"),
        surface: String(row.surface || "unknown"),
        phase: String(row.phase || "legacy"),
        taskWindowKind: String(row.taskWindowKind || "legacy-surface"),
        taskWindowId: String(row.taskWindowId || `external:${row.surface || "unknown"}`),
        usage: {
          inputTokens: normalized.inputTokens,
          cachedInputTokens: normalized.cachedInputTokens,
          outputTokens: normalized.outputTokens,
          reasoningTokens: normalized.reasoningTokens,
          totalTokens: normalized.totalTokens,
          fieldStatus: normalized.fieldStatus,
        },
        costUsd: normalized.costUsd,
      };
      lifetimeRows.push(normalizedRow);
      if (Date.parse(row.at || "") >= cutoffMs) rows.push(normalizedRow);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const usage = zeroUsage();
  let costUsd = 0;
  const detailMap = new Map();
  for (const row of rows) {
    addUsage(usage, row.usage);
    costUsd += numberOrZero(row.costUsd);
    const key = `${row.provider}\0${row.model}`;
    const detail = detailMap.get(key) || {
      id: key,
      provider: row.provider,
      upstreamProvider: row.upstreamProvider || null,
      model: row.model,
      surface: row.surface,
      taskWindowKind: "external-summary",
      taskWindowId: `summary:${row.provider}:${row.model}`,
      phases: [],
      usage: zeroUsage(),
      costUsd: 0,
      requestCount: 0,
      lastAt: row.at,
    };
    addUsage(detail.usage, row.usage);
    detail.costUsd += numberOrZero(row.costUsd);
    detail.requestCount += 1;
    detail.lastAt = Date.parse(row.at) > Date.parse(detail.lastAt) ? row.at : detail.lastAt;
    detail.phases = [...new Set([...detail.phases, row.phase])];
    detailMap.set(key, detail);
  }
  const details = [...detailMap.values()].sort((left, right) => right.usage.totalTokens - left.usage.totalTokens || right.costUsd - left.costUsd);
  return {
    rows,
    details,
    usage,
    costUsd,
    lifetimeCostUsd: lifetimeRows.reduce((sum, row) => sum + numberOrZero(row.costUsd), 0),
    lifetimeRequestCount: lifetimeRows.length,
    trend: usageTrend(rows.map((row) => ({ at: row.at, usage: row.usage }))),
  };
}

export function reconcileExternalAccount(snapshot, status = {}) {
  const usageUsd = status?.usageUsd != null && Number.isFinite(Number(status.usageUsd)) ? Number(status.usageUsd) : null;
  const attributedCostUsd = numberOrZero(snapshot?.externalAccount?.attributedCostUsd);
  const unattributedCostUsd = usageUsd == null ? null : Math.max(0, usageUsd - attributedCostUsd);
  const coverageRatio = usageUsd && usageUsd > 0 ? Math.min(1, attributedCostUsd / usageUsd) : 0;
  const externalAccount = {
    scope: "current-key",
    usageUsd,
    attributedCostUsd,
    unattributedCostUsd,
    coverageRatio,
    requestCount: Number(snapshot?.externalAccount?.requestCount) || 0,
    checkedAt: status?.checkedAt || null,
    available: usageUsd != null,
    note: usageUsd == null
      ? "当前无法读取 OpenRouter 密钥累计；本地分请求账仍可继续记录。"
      : unattributedCostUsd > 0.0000005
        ? "差额属于本地逐请求账接入前的历史，只保留汇总金额。"
        : "当前密钥累计已全部由本地实账覆盖。",
  };
  return {
    ...snapshot,
    externalAccount,
    agents: (snapshot?.agents || []).map((agent) => agent.id === "external" ? {
      ...agent,
      note: usageUsd == null
        ? agent.note
        : `当前 OpenRouter 密钥累计 $${usageUsd.toFixed(6)}；接入后本地实账 $${attributedCostUsd.toFixed(6)}。`,
    } : agent),
  };
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

function normalizeCsvHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseCsvNumber(value) {
  const text = String(value || "").trim();
  if (!text || /^(included|n\/a|-|—)$/i.test(text)) return 0;
  const numeric = Number(text.replace(/,/g, ""));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function parseCsvTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const us = Date.parse(text.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/, "$3-$1-$2"));
  return Number.isFinite(us) ? new Date(us).toISOString() : null;
}

const CURSOR_CSV_HEADERS = Object.freeze({
  date: "at",
  kind: "kind",
  type: "kind",
  model: "model",
  "input (w/ cache write)": "cacheWriteTokens",
  "input (w/o cache write)": "freshInputTokens",
  "cache read": "cacheReadTokens",
  "output tokens": "outputTokens",
  "total tokens": "totalTokens",
  "input tokens": "freshInputTokens",
});

export function parseCursorUsageCsv(csv) {
  const lines = String(csv || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(normalizeCsvHeader);
  const mapped = headers.map((header) => CURSOR_CSV_HEADERS[header] || null);
  if (!mapped.includes("freshInputTokens") && !mapped.includes("outputTokens") && !mapped.includes("totalTokens")) {
    throw new Error("CSV 缺少 Token 列。请导出 Cursor Dashboard 的 Usage 表，而不是账单金额表。");
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const raw = {};
    mapped.forEach((key, index) => {
      if (key) raw[key] = cells[index];
    });
    const at = parseCsvTimestamp(raw.at);
    const freshInputTokens = parseCsvNumber(raw.freshInputTokens);
    const cacheReadTokens = parseCsvNumber(raw.cacheReadTokens);
    const cacheWriteTokens = parseCsvNumber(raw.cacheWriteTokens);
    const outputTokens = parseCsvNumber(raw.outputTokens);
    const inputTokens = freshInputTokens + cacheReadTokens + cacheWriteTokens;
    const totalTokens = parseCsvNumber(raw.totalTokens) || (inputTokens + outputTokens);
    if (!at || (!inputTokens && !outputTokens && !totalTokens)) continue;
    const model = String(raw.model || "Cursor").slice(0, 128);
    const kind = String(raw.kind || "usage").slice(0, 64);
    const eventId = createHash("sha256").update([at, kind, model, freshInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens].join("\0")).digest("hex").slice(0, 32);
    rows.push({
      eventId: `cursor-account:${eventId}`,
      at,
      kind,
      model,
      usage: {
        inputTokens,
        cachedInputTokens: Math.min(inputTokens, cacheReadTokens),
        outputTokens,
        reasoningTokens: null,
        totalTokens,
      },
    });
  }
  return rows;
}

async function existingCursorAccountEventIds(root) {
  const ids = new Set();
  for (const row of await readJsonlRecords(path.join(root, CURSOR_ACCOUNT_LEDGER_PATH), 0, "at")) {
    if (row.eventId) ids.add(String(row.eventId));
  }
  return ids;
}

export async function importCursorAccountCsv(root, csv, options = {}) {
  const parsed = parseCursorUsageCsv(csv);
  if (!parsed.length) throw new Error("CSV 里没有可识别的 Token 行。");
  const existing = await existingCursorAccountEventIds(root);
  const importedAt = new Date().toISOString();
  const filePath = path.join(root, CURSOR_ACCOUNT_LEDGER_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let imported = 0;
  let skippedDuplicates = 0;
  const source = String(options.source || "cursor-dashboard-csv").slice(0, 64);
  for (const row of parsed) {
    if (existing.has(row.eventId)) {
      skippedDuplicates += 1;
      continue;
    }
    existing.add(row.eventId);
    const record = {
      schemaVersion: 1,
      bucket: "account-history",
      source,
      eventId: row.eventId,
      at: row.at,
      kind: row.kind,
      model: row.model,
      importedAt,
      usage: row.usage,
    };
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    imported += 1;
  }
  if (imported || skippedDuplicates) await fs.chmod(filePath, 0o600);
  if (imported) await invalidateSnapshotCache(root);
  const ledger = await readCursorAccountLedger(root, 0);
  return { ok: true, imported, skippedDuplicates, eventCount: ledger.eventCount, usage: ledger.usage };
}

function readLocalCursorSessionCookie() {
  const dbPath = path.join(os.homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("本机没有找到 Cursor 登录状态。");
    throw error;
  }
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
    const raw = String(row?.value || "").replace(/^"|"$/g, "");
    if (!raw) throw new Error("本机 Cursor 未登录，没法代你拉 Usage。");
    return `WorkosCursorSessionToken=${encodeURIComponent(decodeJwtSubject(raw))}%3A%3A${raw}`;
  } finally {
    db.close();
  }
}

function decodeJwtSubject(token) {
  const payload = String(token || "").split(".")[1] || "";
  const padded = payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    return String(JSON.parse(Buffer.from(padded, "base64").toString("utf8")).sub || "");
  } catch {
    return "";
  }
}

export function cursorAccountCsvFromEvents(events = []) {
  const lines = ["Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens"];
  let skipped = 0;
  for (const event of events) {
    const usage = event?.tokenUsage && typeof event.tokenUsage === "object" ? event.tokenUsage : {};
    const fresh = numberOrZero(usage.inputTokens);
    const cacheWrite = numberOrZero(usage.cacheWriteTokens);
    const cacheRead = numberOrZero(usage.cacheReadTokens);
    const output = numberOrZero(usage.outputTokens);
    const total = numberOrZero(usage.totalTokens) || (fresh + cacheRead + cacheWrite + output);
    if (!total && !fresh && !output) {
      skipped += 1;
      continue;
    }
    const stamp = Number(event.timestamp);
    const at = Number.isFinite(stamp) ? new Date(stamp).toISOString() : String(event.timestamp || "");
    const model = String(event.model || "Cursor").replaceAll(",", " ").slice(0, 128);
    const kind = String(event.kind || (event.isHeadless ? "headless" : "usage")).replaceAll(",", " ").slice(0, 64);
    lines.push([at, kind, model, cacheWrite, fresh, cacheRead, output, total].join(","));
  }
  return { csv: `${lines.join("\n")}\n`, eventCount: lines.length - 1, skipped };
}

export async function importCursorAccountEvents(root, events = [], options = {}) {
  const filePath = path.join(root, CURSOR_ACCOUNT_LEDGER_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await existingCursorAccountEventIds(root);
  const importedAt = new Date().toISOString();
  const source = String(options.source || "cursor-local-session").slice(0, 64);
  let imported = 0;
  let skippedDuplicates = 0;
  let skippedNoTokens = 0;
  for (const event of events) {
    const stamp = Number(event?.timestamp);
    const at = Number.isFinite(stamp) ? new Date(stamp).toISOString() : String(event?.timestamp || "");
    if (!at || !Number.isFinite(Date.parse(at))) {
      skippedNoTokens += 1;
      continue;
    }
    const usage = usageFromCursorTokenUsage(event?.tokenUsage);
    if (!usage) {
      skippedNoTokens += 1;
      continue;
    }
    const conversationId = String(event?.conversationId || "").trim() || null;
    const model = String(event?.model || "Cursor").slice(0, 128);
    const kind = String(event?.kind || (event?.isHeadless ? "headless" : "usage")).slice(0, 64);
    const chargedCents = nullableNumber(event?.chargedCents);
    const listedCents = nullableNumber(event?.tokenUsage?.totalCents);
    const requestsCosts = nullableNumber(event?.requestsCosts);
    const isHeadless = event?.isHeadless === true;
    const fingerprint = createHash("sha256").update([
      at,
      conversationId || "",
      kind,
      model,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.cacheWriteTokens ?? "",
      usage.outputTokens,
      usage.totalTokens,
      chargedCents ?? "",
      isHeadless ? "1" : "0",
    ].join("\0")).digest("hex").slice(0, 32);
    const eventId = `cursor-account:${fingerprint}`;
    if (existing.has(eventId)) {
      skippedDuplicates += 1;
      continue;
    }
    existing.add(eventId);
    const record = {
      schemaVersion: 2,
      bucket: "account-history",
      source,
      eventId,
      at,
      kind,
      model,
      conversationId,
      isHeadless,
      chargedCents,
      listedCents,
      requestsCosts,
      importedAt,
      usage: {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens == null ? null : numberOrZero(usage.reasoningTokens),
        totalTokens: usage.totalTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
    };
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    imported += 1;
  }
  if (imported || skippedDuplicates) await fs.chmod(filePath, 0o600);
  if (imported) await invalidateSnapshotCache(root);
  const ledger = await readCursorAccountLedger(root, 0);
  return {
    ok: true,
    imported,
    skippedDuplicates,
    skippedNoTokens,
    eventCount: ledger.eventCount,
    usage: ledger.usage,
  };
}

export async function syncCursorAccountFromLocalSession(root, options = {}) {
  const cookie = readLocalCursorSessionCookie();
  const startMs = Number.isFinite(Date.parse(options.since)) ? Date.parse(options.since) : Date.parse("2026-08-01T00:00:00+09:00");
  const endMs = Date.now();
  const headers = {
    Cookie: cookie,
    Origin: "https://cursor.com",
    Referer: "https://cursor.com/dashboard/usage",
    "Content-Type": "application/json",
  };
  const me = await fetch("https://cursor.com/api/auth/me", { headers, signal: AbortSignal.timeout(20_000) });
  if (!me.ok) throw new Error("本机 Cursor 登录已过期，没法代你拉 Usage。");
  const events = [];
  const pageSize = 200;
  for (let page = 1; page <= 80; page += 1) {
    const response = await fetch("https://cursor.com/api/dashboard/get-filtered-usage-events", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ startDate: String(startMs), endDate: String(endMs), page, pageSize }),
    });
    if (!response.ok) throw new Error("Cursor Usage 页暂时读不到。");
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("Cursor Usage 页暂时读不到。");
    }
    const batch = Array.isArray(data.usageEventsDisplay) ? data.usageEventsDisplay : [];
    events.push(...batch);
    if (batch.length < pageSize || events.length >= Number(data.totalUsageEventsCount || 0)) break;
  }
  if (!events.length) throw new Error("Usage 页这段时间没有可同步的记录。");
  const imported = await importCursorAccountEvents(root, events, { source: "cursor-local-session" });
  if (!imported.imported && !imported.eventCount) throw new Error("Usage 页这段时间没有带 Token 的记录。");
  return { ...imported, fetched: events.length, since: new Date(startMs).toISOString() };
}

async function readCursorAccountLedger(root, cutoffMs) {
  const rawRows = await readJsonlRecords(path.join(root, CURSOR_ACCOUNT_LEDGER_PATH), cutoffMs, "at");
  const { rows, suppressedDuplicateCount, eventCountBefore } = dedupeCursorAccountRows(rawRows);
  const usage = zeroUsage();
  const detailMap = new Map();
  const conversationMap = new Map();
  let importedAt = null;
  let chargedCentsSum = 0;
  let chargedEventCount = 0;
  let listedCentsSum = 0;
  let listedEventCount = 0;
  let reasoningProvidedEventCount = 0;
  for (const row of rows) {
    if (!row.usage || typeof row.usage !== "object") continue;
    const reasoningRaw = row.usage.reasoningTokens;
    const reasoningProvided = reasoningRaw != null && reasoningRaw !== "";
    if (reasoningProvided) reasoningProvidedEventCount += 1;
    const normalized = {
      inputTokens: numberOrZero(row.usage.inputTokens),
      cachedInputTokens: numberOrZero(row.usage.cachedInputTokens),
      outputTokens: numberOrZero(row.usage.outputTokens),
      // Cursor Usage usually omits reasoning; keep null so globals can mark "known portion".
      reasoningTokens: reasoningProvided ? numberOrZero(reasoningRaw) : null,
      totalTokens: numberOrZero(row.usage.totalTokens) || (numberOrZero(row.usage.inputTokens) + numberOrZero(row.usage.outputTokens)),
      cacheWriteTokens: nullableNumber(row.usage.cacheWriteTokens),
    };
    if (!normalized.totalTokens) continue;
    addUsage(usage, normalized);
    if (!importedAt || Date.parse(row.importedAt || "") > Date.parse(importedAt)) importedAt = row.importedAt || null;
    const charged = nullableNumber(row.chargedCents);
    if (charged != null) {
      chargedCentsSum += charged;
      chargedEventCount += 1;
    }
    const listed = nullableNumber(row.listedCents);
    if (listed != null) {
      listedCentsSum += listed;
      listedEventCount += 1;
    }
    const day = dateKey(row.at);
    const key = `${day}\0${row.model || "Cursor"}\0${row.kind || "usage"}`;
    const detail = detailMap.get(key) || {
      id: key,
      at: row.at,
      kind: String(row.kind || "usage"),
      model: String(row.model || "Cursor"),
      usage: zeroUsage(),
      eventCount: 0,
      chargedCents: null,
      listedCents: null,
    };
    addUsage(detail.usage, normalized);
    detail.eventCount += 1;
    if (charged != null) detail.chargedCents = (detail.chargedCents || 0) + charged;
    if (listed != null) detail.listedCents = (detail.listedCents || 0) + listed;
    if (Date.parse(row.at) > Date.parse(detail.at)) detail.at = row.at;
    detailMap.set(key, detail);

    const conversationId = String(row.conversationId || "").trim();
    if (conversationId) {
      const conversation = conversationMap.get(conversationId) || {
        conversationId,
        usage: zeroUsage(),
        eventCount: 0,
        modelCounts: new Map(),
        startedAt: row.at,
        updatedAt: row.at,
        chargedCents: null,
        kinds: new Set(),
      };
      addUsage(conversation.usage, normalized);
      conversation.eventCount += 1;
      conversation.modelCounts.set(row.model || "Cursor", (conversation.modelCounts.get(row.model || "Cursor") || 0) + 1);
      if (row.kind) conversation.kinds.add(String(row.kind));
      if (charged != null) conversation.chargedCents = (conversation.chargedCents || 0) + charged;
      if (Date.parse(row.at) < Date.parse(conversation.startedAt)) conversation.startedAt = row.at;
      if (Date.parse(row.at) > Date.parse(conversation.updatedAt)) conversation.updatedAt = row.at;
      conversationMap.set(conversationId, conversation);
    }
  }
  const details = [...detailMap.values()].sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || right.usage.totalTokens - left.usage.totalTokens);
  const conversations = [...conversationMap.values()].map((item) => {
    const models = [...item.modelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      conversationId: item.conversationId,
      usage: item.usage,
      eventCount: item.eventCount,
      model: models[0]?.[0] || "Cursor",
      models: models.map(([model, count]) => ({ model, count })),
      startedAt: item.startedAt,
      updatedAt: item.updatedAt,
      chargedCents: item.chargedCents,
      kinds: [...item.kinds],
    };
  });
  const reasoningTokensStatus = !rows.length
    ? "unknown"
    : reasoningProvidedEventCount === rows.length
      ? "complete"
      : reasoningProvidedEventCount > 0
        ? "partial"
        : "unknown";
  const dedupeNote = suppressedDuplicateCount
    ? `已按时间／模型／Token 去掉 ${suppressedDuplicateCount} 条跨采集重复（原始 ${eventCountBefore} 条，保留 ${rows.length} 条；本机会话优先于 CSV）。`
    : "";
  return {
    usage: rows.length ? usage : null,
    eventCount: rows.length,
    rawEventCount: eventCountBefore,
    suppressedDuplicateCount,
    importedAt,
    details,
    conversations,
    chargedCents: chargedEventCount ? chargedCentsSum : null,
    listedCents: listedEventCount ? listedCentsSum : null,
    chargedEventCount,
    // Vendor pricing signal only — never treat as verified cash outlay.
    chargedCentsMeaning: chargedEventCount ? "vendor-pricing-unverified" : null,
    reasoningTokensStatus,
    note: rows.length
      ? `刷新账册时用本机已登录会话自动同步 Usage，只作为 Cursor 来源总账与模型／日明细；不把日／模型聚合伪装成任务窗口。${dedupeNote}`
      : "还没有账户历史。点刷新会自动用本机 Cursor 登录态同步 Usage，不必导出 CSV。",
  };
}

function cursorConversationTasksFromAccount(cursorAccount, titleMap) {
  const tasks = [];
  for (const conversation of cursorAccount?.conversations || []) {
    const title = String(titleMap.get(conversation.conversationId) || "").replace(/\s+/gu, " ").trim();
    if (!title) continue;
    const usage = conversation.usage ? { ...conversation.usage } : null;
    if (!usage?.totalTokens) continue;
    tasks.push({
      id: `cursor-conversation:${conversation.conversationId}`,
      kind: "cursor",
      agent: "Cursor",
      model: conversation.model,
      startedAt: conversation.startedAt,
      updatedAt: conversation.updatedAt,
      durationMs: null,
      processState: "account-conversation",
      exitCode: null,
      selfUsage: usage,
      childUsage: zeroUsage(),
      totalUsage: usage,
      childCount: 0,
      hasChildren: false,
      usageMode: "this-run",
      countsTowardSourceTotal: true,
      sourceQuality: "account-history",
      sourceWindowTitle: title,
      classificationTexts: [title, conversation.model],
      classificationEvidence: ["conversation-title"],
      classificationCwds: [],
      sourceProjectIds: [],
      sourceFeatureIds: [],
      accountKind: conversation.kinds?.[0] || null,
      conversationId: conversation.conversationId,
      eventCount: conversation.eventCount,
      actualChargedCents: conversation.chargedCents,
    });
  }
  return tasks;
}

async function cursorAccountNeedsSync(root) {
  const ledger = await readCursorAccountLedger(root, 0);
  if (!ledger.eventCount) return true;
  const importedAt = Date.parse(ledger.importedAt || "");
  return !Number.isFinite(importedAt) || Date.now() - importedAt > CURSOR_ACCOUNT_SYNC_MAX_AGE_MS;
}

async function maybeSyncCursorAccount(root, options = {}) {
  if (options.skipCursorSync || options.nowMs) return null;
  const force = Boolean(options.force);
  if (!force && !(await cursorAccountNeedsSync(root))) return null;
  try {
    return await syncCursorAccountFromLocalSession(root);
  } catch {
    return null;
  }
}

function addScaledUsage(target, value, scale) {
  if (!value) return target;
  return addUsage(target, {
    inputTokens: numberOrZero(value.inputTokens) * scale,
    cachedInputTokens: numberOrZero(value.cachedInputTokens) * scale,
    outputTokens: numberOrZero(value.outputTokens) * scale,
    reasoningTokens: value.reasoningTokens == null ? null : numberOrZero(value.reasoningTokens) * scale,
    totalTokens: numberOrZero(value.totalTokens) * scale,
    fieldStatus: value.fieldStatus,
  });
}

function taskLedgerText(task) {
  return normalizedClassifierText([task.title, task.sourceWindowTitle, ...(task.classificationTexts || [])].filter(Boolean).join(" "));
}

function isSystemTestTask(task) {
  return /\binitialized\b|smoke test|烟雾测试|隔离烟雾|只回复 initialized|dompath|position top/iu.test(taskLedgerText(task));
}

function isProjectExplorationTask(task) {
  return /游戏.{0,12}(方案|原型|demo|改编|玩法|核心循环)|修仙.{0,12}(demo|原型|玩法|方案)|faeria|炉石修仙|增量游戏|可玩\s*demo|核心循环|采矿手势|心动物语/iu.test(taskLedgerText(task));
}

function featureLedger(tasks, catalog) {
  const byId = new Map(catalog
    .filter((feature) => feature.nodeKind === "feature")
    .map(({ classificationText: _classificationText, ...feature }) => [feature.id, { ...feature, usage: zeroUsage(), taskCount: 0, measuredTaskCount: 0 }]));
  const unresolvedByProject = new Map();
  const unlinked = { id: "other:unlinked", name: "未归属项目", moduleId: "", moduleName: "待整理", projectId: "other", projectName: "其他", treeId: "", worklineId: "", nodeKind: "project", usage: zeroUsage(), taskCount: 0, measuredTaskCount: 0 };
  const projectExploration = { id: "other:project-exploration", name: "项目探索", moduleId: "", moduleName: "尚未登记正式项目", projectId: "other", projectName: "其他", treeId: "", worklineId: "", nodeKind: "project", usage: zeroUsage(), taskCount: 0, measuredTaskCount: 0 };
  const systemTests = { id: "other:system-test", name: "系统测试", moduleId: "", moduleName: "烟雾与系统探针", projectId: "other", projectName: "其他", treeId: "", worklineId: "", nodeKind: "project", usage: zeroUsage(), taskCount: 0, measuredTaskCount: 0 };
  for (const task of tasks) {
    const projectMatches = task.projectMatches || [];
    const isOtherOnly = projectMatches.length === 1 && projectMatches[0].projectId === "other";
    const isUnregisteredExploration = isProjectExplorationTask(task)
      && (!projectMatches.length || isOtherOnly);
    if (isSystemTestTask(task) || isUnregisteredExploration) {
      const destination = isSystemTestTask(task) ? systemTests : projectExploration;
      destination.taskCount += 1;
      if (task.totalUsage) {
        destination.measuredTaskCount += 1;
        addUsage(destination.usage, task.totalUsage);
      }
      continue;
    }
    if (!projectMatches.length || isOtherOnly) {
      const destination = unlinked;
      destination.taskCount += 1;
      if (task.totalUsage) {
        destination.measuredTaskCount += 1;
        addUsage(destination.usage, task.totalUsage);
      }
      continue;
    }
    for (const project of projectMatches) {
      const features = (task.featureMatches || []).filter((match) => match.projectId === project.projectId && byId.has(match.id));
      if (!features.length) {
        const phase = task.projectPhase === "setup" ? "setup" : "iteration";
        const unresolvedKey = `${project.projectId}:${phase}`;
        let destination = unresolvedByProject.get(unresolvedKey);
        if (!destination) {
          destination = {
            id: `project-unresolved:${project.projectId}:${phase}`,
            name: phase === "setup" ? "项目首次搭建" : "项目持续迭代",
            moduleId: "",
            moduleName: "项目本体",
            projectId: project.projectId,
            projectName: project.projectName,
            treeId: "",
            worklineId: "",
            nodeKind: "project",
            usage: zeroUsage(),
            taskCount: 0,
            measuredTaskCount: 0,
          };
          unresolvedByProject.set(unresolvedKey, destination);
        }
        destination.taskCount += 1;
        if (task.totalUsage) {
          destination.measuredTaskCount += 1;
          addScaledUsage(destination.usage, task.totalUsage, project.relevance / 100);
        }
        continue;
      }
      for (const match of features) {
        const destination = byId.get(match.id);
        destination.taskCount += 1;
        if (task.totalUsage) {
          destination.measuredTaskCount += 1;
          addScaledUsage(destination.usage, task.totalUsage, match.relevance / 100);
        }
      }
    }
  }
  const personalLifeItems = [...byId.values()].filter((item) => item.projectId === PERSONAL_LIFE_PROJECT_ID && item.taskCount > 0);
  const personalLifePlaceholder = { id: "personal-life:empty", name: "生活事务（待积累）", moduleId: "", moduleName: "生活事务", projectId: PERSONAL_LIFE_PROJECT_ID, projectName: "个人生活运营", treeId: "", worklineId: "", nodeKind: "project", usage: zeroUsage(), taskCount: 0, measuredTaskCount: 0 };
  return [...byId.values(), ...unresolvedByProject.values(), projectExploration, systemTests, unlinked, ...(personalLifeItems.length ? [] : [personalLifePlaceholder])]
    .filter((item) => item.taskCount > 0 || item.id === "personal-life:empty")
    .sort((left, right) => right.usage.totalTokens - left.usage.totalTokens || right.taskCount - left.taskCount);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function usageCacheRatio(usage) {
  return usage?.inputTokens ? usage.cachedInputTokens / usage.inputTokens : 0;
}

export function buildUsageAnomalies(tasks = []) {
  const history = new Map();
  const anomalies = [];
  const measured = tasks
    .filter((task) => task.kind === "codex" && numberOrZero(task.totalUsage?.totalTokens) > 0)
    .toSorted((left, right) => Date.parse(left.updatedAt || "") - Date.parse(right.updatedAt || ""));
  for (const task of measured) {
    const feature = task.featureMatches?.[0] || null;
    const project = task.projectMatches?.[0] || null;
    const scopes = feature
      ? [{ key: `feature:${feature.id}`, kind: "feature", name: `${feature.projectName} · ${feature.name}` }]
      : project
        ? [{ key: `project:${project.projectId}:${task.projectPhase || "iteration"}`, kind: "project", name: project.projectName }]
        : [];
    const scope = scopes.find((candidate) => (history.get(candidate.key) || []).length >= 4) || null;
    if (scope && task.projectPhase !== "setup") {
      const peers = history.get(scope.key);
      const historicalMedianTokens = median(peers.map((item) => item.totalTokens));
      const baselineTokens = Math.max(5_000_000, historicalMedianTokens);
      const baselineCacheRatio = median(peers.map((item) => item.cacheRatio));
      const totalTokens = numberOrZero(task.totalUsage.totalTokens);
      const multiple = baselineTokens ? totalTokens / baselineTokens : 0;
      const deltaTokens = Math.max(0, totalTokens - baselineTokens);
      if (multiple >= 3 && deltaTokens >= Math.max(5_000_000, baselineTokens * 0.5)) {
        const selfTokens = numberOrZero(task.selfUsage?.totalTokens);
        const childTokens = numberOrZero(task.childUsage?.totalTokens);
        const childShare = totalTokens ? childTokens / totalTokens : 0;
        const cacheRatio = usageCacheRatio(task.totalUsage);
        const cause = childShare >= 0.55 && task.childCount
          ? "child-chain"
          : baselineCacheRatio - cacheRatio >= 0.2
            ? "cache-drop"
            : selfTokens / totalTokens >= 0.8
              ? "self-task"
              : "mixed";
        anomalies.push({
          taskId: task.id,
          reference: task.reference,
          title: task.title,
          updatedAt: task.updatedAt,
          scopeKind: scope.kind,
          scopeName: scope.name,
          baselineSampleCount: peers.length,
          baselineTokens,
          baselineCacheRatio,
          totalTokens,
          deltaTokens,
          multiple,
          selfTokens,
          childTokens,
          childCount: task.childCount,
          cacheRatio,
          cause,
          severity: multiple >= 8 || deltaTokens >= 1_000_000_000 ? "high" : multiple >= 4.5 ? "elevated" : "watch",
        });
      }
    }
    for (const candidate of scopes) {
      const peers = history.get(candidate.key) || [];
      peers.push({ totalTokens: numberOrZero(task.totalUsage.totalTokens), cacheRatio: usageCacheRatio(task.totalUsage) });
      history.set(candidate.key, peers);
    }
  }
  return anomalies
    .toSorted((left, right) => right.multiple - left.multiple || right.deltaTokens - left.deltaTokens)
    .slice(0, 8);
}

const CLASSIFICATION_STOP_TERMS = new Set([
  "任务", "功能", "页面", "系统", "支持", "显示", "当前", "已经", "进行", "相关", "项目", "数据", "使用", "内容", "工作", "用户", "可以", "需要", "通过", "查看", "新增", "更新", "调整", "修复", "完成", "实现", "优化", "检查", "测试", "设计", "处理", "进入", "读取", "写入", "保持", "提供", "状态", "模块", "界面", "能力", "原件", "稳定", "本地", "自动", "管理", "记录", "归属", "wiki",
]);

function normalizedClassifierText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{Script=Han}a-z0-9._-]+/gu, " ").trim();
}

function classificationTerms(value) {
  const normalized = normalizedClassifierText(value);
  const terms = new Set((normalized.match(/[a-z][a-z0-9._-]{2,}/gu) || []).filter((term) => !CLASSIFICATION_STOP_TERMS.has(term)));
  for (const sequence of normalized.match(/[\p{Script=Han}]{4,}/gu) || []) {
    for (let size = 4; size <= Math.min(6, sequence.length); size += 1) {
      for (let index = 0; index <= sequence.length - size; index += 1) {
        const term = sequence.slice(index, index + size);
        if (!CLASSIFICATION_STOP_TERMS.has(term)) terms.add(term);
      }
    }
  }
  return terms;
}

function buildFeatureClassifier(catalog) {
  const documents = catalog.map((feature) => ({ feature, terms: classificationTerms(feature.classificationText) }));
  const frequencies = new Map();
  for (const document of documents) {
    for (const term of document.terms) frequencies.set(term, (frequencies.get(term) || 0) + 1);
  }
  return { documents, frequencies, total: Math.max(1, documents.length) };
}

function compactIdentity(value) {
  return normalizedClassifierText(value).replace(/[^\p{Script=Han}a-z0-9]+/gu, "");
}

function taskProjectIds(task, classifier) {
  const roots = classifier.documents.filter((document) => document.feature.nodeKind === "project").map((document) => document.feature);
  const ids = new Set((task.sourceProjectIds || []).filter((id) => roots.some((root) => root.projectId === id)));
  for (const cwd of task.classificationCwds || []) {
    const compactCwd = compactIdentity(cwd);
    for (const root of roots) {
      const idSignal = compactIdentity(root.projectId);
      const nameSignal = compactIdentity(root.projectName);
      if ((idSignal.length >= 5 && compactCwd.includes(idSignal)) || (nameSignal.length >= 3 && compactCwd.includes(nameSignal))) ids.add(root.projectId);
    }
    if (compactCwd.includes("infansvault")) ids.add("infans-ai-system");
  }
  return ids;
}

function allocation(candidates, total = 100) {
  if (!candidates.length) return [];
  const scoreTotal = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
  const values = scoreTotal
    ? candidates.map((candidate) => Math.max(1, Math.round(candidate.score / scoreTotal * total)))
    : candidates.map(() => Math.floor(total / candidates.length));
  values[0] += total - values.reduce((sum, value) => sum + value, 0);
  return values;
}

function exactFeatureSignal(compactText, feature) {
  const name = compactIdentity(feature.name);
  const featureId = compactIdentity(feature.id);
  return (name.length >= 4 && compactText.includes(name))
    || (featureId.length >= 5 && compactText.includes(featureId));
}

function semanticFeatureSignal(taskTerms, document, classifier) {
  let score = 0;
  let matches = 0;
  let rareMatches = 0;
  for (const term of document.terms) {
    if (!taskTerms.has(term)) continue;
    const frequency = classifier.frequencies.get(term) || classifier.total;
    if (frequency > Math.max(12, classifier.total * 0.08)) continue;
    matches += 1;
    if (frequency <= 3) rareMatches += 1;
    score += (1 + Math.log2((classifier.total + 1) / (frequency + 1))) * (term.length >= 5 ? 1.35 : 1);
  }
  if (matches < 2 || (!rareMatches && score < 10)) return null;
  return 80 + score;
}

const FEATURE_TITLE_RULES = [
  { featureId: "tools-agent-observability", pattern: /Token管理|智能体观测|cursor.{0,10}(标题|用量|账单)|token.{0,10}(账本|账册|观测|统计)/iu },
  { featureId: "tools-photo", pattern: /nas.{0,8}相册|相册.{0,12}(下载|全屏|预览)|照片库/iu },
  { featureId: "tools-music", pattern: /nas.{0,8}音乐|音乐.{0,12}(下载|播放)|b站音乐/iu },
  { featureId: "tools-art-library", pattern: /项目美术|美术库|素材.{0,8}(分类|预览)/iu },
  { featureId: "health-mind", pattern: /心理负荷|心理状态/iu },
  { featureId: "health-coach", pattern: /今日训练建议|训练.{0,8}(建议|记录)/iu },
  { featureId: "health-ai-observer", pattern: /身心观察|身心健康状态|精力状态|健康状态展示/iu },
  { featureId: "languages-exam", pattern: /jlpt|jltp|真题|考卷|三模式考官/iu },
  { featureId: "languages-grammar", pattern: /日语.{0,8}(语法|文法)|语法.{0,8}日语/iu },
  { featureId: "languages-course", pattern: /影子跟读|影随|日语课程|课件/iu },
  { featureId: "assistant-tts", pattern: /语音速度|语速|朗读|tts/iu },
  { featureId: "assistant-diary-mode", pattern: /日记模式|今天的日志|写.{0,4}日记/iu },
  { featureId: "schedule-all-project-todos", pattern: /全部待办|项目待办/iu },
  { featureId: "automation-daily-release", pattern: /版本收口|自动版本|升版本/iu },
  { featureId: "automation-ai-acceptance", pattern: /自动验收/iu },
  { featureId: "global-themes", pattern: /玄夜|晴岚|主题.{0,6}(色|模式|视觉|方案|切换|配色|样式)|字体.{0,8}(统一|复测)|排版.{0,8}统一/iu },
  { featureId: "assets-overview", pattern: /总资产|资产总览/iu },
  { featureId: "markets-brief", pattern: /当前简报|简报.{0,12}(排版|显示|小面|大面)/iu },
  { featureId: "library-anime-archive", pattern: /动漫.{0,8}(馆藏|收藏)|艺术馆藏.{0,8}动漫/iu },
  { featureId: "security-backup", pattern: /nas.{0,8}备份|应急备份|内容镜像/iu },
  { featureId: "data-read", pattern: /只读资料库|vault.{0,8}(读取|mcp)|资料库插件/iu },
];

function titleRuleFeatureIds(normalizedText) {
  return new Set(FEATURE_TITLE_RULES.filter((rule) => rule.pattern.test(normalizedText)).map((rule) => rule.featureId));
}

export function personalLifeFeatureId(normalizedText) {
  const productContext = /(?:代码|开发|修复|页面|组件|按钮|接口|api|css|react|typescript|脚本|构建|测试|部署|功能|产品|小秘书)/iu.test(normalizedText);
  if (productContext) return null;
  if (/(?:订|购买|抢|退|改).{0,5}(?:票|机票|车票|门票)|电影票|酒店|旅行|行程|旅游|一日攻略|去哪玩|出行路线/iu.test(normalizedText)) return "personal-life-travel";
  if (/买东西|购物|商品|比价|下单|退货|快递|配送|订购/iu.test(normalizedText)) return "personal-life-shopping";
  if (/预约|办手续|证件|签证|缴费|生活行政|申请.{0,8}(?:证|卡|服务)/iu.test(normalizedText)) return "personal-life-appointments";
  if (/电脑高温|网络故障|家电|设备.{0,6}(?:故障|设置|遥控)|遥控电脑/iu.test(normalizedText)) return "personal-life-devices";
  if (/餐厅|吃什么|周末.{0,5}(?:安排|活动)|生活方案|现实事务|账号归属/iu.test(normalizedText)) return "personal-life-general";
  return null;
}

function inferredProjectIds(normalizedText, roots) {
  const ids = new Set();
  if (/小秘书|梅凝|银月|infans|工作台|日语|jlpt|jltp|anki|影子跟读|身心|健康|训练|心理|日记|待办|简报|相册|nas|音乐|艺术馆藏|动漫|智能体|主题|字体|总资产|资产总览|vault|资料库|备份/iu.test(normalizedText)
    && roots.some((root) => root.projectId === "infans-ai-system")) ids.add("infans-ai-system");
  return ids;
}

function matchTaskAttribution(task, links, classifier) {
  const rawText = (task.classificationTexts || []).join(" ").slice(0, 80_000);
  const normalized = normalizedClassifierText(rawText);
  const normalizedTitle = normalizedClassifierText(task.sourceWindowTitle || task.classificationTexts?.[0] || "");
  const compactText = compactIdentity(rawText);
  const taskTerms = classificationTerms(rawText);
  const verified = new Set(Array.isArray(links[task.id]?.featureIds) ? links[task.id].featureIds : []);
  const roleBound = new Set(Array.isArray(task.sourceFeatureIds) ? task.sourceFeatureIds : []);
  const cwdProjects = taskProjectIds(task, classifier);
  const roots = classifier.documents.filter((document) => document.feature.nodeKind === "project").map((document) => document.feature);
  const specificDocuments = classifier.documents.filter((document) => document.feature.nodeKind === "feature");
  const titleRuleFeatureIdsMatched = titleRuleFeatureIds(normalizedTitle);
  const contextRuleFeatureIds = titleRuleFeatureIds(normalized);
  const directFeatures = specificDocuments.flatMap(({ feature }) => {
    const isVerified = verified.has(feature.id);
    const isRoleBound = roleBound.has(feature.id);
    const isExact = exactFeatureSignal(compactText, feature);
    const isTitleRule = titleRuleFeatureIdsMatched.has(feature.id);
    const isContextRule = contextRuleFeatureIds.has(feature.id);
    return isVerified || isRoleBound || isExact || isTitleRule || isContextRule ? [{
      feature,
      score: isVerified ? 360 : isRoleBound ? 340 : isTitleRule ? 270 : isContextRule ? 230 : 180 + Math.min(60, compactIdentity(feature.name).length * 4),
      basis: isVerified ? "verified" : isRoleBound ? "role" : "semantic",
    }] : [];
  });
  const existingProjectEvidence = directFeatures.some((candidate) => candidate.feature.projectId !== PERSONAL_LIFE_PROJECT_ID);
  if (existingProjectEvidence) {
    for (let index = directFeatures.length - 1; index >= 0; index -= 1) {
      if (directFeatures[index].feature.projectId === PERSONAL_LIFE_PROJECT_ID && directFeatures[index].basis !== "verified") directFeatures.splice(index, 1);
    }
  }
  const lifeFeatureId = existingProjectEvidence ? null : personalLifeFeatureId(normalized);
  if (lifeFeatureId && !directFeatures.some((candidate) => candidate.feature.id === lifeFeatureId)) {
    const feature = specificDocuments.find((document) => document.feature.id === lifeFeatureId)?.feature;
    if (feature) directFeatures.push({ feature, score: 250, basis: "semantic" });
  }
  const explicitProjectScores = new Map();
  for (const root of roots) {
    if (root.projectId === PERSONAL_LIFE_PROJECT_ID && existingProjectEvidence) continue;
    const projectName = normalizedClassifierText(root.projectName);
    if (projectName && normalized.includes(projectName)) explicitProjectScores.set(root.projectId, 240);
  }
  for (const candidate of directFeatures) {
    explicitProjectScores.set(candidate.feature.projectId, Math.max(explicitProjectScores.get(candidate.feature.projectId) || 0, candidate.score));
  }
  const inferredProjects = inferredProjectIds(normalized, roots);
  const projectCandidates = roots.flatMap((root) => {
    const explicitScore = explicitProjectScores.get(root.projectId);
    if (explicitProjectScores.size) return explicitScore ? [{ feature: root, score: explicitScore, basis: "explicit" }] : [];
    if (cwdProjects.has(root.projectId)) return [{ feature: root, score: 100, basis: "context" }];
    if (!cwdProjects.size && inferredProjects.has(root.projectId)) return [{ feature: root, score: 90, basis: "context" }];
    return [];
  }).sort((left, right) => right.score - left.score || left.feature.projectName.localeCompare(right.feature.projectName, "zh-CN"));
  const selectedProjects = projectCandidates.filter((candidate) => candidate.score >= projectCandidates[0]?.score * 0.7).slice(0, 3);
  const projectAllocation = allocation(selectedProjects);
  let projectMatches = selectedProjects.map((candidate, index) => ({
    projectId: candidate.feature.projectId,
    projectName: candidate.feature.projectName,
    relevance: projectAllocation[index],
    basis: candidate.basis,
  }));
  if (!projectMatches.length) {
    projectMatches = [{ projectId: "other", projectName: "其他", relevance: 100, basis: "context" }];
  }

  const featureMatches = [];
  for (const project of projectMatches) {
    const candidatesById = new Map(directFeatures
      .filter((candidate) => candidate.feature.projectId === project.projectId)
      .map((candidate) => [candidate.feature.id, candidate]));
    for (const document of classifier.documents) {
      if (document.feature.nodeKind !== "feature" || document.feature.projectId !== project.projectId || candidatesById.has(document.feature.id)) continue;
      const score = semanticFeatureSignal(taskTerms, document, classifier);
      if (score) candidatesById.set(document.feature.id, { feature: document.feature, score, basis: "semantic" });
    }
    const candidates = [...candidatesById.values()]
      .sort((left, right) => right.score - left.score || left.feature.name.localeCompare(right.feature.name, "zh-CN"));
    if (!candidates.length) continue;
    const selected = candidates.filter((candidate) => candidate.score >= candidates[0].score * 0.75).slice(0, 3);
    const relevance = allocation(selected, project.relevance);
    selected.forEach((candidate, index) => featureMatches.push({
      id: candidate.feature.id,
      name: candidate.feature.name,
      moduleId: candidate.feature.moduleId,
      moduleName: candidate.feature.moduleName,
      projectId: candidate.feature.projectId,
      projectName: candidate.feature.projectName,
      treeId: candidate.feature.treeId,
      worklineId: candidate.feature.worklineId,
      nodeKind: candidate.feature.nodeKind,
      relevance: relevance[index],
      projectRelevance: project.relevance,
      basis: candidate.basis,
    }));
  }
  return { projectMatches, featureMatches };
}

function taskReference(taskId) {
  const compact = String(taskId || "").replace(/[^a-z0-9]/giu, "").slice(-6).toUpperCase();
  return compact || "LOCAL";
}

function projectPhase(task) {
  const text = normalizedClassifierText((task.classificationTexts || []).join(" "));
  const hasFoundation = /首次|初次|从零|初版|第一版|第一期/iu.test(text);
  const hasBuild = /搭建|建立|创建|初始化|跑通|起步|启动/iu.test(text);
  const hasArtifact = /demo|原型|mvp|脚手架|项目/iu.test(text);
  return (hasFoundation && (hasBuild || hasArtifact)) || (hasBuild && hasArtifact) ? "setup" : "iteration";
}

function displayTaskTitle(task, projectMatches, featureMatches) {
  const windowTitle = cleanCodexTaskTitle(task.sourceWindowTitle);
  if (windowTitle) return windowTitle;
  const feature = featureMatches[0];
  if (feature) return `${feature.projectName} · ${feature.name}`;
  const project = projectMatches[0];
  if (project) return `${project.projectName}任务 · ${taskReference(task.id)}`;
  const agent = task.kind === "cursor" ? "Cursor" : task.kind === "external" ? "外部模型" : "Codex";
  return `${agent} 任务 · ${taskReference(task.id)}`;
}

function mergeTrend(days, nowMs, ...maps) {
  const result = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = dateKey(nowMs - index * DAY_MS);
    const usage = zeroUsage();
    for (const map of maps) addUsage(usage, map.get(day));
    result.push({ day, ...usage });
  }
  return result;
}

export async function readAgentObservability(root, options = {}) {
  const period = resolveObservabilityPeriod(options);
  const { cutoffMs, nowMs, trendDays, periodDays, periodHours } = period;
  await maybeSyncCursorAccount(root, options);
  const [codex, cursorRuns, codexScheduledRuns, external, cursorAccount, catalog, links] = await Promise.all([
    readCodex(options, cutoffMs),
    readCursorRuns(root, cutoffMs),
    readCodexScheduledRuns(root, options, cutoffMs),
    readExternalLedger(root, cutoffMs),
    readCursorAccountLedger(root, cutoffMs),
    featureCatalog(root),
    readLinks(root),
  ]);
  const conversationIds = (cursorAccount?.conversations || []).map((item) => item.conversationId).filter(Boolean);
  const conversationTitles = await resolveCursorConversationTitles(root, conversationIds);
  const conversationTasks = cursorConversationTasksFromAccount(cursorAccount, conversationTitles);
  const accountIsAuthority = Boolean(cursorAccount?.usage?.totalTokens);
  const cursorRunsForReport = cursorRuns.map((run) => ({
    ...run,
    countsTowardSourceTotal: !accountIsAuthority && Boolean(run.totalUsage),
    sourceWindowTitle: run.sourceWindowTitle || CURSOR_ROLE_TITLES[run.roleId] || null,
    usageMode: "this-run",
    hasChildren: false,
  }));
  const externalTask = external.details.map((detail) => ({
    id: `external:${detail.provider}:${detail.model}:${detail.taskWindowId}`,
    kind: "external",
    agent: "外部模型",
    model: detail.model,
    startedAt: detail.lastAt,
    updatedAt: detail.lastAt,
    selfUsage: detail.usage,
    childUsage: zeroUsage(),
    totalUsage: detail.usage,
    childCount: 0,
    hasChildren: false,
    usageMode: "this-run",
    countsTowardSourceTotal: true,
    actualCostUsd: detail.costUsd,
    sourceQuality: "provider-reported",
    sourceWindowTitle: "OpenRouter 语音聊天汇总",
    classificationTexts: ["小秘书 对话与问答 assistant-chat"],
    classificationEvidence: ["stable-surface"],
    classificationCwds: [],
    sourceProjectIds: ["infans-ai-system"],
    sourceFeatureIds: ["assistant-chat"],
  }));
  const classifier = buildFeatureClassifier(catalog);
  const tasks = [...codex.chains, ...cursorRunsForReport, ...conversationTasks, ...externalTask]
    .map((task) => {
      const { projectMatches, featureMatches } = matchTaskAttribution(task, links, classifier);
      const {
        sourceWindowTitle: _sourceWindowTitle,
        classificationTexts: _classificationTexts,
        classificationEvidence,
        classificationCwds: _classificationCwds,
        sourceProjectIds: _sourceProjectIds,
        sourceFeatureIds: _sourceFeatureIds,
        accountKind,
        conversationId,
        eventCount,
        actualChargedCents,
        countsTowardSourceTotal,
        usageMode,
        hasChildren,
        ...publicTask
      } = task;
      const confirmedPhase = links[task.id]?.projectPhase;
      const phase = projectMatches.some((project) => project.projectId !== "other") && !featureMatches.length
        ? (confirmedPhase === "setup" || confirmedPhase === "iteration" ? confirmedPhase : projectPhase(task))
        : null;
      return {
        ...publicTask,
        title: displayTaskTitle(task, projectMatches, featureMatches),
        reference: taskReference(task.id),
        projectPhase: phase,
        accountKind: accountKind || null,
        conversationId: conversationId || null,
        eventCount: eventCount || null,
        actualChargedCents: actualChargedCents ?? null,
        countsTowardSourceTotal: countsTowardSourceTotal !== false,
        usageMode: usageMode || (task.kind === "codex" ? "self-and-children" : "this-run"),
        hasChildren: Boolean(hasChildren ?? ((task.childCount || 0) > 0)),
        attributionEvidence: [...new Set([
          ...(classificationEvidence || []),
          ...projectMatches.map((match) => match.basis),
          ...featureMatches.map((match) => match.basis),
        ])],
        projectMatches,
        featureIds: featureMatches.map((match) => match.id),
        featureMatches,
      };
    })
    .sort((left, right) => (right.totalUsage?.totalTokens || 0) - (left.totalUsage?.totalTokens || 0) || Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
  const reportTasks = tasks.filter((task) => task.kind !== "external");
  // Never allow day/model account aggregates into the task report.
  const sanitizedReportTasks = reportTasks.filter((task) => !String(task.id).startsWith("cursor-account:"));
  const measuredRecentTasks = sanitizedReportTasks
    .filter((task) => task.totalUsage && task.countsTowardSourceTotal !== false)
    .toSorted((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "") || (right.totalUsage?.totalTokens || 0) - (left.totalUsage?.totalTokens || 0));
  const recentTasks = measuredRecentTasks.slice(0, 10);
  const recentTasksByAgent = {
    codex: measuredRecentTasks.filter((task) => task.kind === "codex").slice(0, 10),
    cursor: measuredRecentTasks.filter((task) => task.kind === "cursor").slice(0, 10),
  };
  const topTasks = sanitizedReportTasks.slice(0, 80);
  const extraMeasuredCursor = sanitizedReportTasks.filter((task) => task.kind === "cursor" && task.totalUsage && !topTasks.some((item) => item.id === task.id));
  const featureTasks = sanitizedReportTasks.filter((task) => task.countsTowardSourceTotal !== false);
  const cursorScheduleUsage = cursorRuns.reduce((usage, run) => addUsage(usage, run.totalUsage), zeroUsage());
  const measuredCursorRuns = cursorRuns.filter((run) => run.totalUsage);
  const unmeasuredCursorRuns = cursorRuns.length - measuredCursorRuns.length;
  const cursorAccountUsage = cursorAccount?.usage || null;
  const cursorAuthorityUsage = cursorAccountUsage || (measuredCursorRuns.length ? cursorScheduleUsage : null);
  const measuredUsage = addUsage(addUsage(addUsage(zeroUsage(), codex.usage), cursorAuthorityUsage), external.usage);
  const cursorCardUsage = cursorAuthorityUsage;
  const cursorCardCount = cursorAccountUsage ? cursorAccount.eventCount : cursorRuns.length;
  const cursorScheduleTrend = usageTrend(cursorRuns.filter((run) => run.totalUsage).map((run) => ({ at: run.updatedAt, usage: run.totalUsage })));
  const cursorAccountTrend = usageTrend((cursorAccount?.details || []).map((detail) => ({ at: detail.at, usage: detail.usage })));
  const cursorCardTrend = cursorAccountUsage ? cursorAccountTrend : cursorScheduleTrend;
  // All-sources trend uses the same authority rule as the summary: never add account + schedule.
  const combinedTrend = mergeTrend(trendDays, nowMs, codex.trend, external.trend, cursorCardTrend);
  const attributedCursorTokens = conversationTasks.reduce((sum, task) => sum + numberOrZero(task.totalUsage?.totalTokens), 0);
  const cursorSourceTokens = numberOrZero(cursorAuthorityUsage?.totalTokens);
  const cursorAttributionCoverage = cursorSourceTokens
    ? Math.max(0, Math.min(1, attributedCursorTokens / cursorSourceTokens))
    : null;
  const cursorNote = cursorAccountUsage
    ? "本机账户 Usage；不是订阅账单。"
    : measuredCursorRuns.length
      ? `账户暂缺，暂用 ${measuredCursorRuns.length} 个调度回传。`
      : "还没有账户 Usage；点刷新会自动同步。";
  // Reasoning tokens are summed across sources. A source that omits the field
  // adds nothing; it must not rewrite another source's complete number.
  const reasoningTokensStatus = (() => {
    const parts = [];
    if (codex.available) parts.push("complete");
    if (cursorAccountUsage) {
      const cursorStatus = cursorAccount?.reasoningTokensStatus || "unknown";
      parts.push(cursorStatus);
    } else if (measuredCursorRuns.length) {
      parts.push("unknown");
    }
    if (external.rows.length) {
      const known = external.rows.filter((row) => row.usage?.fieldStatus?.reasoningTokens === "known").length;
      parts.push(known === external.rows.length ? "complete" : known ? "partial" : "unknown");
    }
    if (!parts.length) return "unknown";
    if (parts.every((item) => item === "unknown")) return "unknown";
    if (parts.every((item) => item === "complete")) return "complete";
    return "partial";
  })();
  const taskChainCount = sanitizedReportTasks.filter((task) => task.kind === "codex" || (task.kind === "cursor" && !String(task.id).startsWith("cursor-account:"))).length;
  const snapshot = {
    updatedAt: new Date(nowMs).toISOString(),
    periodDays,
    periodHours,
    summary: {
      ...measuredUsage,
      cacheRatio: measuredUsage.inputTokens ? measuredUsage.cachedInputTokens / measuredUsage.inputTokens : 0,
      actualExternalCostUsd: external.costUsd,
      reasoningTokensStatus,
      taskChainCount,
      measuredTaskCount: sanitizedReportTasks.filter((task) => task.totalUsage && task.countsTowardSourceTotal !== false).length,
      cursorRunCount: cursorRuns.length,
      cursorMeasuredRunCount: measuredCursorRuns.length,
      cursorEventCount: cursorAccount?.eventCount || 0,
      cursorRawEventCount: cursorAccount?.rawEventCount || 0,
      cursorSuppressedDuplicateCount: cursorAccount?.suppressedDuplicateCount || 0,
      cursorAttributionCoverage,
      cursorAttributedTokens: attributedCursorTokens,
      cursorChargedCents: cursorAccount?.chargedCents ?? null,
      cursorListedCents: cursorAccount?.listedCents ?? null,
      cursorChargedCentsMeaning: cursorAccount?.chargedCentsMeaning || null,
    },
    agents: [
      { id: "codex", name: "Codex", sourceQuality: codex.available ? "local-count" : "unavailable", usage: codex.usage, taskCount: codex.chains.length, note: "本机会话 token_count 增量；不是订阅账单。" },
      {
        id: "cursor",
        name: "Cursor",
        sourceQuality: cursorAccountUsage ? "account-history" : measuredCursorRuns.length ? "cli-reported" : "runtime-only",
        usage: cursorCardUsage,
        taskCount: cursorCardCount,
        eventCount: cursorAccount?.eventCount || 0,
        runCount: cursorRuns.length,
        attributionCoverage: cursorAttributionCoverage,
        chargedCents: cursorAccount?.chargedCents ?? null,
        listedCents: cursorAccount?.listedCents ?? null,
        chargedCentsMeaning: cursorAccount?.chargedCentsMeaning || null,
        note: cursorNote,
      },
      { id: "external", name: "外部模型", sourceQuality: external.rows.length ? "provider-reported" : "empty", usage: external.rows.length ? external.usage : null, taskCount: external.rows.length, actualCostUsd: external.costUsd, note: "从本次接入后记录 OpenRouter 返回的数值用量与实际成本。" },
    ],
    cursorAccount: {
      ...cursorAccount,
      attributionCoverage: cursorAttributionCoverage,
      attributedTokens: attributedCursorTokens,
      attributedConversationCount: conversationTasks.length,
    },
    trend: combinedTrend,
    agentTrends: {
      all: combinedTrend,
      codex: mergeTrend(trendDays, nowMs, codex.trend),
      cursor: mergeTrend(trendDays, nowMs, cursorCardTrend),
      external: mergeTrend(trendDays, nowMs, external.trend),
    },
    anomalies: buildUsageAnomalies(featureTasks),
    externalDetails: external.details,
    externalAccount: {
      scope: "current-key",
      usageUsd: null,
      attributedCostUsd: external.lifetimeCostUsd,
      unattributedCostUsd: null,
      coverageRatio: 0,
      requestCount: external.lifetimeRequestCount,
      checkedAt: null,
      available: false,
      note: "等待读取 OpenRouter 当前密钥累计。",
    },
    recentTasks,
    recentTasksByAgent,
    tasks: [...topTasks, ...extraMeasuredCursor],
    features: featureLedger(featureTasks, catalog),
    scheduledRuns: scheduledRunsLedger([...cursorRuns, ...codexScheduledRuns]),
    featureCatalog: catalog.map(({ classificationText: _classificationText, ...feature }) => feature),
    codex: { contextWindow: codex.contextWindow, rateLimit: codex.rateLimit, unattributedInternalUsage: codex.unattributedInternalUsage || zeroUsage(), unattributedInternalCount: codex.unattributedInternalCount || 0 },
    notes: [
      "Codex 内部审批与子任务按明确父任务关系归入根任务；缺失父任务或未知内部来源只保留来源用量，不进入任务、功能归属或异常比较。标题仅取首行短名称，审批正文不进入派生缓存。",
      "可测量总量 = Codex 权威用量 + Cursor 权威用量 + OpenRouter 接入后实账；与三张来源卡之和、全部来源每日曲线之和同一公式，只允许四舍五入误差。",
      "Cursor 权威来源优先用账户 Usage；只有账户整期不可用时，才整期退到 CLI 回传。不按缺失时段拼接，账户与 CLI 不直接相加。",
      "Cursor 按日／模型聚合只留在来源明细，不进入任务战报，也不把事件数写成子任务或任务链。",
      "只有稳定 conversationId 且能从本机原件读到窗口标题的账户对话，或稳定 runId + 岗位名的调度批次，才进入任务战报；不得用模型名或日期伪造标题。",
      "没有真实父子关系的 Cursor 行只显示「本次用量」，不套「自身 + 子任务」，也不写 0 个子任务。",
      "Cursor 任务归属覆盖率 = 已映射到真实窗口的账户 Token / Cursor 来源总 Token；覆盖率低不否定来源总量，只说明任务战报尚未解释全部消耗。",
      "总 Token = 输入 + 输出；缓存读／写是输入子项，缓存命中率 = 缓存读 / 输入；推理是输出子项，不重复加总。",
      "Cursor 的 chargedCents 只是供应商计价字段，事件多为套餐内且无币种／发票证据；页面不得写成实付，只能标「账户计价（未核实）」或隐藏。",
      "推理 Token 按来源加总：Codex、Cursor、外部各报各的，不是互斥覆盖。某来源整段未提供时跳过该来源，不加 0，也不用「已知」去改写其他来源已经完整给出的数；只有同一来源内有的事件有、有的没有时，才把全局标成已知部分。",
      "旧 CSV 与本机会话账是同一来源的两种采集：稳定事件 ID 优先；无共同 ID 时只允许不同采集器间按时间／模型／Token 一对一消重，同采集器的两笔真实调用不得合并。原始行保留。",
      "所有切日按 Asia/Tokyo；24 小时窗口按滚动小时，3／7／30／90 天按东京日历日。账户生命周期累计费用必须标成账户累计，不能伪装成当前周期费用。",
      "缓存 Token 是输入组成部分，推理 Token 是输出组成部分，均不重复加到总数。",
      "项目归属优先明确项目名，其次工作目录与项目 ID；功能归属使用稳定角色、完整功能名、稳定 ID、首条需求与摘要。",
      "未归属项目、尚未登记的项目探索与系统测试统一收进末尾的「其他」；保留内部账项区分，不干扰正式项目排序。",
      "定时值班单独成卡，覆盖 Cursor 岗位与 Codex heartbeat 的真实回合，列出岗位、执行器、触发来源、实际模型、状态和 Token；缺字段显示未提供，不补零。这张卡只分组，不另造 Token。",
      "个人生活运营是账本虚拟项目，默认排第一；新旧任务只按标题、工作区、稳定项目 ID、已有链接与任务摘要做保守归类，明确健康、学习、游戏与小秘书项目优先，看不准就留未归属。",
      "近期任务可筛选全部、Codex 或 Cursor；三个视图分别按窗口更新时间取各自最近 10 个已入账项，不预留或互相挤占名额。条长只在当前视图的 10 项之间比较；列表视口默认约显示 5 项，其余在框内滚动查看；随进入、切换周期或手动刷新更新，不做高频强制扫描。",
      "异常膨胀以同功能至少 4 个更早任务的中位数为基线；没有功能归属时才按同项目同阶段比较。",
    ],
  };
  Object.defineProperty(snapshot, ATTRIBUTION_INDEX_TASKS, { value: featureTasks, enumerable: false });
  Object.defineProperty(snapshot, INTERNAL_CODEX_IDS, { value: codex.internalIds || new Set(), enumerable: false });
  return snapshot;
}

async function readSnapshotCache(root) {
  const cache = await readJson(path.join(root, SNAPSHOT_CACHE_PATH), { schemaVersion: SNAPSHOT_CACHE_SCHEMA, snapshots: {} });
  return cache?.schemaVersion === SNAPSHOT_CACHE_SCHEMA ? cache : { schemaVersion: SNAPSHOT_CACHE_SCHEMA, snapshots: {} };
}

const snapshotWrites = new Map();
const attributionWrites = new Map();
const snapshotRefreshAttempts = new Map();

async function mutateSnapshotCache(root, update) {
  const key = path.resolve(root);
  const previous = snapshotWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const filePath = path.join(root, SNAPSHOT_CACHE_PATH);
    const cache = await readSnapshotCache(root);
    update(cache);
    cache.schemaVersion = SNAPSHOT_CACHE_SCHEMA;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  });
  snapshotWrites.set(key, pending);
  try { await pending; } finally { if (snapshotWrites.get(key) === pending) snapshotWrites.delete(key); }
}

async function writeSnapshotCache(root, days, snapshot) {
  await mutateSnapshotCache(root, (cache) => {
    cache.updatedAt = new Date().toISOString();
    cache.snapshots ||= {};
    cache.snapshots[String(days)] = snapshot;
  });
}

async function invalidateSnapshotCache(root) {
  await mutateSnapshotCache(root, (cache) => { cache.invalidatedAt = new Date().toISOString(); });
}

async function writeAttributionIndex(root, tasks, internalIds = new Set()) {
  const key = path.resolve(root);
  const previous = attributionWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => writeAttributionIndexNow(root, tasks, internalIds));
  attributionWrites.set(key, pending);
  try { await pending; } finally { if (attributionWrites.get(key) === pending) attributionWrites.delete(key); }
}

async function writeAttributionIndexNow(root, tasks, internalIds) {
  const filePath = path.join(root, ATTRIBUTION_INDEX_PATH);
  const current = await readJson(filePath, { schemaVersion: 1, tasks: {} });
  const entries = current && typeof current.tasks === "object" && !Array.isArray(current.tasks) ? current.tasks : {};
  for (const [id, task] of Object.entries(entries)) {
    if (task?.kind === "codex" && (internalIds.has(id) || isInternalCodexTask(task))) delete entries[id];
    else if (task) task.title = cleanCodexTaskTitle(task.title);
  }
  for (const task of tasks) {
    entries[task.id] = {
      kind: task.kind,
      agent: task.agent,
      title: task.title,
      reference: task.reference,
      projectPhase: task.projectPhase,
      sourceUpdatedAt: task.updatedAt,
      indexedAt: new Date().toISOString(),
      attributionEvidence: task.attributionEvidence || [],
      projectMatches: task.projectMatches || [],
      featureMatches: (task.featureMatches || []).map(({ id, name, moduleId, moduleName, projectId, projectName, relevance, projectRelevance, basis }) => ({
        id,
        name,
        moduleId,
        moduleName,
        projectId,
        projectName,
        relevance,
        projectRelevance,
        basis,
      })),
    };
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), tasks: entries })}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

async function applyVerifiedAttributionToIndex(root, taskId, featureIds, projectPhase, catalog) {
  const key = path.resolve(root);
  const previous = attributionWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const filePath = path.join(root, ATTRIBUTION_INDEX_PATH);
    const current = await readJson(filePath, { schemaVersion: 1, tasks: {} });
    const entries = current && typeof current.tasks === "object" && !Array.isArray(current.tasks) ? current.tasks : {};
    const task = entries[taskId];
    if (!task) return;
    if (projectPhase) task.projectPhase = projectPhase;
    if (featureIds.length) {
      const byId = new Map(catalog.filter((item) => item.nodeKind === "feature").map((item) => [item.id, item]));
      const features = featureIds.map((id) => byId.get(id)).filter(Boolean);
      const projectIds = [...new Set(features.map((feature) => feature.projectId))];
      const projectShares = allocation(projectIds.map((projectId) => ({ score: features.filter((feature) => feature.projectId === projectId).length })), 100);
      const projectRelevance = new Map(projectIds.map((projectId, index) => [projectId, projectShares[index]]));
      task.projectMatches = projectIds.map((projectId, index) => {
        const feature = features.find((item) => item.projectId === projectId);
        return { projectId, projectName: feature.projectName, relevance: projectShares[index], basis: "verified" };
      });
      task.featureMatches = features.map((feature) => {
        const siblings = features.filter((item) => item.projectId === feature.projectId);
        const siblingIndex = siblings.findIndex((item) => item.id === feature.id);
        const shares = allocation(siblings.map(() => ({ score: 1 })), projectRelevance.get(feature.projectId));
        return {
          id: feature.id,
          name: feature.name,
          moduleId: feature.moduleId,
          moduleName: feature.moduleName,
          projectId: feature.projectId,
          projectName: feature.projectName,
          relevance: shares[siblingIndex],
          projectRelevance: projectRelevance.get(feature.projectId),
          basis: "verified",
        };
      });
      task.attributionEvidence = [...new Set([...(task.attributionEvidence || []), "verified"])];
      task.indexedAt = new Date().toISOString();
    } else {
      // A cleared verified link must disappear from Wiki immediately. The next
      // observability refresh can rebuild any conservative semantic match.
      delete entries[taskId];
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), tasks: entries })}\n`, { mode: 0o600 });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  });
  attributionWrites.set(key, pending);
  try { await pending; } finally { if (attributionWrites.get(key) === pending) attributionWrites.delete(key); }
}

async function refreshSnapshot(root, options) {
  const period = resolveObservabilityPeriod(options);
  const key = `${path.resolve(root)}:${period.cacheKey}`;
  if (snapshotRefreshes.has(key)) return snapshotRefreshes.get(key);
  snapshotRefreshAttempts.set(key, Date.now());
  const pending = Promise.all([
    readAgentObservability(root, { ...options, days: period.days, hours: period.hours }),
    options.readExternalStatus ? Promise.resolve().then(() => options.readExternalStatus()).catch(() => null) : null,
  ])
    .then(async ([raw, status]) => {
      const previous = status?.usageUsd == null ? (await readSnapshotCache(root))?.snapshots?.[period.cacheKey]?.externalAccount : null;
      const accountStatus = status?.usageUsd != null ? status : previous?.usageUsd != null ? previous : status;
      const snapshot = accountStatus ? reconcileExternalAccount(raw, accountStatus) : raw;
      await Promise.all([
        writeSnapshotCache(root, period.cacheKey, snapshot),
        writeAttributionIndex(root, raw[ATTRIBUTION_INDEX_TASKS] || raw.tasks, raw[INTERNAL_CODEX_IDS]),
      ]);
      return { ...snapshot, cacheStatus: "fresh" };
    })
    .finally(() => snapshotRefreshes.delete(key));
  snapshotRefreshes.set(key, pending);
  return pending;
}

export async function readAgentObservabilityCached(root, options = {}) {
  const period = resolveObservabilityPeriod(options);
  const refreshOptions = { ...options, days: period.days, hours: period.hours };
  if (options.force || options.nowMs) return refreshSnapshot(root, refreshOptions);
  const cache = await readSnapshotCache(root);
  const snapshot = cache?.snapshots?.[period.cacheKey] || null;
  if (!snapshot) return refreshSnapshot(root, refreshOptions);
  const key = `${path.resolve(root)}:${period.cacheKey}`;
  const ageMs = Math.max(0, Date.now() - Date.parse(snapshot.updatedAt || ""));
  const invalidated = Date.parse(cache.invalidatedAt || "") >= Date.parse(snapshot.updatedAt || "");
  const mayRetry = Date.now() - (snapshotRefreshAttempts.get(key) || 0) > 60_000;
  if (mayRetry && (!Number.isFinite(ageMs) || ageMs > SNAPSHOT_CACHE_MAX_AGE_MS || invalidated)) {
    void refreshSnapshot(root, refreshOptions).catch(() => undefined);
  }
  return { ...snapshot, cacheStatus: snapshotRefreshes.has(key) ? "refreshing" : "cached" };
}

export async function writeAgentObservabilityLink(root, input = {}) {
  const taskId = String(input.taskId || "").trim();
  if (!/^[a-z0-9][a-z0-9:._+-]{0,159}$/iu.test(taskId)) throw new Error("TASK_LINK_ID_INVALID");
  const catalog = await featureCatalog(root);
  const allowed = new Set(catalog.map((feature) => feature.id));
  const filePath = path.join(root, LINKS_PATH);
  const links = await readLinks(root);
  const current = links[taskId] && typeof links[taskId] === "object" ? links[taskId] : {};
  const hasFeatureIds = Array.isArray(input.featureIds);
  const featureIds = [...new Set((hasFeatureIds ? input.featureIds : current.featureIds || []).map((item) => String(item).trim()).filter(Boolean))];
  if (featureIds.length > 8 || featureIds.some((id) => !allowed.has(id))) throw new Error("TASK_LINK_FEATURE_INVALID");
  const hasProjectPhase = Object.prototype.hasOwnProperty.call(input, "projectPhase");
  const projectPhase = hasProjectPhase ? input.projectPhase : current.projectPhase;
  if (projectPhase !== undefined && projectPhase !== null && projectPhase !== "setup" && projectPhase !== "iteration") throw new Error("TASK_LINK_PHASE_INVALID");
  if (featureIds.length || projectPhase) links[taskId] = { featureIds, ...(projectPhase ? { projectPhase } : {}), updatedAt: new Date().toISOString() };
  else delete links[taskId];
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), links }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
  await applyVerifiedAttributionToIndex(root, taskId, featureIds, projectPhase, catalog);
  await invalidateSnapshotCache(root);
  return { ok: true, taskId, featureIds, projectPhase: projectPhase || null };
}

export async function appendExternalAgentUsage(root, input = {}) {
  const normalized = normalizeExternalUsage(input.usage);
  if (!normalized.totalTokens && !normalized.costUsd) return { recorded: false };
  const filePath = path.join(root, EXTERNAL_LEDGER_PATH);
  const row = {
    schemaVersion: 2,
    at: String(input.at || new Date().toISOString()),
    eventId: String(input.eventId || (input.generationId ? `${input.provider || "external"}:${input.generationId}` : randomUUID())).slice(0, 180),
    generationId: String(input.generationId || "").slice(0, 160) || null,
    provider: String(input.provider || "external").slice(0, 48),
    upstreamProvider: String(input.upstreamProvider || "").slice(0, 80) || null,
    model: String(input.model || "unknown").slice(0, 128),
    surface: String(input.surface || "unknown").slice(0, 64),
    phase: String(input.phase || "ordinary").slice(0, 32),
    taskWindowKind: String(input.taskWindowKind || "secretary-chat").slice(0, 48),
    taskWindowId: String(input.taskWindowId || `external:${input.surface || "unknown"}`).slice(0, 160),
    usage: {
      inputTokens: normalized.inputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      outputTokens: normalized.outputTokens,
      reasoningTokens: normalized.reasoningTokens,
      totalTokens: normalized.totalTokens,
      fieldStatus: normalized.fieldStatus,
    },
    costUsd: normalized.costUsd,
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  await invalidateSnapshotCache(root);
  return { recorded: true };
}
