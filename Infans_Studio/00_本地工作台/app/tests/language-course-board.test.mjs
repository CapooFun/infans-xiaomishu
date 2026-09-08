import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildCourseCatalog,
  courseLessonId,
  masteryLabel,
  normalizeCoursePosition,
  courseStCard,
  courseSectionHasStudyContent,
  COURSE_SECTION_DEFINITIONS,
} from "../src/pages/languages/course-board-model.ts";

const componentSource = readFileSync(new URL("../src/pages/languages/CourseBoard.tsx", import.meta.url), "utf8");
const progressComponentSource = readFileSync(new URL("../src/pages/languages/CourseProgressBooks.tsx", import.meta.url), "utf8");
const explorationSource = readFileSync(new URL("../src/pages/languages/ExplorationMatrix.tsx", import.meta.url), "utf8");
const courseStyles = readFileSync(new URL("../src/pages/languages/course-board.css", import.meta.url), "utf8");
const progressStyles = readFileSync(new URL("../src/pages/languages/course-progress-books.css", import.meta.url), "utf8");

test("教材目录固定为30课和75个ST", () => {
  const catalog = buildCourseCatalog();
  assert.equal(catalog.length, 30);
  assert.equal(catalog.filter((lesson) => lesson.book === "beginner").length, 15);
  assert.equal(catalog.filter((lesson) => lesson.book === "intermediate").length, 15);
  assert.equal(catalog.reduce((sum, lesson) => sum + lesson.stIds.length, 0), 75);
});

test("课程坐标只负责规范化用户明确点选的课次", () => {
  const current = normalizeCoursePosition({ book: "intermediate", lesson: 3 });
  assert.deepEqual(current, {
    book: "intermediate",
    lesson: 3,
    st: 1,
    lessonId: "dekiru-chukyu-03",
    stId: "dekiru-chukyu-03-st1",
  });
  assert.equal(courseLessonId("beginner", 3), "dekiru-shokyu-03");
});

test("学习页只保留有实际学习内容的主要环节", () => {
  assert.deepEqual(COURSE_SECTION_DEFINITIONS.map((section) => section.title), [
    "チャレンジ",
    "言ってみよう",
    "やってみよう",
    "話読聞書",
  ]);
  assert.equal(courseSectionHasStudyContent({
    id: "listen",
    kind: "listen",
    title: "聞いてみよう",
    items: [{ id: "track", kind: "audio", title: "音轨", audioTrack: "001", blocks: [] }],
  }), false);
  assert.equal(courseSectionHasStudyContent({
    id: "listen",
    kind: "listen",
    title: "聞いてみよう",
    items: [{
      id: "track",
      kind: "audio",
      title: "音轨",
      blocks: [{ id: "script", kind: "script", lines: [{ id: "line", speaker: "A", text: "こんにちは。" }] }],
    }],
  }), true);
});

test("外部按课数据可覆盖内置回退样例", () => {
  const external = {
    "dekiru-chukyu-03-st1": {
      stId: "dekiru-chukyu-03-st1",
      title: "外部按课内容",
    },
  };
  assert.equal(courseStCard("dekiru-chukyu-03-st1", external).title, "外部按课内容");
});

test("没有整理的ST不伪造学习卡", () => {
  assert.equal(courseStCard("dekiru-chukyu-03-st1"), undefined);
  assert.equal(courseStCard("dekiru-chukyu-02-st1"), undefined);
});

test("课程页按教材、课次和课内小节展示重点与分级证据", () => {
  assert.match(componentSource, /progress\?: JapaneseCourseProgress/);
  assert.match(componentSource, /<CourseProgressBooks/);
  assert.match(componentSource, /loadStCard\?:/);
  assert.match(componentSource, /Promise\.allSettled/);
  assert.match(componentSource, /lessonCards\.flatMap\(\(card\) => card\.supports\)/);
  assert.match(componentSource, /本课重点语法/);
  assert.match(componentSource, /card\.grammarFocus\?\.map/);
  assert.match(componentSource, /课文例句配中文精译/);
  assert.match(componentSource, /用法 \{usageIndex \+ 1\}/);
  assert.match(componentSource, /本课小节与学习记录/);
  assert.match(componentSource, /card\.sections\.map/);
  assert.match(componentSource, /<details className=/);
  assert.match(componentSource, /我的课业记录/);
  assert.match(componentSource, /stEvidence/);
  assert.match(componentSource, /ChevronDown/);
  assert.match(componentSource, /stMasteryLabel/);
  assert.match(componentSource, /COURSE_MASTERY_LABELS/);
  assert.match(componentSource, /教材重点映射待整理/);
  assert.match(componentSource, /不会扫描正文或自行补写/);
  assert.match(componentSource, /第 \{selected\.lesson\}-\{selection\.st\} 课/);
  assert.match(componentSource, /第 \{selected\.lesson\}-\{st\} 课 · 语法分组/);
  assert.match(componentSource, /\{selected\.lesson\}-\{st\} · \{point\.kind\}/);
  assert.match(componentSource, /openGrammarPointIds/);
  assert.match(componentSource, /setGrammarGroupOpen/);
  assert.match(componentSource, /全部收起/);
  assert.match(componentSource, /全部展开/);
  assert.match(componentSource, /onToggle=\{\(event\) => setGrammarPointOpen/);
  assert.match(componentSource, /useState<CourseSelection \| null>/);
  assert.match(componentSource, /\{selected && selectedBook \? <article/);
  assert.doesNotMatch(componentSource, /progress\?\.currentSelection|DEFAULT_CURRENT_POSITION|当前选课/);
  assert.doesNotMatch(componentSource, /只读展示|学习内容由 GPT|course-board__note|ST\{/);
  assert.doesNotMatch(componentSource, /ScriptBlock|ContentBlockView|SectionView|\.blocks/);
  assert.doesNotMatch(componentSource, /开始口语练习|准备本课交接|教材阅览器|上一节|下一节/);
  assert.doesNotMatch(componentSource, /course-board__study/);
  assert.doesNotMatch(courseStyles, /\.conjugation-board/);
  assert.match(courseStyles, /width: 100%/);
  assert.doesNotMatch(courseStyles, /width: min\(1280px, 100%\)/);
  assert.match(courseStyles, /\.course-board__st-records/);
  assert.match(courseStyles, /\.course-board__grammar-points[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(courseStyles, /\.course-board__grammar-points > details > summary[\s\S]*min-height: 164px/);
  assert.match(courseStyles, /\.course-board__grammar-group-actions button/);
  assert.match(courseStyles, /\.course-board__grammar-examples[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(courseStyles, /\.course-board__study/);
  assert.match(courseStyles, /@media \(max-width: 1450px\)/);
  assert.match(courseStyles, /\.course-board__st-map/);
  assert.match(courseStyles, /@media \(max-width: 720px\)/);
});

test("探索页恢复横幅，分册默认收起并按需展开课次", () => {
  assert.match(explorationSource, /<CourseProgressBooks books=\{course\.books\}\/>/);
  assert.match(explorationSource, /exploration-hero exploration-course-hero/);
  assert.match(explorationSource, /course\.oralReview\.dueCount/);
  assert.match(explorationSource, /每次最多带入 2 项/);
  assert.doesNotMatch(explorationSource, /CourseLessonCard|course-progress-lessons|course-progress-sts/);
  assert.doesNotMatch(explorationSource, /SourceLink|evidenceRule|ST</);
  assert.match(progressComponentSource, /FUTURE_BOOKS/);
  assert.match(progressComponentSource, /label: "中級"/);
  assert.match(progressComponentSource, /label: "上級"/);
  assert.match(progressComponentSource, /后续阶段 · 尚未接入/);
  assert.doesNotMatch(progressComponentSource, /label: "中級", lessonTotal|label: "上級", lessonTotal/);
  assert.match(progressComponentSource, /aria-expanded=\{expanded\}/);
  assert.match(progressComponentSource, /defaultExpanded = false/);
  assert.match(progressComponentSource, /initialExpandedBookId/);
  assert.match(progressComponentSource, /onExpandedBookChange/);
  assert.match(progressComponentSource, /defaultExpanded \? \(bookForLessonId\(books, selectedLessonId\)/);
  assert.doesNotMatch(progressComponentSource, /当前选课|isCurrentSelection|currentBookId|is-current/);
  assert.doesNotMatch(explorationSource, /现在准备从这里学|currentSelection/);
  assert.match(progressComponentSource, /有记录不等于已经掌握/);
  assert.match(progressComponentSource, /第\{lesson\.lesson\}-\{item\.st\}课/);
  assert.doesNotMatch(progressComponentSource, /ST\{item\.st\}|ST 已评价|ST 达到掌握/);
  assert.match(progressComponentSource, /整课 LV\$\{floor\}/);
  assert.doesNotMatch(progressComponentSource, /Math\.round.*stWithEvidence/);
  assert.match(progressStyles, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(progressStyles, /\.course-volume__lessons/);
  assert.match(progressStyles, /@media \(max-width: 720px\)/);
});

test("课程程度显示四级证据名称", () => {
  assert.deepEqual([0, 1, 2, 3].map((level) => masteryLabel(level)), [
    "LV0 门外汉",
    "LV1 入门",
    "LV2 可独立完成",
    "LV3 跨日稳定",
  ]);
  assert.equal(masteryLabel(undefined), "尚未记录");
});

test("练习积累、覆盖、等级与稳定分开，不把未评当作没练", () => {
  assert.match(explorationSource, /summary\.recordedSessionCount/);
  assert.match(explorationSource, /已归档练习 · 含自由口语/);
  assert.match(explorationSource, /summary\.practicedSt/);
  assert.match(explorationSource, /小节已有等级/);
  assert.match(explorationSource, /小节跨日稳定/);
  assert.match(explorationSource, /summary\.lastPracticedOn/);
  assert.doesNotMatch(explorationSource, /<strong>\{summary\.masteredSt\}<small>/);
  assert.match(progressComponentSource, /已练习/);
  assert.match(progressComponentSource, /暂无记录/);
  assert.match(progressComponentSource, /item\.practiced/);
  assert.match(componentSource, /本节练习记录尚未关联到这里/);
  for (const source of [componentSource, progressComponentSource, explorationSource]) {
    assert.doesNotMatch(source, /待评价|补入原练习对话后再评价|评价待补齐|具体场次与等级待补/);
  }
});

test("选课越界时按册别约束课次和ST", () => {
  assert.deepEqual(normalizeCoursePosition({ book: "beginner", lesson: 99, st: 9 }), {
    book: "beginner",
    lesson: 15,
    st: 3,
    lessonId: "dekiru-shokyu-15",
    stId: "dekiru-shokyu-15-st3",
  });
  assert.equal(normalizeCoursePosition({ book: "intermediate", lesson: 0, st: 0 }).st, 1);
});
