import fs from "node:fs/promises";
import path from "node:path";

import { COURSE_MATERIALS_ROOT, COURSE_GRAMMAR_ROOT } from "./vault-paths.mjs";
export { COURSE_MATERIALS_ROOT, COURSE_GRAMMAR_ROOT };

const BOOKS = Object.freeze({
  beginner: Object.freeze({ directory: "初級", lessons: 15, stPerLesson: 3, idPrefix: "shokyu" }),
  intermediate: Object.freeze({ directory: "初中級", lessons: 15, stPerLesson: 2, idPrefix: "chukyu" }),
});

const SECTION_KINDS = new Set(["listen", "challenge", "say", "try", "integrated", "other"]);
const ITEM_KINDS = new Set(["audio", "question", "activity", "reading", "writing"]);
const BLOCK_KINDS = new Set(["script", "prompt", "answer", "example", "note"]);

function integerInRange(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${label}超出范围`);
  }
  return number;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label}缺失`);
  return value;
}

function optionalText(value, label) {
  if (value === undefined) return undefined;
  return requireText(value, label);
}

function cleanMarkdownCell(value = "") {
  return String(value)
    .replace(/\*\*|__|`/g, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseCourseGrammarFocus(markdown = "") {
  const section = String(markdown).match(/(?:^|\n)##\s+核心语法一览\s*\n([\s\S]*?)(?=\n##\s+|$)/)?.[1] || "";
  const rows = [];
  for (const rawLine of section.split(/\r?\n/)) {
    if (!/^\s*\|/.test(rawLine) || /^\s*\|\s*(?:重点|[-: ]+)\s*\|/.test(rawLine)) continue;
    const cells = rawLine.split("|").slice(1, -1).map(cleanMarkdownCell);
    if (cells.length < 3 || !cells[0] || !cells[1]) continue;
    rows.push([cells[0], cells[1], cells[2]].filter(Boolean).join("｜"));
  }
  return rows;
}

function pageNumber(value, label) {
  return integerInRange(value, 1, 999, label);
}

function normalizeLine(line, label) {
  if (!line || typeof line !== "object") throw new TypeError(`${label}不是对象`);
  return {
    id: requireText(line.id, `${label}.id`),
    speaker: requireText(line.speaker, `${label}.speaker`),
    text: requireText(line.text, `${label}.text`),
  };
}

function normalizeBlock(block, label) {
  if (!block || typeof block !== "object") throw new TypeError(`${label}不是对象`);
  if (!BLOCK_KINDS.has(block.kind)) throw new TypeError(`${label}.kind 无效`);
  const normalized = {
    id: requireText(block.id, `${label}.id`),
    kind: block.kind,
  };
  const title = optionalText(block.title, `${label}.title`);
  const text = optionalText(block.text, `${label}.text`);
  if (title) normalized.title = title;
  if (text) normalized.text = text;
  if (block.lines !== undefined) {
    if (!Array.isArray(block.lines)) throw new TypeError(`${label}.lines 不是数组`);
    normalized.lines = block.lines.map((line, index) => normalizeLine(line, `${label}.lines[${index}]`));
  }
  if (!normalized.text && !normalized.lines?.length) throw new TypeError(`${label}没有正文`);
  return normalized;
}

function normalizeItem(item, label) {
  if (!item || typeof item !== "object") throw new TypeError(`${label}不是对象`);
  if (!ITEM_KINDS.has(item.kind)) throw new TypeError(`${label}.kind 无效`);
  if (!Array.isArray(item.blocks)) throw new TypeError(`${label}.blocks 不是数组`);
  if (item.blocks.length === 0 && (item.kind !== "audio" || !item.audioTrack)) {
    throw new TypeError(`${label}.blocks 为空`);
  }
  const normalized = {
    id: requireText(item.id, `${label}.id`),
    kind: item.kind,
    title: requireText(item.title, `${label}.title`),
    blocks: item.blocks.map((block, index) => normalizeBlock(block, `${label}.blocks[${index}]`)),
  };
  const audioTrack = optionalText(item.audioTrack, `${label}.audioTrack`);
  if (audioTrack) normalized.audioTrack = audioTrack;
  if (item.sourceBookPage !== undefined) normalized.sourceBookPage = pageNumber(item.sourceBookPage, `${label}.sourceBookPage`);
  return normalized;
}

function normalizeSection(section, label) {
  if (!section || typeof section !== "object") throw new TypeError(`${label}不是对象`);
  if (!SECTION_KINDS.has(section.kind)) throw new TypeError(`${label}.kind 无效`);
  if (!Array.isArray(section.items) || section.items.length === 0) throw new TypeError(`${label}.items 为空`);
  const normalized = {
    id: requireText(section.id, `${label}.id`),
    kind: section.kind,
    title: requireText(section.title, `${label}.title`),
    items: section.items.map((item, index) => normalizeItem(item, `${label}.items[${index}]`)),
  };
  for (const key of ["subtitle", "summary"]) {
    const value = optionalText(section[key], `${label}.${key}`);
    if (value) normalized[key] = value;
  }
  if (section.sourceBookPage !== undefined) normalized.sourceBookPage = pageNumber(section.sourceBookPage, `${label}.sourceBookPage`);
  return normalized;
}

function normalizeGrammarExample(example, label) {
  if (!example || typeof example !== "object") throw new TypeError(`${label}不是对象`);
  const normalized = {
    japanese: requireText(example.japanese, `${label}.japanese`),
    chinese: requireText(example.chinese, `${label}.chinese`),
  };
  const source = optionalText(example.source, `${label}.source`);
  if (source) normalized.source = source;
  return normalized;
}

function normalizeGrammarUsage(usage, label) {
  if (!usage || typeof usage !== "object") throw new TypeError(`${label}不是对象`);
  if (!Array.isArray(usage.examples) || usage.examples.length === 0) throw new TypeError(`${label}.examples 为空`);
  return {
    label: requireText(usage.label, `${label}.label`),
    explanation: requireText(usage.explanation, `${label}.explanation`),
    examples: usage.examples.map((example, index) => normalizeGrammarExample(example, `${label}.examples[${index}]`)),
  };
}

function normalizeGrammarFocus(point, label) {
  if (!point || typeof point !== "object") throw new TypeError(`${label}不是对象`);
  if (!Array.isArray(point.usages) || point.usages.length === 0) throw new TypeError(`${label}.usages 为空`);
  return {
    id: requireText(point.id, `${label}.id`),
    kind: requireText(point.kind, `${label}.kind`),
    pattern: requireText(point.pattern, `${label}.pattern`),
    connection: requireText(point.connection, `${label}.connection`),
    summary: requireText(point.summary, `${label}.summary`),
    usages: point.usages.map((usage, index) => normalizeGrammarUsage(usage, `${label}.usages[${index}]`)),
  };
}

export function normalizeCourseCard(card, expectedStId) {
  if (!card || typeof card !== "object") throw new TypeError("学习卡不是对象");
  const stId = requireText(card.stId, "stId");
  if (stId !== expectedStId) throw new TypeError(`学习卡 ID 不匹配：${stId}`);
  if (!Array.isArray(card.sections) || card.sections.length === 0) throw new TypeError(`${stId}.sections 为空`);
  const normalized = {
    stId,
    title: requireText(card.title, `${stId}.title`),
    goal: requireText(card.goal, `${stId}.goal`),
    officialSummary: requireText(card.officialSummary, `${stId}.officialSummary`),
    sourceBookPage: pageNumber(card.sourceBookPage, `${stId}.sourceBookPage`),
    sections: card.sections.map((section, index) => normalizeSection(section, `${stId}.sections[${index}]`)),
    supports: Array.isArray(card.supports)
      ? card.supports.map((item, index) => requireText(item, `${stId}.supports[${index}]`))
      : [],
  };
  if (card.grammarFocus !== undefined) {
    if (!Array.isArray(card.grammarFocus) || card.grammarFocus.length === 0) throw new TypeError(`${stId}.grammarFocus 为空`);
    normalized.grammarFocus = card.grammarFocus.map((point, index) => normalizeGrammarFocus(point, `${stId}.grammarFocus[${index}]`));
  }
  const currentSectionId = optionalText(card.currentSectionId, `${stId}.currentSectionId`);
  if (currentSectionId) normalized.currentSectionId = currentSectionId;
  return normalized;
}

function lessonCards(payload) {
  if (!payload || typeof payload !== "object") throw new TypeError("教材文件不是对象");
  if (Array.isArray(payload.stCards)) return payload.stCards;
  if (payload.stCards && typeof payload.stCards === "object") return Object.values(payload.stCards);
  throw new TypeError("教材文件缺少 stCards");
}

export function courseMaterialPath(root, bookId, lesson) {
  const book = BOOKS[bookId];
  if (!book) throw new RangeError("未知教材册别");
  const safeLesson = integerInRange(lesson, 1, book.lessons, "课次");
  return path.join(root, COURSE_MATERIALS_ROOT, book.directory, `lesson-${String(safeLesson).padStart(2, "0")}.json`);
}

export function courseGrammarReviewPath(root, bookId, lesson) {
  const book = BOOKS[bookId];
  if (!book) throw new RangeError("未知教材册别");
  const safeLesson = integerInRange(lesson, 1, book.lessons, "课次");
  const volume = bookId === "beginner" ? "上册" : "下册";
  return path.join(root, COURSE_GRAMMAR_ROOT, `${volume}_第${safeLesson}课_语法重点复习.md`);
}

export async function readCourseLessonFocus(root, selection) {
  const filePath = courseGrammarReviewPath(root, selection?.book, selection?.lesson);
  try {
    return parseCourseGrammarFocus(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function readCourseStCard(root, selection) {
  const book = BOOKS[selection?.book];
  if (!book) throw new RangeError("未知教材册别");
  const lesson = integerInRange(selection.lesson, 1, book.lessons, "课次");
  const st = integerInRange(selection.st, 1, book.stPerLesson, "ST");
  const expectedStId = `dekiru-${book.idPrefix}-${String(lesson).padStart(2, "0")}-st${st}`;
  const filePath = courseMaterialPath(root, selection.book, lesson);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const payload = JSON.parse(raw);
  const card = lessonCards(payload).find((candidate) => candidate?.stId === expectedStId);
  if (!card) return null;
  const normalized = normalizeCourseCard(card, expectedStId);
  const lessonFocus = await readCourseLessonFocus(root, selection);
  return {
    ...normalized,
    supports: lessonFocus.length ? lessonFocus : normalized.supports,
  };
}
