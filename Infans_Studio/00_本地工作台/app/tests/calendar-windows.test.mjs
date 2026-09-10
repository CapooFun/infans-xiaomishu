import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyCalendarResponse,
  beginCalendarLoad,
  calendarQuery,
  failCalendarLoad,
  homeCalendarWindow,
  lifeCalendarWindow,
  readCalendarWindow,
  EMPTY_CALENDAR,
  HOME_CALENDAR_DAYS,
} from "../src/calendar-windows.ts";

const granted = { available: true, permission: "granted", calendars: ["个人"], events: [{ id: "1" }] };
const denied = { available: false, permission: "denied", calendars: [], events: [], message: "请开启日历权限" };

test("home and life calendar windows stay distinct product ranges", () => {
  const now = new Date(2026, 8, 9, 15, 30, 0);
  const home = homeCalendarWindow(now);
  const life = lifeCalendarWindow("2026-09-09");
  assert.equal(HOME_CALENDAR_DAYS, 8);
  assert.equal((Date.parse(home.to) - Date.parse(home.from)) / 86400000, 8);
  const localStart = new Date(home.from);
  assert.equal(localStart.getHours(), 0);
  assert.equal(localStart.getMinutes(), 0);
  assert.equal(life.from, "2026-09-01T00:00:00+09:00");
  assert.equal(life.to, "2027-03-01T00:00:00+09:00");
  assert.notEqual(home.from, life.from);
  assert.notEqual(home.to, life.to);
  assert.ok((Date.parse(life.to) - Date.parse(life.from)) / 86400000 > 8);
  assert.match(calendarQuery(home.from, home.to), /^\/api\/calendar\?from=/);
  assert.match(calendarQuery(life.from, life.to, true), /force=1/);
});

test("stale disk cache force-retries once and already-forced reads do not loop", async () => {
  const calls = [];
  const stale = { ...granted, stale: true, events: [] };
  const fresh = { ...granted, stale: false, events: [{ id: "fresh" }] };
  const painted = [];
  const first = await readCalendarWindow("a", "b", {
    fetch: async (from, to, force) => {
      calls.push({ from, to, force });
      return force ? fresh : stale;
    },
    onStale: (snapshot) => painted.push(snapshot),
  });
  assert.deepEqual(calls, [{ from: "a", to: "b", force: false }, { from: "a", to: "b", force: true }]);
  assert.equal(painted.length, 1);
  assert.equal(painted[0].stale, true);
  assert.equal(first.events[0].id, "fresh");
  calls.length = 0;
  const forced = await readCalendarWindow("a", "b", {
    force: true,
    fetch: async (_from, _to, force) => {
      calls.push(force);
      return stale;
    },
  });
  assert.deepEqual(calls, [true]);
  assert.equal(forced.stale, true);
});

test("calendar load helpers keep the last snapshot, clear on deny, and stay quiet when silent", () => {
  const available = { ...granted, loading: false };
  assert.equal(beginCalendarLoad(available, { silent: true }).loading, false);
  assert.equal(beginCalendarLoad(available, { silent: true }), available);
  assert.equal(beginCalendarLoad(available, { force: true }).loading, true);
  assert.equal(beginCalendarLoad(EMPTY_CALENDAR, {}).loading, true);
  assert.equal(applyCalendarResponse(available, denied).permission, "denied");
  assert.equal(applyCalendarResponse(available, denied).events.length, 0);
  const kept = applyCalendarResponse(available, { ...EMPTY_CALENDAR, message: "超时" }, { silent: true });
  assert.equal(kept.available, true);
  assert.equal(kept.stale, true);
  assert.equal(kept.message, "超时");
  const fallback = applyCalendarResponse(available, EMPTY_CALENDAR, { force: true });
  assert.match(fallback.message, /没连上/);
  const failed = failCalendarLoad(available, new Error("网络中断"));
  assert.equal(failed.available, true);
  assert.equal(failed.stale, true);
  assert.equal(failed.message, "网络中断");
  const emptyFail = failCalendarLoad(EMPTY_CALENDAR, "x");
  assert.equal(emptyFail.available, false);
  assert.equal(emptyFail.stale, true);
});

test("shell and schedule share one calendar hook and one change subscription", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/pages/SchedulePage.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/use-calendar-windows.ts", import.meta.url), "utf8");
  const windows = readFileSync(new URL("../src/calendar-windows.ts", import.meta.url), "utf8");
  assert.match(main, /useCalendarWindows\(\{\s*home:/);
  assert.match(main, /void refreshCalendarWindows\("all", \{ force: true \}\)/);
  assert.doesNotMatch(main, /new EventSource/);
  assert.doesNotMatch(main, /loadCalendar/);
  assert.doesNotMatch(main, /\/api\/calendar\?from=/);
  assert.match(page, /useCalendarWindows\(\{\s*life:/);
  assert.match(page, /refresh\("life", \{ force \}\)/);
  assert.doesNotMatch(page, /calendarSignal/);
  assert.doesNotMatch(page, /new EventSource/);
  assert.match(hook, /new EventSource\("\/api\/calendar\/changes"\)/);
  assert.match(hook, /turn !== generations\[id\]/);
  assert.equal(hook.split("new EventSource").length, 2);
  assert.match(windows, /next\.available && next\.stale && !force/);
  assert.doesNotMatch(hook, /next\.available && next\.stale && !force/);
});
