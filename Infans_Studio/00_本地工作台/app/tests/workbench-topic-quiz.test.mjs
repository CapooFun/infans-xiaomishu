import test from "node:test";
import assert from "node:assert/strict";
import { parseTongjianProgress, selectQuizItem, buildExplainSeed } from "../src/server/workbench-topic-quiz.mjs";

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
