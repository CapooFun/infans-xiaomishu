import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTongjianProgress, selectQuizItem, buildExplainSeed, getDailyTopicQuiz } from "../src/server/workbench-topic-quiz.mjs";

test("parseTongjianProgress reads frontmatter first", () => {
  const text = `---
progressSeason: 5
progressLecture: 6
---
# x
当前听到：第五季第 3 讲
`;
  assert.deepEqual(parseTongjianProgress(text), { season: 5, lecture: 6 });
});

test("selectQuizItem stays within previous 5 lectures and avoids recent ids", () => {
  const items = [];
  for (let lecture = 1; lecture <= 8; lecture += 1) {
    items.push({ id: `s5-${lecture}-a`, season: 5, lecture, title: `t${lecture}`, question: `q${lecture}？` });
    items.push({ id: `s5-${lecture}-b`, season: 5, lecture, title: `t${lecture}`, question: `q${lecture}b？` });
  }
  const picked = selectQuizItem(items, { season: 5, lecture: 6 }, "2026-08-07", ["s5-6-a", "s5-5-a"]);
  assert.ok(picked);
  assert.ok(picked.lecture >= 2 && picked.lecture <= 6);
  assert.notEqual(picked.id, "s5-6-a");
  assert.notEqual(picked.id, "s5-5-a");
});

test("buildExplainSeed asks Meining to teach not quiz first", () => {
  const seed = buildExplainSeed({
    season: 5,
    lecture: 6,
    title: "赵充国的进攻节奏有什么变化？",
    question: "赵充国前期为什么偏守？",
    answerHint: "先拆联盟再择机打",
  });
  assert.match(seed, /请讲清楚/);
  assert.match(seed, /不要一上来就考我/);
  assert.match(seed, /第5季第006讲/);
});

test("今日一问已暂停，旧地址不再写派生文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-topic-quiz-"));
  const result = await getDailyTopicQuiz(root, "any-topic");
  assert.equal(result.available, false);
  assert.equal(result.paused, true);
  const entries = await fs.readdir(root);
  assert.equal(entries.length, 0);
  await fs.rm(root, { recursive: true, force: true });
  const home = await fs.readFile(new URL("../src/pages/HomePage.tsx", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(home, /今日一问|topic-quiz|TopicQuiz/);
  assert.doesNotMatch(main, /今日一问|topic-quiz|TopicQuiz/);
});
