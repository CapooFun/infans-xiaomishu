import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("开源版不含房间组件", async () => {
  const room = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/secretary-room");
  await assert.rejects(stat(room), { code: "ENOENT" });
});
