import { tokyoDateKey } from "../tokyo-time.mjs";

export const HOLIDAY_CALENDAR_PATTERN = /节假日|Holidays|祝日/i;
export const SCHOOL_REST_EVENT_PATTERN = /请假|休校|休講|学校[^\n]{0,8}休|授业[^\n]{0,8}休|授業[^\n]{0,8}休|欠席/i;

function dateRange(start, end) {
  if (!start || !end) return [];
  const first = new Date(start);
  const last = new Date(new Date(end).getTime() - 1);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return [];
  const dates = [];
  for (let cursor = first; cursor <= last && dates.length < 370; cursor = new Date(cursor.getTime() + 86_400_000)) {
    const date = tokyoDateKey(cursor);
    if (!dates.includes(date)) dates.push(date);
  }
  return dates;
}

/**
 * 休息日只来自可复查证据：正常周末、日本节假日日历，或本人日历中明示的请假/休校事件。
 * 普通日历空白不等于休息，避免把未知误报为休息日。
 */
export function deriveSchoolRestDays(dates = [], calendarSnapshot = null) {
  const reasons = new Map();
  const allowedDates = new Set(dates);
  const add = (date, reason) => {
    if (!allowedDates.has(date)) return;
    const current = reasons.get(date) || [];
    if (!current.includes(reason)) current.push(reason);
    reasons.set(date, current);
  };

  for (const date of dates) {
    const weekday = new Date(`${date}T12:00:00+09:00`).getDay();
    if (weekday === 0 || weekday === 6) add(date, "weekend");
  }

  if (calendarSnapshot?.available) {
    for (const event of calendarSnapshot.events || []) {
      const holiday = event.holiday === true || HOLIDAY_CALENDAR_PATTERN.test(event.calendar || "");
      const leave = SCHOOL_REST_EVENT_PATTERN.test(event.title || "");
      if (!holiday && !leave) continue;
      for (const date of dateRange(event.start, event.end)) add(date, holiday ? "public-holiday" : "leave");
    }
  }

  return dates.map((date) => ({ date, restDay: reasons.has(date), restReasons: reasons.get(date) || [] }));
}
