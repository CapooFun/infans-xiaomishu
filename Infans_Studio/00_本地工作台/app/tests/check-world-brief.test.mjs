import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { inspectWorldBriefCounts } from "../scripts/check-world-brief.mjs";

const checker = fileURLToPath(new URL("../scripts/check-world-brief.mjs", import.meta.url));
const vaultJapan = fileURLToPath(new URL("../../20_记录/世界资讯/日本/当前.md", import.meta.url));
const vaultAi = fileURLToPath(new URL("../../20_记录/世界资讯/AI/当前.md", import.meta.url));
const vaultGames = fileURLToPath(new URL("../../20_记录/世界资讯/游戏/当前.md", import.meta.url));

function briefMarkdown(lane, events, headline = "测试") {
  return `---
description: 测试
date: 2026-09-03
tags: [世界资讯]
---

<!-- INFANS_WORLD_BRIEF_JSON_START -->
\`\`\`json
${JSON.stringify({
    schemaVersion: 1,
    lane,
    generatedAt: "2026-09-03T00:00:00+09:00",
    asOf: "2026-09-03 日本时间",
    headline,
    status: "active",
    events,
    calendar: [],
    readings: [],
    note: "测试",
  })}
\`\`\`
<!-- INFANS_WORLD_BRIEF_JSON_END -->
`;
}

function fakeEvents(count, category) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${category}-${index}`,
    category,
    title: `新闻${index}`,
    fact: "事实",
    whyItMatters: "原因",
    watchNext: [],
    sources: [{ title: "官方", url: "https://example.com/", type: "一手" }],
  }));
}

test("inspectWorldBriefCounts accepts the current vault briefs", async () => {
  const counts = await inspectWorldBriefCounts({
    ai: vaultAi,
    games: vaultGames,
    japan: vaultJapan,
  });
  assert.ok(counts.ai.count >= 4);
  assert.ok(counts.games.count >= 4);
  assert.ok(counts.japan.count >= 5);
});

test("check-world-brief fails when japan has fewer than five events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "world-brief-"));
  const ai = path.join(dir, "ai.md");
  const games = path.join(dir, "games.md");
  const japan = path.join(dir, "japan.md");
  await writeFile(ai, briefMarkdown("ai", fakeEvents(4, "工具")));
  await writeFile(games, briefMarkdown("games", fakeEvents(4, "展会")));
  await writeFile(japan, briefMarkdown("japan", fakeEvents(1, "签证")));
  const result = spawnSync(process.execPath, [checker, ai, games, japan], { encoding: "utf8" });
  assert.equal(result.status, 4);
  assert.match(result.stderr, /日本 1\/5/);
});

test("check-world-brief fails when a headline is process talk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "world-brief-"));
  const ai = path.join(dir, "ai.md");
  const games = path.join(dir, "games.md");
  const japan = path.join(dir, "japan.md");
  await writeFile(ai, briefMarkdown("ai", fakeEvents(4, "工具"), "Google 发布；昨天三条官方页仍有效"));
  await writeFile(games, briefMarkdown("games", fakeEvents(4, "展会")));
  await writeFile(japan, briefMarkdown("japan", fakeEvents(5, "签证")));
  const result = spawnSync(process.execPath, [checker, ai, games, japan], { encoding: "utf8" });
  assert.equal(result.status, 4);
  assert.match(result.stderr, /写稿过程/);
});
