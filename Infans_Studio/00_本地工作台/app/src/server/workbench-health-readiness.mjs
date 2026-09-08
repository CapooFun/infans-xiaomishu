import { readAppleHealthData } from "./workbench-apple-health.mjs";

export const HEALTH_SOURCE_GATED_TASK_IDS = new Set(["training-review"]);

/** @param {string} dayKey YYYY-MM-DD */
export function previousCalendarDay(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ""))) return null;
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** @param {unknown} apple */
export function latestAppleHealthDailyDate(apple) {
  const rows = Array.isArray(apple?.daily) ? apple.daily : [];
  return rows
    .map((row) => String(row?.date || ""))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort()
    .at(-1) || null;
}

/** @param {unknown} value */
export function tokyoDayFromInstant(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * 每天给 iOS 留到 15:00 的系统调度宽限；之后仍未见当天批次，异常雷达才报警。
 * @param {unknown} apple
 * @param {string} todayKey
 * @param {number} currentHour
 */
export function appleHealthAutoSyncStatus(apple, todayKey, currentHour) {
  const sync = apple?.sync && typeof apple.sync === "object" ? apple.sync : null;
  const sourceReady = sync?.source === "iphone-healthkit";
  const lastSyncedDay = tokyoDayFromInstant(sync?.lastSyncedAt);
  const requiredThrough = previousCalendarDay(todayKey);
  const completeThrough = /^\d{4}-\d{2}-\d{2}$/.test(String(sync?.completeThrough || ""))
    ? String(sync.completeThrough)
    : null;
  const ranToday = sourceReady && lastSyncedDay === todayKey;
  const coverageReady = Boolean(requiredThrough && completeThrough && completeThrough >= requiredThrough);
  const graceEnded = Number(currentHour) >= 15;
  const ready = ranToday && coverageReady;
  const alarm = graceEnded && !ready;

  let detail;
  if (ready) {
    detail = `iPhone 今天已自动同步 · 完整覆盖到 ${completeThrough}`;
  } else if (!graceEnded) {
    detail = ranToday
      ? `iPhone 今天已送达；完整覆盖暂到 ${completeThrough || "未知"}`
      : "等待 iPhone 12:00 后由 iOS 择机自动同步；15:00 后仍未送达才报警";
  } else if (!sourceReady) {
    detail = "今天未看到 iPhone HealthKit 自动同步来源；手动 ZIP 仅作故障恢复";
  } else if (!ranToday) {
    detail = `今天尚未收到 iPhone 自动同步；上次为 ${lastSyncedDay || "无记录"}`;
  } else {
    detail = `iPhone 今天已送达，但完整覆盖只到 ${completeThrough || "未知"}，应到 ${requiredThrough}`;
  }

  return { ready, alarm, lastSyncedDay, completeThrough, requiredThrough, detail };
}

/**
 * 训练复盘只在 Apple Health 导出至少覆盖到昨天时运行。
 * 这里检查的是导出覆盖日，而不是“必须有睡眠值”：新导出中确实没有睡眠，
 * 仍属于已知缺测；旧导出则属于训练原料尚未补齐。
 * 身心月报会把 Apple Health 当作可降级来源，因此不经过这个硬门。
 * @param {unknown} apple
 * @param {string} todayKey
 */
export function appleHealthSourceReadiness(apple, todayKey) {
  const requiredThrough = previousCalendarDay(todayKey);
  const asOf = latestAppleHealthDailyDate(apple);
  const ready = Boolean(requiredThrough && asOf && asOf >= requiredThrough);
  return {
    ready,
    asOf,
    requiredThrough,
    detail: ready
      ? `Apple Health 已覆盖到 ${asOf}`
      : `待苹果健康导入：需要覆盖到 ${requiredThrough || "昨天"}，当前只到 ${asOf || "无数据"}`,
  };
}

/** @param {string} taskId @param {unknown} apple @param {string} todayKey */
export function healthSourceGateForTask(taskId, apple, todayKey) {
  return HEALTH_SOURCE_GATED_TASK_IDS.has(taskId)
    ? appleHealthSourceReadiness(apple, todayKey)
    : null;
}

/** @param {string} vaultRoot @param {string} todayKey */
export async function readAppleHealthSourceReadiness(vaultRoot, todayKey) {
  const apple = await readAppleHealthData(vaultRoot);
  return appleHealthSourceReadiness(apple, todayKey);
}
