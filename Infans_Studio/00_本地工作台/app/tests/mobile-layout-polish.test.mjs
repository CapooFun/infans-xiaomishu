import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const themes = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
const refinements = readFileSync(new URL("../src/workbench-refinements.css", import.meta.url), "utf8");
const exploration = readFileSync(new URL("../src/pages/languages/ExplorationMatrix.tsx", import.meta.url), "utf8");

test("mobile AI summaries clip their clamped lines and wrap long task identifiers", () => {
  const mobile = styles.slice(styles.indexOf("@media (max-width: 560px) {\n  .schedule-ai-queue"));
  const summaryRule = mobile.match(/\.schedule-ai-queue \.ai-task-copy > span,[\s\S]*?\.ai-task-next \{([^}]+)\}/)?.[1];
  assert.ok(summaryRule);
  assert.match(summaryRule, /overflow: hidden/);
  assert.match(summaryRule, /overflow-wrap: anywhere/);
  assert.match(summaryRule, /white-space: normal/);
  assert.doesNotMatch(summaryRule, /overflow: visible/);
  assert.match(mobile, /\.ai-task-progress \{ -webkit-line-clamp: 2; \}/);
  assert.match(mobile, /\.ai-task-next \{ -webkit-line-clamp: 3; \}/);
  assert.match(mobile, /\.schedule-ai-queue > header > span \{\s*grid-column: 2;\s*grid-row: 1;/);
});

test("single-column quadrants use natural page scrolling", () => {
  assert.match(styles, /@media \(max-width: 900px\) \{\s*\.market-layout[\s\S]*?\.schedule-quadrant \.schedule-todo-rows \{ max-height: none; overflow: visible; \}/);
  assert.doesNotMatch(refinements, /schedule-quadrant\.is-empty[^\{]*\{[^}]*min-height/u);
});

test("phone study statistics stay two by two with separate practice and mastery counts", () => {
  const mobile = styles.slice(styles.indexOf("@media (max-width: 620px) {\n  .exploration-levels"));
  assert.match(mobile, /\.exploration-ability-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(mobile, /\.agenda-todo-split \.empty \{ min-height: 52px;/);
  for (const key of ["practicedSt", "stWithEvidence", "masteredSt", "lastPracticedOn"]) {
    assert.ok(exploration.includes(`summary.${key}`));
  }
  assert.match(exploration, /className="exploration-evidence-rule">口语复习/);
});

test("day surfaces and alert counts use legible theme-aware colors", () => {
  assert.match(themes, /:root\[data-theme="day"\] \.schedule-ai-queue \{[^}]*background: var\(--surface-2\);/);
  assert.match(themes, /\.schedule-quadrant\[class\*="tone-"\] > \.schedule-quadrant-head span \{\s*color: var\(--quadrant-accent\);/);
  const badge = styles.match(/\.home-important-alert em \{([^}]+)\}/)?.[1];
  assert.match(badge, /color:var\(--surface-2\)/);
  assert.match(badge, /background:var\(--alert-accent\)/);
  assert.doesNotMatch(badge, /background:currentColor/);
  assert.match(styles, /\.home-important-alert\.is-critical \{ --alert-accent:var\(--red\); \}/);
});
