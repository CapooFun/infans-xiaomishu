import assert from "node:assert/strict";
import test from "node:test";
import {
  addCalendarDays,
  assignLane,
  barStyle,
  buildGanttModel,
  buildLanes,
  buildRoadmapMonths,
  familyForLane,
  formatHomeTodoSummary,
  milestoneStyle,
  parseRoutineDates,
  parseTaskMeta,
  parseTaskDates,
  parseTaskKind,
  resolveTaskKind,
  resolveVisual,
  roadmapBarStyle,
  roadmapDependencyStyle,
  roadmapPointStyle,
  startOfWeekMonday,
  stripTaskDecorators,
  stripTodoMetaPrefixes,
  tokyoDateKey,
  isStalePast,
} from "../src/gantt-model.ts";

const MAINLINES = [
  { priority: "公司", item: "公司事务", entry: "总览" },
  { priority: "核心", item: "游戏事业", entry: "总览" },
  { priority: "成长", item: "日语学习", entry: "总览" },
  { priority: "成长", item: "领域研究", entry: "总览" },
  { priority: "健康", item: "身心健康", entry: "总览" },
  { priority: "生活", item: "生活事务", entry: "总览" },
  { priority: "副业", item: "示例助手项目", entry: "总览" },
  { priority: "内容", item: "公众号「示例专栏」", entry: "总览" },
  { priority: "内容", item: "小红书", entry: "总览" },
  { priority: "内容", item: "抖音", entry: "总览" },
];

test("parseTaskDates ignores clock remarks so one-day events stay single", () => {
  const text = "公司：事件：8/8 · 东京游戏地牢13（東京ゲームダンジョン13）｜11:00–17:00";
  assert.deepEqual(parseTaskDates(text, "2026-08-06"), {
    start: "2026-08-08",
    end: "2026-08-08",
    kind: "single",
    source: "explicit",
  });
  assert.equal(stripTaskDecorators(text), "东京游戏地牢13（東京ゲームダンジョン13）");
  assert.ok(!stripTaskDecorators(text).includes("::"));

  const model = buildGanttModel({
    todayKey: "2026-08-06",
    mainlines: MAINLINES,
    longTerm: [{ done: false, text }],
  });
  const task = model.tasks.find((item) => item.text.includes("游戏地牢"));
  assert.ok(task);
  assert.equal(task.kind, "event");
  assert.equal(task.marker, "star");
  assert.equal(task.span?.kind, "single");
  assert.equal(task.span?.start, "2026-08-08");
  assert.equal(task.displayText, "东京游戏地牢13（東京ゲームダンジョン13）");
});

test("parseTaskDates still keeps real ranges that end with a clock note", () => {
  const span = parseTaskDates("日语：区间：8/24–9/7 17:00 JLPT 报名", "2026-08-06");
  assert.deepEqual(span, { start: "2026-08-24", end: "2026-09-07", kind: "range", source: "explicit" });
});

test("parseTaskDates reads single-day M/D · prefix", () => {
  const span = parseTaskDates("8/1 · 收束 Shadowrocket 单 VPN 工作台入口", "2026-08-01");
  assert.deepEqual(span, { start: "2026-08-01", end: "2026-08-01", kind: "single", source: "explicit" });
});

test("parseTaskDates marks an ongoing start without treating a deadline as a start", () => {
  assert.deepEqual(parseTaskDates("治理：节点：2026-08-22 起 · 逐条审核全库事项", "2026-08-29"), {
    start: "2026-08-22",
    end: "2026-08-22",
    kind: "single",
    source: "explicit",
  });
  assert.equal(parseTaskDates("7/27 前 · 提交材料", "2026-08-29"), null);
  assert.equal(stripTaskDecorators("治理：节点：2026-08-22 起 · 逐条审核全库事项"), "逐条审核全库事项");
});

test("parseTaskDates keeps full ISO dates as one day instead of a month range", () => {
  const span = parseTaskDates("游戏：项目进度 · 里程碑：2026-09-01 · 推出正式版", "2026-08-23");
  assert.deepEqual(span, { start: "2026-09-01", end: "2026-09-01", kind: "single", source: "explicit" });
});

test("parseTaskDates reads inclusive ranges across months", () => {
  const span = parseTaskDates("专题：区间：8/3–9/7 通鉴第一季读完", "2026-08-01");
  assert.deepEqual(span, { start: "2026-08-03", end: "2026-09-07", kind: "range", source: "explicit" });
});

test("parseTaskDates accepts full-year cross-year ranges", () => {
  const span = parseTaskDates("游戏：区间：2026/11–2027/2 可上架冲刺", "2026-08-01");
  assert.deepEqual(span, { start: "2026-11-01", end: "2027-02-01", kind: "range", source: "explicit" });
});

test("parseTaskKind and resolveTaskKind cover typed kinds", () => {
  assert.equal(parseTaskKind("生活：事件：8/19 · 某展会").kind, "event");
  assert.equal(parseTaskKind("日语：截止：8/24 · JLPT 报名").kind, "deadline");
  assert.equal(parseTaskKind("健康：常驻：训练节奏").kind, "cadence");
  assert.equal(parseTaskKind("游戏：例行：Tokyo Indies｜8/19 ·").kind, "routine");
  assert.equal(parseTaskKind("游戏：阶段：9/1–9/30 月度试水").kind, "phase");
  assert.equal(parseTaskKind("游戏：决策：12/31 · 选出胜出项目").kind, "gate");
  assert.equal(parseTaskKind("游戏：细节：9/9 · 真机验证").kind, "detail");
  assert.equal(parseTaskKind("公司：例行：Tokyo Indies｜8/19 ·").kind, "routine");
  assert.equal(parseTaskKind("公司：日程（有空可去）：Tokyo Indies｜2026-09-16 ·").kind, "routine");
  assert.equal(parseTaskKind("公司：日程区间：2026-09-10–09-15 · 上海商务差旅").kind, "span");
  assert.equal(parseTaskKind("游戏：项目进度 · 关键里程碑：2026-09-01 · 推出正式版").kind, "milestone");
  assert.equal(assignLane("公司：事件：8/9 · AIDD", buildLanes(MAINLINES)), "company");
  assert.equal(resolveTaskKind("游戏：7/1–8/31 Steam", parseTaskDates("游戏：7/1–8/31 Steam", "2026-08-01")), "span");
  assert.equal(resolveTaskKind("游戏：2027/2 · 发售", parseTaskDates("游戏：2027/2 · 发售", "2026-08-01")), "milestone");
  assert.equal(resolveTaskKind("健康：维持训练", null), "cadence");
});

test("roadmap metadata builds stable parent, child and dependency relationships", () => {
  const phase = "游戏：阶段：A：9/1–9/30 投放第一款试水游戏｜ID：web-09";
  const detail = "游戏：细节：A：9/9 · 完成真机验证｜ID：web-09-device｜父级：web-09";
  const gate = "游戏：决策：A：10/1 · 决定是否继续投入｜ID：web-gate｜依赖：web-09,web-09-device";
  assert.deepEqual(parseTaskMeta(gate), {
    planId: "web-gate",
    parentId: null,
    dependencyIds: ["web-09", "web-09-device"],
  });
  assert.equal(stripTaskDecorators(detail), "完成真机验证");

  const model = buildGanttModel({ todayKey: "2026-08-19", mainlines: MAINLINES, longTerm: [phase, detail, gate].map((text) => ({ done: false, text })) });
  const phaseTask = model.tasks.find((task) => task.planId === "web-09");
  const detailTask = model.tasks.find((task) => task.planId === "web-09-device");
  const gateTask = model.tasks.find((task) => task.planId === "web-gate");
  assert.equal(phaseTask?.kind, "phase");
  assert.equal(phaseTask?.childCount, 1);
  assert.equal(detailTask?.kind, "detail");
  assert.equal(detailTask?.depth, 1);
  assert.equal(gateTask?.kind, "gate");
  assert.equal(gateTask?.marker, "diamond");
  assert.deepEqual(gateTask?.dependencyIds, ["web-09", "web-09-device"]);
});

test("monthly roadmap spans the full horizon without stretching the weekly scale", () => {
  const model = buildGanttModel({
    todayKey: "2026-08-19",
    mainlines: MAINLINES,
    longTerm: [
      { done: false, text: "游戏：阶段：9/1–9/30 九月阶段｜ID：sep" },
      { done: false, text: "游戏：决策：12/31 · 年末决策｜ID：gate｜依赖：sep" },
    ],
  });
  const months = buildRoadmapMonths(model.tasks, "2026-08-19");
  assert.deepEqual(months.map((month) => month.key), ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]);
  const phase = model.tasks.find((task) => task.planId === "sep");
  const gate = model.tasks.find((task) => task.planId === "gate");
  assert.ok(phase && gate);
  const phaseStyle = roadmapBarStyle(phase, months);
  const gateStyle = roadmapPointStyle(gate, months);
  const dependencyStyle = roadmapDependencyStyle(gate, phase, months);
  assert.ok(Number.parseFloat(phaseStyle.width) > 10);
  assert.ok(Number.parseFloat(gateStyle.left) > Number.parseFloat(phaseStyle.left));
  assert.ok(dependencyStyle && Number.parseFloat(dependencyStyle.width) > 0);
});

test("monthly roadmap clips ranges that begin before the first visible month", () => {
  const model = buildGanttModel({
    todayKey: "2026-09-02",
    mainlines: MAINLINES,
    longTerm: [
      { done: false, text: "公司：阶段：2026/08/30–09/05 · 七日大作战｜ID：battle" },
      { done: false, text: "日语：区间：2026/08/11–09/30 · N3 学习｜ID：n3" },
    ],
  });
  const months = buildRoadmapMonths(model.tasks, "2026-09-02");
  const battle = model.tasks.find((task) => task.planId === "battle");
  const n3 = model.tasks.find((task) => task.planId === "n3");
  assert.ok(battle && n3);

  const battleStyle = roadmapBarStyle(battle, months);
  const n3Style = roadmapBarStyle(n3, months);
  assert.equal(battleStyle.left, "0%");
  assert.ok(Number.parseFloat(battleStyle.width) > 2 && Number.parseFloat(battleStyle.width) < 3);
  assert.equal(n3Style.left, "0%");
  assert.ok(Number.parseFloat(n3Style.width) > 16 && Number.parseFloat(n3Style.width) < 17);
});

test("assignLane maps 专题 to topics, 求职 to coach, 经营 to game", () => {
  const lanes = buildLanes(MAINLINES);
  assert.equal(assignLane("公司：区间：8/12–8/14 完成 Apple Developer 组织注册闭环", lanes), "company");
  assert.equal(assignLane("游戏：补丁说明写作", lanes), "game");
  assert.equal(assignLane("经营：意向：签证材料", lanes), "game");
  assert.equal(assignLane("教练：跟进唐", lanes), "coach");
  assert.equal(assignLane("求职：更新跟进表", lanes), "coach");
  assert.equal(assignLane("公众号：下周发一篇", lanes), "wechat");
  assert.equal(assignLane("小红书：系列提纲", lanes), "xiaohongshu");
  assert.equal(assignLane("抖音：剪一集", lanes), "douyin");
  assert.equal(assignLane("日语：N2 听力", lanes), "japanese");
  assert.equal(assignLane("健康：练腿", lanes), "health");
  assert.equal(assignLane("专题：通鉴第一季", lanes), "topics");
  assert.equal(assignLane("生活：续签材料", lanes), "life");
});

test("family tones follow lane families", () => {
  assert.equal(familyForLane("company"), "work");
  assert.equal(familyForLane("game"), "work");
  assert.equal(familyForLane("coach"), "work");
  assert.equal(familyForLane("douyin"), "work");
  assert.equal(familyForLane("japanese"), "cultivate");
  assert.equal(familyForLane("topics"), "cultivate");
  assert.equal(familyForLane("health"), "cultivate");
  assert.equal(familyForLane("life"), "life");
  assert.equal(familyForLane("other"), "mist");
});

test("company activity routines stay in the company lane", () => {
  const model = buildGanttModel({
    todayKey: "2026-08-01",
    mainlines: MAINLINES,
    longTerm: [
      { done: false, text: "公司：例行：Tokyo Indies｜8/19 · 9/16 · 10/21 · 11/18 · 12/16" },
      { done: false, text: "日语：区间：8/24–9/7 JLPT 报名" },
    ],
  });
  assert.equal(model.routines.length, 1);
  assert.equal(model.routines[0].displayText, "Tokyo Indies");
  assert.equal(model.routines[0].laneId, "company");
  assert.equal(model.routines[0].family, "work");
  assert.equal(model.routines[0].points.length, 5);
  assert.equal(model.routines[0].points[0].date, "2026-08-19");
  assert.equal(model.lanes[0]?.id, "company");
  assert.ok(!model.lanes.some((lane) => lane.id === "industry"));
  assert.ok(!model.tasks.some((task) => /Tokyo Indies/.test(task.text)));
  assert.equal(model.tasks.find((task) => /JLPT 报名/.test(task.text))?.kind, "span");
  assert.equal(model.tasks.find((task) => /JLPT 报名/.test(task.text))?.span?.end, "2026-09-07");
});

test("governed schedule labels keep all routine dates and milestone precision", () => {
  const model = buildGanttModel({
    todayKey: "2026-08-23",
    mainlines: MAINLINES,
    longTerm: [
      { done: false, text: "公司：日程（有空可去）：Tokyo Indies｜2026-09-16 · 2026-10-21 · 2026-11-18 · 2026-12-16" },
      { done: false, text: "游戏：项目进度 · 关键里程碑：2026-09-01 · 《示例卡牌游戏》正式版封版并推出" },
    ],
  });
  assert.deepEqual(model.routines[0]?.points.map((point) => point.date), [
    "2026-09-16",
    "2026-10-21",
    "2026-11-18",
    "2026-12-16",
  ]);
  const milestone = model.tasks.find((task) => /示例卡牌游戏/.test(task.text));
  assert.equal(milestone?.kind, "milestone");
  assert.deepEqual(milestone?.span, { start: "2026-09-01", end: "2026-09-01", kind: "single", source: "explicit" });
});

test("parseRoutineDates collects every M/D · mark", () => {
  const dates = parseRoutineDates("公司：例行：Tokyo Indies｜8/19 · 9/16 · 10/21 ·", "2026-08-01");
  assert.deepEqual(dates, ["2026-08-19", "2026-09-16", "2026-10-21"]);
});

test("buildGanttModel: kinds, no heuristic bars, intent excluded", () => {
  const model = buildGanttModel({
    todayKey: "2026-08-01",
    mainlines: MAINLINES,
    today: [{ done: false, text: "生活：节点：8/1 · 收束 VPN 入口" }],
    longTerm: [
      { done: false, text: "专题：区间：8/3–10/4 通鉴大计划" },
      { done: false, text: "游戏：节点：2027/2 · 正式发售" },
      { done: false, text: "日语：截止：8/24 · JLPT 报名开始" },
      { done: false, text: "生活：事件：8/19 · 某展会" },
      { done: false, text: "健康：常驻：维持训练节奏" },
      { done: false, text: "经营：意向：签证材料推进" },
      { done: false, text: "日语：区间：9/1–9/30 N3 达标" },
    ],
  });

  const byText = (re) => model.tasks.find((task) => re.test(task.text));
  assert.equal(byText(/通鉴大计划/)?.kind, "span");
  assert.equal(byText(/通鉴大计划/)?.family, "cultivate");
  assert.equal(byText(/通鉴大计划/)?.onAxis, true);
  assert.equal(byText(/正式发售/)?.marker, "star");
  assert.equal(byText(/JLPT 报名/)?.marker, "flag");
  assert.equal(byText(/某展会/)?.kind, "event");
  assert.equal(byText(/某展会/)?.family, "life");
  assert.ok(!model.tasks.some((task) => /维持训练/.test(task.text)), "无日期常驻不进甘特");
  assert.ok(!model.tasks.some((task) => /签证材料/.test(task.text)));
  assert.equal(byText(/正式发售/)?.family, "work");
  assert.ok(model.weeks.length >= 8);
  assert.deepEqual(model.routines, []);
});

test("resolveVisual marks overdue unfinished tasks", () => {
  assert.equal(resolveVisual(false, { start: "2026-07-01", end: "2026-07-20", kind: "range", source: "explicit" }, "2026-08-01"), "overdue");
  assert.equal(resolveVisual(true, { start: "2026-07-01", end: "2026-07-20", kind: "range", source: "explicit" }, "2026-08-01"), "done");
  assert.equal(resolveVisual(false, { start: "2026-09-01", end: "2026-09-10", kind: "range", source: "explicit" }, "2026-08-01"), "future");
});

test("barStyle uses day precision instead of whole weeks", () => {
  // 8/24–9/7：周一窗口起点 8/24 起，9/7 也是周一 → 只占到 W6 的第一天，不铺满整周
  const model = buildGanttModel({
    todayKey: "2026-08-03",
    mainlines: MAINLINES,
    longTerm: [{ done: false, text: "日语：区间：8/24–9/7 JLPT 报名" }],
  });
  const task = model.tasks.find((item) => /JLPT 报名/.test(item.text));
  assert.ok(task);
  assert.equal(task.span?.end, "2026-09-07");
  assert.equal(task.weekStart, 3); // 8/24 所在周（窗口周一 8/3）
  assert.equal(task.weekEnd, 5); // 9/7 所在周
  assert.equal(task.dayOffset, 0); // 8/24 周一
  assert.equal(task.dayEndOffset, 1 / 7); // 9/7 当天结束

  const style = barStyle(task, model.weeks.length);
  const left = Number.parseFloat(style.left);
  const width = Number.parseFloat(style.width);
  // 起点=第 3 周 / 终点=第 5 周 + 1/7；不得铺满到第 6 周
  assert.ok(Math.abs(left - (3 / model.weeks.length) * 100) < 1e-6);
  assert.ok(Math.abs(width - ((5 + 1 / 7 - 3) / model.weeks.length) * 100) < 1e-6);
  assert.ok(left + width < ((5 + 1) / model.weeks.length) * 100 - 0.01);

  const pin = milestoneStyle(
    {
      id: "m",
      text: "t",
      displayText: "t",
      done: false,
      scope: "longTerm",
      laneId: "game",
      kind: "milestone",
      family: "work",
      marker: "star",
      onAxis: true,
      span: { start: "2027-02-01", end: "2027-02-01", kind: "single", source: "explicit" },
      visual: "future",
      weekStart: 4,
      weekEnd: 4,
      dayOffset: 0.5,
      dayEndOffset: 0.5 + 1 / 7,
    },
    8,
  );
  // 周内 0.5 + 半日 → (4.5 + 0.5/7) / 8
  assert.equal(pin.left, `${((4.5 + 0.5 / 7) / 8) * 100}%`);
});

test("stripTaskDecorators drops workbench lane, kind and 待排 placeholder", () => {
  assert.equal(
    stripTaskDecorators("工作台：节点：待排 · 把事业顺利改成「点进项目就进工作台」"),
    "把事业顺利改成「点进项目就进工作台」",
  );
  assert.equal(
    stripTaskDecorators("公司：截止：8/6 · 买东京游戏地牢13门票"),
    "买东京游戏地牢13门票",
  );
  assert.equal(
    stripTaskDecorators("游戏：项目进度 · 关键里程碑：2026-09-01 · 《示例卡牌游戏》正式版封版并推出"),
    "《示例卡牌游戏》正式版封版并推出",
  );
  assert.equal(
    stripTaskDecorators("公司：日程（有空可去）：Tokyo Indies｜2026-09-16 · 2026-10-21 · 2026-11-18 · 2026-12-16"),
    "Tokyo Indies",
  );
  assert.equal(
    stripTaskDecorators("公司：日程区间：2026-09-10–09-15 · 上海商务差旅"),
    "上海商务差旅",
  );
  assert.equal(
    stripTaskDecorators("游戏：战略主线下的项目进度 · 发行里程碑：2026 年 8–12 月推进《阳台种植计划》，目标年底在 Steam 发行"),
    "推进《阳台种植计划》，目标年底在 Steam 发行",
  );
});

test("stripTodoMetaPrefixes keeps date and title for home summary", () => {
  assert.equal(
    stripTodoMetaPrefixes("游戏：节点：A：8/10 · 把苹果企业开发者身份认证做完"),
    "8/10 · 把苹果企业开发者身份认证做完",
  );
  assert.equal(
    stripTodoMetaPrefixes("游戏：节点：A：8/18 · 给 Steam 上的游戏换名并重做商店页"),
    "8/18 · 给 Steam 上的游戏换名并重做商店页",
  );
});

test("formatHomeTodoSummary keeps only the actionable title for the near-term home list", () => {
  assert.equal(
    formatHomeTodoSummary("待办：2026-08-23 · 联系 Steamworks 客服"),
    "联系 Steamworks 客服",
  );
  assert.equal(
    formatHomeTodoSummary("验收：2026-08-23 · 检查首页"),
    "检查首页",
  );
  assert.equal(
    formatHomeTodoSummary("待办：2027-01-03 · 明年事项"),
    "明年事项",
  );
  assert.equal(
    formatHomeTodoSummary("游戏：待办：S：2026-08-26 · 联系 Steamworks 客服｜ID：quit-to-cultivate-steam-support｜工作线：board.qtc.steam_release"),
    "联系 Steamworks 客服",
  );
});

test("stripTaskDecorators clears time-of-day and empty meta parentheses", () => {
  assert.equal(
    stripTaskDecorators("健康：节点：8/6 · 白天 · 定精力与平衡要怎么问、多久问一次"),
    "定精力与平衡要怎么问、多久问一次",
  );
  assert.equal(
    stripTaskDecorators("专题：节点：8/2 · 把专题课程做成能用的陪学入口（工作台）"),
    "把专题课程做成能用的陪学入口",
  );
  assert.equal(
    stripTaskDecorators("日语：常驻：8/3 起 · JLPT 真题逐场精校入库（盯进度）"),
    "JLPT 真题逐场精校入库",
  );
});

test("startOfWeekMonday and strip decorators stay stable", () => {
  assert.equal(startOfWeekMonday("2026-08-01"), "2026-07-27");
  assert.equal(tokyoDateKey("2026-08-01T15:00:00+09:00"), "2026-08-01");
  assert.equal(stripTaskDecorators("专题：区间：8/3–9/7 通鉴第一季读完"), "通鉴第一季读完");
  assert.equal(addCalendarDays("2026-08-01", 7), "2026-08-08");
});

test("stale past tasks older than 7 days leave the gantt", () => {
  assert.equal(isStalePast("2026-07-20", "2026-08-02"), true);
  assert.equal(isStalePast("2026-07-26", "2026-08-02"), false);
  assert.equal(isStalePast("2026-07-25", "2026-08-02"), true);
  const model = buildGanttModel({
    today: [
      { done: false, text: "公司：事件：7/10 · 很久以前的会" },
      { done: false, text: "公司：事件：7/28 · 一周内的会" },
      { done: true, text: "公司：事件：8/8 · 已完成的会" },
      { done: false, text: "公司：事件：8/9 · 未来的会" },
    ],
    longTerm: [
      { done: false, text: "公司：例行：Tokyo Indies｜7/15 · 8/19 · 9/16" },
    ],
    mainlines: MAINLINES,
    todayKey: "2026-08-02",
  });
  assert.equal(model.tasks.some((task) => task.text.includes("很久以前")), false);
  assert.equal(model.tasks.some((task) => task.text.includes("一周内")), true);
  assert.equal(model.tasks.some((task) => task.text.includes("已完成")), false, "已完成不进甘特");
  assert.equal(model.tasks.some((task) => task.text.includes("未来的会")), true);
  const routine = model.routines.find((item) => item.text.includes("Tokyo Indies"));
  assert.ok(routine);
  assert.deepEqual(routine.points.map((point) => point.date), ["2026-08-19", "2026-09-16"]);
});

test("empty or cadence-only lanes stay hidden", () => {
  const model = buildGanttModel({
    todayKey: "2026-08-09",
    mainlines: MAINLINES,
    longTerm: [
      { done: true, text: "健康：节点：8/6 · 已完成身心事项" },
      { done: false, text: "健康：常驻：无日期节奏" },
      { done: false, text: "游戏：节点：2027/2 · 正式发售" },
    ],
  });
  assert.ok(!model.lanes.some((lane) => lane.id === "health"));
  assert.ok(model.lanes.some((lane) => lane.id === "game"));
  assert.ok(!model.tasks.some((task) => /无日期节奏/.test(task.text)));
});
