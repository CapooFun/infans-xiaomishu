import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { GAME_ANALYTICS_DERIVED } from "./vault-paths.mjs";

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 1;
const MAX_BATCH_EVENTS = 24;
const MAX_STORED_EVENTS = 50_000;
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GAME_IDS = new Set(["example-game"]);
const ENVIRONMENTS = new Set(["development", "production"]);
export const GAME_ANALYTICS_KEYCHAIN_SERVICE = "Infans Game Analytics";
export const GAME_ANALYTICS_KEYCHAIN_ACCOUNT = "Infans";
export const GAME_ANALYTICS_REMOTE_SUMMARY_URL = "";
const REMOTE_TIMEOUT_MS = 6_000;
const REMOTE_CACHE_MS = 30_000;
const EVENTS = new Set([
  "page_view",
  "play_start",
  "play_5m",
  "play_15m",
  "session_end",
  "steam_click",
  "run_start",
  "run_end",
  "death",
  "reincarnate",
]);

const PROPERTY_RULES = Object.freeze({
  page_view: {},
  play_start: {},
  play_5m: {},
  play_15m: {},
  session_end: { duration_seconds: "number" },
  steam_click: { placement: "string" },
  run_start: { tier: "string" },
  run_end: { tier: "string", outcome: "string", steps: "number", floor: "number" },
  death: { reason: "string", realm_level: "number" },
  reincarnate: { death_count: "number" },
});

let writeTail = Promise.resolve();
const officialSummaryCache = new Map();

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: null, events: [] };
}

function clampText(value, max = 80) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizedProperties(eventName, raw) {
  const rules = PROPERTY_RULES[eventName] ?? {};
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const result = {};
  for (const [key, kind] of Object.entries(rules)) {
    const value = source[key];
    if (kind === "string" && typeof value === "string") result[key] = clampText(value);
    if (kind === "number" && Number.isFinite(value)) result[key] = Math.max(0, Math.round(Number(value) * 100) / 100);
  }
  return result;
}

export function normalizeGameAnalyticsEvent(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkbenchWriteError("事件格式不正确", 400, "INVALID_EVENT");
  }
  if (Number(raw.schema_version) !== SCHEMA_VERSION) {
    throw new WorkbenchWriteError("事件版本不受支持", 400, "INVALID_SCHEMA_VERSION");
  }
  const eventId = clampText(raw.event_id, 64);
  const sessionId = clampText(raw.session_id, 64);
  const gameId = clampText(raw.game_id, 48);
  const version = clampText(raw.version, 32);
  const channel = clampText(raw.channel, 40);
  const environment = clampText(raw.environment, 20);
  const event = clampText(raw.event, 40);
  const occurredMs = Date.parse(String(raw.occurred_at || ""));
  if (!UUID_PATTERN.test(eventId) || !UUID_PATTERN.test(sessionId)) {
    throw new WorkbenchWriteError("事件标识不正确", 400, "INVALID_EVENT_ID");
  }
  if (!GAME_IDS.has(gameId)) throw new WorkbenchWriteError("游戏未登记", 400, "UNKNOWN_GAME");
  if (!version || !channel) throw new WorkbenchWriteError("事件缺少版本或渠道", 400, "MISSING_EVENT_CONTEXT");
  if (!ENVIRONMENTS.has(environment)) throw new WorkbenchWriteError("环境不正确", 400, "INVALID_ENVIRONMENT");
  if (!EVENTS.has(event)) throw new WorkbenchWriteError("事件不在白名单", 400, "UNKNOWN_EVENT");
  if (!Number.isFinite(occurredMs) || occurredMs < now - MAX_AGE_MS || occurredMs > now + MAX_FUTURE_SKEW_MS) {
    throw new WorkbenchWriteError("事件时间不在允许范围", 400, "INVALID_EVENT_TIME");
  }
  return {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    session_id: sessionId,
    game_id: gameId,
    version,
    channel,
    environment,
    event,
    occurred_at: new Date(occurredMs).toISOString(),
    properties: normalizedProperties(event, raw.properties),
  };
}

export function isLocalGameAnalyticsOrigin(request) {
  const host = String(request.headers.host || "");
  if (!/^127\.0\.0\.1:\d{2,5}$/.test(host)) return false;
  try {
    const origin = new URL(String(request.headers.origin || ""));
    return origin.protocol === "http:"
      && (origin.hostname === "127.0.0.1" || origin.hostname === "localhost")
      && /^\d{2,5}$/.test(origin.port);
  } catch {
    return false;
  }
}

export function writeGameAnalyticsCors(request, response) {
  if (!isLocalGameAnalyticsOrigin(request)) return;
  response.setHeader("Access-Control-Allow-Origin", String(request.headers.origin));
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function assertLocalGameAnalyticsWrite(request) {
  if (!isLocalGameAnalyticsOrigin(request)) {
    throw new WorkbenchWriteError("本机统计只接受本地开发版游戏", 403, "ORIGIN_REJECTED");
  }
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new WorkbenchWriteError("请求必须使用 JSON", 415, "CONTENT_TYPE_REQUIRED");
  }
}

export function gameAnalyticsPath(vaultRoot) {
  return path.resolve(vaultRoot, GAME_ANALYTICS_DERIVED);
}

async function readStore(vaultRoot) {
  try {
    const parsed = JSON.parse(await fs.readFile(gameAnalyticsPath(vaultRoot), "utf8"));
    if (Number(parsed?.schemaVersion) !== SCHEMA_VERSION || !Array.isArray(parsed?.events)) return emptyStore();
    return { schemaVersion: SCHEMA_VERSION, updatedAt: parsed.updatedAt || null, events: parsed.events };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(vaultRoot, store) {
  const target = gameAnalyticsPath(vaultRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.infans-tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
}

export async function appendGameAnalyticsEvents(vaultRoot, payload, now = Date.now()) {
  const incoming = Array.isArray(payload?.events) ? payload.events : [];
  if (!incoming.length || incoming.length > MAX_BATCH_EVENTS) {
    throw new WorkbenchWriteError(`每批必须包含 1–${MAX_BATCH_EVENTS} 条事件`, 400, "INVALID_BATCH_SIZE");
  }
  const normalized = incoming.map((event) => normalizeGameAnalyticsEvent(event, now));
  const task = writeTail.then(async () => {
    const store = await readStore(vaultRoot);
    const cutoff = now - MAX_AGE_MS;
    const retained = store.events.filter((event) => Date.parse(event.occurred_at) >= cutoff);
    const known = new Set(retained.map((event) => event.event_id));
    const accepted = normalized.filter((event) => !known.has(event.event_id));
    const events = [...retained, ...accepted].slice(-MAX_STORED_EVENTS);
    const updatedAt = new Date(now).toISOString();
    await writeStore(vaultRoot, { schemaVersion: SCHEMA_VERSION, updatedAt, events });
    return { accepted: accepted.length, duplicated: normalized.length - accepted.length };
  });
  writeTail = task.catch(() => undefined);
  return task;
}

function uniqueSessions(events, eventName) {
  return new Set(events.filter((row) => row.event === eventName).map((row) => row.session_id)).size;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function countEvents(events, eventName) {
  return events.reduce((sum, row) => sum + (row.event === eventName ? 1 : 0), 0);
}

function breakdown(events, field) {
  const counts = new Map();
  for (const event of events) counts.set(event[field], (counts.get(event[field]) || 0) + 1);
  return [...counts.entries()]
    .map(([label, eventCount]) => ({ label, eventCount }))
    .sort((a, b) => b.eventCount - a.eventCount || a.label.localeCompare(b.label));
}

export async function readGameAnalyticsSummary(vaultRoot, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const requestedDays = Number(options.days);
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  const environment = ENVIRONMENTS.has(options.environment) ? options.environment : "production";
  const gameId = GAME_IDS.has(options.gameId) ? options.gameId : "example-game";
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const store = await readStore(vaultRoot);
  const events = store.events.filter((row) => row.game_id === gameId
    && row.environment === environment
    && Date.parse(row.occurred_at) >= cutoff
    && Date.parse(row.occurred_at) <= now + MAX_FUTURE_SKEW_MS);
  const pageViews = uniqueSessions(events, "page_view");
  const playStarts = uniqueSessions(events, "play_start");
  const play5m = uniqueSessions(events, "play_5m");
  const play15m = uniqueSessions(events, "play_15m");
  const runStarts = countEvents(events, "run_start");
  const runEnds = countEvents(events, "run_end");
  const latest = events.reduce((value, row) => value > row.occurred_at ? value : row.occurred_at, "");
  return {
    schemaVersion: SCHEMA_VERSION,
    game: { id: gameId, name: "示例游戏", productLine: "示例网页体验" },
    environment,
    days,
    observedAt: new Date(now).toISOString(),
    dataUpdatedAt: latest || null,
    eventCount: events.length,
    metrics: {
      pageViews,
      playStarts,
      playStartRate: ratio(playStarts, pageViews),
      play5m,
      play5mRate: ratio(play5m, playStarts),
      play15m,
      play15mRate: ratio(play15m, playStarts),
      sessionEnds: countEvents(events, "session_end"),
      runStarts,
      runEnds,
      runEndRate: ratio(runEnds, runStarts),
      deaths: countEvents(events, "death"),
      reincarnations: countEvents(events, "reincarnate"),
      steamClicks: countEvents(events, "steam_click"),
    },
    versions: breakdown(events, "version"),
    channels: breakdown(events, "channel"),
    income: { connected: false, advertising: null, steamSales: null, other: null },
    boundary: environment === "production"
      ? "正式官网尚未接入新收集端；这里不会显示本地测试事件。"
      : "当前显示本机开发事件，只用于接线验收，不代表官网玩家表现。",
  };
}

export async function readGameAnalyticsPrivateToken({ execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl("/usr/bin/security", [
      "find-generic-password",
      "-a", GAME_ANALYTICS_KEYCHAIN_ACCOUNT,
      "-s", GAME_ANALYTICS_KEYCHAIN_SERVICE,
      "-w",
    ], { timeout: 5000 });
    const token = String(stdout || "").trim();
    if (!token) throw new Error("empty token");
    return token;
  } catch {
    throw new WorkbenchWriteError("还没有配置游戏经营数据读取密钥。", 503, "GAME_ANALYTICS_TOKEN_REQUIRED");
  }
}

function assertOfficialSummary(payload, { days, gameId }) {
  const valid = payload
    && typeof payload === "object"
    && Number(payload.schemaVersion) === SCHEMA_VERSION
    && payload.environment === "production"
    && Number(payload.days) === days
    && payload.game?.id === gameId
    && Number.isFinite(Number(payload.eventCount))
    && payload.metrics && typeof payload.metrics === "object"
    && Array.isArray(payload.versions)
    && Array.isArray(payload.channels)
    && payload.income && typeof payload.income === "object";
  if (!valid) {
    throw new WorkbenchWriteError("远端经营数据格式不正确。", 502, "GAME_ANALYTICS_INVALID_RESPONSE");
  }
  return payload;
}

export function resetOfficialGameAnalyticsCacheForTests() {
  officialSummaryCache.clear();
}

export async function readOfficialGameAnalyticsSummary(options = {}) {
  const requestedDays = Number(options.days);
  const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
  const gameId = GAME_IDS.has(options.gameId) ? options.gameId : "example-game";
  const cacheKey = `${gameId}:${days}`;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const useCache = !options.fetchImpl && !options.token && !options.execFileImpl;
  const cached = officialSummaryCache.get(cacheKey);
  if (!options.force && useCache && cached && now - cached.checkedAt < REMOTE_CACHE_MS) return cached.value;

  const token = options.token || await readGameAnalyticsPrivateToken(options);
  const endpoint = options.endpoint || GAME_ANALYTICS_REMOTE_SUMMARY_URL;
  if (!endpoint) {
    throw new WorkbenchWriteError("游戏数据服务尚未配置。", 503, "GAME_ANALYTICS_UNCONFIGURED");
  }
  const url = new URL(endpoint);
  url.searchParams.set("game_id", gameId);
  url.searchParams.set("days", String(days));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), REMOTE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new WorkbenchWriteError("游戏经营数据读取密钥已失效。", 503, "GAME_ANALYTICS_AUTH_FAILED");
    }
    if (!response.ok) {
      throw new WorkbenchWriteError("正式经营数据服务暂时不可用。", 502, "GAME_ANALYTICS_UPSTREAM_FAILED");
    }
    const value = assertOfficialSummary(await response.json(), { days, gameId });
    if (useCache) officialSummaryCache.set(cacheKey, { checkedAt: now, value });
    return value;
  } catch (error) {
    if (error instanceof WorkbenchWriteError) throw error;
    throw new WorkbenchWriteError("暂时无法连接正式经营数据服务。", 502, "GAME_ANALYTICS_NETWORK_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}
