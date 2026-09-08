import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { healthRequirementForTask, nextRunLabel, readCronMonitor, runCronTasks, scanLog, scheduledToday } from "../src/server/workbench-cron-monitor.mjs";

test("异常雷达月更区保留账号与账单的完整盘点清单", () => {
  const toolsPage = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  assert.match(toolsPage, /function AssetChecklist/);
  assert.match(toolsPage, /下一轮账号与账单/);
  assert.match(toolsPage, /月末盘点待安排/);
  assert.match(toolsPage, /上次完成依据/);
  assert.match(toolsPage, /monthlyAssets \? <AssetChecklist/);
});

test("异常雷达只给复杂周期任务展示条件页签，日更直接回答今天结果", () => {
  const toolsPage = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  assert.match(toolsPage, /task\.cadence !== "daily"/);
  assert.match(toolsPage, /今天成功/);
  assert.match(toolsPage, /今天失败/);
  assert.match(toolsPage, /今天尚未执行/);
  assert.match(toolsPage, /今天已执行/);
  assert.match(toolsPage, /versionOutcomeLabel/);
  assert.match(toolsPage, /"上次缺少"/);
  assert.match(toolsPage, /"下次需要"/);
  assert.match(toolsPage, /className="cron-task-layout"/);
  assert.match(toolsPage, /className="cron-daily-detail"/);
  assert.match(toolsPage, /is-daily-grid/);
  assert.match(toolsPage, /下次执行/);
  assert.match(toolsPage, /cronNextRunDisplay/);
  assert.match(toolsPage, /row\.id === "apple-health-sync"/);
  assert.match(toolsPage, /appleHealthSync\?\.alarm/);
  assert.match(toolsPage, /rows=\{\[appleHealthSync\]\}/);
});

test("旧版运行器把不升级写成红叉时，监控仍按有效执行识别", () => {
  const line = "2026-08-29 06:00:05 JST ❌ 版本队列仍有待处理事项；Cursor 已保留原因";
  const scanned = scanLog(
    line,
    [/❌ 版本队列仍有待处理事项；Cursor 已保留原因/],
    [/❌/],
  );
  assert.equal(scanned.lastOk?.line, line);
  assert.equal(scanned.lastFail, null);
});

test("readCronMonitor returns Infans scheduled tasks including Cursor release closeout, Anki and Japan activities", async () => {
  const snapshot = await readCronMonitor("${INFANS_VAULT_ROOT:-$HOME/Infans_Studio}");
  assert.equal(snapshot.tasks.length, 11);
  assert.ok(snapshot.today);
  assert.match(snapshot.noteExtras, /训练复盘会等 Apple Health/);
  assert.match(snapshot.noteExtras, /月报缺覆盖时降级/);
  const ids = snapshot.tasks.map((task) => task.id);
  assert.deepEqual(ids, [
    "workbench-daily-health",
    "workbench-daily-release",
    "vault-backup",
    "world-brief",
    "health-daily",
    "monthly-review",
    "training-review",
    "japan-activities",
    "ai-tools-quarterly",
    "anki-snapshot",
    "quarterly-restore-drill",
  ]);
  for (const task of snapshot.tasks) {
    assert.equal(typeof task.statusLabel, "string");
    assert.equal(typeof task.agentInstalled, "boolean");
    assert.equal(typeof task.canRerun, "boolean");
    assert.equal(typeof task.nextRunLabel, "string");
    assert.equal(typeof task.lastOutcomeSummary, "string");
    assert.ok(task.requirements.length >= 1);
  }
  assert.equal(snapshot.tasks.some((task) => task.id === "kitchen-orders-sync"), false);
  const dailyHealth = snapshot.tasks.find((task) => task.id === "workbench-daily-health");
  assert.equal(dailyHealth.scheduleLabel, "每天 06:00");
  assert.match(dailyHealth.blurb, /不调用模型/);
  const dailyRelease = snapshot.tasks.find((task) => task.id === "workbench-daily-release");
  assert.equal(dailyRelease.scheduleLabel, "每周一 06:00");
  assert.equal(dailyRelease.cadence, "weekly");
  assert.match(dailyRelease.blurb, /Cursor/);
  if (dailyRelease.status === "ok") assert.match(dailyRelease.versionOutcomeLabel, /^(当前版本号|已升级版本号)：V\d+\.\d+\.\d+$/);
  assert.equal(snapshot.tasks.find((task) => task.id === "monthly-review")?.scheduleLabel, "每月 1 日 06:05");
  assert.equal(snapshot.tasks.find((task) => task.id === "world-brief")?.scheduleLabel, "每天 06:10");
  assert.ok(snapshot.tasks.find((task) => task.id === "world-brief")?.requirements.some((row) => row.id === "news-algorithm"));
  assert.equal(snapshot.tasks.find((task) => task.id === "health-daily")?.scheduleLabel, "每天 06:30");
  assert.equal(snapshot.tasks.find((task) => task.id === "training-review")?.scheduleLabel, "每周一 06:35");
  assert.equal(snapshot.tasks.find((task) => task.id === "vault-backup")?.scheduleLabel, "每天 07:10");
  const japanActivities = snapshot.tasks.find((task) => task.id === "japan-activities");
  assert.equal(japanActivities.scheduleLabel, "隔周一 09:00");
  const aiToolsQuarterly = snapshot.tasks.find((task) => task.id === "ai-tools-quarterly");
  assert.equal(aiToolsQuarterly.scheduleLabel, "每季度第一天 09:30");
  assert.ok(aiToolsQuarterly.requirements.some((row) => row.id === "used-tools"));
  const quarterly = snapshot.tasks.find((task) => task.id === "quarterly-restore-drill");
  assert.equal(quarterly.cadence, "quarterly");
  assert.match(quarterly.nextRunLabel, /Q3/);
  assert.match(quarterly.lastOutcomeSummary, /没有找到可核对/);
});

test("nextRunLabel keeps failed runs in the current slot and calculates future cadence", () => {
  const monday = { date: "2026-08-24", weekday: 1, dayOfMonth: 24, hour: 8, minute: 30 };
  assert.equal(nextRunLabel({ cadence: "daily", hour: 6, minute: 0 }, monday, "ok"), "明天 06:00");
  assert.equal(nextRunLabel({ cadence: "weekly", weekday: 1, hour: 7, minute: 0 }, monday, "waiting"), "本次待处理 · 原定今天 07:00");
  assert.equal(nextRunLabel({ cadence: "weekly", weekday: 1, hour: 7, minute: 0 }, monday, "ok"), "2026-08-31 07:00");
  assert.equal(nextRunLabel({ cadence: "monthly", dayOfMonth: 1, hour: 8, minute: 0 }, monday, "idle"), "2026-09-01 08:00");
});

test("health requirements distinguish a current gap from a future run cutoff", () => {
  const monthly = { nextRunLabel: "2026-09-01 08:00" };
  const missing = healthRequirementForTask(monthly, {
    ready: false,
    asOf: "2026-08-16",
    requiredThrough: "2026-08-23",
    detail: "待苹果健康导入：需要覆盖到 2026-08-23，当前只到 2026-08-16",
  });
  assert.equal(missing.state, "missing");
  assert.match(missing.detail, /2026-09-01 执行前还需覆盖到 2026-08-31/);
  const monthlyDegraded = healthRequirementForTask(monthly, {
    ready: false,
    asOf: "2026-08-16",
    requiredThrough: "2026-08-23",
    detail: "待苹果健康导入：需要覆盖到 2026-08-23，当前只到 2026-08-16",
  }, { optional: true });
  assert.equal(monthlyDegraded.state, "optional");
  assert.match(monthlyDegraded.detail, /2026-09-01 执行前还需覆盖到 2026-08-31/);

  const currentButNotFinal = healthRequirementForTask(monthly, {
    ready: true,
    asOf: "2026-08-23",
    requiredThrough: "2026-08-23",
    detail: "Apple Health 已覆盖到 2026-08-23",
  });
  assert.equal(currentButNotFinal.state, "check");
  assert.match(currentButNotFinal.detail, /执行前还需覆盖到 2026-08-31/);
});

test("Japan activities is due on alternating Mondays from its anchor", () => {
  const task = { cadence: "weekly", weekday: 1, intervalWeeks: 2, anchorDate: "2026-09-07" };
  assert.equal(scheduledToday(task, { date: "2026-08-24", weekday: 1 }), false);
  assert.equal(scheduledToday(task, { date: "2026-08-31", weekday: 1 }), false);
  assert.equal(scheduledToday(task, { date: "2026-09-07", weekday: 1 }), true);
  assert.equal(scheduledToday(task, { date: "2026-09-21", weekday: 1 }), true);
  assert.equal(scheduledToday(task, { date: "2026-09-08", weekday: 2 }), false);
});

test("AI tools report is due only on the first day of each quarter", () => {
  const task = { cadence: "quarterly", dayOfMonth: 1, monthsOfYear: [1, 4, 7, 10] };
  assert.equal(scheduledToday(task, { month: 10, dayOfMonth: 1 }), true);
  assert.equal(scheduledToday(task, { month: 9, dayOfMonth: 1 }), false);
  assert.equal(scheduledToday(task, { month: 10, dayOfMonth: 2 }), false);
});

test("runCronTasks rejects unknown task ids", async () => {
  const result = await runCronTasks("${INFANS_VAULT_ROOT:-$HOME/Infans_Studio}", { id: "not-a-real-task" });
  assert.equal(result.ok, false);
  assert.match(result.message, /未知任务/);
});
