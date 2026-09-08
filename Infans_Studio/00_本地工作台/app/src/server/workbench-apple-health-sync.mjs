import crypto from "node:crypto";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { normalizeAppleHealthData, readAppleHealthData, writeAppleHealthSnapshot } from "./workbench-apple-health.mjs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_TRIGGERS = new Set(["background-refresh", "healthkit-observer", "app-launch", "manual"]);
const DAILY_LIMITS = {
  steps: [0, 200_000],
  activeEnergy: [0, 20_000],
  exerciseMinutes: [0, 1_440],
  standMinutes: [0, 1_440],
  restingHeartRate: [20, 250],
  sleepMinutes: [0, 1_800],
  asleepMinutes: [0, 1_800],
};
const BODY_LIMITS = {
  weightKg: [20, 400, "kg"],
  waistCm: [20, 300, "cm"],
  bodyFatPercent: [1, 80, "%"],
};
const WORKOUT_TYPES = new Set([
  "步行", "跑步", "骑行", "徒步", "传统力量训练", "功能性力量训练",
  "核心训练", "瑜伽", "整理放松", "游泳", "其他训练",
]);

function fail(message, code = "HEALTH_SYNC_INVALID") {
  throw new WorkbenchWriteError(message, 400, code);
}

function finite(value, label, min, max, optional = false) {
  if (value == null && optional) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) fail(`${label}超出允许范围`);
  return Math.round(number * 10) / 10;
}

function short(value, label, max = 160) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\r\n]/.test(text)) fail(`${label}不合法`);
  return text;
}

function validDate(value, label) {
  const day = String(value || "");
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00+09:00`))) fail(`${label}不是有效日期`);
  return day;
}

function within(day, start, end, label) {
  if (day < start || day > end) fail(`${label}不在同步时间窗内`);
}

function normalizeSources(value = {}) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const metric of Object.keys(DAILY_LIMITS)) {
    if (value[metric]) result[metric] = short(value[metric], `${metric} 来源`);
  }
  return result;
}

function normalizeDaily(row, start, end) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("日摘要格式不对");
  const date = validDate(row.date, "日摘要日期");
  within(date, start, end, "日摘要日期");
  const result = { date, sources: normalizeSources(row.sources) };
  for (const [metric, [min, max]] of Object.entries(DAILY_LIMITS)) {
    const value = finite(row[metric], metric, min, max, true);
    if (value != null) result[metric] = value;
  }
  if (Object.keys(result).length === 2 && Object.keys(result.sources).length === 0) fail("日摘要没有可用数据");
  return result;
}

function normalizeBody(row, start, end) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("身体测量格式不对");
  const date = validDate(row.date || row.day, "身体测量日期");
  within(date, start, end, "身体测量日期");
  const metric = short(row.metric, "身体测量指标", 40);
  const limits = BODY_LIMITS[metric];
  if (!limits) fail("身体测量指标不在白名单中");
  return {
    ...(row.id ? { id: short(row.id, "身体测量 ID", 80) } : {}),
    date,
    day: date,
    metric,
    value: finite(row.value, metric, limits[0], limits[1]),
    unit: limits[2],
    source: short(row.source || "HealthKit", "身体测量来源"),
  };
}

function normalizeWorkout(row, start, end) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("运动记录格式不对");
  const day = validDate(row.day, "运动日期");
  within(day, start, end, "运动日期");
  const type = short(row.type, "运动类型", 40);
  if (!WORKOUT_TYPES.has(type)) fail("运动类型不在白名单中");
  const date = new Date(row.date);
  const endDate = new Date(row.end);
  if (Number.isNaN(date.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= date) fail("运动时间不合法");
  return {
    ...(row.id ? { id: short(row.id, "运动 ID", 80) } : {}),
    date: date.toISOString(),
    end: endDate.toISOString(),
    day,
    type,
    durationMinutes: finite(row.durationMinutes, "运动时长", 0.1, 1_440),
    energyKcal: finite(row.energyKcal, "运动能量", 0, 20_000, true),
    source: short(row.source || "HealthKit", "运动来源"),
  };
}

function normalizeRunAudit(value, now) {
  // 允许已在 iPhone 待发队列中的旧版批次继续送达，但它们不能作为无人值守触发证据。
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("同步运行审计格式不对");
  const runId = short(value.runId, "运行 ID", 80);
  if (!UUID.test(runId)) fail("运行 ID 格式不对");
  const trigger = short(value.trigger, "触发来源", 40);
  if (!RUN_TRIGGERS.has(trigger)) fail("触发来源不在白名单中");
  const startedAt = new Date(value.startedAt);
  const finishedAt = new Date(value.finishedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(finishedAt.getTime())) fail("同步运行时间不合法");
  if (finishedAt < startedAt || finishedAt.getTime() - startedAt.getTime() > 30 * 60_000) fail("同步运行时长不合法");
  if (finishedAt.getTime() > now.getTime() + 10 * 60_000 || startedAt.getTime() < now.getTime() - 30 * 86400_000) fail("同步运行时间超出允许窗口");
  return { runId: runId.toLowerCase(), trigger, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
}

export function normalizeAppleHealthDevicePayload(raw, options = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("同步正文不是对象");
  if (Number(raw.schemaVersion) !== 1) fail("不支持这个同步版本", "HEALTH_SYNC_SCHEMA_UNSUPPORTED");
  const batchId = short(raw.batchId, "批次 ID", 80);
  const deviceId = short(raw.deviceId, "设备 ID", 80);
  if (!UUID.test(batchId) || !UUID.test(deviceId)) fail("批次或设备 ID 格式不对");
  const generated = new Date(raw.generatedAt);
  if (Number.isNaN(generated.getTime())) fail("批次生成时间不合法");
  const now = options.now?.() ?? new Date();
  if (generated.getTime() > now.getTime() + 10 * 60_000 || generated.getTime() < now.getTime() - 30 * 86400_000) fail("批次生成时间超出允许窗口");
  const windowStart = validDate(raw.windowStart, "同步起始日");
  const windowEnd = validDate(raw.windowEnd, "同步结束日");
  const completeThrough = validDate(raw.completeThrough, "数据覆盖日");
  if (windowStart > windowEnd || completeThrough < windowStart || completeThrough > windowEnd) fail("同步时间窗不合法");
  const span = Math.round((Date.parse(`${windowEnd}T00:00:00+09:00`) - Date.parse(`${windowStart}T00:00:00+09:00`)) / 86400_000);
  if (span > 45) fail("单次同步不能超过 46 天");
  if (raw.timeZone !== "Asia/Tokyo") fail("首期只接受 Asia/Tokyo 日界");
  const daily = Array.isArray(raw.daily) ? raw.daily.map((row) => normalizeDaily(row, windowStart, windowEnd)) : fail("缺少日摘要数组");
  const body = Array.isArray(raw.body) ? raw.body.map((row) => normalizeBody(row, windowStart, windowEnd)) : fail("缺少身体测量数组");
  const workouts = Array.isArray(raw.workouts) ? raw.workouts.map((row) => normalizeWorkout(row, windowStart, windowEnd)) : fail("缺少运动数组");
  const run = normalizeRunAudit(raw.run, now);
  if (daily.length > 46 || body.length > 1_000 || workouts.length > 500) fail("单次同步记录过多");
  return {
    schemaVersion: 1,
    batchId,
    deviceId,
    generatedAt: generated.toISOString(),
    windowStart,
    windowEnd,
    completeThrough,
    timeZone: "Asia/Tokyo",
    sampleCount: Math.round(finite(raw.sampleCount ?? 0, "样本数", 0, 1_000_000)),
    run,
    daily,
    body,
    workouts,
  };
}

function latestBody(body) {
  return Object.fromEntries(Object.keys(BODY_LIMITS).map((metric) => [metric, [...body].reverse().find((item) => item.metric === metric) ?? null]));
}

function itemKey(item) {
  return item.id || [item.metric, item.type, item.date, item.end, item.value, item.durationMinutes, item.source].join("|");
}

export function mergeAppleHealthDevicePayload(existing, payload, options = {}) {
  const current = normalizeAppleHealthData(existing || {});
  const recentBatchIds = Array.isArray(current.sync?.recentBatchIds) ? current.sync.recentBatchIds : [];
  if (recentBatchIds.includes(payload.batchId)) return { duplicate: true, data: current };

  const dailyByDate = new Map((current.daily || []).map((row) => [row.date, { ...row, sources: { ...(row.sources || {}) } }]));
  for (const incoming of payload.daily) {
    const row = dailyByDate.get(incoming.date) || { date: incoming.date, sources: {} };
    for (const metric of Object.keys(DAILY_LIMITS)) {
      if (incoming[metric] != null) row[metric] = incoming[metric];
      if (incoming.sources?.[metric]) row.sources[metric] = incoming.sources[metric];
    }
    dailyByDate.set(incoming.date, row);
  }
  const daily = [...dailyByDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const incomingBodyMetrics = new Set(payload.body.map((item) => item.metric));
  const retainedBody = (current.body || []).filter((item) => !(item.day >= payload.windowStart && item.day <= payload.windowEnd && incomingBodyMetrics.has(item.metric)));
  const bodyByKey = new Map([...retainedBody, ...payload.body].map((item) => [itemKey(item), item]));
  const body = [...bodyByKey.values()].sort((a, b) => a.date.localeCompare(b.date));

  const retainedWorkouts = payload.workouts.length
    ? (current.workouts || []).filter((item) => !(item.day >= payload.windowStart && item.day <= payload.windowEnd))
    : (current.workouts || []);
  const workoutsByKey = new Map([...retainedWorkouts, ...payload.workouts].map((item) => [itemKey(item), item]));
  const workouts = [...workoutsByKey.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 500);
  const now = options.now?.() ?? new Date();
  const data = normalizeAppleHealthData({
    ...current,
    schemaVersion: Math.max(3, Number(current.schemaVersion) || 1),
    importedAt: now.toISOString(),
    exportFile: "iPhone HealthKit 自动同步",
    exportCreatedAt: "",
    recordCount: Number(current.recordCount) || payload.sampleCount,
    daily,
    body,
    workouts,
    latestBody: latestBody(body),
    latestDaily: daily.at(-1) ?? null,
    note: "步数、活动能量、锻炼、心率、睡眠、身体测量与运动由本人 iPhone 每日增量同步，只作健康与训练参考；不含医疗记录、路线或逐秒心率。客观睡眠与日记主观记录分列，不合成一个数。",
    sync: {
      source: "iphone-healthkit",
      deviceId: payload.deviceId,
      lastSyncedAt: now.toISOString(),
      lastGeneratedAt: payload.generatedAt,
      windowStart: payload.windowStart,
      windowEnd: payload.windowEnd,
      completeThrough: payload.completeThrough,
      sampleCount: payload.sampleCount,
      lastRun: payload.run,
      recentBatchIds: [...recentBatchIds, payload.batchId].slice(-32),
    },
  });
  return { duplicate: false, data };
}

export function createAppleHealthDeviceSyncService(vaultRoot, options = {}) {
  let writes = Promise.resolve();
  return {
    sync(raw) {
      const operation = writes.then(async () => {
        const payload = normalizeAppleHealthDevicePayload(raw, options);
        const existing = await readAppleHealthData(vaultRoot);
        const merged = mergeAppleHealthDevicePayload(existing, payload, options);
        if (!merged.duplicate) await writeAppleHealthSnapshot(vaultRoot, merged.data);
        return {
          ok: true,
          duplicate: merged.duplicate,
          batchId: payload.batchId,
          completeThrough: merged.data.sync?.completeThrough || payload.completeThrough,
          lastSyncedAt: merged.data.sync?.lastSyncedAt || null,
        };
      });
      writes = operation.catch(() => undefined);
      return operation;
    },
  };
}

export function healthSyncTokenMatches(supplied, expected) {
  const left = Buffer.from(String(supplied || ""));
  const right = Buffer.from(String(expected || ""));
  return right.length >= 32 && left.length === right.length && crypto.timingSafeEqual(left, right);
}
