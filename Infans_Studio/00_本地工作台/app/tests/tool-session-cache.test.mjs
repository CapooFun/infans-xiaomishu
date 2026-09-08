import assert from "node:assert/strict";
import test from "node:test";

import { createToolSessionCache, invalidateAllToolSessionCaches } from "../src/tool-session-cache.ts";

test("工具会话缓存合并并发读取并复用成功快照", async () => {
  let calls = 0;
  const cache = createToolSessionCache(async (key) => ({ key, calls: ++calls }));
  const [first, second] = await Promise.all([cache.load("tools"), cache.load("tools")]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(await cache.load("tools"), first);
  assert.equal(calls, 1);
});

test("工具会话缓存支持明确刷新、短时过期和写后更新", async () => {
  let calls = 0;
  const cache = createToolSessionCache(async () => ({ calls: ++calls }));
  assert.equal((await cache.load("renewals")).calls, 1);
  assert.equal((await cache.load("renewals", { force: true })).calls, 2);
  cache.set("renewals", { calls: 9 });
  assert.equal(cache.get("renewals")?.calls, 9);
  assert.equal((await cache.load("renewals", { maxAgeMs: -1 })).calls, 3);
  invalidateAllToolSessionCaches();
  assert.equal(cache.get("renewals"), null);
});
