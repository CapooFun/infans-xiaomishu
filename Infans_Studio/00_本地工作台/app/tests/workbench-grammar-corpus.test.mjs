import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseGrammarChecklist } from "../src/server/workbench-grammar.mjs";

const corpusRoot = new URL("../../../55_语言学习/日语/文法/JLPT/", import.meta.url);

test("开源示例文法可被看板解析，且不是作者完整题库", async () => {
  const markdown = await readFile(new URL("N5.md", corpusRoot), "utf8");
  const grammar = parseGrammarChecklist(markdown, "N5");
  const points = grammar.groups.flatMap((group) => group.points);
  assert.ok(points.length >= 6, "N5 示例至少有几条公开句式");
  assert.match(markdown, /示例/u);
  for (const point of points) {
    assert.ok(point.connection, `${point.id} has a parsed connection`);
    assert.ok(point.meaning, `${point.id} has a parsed meaning`);
    assert.ok(point.examples.length > 0, `${point.id} has a parsed example`);
  }
});
