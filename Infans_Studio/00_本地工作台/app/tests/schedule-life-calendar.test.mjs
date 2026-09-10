import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { calendarEventHref, calendarEventKind, calendarEventListTitle, calendarEventPlacement, calendarEventsByLane, calendarEventsNotCoveredByRoutines, calendarMarkerStackOffsets, calendarRange, companyTravelEventLabel, eventDays, eventTimeLabel, eventAxisPointStyle, ganttExpandAllShouldShow, groupCompanyTravel, groupLifeEvents, lifeCategoryDefaultOpen, lifeCategoryIsOpen, lifeEvents, shiftMonth } from "../src/pages/schedule/calendar-model.ts";
import { buildGanttModel, buildRoadmapMonths } from "../src/gantt-model.ts";
import { createCalendarWriteService } from "../src/server/workbench-calendar.mjs";

const event = { id: "uid1", calendar: "个人", title: "电影 · 16:40到场，正式开始17:10", start: "2026-09-06T16:40:00+09:00", end: "2026-09-06T19:10:00+09:00", allDay: false, editable: true, recurring: false };
test("half-year range crosses year and leap day using Tokyo boundaries", () => {
  assert.equal(shiftMonth("2026-09", 6), "2027-03");
  assert.deepEqual(calendarRange("2027-09"), { from: "2027-09-01T00:00:00+09:00", to: "2028-03-01T00:00:00+09:00", firstDay: "2027-09-01", lastDay: "2028-02-29" });
});
test("life events use range overlap, omit holidays, deduplicate exact occurrence only", () => {
  const range = calendarRange("2026-09");
  const recurrence = { ...event, recurring: true, start: "2026-09-07T16:40:00+09:00", end: "2026-09-07T19:10:00+09:00" };
  assert.equal(lifeEvents([event, event, recurrence, { ...event, id: "x", calendar: "工作" }, { ...event, calendar: "日本の祝日" }, { ...event, start: "2027-03-01T00:00:00+09:00", end: "2027-03-02T00:00:00+09:00" }], range.from, range.to).length, 3);
});
test("industry events and business travel both live under company matters", () => {
  const rows = [
    { ...event, id: "movie", title: "《只狼》新宿バルト9" },
    { ...event, id: "meal", title: "和朋友吃晚饭" },
    { ...event, id: "flight", title: "羽田机场航班" },
    { ...event, id: "appointment", title: "领取文件" },
    { ...event, id: "industry", title: "Tokyo Indies 游戏交流会" },
  ];
  assert.deepEqual(rows.map(calendarEventPlacement), [
    { laneId: "life", categoryId: "leisure" },
    { laneId: "life", categoryId: "leisure" },
    { laneId: "company", categoryId: "travel" },
    { laneId: "life", categoryId: "other" },
    { laneId: "company", categoryId: "industry" },
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(calendarEventsByLane(rows)).map(([lane, events]) => [lane, events.length])), { company: 2, life: 3 });
  assert.deepEqual(calendarEventPlacement({ ...event, title: "东京游戏地牢13（東京ゲームダンジョン13）" }), { laneId: "company", categoryId: "industry" });
  assert.deepEqual(groupLifeEvents(rows).map((group) => [group.label, group.events.length]), [
    ["游玩娱乐", 2], ["其他事务", 1],
  ]);
});
test("game releases go to leisure with a 游戏 badge, while industry events stay company", () => {
  assert.deepEqual(calendarEventPlacement({ ...event, title: "游戏发售 《示例园艺模拟》" }), { laneId: "life", categoryId: "leisure" });
  assert.deepEqual(calendarEventPlacement({ ...event, title: "Tokyo Indies 游戏交流会" }), { laneId: "company", categoryId: "industry" });
  assert.equal(calendarEventKind({ title: "游戏发售 《示例园艺模拟》" }), "游戏");
  assert.equal(calendarEventKind({ title: "《只狼》新宿バルト9｜16:40到场・正式开始17:10" }), "事件");
});
test("gantt list titles keep the event and drop trailing times, and known items link out", () => {
  const playbooks = [
    { id: "example-garden-fair-2026", name: "示例园艺展 2026｜周末去市集", shareName: "示例园艺展｜9月19日周末市集一日" },
    { id: "tokyo-autumn-bbq-2026", name: "东京秋季户外BBQ", shareName: "东京秋季户外BBQ｜十人电车出发" },
  ];
  assert.equal(calendarEventListTitle("示例园艺展｜市集三人同行｜正式开始09:30（东京时间）"), "示例园艺展｜市集三人同行");
  assert.equal(calendarEventListTitle("东京秋季户外BBQ｜09:00高円寺集合・正式开始11:00｜昭和纪念公园（暂定）"), "东京秋季户外BBQ｜昭和纪念公园（暂定）");
  assert.equal(calendarEventListTitle("游戏发售 《示例园艺模拟》"), "《示例园艺模拟》");
  assert.equal(calendarEventListTitle("《只狼》新宿バルト9｜16:40到场・正式开始17:10"), "《只狼》新宿バルト9");
  assert.equal(calendarEventHref("游戏发售 《示例园艺模拟》"), "/schedule?view=releases&q=%E7%A4%BA%E4%BE%8B%E5%9B%AD%E8%89%BA%E6%A8%A1%E6%8B%9F");
  assert.equal(calendarEventHref("示例园艺展｜市集三人同行｜正式开始09:30（东京时间）", { playbooks }), "/schedule?view=local&guide=example-garden-fair-2026");
  assert.equal(calendarEventHref("东京秋季户外BBQ｜09:00高円寺集合・正式开始11:00｜昭和纪念公园（暂定）", { playbooks }), "/schedule?view=local&guide=tokyo-autumn-bbq-2026");
  assert.equal(calendarEventHref("取消 Apple Music 个人版免费试用", { playbooks }), null);
});
test("hiding a company routine does not unmask matching Apple Calendar copies", () => {
  const events = [1, 2, 3, 4].map((index) => ({
    ...event,
    id: `tokyo-indies-${index}`,
    title: "Tokyo Indies 游戏交流会",
    start: `2026-${String(8 + index).padStart(2, "0")}-16T19:00:00+09:00`,
    end: `2026-${String(8 + index).padStart(2, "0")}-16T21:00:00+09:00`,
  }));
  const covering = [{ displayText: "Tokyo Indies" }];
  assert.equal(calendarEventsNotCoveredByRoutines(events, covering).length, 0);
  assert.equal(calendarEventsNotCoveredByRoutines(events, []).length, 4);
  assert.equal(lifeCategoryIsOpen({ id: "leisure", events: [event] }, {}), true);
  assert.equal(ganttExpandAllShouldShow(false, [{ id: "leisure", events: [event] }], {}, [], {}), false);
});
test("company travel groups calendar moments under the matching range without swallowing industry events", () => {
  const model = buildGanttModel({
    todayKey: "2026-09-04",
    windowStartKey: "2026-09-01",
    windowEndKey: "2027-02-28",
    longTerm: [
      { done: false, text: "公司：日程区间：2026-09-10–09-15 · 上海商务差旅｜ID：shanghai-trip" },
      { done: false, text: "公司：节点：2026-09-12 · 审核回复｜ID：review" },
    ],
  });
  const departure = { ...event, id: "depart", title: "成田机场航班", start: "2026-09-10T19:20:00+09:00", end: "2026-09-10T21:45:00+09:00" };
  const returnFlight = { ...event, id: "return", title: "浦东飞回羽田", start: "2026-09-15T01:05:00+09:00", end: "2026-09-15T05:00:00+09:00" };
  const industry = { ...event, id: "industry", title: "Tokyo Indies 游戏交流会", start: "2026-09-12T19:00:00+09:00", end: "2026-09-12T21:00:00+09:00" };
  const grouped = groupCompanyTravel(model.tasks, [departure, returnFlight, industry]);
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.groups[0].task.planId, "shanghai-trip");
  assert.deepEqual(grouped.groups[0].events.map((row) => row.id), ["depart", "return"]);
  assert.equal(grouped.tasks.some((task) => task.planId === "shanghai-trip"), false);
  assert.equal(grouped.tasks.some((task) => task.planId === "review"), true);
  assert.deepEqual(grouped.events.map((row) => row.id), ["industry"]);

  assert.deepEqual(calendarMarkerStackOffsets([departure, returnFlight], "roadmap"), [{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  assert.deepEqual(calendarMarkerStackOffsets([departure, returnFlight], "weeks"), [{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  assert.equal(companyTravelEventLabel({ ...departure, title: "成田飞上海 · 春秋日本 IJ005" }), "19:20 成田飞上海 · 春秋日本 IJ005");
  assert.equal(companyTravelEventLabel({ ...returnFlight, title: "浦东 01:05 飞回羽田 · 乐桃 MM876" }), "01:05 浦东飞回羽田 · 乐桃 MM876");
});
test("leisure opens by default through three items while other categories stay folded", () => {
  assert.equal(lifeCategoryDefaultOpen({ id: "leisure", events: [event] }), true);
  assert.equal(lifeCategoryDefaultOpen({ id: "leisure", events: [event, event, event] }), true);
  assert.equal(lifeCategoryDefaultOpen({ id: "leisure", events: [event, event, event, event] }), false);
  assert.equal(lifeCategoryDefaultOpen({ id: "travel", events: [event] }), false);
  assert.equal(lifeCategoryDefaultOpen({ id: "other", events: [event] }), false);
});
test("midnight end is exclusive, cross-day and all-day labels remain accurate", () => {
  const overnight = { ...event, start: "2026-09-05T23:30:00+09:00", end: "2026-09-06T01:00:00+09:00" };
  assert.deepEqual(eventDays(overnight), { start: "2026-09-05", end: "2026-09-06" });
  assert.match(eventTimeLabel(overnight), /2026-09-06 01:00/);
  const whole = { ...event, allDay: true, start: "2026-09-05T00:00:00+09:00", end: "2026-09-06T00:00:00+09:00" };
  assert.equal(eventTimeLabel(whole), "2026-09-05 · 全天");
});
test("month and week event geometry clips to range, titles do not become parsed tasks", () => {
  const months = buildRoadmapMonths([], "2026-09-01", 6, "2027-02-28");
  const result = eventAxisPointStyle(event, months, "2026-08-31", 26, "weeks");
  assert.ok(Math.abs(parseFloat(result.left) - 6.5 / 182 * 100) < 0.00001);
  assert.ok(Math.abs(parseFloat(eventAxisPointStyle(event, months, "2026-08-31", 26, "roadmap").left) - (5.5 / 30) / 6 * 100) < 0.00001);
  assert.equal(months.length, 6);
});
test("Gantt accepts a fixed six-month window without moving today's date", () => {
  const input = { todayKey: "2026-09-04", longTerm: [{ done: false, text: "生活：事件：2026-02-02 · 出游" }, { done: false, text: "公司：事件：2027-02-02 · 行业会" }], windowStartKey: "2026-01-01", windowEndKey: "2026-06-30" };
  const model = buildGanttModel(input);
  assert.equal(model.tasks.length, 1);
  assert.equal(model.todayKey, "2026-09-04");
  assert.equal(model.weeks[0].start, "2025-12-29");
});

function fakeCalendar(initial = [event]) {
  let id = 0;
  const rows = [];
  const wrap = (row) => {
    const values = { summary: row.title, startDate: new Date(row.start), endDate: new Date(row.end), alldayEvent: row.allDay, uid: row.id, recurrence: row.recurring ? "RRULE" : "" };
    const item = {};
    for (const key of Object.keys(values)) Object.defineProperty(item, key, { get: () => () => values[key], set: (v) => { values[key] = v; } });
    return item;
  };
  rows.push(...initial.map(wrap));
  rows.whose = (query) => () => rows.filter((row) => Object.entries(query).every(([key, value]) => row[key]() === value));
  const calendar = { name: () => "个人", events: rows };
  const calendars = () => [calendar];
  calendars.whose = (query) => () => query.name === "个人" ? [calendar] : [];
  return { rows, app: { calendars, Event: (data) => wrap({ id: `new-${++id}`, title: data.summary, start: data.startDate, end: data.endDate, allDay: data.alldayEvent }), delete: (row) => rows.splice(rows.indexOf(row), 1) } };
}
async function withService(fn) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "life-calendar-test-"));
  const fake = fakeCalendar();
  const service = createCalendarWriteService({ cacheDir, osEnabled: true, readCurrent: async () => ({ available: true, permission: "granted", events: [event] }), runner: async (script) => ({ stdout: vm.runInNewContext(`${script};run()`, { Application: () => fake.app, Date }) }) });
  try { await fn(service, fake); } finally { await fs.rm(cacheDir, { recursive: true, force: true }); }
}
test("calendar write preview requires stable expected snapshot and rejects readonly changes", () => {
  const service = createCalendarWriteService({ osEnabled: true, cacheDir: os.tmpdir() });
  assert.throws(() => service.preview({ kind: "delete", id: event.id }), /原日程快照/);
  for (const expected of [{ ...event, recurring: true }, { ...event, editable: false }, { ...event, calendar: "计划的提醒事项" }])
    assert.throws(() => service.preview({ kind: "delete", id: event.id, expected }), /只读/);
});
test("JXA mutation rechecks expected state and updates only selected event", async () => withService(async (service, fake) => {
  const preview = service.preview({ ...event, kind: "update", title: "改后标题", expected: event });
  assert.match(preview.before, /正式开始17:10/);
  assert.match(preview.after, /16:40/);
  assert.equal(fake.rows[0].summary(), event.title);
  assert.equal((await service.commit(preview.token)).ok, true);
  assert.equal(fake.rows[0].summary(), "改后标题");
  await assert.rejects(() => service.commit(preview.token), /过期/);
}));
test("external change after preview blocks deletion", async () => withService(async (service, fake) => {
  const preview = service.preview({ kind: "delete", id: event.id, expected: event });
  fake.rows[0].summary = "用户已在手机修改";
  await assert.rejects(() => service.commit(preview.token), /别处修改/);
  assert.equal(fake.rows.length, 1);
}));
test("EventKit identity is resolved to a different JXA UID only by unique exact snapshot", async () => withService(async (service, fake) => {
  fake.rows[0].uid = "jxa-different-id";
  const preview = service.preview({ ...event, kind: "update", title: "安全映射", expected: event });
  const result = await service.commit(preview.token);
  assert.equal(result.id, "jxa-different-id");
  assert.equal(result.sourceId, event.id);
  assert.equal(fake.rows[0].summary(), "安全映射");
}));
test("missing native identity blocks writes before invoking Calendar.app", async () => {
  let calls = 0;
  const service = createCalendarWriteService({ osEnabled: true, cacheDir: os.tmpdir(), readCurrent: async () => ({ available: true, permission: "granted", events: [] }), runner: async () => { calls++; return { stdout: "{}" }; } });
  const preview = service.preview({ kind: "delete", id: event.id, expected: event });
  await assert.rejects(() => service.commit(preview.token), /别处修改/);
  assert.equal(calls, 0);
});
test("confirmed delete removes exactly one non-recurring event", async () => withService(async (service, fake) => {
  const preview = service.preview({ kind: "delete", id: event.id, expected: event });
  assert.equal((await service.commit(preview.token)).ok, true);
  assert.equal(fake.rows.length, 0);
}));
test("duplicate create and simultaneous commits do not create extra appointments", async () => withService(async (service, fake) => {
  const a = service.preview({ ...event, kind: "create", title: "新约会" });
  const b = service.preview({ ...event, kind: "create", title: "新约会" });
  const result = await Promise.all([service.commit(a.token), service.commit(b.token)]);
  assert.equal(result[0].id, result[1].id);
  assert.equal(result[1].existing, true);
  assert.equal(fake.rows.length, 2);
}));
test("UI keeps life above work, uses original Gantt event stars, and leaves appointments read-only", async () => {
  const page = await fs.readFile(new URL("../src/pages/SchedulePage.tsx", import.meta.url), "utf8");
  assert.match(page, /\[lifeLane, \.\.\.model.lanes.filter/);
  assert.match(page, /LifeCalendarSidebar/);
  assert.match(page, /expandedLifeCategories/);
  assert.match(page, /calendarEventKind\(event\)/);
  assert.match(page, /calendarEventListTitle/);
  assert.match(page, /gantt-event-link/);
  assert.match(page, /todayPx - 90/);
  assert.match(page, /scrollLeft = left/);
  assert.doesNotMatch(page, /calendar-company-travel-span/);
  assert.match(page, /HideEyeButton label=\{event\.title\}/);
  assert.match(page, /onHide=\{\(event\) => hideText\(event\.title\)\}/);
  assert.match(page, /visibleLifeEvents/);
  assert.match(page, /refreshLifeCalendar\(true\)/);
  assert.match(page, /calendarEventsNotCoveredByRoutines\(laneAppointments, coveringRoutines\)/);
  assert.match(page, /CompanyTravelSidebar/);
  assert.match(page, /CompanyTravelAxis/);
  assert.match(page, /\{travelRows\}\{taskRows\}\{eventRows\}\{routineRows\}/);
  assert.doesNotMatch(page, /schedule-calendar-toolbar/);
  assert.doesNotMatch(page, /新建行程/);
  assert.doesNotMatch(page, /前半年|后半年|起始月份/);
  assert.doesNotMatch(page, /CalendarEventDialog|selectedEvent|setSelectedEvent/);
  assert.match(page, /gantt-milestone family-\$\{family\} visual-/);
  assert.match(page, /marker-star/);
  assert.match(page, /calendar-event-readonly/);
  const styles = await fs.readFile(new URL("../src/pages/schedule/calendar.css", import.meta.url), "utf8");
  assert.match(styles, /transition:\s*top 240ms/);
  assert.match(styles, /calendar-company-travel-marker/);
  assert.match(styles, /calendar-company-travel\.is-open \.calendar-life-row/);
  assert.match(styles, /calendar-company-travel-axis > \.gantt-bar-row:first-child \.gantt-bar span/);
  assert.match(styles, /\.gantt-corner-labels \{\s*align-items: baseline;/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(styles, /calendar-life-axis-event|schedule-calendar-dialog/);
  const ai = await fs.readFile(new URL("../src/server/workbench-ai.mjs", import.meta.url), "utf8");
  assert.match(ai, /主线进度只做跨月只读查看和派生归类/);
  assert.match(ai, /当前 AI 行动格式只支持创建/);
  assert.doesNotMatch(ai, /主线进度→生活事务可跨月查看与预览确认修改、删除/);
  const hook = await fs.readFile(new URL("../src/pages/schedule/use-life-calendar.ts", import.meta.url), "utf8");
  assert.match(hook, /turn !== generation.current/);
  assert.doesNotMatch(hook, /new EventSource/);
});
