import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { instanceIdFor } from "../src/workbench-instance.mjs";
import {
  createPublicThreadBuffer,
  mergeLoadedSession,
} from "../src/opensource-thread-buffer.mjs";
import { osCalendarEnabled, instanceCalendarCacheDir } from "../src/server/workbench-calendar.mjs";
import { isScheduleQuestion, resolveScheduleDate } from "../src/server/workbench-schedule-date.mjs";
import { unifiedReminderActionFromGenerated } from "../src/server/workbench-unified-reminder.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const initScript = path.join(appRoot, "scripts/init-opensource-data.mjs");
const startLocal = path.join(appRoot, "scripts/start-local.sh");

function runNode(args, env, cwd = appRoot) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitHealth(url, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (response.ok) return await response.json();
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`健康检查超时：${url}`);
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

test("INF-OSS-011 祖先符号链接不能把数据根建进仓库", async () => {
  const repo = path.resolve(appRoot, "../../..");
  const alias = path.join(os.tmpdir(), `infans-oss-011-alias-${Date.now()}`);
  await fs.symlink(repo, alias);
  const nested = path.join(alias, `nested-data-${Date.now()}`);
  const result = await runNode([initScript, nested], { INFANS_VAULT_ROOT: "" });
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /仓库外|符号链接|不能建在候选|不能建在候选目录里/);
  assert.equal(existsSync(path.join(repo, path.basename(nested))), false);
  await fs.rm(alias, { force: true });
});

test("INF-OSS-011 精确清单不复制目录里后加的运行文档", async (t) => {
  const canaryRel = path.join(appRoot, "../../10_日志记录/CANARY-RUNTIME.md");
  const existed = await fs.readFile(canaryRel, "utf8").catch(() => null);
  await fs.mkdir(path.dirname(canaryRel), { recursive: true });
  await fs.writeFile(canaryRel, "CANARY-NOT-A-BUNDLED-SAMPLE\n");
  t.after(async () => {
    if (existed == null) await fs.rm(canaryRel, { force: true });
    else await fs.writeFile(canaryRel, existed);
  });
  const fresh = path.join(os.tmpdir(), `infans-oss-011-manifest-${Date.now()}`);
  const created = await runNode([initScript, fresh], { INFANS_VAULT_ROOT: "" });
  t.after(() => fs.rm(fresh, { recursive: true, force: true }));
  assert.equal(created.code, 0, created.stderr);
  assert.equal(existsSync(path.join(fresh, "10_日志记录/CANARY-RUNTIME.md")), false);
  assert.equal(existsSync(path.join(fresh, ".infans-opensource-ready.json")), true);
});

test("INF-OSS-011 已有空目录失败可回滚且不能 bind 半成品", async (t) => {
  const mini = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-011-mini-"));
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-011-empty-"));
  const manifest = path.join(mini, "manifest.json");
  await fs.writeFile(path.join(mini, "待办事项与长期规划.md"), "sample\n");
  await fs.mkdir(path.join(mini, "30_事业顺利"), { recursive: true });
  await fs.symlink(os.tmpdir(), path.join(mini, "30_事业顺利/canary.md"));
  await fs.writeFile(manifest, JSON.stringify({ files: ["待办事项与长期规划.md", "30_事业顺利/canary.md"] }));
  const pointer = path.join(appRoot, ".infans-vault-root");
  const previousPointer = await fs.readFile(pointer, "utf8").catch(() => null);
  t.after(async () => {
    if (previousPointer == null) await fs.rm(pointer, { force: true });
    else await fs.writeFile(pointer, previousPointer, { mode: 0o600 });
    await fs.rm(mini, { recursive: true, force: true });
    await fs.rm(empty, { recursive: true, force: true });
  });
  const failed = await runNode([initScript, empty], {
    INFANS_VAULT_ROOT: "",
    INFANS_OSS_EXAMPLE_SOURCE: mini,
    INFANS_OSS_EXAMPLE_MANIFEST: manifest,
  });
  assert.notEqual(failed.code, 0);
  assert.match(`${failed.stdout}${failed.stderr}`, /符号链接/);
  assert.equal(existsSync(path.join(empty, "30_事业顺利")), false);
  assert.equal(existsSync(path.join(empty, ".infans-opensource-init-failed.json")), true);
  const bind = await runNode([initScript, "--bind", empty], { INFANS_VAULT_ROOT: "" });
  assert.notEqual(bind.code, 0);
  assert.match(`${bind.stdout}${bind.stderr}`, /完整初始化标记|半成品/);
});

test("INF-OSS-014 恢复完成前禁止持久化，失败不退回共享键", async () => {
  const storage = memoryStorage();
  const keyA = "infans-oss-ai-thread-v1:instance-a";
  storage.setItem(keyA, JSON.stringify({
    schemaVersion: 8,
    archiveId: "CANARY-ARCHIVE",
    title: "canary",
    messages: [
      { id: "1", role: "user", content: "CANARY-1" },
      { id: "2", role: "assistant", speaker: "yinyue", content: "CANARY-2" },
    ],
  }));
  const buffer = createPublicThreadBuffer({
    storage,
    fetchHealth: async () => ({
      ok: true,
      json: async () => ({ instanceId: "instance-a" }),
    }),
  });
  assert.equal(buffer.persist({ messages: [], archiveId: null, title: "" }, "yinyue").skipped, true);
  const bound = await buffer.bind();
  assert.equal(bound.key, keyA);
  const loaded = buffer.load("yinyue");
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.archiveId, "CANARY-ARCHIVE");
  buffer.markReady();
  const merged = mergeLoadedSession(loaded, { messages: [] });
  assert.equal(merged.messages.length, 2);
  const failed = createPublicThreadBuffer({
    storage,
    fetchHealth: async () => ({ ok: false, json: async () => ({}) }),
  });
  const failBound = await failed.bind();
  assert.ok(failBound.error);
  assert.equal(failed.key, null);
  assert.equal(failed.persist({ messages: [], archiveId: null, title: "" }, "yinyue").skipped, true);
  const still = JSON.parse(storage.getItem(keyA));
  assert.equal(still.archiveId, "CANARY-ARCHIVE");
  assert.equal(still.messages.length, 2);
});

test("INF-OSS-004 Watch 会话实现已从源码拿掉，通用日程与提醒仍在", async () => {
  assert.equal(existsSync(path.join(appRoot, "src/server/workbench-watch-secretary.mjs")), false);
  const overlays = await fs.readFile(path.join(appRoot, "src/shell/WorkbenchOverlays.tsx"), "utf8");
  assert.doesNotMatch(overlays, /activatePrivateOverlay/);
  const lab = await fs.readFile(path.join(appRoot, "src/pages/tools/NativeUiDesignLab.tsx"), "utf8");
  assert.doesNotMatch(lab, /Apple Watch 入口/);
  assert.doesNotMatch(lab, /function WatchScreen/);
  const friday = new Date("2026-08-28T01:00:00+09:00");
  assert.equal(isScheduleQuestion("我星期天下午有什么安排"), true);
  assert.equal(resolveScheduleDate("我明天有什么日程", friday), "2026-08-29");
  const reminder = unifiedReminderActionFromGenerated({
    kind: "calendarCreate",
    title: "交水电费",
    start: "2026-09-02T06:00:00.000Z",
    end: "2026-09-02T06:30:00.000Z",
  }, {
    schemaVersion: 1,
    commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa9",
    createdAt: "2026-09-01T01:02:03+09:00",
    text: "明天下午三点提醒我交水电费",
    routing: { unifiedReminder: { executor: "apple_reminders", operation: "create", requiresClarification: false } },
  });
  assert.equal(reminder.kind, "unifiedReminder");
});

test("INF-OSS-003 日历禁用默认关闭，启用才用实例缓存", () => {
  assert.equal(osCalendarEnabled({}), false);
  assert.equal(osCalendarEnabled({ INFANS_CALENDAR_OS: "1" }), true);
  const vault = "/tmp/infans-oss-cal-vault";
  assert.equal(instanceCalendarCacheDir(vault), path.join(vault, "00_本地工作台/派生数据/calendar-cache"));
});

test("INF-OSS-010 聚合哈希可复算；排序不同会变，不改历史官方摘要", () => {
  const files = [
    { path: "b.md", sha256: "11".repeat(32) },
    { path: "a.md", sha256: "22".repeat(32) },
  ];
  const digest = (rows, reverse = false) => {
    const ordered = [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (reverse) ordered.reverse();
    return crypto.createHash("sha256").update(ordered.map((item) => `${item.path}\0${item.sha256}\n`).join("")).digest("hex");
  };
  const pathOrder = digest(files);
  const reverseOrder = digest(files, true);
  assert.notEqual(pathOrder, reverseOrder);
  assert.equal(pathOrder, digest(files));
  assert.equal("d0046d4289a9c6449857ab96dd4c4d5a9443769590c2ff2219c500282733fd1c".length, 64);
  assert.notEqual("d0046d4289a9c6449857ab96dd4c4d5a9443769590c2ff2219c500282733fd1c", "c74216aca4901bf0700983b481eda70a4aea1b04c730aac06a3b0661ede4bc88");
});

test("INF-OSS-001/009 真实 start-local 与构建页：冷启动、健康、停止重开、双数据根", async (t) => {
  const distHtml = path.join(appRoot, "dist/index.html");
  const built = await runNode([path.join(appRoot, "scripts/build-frontend.mjs")], {
    INFANS_VAULT_ROOT: "",
  });
  assert.equal(built.code, 0, built.stderr.slice(-2000));
  const html = await fs.readFile(distHtml, "utf8");
  assert.match(html, /<div id="root">|<script/i);
  assert.doesNotMatch(html, /oss-012/);

  const stopGroup = (child) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
  };

  const start = async (vault, port) => {
    const child = spawn("bash", [startLocal], {
      cwd: appRoot,
      detached: true,
      env: {
        ...process.env,
        HOME: await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-home-")),
        INFANS_VAULT_ROOT: vault,
        INFANS_PORT: String(port),
        INFANS_HOST: "127.0.0.1",
        INFANS_CALENDAR_OS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return child;
  };

  const vaultA = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-start-a-"));
  const vaultB = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-start-b-"));
  const portA = 19000 + Math.floor(Math.random() * 800);
  const portB = portA + 1;
  const childA = await start(vaultA, portA);
  t.after(() => stopGroup(childA));
  const healthA = await waitHealth(`http://127.0.0.1:${portA}/api/health`, 90);
  assert.equal(healthA.ok, true);
  assert.equal(healthA.instanceId, instanceIdFor(appRoot, vaultA));
  const page = await fetch(`http://127.0.0.1:${portA}/`);
  assert.equal(page.ok, true);
  const pageText = await page.text();
  assert.match(pageText, /<script/i);

  const childB = await start(vaultB, portB);
  t.after(() => stopGroup(childB));
  const healthB = await waitHealth(`http://127.0.0.1:${portB}/api/health`, 90);
  assert.notEqual(healthB.instanceId, healthA.instanceId);

  stopGroup(childA);
  await new Promise((resolve) => childA.once("close", resolve));
  const childA2 = await start(vaultA, portA);
  t.after(() => stopGroup(childA2));
  const reopened = await waitHealth(`http://127.0.0.1:${portA}/api/health`, 90);
  assert.equal(reopened.instanceId, healthA.instanceId);
});
