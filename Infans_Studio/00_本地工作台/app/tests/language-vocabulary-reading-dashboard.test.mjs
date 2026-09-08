import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const languagesSource = await readFile(new URL("../src/pages/languages/LanguagesPage.tsx", import.meta.url), "utf8");
const readingSource = await readFile(new URL("../src/pages/languages/ReadingBoard.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const ankiSource = await readFile(new URL("../src/server/workbench-anki.mjs", import.meta.url), "utf8");

test("词汇页按主牌组归组，每个 N 卡容纳多个子牌组进度", () => {
  assert.match(languagesSource, /Anki 词汇进度/);
  assert.match(languagesSource, /ANKI_DECK_ROOT/);
  assert.match(languagesSource, /3-N3::1-高频/);
  assert.match(languagesSource, /5-N1/);
  assert.doesNotMatch(languagesSource, /JLPT 词汇阶梯/);
  assert.match(ankiSource, /DEMO_JLPT_DECK_ROOT/);
  assert.match(ankiSource, /::5-N1/);
  assert.doesNotMatch(ankiSource, /eggrolls/);
  assert.match(ankiSource, /deck: item\.deck/);
  assert.match(languagesSource, /buildAnkiDeckGroups/);
  assert.match(languagesSource, /anki-deck-group/);
  assert.match(languagesSource, /anki-level-card/);
  assert.match(languagesSource, /尚未接入/);
  assert.match(languagesSource, /segments\.map/);
  assert.doesNotMatch(languagesSource, /anki-deck-levels/);
});

test("阅读页分开新闻和赏析阅读，不含真题阅读", () => {
  for (const label of ["新闻阅读", "赏析阅读"]) assert.match(readingSource, new RegExp(label));
  assert.doesNotMatch(readingSource, /真题阅读|真题练习|随便练几篇|真题原文/);
  assert.match(readingSource, /\/api\/markets\/world\?lane=japan/);
  assert.match(readingSource, /\/api\/languages\/reading-literature/);
  assert.match(readingSource, /最新本地稿/);
  assert.match(readingSource, /在小秘书内阅读/);
  assert.doesNotMatch(readingSource, /尚未接入可追溯的新闻原文/);
  assert.doesNotMatch(readingSource, /青空文库原文/);
  assert.match(readingSource, /readLanguageViewPosition\("reading"\)/);
  assert.match(styles, /\.literature-document > \.collection-document-markdown/);
});

test("日语收藏先走三级目录，再以三列卡片阅读内容", async () => {
  const collectionSource = await readFile(new URL("../src/pages/languages/LanguageReactorLibrary.tsx", import.meta.url), "utf8");
  for (const label of ["收藏总目录", "语言知识", "作品与行业", "学习积累", "知识点", "实用表达", "歌词精读", "行业用语", "动漫用语", "学习经验", "沉浸语料", "完整句子", "带语境单词", "阅读全文", "快速复习 5 张"]) {
    assert.match(collectionSource, new RegExp(label));
  }
  assert.match(collectionSource, /\/api\/languages\/collection/);
  assert.match(collectionSource, /readLanguageViewPosition\("collection"\)/);
  assert.match(collectionSource, /writeLanguageViewPosition\("collection"/);
  assert.match(collectionSource, /viewTrail/);
  assert.match(collectionSource, /collection-directory-stage/);
  assert.match(collectionSource, /<PageTrail items=/);
  assert.doesNotMatch(collectionSource, /className="collection-breadcrumb"|className="collection-back-button"/);
  assert.match(styles, /\.lr-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.collection-directory-grid \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.collection-directory-spine/);
  assert.match(styles, /-webkit-line-clamp: 2/);
  assert.match(styles, /\.knowledge-card-detail/);
  assert.match(styles, /\.document-card:has\(details\[open\]\)/);
  assert.match(styles, /\.collection-document-markdown/);
});
