import assert from "node:assert/strict";
import test from "node:test";
import { parseGrammarChecklist } from "../src/server/workbench-grammar.mjs";

test("keeps comparable grammar points together in their semantic row", () => {
  const grammar = parseGrammarChecklist(`# N3 文法
## 怎么使用
- 说明
## 一、条件与假设
> 这一组要横向比较。
**N3-01 〜たら**　｜掌握度 2｜复习 2026-08-01
- 接续：た形
- 含义：如果……
- 例：時間があったら、行きます。
- 辨析：可用于一次性条件。

**N3-02 〜なら**　｜掌握度 3｜复习 —
- 含义：若说到……
`, "N3");
  assert.equal(grammar.total, 2);
  assert.equal(grammar.groups.length, 1);
  assert.equal(grammar.groups[0].title, "条件与假设");
  assert.equal(grammar.groups[0].note, "这一组要横向比较。");
  assert.deepEqual(grammar.groups[0].points.map((point) => point.id), ["N3-01", "N3-02"]);
  assert.equal(grammar.diagnosed, 2);
  assert.equal(grammar.mastered, 1);
});

test("把知识点的受控我的笔记派生为口语看板摘要", () => {
  const grammar = parseGrammarChecklist(`## 一、条件
**N4-17 〜たら**　｜掌握度 3｜复习 2026-08-03
- 接续：V-た＋ら
- 含义：如果……
- 我的笔记：
  - 最近口语证据：2026-08-28｜提示后｜[[记录]]
  - 可观察表现：能改正卒業したら。
  - 个性化模式：候选｜实时成形仍慢。
  - 下次复习：2026-08-31｜换动词再说。
`, "N4");
  const point = grammar.groups[0].points[0];
  assert.equal(point.oral.status, "prompted");
  assert.equal(point.oral.label, "提示后可用");
  assert.match(point.oral.note, /能改正/);
  assert.match(point.oral.nextReview, /2026-08-31/);
});
