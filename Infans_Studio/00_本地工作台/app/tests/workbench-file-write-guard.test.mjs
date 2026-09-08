import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWritableVaultPath, withVaultFileWrite } from "../src/server/workbench-file-write-guard.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "infans-write-guard-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "vault");
  await fs.mkdir(root);
  return { directory, root };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("cooperating writers share one queue through equivalent Vault root paths", { timeout: 3000 }, async (t) => {
  const { directory, root } = await fixture(t);
  const alias = path.join(directory, "vault-alias");
  await fs.symlink(root, alias, "dir");
  const entered = deferred();
  const release = deferred();
  const first = withVaultFileWrite(root, "note.md", async (target) => {
    entered.resolve();
    await release.promise;
    await fs.writeFile(target, "first");
  });
  await entered.promise;
  const second = withVaultFileWrite(alias, "./note.md", async (target) => {
    assert.equal(await fs.readFile(target, "utf8"), "first");
    await fs.writeFile(target, "second");
  });
  // Other targets remain writable while the first file's critical section waits.
  await withVaultFileWrite(root, "other.md", (target) => fs.writeFile(target, "independent"));
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(await fs.readFile(path.join(root, "note.md"), "utf8"), "second");
});

test("a rejected writer does not block later writes to that target", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(withVaultFileWrite(root, "note.md", () => { throw new Error("fixture failure"); }), /fixture failure/);
  await withVaultFileWrite(root, "note.md", (target) => fs.writeFile(target, "recovered"));
  assert.equal(await fs.readFile(path.join(root, "note.md"), "utf8"), "recovered");
});

test("write targets reject traversal and links, but allow missing regular parents", async (t) => {
  const { directory, root } = await fixture(t);
  const outside = path.join(directory, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "note.md"), "outside");
  await fs.symlink(outside, path.join(root, "linked"), "dir");
  await fs.symlink(path.join(outside, "note.md"), path.join(root, "leaf.md"));
  await assert.rejects(resolveWritableVaultPath(root, "../outside/note.md"), { code: "PATH_OUTSIDE_VAULT" });
  await assert.rejects(resolveWritableVaultPath(root, "linked/note.md"), { code: "PATH_SYMLINK_FORBIDDEN" });
  await assert.rejects(resolveWritableVaultPath(root, "leaf.md"), { code: "PATH_SYMLINK_FORBIDDEN" });
  assert.equal(await resolveWritableVaultPath(root, "new/sub/note.md"), path.join(await fs.realpath(root), "new/sub/note.md"));
});
