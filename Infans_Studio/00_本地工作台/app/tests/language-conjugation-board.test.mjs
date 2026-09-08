import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cardsForPhase,
  CONJUGATION_CARDS,
  CONJUGATION_SOURCE_ROOT,
  uniqueConjugationSources,
} from "../src/pages/languages/conjugation-board-model.ts";

test("每张卡都有完整的五段学习结构", () => {
  assert.ok(CONJUGATION_CARDS.length >= 20);
  for (const card of CONJUGATION_CARDS) {
    assert.ok(card.masteryPointIds.length, `${card.id} 缺少掌握度关联节点`);
    assert.ok(card.whenToUse.trim(), `${card.id} 缺少什么时候用`);
    assert.ok(card.steps.length, `${card.id} 缺少变形步骤`);
    assert.ok(card.groupRules.length, `${card.id} 缺少组别与例外`);
    assert.ok(card.examples.length, `${card.id} 缺少例句`);
    assert.ok(card.pitfalls.length, `${card.id} 缺少容易错`);
    assert.ok(card.oralPractice.length, `${card.id} 缺少口头练习`);
  }
});

test("基础、功能和组合构成独立的完整练习路线", () => {
  assert.deepEqual(cardsForPhase("foundation").map((card) => card.id), [
    "verb-groups",
    "dictionary",
    "masu",
    "nai",
    "te-form",
    "ta-form",
    "core-four",
    "te-ta",
  ]);
  assert.deepEqual(cardsForPhase("functional").map((card) => card.id), [
    "volitional",
    "conditionals",
    "to-nara",
    "ba",
    "tara",
    "nakereba",
    "commands",
    "potential",
    "passive",
    "causative",
    "causative-passive",
  ]);
  assert.deepEqual(cardsForPhase("combination").map((card) => card.id), [
    "masu-family",
    "te-ta-families",
    "stack-reading",
  ]);
});

test("指定的核心变形全部有独立或专项卡片", () => {
  const ids = new Set(CONJUGATION_CARDS.map((card) => card.id));
  for (const id of [
    "verb-groups", "dictionary", "masu", "nai", "te-form", "ta-form",
    "volitional", "conditionals", "to-nara", "ba", "tara", "commands",
    "potential", "passive", "causative", "causative-passive", "stack-reading",
  ]) {
    assert.equal(ids.has(id), true, `缺少核心卡片：${id}`);
  }
  const conditionText = CONJUGATION_CARDS
    .filter((card) => ["conditionals", "to-nara", "ba", "tara"].includes(card.id))
    .map((card) => `${card.title}${card.japaneseTitle}${card.whenToUse}`)
    .join("\n");
  for (const form of ["と", "ば", "たら", "なら"]) assert.match(conditionText, new RegExp(form));
});

test("卡片不虚构掌握状态且只依赖独立的变形原件", () => {
  const serialized = JSON.stringify(CONJUGATION_CARDS);
  for (const phrase of ["尚未记录", "已掌握", "精通", "正确率", "复习次数"]) {
    assert.equal(serialized.includes(phrase), false, `不应出现虚构状态：${phrase}`);
  }
  for (const source of uniqueConjugationSources()) {
    assert.equal(source.startsWith(`${CONJUGATION_SOURCE_ROOT}/`), true);
    assert.equal(source.endsWith(".md"), true);
  }
});

test("变形卡复用文法专项掌握节点而不是另造状态", () => {
  const byId = new Map(CONJUGATION_CARDS.map((card) => [card.id, card]));
  assert.deepEqual(byId.get("dictionary")?.masteryPointIds, ["N5-42"]);
  assert.deepEqual(byId.get("te-form")?.masteryPointIds, ["N5-33"]);
  assert.deepEqual(byId.get("potential")?.masteryPointIds, ["N4-01"]);
  assert.deepEqual(byId.get("causative-passive")?.masteryPointIds, ["N3-56"]);
  for (const card of CONJUGATION_CARDS) {
    for (const pointId of card.masteryPointIds) assert.match(pointId, /^N[2-5]-\d+$/);
  }
});

test("意向形独立区分当下意志与计划表达", () => {
  const card = CONJUGATION_CARDS.find((item) => item.id === "volitional");
  assert.match(card?.whenToUse || "", /当下意志或邀请/);
  assert.match(card?.whenToUse || "", /意向形＋と思っています／と思う/);
  assert.equal(card?.examples.some((example) => example.japanese.includes("作ろうと思っています")), true);
  assert.equal(card?.phase, "functional");
});

test("意向和条件卡保留关键变形", () => {
  const byId = new Map(CONJUGATION_CARDS.map((card) => [card.id, card]));
  assert.deepEqual(byId.get("volitional")?.route, ["行く", "行こう"]);
  assert.deepEqual(byId.get("tara")?.route, ["着く", "着いたら"]);
  assert.deepEqual(byId.get("nakereba")?.route, ["書かない", "書かなければ"]);
});

test("易错形被明确纠正", () => {
  const serialized = JSON.stringify(CONJUGATION_CARDS);
  const answerCorpus = JSON.stringify(CONJUGATION_CARDS.map((card) => ({ route: card.route, examples: card.examples })));
  for (const correction of ["買わない", "行って", "行った", "来ない（こない）", "する→できる"]) {
    assert.match(serialized, new RegExp(correction.replace(/[()]/g, "\\$&")));
  }
  for (const wrong of ["買あない", "行いて", "行いた", "あらない"]) {
    assert.equal(answerCorpus.includes(wrong), false, `错误形不应出现在答案或例句中：${wrong}`);
  }
});

test("页面使用固定目录与详情，并显示同口径掌握度", () => {
  const component = readFileSync(new URL("../src/pages/languages/ConjugationBoard.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/pages/languages/conjugation-board.css", import.meta.url), "utf8");
  assert.match(component, /变形知识与掌握情况/);
  assert.match(component, /conjugation-board__workspace/);
  assert.match(component, /conjugation-board__index/);
  assert.match(component, /conjugation-detail/);
  assert.match(component, /等级 \$\{mastery\.level\}/);
  assert.match(component, /关联文法点/);
  assert.match(component, /题目表现/);
  assert.match(component, /口语使用/);
  assert.match(component, /未练习/);
  assert.match(component, /correctAverage \/ 35/);
  assert.doesNotMatch(component, /第 3 课|第3课|lesson-3/);
  assert.doesNotMatch(JSON.stringify(CONJUGATION_CARDS), /第 3 课|第3课|lesson-3/);
  assert.match(component, /组别与例外/);
  assert.match(styles, /width: min\(100%, 1520px\)/);
  assert.match(styles, /grid-template-columns: clamp\(230px, 22vw, 330px\) minmax\(0, 1fr\)/);
  assert.doesNotMatch(component, /<details|<summary/);
  assert.doesNotMatch(component, /自己试一遍/);
  assert.doesNotMatch(styles, /\.conjugation-card\[open\]/);
});
