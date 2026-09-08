import test from "node:test";
import assert from "node:assert/strict";
import {
  appleHealthAutoSyncStatus,
  appleHealthSourceReadiness,
  healthSourceGateForTask,
  latestAppleHealthDailyDate,
  previousCalendarDay,
} from "../src/server/workbench-health-readiness.mjs";

test("iPhone 自动同步在 15:00 后仍未送达才报警", () => {
  const yesterday = {
    sync: {
      source: "iphone-healthkit",
      lastSyncedAt: "2026-08-26T03:10:00.000Z",
      completeThrough: "2026-08-25",
    },
  };
  assert.equal(appleHealthAutoSyncStatus(yesterday, "2026-08-27", 14).alarm, false);
  assert.equal(appleHealthAutoSyncStatus(yesterday, "2026-08-27", 15).alarm, true);

  const today = {
    sync: {
      source: "iphone-healthkit",
      lastSyncedAt: "2026-08-27T03:10:00.000Z",
      completeThrough: "2026-08-26",
    },
  };
  const ready = appleHealthAutoSyncStatus(today, "2026-08-27", 15);
  assert.equal(ready.ready, true);
  assert.equal(ready.alarm, false);
  assert.match(ready.detail, /今天已自动同步/);
});

test("Apple Health 来源新鲜度要求导出覆盖到昨天", () => {
  assert.equal(previousCalendarDay("2026-08-24"), "2026-08-23");
  const stale = { daily: [{ date: "2026-08-16", sleepMinutes: 426 }] };
  assert.equal(latestAppleHealthDailyDate(stale), "2026-08-16");
  assert.deepEqual(appleHealthSourceReadiness(stale, "2026-08-24"), {
    ready: false,
    asOf: "2026-08-16",
    requiredThrough: "2026-08-23",
    detail: "待苹果健康导入：需要覆盖到 2026-08-23，当前只到 2026-08-16",
  });
  const freshWithoutSleep = { daily: [{ date: "2026-08-23", steps: 1234 }] };
  assert.equal(appleHealthSourceReadiness(freshWithoutSleep, "2026-08-24").ready, true);
});

test("只有训练复盘被 Apple Health 硬门阻止，月报允许降级", () => {
  const apple = { daily: [{ date: "2026-08-16" }] };
  assert.equal(healthSourceGateForTask("training-review", apple, "2026-08-24")?.ready, false);
  assert.equal(healthSourceGateForTask("monthly-review", apple, "2026-08-24"), null);
  assert.equal(healthSourceGateForTask("health-daily", apple, "2026-08-24"), null);
});
