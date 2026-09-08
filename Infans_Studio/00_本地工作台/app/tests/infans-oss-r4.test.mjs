import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createPublicThreadBuffer,
  mergeLoadedSession,
  parseOneOnOneSession,
  shouldAutoApplyDiskArchive,
} from "../src/opensource-thread-buffer.mjs";
import {
  assertExcludedWatchCommand,
  createCodexCommandInboxService,
  FORBIDDEN_SHARED_CODEX_COMMAND_INBOX_DIR,
  instanceCodexCommandInboxDir,
} from "../src/server/workbench-codex-command-inbox.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const initScript = path.join(appRoot, "scripts/init-opensource-data.mjs");

async function waitForFile(file, attempts = 250) {
  for (let i = 0; i < attempts; i += 1) {
    if (await fs.access(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待文件超时：${file}`);
}

test("INF-OSS-011 并发抢占目标时只清自己的暂存，不删他人 canary", async (t) => {
  const mini = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-r4-011-src-"));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-r4-011-parent-"));
  const target = path.join(parent, "fresh-vault");
  const manifest = path.join(mini, "manifest.json");
  const gate = path.join(parent, "commit.gate");
  await fs.writeFile(path.join(mini, "待办事项与长期规划.md"), "sample\n");
  await fs.writeFile(manifest, JSON.stringify({ files: ["待办事项与长期规划.md"] }));
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
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "CANARY-FOREIGN"), "keep-me\n");
  await fs.writeFile(gate, "go\n");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(code, 0, `${stdout}\n${stderr}`);
  assert.equal(await fs.readFile(path.join(target, "CANARY-FOREIGN"), "utf8"), "keep-me\n");
  const leftoverStaging = (await fs.readdir(parent)).filter((name) => name.startsWith(".infans-init-staging-"));
  assert.deepEqual(leftoverStaging, []);
  assert.equal(existsSync(path.join(target, ".infans-opensource-ready.json")), false);
});

test("INF-OSS-014 有较新缓冲或冲突时禁止自动套磁盘存档", () => {
  const four = [
    { id: "1", role: "user", content: "CANARY-LIVE-1" },
    { id: "2", role: "assistant", speaker: "yinyue", content: "CANARY-LIVE-2" },
    { id: "3", role: "user", content: "CANARY-LIVE-3" },
    { id: "4", role: "assistant", speaker: "yinyue", content: "CANARY-LIVE-4" },
  ];
  const parsed = parseOneOnOneSession(JSON.stringify({
    schemaVersion: 8,
    archiveId: "CANARY-ARCHIVE",
    title: "live",
    saveConflict: false,
    generation: 4,
    messages: four,
  }));
  assert.equal(parsed.hasBufferedBody, true);
  assert.equal(parsed.bufferedMessageCount, 4);
  assert.equal(parsed.generation, 4);
  assert.equal(shouldAutoApplyDiskArchive(parsed), false);
  assert.equal(shouldAutoApplyDiskArchive({ archiveId: "CANARY-ARCHIVE", messages: four, saveConflict: false }), false);
  assert.equal(shouldAutoApplyDiskArchive({ archiveId: "CANARY-ARCHIVE", messages: four, saveConflict: true }), false);
  assert.equal(shouldAutoApplyDiskArchive({ archiveId: "CANARY-ARCHIVE", messages: [], saveConflict: true }), false);
  assert.equal(shouldAutoApplyDiskArchive({ archiveId: "CANARY-ARCHIVE", messages: [], saveConflict: false }), true);
  const loaded = { archiveId: "CANARY-ARCHIVE", messages: four.slice(0, 2), title: "disk" };
  const mergedConflict = mergeLoadedSession(loaded, { messages: four, title: "live" });
  assert.equal(mergedConflict.messages.length, 4);
  assert.equal(shouldAutoApplyDiskArchive(mergedConflict), false);
});

test("INF-OSS-014 延迟保存模型：关开后仍保留四条，不套磁盘两条", async () => {
  const storage = {
    map: new Map(),
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; },
    setItem(key, value) { this.map.set(key, String(value)); },
    removeItem(key) { this.map.delete(key); },
  };
  const key = "infans-oss-ai-thread-v1:instance-r4";
  storage.setItem(key, JSON.stringify({
    schemaVersion: 8,
    archiveId: "CANARY-ARCHIVE",
    title: "live",
    saveConflict: false,
    generation: 4,
    messages: [
      { id: "1", role: "user", content: "CANARY-1" },
      { id: "2", role: "assistant", speaker: "yinyue", content: "CANARY-2" },
      { id: "3", role: "user", content: "CANARY-3" },
      { id: "4", role: "assistant", speaker: "yinyue", content: "CANARY-4" },
    ],
  }));
  const buffer = createPublicThreadBuffer({
    storage,
    fetchHealth: async () => ({
      ok: true,
      json: async () => ({ instanceId: "instance-r4" }),
    }),
  });
  const bound = await buffer.bind();
  assert.equal(bound.key, key);
  const loaded = buffer.load("yinyue");
  const merged = mergeLoadedSession(loaded, { messages: loaded.messages, title: loaded.title });
  assert.equal(merged.messages.length, 4);
  assert.equal(shouldAutoApplyDiskArchive(merged), false);
  buffer.markReady();
  const still = JSON.parse(storage.getItem(key));
  assert.equal(still.messages.length, 4);
});

test("INF-OSS-004 排除来源在 ensureInbox 之前拒绝，双数据根不串库", async () => {
  const vaultA = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-r4-004-a-"));
  const vaultB = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-r4-004-b-"));
  const command = {
    schemaVersion: 1,
    commandId: "88cfe608-17e8-4d0d-a4ad-21ab20955aa1",
    text: "记一下明天和某人吃饭",
    createdAt: "2026-08-28T01:02:03Z",
    source: "apple_watch_app",
    deviceId: "watch-01",
    route: "auto",
  };
  const a = createCodexCommandInboxService({ root: vaultA });
  const b = createCodexCommandInboxService({ root: vaultB });
  assert.equal(a.inboxDir, instanceCodexCommandInboxDir(vaultA));
  assert.notEqual(a.inboxDir, b.inboxDir);
  assert.notEqual(a.inboxDir, FORBIDDEN_SHARED_CODEX_COMMAND_INBOX_DIR);
  for (const route of ["auto", "companion", "codex"]) {
    await assert.rejects(
      () => a.accept({ ...command, route }),
      (error) => error?.code === "WATCH_EXCLUDED" && error.status === 404,
    );
  }
  await assert.rejects(() => b.accept({ ...command, source: "apple_watch_siri", route: "codex" }), /手表产品/);
  assert.equal(await fs.access(a.inboxFile).then(() => true, () => false), false);
  assert.equal(await fs.access(b.inboxFile).then(() => true, () => false), false);
  assert.deepEqual(await a.list(10), []);
  assert.deepEqual(await b.list(10), []);
  const canary = path.join(vaultA, "00_本地工作台/派生数据/codex-command-inbox/CANARY");
  await fs.mkdir(path.dirname(canary), { recursive: true });
  await fs.writeFile(canary, "only-a\n");
  assert.equal(await fs.access(path.join(vaultB, "00_本地工作台/派生数据/codex-command-inbox/CANARY")).then(() => true, () => false), false);
  assert.throws(() => assertExcludedWatchCommand(command), /手表产品/);
  const routes = await fs.readFile(path.join(appRoot, "src/server/workbench-routes.mjs"), "utf8");
  assert.match(routes, /assertExcludedWatchCommand\(body\)/);
  assert.match(routes, /createCodexCommandInboxService\(\{\s*root,/s);
});

test("INF-OSS-005 网页叠层只保留一对一请求字段", async () => {
  const overlays = await fs.readFile(path.join(appRoot, "src/shell/WorkbenchOverlays.tsx"), "utf8");
  assert.doesNotMatch(overlays, /toggleGuestPresence/);
  assert.doesNotMatch(overlays, /toggleSpeakerLight/);
  assert.doesNotMatch(overlays, /nextGuestPresence/);
  assert.match(overlays, /shouldAutoApplyDiskArchive/);
  assert.match(overlays, /mergeLoadedSession\(loaded, \{ messages: messagesRef\.current/);
});
