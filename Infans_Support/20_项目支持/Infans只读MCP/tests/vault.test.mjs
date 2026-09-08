import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DEFAULT_LIMITS } from "../src/config.mjs";
import { createVaultReader } from "../src/vault.mjs";
import { makeFixture, writeMinimalPdf } from "./helpers.mjs";

function readerFor(fixture, options = {}) {
  return createVaultReader({ vaultRoot: fixture.vaultRoot, stateDirectory: fixture.stateDirectory, limits: DEFAULT_LIMITS, ...options });
}

test("lists allowed content and hides excluded roots", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const result = await readerFor(fixture).list("", 2);
  assert(result.entries.some((entry) => entry.path === "首页.md"));
  assert(!result.entries.some((entry) => entry.path.startsWith(".git")));
  assert(!result.entries.some((entry) => entry.path.startsWith(".claude")));
  assert(!result.entries.some((entry) => entry.path === ".env"));
});

test("reads text in bounded chunks without changing the source", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const source = path.join(fixture.vaultRoot, "首页.md");
  const before = await fs.stat(source);
  const result = await readerFor(fixture).read("首页.md", { start: 0, maxChars: 8 });
  const after = await fs.stat(source);
  assert.equal(result.text, "# 首页\n今天继");
  assert.equal(result.truncated, true);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("searches text using literal queries", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const result = await readerFor(fixture).search("云存档");
  assert.equal(result.resultCount, 1);
  assert.equal(result.results[0].path, "30_事业顺利/游戏开发/项目.md");
});

test("searches text when ripgrep is unavailable in the runtime environment", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const result = await readerFor(fixture, { rgExecutable: false }).search("云存档");
  assert.equal(result.resultCount, 1);
  assert.equal(result.results[0].path, "30_事业顺利/游戏开发/项目.md");
  assert.equal(result.results[0].line, 1);
});

test("reads and searches PDF text", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  await writeMinimalPdf(path.join(fixture.vaultRoot, "资料.pdf"));
  const reader = readerFor(fixture);
  const readResult = await reader.read("资料.pdf", { pageStart: 1, pageCount: 1 });
  assert.match(readResult.pages[0].text, /Vault PDF marker/);
  const searchResult = await reader.search("PDF marker");
  assert(searchResult.results.some((result) => result.path === "资料.pdf" && result.page === 1));
});

for (const [name, requestedPath, code] of [
  ["parent traversal", "../outside.txt", "PATH_ESCAPE_DENIED"],
  ["absolute path", "/etc/passwd", "ABSOLUTE_PATH_DENIED"],
  ["git internals", ".git/secret", "EXCLUDED_PATH"],
  ["environment file", ".env", "EXCLUDED_FILE"],
  ["AI archive", ".claude/history.json", "EXCLUDED_PATH"],
  ["escaping symlink", "outside-link.txt", "SYMLINK_ESCAPE_DENIED"],
]) {
  test(`denies ${name}`, async (t) => {
    const fixture = await makeFixture();
    t.after(fixture.cleanup);
    await assert.rejects(() => readerFor(fixture).read(requestedPath), (error) => error?.code === code);
  });
}
