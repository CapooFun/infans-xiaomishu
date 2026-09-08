import test from "node:test";
import assert from "node:assert/strict";

import { classifyUnifiedReminderIntent } from "../src/server/workbench-unified-reminder-router.mjs";

const cases = [
  ["明天下午三点提醒我交水电费", "reminder", "apple_reminders"],
  ["周六14点和孙翔看电影", "calendar", "apple_calendar"],
  ["开票前十分钟一定叫我", "strong_alarm", "alarmkit_alarm"],
  ["二十分钟后提醒我关火", "timer", "alarmkit_timer"],
  ["每周一早上提醒我倒垃圾", "reminder", "apple_reminders"],
  ["每天七点叫我起床", "strong_alarm", "alarmkit_alarm"],
  ["票一开卖就告诉我", "monitor", "secretary_monitor"],
];

test("统一提醒首批样例稳定分流到系统事实源", () => {
  for (const [text, kind, executor] of cases) {
    const routed = classifyUnifiedReminderIntent(text);
    assert.equal(routed?.kind, kind, text);
    assert.equal(routed?.executor, executor, text);
    assert.equal(routed?.timeZone, "Asia/Tokyo", text);
  }
});

test("强提醒保留普通提醒作为防漏保障，但不伪装成系统时钟闹钟", () => {
  const routed = classifyUnifiedReminderIntent("明天九点抢票，一定叫我");
  assert.equal(routed.kind, "strong_alarm");
  assert.deepEqual(routed.safeguards, ["apple_reminders"]);
  assert.equal(routed.executor, "alarmkit_alarm");
});

test("时间缺失时只标记关键缺口，不创建或猜时间", () => {
  const reminder = classifyUnifiedReminderIntent("提醒我交水电费");
  assert.equal(reminder.requiresClarification, true);
  assert.deepEqual(reminder.missing, ["提醒时间"]);

  const calendar = classifyUnifiedReminderIntent("和孙翔看电影");
  assert.equal(calendar.requiresClarification, true);
  assert.deepEqual(calendar.missing, ["日期", "开始时间"]);
});

test("修改取消沿指代进入原执行器，不降级为新建项目", () => {
  const update = classifyUnifiedReminderIntent("把刚才那个改到三点");
  assert.equal(update.operation, "update");
  assert.equal(update.kind, "reminder");
  assert.equal(update.requiresClarification, false);

  const cancel = classifyUnifiedReminderIntent("我已经买到了，取消那个提醒");
  assert.equal(cancel.operation, "cancel");
  assert.equal(cancel.kind, "reminder");

  const titled = classifyUnifiedReminderIntent("取消交水电费提醒");
  assert.equal(titled.operation, "cancel");
  assert.equal(titled.requiresClarification, false);
});

test("普通问答不被统一提醒路由误接管", () => {
  assert.equal(classifyUnifiedReminderIntent("生存还是死亡出自哪部戏"), null);
  assert.equal(classifyUnifiedReminderIntent("银月在吗"), null);
});
