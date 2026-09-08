/** 东京日历日 YYYY-MM-DD（与前端 page-shared / 服务端各模块共用）。 */
export function tokyoDateKey(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function tokyoDay(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return tokyoDateKey(date);
}

/** 首页 / 日程 chips：展示「今天起共 N 个东京日历日」内的事件（含当天）。 */
export const NEAR_TERM_CALENDAR_DAYS = 2;

export function addTokyoCalendarDays(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, "0")}-${String(utc.getUTCDate()).padStart(2, "0")}`;
}

export function nearTermTokyoDateKeys(from = new Date(), days = NEAR_TERM_CALENDAR_DAYS) {
  const start = tokyoDateKey(from);
  const count = Math.max(1, Number(days) || NEAR_TERM_CALENDAR_DAYS);
  return Array.from({ length: count }, (_, index) => addTokyoCalendarDays(start, index));
}

export function isNearTermTokyoInstant(value, from = new Date(), days = NEAR_TERM_CALENDAR_DAYS) {
  return nearTermTokyoDateKeys(from, days).includes(tokyoDateKey(value));
}
