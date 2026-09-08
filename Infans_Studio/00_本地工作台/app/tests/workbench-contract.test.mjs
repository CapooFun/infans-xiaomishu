import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECTION_DATA_KEYS } from "../src/types.ts";
import { queryLanguageReactor, scanWorkbenchSection } from "../src/server/workbench-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

for (const [section, expected] of Object.entries(SECTION_DATA_KEYS)) {
  test(`分区 ${section} 返回 key 集合与 types 预期一致`, async () => {
    const payload = await scanWorkbenchSection(root, section);
    assert.ok(payload.data && typeof payload.data === "object");
    const actual = Object.keys(payload.data).sort();
    assert.deepEqual(actual, [...expected].sort(), `实际 keys: ${actual.join(", ")}`);
  });
}

test("Language Reactor 分页可连续取得全部收藏而不是停在服务端上限", async () => {
  const first = await queryLanguageReactor(root, { offset: 0, limit: 60 });
  const second = await queryLanguageReactor(root, { offset: 60, limit: 60 });
  assert.equal(first.data.items.length, Math.min(60, first.data.total));
  if (first.data.total > 60) {
    assert.ok(second.data.items.length > 0);
    assert.equal(first.data.items.some((item) => item.id === second.data.items[0].id), false);
  }
});
