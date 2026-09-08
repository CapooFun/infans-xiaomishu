import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const languagesPage = readFileSync(new URL("../src/pages/languages/LanguagesPage.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const positionMemory = readFileSync(new URL("../src/workbench-position-memory.ts", import.meta.url), "utf8");

test("语言学习桌面导航收口为六项看板", () => {
  const labels = ["探索成就", "课程", "单词", "文法", "阅读", "收藏"];
  const positions = labels.map((label) => languagesPage.indexOf(`label: "${label}"`));

  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, positions.toSorted((a, b) => a - b));
  assert.match(languagesPage, /\? \(value as HubSection\) : "course"/);
  assert.match(languagesPage, /<button type="button" aria-pressed=\{section === item\.id\}/);
  assert.match(styles, /\.language-primary-tabs-6 \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \}/);
});

test("首次入口默认进入课程，探索成就仍可由显式地址进入", () => {
  assert.match(languagesPage, /: "course"/);
  assert.match(languagesPage, /if \(section === "course"\) url\.searchParams\.delete\("section"\)/);
  assert.match(languagesPage, /else url\.searchParams\.set\("section", section\)/);
  assert.match(languagesPage, /readLanguageViewPosition\("course"\)/);
  assert.match(languagesPage, /currentPosition=\{coursePosition\?\.selection\}/);
  assert.match(languagesPage, /writeLanguageViewPosition\("course"/);
  assert.match(positionMemory, /"\/languages": \["section"\]/);
  assert.match(positionMemory, /store\.scroll\[location\] =/);
});

test("探索成就移除今天开始练习的顶部入口", () => {
  const exploration = readFileSync(new URL("../src/pages/languages/ExplorationMatrix.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(exploration, /今天练一点|开始一次练习|exploration-start/);
});

test("变形并入文法且旧链接可转入对应分支", () => {
  assert.doesNotMatch(languagesPage, /section === "conjugation"[\s\S]*?<ConjugationBoard/);
  assert.match(languagesPage, /if \(value === "conjugation"\) return "grammar"/);
  assert.match(languagesPage, /url\.searchParams\.set\("branch", "conjugation"\)/);
});

test("教材页不向用户暴露试点、回退或 iterating 工程状态", () => {
  assert.doesNotMatch(languagesPage, /试点|iterating|回退/);
  assert.doesNotMatch(languagesPage, /liveReason|materials:/);
});
