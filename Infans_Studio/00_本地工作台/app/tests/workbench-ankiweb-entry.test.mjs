import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const languagesPage = readFileSync(new URL("../src/pages/languages/LanguagesPage.tsx", import.meta.url), "utf8");
const homePage = readFileSync(new URL("../src/pages/HomePage.tsx", import.meta.url), "utf8");
const shared = readFileSync(new URL("../src/pages/languages/shared.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("vocabulary page and the homepage Anki cell both open AnkiWeb", () => {
  assert.match(shared, /export const ANKIWEB_DECKS_URL = "https:\/\/ankiweb\.net\/decks";/);
  assert.match(languagesPage, /href=\{ANKIWEB_DECKS_URL\} target="_blank" rel="noopener noreferrer"/);
  assert.match(languagesPage, />\u514d费打开 AnkiWeb 背词/);
  assert.match(homePage, /className="jp-source-anki" href=\{ANKIWEB_DECKS_URL\} target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(homePage, /ankiSourceLabel|快照/);
  assert.doesNotMatch(homePage, /home-anki-button/);
  assert.doesNotMatch(homePage, /免费 · 与 Mac 同步/);
  assert.doesNotMatch(styles, /\.home-anki-button/);
});

test("home Japanese card presents the four real practice sources without stage prose or demo data", () => {
  assert.match(homePage, /日语 · N2备考/);
  assert.match(homePage, /<span>今日练习总时长<\/span>/);
  assert.match(homePage, /其中口语/);
  assert.match(homePage, /<span>专项<\/span>/);
  assert.match(homePage, /<span>阅读<\/span>/);
  assert.match(homePage, /<span>考试<\/span>/);
  assert.match(homePage, /data\.japanese\.studySummary/);
  assert.doesNotMatch(homePage, /data\.japanese\.stage/);
  assert.doesNotMatch(homePage, /待复习|错题练习也归入这里|今日暂无练习|今日暂无测试/);
  const japaneseCard = homePage.match(/className="jp-pulse[\s\S]*?className="health-pulse/u)?.[0] || "";
  assert.doesNotMatch(japaneseCard.split('<div className="jp-source-ledger">')[1] || "", /<small>/u);
  assert.doesNotMatch(homePage, /jpDemo|昨天|演示|JAPANESE_HOME_DEMO|JAPANESE_SCREENSHOT_STUDY/);
});
