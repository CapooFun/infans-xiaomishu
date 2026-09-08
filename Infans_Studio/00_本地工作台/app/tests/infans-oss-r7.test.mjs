import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const initScript = path.join(appRoot, "scripts/init-opensource-data.mjs");

async function waitForFile(file, attempts = 250) {
  for (let i = 0; i < attempts; i += 1) {
    if (await fs.access(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待文件超时：${file}`);
}

test("INF-OSS-011 回滚不删除已放入目录里的外来文件", async (t) => {
  const mini = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-r7-011-src-"));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-r7-011-parent-"));
  const target = path.join(parent, "existing-empty");
  const manifest = path.join(mini, "manifest.json");
  const placeGate = path.join(parent, "place.gate");
  const dirName = "a-notes";
  const laterName = "z-todo.md";
  await fs.mkdir(target);
  await fs.mkdir(path.join(mini, dirName));
  await fs.writeFile(path.join(mini, dirName, "readme.md"), "sample-dir\n");
  await fs.writeFile(path.join(mini, laterName), "sample-later\n");
  await fs.writeFile(manifest, JSON.stringify({ files: [`${dirName}/readme.md`, laterName] }));
  const pointer = path.join(appRoot, ".infans-vault-root");
  const previousPointer = await fs.readFile(pointer, "utf8").catch(() => null);
  t.after(async () => {
    if (previousPointer == null) await fs.rm(pointer, { force: true });
    else await fs.writeFile(pointer, previousPointer, { mode: 0o600 });
    await fs.rm(mini, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
  });
  const child = spawn(process.execPath, [initScript, target], {
    cwd: appRoot,
    env: {
      ...process.env,
      INFANS_VAULT_ROOT: "",
      INFANS_OSS_EXAMPLE_SOURCE: mini,
      INFANS_OSS_EXAMPLE_MANIFEST: manifest,
      INFANS_OSS_INIT_PLACE_GATE: placeGate,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForFile(`${placeGate}.1.waiting`);
  await fs.writeFile(path.join(target, dirName, "CANARY_FOREIGN.txt"), "keep-dir-foreign\n");
  await fs.writeFile(path.join(target, laterName), "keep-later-foreign\n");
  await fs.writeFile(`${placeGate}.1`, "go\n");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(code, 0, `${stdout}\n${stderr}`);
  assert.match(`${stdout}\n${stderr}`, /目标已被其他内容占用|TARGET_OCCUPIED/u);
  assert.match(`${stdout}\n${stderr}`, /不要整目录删除/u);
  assert.equal(await fs.readFile(path.join(target, dirName, "CANARY_FOREIGN.txt"), "utf8"), "keep-dir-foreign\n");
  assert.equal(await fs.readFile(path.join(target, laterName), "utf8"), "keep-later-foreign\n");
  assert.equal(await fs.readFile(path.join(target, dirName, "readme.md"), "utf8"), "sample-dir\n");
  const leftoverStaging = (await fs.readdir(parent)).filter((name) => name.startsWith(".infans-init-staging-"));
  assert.deepEqual(leftoverStaging, []);
  assert.equal(existsSync(path.join(target, ".infans-opensource-ready.json")), false);
  assert.equal(existsSync(path.join(target, ".infans-opensource-init-failed.json")), true);
  const pointerNow = await fs.readFile(pointer, "utf8").catch(() => null);
  assert.equal(pointerNow, previousPointer);
});
