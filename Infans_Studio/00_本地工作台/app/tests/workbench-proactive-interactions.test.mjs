import assert from "node:assert/strict";
import test from "node:test";
import { createProactiveInteractionService } from "../src/server/workbench-proactive-interactions.mjs";

test("开源版主动来访为空", async () => {
  const service = createProactiveInteractionService();
  assert.deepEqual(await service.peek(), { items: [] });
});
