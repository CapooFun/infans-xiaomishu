import test from "node:test";
import assert from "node:assert/strict";
import {
  mondayOfWeek,
  previousMonthRange,
  assetInventoryCycle,
  formatShortDate,
  diaryDayComplete,
  coverageAlarm,
  weeklySleepAlarm,
  steamPlayedRecently,
  matchAssetChecklistSmart,
  applyCashflowChecklist,
  readLargeOtherPaymentConfirm,
  buildVerdict,
  pickMonthAssetSnapshot,
  freshnessReadyPercent,
  ASSET_CHECKLIST_ITEMS,
  ASSET_CASHFLOW_ITEMS,
} from "../src/server/workbench-rhythm-check.mjs";
import { billFileCoversMonth } from "../src/server/workbench-wechat-bills.mjs";
import { readCronMonitor } from "../src/server/workbench-cron-monitor.mjs";

test("mondayOfWeek and previousMonthRange", () => {
  assert.equal(mondayOfWeek("2026-08-09"), "2026-08-03");
  assert.equal(mondayOfWeek("2026-08-03"), "2026-08-03");
  const prev = previousMonthRange("2026-08-09");
  assert.equal(prev.monthKey, "2026-07");
  assert.equal(prev.daysInMonth, 31);
  assert.equal(prev.days[0], "2026-07-01");
  assert.equal(prev.days.at(-1), "2026-07-31");
});

test("asset inventory cycle distinguishes next pending, open, and overdue", () => {
  assert.deepEqual(assetInventoryCycle("2026-08-24", true), {
    state: "next-pending",
    targetMonthKey: "2026-08",
    opensAt: "2026-09-01",
    dueAt: "2026-09-10",
    lastCompletedMonthKey: "2026-07",
  });
  assert.deepEqual(assetInventoryCycle("2026-08-09", false), {
    state: "open",
    targetMonthKey: "2026-07",
    opensAt: "2026-08-01",
    dueAt: "2026-08-10",
    lastCompletedMonthKey: null,
  });
  assert.equal(assetInventoryCycle("2026-08-24", false).state, "overdue");
});

test("formatShortDate and diaryDayComplete", () => {
  assert.equal(formatShortDate("2026-08-08"), "8/8");
  assert.equal(formatShortDate(null), "—");
  assert.equal(diaryDayComplete("工作强度 6/10\n恢复：收工就能放下 50 · 日程未被打乱 100"), true);
  assert.equal(diaryDayComplete("工作强度 0/10\n恢复：收工就能放下 100 · 日程未被打乱 100"), true);
  assert.equal(diaryDayComplete("工作强度 3/5\n恢复：收工就能放下 50 · 日程未被打乱 100"), true);
  assert.equal(diaryDayComplete("工作强度 6/10"), false);
  assert.equal(diaryDayComplete("恢复：收工就能放下 50"), false);
});

test("coverage and weekly sleep alarms", () => {
  assert.equal(coverageAlarm(24, 31).alarm, true);
  assert.equal(coverageAlarm(25, 31).alarm, false);
  assert.equal(weeklySleepAlarm(2, 5).alarm, true);
  assert.equal(weeklySleepAlarm(3, 5).alarm, false);
  // 周一开局：昨晚数据还在，不报红
  assert.equal(weeklySleepAlarm(0, 1, { latestSleepKey: "2026-08-09", todayKey: "2026-08-10" }).alarm, false);
  assert.equal(weeklySleepAlarm(0, 1, { latestSleepKey: "2026-08-09", todayKey: "2026-08-10" }).freshEnough, true);
  // 拖了两天以上仍无本周数据，照旧报红
  assert.equal(weeklySleepAlarm(0, 2, { latestSleepKey: "2026-08-09", todayKey: "2026-08-11" }).alarm, true);
});

test("steamPlayedRecently", () => {
  const hit = steamPlayedRecently(JSON.stringify({
    synced_at: "2026-08-08T00:00:00",
    games: [{ playtime_2weeks_minutes: 120 }, { playtime_2weeks_minutes: 0 }],
  }));
  assert.equal(hit.played, true);
  assert.equal(hit.minutes2weeks, 120);
  const miss = steamPlayedRecently(JSON.stringify({ games: [{ playtime_2weeks_minutes: 0 }] }));
  assert.equal(miss.played, false);
});

test("matchAssetChecklistSmart marks present and missing", () => {
  const snapshot = {
    date: "2026-08-06",
    items: [
      { category: "银行存款", name: "示例银行甲（尾号1001）" },
      { category: "现金/第三方", name: "PayPay" },
      { category: "信用卡负债", name: "PayPay卡" },
      { category: "证券投资", name: "A股" },
      { category: "贷款负债", name: "示例消费贷" },
      { category: "债权资产", name: "示例借款人甲" },
    ],
  };
  const view = matchAssetChecklistSmart(snapshot);
  assert.equal(view.snapshotDate, "2026-08-06");
  assert.ok(view.items.find((item) => item.id === "bank-a")?.present);
  assert.ok(view.items.find((item) => item.id === "paypay-balance")?.present);
  assert.ok(view.items.find((item) => item.id === "paypay-card")?.present);
  assert.ok(view.items.find((item) => item.id === "a-shares")?.present);
  assert.ok(view.items.find((item) => item.id === "consumer-loan")?.present);
  assert.ok(view.items.find((item) => item.id === "personal-loans")?.present);
  assert.equal(view.items.find((item) => item.id === "alipay")?.present, false);
  assert.ok(view.missingCount >= 1);
  assert.equal(view.groups.length, 5);
  assert.deepEqual(view.groups.map((group) => group.id), ["bank", "cash", "credit", "securities", "loans"]);
  assert.ok(view.groups.find((group) => group.id === "cash")?.missingCount >= 1);
  assert.ok(ASSET_CHECKLIST_ITEMS.length >= 20);
  assert.ok(ASSET_CASHFLOW_ITEMS.some((item) => item.id === "wechat-bills"));
  assert.ok(ASSET_CHECKLIST_ITEMS.some((item) => item.id === "personal-loans"));
  assert.ok(!ASSET_CHECKLIST_ITEMS.some((item) => item.id === "loan-wu"));
});

test("bill coverage and large-other confirm", () => {
  assert.equal(billFileCoversMonth("Transactions_20260118-20260806.csv", "2026-08"), false);
  assert.equal(billFileCoversMonth("Transactions_20260118-20260831.csv", "2026-08"), true);
  assert.equal(billFileCoversMonth("Transactions_20260801-20260831.csv", "2026-08"), true);
  assert.equal(billFileCoversMonth("Transactions_20260802-20260901.csv", "2026-08"), false);
  assert.equal(billFileCoversMonth("微信支付账单流水文件(20251231-20260731)_x.xlsx", "2026-08"), false);
  assert.equal(billFileCoversMonth("微信支付账单流水文件(20251231-20260731)_x.xlsx", "2026-07"), true);
  const confirmed = readLargeOtherPaymentConfirm("大额支付确认（2026-08）：无其他未统计 · 2026-08-09\n", "2026-08");
  assert.equal(confirmed.present, true);
  assert.match(confirmed.note || "", /无其他/);
  const pending = readLargeOtherPaymentConfirm("大额支付确认（2026-08）：待确认\n", "2026-08");
  assert.equal(pending.present, false);
  const missing = readLargeOtherPaymentConfirm("", "2026-08");
  assert.equal(missing.present, false);

  const base = matchAssetChecklistSmart({ date: "2026-08-06", items: [] });
  const merged = applyCashflowChecklist(base, { wechat: true, paypay: false, alipay: true, largeOther: true });
  assert.equal(merged.groups.length, 6);
  assert.ok(merged.groups.some((group) => group.id === "cashflow"));
  assert.equal(merged.items.find((item) => item.id === "wechat-bills")?.present, true);
  assert.equal(merged.items.find((item) => item.id === "paypay-bills")?.present, false);
  assert.equal(merged.items.find((item) => item.id === "alipay-bills")?.present, true);
  assert.equal(merged.items.find((item) => item.id === "large-other")?.present, true);
});

test("pickMonthAssetSnapshot prefers current month", () => {
  const md = `<!-- INFANS_ASSET_SNAPSHOT_JSON_START -->
\`\`\`json
{
  "snapshots": [
    { "date": "2026-05-31", "capturedAt": "2026-06-10", "items": [{ "name": "A股", "category": "证券投资", "cnyValue": 1 }] },
    { "date": "2026-07-31", "capturedAt": "2026-08-06", "items": [{ "name": "A股", "category": "证券投资", "cnyValue": 2 }] }
  ]
}
\`\`\`
<!-- INFANS_ASSET_SNAPSHOT_JSON_END -->`;
  const snap = pickMonthAssetSnapshot(md, "2026-07");
  assert.equal(snap?.date, "2026-07-31");
  const none = pickMonthAssetSnapshot(md, "2026-08");
  assert.equal(none?.date, "2026-07-31");
  assert.equal(none?._notThisMonth, true);
});

test("proxy snapshot is flagged for inventory skip", () => {
  const md = `<!-- INFANS_ASSET_SNAPSHOT_JSON_START -->
\`\`\`json
{
  "snapshots": [
    { "date": "2026-06-30", "proxy": true, "proxyOf": "2026-05-31", "items": [{ "name": "A股", "category": "证券投资", "cnyValue": 1 }] }
  ]
}
\`\`\`
<!-- INFANS_ASSET_SNAPSHOT_JSON_END -->`;
  const snap = pickMonthAssetSnapshot(md, "2026-06");
  assert.equal(snap?.date, "2026-06-30");
  assert.equal(snap?.proxy, true);
  // 定期检查台：proxy 不算交卷
  const inventorySnapshot = snap && !snap._notThisMonth && snap.proxy !== true ? snap : null;
  assert.equal(inventorySnapshot, null);
});

test("monthly asset inventory uses previous month key", () => {
  // 8 月初交的是 7 月末盘点；prev.monthKey = 2026-07
  const prev = previousMonthRange("2026-08-09");
  assert.equal(prev.monthKey, "2026-07");
  const md = `<!-- INFANS_ASSET_SNAPSHOT_JSON_START -->
\`\`\`json
{
  "snapshots": [
    { "date": "2026-07-31", "capturedAt": "2026-08-06", "items": [
      { "category": "银行存款", "name": "示例银行甲（尾号1001）" },
      { "category": "现金/第三方", "name": "支付宝" },
      { "category": "债权资产", "name": "示例借款人甲" }
    ] }
  ]
}
\`\`\`
<!-- INFANS_ASSET_SNAPSHOT_JSON_END -->
大额支付确认（2026-07）：无其他未统计 · 2026-08-09
`;
  const snap = pickMonthAssetSnapshot(md, prev.monthKey);
  assert.equal(snap?._notThisMonth, undefined);
  assert.equal(snap?.date, "2026-07-31");
  const view = matchAssetChecklistSmart(snap);
  assert.ok(view.items.find((item) => item.id === "bank-a")?.present);
  assert.ok(view.items.find((item) => item.id === "alipay")?.present);
  assert.equal(readLargeOtherPaymentConfirm(md, prev.monthKey).present, true);
  assert.equal(readLargeOtherPaymentConfirm(md, "2026-08").present, false);
});

test("freshnessReadyPercent decays with age", () => {
  assert.equal(freshnessReadyPercent("2026-08-09", "2026-08-09"), 100);
  assert.equal(freshnessReadyPercent("2026-08-06", "2026-08-09"), 78);
  assert.equal(freshnessReadyPercent(null, "2026-08-09"), 0);
});

test("buildVerdict levels", () => {
  assert.equal(buildVerdict([{ status: "ok" }, { status: "idle" }], 0).level, "green");
  assert.equal(buildVerdict([{ status: "pending" }], 0).level, "yellow");
  assert.equal(buildVerdict([{ status: "waiting" }], 0).level, "yellow");
  assert.equal(buildVerdict([{ status: "ok" }], 1).level, "red");
  assert.match(buildVerdict([{ status: "failed" }], 0).label, /1 个定时要看/);
  assert.equal(buildVerdict([{ status: "missed" }], 0).level, "red");
});

test("readCronMonitor includes rhythm sections", async () => {
  const snapshot = await readCronMonitor("${INFANS_VAULT_ROOT:-$HOME/Infans_Studio}");
  assert.equal(snapshot.tasks.length, 13);
  assert.ok(snapshot.verdict?.level);
  assert.ok(Array.isArray(snapshot.freshness));
  assert.ok(snapshot.freshness.some((row) => row.id === "apple-health-sync"));
  assert.ok(snapshot.freshness.some((row) => row.id === "apple-activity"));
  assert.ok(snapshot.freshness.some((row) => row.id === "apple-sleep"));
  assert.ok(snapshot.sections?.daily?.tasks.length >= 3);
  assert.ok(snapshot.sections?.weekly?.tasks.length >= 1);
  assert.ok(snapshot.sections?.weekly?.tasks.some((task) => task.id === "japan-activities"));
  assert.ok(snapshot.sections?.quarterly?.tasks.some((task) => task.id === "ai-tools-quarterly"));
  assert.ok(snapshot.sections?.monthly?.tasks.length >= 1);
  assert.ok(snapshot.sections?.monthly?.coverage?.assets?.items?.length >= 10);
  assert.equal(typeof snapshot.summary.materialAlarms, "number");
  assert.equal(snapshot.sections?.monthly?.coverage?.diary, undefined);
  assert.ok(snapshot.sections?.monthly?.coverage?.sleep);
  assert.equal(snapshot.sections?.monthly?.coverage?.sleep?.id, "month-sleep");
  if (snapshot.today === "2026-08-24") {
    const training = snapshot.tasks.find((task) => task.id === "training-review");
    const healthRequirement = training?.requirements.find((row) => row.id === "apple-health");
    const sourceMissing = healthRequirement?.state === "missing";
    assert.equal(training?.status === "waiting", sourceMissing);
    if (sourceMissing) {
      assert.equal(training?.statusLabel, "待健康导入");
      assert.equal(training?.canRerun, false);
    }
    assert.equal(snapshot.freshness.find((row) => row.id === "apple-activity")?.alarm, sourceMissing);
    assert.equal(snapshot.freshness.find((row) => row.id === "apple-sleep")?.alarm, sourceMissing);
  }
});
