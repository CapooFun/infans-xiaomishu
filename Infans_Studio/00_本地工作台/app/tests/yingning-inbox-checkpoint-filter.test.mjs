import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECKPOINT_FILTER_COLLAPSE_AT,
  checkpointFilterChips,
  checkpointFilterCollapsible,
  checkpointFilterToggleLabel,
} from "../src/pages/tools/yingning-inbox-checkpoint-filter.ts";

function cps(...ids) {
  return ids.map((checkpointId) => ({ checkpointId, name: checkpointId }));
}

test("检查点不超过阈值时不收，全部铺开", () => {
  const items = cps("a", "b", "c");
  assert.equal(checkpointFilterCollapsible(items.length), false);
  assert.equal(checkpointFilterCollapsible(CHECKPOINT_FILTER_COLLAPSE_AT), false);
  assert.deepEqual(checkpointFilterChips(items, null, false), items);
  assert.deepEqual(checkpointFilterChips(items, "b", false), items);
});

test("检查点超过阈值时默认只留当前选中，未选则只留全部按钮", () => {
  const items = cps("a", "b", "c", "d", "e", "f", "g", "h", "i");
  assert.equal(checkpointFilterCollapsible(items.length), true);
  assert.deepEqual(checkpointFilterChips(items, null, false), []);
  assert.deepEqual(checkpointFilterChips(items, "c", false), [{ checkpointId: "c", name: "c" }]);
  assert.deepEqual(checkpointFilterChips(items, "missing", false), []);
});

test("展开后仍返回全部检查点，收起文案跟着状态走", () => {
  const items = cps("a", "b", "c", "d", "e", "f", "g", "h", "i");
  assert.deepEqual(checkpointFilterChips(items, "c", true), items);
  assert.equal(checkpointFilterToggleLabel(items.length, false), "9 个检查点");
  assert.equal(checkpointFilterToggleLabel(items.length, true), "收起");
});
