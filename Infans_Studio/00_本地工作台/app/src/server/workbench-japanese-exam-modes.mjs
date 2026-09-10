import fs from "node:fs/promises";
import path from "node:path";
import { JP_MISTAKE_STATE, JP_SPECIAL_HISTORY_DIR } from "./vault-paths.mjs";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";

export const EXPLORATION_MISTAKE_STATE_PATH = JP_MISTAKE_STATE;
export const SPECIAL_HISTORY_DIR = JP_SPECIAL_HISTORY_DIR;

export function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function mcq(id, prompt, choices, answer, nodeIds, explanation) {
  return { id, type: "mcq", prompt, choices, answer, nodeIds, explanation };
}

export function resolveExamHallUrl() {
  return "";
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** 开源版不含 JLPT 真题包，也不去本机题库目录找。 */
export async function loadJlptBankPool(level = "N2") {
  return {
    language: [],
    reading: [],
    grammarTagged: [],
    notes: [`开源版不含 ${level} 真题包。`],
    contentRoot: "",
  };
}

export function composeBankQuizQuestions(pool, { mcqCount = 5 } = {}) {
  const language = shuffle(pool.language || []).slice(0, mcqCount);
  const readingHit = shuffle(pool.reading || [])[0] || null;
  const questions = language.map((item, index) => mcq(
    `b-mcq-${index + 1}`,
    item.prompt,
    item.choices.includes(item.answer) ? item.choices : shuffle([item.answer, ...item.choices]).slice(0, 4),
    item.answer,
    [item.nodeId],
    item.explanation,
  ));

  if (readingHit) {
    questions.push({
      id: "b-pass",
      type: "passage",
      prompt: readingHit.material,
      choices: [],
      answer: "",
      nodeIds: [readingHit.nodeId],
      explanation: "",
    });
    questions.push(mcq(
      "b-read-1",
      readingHit.prompt,
      readingHit.choices.includes(readingHit.answer)
        ? readingHit.choices
        : shuffle([readingHit.answer, ...readingHit.choices]).slice(0, 4),
      readingHit.answer,
      [readingHit.nodeId],
      readingHit.explanation,
    ));
  }

  return {
    questions,
    meta: {
      languageCount: language.length,
      hasReading: Boolean(readingHit),
      notes: pool.notes || [],
      degraded: language.length < mcqCount || !readingHit,
    },
  };
}

export function composeMistakeQuiz({ mistakes = [], storedByNode = {}, level = null, levels = null } = {}) {
  const allow = Array.isArray(levels) && levels.length
    ? new Set(levels)
    : level
      ? new Set([level])
      : null;
  const levelMistakes = mistakes.filter((item) => !allow || allow.has(item.level));
  const questions = [];
  const notes = ["错题练习 · 只做还没清掉的错题"];
  let skipped = 0;

  for (const item of shuffle(levelMistakes)) {
    const stored = storedByNode[item.nodeId];
    if (stored?.prompt && stored?.choices?.length >= 2 && stored?.answer) {
      questions.push(mcq(
        `m-${questions.length + 1}`,
        `【重做错题】\n${stored.prompt}`,
        shuffle([...stored.choices]).slice(0, 4),
        stored.answer,
        [item.nodeId],
        stored.explanation || `错题 · ${item.nodeId}`,
      ));
      continue;
    }
    skipped += 1;
  }
  if (skipped) notes.push(`跳过 ${skipped} 条无落盘原题的错题（不做假干扰）`);
  if (allow) notes.push(`级别：${[...allow].join("、")}`);

  return {
    questions,
    meta: {
      notes,
      mistakeCount: levelMistakes.length,
      skipped,
      degraded: false,
      empty: questions.length === 0,
    },
  };
}

export function composeSpecialGrammarQuiz(points = [], { degradedLabel = "降级模板 · 清单例句挖空" } = {}) {
  const selected = points.filter((point) => point.meaning || point.examples?.length || point.connection);
  const pool = selected.length ? selected : points;
  const questions = pool.map((point, index) => {
    const distractors = shuffle(points.filter((item) => item.id !== point.id)).slice(0, 3);
    while (distractors.length < 3) distractors.push({ title: "以上でもない", meaning: "—" });
    if (point.examples?.[0]) {
      const blanked = point.examples[0].replace(point.title.replace(/^〜/, ""), "（　　）").slice(0, 160);
      const choices = shuffle([point.title, ...distractors.map((item) => item.title)]).slice(0, 4);
      return mcq(`s-${index + 1}`, `次の文の（　　）に入るものはどれか。\n${blanked}`, choices, point.title, [point.id], point.meaning || point.connection);
    }
    const answer = point.meaning || point.connection || point.title;
    const choices = shuffle([answer, ...distractors.map((item) => item.meaning || item.title)]).slice(0, 4);
    return mcq(`s-${index + 1}`, `「${point.title}」の意味として最も近いものはどれか。`, choices, answer, [point.id], point.connection || "");
  });

  return {
    questions,
    meta: {
      notes: [degradedLabel, `选中 ${points.length} 卡 · 出题 ${questions.length}`],
      degraded: true,
      pointIds: points.map((point) => point.id),
    },
  };
}

function stripMdPreview(text = "", max = 140) {
  return String(text)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function passageTitleFromMaterial(material = "", section = "", mondai = "") {
  const heading = String(material).match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  if (section) return String(section);
  return mondai ? `第 ${mondai} 大题` : "阅读";
}

function passageIdFor(sitting, mondai, firstQuestionId) {
  return `${sitting}__m${mondai}__q${firstQuestionId}`;
}

function groupReadingItems(readingItems = []) {
  const groups = new Map();
  for (const item of readingItems) {
    const key = `${item.sitting}::${item.mondai}::${item.material}`;
    if (!groups.has(key)) {
      groups.set(key, {
        sitting: item.sitting,
        mondai: item.mondai,
        section: item.section || (item.mondai != null ? `問題${item.mondai}` : ""),
        instruction: item.instruction || "",
        material: item.material,
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }
  return [...groups.values()].map((group) => {
    const sorted = [...group.items].sort((a, b) => Number(a.questionId || 0) - Number(b.questionId || 0));
    const firstId = sorted[0]?.questionId || sorted[0]?.id;
    const id = passageIdFor(group.sitting, group.mondai, firstId);
    return {
      id,
      sitting: group.sitting,
      mondai: group.mondai,
      section: group.section,
      instruction: group.instruction,
      title: passageTitleFromMaterial(group.material, group.section, group.mondai),
      preview: stripMdPreview(group.material),
      questionCount: sorted.length,
      questionIds: sorted.map((item) => item.questionId || item.id),
      material: group.material,
      items: sorted,
    };
  });
}

/** 阅读库：按场次列出已精校 full 包中的読解篇目卡片。 */
export async function listReadingLibrary(level = "N2") {
  const pool = await loadJlptBankPool(level);
  const passages = groupReadingItems(pool.reading || []);
  const bySitting = new Map();
  for (const passage of passages) {
    if (!bySitting.has(passage.sitting)) {
      bySitting.set(passage.sitting, {
        sitting: passage.sitting,
        title: `${passage.sitting} N2 阅读`,
        passageCount: 0,
        questionCount: 0,
        passages: [],
      });
    }
    const row = bySitting.get(passage.sitting);
    row.passages.push({
      id: passage.id,
      sitting: passage.sitting,
      mondai: passage.mondai,
      section: passage.section,
      title: passage.title,
      preview: passage.preview,
      instruction: passage.instruction,
      questionCount: passage.questionCount,
      questionIds: passage.questionIds,
    });
    row.passageCount += 1;
    row.questionCount += passage.questionCount;
  }
  const sittings = [...bySitting.values()].sort((a, b) => String(b.sitting).localeCompare(String(a.sitting)));
  return {
    level,
    sittings,
    totalPassages: passages.length,
    totalQuestions: passages.reduce((n, item) => n + item.questionCount, 0),
    notes: pool.notes || [],
  };
}

export function composeReadingPassage(pool, { passageId } = {}) {
  const groups = groupReadingItems(pool.reading || []);
  const group = groups.find((item) => item.id === passageId);
  if (!group) {
    return { questions: [], meta: { notes: [`找不到篇目 ${passageId}`], empty: true } };
  }
  const questions = [{
    id: `r-pass-${group.id}`,
    type: "passage",
    prompt: group.material,
    choices: [],
    answer: "",
    nodeIds: group.items.map((item) => item.nodeId),
    explanation: "",
  }];
  for (const [index, item] of group.items.entries()) {
    const stem = String(item.prompt || "").trim()
      || (group.instruction ? `${group.instruction}\n問${item.questionId || index + 1}` : `問${item.questionId || index + 1}`);
    questions.push(mcq(
      `r-q-${item.questionId || index + 1}`,
      stem,
      item.choices.includes(item.answer) ? item.choices : shuffle([item.answer, ...item.choices]).slice(0, 4),
      item.answer,
      [item.nodeId],
      item.explanation,
    ));
  }
  return {
    questions,
    meta: {
      notes: [
        "阅读练习 · 不计入探索成就",
        `${group.sitting} · ${group.section || `問題${group.mondai}`} · ${group.title}`,
        `${group.questionCount} 题`,
      ],
      passageId: group.id,
      sitting: group.sitting,
      title: group.title,
      questionCount: group.questionCount,
      empty: false,
    },
  };
}

export function composeReadingDrill(pool, { count = 3 } = {}) {
  const groups = shuffle(groupReadingItems(pool.reading || [])).slice(0, count);
  const questions = [];
  for (const [index, group] of groups.entries()) {
    questions.push({
      id: `r-pass-${index + 1}`,
      type: "passage",
      prompt: group.material,
      choices: [],
      answer: "",
      nodeIds: group.items.map((item) => item.nodeId),
      explanation: "",
    });
    const item = group.items[0];
    if (!item) continue;
    questions.push(mcq(
      `r-q-${index + 1}`,
      item.prompt || group.title,
      item.choices.includes(item.answer) ? item.choices : shuffle([item.answer, ...item.choices]).slice(0, 4),
      item.answer,
      [item.nodeId],
      item.explanation,
    ));
  }
  return {
    questions,
    meta: {
      notes: ["阅读短练 · 不计入探索成就", `篇目 ${groups.length}`],
      passageCount: groups.length,
      sittings: [...new Set(groups.map((item) => item.sitting))],
    },
  };
}

export async function saveSpecialHistory(root, sessionId, payload) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const relative = path.posix.join(SPECIAL_HISTORY_DIR, `${day}_${sessionId}.json`);
  await withVaultFileWrite(root, relative, async (file) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  });
  return path.join(root, relative);
}

export async function loadStoredQuestionsByNode(root) {
  const dir = path.join(root, SPECIAL_HISTORY_DIR);
  const map = {};
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return map;
  }
  for (const name of names.filter((item) => item.endsWith(".json")).sort().reverse().slice(0, 40)) {
    const data = await readJsonIfExists(path.join(dir, name));
    for (const question of data?.questions || []) {
      for (const nodeId of question.nodeIds || []) {
        if (!map[nodeId] && question.type === "mcq") {
          map[nodeId] = question;
        }
      }
    }
  }
  return map;
}

export async function loadMistakeState(root) {
  const absolute = path.join(root, EXPLORATION_MISTAKE_STATE_PATH);
  const data = await readJsonIfExists(absolute);
  return data && typeof data === "object" ? data : { items: {} };
}

export async function saveMistakeState(root, state) {
  await withVaultFileWrite(root, EXPLORATION_MISTAKE_STATE_PATH, async (absolute) => {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  });
}

export function applyMistakeStreaks(state, { level, track, verifiedIds = [], missedIds = [], stamp }) {
  const items = { ...(state.items || {}) };
  const cleared = [];
  const reopened = [];
  for (const nodeId of missedIds) {
    const key = `${level}:${track}:${nodeId}`;
    items[key] = {
      streak: 0,
      status: "active",
      lastWrongAt: stamp,
      nodeId,
      level,
      track,
    };
    reopened.push(nodeId);
  }
  for (const nodeId of verifiedIds) {
    const key = `${level}:${track}:${nodeId}`;
    const prev = items[key];
    if (!prev || prev.status === "cleared") continue;
    const streak = Number(prev.streak || 0) + 1;
    if (streak >= 2) {
      items[key] = { ...prev, streak: 2, status: "cleared", clearedAt: stamp };
      cleared.push(nodeId);
    } else {
      items[key] = { ...prev, streak, status: "active", lastCorrectAt: stamp };
    }
  }
  return { state: { items, updatedAt: stamp }, cleared, reopened };
}

export function activeMistakeNodeIds(state, levelOrLevels) {
  const levels = Array.isArray(levelOrLevels)
    ? levelOrLevels
    : levelOrLevels
      ? [levelOrLevels]
      : null;
  const allow = levels?.length ? new Set(levels) : null;
  return Object.values(state.items || {})
    .filter((item) => item.status === "active" && (!allow || allow.has(item.level)))
    .map((item) => item.nodeId);
}
