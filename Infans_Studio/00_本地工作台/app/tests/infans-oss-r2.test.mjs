import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decideListenerAction,
  instanceIdFor,
  parseListenPort,
  restartLooksRecovered,
} from "../src/workbench-instance.mjs";
import {
  assistantShiftIsPublic,
  publicThreadStorageKey,
  assertPublicChatPayload,
} from "../src/opensource-chat-session.mjs";
import { existsSync } from "node:fs";
import { defaultCalendarCacheDir, osCalendarEnabled, readCachedCalendarNames } from "../src/server/workbench-calendar.mjs";
import { WorkbenchWriteError } from "../src/server/workbench-errors.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const initScript = path.join(appRoot, "scripts/init-opensource-data.mjs");
const serveScript = path.join(appRoot, "src/server/serve.mjs");

function runNode(args, env, cwd = appRoot, timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => { child.kill("SIGTERM"); }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitHealth(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (response.ok) return await response.json();
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`健康检查超时：${url}`);
}

test("INF-OSS-001 同一工程不同数据根不是同一实例", () => {
  const app = "/tmp/infans-oss-same-app";
  const vaultA = "/tmp/infans-oss-vault-a";
  const vaultB = "/tmp/infans-oss-vault-b";
  assert.notEqual(instanceIdFor(app, vaultA), instanceIdFor(app, vaultB));
  const decision = decideListenerAction({
    health: { ok: true, version: "1.16.0", instanceId: instanceIdFor(app, vaultA), vaultRoot: vaultA },
    listenerCommand: "node src/server/serve.mjs",
    listenerCwd: app,
    expectedAppDir: app,
    expectedVersion: "1.16.0",
    expectedInstanceId: instanceIdFor(app, vaultB),
    expectedVaultRoot: vaultB,
  });
  assert.equal(decision.action, "conflict");
  assert.equal(decision.signal, null);
});

test("INF-OSS-001 非法端口失败，平滑重启必须核对 instanceId", () => {
  assert.throws(() => parseListenPort({ INFANS_PORT: "not-a-port" }), /不合法/);
  assert.equal(parseListenPort({ INFANS_PORT: "5199" }).port, 5199);
  assert.equal(restartLooksRecovered({
    health: { ok: true, version: "1.16.0", instanceId: "aaa", vaultRoot: "/tmp/a" },
    expectedInstanceId: "aaa",
    expectedVersion: "1.16.0",
    expectedVaultRoot: "/tmp/a",
    replacementPid: "22",
    previousPid: "11",
  }), true);
  assert.equal(restartLooksRecovered({
    health: { ok: true, version: "1.16.0", instanceId: "hijack", vaultRoot: "/tmp/a" },
    expectedInstanceId: "aaa",
    expectedVersion: "1.16.0",
    expectedVaultRoot: "/tmp/a",
    replacementPid: "22",
    previousPid: "11",
  }), false);
});

test("INF-OSS-011 已有 canary 与二次编辑拒绝覆盖，符号链接不写出目标外", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-011-exist-"));
  await fs.writeFile(path.join(target, "CANARY-USER-KEEP.md"), "CANARY-USER-KEEP\n");
  const first = await runNode([initScript, target], { INFANS_VAULT_ROOT: "" });
  assert.notEqual(first.code, 0);
  assert.match(`${first.stdout}${first.stderr}`, /已有内容|bind:data|不能建在候选/);
  assert.equal(await fs.readFile(path.join(target, "CANARY-USER-KEEP.md"), "utf8"), "CANARY-USER-KEEP\n");

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-011-out-"));
  const victim = path.join(outside, "victim.txt");
  await fs.writeFile(victim, "CANARY-LINK-KEEP\n");
  const linkRoot = path.join(os.tmpdir(), `infans-oss-011-link-${Date.now()}`);
  await fs.symlink(outside, linkRoot);
  const linked = await runNode([initScript, linkRoot], {});
  assert.notEqual(linked.code, 0);
  assert.equal(await fs.readFile(victim, "utf8"), "CANARY-LINK-KEEP\n");
  await fs.rm(linkRoot, { force: true });
});

test("INF-OSS-011 仓库内目标和源码内 .local 都不得铺进新库", async (t) => {
  const pointer = path.join(appRoot, ".infans-vault-root");
  const previousPointer = await fs.readFile(pointer, "utf8").catch(() => null);
  t.after(async () => {
    if (previousPointer == null) await fs.rm(pointer, { force: true });
    else await fs.writeFile(pointer, previousPointer, { mode: 0o600 });
  });
  const insideRepo = path.join(appRoot, "..", "..", `tmp-oss-init-${Date.now()}`);
  const inside = await runNode([initScript, insideRepo], { INFANS_VAULT_ROOT: "" });
  assert.notEqual(inside.code, 0);
  await fs.rm(insideRepo, { recursive: true, force: true });

  const fresh = path.join(os.tmpdir(), `infans-oss-011-fresh-${Date.now()}`);
  const healthLocal = path.join(appRoot, ".health-sync.local");
  const existed = await fs.readFile(healthLocal, "utf8").catch(() => null);
  await fs.writeFile(healthLocal, "CANARY-LOCAL-CONFIG=1\n", { mode: 0o600 });
  t.after(async () => {
    if (existed == null) await fs.rm(healthLocal, { force: true });
    else await fs.writeFile(healthLocal, existed, { mode: 0o600 });
  });
  const created = await runNode([initScript, fresh], { INFANS_VAULT_ROOT: "" });
  assert.equal(created.code, 0, created.stderr);
  const copied = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else copied.push(full);
    }
  }
  await walk(fresh);
  assert.equal(copied.some((item) => item.endsWith(".health-sync.local") || item.includes(`${path.sep}app${path.sep}`)), false);
  assert.equal(copied.some((item) => item.includes("待办事项与长期规划.md")), true);
});

test("INF-OSS-012 生产入口冷启动可持续健康，停止后可重开", async (t) => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-012-vault-"));
  const distDir = path.join(appRoot, "dist");
  const distHtml = path.join(distDir, "index.html");
  await fs.mkdir(distDir, { recursive: true });
  const previous = await fs.readFile(distHtml, "utf8").catch(() => null);
  await fs.writeFile(distHtml, "<!doctype html><title>oss-012</title>");
  t.after(async () => {
    if (previous == null) await fs.rm(distHtml, { force: true });
    else await fs.writeFile(distHtml, previous);
  });

  const start = (port) => spawn(process.execPath, [serveScript], {
    cwd: appRoot,
    env: {
      ...process.env,
      INFANS_VAULT_ROOT: vault,
      INFANS_PORT: String(port),
      INFANS_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const portA = 18000 + Math.floor(Math.random() * 1000);
  const child = start(portA);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const health = await waitHealth(`http://127.0.0.1:${portA}/api/health`);
  assert.equal(health.ok, true);
  assert.equal(health.product, "infans-opensource");
  assert.equal(health.instanceId, instanceIdFor(appRoot, vault));
  const again = await waitHealth(`http://127.0.0.1:${portA}/api/health`);
  assert.equal(again.instanceId, health.instanceId);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
  assert.doesNotMatch(stderr, /WORKBENCH_VERSION is not defined/);

  const child2 = start(portA);
  t.after(() => child2.kill("SIGTERM"));
  const reopened = await waitHealth(`http://127.0.0.1:${portA}/api/health`);
  assert.equal(reopened.ok, true);
  child2.kill("SIGTERM");
});

test("INF-OSS-012 去掉版本定义时检查门应失败", async (t) => {
  const source = await fs.readFile(serveScript, "utf8");
  assert.match(source, /WORKBENCH_VERSION/);
  const mutant = source.replace(/import \{ WORKBENCH_VERSION \} from "\.\/workbench-data\.mjs";\n/, "");
  assert.match(mutant, /v\$\{WORKBENCH_VERSION\}/);
  assert.doesNotMatch(mutant, /import \{ WORKBENCH_VERSION \}/);
  const mutantPath = path.join(appRoot, "src/server/.infans-oss-012-mutant.mjs");
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-012-mutant-"));
  await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
  const distHtml = path.join(appRoot, "dist/index.html");
  const previous = await fs.readFile(distHtml, "utf8").catch(() => null);
  if (previous == null) await fs.writeFile(distHtml, "<!doctype html><title>oss-012-mutant</title>");
  await fs.writeFile(mutantPath, mutant);
  t.after(async () => {
    await fs.rm(mutantPath, { force: true });
    if (previous == null) await fs.rm(distHtml, { force: true });
  });
  const port = 18100 + Math.floor(Math.random() * 800);
  const result = await runNode([mutantPath], {
    INFANS_VAULT_ROOT: vault,
    INFANS_PORT: String(port),
    INFANS_HOST: "127.0.0.1",
  }, appRoot, 8000);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /WORKBENCH_VERSION is not defined|WORKBENCH_VERSION/);
});

test("INF-OSS-003 日历辅助入口不得回落共享 HOME 缓存", async () => {
  assert.equal(osCalendarEnabled({}), false);
  assert.throws(() => defaultCalendarCacheDir(), /实例缓存目录/);
  await assert.rejects(() => readCachedCalendarNames(), /实例缓存目录/);
});

test("INF-OSS-004 Watch 生命周期不再激活或重试产品链", async () => {
  const app = await fs.readFile(path.join(appRoot, "native/InfansHealthSync/InfansHealthSync/InfansHealthSyncApp.swift"), "utf8");
  assert.doesNotMatch(app, /PhoneCommandBridge\.shared\.retryPending/);
  assert.doesNotMatch(app, /CodexCommandRetrySchedule/);
  const bridge = await fs.readFile(path.join(appRoot, "native/InfansHealthSync/InfansHealthSync/PhoneCommandBridge.swift"), "utf8");
  assert.doesNotMatch(bridge, /import WatchConnectivity/);
  assert.doesNotMatch(bridge, /WCSession/);
  assert.equal(existsSync(path.join(appRoot, "src/server/workbench-watch-secretary.mjs")), false);
  const routes = await fs.readFile(path.join(appRoot, "src/server/workbench-routes.mjs"), "utf8");
  assert.match(routes, /WATCH_EXCLUDED/);
});

test("INF-OSS-005 main 不再用 invite 查询打开会话", async () => {
  const main = await fs.readFile(path.join(appRoot, "src/main.tsx"), "utf8");
  assert.doesNotMatch(main, /get\("invite"\) === "1"/);
});

test("INF-OSS-013 银月梅凝换班仍是一对一，缓冲键按实例隔离", () => {
  const messages = [
    { role: "user", content: "CANARY-SHIFT-1" },
    { role: "assistant", speaker: "yinyue", content: "CANARY-YINYUE" },
    { role: "assistant", speaker: "meining", content: "CANARY-MEINING" },
  ];
  assert.equal(assistantShiftIsPublic(messages, "meining"), true);
  assert.doesNotThrow(() => assertPublicChatPayload({
    messages,
    privacy: "standard",
    indexPolicy: "allow",
  }));
  assert.notEqual(publicThreadStorageKey("vault-a"), publicThreadStorageKey("vault-b"));
  assert.match(publicThreadStorageKey("abc"), /^infans-oss-ai-thread-v1:abc$/);
});

test("INF-OSS-002/013 私人会话输入仍拒绝", () => {
  assert.throws(() => assertPublicChatPayload({ privacy: "private", messages: [{ role: "user", content: "CANARY-PRIVATE" }] }), WorkbenchWriteError);
});
