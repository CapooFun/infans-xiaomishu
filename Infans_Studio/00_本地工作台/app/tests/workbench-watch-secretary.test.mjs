import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isScheduleQuestion, resolveScheduleDate } from "../src/server/workbench-schedule-date.mjs";
import { unifiedReminderActionFromGenerated } from "../src/server/workbench-unified-reminder.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COMMAND = {
  schemaVersion: 1,
  commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa3",
  text: "银月，天空为什么是蓝色？",
  createdAt: "2026-08-28T01:02:03Z",
  source: "apple_watch_app",
  deviceId: "watch-01",
  route: "auto",
  conversationKey: "watch-default",
};

test("Watch 会话实现文件已不在开源树", async () => {
  assert.equal(existsSync(path.join(appRoot, "src/server/workbench-watch-secretary.mjs")), false);
  const routes = await readFile(path.join(appRoot, "src/server/workbench-routes.mjs"), "utf8");
  assert.match(routes, /WATCH_EXCLUDED/);
  assert.match(routes, /手表产品不在公开范围/);
});

test("星期几安排按发言时的东京日期解析", () => {
  const friday = new Date("2026-08-28T10:00:00Z");
  assert.equal(isScheduleQuestion("我星期天下午有什么安排"), true);
  assert.equal(resolveScheduleDate("我星期天有什么安排", friday), "2026-08-30");
  assert.equal(resolveScheduleDate("我明天有什么日程", friday), "2026-08-29");
  assert.equal(resolveScheduleDate("我9月2日有什么安排", friday), "2026-09-02");
});

test("统一提醒把模型时间解析转成 iPhone 本机执行契约", () => {
  const baseAction = {
    kind: "calendarCreate",
    title: "交水电费",
    start: "2026-09-02T06:00:00.000Z",
    end: "2026-09-02T06:30:00.000Z",
    calendar: "个人",
  };
  const reminder = unifiedReminderActionFromGenerated(baseAction, {
    ...COMMAND,
    commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa9",
    createdAt: "2026-09-01T01:02:03+09:00",
    text: "明天下午三点提醒我交水电费",
    routing: { unifiedReminder: { executor: "apple_reminders", operation: "create", requiresClarification: false } },
  });
  assert.equal(reminder.kind, "unifiedReminder");
  assert.equal(reminder.executor, "apple_reminders");
  assert.equal(reminder.fireAt, baseAction.start);
  assert.equal(reminder.timeZone, "Asia/Tokyo");

  const poisonedByAddress = unifiedReminderActionFromGenerated({
    ...baseAction,
    start: "2027-09-01T01:40:00+09:00",
  }, {
    ...COMMAND,
    createdAt: "2026-09-01T01:33:21+09:00",
    text: "一年今天凌晨1点40分提醒我做统一提醒验收",
    routing: { unifiedReminder: { executor: "apple_reminders", operation: "create", requiresClarification: false } },
  });
  assert.equal(poisonedByAddress, null);

  const timer = unifiedReminderActionFromGenerated(baseAction, {
    ...COMMAND,
    text: "二十分钟后提醒我关火",
    routing: { unifiedReminder: { executor: "alarmkit_timer", operation: "create", requiresClarification: false } },
  });
  assert.equal(timer.durationSeconds, 1_200);
  assert.equal(timer.fireAt, undefined);

  const strong = unifiedReminderActionFromGenerated(baseAction, {
    ...COMMAND,
    createdAt: "2026-09-01T01:02:03+09:00",
    text: "明天下午三点抢票，一定叫我",
    routing: { unifiedReminder: { executor: "alarmkit_alarm", operation: "create", requiresClarification: false, safeguards: ["apple_reminders"] } },
  });
  assert.deepEqual(strong.safeguardExecutors, ["apple_reminders"]);
});

test("现有系统项通过稳定外部 ID 修改、取消和完成", () => {
  const target = {
    actionID: "88cfe608-17e8-4d0d-a4ad-21ab20955aa9",
    executor: "apple_reminders",
    nativeID: "eventkit-reminder-1",
    title: "交水电费",
  };
  const updated = unifiedReminderActionFromGenerated({
    kind: "calendarCreate",
    title: "交水电费",
    start: "2026-09-01T07:00:00.000Z",
    end: "2026-09-01T07:30:00.000Z",
  }, {
    ...COMMAND,
    createdAt: "2026-09-01T01:02:03+09:00",
    text: "把刚才那个改到下午四点",
    routing: { unifiedReminder: { executor: "apple_reminders", operation: "update", requiresClarification: false } },
  }, target);
  assert.equal(updated.operation, "update");
  assert.equal(updated.actionID, target.actionID);
  assert.equal(updated.nativeID, target.nativeID);
  assert.equal(updated.fireAt, "2026-09-01T07:00:00.000Z");

  const cancelled = unifiedReminderActionFromGenerated(null, {
    ...COMMAND,
    text: "取消那个提醒",
    routing: { unifiedReminder: { executor: "apple_reminders", operation: "cancel", requiresClarification: false } },
  }, target);
  assert.equal(cancelled.operation, "cancel");
  assert.equal(cancelled.nativeID, target.nativeID);
  assert.equal(cancelled.fireAt, undefined);
});

test("时间不全、监控型与找不到目标的修改不会误传给本机执行器", () => {
  const action = { kind: "calendarCreate", title: "有票就通知", start: "2026-09-02T06:00:00.000Z", end: "2026-09-02T06:30:00.000Z" };
  for (const routing of [
    { executor: "apple_reminders", operation: "create", requiresClarification: true },
    { executor: "secretary_monitor", operation: "create", requiresClarification: false },
    { executor: "apple_reminders", operation: "update", requiresClarification: false },
  ]) {
    assert.equal(unifiedReminderActionFromGenerated(action, { ...COMMAND, routing: { unifiedReminder: routing } }), null);
  }
});
