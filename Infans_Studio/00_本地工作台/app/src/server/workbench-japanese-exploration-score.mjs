/**
 * 日语探索成就分与专项掌握状态机。
 * 对外产品名「探索成就」（学习进度看板）；代码字段仍用 exploration。
 * 总分 = 0.4V + 0.4G + 0.2M；分项 = B*(0.7+0.3C)；C = cleared/(active+cleared)。
 * 文法 LV：累计答对 <5 门外汉 / 5–15 入门 / 15–35 掌握 / ≥35 精通。
 * 级别「文法水平」= 该级全部清单点 correctTotal 的算术平均，再套同一阈值。
 */
import {
  JP_MOCK_SNAPSHOT,
  JP_READING_MILEAGE,
  JP_SPECIAL_HISTORY_DIR,
  JP_SPECIAL_MASTERY,
} from "./vault-paths.mjs";

export const SPECIAL_MASTERY_PATH = JP_SPECIAL_MASTERY;
export const MOCK_SNAPSHOT_PATH = JP_MOCK_SNAPSHOT;
export const READING_MILEAGE_PATH = JP_READING_MILEAGE;
export const SPECIAL_HISTORY_DIR = JP_SPECIAL_HISTORY_DIR;

/** index = lv；correctTotal >= threshold 才升到该 lv */
export const LV_THRESHOLDS = [0, 5, 15, 35];

export function lvFromCorrectTotal(correctTotal = 0) {
  const n = Math.max(0, Number(correctTotal) || 0);
  if (n >= 35) return 3;
  if (n >= 15) return 2;
  if (n >= 5) return 1;
  return 0;
}

export function lvLabel(lv = 0) {
  if (lv >= 3) return "精通";
  if (lv === 2) return "掌握";
  if (lv === 1) return "入门";
  return "门外汉";
}

export function lvToScore(lv = 0) {
  if (lv >= 3) return 1;
  if (lv === 2) return 2 / 3;
  if (lv === 1) return 1 / 3;
  return 0;
}

/** C = cleared / (active + cleared)；分母 0 → 1 */
export function clearanceRate(activeCount = 0, clearedCount = 0) {
  const a = Math.max(0, Number(activeCount) || 0);
  const c = Math.max(0, Number(clearedCount) || 0);
  const den = a + c;
  if (den === 0) return 1;
  return c / den;
}

/** 分项 = B * (0.7 + 0.3 * C) */
export function trackPartScore(baseB = 0, clearanceC = 1) {
  const B = Math.min(1, Math.max(0, Number(baseB) || 0));
  const C = Math.min(1, Math.max(0, Number(clearanceC) || 0));
  return B * (0.7 + 0.3 * C);
}

export function explorationTotal(vocabPart = 0, grammarPart = 0, mockPart = 0) {
  return 0.4 * clamp01(vocabPart) + 0.4 * clamp01(grammarPart) + 0.2 * clamp01(mockPart);
}

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}

export function grammarBaseFromMastery(allPointIds = [], masteryItems = {}) {
  if (!allPointIds.length) return 0;
  let sum = 0;
  for (const id of allPointIds) {
    const row = masteryItems[id] || masteryItems[`grammar:${id}`];
    sum += lvToScore(row?.lv ?? lvFromCorrectTotal(row?.correctTotal ?? 0));
  }
  return sum / allPointIds.length;
}

/** 某级全部点的累计答对均分 → 级别文法水平 */
export function averageCorrectTotal(pointIds = [], masteryItems = {}) {
  if (!pointIds.length) return 0;
  let sum = 0;
  for (const id of pointIds) {
    const row = masteryItems[id] || masteryItems[`grammar:${id}`];
    sum += Number(row?.correctTotal) || 0;
  }
  return sum / pointIds.length;
}

export function stageFromAverageCorrect(avgCorrect = 0) {
  const lv = lvFromCorrectTotal(avgCorrect);
  return { lv, label: lvLabel(lv), avgCorrect: Number(avgCorrect) || 0, progress: lvToScore(lv) };
}

export function vocabBaseFromAnki(levels = [], focusLevel = null) {
  const rows = (levels || []).filter((row) => {
    if (!focusLevel) return true;
    return String(row.name || "").toUpperCase().startsWith(String(focusLevel).toUpperCase());
  });
  const pool = rows.length ? rows : levels || [];
  let learned = 0;
  let total = 0;
  for (const row of pool) {
    learned += Number(row.learned) || 0;
    total += Number(row.total) || 0;
  }
  if (!total) return 0;
  return Math.min(1, learned / total);
}

export function mockPartFromSnapshot(snapshot = {}) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions.slice(0, 3) : [];
  if (!sessions.length) return { score: 0, count: 0, ceiling: 0.8 };
  const avg = sessions.reduce((s, item) => s + (Number(item.accuracy) || 0), 0) / sessions.length;
  return { score: clamp01(avg), count: sessions.length, ceiling: 1 };
}

export function applyMasteryAnswer(masteryItems = {}, nodeId, correct) {
  const key = String(nodeId || "").replace(/^grammar:/, "");
  if (!key) return masteryItems;
  const prev = masteryItems[key] || { correctTotal: 0, correctStreak: 0, lv: 0 };
  let correctTotal = Number(prev.correctTotal) || 0;
  let correctStreak = Number(prev.correctStreak) || 0;
  if (correct) {
    correctTotal += 1;
    correctStreak += 1;
  } else {
    correctStreak = 0;
  }
  const lv = lvFromCorrectTotal(correctTotal);
  return {
    ...masteryItems,
    [key]: {
      correctTotal,
      correctStreak,
      lv,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function countMistakeBuckets(mistakeState = {}, level = null, track = null) {
  const items = mistakeState.items || {};
  let active = 0;
  let cleared = 0;
  for (const row of Object.values(items)) {
    if (level && row.level && row.level !== level) continue;
    if (track && row.track && row.track !== track) continue;
    if (row.status === "cleared") cleared += 1;
    else active += 1;
  }
  return { active, cleared };
}

export function countActiveMistakesFromMarkdown(markdown = "") {
  const blocks = String(markdown).split(/^##\s+/m).slice(1);
  return blocks.filter((block) => {
    const title = block.split(/\r?\n/)[0] || "";
    return /｜\s*N[2-5]\s*｜/i.test(title);
  }).length;
}

export function assertMistakeSourcesAligned(mdActiveCount, stateActiveCount) {
  return Number(mdActiveCount) === Number(stateActiveCount);
}
