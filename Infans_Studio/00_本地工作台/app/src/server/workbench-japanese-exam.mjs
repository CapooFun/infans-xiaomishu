import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parseGrammarChecklist } from "./workbench-grammar.mjs";
import { SOURCES } from "./workbench-data.mjs";
import {
  EXPLORATION_MISTAKE_STATE_PATH,
  activeMistakeNodeIds,
  applyMistakeStreaks,
  composeMistakeQuiz,
  composeSpecialGrammarQuiz,
  loadMistakeState,
  loadStoredQuestionsByNode,
  saveMistakeState,
  saveSpecialHistory,
} from "./workbench-japanese-exam-modes.mjs";
import {
  SPECIAL_MASTERY_PATH,
  MOCK_SNAPSHOT_PATH,
  READING_MILEAGE_PATH,
  applyMasteryAnswer,
  assertMistakeSourcesAligned,
  averageCorrectTotal,
  clearanceRate,
  countActiveMistakesFromMarkdown,
  countMistakeBuckets,
  explorationTotal,
  grammarBaseFromMastery,
  mockPartFromSnapshot,
  stageFromAverageCorrect,
  trackPartScore,
  vocabBaseFromAnki,
  lvToScore,
} from "./workbench-japanese-exploration-score.mjs";
import { buildJapaneseCourseProgress } from "./workbench-japanese-course-progress.mjs";

import { JP_EXAM_SKILL, JP_EXPLORATION_PROGRESS, JP_MISTAKES } from "./vault-paths.mjs";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";

export const EXPLORATION_PROGRESS_PATH = JP_EXPLORATION_PROGRESS;
export const EXPLORATION_MISTAKES_PATH = JP_MISTAKES;
export const EXAM_SKILL_PATH = JP_EXAM_SKILL;
export { EXPLORATION_MISTAKE_STATE_PATH, SPECIAL_MASTERY_PATH, MOCK_SNAPSHOT_PATH };

const LEVELS = ["N5", "N4", "N3", "N2"];
const GRAMMAR_SOURCES = {
  N5: SOURCES.grammarN5,
  N4: SOURCES.grammarN4,
  N3: SOURCES.grammarN3,
  N2: SOURCES.grammarN2,
};

const EXAM_MODES = [
  { kind: "special", label: "专项练习", blurb: "就地多选级别开考" },
  { kind: "mistake", label: "错题练习", blurb: "重做错题" },
];

const examSessions = new Map();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function tokyoStamp(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(",", "");
}

async function readText(root, relativePath) {
  try {
    return await fs.readFile(path.join(root, relativePath), "utf8");
  } catch {
    return "";
  }
}

async function readJson(root, relativePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(root, relativePath, data) {
  await withVaultFileWrite(root, relativePath, async (absolute) => {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  });
}

export function parseExplorationProgress(markdown = "") {
  const nodeTier = new Map();
  const sessions = [];
  const blocks = String(markdown).split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const title = lines[0]?.trim() || "";
    const match = title.match(/^(.*?)\s*｜\s*(N[2-5])\s*｜\s*(\S+)\s*｜\s*(\d+)\s*\/\s*(\d+)/i)
      || title.match(/^(.*?)\s*｜\s*(N[2-5])\s*｜\s*(\S+)/i);
    if (!match) continue;
    const level = match[2].toUpperCase();
    const track = match[3].toLowerCase();
    const correct = match[4] ? Number(match[4]) : null;
    const total = match[5] ? Number(match[5]) : null;
    const body = lines.slice(1).join("\n");
    const durationRaw = body.match(/\*\*用时\*\*[：:]\s*([^\n]+)/)?.[1] || "";
    const seconds = Number(durationRaw.match(/(\d+(?:\.\d+)?)\s*秒/)?.[1] || 0);
    const minutes = Number(durationRaw.match(/(\d+(?:\.\d+)?)\s*分(?:钟)?/)?.[1] || 0);
    const durationMinutes = minutes || seconds ? Math.round((minutes + seconds / 60) * 10) / 10 : null;
    const verified = [...body.matchAll(/\*\*已验\*\*[：:]\s*([^\n]+)/g)].flatMap((m) => m[1].split(/[,，、\s]+/)).map((s) => s.trim()).filter(Boolean);
    const missed = [...body.matchAll(/\*\*未过\*\*[：:]\s*([^\n]+)/g)].flatMap((m) => m[1].split(/[,，、]/).map((s) => s.replace(/（[^）]*）|\([^)]*\)/g, "").trim()).filter(Boolean));
    for (const id of verified) {
      const key = `${level}:${track}:${id}`;
      if (!nodeTier.has(key) || nodeTier.get(key) < 2) nodeTier.set(key, 2);
    }
    for (const id of missed) {
      const key = `${level}:${track}:${id}`;
      if (!nodeTier.has(key)) nodeTier.set(key, 1);
    }
    sessions.push({ at: match[1], level, track, correct, total, durationMinutes, verified, missed });
  }
  return { nodeTier, sessions };
}

export function parseExplorationMistakes(markdown = "") {
  const items = [];
  const blocks = String(markdown).split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const title = lines[0]?.trim() || "";
    const match = title.match(/^(.*?)\s*｜\s*(N[2-5])\s*｜\s*(vocab|grammar|reading|listening|special|mistake|bank_quiz)\s*｜\s*(\S+)/i);
    if (!match) continue;
    items.push({
      at: match[1],
      level: match[2].toUpperCase(),
      track: match[3].toLowerCase(),
      nodeId: match[4],
      body: lines.slice(1).join("\n"),
    });
  }
  return items;
}

async function loadGrammarPoints(root, level) {
  const source = GRAMMAR_SOURCES[level];
  if (!source) return [];
  const markdown = await readText(root, source);
  const parsed = parseGrammarChecklist(markdown, level);
  return parsed.groups.flatMap((group) => group.points);
}

async function loadAllGrammarIds(root) {
  const ids = [];
  for (const level of LEVELS) {
    const points = await loadGrammarPoints(root, level);
    ids.push(...points.map((point) => point.id));
  }
  return ids;
}

export async function buildJapaneseExploration(root, japaneseSection) {
  const [progressMd, mistakesMd, skill, mistakeState, mastery, mockSnap, readingMileage, courseProgress] = await Promise.all([
    readText(root, EXPLORATION_PROGRESS_PATH),
    readText(root, EXPLORATION_MISTAKES_PATH),
    readText(root, EXAM_SKILL_PATH),
    loadMistakeState(root),
    readJson(root, SPECIAL_MASTERY_PATH, { items: {} }),
    readJson(root, MOCK_SNAPSHOT_PATH, { sessions: [] }),
    readJson(root, READING_MILEAGE_PATH, { totalPassages: 0, totalQuestions: 0, recent7Days: [] }),
    buildJapaneseCourseProgress(root),
  ]);

  const { sessions } = parseExplorationProgress(progressMd);
  const recentMistakes = parseExplorationMistakes(mistakesMd);
  const mdActive = countActiveMistakesFromMarkdown(mistakesMd);
  const stateActive = Object.values(mistakeState.items || {}).filter((item) => item.status === "active").length;
  const aligned = assertMistakeSourcesAligned(mdActive, stateActive);

  const allGrammarIds = await loadAllGrammarIds(root);
  const masteryItems = mastery.items || mastery;
  const B_g = grammarBaseFromMastery(allGrammarIds, masteryItems);
  const B_v = vocabBaseFromAnki(japaneseSection?.levels || []);
  const vocabBucket = countMistakeBuckets(mistakeState, null, "vocab");
  const grammarBucket = countMistakeBuckets(mistakeState, null, "grammar");
  // also count special/mistake tracks that are grammar node ids
  const grammarActiveExtra = Object.values(mistakeState.items || {}).filter((item) => item.status === "active" && (item.track === "special" || item.track === "grammar")).length;
  const grammarClearedExtra = Object.values(mistakeState.items || {}).filter((item) => item.status === "cleared" && (item.track === "special" || item.track === "grammar")).length;
  const C_v = clearanceRate(vocabBucket.active, vocabBucket.cleared);
  const C_g = clearanceRate(Math.max(grammarBucket.active, grammarActiveExtra), Math.max(grammarBucket.cleared, grammarClearedExtra));
  const V = trackPartScore(B_v, C_v);
  const G = trackPartScore(B_g, C_g);
  const mock = mockPartFromSnapshot(mockSnap);
  const total = explorationTotal(V, G, mock.score);

  const grammarDetail = {};
  for (const level of LEVELS) {
    const points = await loadGrammarPoints(root, level);
    const source = GRAMMAR_SOURCES[level];
    const parsed = parseGrammarChecklist(await readText(root, source), level);
    const groups = parsed.groups.map((group) => ({
      id: group.id,
      title: group.title,
      points: group.points.map((point) => {
        const row = masteryItems[point.id] || {};
        const lv = row.lv || 0;
        return {
          id: point.id,
          title: point.title,
          lv,
          correctTotal: row.correctTotal || 0,
          score: lvToScore(lv),
          evidence: lv ? `LV${lv} · 累计对 ${row.correctTotal || 0}` : null,
        };
      }),
    }));
    const lit = groups.reduce((n, g) => n + g.points.filter((p) => p.lv > 0).length, 0);
    const pointIds = groups.flatMap((g) => g.points.map((p) => p.id));
    const avgCorrect = averageCorrectTotal(pointIds, masteryItems);
    const stage = stageFromAverageCorrect(avgCorrect);
    grammarDetail[level] = {
      total: points.length,
      lit,
      verified: groups.reduce((n, g) => n + g.points.filter((p) => p.lv >= 2).length, 0),
      avgCorrect: stage.avgCorrect,
      stageLv: stage.lv,
      stageLabel: stage.label,
      stageProgress: stage.progress,
      groups,
      cells: groups.flatMap((g) => g.points),
    };
  }

  const levels = LEVELS.map((level) => {
    const ankiRows = (japaneseSection?.levels || []).filter((row) => String(row.name || "").toUpperCase().startsWith(level));
    let learned = 0;
    let totalCards = 0;
    for (const row of ankiRows) {
      learned += Number(row.learned) || 0;
      totalCards += Number(row.total) || 0;
    }
    const detail = grammarDetail[level];
    const vocabRatio = totalCards ? learned / totalCards : 0;
    return {
      level,
      vocab: {
        tier: totalCards ? (vocabRatio >= 0.85 ? 2 : learned > 0 ? 1 : 0) : 0,
        learned,
        total: totalCards || null,
        progress: vocabRatio,
        label: totalCards ? `${learned}/${totalCards}` : "—",
      },
      grammar: {
        tier: detail.stageLv,
        lit: detail.lit,
        verified: detail.verified,
        total: detail.total,
        avgCorrect: detail.avgCorrect,
        stageLabel: detail.stageLabel,
        progress: detail.stageProgress,
        label: `${detail.stageLabel} · 均 ${detail.avgCorrect.toFixed(1)} 次`,
      },
      reading: {
        tier: 0,
        milestones: [],
        label: "练习栏 · 不计入探索成就",
      },
    };
  });

  return {
    courseProgress,
    levels,
    grammarDetail,
    recentSessions: sessions.slice(0, 12),
    studySessions: [
      ...sessions,
      ...(mockSnap.sessions || []).map((item) => ({
        at: item.at || "",
        level: item.level || "N2",
        track: "full",
        correct: item.correct ?? null,
        total: item.total ?? null,
        durationMinutes: item.durationMinutes ?? null,
        verified: [],
        missed: [],
      })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20),
    recentMistakes: recentMistakes.slice(0, 40),
    paths: {
      progress: EXPLORATION_PROGRESS_PATH,
      mistakes: EXPLORATION_MISTAKES_PATH,
      skill: EXAM_SKILL_PATH,
      mistakeState: EXPLORATION_MISTAKE_STATE_PATH,
      mastery: SPECIAL_MASTERY_PATH,
      mockSnapshot: MOCK_SNAPSHOT_PATH,
    },
    skillAvailable: Boolean(skill.trim()),
    suggestedDefault: { level: "N2", track: "special", label: "N2 专项练习" },
    examModes: EXAM_MODES,
    scores: {
      total,
      vocab: V,
      grammar: G,
      mock: mock.score,
      vocabBase: B_v,
      grammarBase: B_g,
      vocabClearance: C_v,
      grammarClearance: C_g,
      mockCount: mock.count,
      ceiling: mock.count ? 1 : 0.8,
      mistakeAligned: aligned,
      mdActiveMistakes: mdActive,
      stateActiveMistakes: stateActive,
    },
    readingMileage: {
      totalPassages: readingMileage.totalPassages || 0,
      totalQuestions: readingMileage.totalQuestions || 0,
      recent7Days: readingMileage.recent7Days || [],
    },
    masterySummary: {
      pointCount: allGrammarIds.length,
      practiced: Object.keys(masteryItems).filter((id) => (masteryItems[id]?.lv || 0) > 0).length,
    },
  };
}

export function suggestExamScope(context = {}) {
  const level = LEVELS.includes(context.level) ? context.level : "N2";
  const kind = ["special", "mistake"].includes(context.kind) ? context.kind : "special";
  const labels = {
    special: `${level} 专项练习`,
    mistake: `${level} 错题练习`,
  };
  return {
    mode: kind,
    level,
    track: kind === "special" ? "grammar" : "mistake",
    label: labels[kind],
    kind,
    alternatives: EXAM_MODES.map((mode) => ({ ...mode, level })),
  };
}

function pruneSessionMap() {
  const now = Date.now();
  for (const [id, session] of examSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) examSessions.delete(id);
  }
}

export async function startJapaneseExam(root, japaneseSection, payload = {}, options = {}) {
  pruneSessionMap();
  const kind = ["special", "mistake"].includes(payload.kind) ? payload.kind : "special";
  if (payload.kind === "formal" || payload.kind === "bank_quiz" || payload.kind === "reading") {
    throw Object.assign(new Error("开源版不含真题练习和真题阅读"), { status: 404 });
  }
  const suggestion = suggestExamScope({ ...payload.context, kind, level: payload.level });
  const level = LEVELS.includes(payload.level) ? payload.level : suggestion.level;
  const levels = Array.isArray(payload.levels)
    ? payload.levels.map(String).filter((item) => LEVELS.includes(item))
    : [];

  let questions = [];
  let notes = [];
  let label = "";
  let track = "grammar";
  let timeLimitSeconds = 10 * 60;
  let pointIds = Array.isArray(payload.pointIds) ? payload.pointIds.map(String) : [];

  if (kind === "mistake") {
    const selectedLevels = levels.length ? levels : LEVELS;
    const exploration = await buildJapaneseExploration(root, japaneseSection);
    const state = await loadMistakeState(root);
    const activeIds = new Set(activeMistakeNodeIds(state, selectedLevels));
    const activeMistakes = exploration.recentMistakes.filter((item) => activeIds.has(item.nodeId));
    const stored = await loadStoredQuestionsByNode(root);
    const composed = composeMistakeQuiz({
      mistakes: activeMistakes,
      storedByNode: stored,
      levels: selectedLevels,
    });
    questions = composed.questions;
    notes = composed.meta.notes || [];
    label = `错题练习 · ${selectedLevels.join("、")}`;
    track = "mistake";
    if (composed.meta.empty) {
      throw Object.assign(new Error("所选级别没有能重做的错题（需要已记下的原题）"), { status: 400 });
    }
  } else {
    const selectedLevels = levels.length ? levels : [level];
    let points = [];
    if (pointIds.length) {
      const wanted = new Set(pointIds);
      const all = [];
      for (const lv of LEVELS) all.push(...await loadGrammarPoints(root, lv));
      points = all.filter((point) => wanted.has(point.id));
    } else {
      const pool = [];
      for (const lv of selectedLevels) pool.push(...await loadGrammarPoints(root, lv));
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      points = shuffled.slice(0, Math.min(10, shuffled.length));
      notes.push(`按级别 ${selectedLevels.join("、")} 随机抽 ${points.length} 卡`);
    }
    pointIds = points.map((point) => point.id);
    if (!points.length) {
      throw Object.assign(new Error("请先选择级别或文法卡片"), { status: 400 });
    }
    const composed = composeSpecialGrammarQuiz(points);
    questions = composed.questions;
    notes = [...notes, ...(composed.meta.notes || [])];
    label = `专项练习 · ${pointIds.length} 卡`;
    track = "special";
  }

  const id = crypto.randomBytes(8).toString("hex");
  const publicQuestions = questions.map(({ answer, explanation, ...rest }) => rest);
  const session = {
    id,
    createdAt: Date.now(),
    level: levels[0] || level,
    track,
    mode: kind,
    kind,
    label,
    notes,
    timeLimitSeconds,
    questions,
    pointIds,
    levels,
    status: "active",
    suggestion,
    countsTowardExploration: kind !== "reading",
  };
  examSessions.set(id, session);

  if (options.persistHistory !== false) {
    await saveSpecialHistory(root, id, {
      sessionId: id,
      kind,
      level: session.level,
      levels,
      track,
      pointIds,
      questions,
      createdAt: new Date().toISOString(),
    });
  }

  return {
    sessionId: id,
    kind,
    level: session.level,
    levels,
    track,
    mode: kind,
    label,
    notes,
    timeLimitSeconds,
    suggestion,
    pointIds,
    questionCount: publicQuestions.filter((item) => item.type === "mcq").length,
    questions: publicQuestions,
  };
}

export function getJapaneseExamSession(sessionId) {
  pruneSessionMap();
  const session = examSessions.get(sessionId);
  if (!session) return null;
  return {
    sessionId: session.id,
    kind: session.kind,
    level: session.level,
    track: session.track,
    mode: session.mode,
    label: session.label,
    notes: session.notes || [],
    timeLimitSeconds: session.timeLimitSeconds || 600,
    status: session.status,
    result: session.result || null,
    questions: session.questions.map(({ answer, explanation, ...rest }) => rest),
  };
}

export function gradeJapaneseExam(sessionId, answers = {}) {
  const session = examSessions.get(sessionId);
  if (!session) throw Object.assign(new Error("考试会话不存在或已过期"), { status: 404 });
  const mcqs = session.questions.filter((item) => item.type === "mcq");
  let correct = 0;
  const details = [];
  const verified = [];
  const missed = [];
  for (const question of mcqs) {
    const given = String(answers[question.id] ?? "").trim();
    const ok = given === question.answer;
    if (ok) {
      correct += 1;
      verified.push(...question.nodeIds);
    } else {
      missed.push(...question.nodeIds);
      details.push({ id: question.id, nodeIds: question.nodeIds, given, answer: question.answer, prompt: question.prompt.slice(0, 120) });
    }
  }
  const uniqueVerified = [...new Set(verified)];
  const uniqueMissed = [...new Set(missed)].filter((id) => !uniqueVerified.includes(id));
  const stamp = tokyoStamp();
  const basisMap = {
    bank_quiz: "词汇小测（工作台）",
    mistake: "错题练习（工作台）",
    special: "专项练习（工作台）",
    reading: "阅读短练（不计入探索成就）",
  };
  const basis = basisMap[session.kind] || "工作台测验";
  const trackLabel = session.track;
  const durationMinutes = Math.max(0.1, Math.round((Date.now() - session.createdAt) / 6000) / 10);
  const progressBlock = [
    `## ${stamp} ｜ ${session.level} ｜ ${trackLabel} ｜ ${correct}/${mcqs.length}`,
    "",
    `- **已验**：${uniqueVerified.join(", ") || "—"}`,
    `- **未过**：${uniqueMissed.map((id) => {
      const hit = details.find((item) => item.nodeIds.includes(id));
      return hit ? `${id}（答 ${hit.given || "空"}）` : id;
    }).join("、") || "—"}`,
    `- **依据**：${basis}`,
    `- **用时**：${durationMinutes} 分钟`,
    "",
  ].join("\n");

  const mistakeBlocks = details.map((item) => [
    `## ${stamp} ｜ ${session.level} ｜ ${trackLabel === "special" ? "grammar" : trackLabel} ｜ ${item.nodeIds[0] || item.id}`,
    "",
    `- **错因**：选了「${item.given || "未答"}」，正解「${item.answer}」`,
    `- **题摘要**：${item.prompt.replace(/\n/g, " ")}`,
    "- **复查**：回看该节点释义与例句后重考",
    "- **连续答对**：0/2",
    "",
  ].join("\n")).join("\n");

  const result = {
    sessionId: session.id,
    kind: session.kind,
    level: session.level,
    track: trackLabel,
    label: session.label,
    notes: session.notes || [],
    correct,
    total: mcqs.length,
    durationMinutes,
    uniqueVerified,
    uniqueMissed,
    details,
    progressBlock,
    mistakeBlocks,
    progressPath: EXPLORATION_PROGRESS_PATH,
    mistakesPath: EXPLORATION_MISTAKES_PATH,
    mistakeStatePath: EXPLORATION_MISTAKE_STATE_PATH,
    countsTowardExploration: session.countsTowardExploration !== false && session.kind !== "reading",
    pointIds: session.pointIds || [],
    answerMap: Object.fromEntries(mcqs.map((q) => {
      const given = String(answers[q.id] ?? "").trim();
      return [q.id, { given, correct: given === q.answer, nodeIds: q.nodeIds }];
    })),
  };
  session.status = "graded";
  session.result = result;
  return result;
}

export async function readExamSkill(root) {
  return readText(root, EXAM_SKILL_PATH);
}

async function appendMarkdownSection(root, relativePath, section) {
  if (!section?.trim()) return;
  await withVaultFileWrite(root, relativePath, async (absolute) => {
    let existing = "";
    try {
      existing = await fs.readFile(absolute, "utf8");
    } catch {
      existing = "";
    }
    // drop empty placeholder
    existing = existing.replace(/（暂无活跃错题。）\n?/g, "").replace(/（尚无正式全卷或专项摘要。）\n?/g, "");
    const parts = existing.split(/^##\s+/m);
    const header = parts[0] || "";
    const body = parts.slice(1).map((block) => `## ${block}`.trimEnd());
    const next = `${header.trimEnd()}\n\n${section.trim()}\n\n${body.join("\n\n")}`.trim() + "\n";
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, next, "utf8");
  });
}

export async function commitExamEvidence(root, result) {
  const written = [];
  if (result.countsTowardExploration !== false) {
    await appendMarkdownSection(root, EXPLORATION_PROGRESS_PATH, result.progressBlock);
    written.push(EXPLORATION_PROGRESS_PATH);
  }

  const mistakeTrack = result.track === "special" ? "grammar" : result.track;
  if (result.mistakeBlocks && result.uniqueMissed.length) {
    await appendMarkdownSection(root, EXPLORATION_MISTAKES_PATH, result.mistakeBlocks);
    written.push(EXPLORATION_MISTAKES_PATH);
  }

  const state = await loadMistakeState(root);
  const streak = applyMistakeStreaks(state, {
    level: result.level,
    track: mistakeTrack === "bank_quiz" ? "vocab" : mistakeTrack === "mistake" ? "grammar" : mistakeTrack,
    verifiedIds: result.uniqueVerified,
    missedIds: result.uniqueMissed,
    stamp: tokyoStamp(),
  });
  await saveMistakeState(root, streak.state);
  written.push(EXPLORATION_MISTAKE_STATE_PATH);

  // mastery updates for special / grammar nodes
  if (result.kind === "special" || result.track === "special") {
    const mastery = await readJson(root, SPECIAL_MASTERY_PATH, { version: 1, items: {} });
    let items = { ...(mastery.items || {}) };
    for (const [qid, row] of Object.entries(result.answerMap || {})) {
      for (const nodeId of row.nodeIds || []) {
        if (!/^N[2-5]-/.test(nodeId)) continue;
        items = applyMasteryAnswer(items, nodeId, row.correct);
      }
    }
    await writeJson(root, SPECIAL_MASTERY_PATH, { version: 1, items, updatedAt: new Date().toISOString() });
    written.push(SPECIAL_MASTERY_PATH);
  }

  if (result.kind === "reading") {
    const mileage = await readJson(root, READING_MILEAGE_PATH, { version: 1, totalPassages: 0, totalQuestions: 0, recent7Days: [] });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
    mileage.totalQuestions = (mileage.totalQuestions || 0) + (result.total || 0);
    mileage.totalPassages = (mileage.totalPassages || 0) + Math.max(1, Math.floor((result.total || 0) / 1));
    const recent = Array.isArray(mileage.recent7Days) ? mileage.recent7Days.filter((d) => d !== day) : [];
    recent.unshift(day);
    mileage.recent7Days = recent.slice(0, 7);
    await writeJson(root, READING_MILEAGE_PATH, mileage);
    written.push(READING_MILEAGE_PATH);
  }

  const session = examSessions.get(result.sessionId);
  if (session) {
    const historyPath = await saveSpecialHistory(root, result.sessionId, {
      sessionId: result.sessionId,
      kind: session.kind,
      level: session.level,
      levels: session.levels || [],
      track: session.track,
      pointIds: session.pointIds || [],
      questions: session.questions,
      createdAt: new Date(session.createdAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMinutes: result.durationMinutes,
      result: {
        correct: result.correct,
        total: result.total,
        verifiedNodeIds: result.uniqueVerified,
        missedNodeIds: result.uniqueMissed,
      },
    });
    written.push(path.relative(root, historyPath).split(path.sep).join("/"));
  }

  return { written, paths: written, clearedMistakes: streak.cleared };
}

/** 登记正式全卷快照（粘贴分析或显式提交）。 */
export async function registerMockSnapshot(root, payload = {}) {
  const snap = await readJson(root, MOCK_SNAPSHOT_PATH, { version: 1, sessions: [] });
  const accuracy = Number(payload.accuracy);
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) {
    throw Object.assign(new Error("accuracy 须为 0–1"), { status: 400 });
  }
  const entry = {
    at: payload.at || tokyoStamp(),
    sitting: payload.sitting || "unknown",
    accuracy,
    correct: payload.correct == null ? null : Number(payload.correct),
    total: payload.total == null ? null : Number(payload.total),
    durationMinutes: payload.durationMinutes == null ? null : Number(payload.durationMinutes),
    language: payload.language ?? null,
    reading: payload.reading ?? null,
    listening: payload.listening ?? null,
    source: payload.source || "paste",
  };
  const sessions = [entry, ...(snap.sessions || [])].slice(0, 3);
  await writeJson(root, MOCK_SNAPSHOT_PATH, { version: 1, sessions, updatedAt: new Date().toISOString() });
  return { sessions, mock: mockPartFromSnapshot({ sessions }) };
}

export function parseMockAnalysisMarkdown(text = "") {
  const sitting = text.match(/场次[：:]\s*(\S+)/)?.[1] || null;
  const total = text.match(/全卷原始正确率[：:]\s*(\d+)\s*\/\s*(\d+)/);
  const lang = text.match(/言語知識[：:]\s*(\d+)\s*\/\s*(\d+)/);
  const reading = text.match(/読解[：:]\s*(\d+)\s*\/\s*(\d+)/);
  const listening = text.match(/聴解[：:]\s*(\d+)\s*\/\s*(\d+)/);
  const ratio = (m) => (m && Number(m[2]) ? Number(m[1]) / Number(m[2]) : null);
  const clockMinutes = (value) => {
    if (!value) return null;
    const parts = value.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    const seconds = parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
    return Math.round(seconds / 6) / 10;
  };
  const quickDuration = clockMinutes(text.match(/(?:^|\n)\s*-?\s*用时[：:]\s*(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1]);
  const textDuration = clockMinutes(text.match(/言語知識・読解用时[：:]\s*(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1]);
  const listeningDuration = clockMinutes(text.match(/聴解用时[：:]\s*(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1]);
  const durationMinutes = quickDuration ?? (
    textDuration != null || listeningDuration != null
      ? Math.round(((textDuration || 0) + (listeningDuration || 0)) * 10) / 10
      : null
  );
  let accuracy = ratio(total);
  if (accuracy == null && lang && reading && listening) {
    const c = Number(lang[1]) + Number(reading[1]) + Number(listening[1]);
    const t = Number(lang[2]) + Number(reading[2]) + Number(listening[2]);
    accuracy = t ? c / t : null;
  }
  return {
    sitting,
    accuracy,
    correct: total ? Number(total[1]) : null,
    total: total ? Number(total[2]) : null,
    durationMinutes,
    language: ratio(lang),
    reading: ratio(reading),
    listening: ratio(listening),
  };
}
