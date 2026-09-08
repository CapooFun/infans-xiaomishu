import assert from "node:assert/strict";
import test from "node:test";
import { buildJapaneseTodayStudy, hasJapaneseStudyActivity, tokyoPreviousDateKey } from "../src/server/workbench-japanese-today.mjs";

test("最近学习日按东京自然日回退，不受 Anki 凌晨换日规则影响", () => {
  assert.equal(tokyoPreviousDateKey(new Date("2026-08-29T01:30:00+09:00")), "2026-08-28");
});

test("今日学习汇总按口语、Anki、专项、阅读和考试分别记量", () => {
  const result = buildJapaneseTodayStudy({
    date: "2026-08-29",
    oralSessions: [
      { date: "2026-08-29", durationMinutes: 55, estimated: true },
      { date: "2026-08-28", durationMinutes: 20, estimated: false },
    ],
    ankiActivity: { available: true, day: "2026-08-29", durationMinutes: 23, reviewCount: 368, source: "live" },
    examSessions: [
      { at: "2026-08-29 18:00", level: "N2", track: "mistake", durationMinutes: 10, correct: 4, total: 5 },
      { at: "2026-08-29 19:00", level: "N2", track: "reading", durationMinutes: 12, correct: 8, total: 10 },
      { at: "2026-08-29 20:00", level: "N2", track: "full", durationMinutes: 18, correct: 4, total: 6 },
    ],
  });
  assert.equal(result.totalDurationMinutes, 118);
  assert.deepEqual(result.oral, { durationMinutes: 55, sessionCount: 1, estimated: true });
  assert.equal(result.anki.reviewCount, 368);
  assert.equal(result.special.label, "N2 错题");
  assert.equal(result.special.correct, 4);
  assert.equal(result.reading.label, "N2 阅读");
  assert.equal(result.reading.correct, 8);
  assert.equal(result.exam.label, "N2 练习");
  assert.equal(result.exam.correct, 4);
  assert.equal(hasJapaneseStudyActivity(result), true);
});

test("非同日测试不混入当前学习日", () => {
  const result = buildJapaneseTodayStudy({
    date: "2026-08-29",
    oralSessions: [{ date: "2026-08-29", durationMinutes: 55, estimated: false }],
    examSessions: [{ at: "2026-08-03 15:42", level: "N2", track: "bank_quiz", correct: 2, total: 6, durationMinutes: null }],
  });
  assert.equal(result.totalDurationMinutes, 55);
  assert.equal(result.exam, null);
  const examOnly = buildJapaneseTodayStudy({
    date: "2026-08-29",
    examSessions: [{ at: "2026-08-03 15:42", level: "N2", track: "bank_quiz", correct: 2, total: 6 }],
  });
  assert.equal(hasJapaneseStudyActivity(examOnly), false);
});

test("没有来源记录时四个来源都保持空值", () => {
  const result = buildJapaneseTodayStudy({ date: "2026-08-29" });
  assert.equal(result.special, null);
  assert.equal(result.reading, null);
  assert.equal(result.exam, null);
  assert.equal(result.totalDurationMinutes, 0);
  assert.equal(hasJapaneseStudyActivity(result), false);
});
