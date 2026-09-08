import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAnkiVocabProgress,
  deriveJapaneseStageFromLevels,
  ensureAnkiConnectReady,
  formatAnkiDayReviewsForAi,
  reviewPaceFromReviewDays,
  streakFromReviewDays,
  summarizeAnkiReviewRows,
  tokyoYesterday,
} from "../src/server/workbench-anki.mjs";

test("Anki 今日活动按复习 ID 去重并汇总实际作答耗时", () => {
  const rows = [
    [1001, 11, 0, 3, 0, 0, 0, 30_000],
    [1001, 11, 0, 3, 0, 0, 0, 30_000],
    [1002, 12, 0, 4, 0, 0, 0, 15_000],
  ];
  const result = summarizeAnkiReviewRows(rows);
  assert.equal(result.reviewCount, 2);
  assert.equal(result.durationMinutes, 0.8);
});

test("tokyoYesterday respects Anki 04:00 rollover in Tokyo", () => {
  assert.equal(tokyoYesterday(new Date("2026-08-02T12:00:00+09:00")), "2026-08-01");
  assert.equal(tokyoYesterday(new Date("2026-08-02T03:00:00+09:00")), "2026-07-31");
});

test("streakFromReviewDays skips incomplete today and stops at gaps", () => {
  const byDay = [
    ["2026-08-08", 124],
    ["2026-08-07", 131],
    ["2026-08-06", 148],
    ["2026-08-05", 275],
    ["2026-08-04", 59],
    ["2026-08-02", 15],
  ];
  assert.equal(streakFromReviewDays(byDay, new Date("2026-08-09T14:00:00+09:00")), 5);
  assert.equal(streakFromReviewDays(byDay, new Date("2026-08-08T12:00:00+09:00")), 5);
});

test("reviewPaceFromReviewDays averages seven completed Anki days including zero days", () => {
  const byDay = [
    ["2026-08-23", 0],
    ["2026-08-22", 8],
    ["2026-08-21", 11],
    ["2026-08-20", 254],
    ["2026-08-19", 140],
    ["2026-08-18", 70],
    ["2026-08-17", 35],
  ];
  assert.equal(reviewPaceFromReviewDays(byDay, 7, new Date("2026-08-24T08:00:00+09:00")), 74);
});

test("deriveJapaneseStageFromLevels follows N3 then N2 high", () => {
  assert.match(
    deriveJapaneseStageFromLevels([
      { name: "N3 低频", learned: 150, total: 150 },
      { name: "N2 高频", learned: 40, total: 200 },
    ]),
    /N2 高频推进/,
  );
  assert.match(
    deriveJapaneseStageFromLevels([
      { name: "N3 低频", learned: 120, total: 150 },
      { name: "N2 高频", learned: 0, total: 200 },
    ]),
    /N3 低频收尾/,
  );
});

test("applyAnkiVocabProgress overlays live numbers onto status markdown", () => {
  const base = {
    updatedAt: "2026-08-03",
    stage: "旧阶段",
    progress: { learned: 80, total: 820 },
    queue: 20,
    streak: 12,
    pace7: 8,
    pace14: 7,
    levels: [{ name: "N3 高频", total: 120, learned: 80, status: "进行中" }],
  };
  const next = applyAnkiVocabProgress(base, {
    available: true,
    source: "live",
    updatedAt: "2026-08-09（Anki 实时）",
    stage: "词汇线：N3 已清完，N2 高频推进中。",
    progress: { learned: 100, total: 820 },
    queue: 20,
    streak: 5,
    pace7: 10,
    pace14: 6,
    reviewPace7: 30,
    newCardPace7: 10,
    newCardPace14: 6,
    levels: [{ name: "N2 高频", total: 200, learned: 40, status: "进行中" }],
  });
  assert.equal(next.progress.learned, 100);
  assert.equal(next.streak, 5);
  assert.equal(next.reviewPace7, 30);
  assert.equal(next.newCardPace7, 10);
  assert.match(next.stage, /N2 高频推进/);
  assert.equal(next.ankiSource, "live");
});

test("formatAnkiDayReviewsForAi summarizes offline and online payloads", () => {
  const offline = formatAnkiDayReviewsForAi({ available: false, message: "离线" });
  assert.match(offline, /不可用/);
  const online = formatAnkiDayReviewsForAi({
    available: true,
    day: "2026-08-01",
    reviewCount: 2,
    uniqueCards: 2,
    buttonCounts: { Again: 0, Hard: 1, Good: 0, Easy: 1 },
    byDeck: { "3-N3/3-低频": 2 },
    timeRange: "23:42–23:52",
    hard: [{ word: "終点", reading: "しゅうてん", meaning: "终点", deck: "3-N3/3-低频", button: "Hard" }],
    words: [{ word: "終点", reading: "しゅうてん", meaning: "终点", deck: "3-N3/3-低频", button: "Hard" }],
    truncated: false,
  });
  assert.match(online, /2026-08-01/);
  assert.match(online, /終点/);
  assert.match(online, /Hard 1/);
});

test("ensureAnkiConnectReady does not launch Anki when already connected", async () => {
  let opened = 0;
  const result = await ensureAnkiConnectReady({
    ping: async () => 6,
    openAnki: async () => {
      opened += 1;
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.launched, false);
  assert.equal(opened, 0);
});

test("ensureAnkiConnectReady opens Anki then waits until Connect answers", async () => {
  let opened = 0;
  let pings = 0;
  const result = await ensureAnkiConnectReady({
    ping: async () => {
      pings += 1;
      if (pings < 2) throw new Error("down");
      return 6;
    },
    openAnki: async () => {
      opened += 1;
    },
    waitMs: 40,
    intervalMs: 1,
  });
  assert.equal(result.ready, true);
  assert.equal(result.launched, true);
  assert.equal(opened, 1);
  assert.ok(pings >= 2);
});

test("ensureAnkiConnectReady can skip opening when asked", async () => {
  let opened = 0;
  const result = await ensureAnkiConnectReady({
    ping: async () => {
      throw new Error("down");
    },
    openAnki: async () => {
      opened += 1;
    },
    skipOpen: true,
    waitMs: 0,
    intervalMs: 0,
  });
  assert.equal(result.ready, false);
  assert.equal(result.launched, false);
  assert.equal(opened, 0);
});
