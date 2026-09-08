import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findWorldNewsEvent, readWorldNewsFavorites, worldNewsFavoritesPath, writeWorldNewsFavorite } from "../src/server/workbench-world-news-favorites.mjs";

async function fixture(t) {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "infans-world-news-favorites-"));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  const briefDir = path.join(vault, "50_世界资讯", "日本");
  await fs.mkdir(briefDir, { recursive: true });
  await fs.writeFile(path.join(briefDir, "当前.md"), `---
description: 测试
date: 2026-09-07
tags: [世界资讯]
---

# 测试

<!-- INFANS_WORLD_BRIEF_JSON_START -->
\`\`\`json
{"schemaVersion":1,"lane":"japan","generatedAt":"2026-09-07T06:10:00+09:00","asOf":"2026-09-07 日本时间","headline":"有雨","status":"active","events":[{"id":"rain-1","category":"灾害","lane":"now","title":"东京有雨","fact":"气象厅发布了降雨注意。","whyItMatters":"出门要带伞","impact":"","watchNext":["傍晚再看雷达"],"sources":[{"title":"气象厅","url":"https://www.jma.go.jp/","type":"一手"}]}],"calendar":[],"readings":[],"note":"测试"}
\`\`\`
<!-- INFANS_WORLD_BRIEF_JSON_END -->
`);
  return vault;
}

test("世界资讯收藏缺省为空，GET 不会顺手创建派生文件", async (t) => {
  const vault = await fixture(t);
  assert.deepEqual(await readWorldNewsFavorites(vault), { schemaVersion: 1, items: [] });
  await assert.rejects(fs.access(worldNewsFavoritesPath(vault)));
});

test("只能收藏当天稿里真实存在的新闻，重复收藏保持一条", async (t) => {
  const vault = await fixture(t);
  const first = await writeWorldNewsFavorite(vault, {
    lane: "japan",
    asOf: "2026-09-07",
    eventId: "rain-1",
    saved: true,
  });
  const second = await writeWorldNewsFavorite(vault, {
    lane: "japan",
    asOf: "2026-09-07",
    eventId: "rain-1",
    saved: true,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].title, "东京有雨");
  assert.equal(second.items[0].category, "灾害");
  assert.equal(second.items[0].signal, "like");
  assert.equal(second.items[0].savedAt, first.items[0].savedAt);
  assert.equal((await fs.stat(worldNewsFavoritesPath(vault))).mode & 0o777, 0o600);
  await assert.rejects(writeWorldNewsFavorite(vault, {
    lane: "japan",
    asOf: "2026-09-07",
    eventId: "missing-1",
    saved: true,
  }), /找不到这条新闻/);
});

test("金融栏只能收藏当前简报里真实存在的事件", async (t) => {
  const vault = await fixture(t);
  const briefDir = path.join(vault, "50_世界资讯", "金融");
  await fs.mkdir(briefDir, { recursive: true });
  await fs.writeFile(path.join(briefDir, "当前简报.md"), `---
description: 测试
date: 2026-09-07
tags: [世界资讯]
---

# 测试

<!-- INFANS_MARKET_BRIEF_JSON_START -->
\`\`\`json
{"schemaVersion":1,"asOf":"2026-09-07","headline":"利率","status":"active","events":[{"id":"fed-1","category":"央行","title":"维持利率","fact":"官方维持利率。","whyItMatters":"改变预期","marketReaction":"波动","impact":"利率更高更久","confidence":"中等","watchNext":["CPI"],"sources":[{"title":"官方","url":"https://example.com/fed","type":"一手"}]}]}
\`\`\`
<!-- INFANS_MARKET_BRIEF_JSON_END -->
`);
  const saved = await writeWorldNewsFavorite(vault, {
    lane: "finance",
    asOf: "2026-09-07",
    eventId: "fed-1",
    saved: true,
  });
  assert.equal(saved.items[0].lane, "finance");
  assert.equal(saved.items[0].title, "维持利率");
});

test("不喜欢与收藏互斥，取消不喜欢后不再保留", async (t) => {
  const vault = await fixture(t);
  const liked = await writeWorldNewsFavorite(vault, {
    lane: "japan",
    asOf: "2026-09-07",
    eventId: "rain-1",
    saved: true,
    signal: "like",
  });
  assert.equal(liked.items[0].signal, "like");
  const disliked = await writeWorldNewsFavorite(vault, {
    lane: "japan",
    asOf: "2026-09-07",
    eventId: "rain-1",
    saved: true,
    signal: "dislike",
  });
  assert.equal(disliked.items.length, 1);
  assert.equal(disliked.items[0].signal, "dislike");
  const cleared = await writeWorldNewsFavorite(vault, {
    lane: "japan",
    asOf: "2026-09-07",
    eventId: "rain-1",
    saved: false,
  });
  assert.deepEqual(cleared, { schemaVersion: 1, items: [] });
});

test("没有 signal 的旧收藏仍按喜欢读取", async (t) => {
  const vault = await fixture(t);
  await fs.mkdir(path.dirname(worldNewsFavoritesPath(vault)), { recursive: true });
  await fs.writeFile(worldNewsFavoritesPath(vault), `${JSON.stringify({
    schemaVersion: 1,
    items: [{
      key: "japan:2026-09-07:rain-1",
      lane: "japan",
      asOf: "2026-09-07",
      eventId: "rain-1",
      title: "东京有雨",
      category: "灾害",
      savedAt: "2026-09-07T06:10:00.000Z",
    }],
  }, null, 2)}\n`);
  const snapshot = await readWorldNewsFavorites(vault);
  assert.equal(snapshot.items[0].signal, "like");
});
