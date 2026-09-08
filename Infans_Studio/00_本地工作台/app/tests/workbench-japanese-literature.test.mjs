import assert from "node:assert/strict";
import test from "node:test";

import { parseJapaneseLiteratureDocument } from "../src/server/workbench-japanese-literature.mjs";

test("本地赏析从 Markdown 原件读取卡片信息", () => {
  const card = parseJapaneseLiteratureDocument(`---
description: 本地赏析摘要
date: 2026-09-05
author: 新美南吉
level: 入门首选
source_name: 青空文库
source_url: https://www.aozora.gr.jp/cards/000121/card628.html
---

# ごん狐

这是一篇保存在本地的赏析正文。
`, { id: "gon-gitsune", file: "ごん狐.md" });

  assert.equal(card.id, "gon-gitsune");
  assert.equal(card.title, "ごん狐");
  assert.equal(card.author, "新美南吉");
  assert.equal(card.level, "入门首选");
  assert.equal(card.note, "本地赏析摘要");
  assert.equal(card.updatedAt, "2026-09-05");
  assert.equal(card.sourcePath, "55_语言学习/日语/阅读/ごん狐.md");
  assert.equal(card.readTime, 1);
});

test("本地赏析拒绝非 HTTPS 来源链接", () => {
  const card = parseJapaneseLiteratureDocument(`---
description: 测试
source_url: javascript:alert(1)
---
# 测试
`, { id: "test", file: "测试.md" });
  assert.equal(card.sourceUrl, "");
});
