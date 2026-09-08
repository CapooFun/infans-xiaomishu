import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("开源版私人媒体模块不存在", () => {
  assert.equal(existsSync(fileURLToPath(new URL("../src/server/workbench-secretary-guest-media.mjs", import.meta.url))), false);
});
