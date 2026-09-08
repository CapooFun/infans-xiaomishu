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

test("INF-OSS-011 空目录提交时同名 canary 保留，不报告成功", async (t) => {
  const mini = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-r6-011-src-"));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-r6-011-parent-"));
  const target = path.join(parent, "existing-empty");
  const manifest = path.join(mini, "manifest.json");
  const gate = path.join(parent, "commit.gate");
  const sampleName = "待办事项与长期规划.md";
  await fs.mkdir(target);
  await fs.writeFile(path.join(mini, sampleName), "sample\n");
  await fs.writeFile(manifest, JSON.stringify({ files: [sampleName] }));
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
      INFANS_OSS_INIT_COMMIT_GATE: gate,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForFile(`${gate}.waiting`);
  await fs.writeFile(path.join(target, sampleName), "keep-foreign\n");
  await fs.writeFile(gate, "go\n");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(code, 0, `${stdout}\n${stderr}`);
  assert.match(`${stdout}\n${stderr}`, /目标已被其他内容占用|TARGET_OCCUPIED/u);
  assert.equal(await fs.readFile(path.join(target, sampleName), "utf8"), "keep-foreign\n");
  const leftoverStaging = (await fs.readdir(parent)).filter((name) => name.startsWith(".infans-init-staging-"));
  assert.deepEqual(leftoverStaging, []);
  assert.equal(existsSync(path.join(target, ".infans-opensource-ready.json")), false);
  assert.equal(existsSync(path.join(target, ".infans-opensource-init-failed.json")), true);
  const pointerNow = await fs.readFile(pointer, "utf8").catch(() => null);
  assert.equal(pointerNow, previousPointer);
  const bindImport = spawn(process.execPath, [initScript, "--bind", "--import", target], {
    cwd: appRoot,
    env: { ...process.env, INFANS_VAULT_ROOT: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bindOut = "";
  let bindErr = "";
  bindImport.stdout.on("data", (chunk) => { bindOut += chunk; });
  bindImport.stderr.on("data", (chunk) => { bindErr += chunk; });
  const bindCode = await new Promise((resolve) => bindImport.on("close", resolve));
  assert.notEqual(bindCode, 0, `${bindOut}\n${bindErr}`);
  assert.match(`${bindOut}\n${bindErr}`, /失败的初始化半成品|不要整目录删除/u);
  const pointerAfterBind = await fs.readFile(pointer, "utf8").catch(() => null);
  assert.equal(pointerAfterBind, previousPointer);
});

test("原生检查器只介绍一对一会话", async () => {
  const inspector = await fs.readFile(path.join(appRoot, "native/InfansHealthSync/InfansHealthSync/SecretaryConversationInspectorView.swift"), "utf8");
  assert.match(inspector, /一对一会话/);
});
