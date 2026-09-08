import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseJapaneseCollectionIndex,
  parseJapaneseKnowledgeCard,
  queryJapaneseCollection,
  readJapaneseCollectionDocumentById,
  readJapaneseCollectionDocuments,
  readJapaneseKnowledgeCards,
  selectJapaneseKnowledgeReview,
} from "../src/server/workbench-japanese-knowledge-cards.mjs";
import { normalizeJapaneseStudyMarkdown } from "../src/markdown-display.mjs";

const sample = `---
description: 测试知识卡片
date: 2026-09-02
tags: [日语, 测试]
cardId: sample-card
category: 语法记忆
verification: 个人记法
summary: 用一个钩子记住规则。
sources:
  - label: 本地原件
    path: 55_语言学习/日语/文法/变形.md
---

# 测试卡片

## 展开说明

这是第一段。

这是第二段。

## 我的记法

把方向想成向外发出。

## 正确规则

- 五段动词使用あ段。
- 一段动词另按自己的规则。

## 适用边界

- 记法不是词源。
`;

test("知识卡片解析标题、状态、正文段落和原件来源", () => {
  const card = parseJapaneseKnowledgeCard(sample, "55_语言学习/日语/收藏/知识卡片/测试.md");
  assert.equal(card.id, "sample-card");
  assert.equal(card.kind, "knowledge");
  assert.equal(card.category, "语法记忆");
  assert.equal(card.verification, "个人记法");
  assert.equal(card.explanation, "这是第一段。\n\n这是第二段。");
  assert.deepEqual(card.rules, ["五段动词使用あ段。", "一段动词另按自己的规则。"]);
  assert.equal(card.sources[0].path, "55_语言学习/日语/文法/变形.md");
});

test("知识卡目录只读取带稳定 cardId 的 Markdown", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-jp-cards-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "55_语言学习/日语/收藏/知识卡片");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "README.md"), "# 说明\n");
  await fs.writeFile(path.join(directory, "卡片.md"), sample);
  await fs.writeFile(path.join(directory, "普通笔记.md"), "---\ndescription: 普通笔记\ntags: [日语]\n---\n\n# 普通笔记\n");
  const cards = await readJapaneseKnowledgeCards(root);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "测试卡片");
});

test("统一收藏接口能筛选知识卡并给出稳定的每日快速复习", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-jp-collection-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "55_语言学习/日语/收藏/知识卡片");
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(Array.from({ length: 7 }, (_, index) => fs.writeFile(
    path.join(directory, `卡片-${index}.md`),
    sample.replace("sample-card", `sample-card-${index}`).replace("测试卡片", `测试卡片 ${index}`),
  )));
  const first = await queryJapaneseCollection(root, { scope: "knowledge", review: 5, dateKey: "2026-09-02" });
  const second = await queryJapaneseCollection(root, { scope: "knowledge", review: 5, dateKey: "2026-09-02" });
  assert.equal(first.stats.knowledge, 7);
  assert.equal(first.items.length, 5);
  assert.deepEqual(first.items.map((item) => item.id), second.items.map((item) => item.id));
  const selected = selectJapaneseKnowledgeReview(await readJapaneseKnowledgeCards(root), "2026-09-03", 5);
  assert.equal(selected.length, 5);
});

test("跨目录收藏索引只接受稳定类型和日语目录内 Markdown", () => {
  const index = `---
description: 测试索引
tags: [日语, 收藏]
cards:
  - id: song-test
    type: 歌曲精读
    category: 动画歌曲
    path: 55_语言学习/日语/收藏/歌曲/测试.md
  - id: escaped
    type: 歌曲精读
    category: 错误
    path: ../秘密.md
  - id: song-test
    type: 行业用语
    category: 重复
    path: 55_语言学习/日语/单词/重复.md
---`;
  assert.deepEqual(parseJapaneseCollectionIndex(index), [{
    id: "song-test",
    cardType: "歌曲精读",
    category: "动画歌曲",
    sourcePath: "55_语言学习/日语/收藏/歌曲/测试.md",
  }]);
});

test("跨目录资料卡列表不下发全文，点开后读取同一原件全文", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-jp-doc-cards-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const japaneseRoot = path.join(root, "55_语言学习/日语");
  await fs.mkdir(path.join(japaneseRoot, "收藏/歌曲"), { recursive: true });
  await fs.writeFile(path.join(japaneseRoot, "收藏卡片_总览.md"), `---
description: 测试索引
tags: [日语, 收藏]
cards:
  - id: song-test
    type: 歌曲精读
    category: 动画歌曲
    path: 55_语言学习/日语/收藏/歌曲/测试.md
---\n# 总览\n`);
  await fs.writeFile(path.join(japaneseRoot, "收藏/歌曲/测试.md"), `---
description: 一首用于测试完整阅读的歌
date: 2026-09-02
tags: [日语, 歌曲]
---
# 测试歌曲

## 第一段

【歌词】<ruby>空<rt>そら</rt></ruby>へ
【大意】向着天空
`);
  const documents = await readJapaneseCollectionDocuments(root);
  assert.equal(documents.length, 1);
  const result = await queryJapaneseCollection(root, { scope: "cards", cardType: "歌曲精读" });
  assert.equal(result.stats.documents, 1);
  assert.equal(result.stats.songs, 1);
  assert.equal(result.stats.industry, 0);
  assert.equal(result.stats.anime, 0);
  assert.equal(result.stats.methods, 0);
  assert.equal(result.stats.expressions, 0);
  assert.equal(result.items[0].kind, "document");
  assert.equal("markdown" in result.items[0], false);
  const detail = await readJapaneseCollectionDocumentById(root, "song-test");
  assert.match(detail.markdown, /<ruby>空/);
  const display = normalizeJapaneseStudyMarkdown(detail.markdown);
  assert.match(display, /空（そら）/);
  assert.match(display, /\*\*歌词\*\*/);
});
