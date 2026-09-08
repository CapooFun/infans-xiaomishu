import assert from "node:assert/strict";
import test from "node:test";
import { createRequestCache } from "../src/request-cache-core.mjs";

test("request cache deduplicates concurrent reads and reuses session data", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createRequestCache(async () => {
    calls += 1;
    await gate;
    return { value: calls };
  });
  const first = cache.load("health");
  const second = cache.load("health");
  assert.equal(first, second);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(await cache.load("health"), { value: 1 });
  assert.equal(calls, 1);
});

test("request cache retains stale data on refresh failure and invalidates exactly", async () => {
  let calls = 0;
  const cache = createRequestCache(async () => {
    calls += 1;
    if (calls === 2) throw new Error("暂时不可用");
    return { value: calls };
  });
  assert.deepEqual(await cache.load("languages"), { value: 1 });
  await assert.rejects(() => cache.load("languages", true), /暂时不可用/);
  assert.deepEqual(cache.snapshot("languages"), {
    data: { value: 1 },
    error: "暂时不可用",
    loading: false,
  });
  cache.invalidate("languages");
  assert.deepEqual(cache.snapshot("languages"), { data: null, error: "", loading: false });
  assert.deepEqual(await cache.load("languages"), { value: 3 });
});

test("invalidation supersedes an older in-flight request", async () => {
  let calls = 0;
  const releases = [];
  const cache = createRequestCache(() => new Promise((resolve) => {
    calls += 1;
    releases.push(resolve);
  }));
  const stale = cache.load("health");
  cache.invalidate("health");
  const fresh = cache.load("health");
  assert.equal(calls, 2);
  releases[0]({ value: "stale" });
  releases[1]({ value: "fresh" });
  await Promise.all([stale, fresh]);
  assert.deepEqual(cache.snapshot("health"), { data: { value: "fresh" }, error: "", loading: false });
});
