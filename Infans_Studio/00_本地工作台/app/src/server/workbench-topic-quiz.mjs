/**
 * 专题「今日一问」：按学习进度在近讲窗口内抽题，东京日不重复。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DIR_TOPICS, WORKBENCH_DERIVED_DIR } from "./vault-paths.mjs";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";

const QUIZ_STATE_RELATIVE = path.posix.join(WORKBENCH_DERIVED_DIR, "topic-daily-quiz.json");
const TONGJIAN_OVERVIEW = path.posix.join(DIR_TOPICS, "学习中", "资治通鉴", "资治通鉴_总览.md");
const TONGJIAN_BANK = path.posix.join(DIR_TOPICS, "学习中", "资治通鉴", "40_数据", "今日一问题库.json");
const WINDOW = 5;
const RECENT_KEEP = 40;

function contentId(relativePath) {
  return crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 18);
}

export const TONGJIAN_TOPIC_ID = contentId(TONGJIAN_OVERVIEW);

function tokyoDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function orderKey(season, lecture) {
  return Number(season) * 1000 + Number(lecture);
}

async function readJsonSafe(absolute, fallback) {
  try {
    return JSON.parse(await fs.readFile(absolute, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(vaultRoot, relativePath, data) {
  await withVaultFileWrite(vaultRoot, relativePath, async (absolute) => {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.infans-tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(temporary, absolute);
  });
}

export function parseTongjianProgress(overviewText = "") {
  const matter = overviewText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const head = matter?.[1] || "";
  const seasonFm = head.match(/^\s*progressSeason:\s*(\d+)/m);
  const lectureFm = head.match(/^\s*progressLecture:\s*(\d+)/m);
  if (seasonFm && lectureFm) {
    return { season: Number(seasonFm[1]), lecture: Number(lectureFm[1]) };
  }
  const seasonBody = overviewText.match(/第\s*\*?\*?(\d)\*?\*?\s*季/)
    || overviewText.match(/第五季|05季|第5季/);
  const lectureBody = overviewText.match(/第\s*\*?\*?(\d{1,3})\*?\*?\s*讲/);
  const season = seasonFm ? Number(seasonFm[1])
    : seasonBody?.[1] ? Number(seasonBody[1])
    : /第五季|05季|第5季/.test(overviewText) ? 5 : 5;
  const lecture = lectureFm ? Number(lectureFm[1])
    : lectureBody?.[1] ? Number(lectureBody[1])
    : 1;
  return { season, lecture };
}

function pickDaily(candidates, dateKey, recentIds = []) {
  if (!candidates.length) return null;
  const fresh = candidates.filter((item) => !recentIds.includes(item.id));
  const pool = fresh.length ? fresh : candidates;
  let hash = 0;
  const seed = `${dateKey}:${pool.map((item) => item.id).join(",")}`;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return pool[hash % pool.length];
}

export function selectQuizItem(bankItems, progress, dateKey, recentIds = []) {
  const end = orderKey(progress.season, progress.lecture);
  const start = end - (WINDOW - 1);
  const inWindow = bankItems.filter((item) => {
    const key = orderKey(item.season, item.lecture);
    return key >= start && key <= end;
  });
  const pool = inWindow.length ? inWindow : bankItems.filter((item) => orderKey(item.season, item.lecture) <= end);
  return pickDaily(pool, dateKey, recentIds);
}

export function buildExplainSeed(quiz) {
  const lectureLabel = `第${quiz.season}季第${String(quiz.lecture).padStart(3, "0")}讲`;
  return [
    "请讲清楚这道《资治通鉴》复习题的答案与要点（说人话，先结论后依据，别写成论文）：",
    `题目：${quiz.question}`,
    `出处：${lectureLabel}${quiz.title ? `「${quiz.title}」` : ""}`,
    quiz.answerHint ? `笔记线索：${quiz.answerHint}` : "",
    "讲完可以再问我一句，看我是否听懂；不要一上来就考我。",
  ].filter(Boolean).join("\n");
}

export async function getDailyTopicQuiz(_vaultRoot, topicId) {
  return {
    available: false,
    paused: true,
    topicId: String(topicId || "").trim() || undefined,
    reason: "今日一问已暂停，不再抽题、不再写派生文件",
  };
}
