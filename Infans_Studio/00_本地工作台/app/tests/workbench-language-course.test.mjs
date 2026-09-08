import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COURSE_MATERIALS_ROOT,
  courseGrammarReviewPath,
  courseMaterialPath,
  normalizeCourseCard,
  parseCourseGrammarFocus,
  readCourseLessonFocus,
  readCourseStCard,
} from "../src/server/workbench-language-course.mjs";

function sampleCard(stId = "dekiru-shokyu-01-st1") {
  return {
    stId,
    title: "はじめまして",
    goal: "初対面で自己紹介する。",
    officialSummary: "官方配套资料中的场景与脚本。",
    sourceBookPage: 1,
    currentSectionId: "challenge",
    supports: [],
    sections: [{
      id: "challenge",
      kind: "challenge",
      title: "チャレンジ",
      items: [{
        id: "audio-001",
        kind: "audio",
        title: "音声 001",
        audioTrack: "001",
        sourceBookPage: 1,
        blocks: [{
          id: "audio-001-script",
          kind: "script",
          lines: [{ id: "line-1", speaker: "A", text: "はじめまして。" }],
        }],
      }],
    }],
  };
}

function sampleGrammarFocus() {
  return [{
    id: "grammar-tameni",
    kind: "目的",
    pattern: "〜ために",
    connection: "V辞书形＋ために",
    summary: "说明为了实现目标而采取行动。",
    usages: [{
      label: "以行动为目的",
      explanation: "先说目的，再说为此采取的行动。",
      examples: [{ japanese: "勉強するために、日本へ来ました。", chinese: "为了学习而来到日本。", source: "课文例句" }],
    }],
  }];
}

test("course material path stays in the selected official book directory", () => {
  assert.equal(
    courseMaterialPath("/vault", "beginner", 1),
    path.join("/vault", COURSE_MATERIALS_ROOT, "初級", "lesson-01.json"),
  );
  assert.throws(() => courseMaterialPath("/vault", "../private", 1), /未知教材册别/);
  assert.throws(() => courseMaterialPath("/vault", "beginner", 16), /课次超出范围/);
});

test("course grammar focus reads only the explicit core grammar table", () => {
  const markdown = `# 第3课

课文里自然出现：〜たいです。

## 核心语法一览

| 重点 | 句型 | 用途 |
|---|---|---|
| 确定条件：Vたら | \`Vた形＋ら\` | 前项完成后说安排。 |
| 打算：Vるつもりです | \`辞书形＋つもりです\` | 表达明确计划。 |

## 重点讲解

这里再次出现 〜たいです。`;
  assert.deepEqual(parseCourseGrammarFocus(markdown), [
    "确定条件：Vたら｜Vた形＋ら｜前项完成后说安排。",
    "打算：Vるつもりです｜辞书形＋つもりです｜表达明确计划。",
  ]);
});

test("grammar review path follows the real course volume naming", () => {
  assert.equal(
    courseGrammarReviewPath("/vault", "beginner", 3),
    path.join("/vault", "55_语言学习", "日语", "课程", "できる日本語", "上册_第3课_语法重点复习.md"),
  );
  assert.equal(
    courseGrammarReviewPath("/vault", "intermediate", 3),
    path.join("/vault", "55_语言学习", "日语", "课程", "できる日本語", "下册_第3课_语法重点复习.md"),
  );
});

test("course card validator rejects mismatched IDs and empty content", () => {
  assert.equal(normalizeCourseCard(sampleCard(), "dekiru-shokyu-01-st1").sections[0].kind, "challenge");
  assert.throws(() => normalizeCourseCard(sampleCard("wrong"), "dekiru-shokyu-01-st1"), /ID 不匹配/);
  assert.throws(() => normalizeCourseCard({ ...sampleCard(), sections: [] }, "dekiru-shokyu-01-st1"), /sections 为空/);
});

test("course card validator keeps per-ST grammar usages and bilingual examples", () => {
  const card = sampleCard();
  card.grammarFocus = sampleGrammarFocus();
  const normalized = normalizeCourseCard(card, card.stId);
  assert.equal(normalized.grammarFocus[0].usages[0].examples[0].chinese, "为了学习而来到日本。");

  card.grammarFocus[0].usages[0].examples = [];
  assert.throws(() => normalizeCourseCard(card, card.stId), /examples 为空/);
});

test("audio locators may remain scriptless when the official companion PDF has no transcript", () => {
  const card = sampleCard();
  card.sections[0].items[0].blocks = [];
  assert.deepEqual(normalizeCourseCard(card, card.stId).sections[0].items[0].blocks, []);
  card.sections[0].items[0].kind = "question";
  assert.throws(() => normalizeCourseCard(card, card.stId), /blocks 为空/);
});

test("course reader returns one ST lazily and treats an unrecorded lesson as missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infans-course-"));
  const directory = path.join(root, COURSE_MATERIALS_ROOT, "初級");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "lesson-01.json"), JSON.stringify({ stCards: [sampleCard()] }), "utf8");
  const grammarPath = courseGrammarReviewPath(root, "beginner", 1);
  await mkdir(path.dirname(grammarPath), { recursive: true });
  await writeFile(grammarPath, `## 核心语法一览

| 重点 | 句型 | 用途 |
|---|---|---|
| 自我介绍 | \`Nです\` | 介绍自己。 |
`, "utf8");

  const card = await readCourseStCard(root, { book: "beginner", lesson: 1, st: 1 });
  assert.equal(card.stId, "dekiru-shokyu-01-st1");
  assert.equal(card.sections[0].items[0].blocks[0].lines[0].text, "はじめまして。");
  assert.deepEqual(card.supports, ["自我介绍｜Nです｜介绍自己。"]) ;
  assert.deepEqual(await readCourseLessonFocus(root, { book: "beginner", lesson: 1 }), card.supports);
  assert.equal(await readCourseStCard(root, { book: "beginner", lesson: 2, st: 1 }), null);
});
