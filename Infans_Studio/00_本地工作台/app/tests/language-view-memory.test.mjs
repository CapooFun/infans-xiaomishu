import assert from "node:assert/strict";
import test from "node:test";
import {
  LANGUAGE_VIEW_MEMORY_KEY,
  parseLanguageViewMemory,
  readLanguageViewPosition,
  writeLanguageViewPosition,
} from "../src/pages/languages/language-view-memory.ts";

test("语言学习位置记忆只接受稳定导航状态", () => {
  const parsed = parseLanguageViewMemory(JSON.stringify({
    version: 1,
    course: {
      selection: { book: "intermediate", lesson: 3, st: 1 },
      expandedBookId: "intermediate",
      transcript: "不应保存",
    },
    vocabulary: { level: "N2" },
    grammar: { branch: "pragmatics", level: "N3", filter: "review", query: "不应保存" },
    reading: { category: "literature", sitting: "全部" },
    collection: { kind: "word", source: "魔法少女まどかマギカ", query: "不应保存" },
  }));

  assert.deepEqual(parsed, {
    version: 1,
    course: {
      selection: { book: "intermediate", lesson: 3, st: 1 },
      expandedBookId: "intermediate",
    },
    vocabulary: { level: "N2" },
    grammar: { branch: "pragmatics", level: "N3", filter: "review" },
    reading: { category: "literature", sitting: "全部" },
    collection: { kind: "word", source: "魔法少女まどかマギカ" },
  });
});

test("损坏或越界的位置记忆安静回退", () => {
  assert.deepEqual(parseLanguageViewMemory("not-json"), { version: 1 });
  assert.deepEqual(parseLanguageViewMemory(JSON.stringify({
    version: 1,
    vocabulary: { level: "N0" },
    grammar: { branch: "unknown", level: "N1", filter: "all" },
  })), { version: 1 });
  assert.deepEqual(parseLanguageViewMemory(JSON.stringify({
    version: 1,
    collection: { kind: "knowledge", source: "全部作品" },
  })).collection, { kind: "knowledge", source: "全部作品" });
  assert.deepEqual(parseLanguageViewMemory(JSON.stringify({
    version: 1,
    collection: { kind: "cards", source: "全部作品" },
  })).collection, { kind: "cards", source: "全部作品" });
});

test("各子看板写入时互不覆盖", () => {
  const rows = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => rows.get(key) ?? null,
      setItem: (key, value) => rows.set(key, value),
    },
  };
  writeLanguageViewPosition("course", {
    selection: { book: "intermediate", lesson: 3, st: 1 },
    expandedBookId: "intermediate",
  });
  writeLanguageViewPosition("reading", { category: "literature", sitting: "全部" });
  assert.deepEqual(readLanguageViewPosition("course"), {
    selection: { book: "intermediate", lesson: 3, st: 1 },
    expandedBookId: "intermediate",
  });
  assert.ok(rows.has(LANGUAGE_VIEW_MEMORY_KEY));
  delete globalThis.window;
});
