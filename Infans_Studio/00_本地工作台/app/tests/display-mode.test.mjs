import assert from "node:assert/strict";
import test from "node:test";
import { readDisplayMode, writeDisplayMode } from "../src/display-mode.ts";

test("开源版展示模式恒为关闭", () => {
  const storage = { getItem() { return "1"; }, setItem() {} };
  assert.equal(readDisplayMode(storage), false);
  writeDisplayMode(true, storage);
  assert.equal(readDisplayMode(storage), false);
});
