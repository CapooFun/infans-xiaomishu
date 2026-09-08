import assert from "node:assert/strict";
import test from "node:test";
import { createDisplayModeAccessService } from "../src/server/workbench-display-mode.mjs";

test("开源版拒绝展示模式解锁", () => {
  const service = createDisplayModeAccessService();
  assert.deepEqual(service.status(), { available: false, enrolled: false });
  assert.throws(() => service.verify(), (error) => error.status === 404);
});
