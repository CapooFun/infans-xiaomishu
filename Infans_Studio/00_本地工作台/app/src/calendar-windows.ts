import { calendarRange } from "./pages/schedule/calendar-model.ts";
import { tokyoDateKey } from "./tokyo-time.mjs";
import type { CalendarSnapshot } from "./types";

export type CalendarWindowId = "home" | "life";
export type CalendarWindowSpec = { from: string; to: string; active: boolean };
export type CalendarFetcher = (from: string, to: string, force: boolean) => Promise<CalendarSnapshot>;

export const HOME_CALENDAR_DAYS = 8;
export const EMPTY_CALENDAR: CalendarSnapshot = { available: false, permission: "unknown", calendars: [], events: [] };
export const HOME_CALENDAR_BOOT: CalendarSnapshot = { ...EMPTY_CALENDAR, loading: true, message: "正在读取苹果日历…" };

export function homeCalendarWindow(now = new Date()) {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + HOME_CALENDAR_DAYS);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function lifeCalendarWindow(now: Date | string = new Date()) {
  const key = typeof now === "string" ? now : tokyoDateKey(now);
  return calendarRange(key.slice(0, 7));
}

export function calendarQuery(from: string, to: string, force = false) {
  const params = new URLSearchParams({ from, to });
  if (force) params.set("force", "1");
  return `/api/calendar?${params}`;
}

export function beginCalendarLoad(old: CalendarSnapshot, opts: { force?: boolean; silent?: boolean } = {}): CalendarSnapshot {
  if (opts.silent && old.available) return old;
  if (old.available) return { ...old, loading: Boolean(opts.force) || Boolean(old.stale), message: old.message };
  return { ...old, loading: true, message: old.message || "正在读取苹果日历…" };
}

export function applyCalendarResponse(old: CalendarSnapshot, next: CalendarSnapshot, opts: { force?: boolean; silent?: boolean } = {}): CalendarSnapshot {
  if (next.permission === "denied") return { ...next, loading: false };
  if (!next.available) {
    if (old.available && (opts.force || opts.silent)) {
      return { ...old, loading: false, stale: true, message: next.message || "没连上，还显示上次的数据。" };
    }
    return { ...next, loading: false };
  }
  return { ...next, loading: false, stale: Boolean(next.stale) };
}

export function failCalendarLoad(old: CalendarSnapshot, error: unknown): CalendarSnapshot {
  const message = error instanceof Error ? error.message : "日历读取失败";
  if (old.available) return { ...old, loading: false, stale: true, message };
  return { ...EMPTY_CALENDAR, loading: false, stale: true, message };
}

export async function readCalendarWindow(
  from: string,
  to: string,
  options: { force?: boolean; fetch: CalendarFetcher; onStale?: (snapshot: CalendarSnapshot) => void },
): Promise<CalendarSnapshot> {
  const force = Boolean(options.force);
  let next = await options.fetch(from, to, force);
  if (next.available && next.stale && !force) {
    options.onStale?.(next);
    next = await options.fetch(from, to, true);
  }
  return next;
}
