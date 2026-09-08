import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decideListenerAction, instanceIdFor, resolveListenPort } from "../src/workbench-instance.mjs";
import { assertPublicChatPayload, FOREIGN_THREAD_KEYS, PUBLIC_THREAD_KEY } from "../src/opensource-chat-session.mjs";
import { instanceCalendarCacheDir, osCalendarEnabled, readAppleCalendar } from "../src/server/workbench-calendar.mjs";
import { existsSync } from "node:fs";
import { createRelationshipMemoryService } from "../src/server/workbench-relationship-memory.mjs";
import { saveSecretaryChat } from "../src/server/workbench-secretary-chats.mjs";
import { WorkbenchWriteError } from "../src/server/workbench-errors.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("INF-OSS-001 未知或另一实例只报冲突，不发信号", () => {
  const appA = "/tmp/infans-oss-a";
  const appB = "/tmp/infans-oss-b";
  const same = decideListenerAction({
    health: { ok: true, version: "1.16.0", instanceId: instanceIdFor(appA) },
    listenerCommand: "node src/server/serve.mjs",
    listenerCwd: appA,
    expectedAppDir: appA,
    expectedVersion: "1.16.0",
    expectedInstanceId: instanceIdFor(appA),
  });
  assert.equal(same.action, "already-running");
  assert.equal(same.signal, null);

  const otherRoot = decideListenerAction({
    health: { ok: true, version: "1.16.0", instanceId: instanceIdFor(appB) },
    listenerCommand: "node src/server/serve.mjs",
    listenerCwd: appB,
    expectedAppDir: appA,
    expectedVersion: "1.16.0",
    expectedInstanceId: instanceIdFor(appA),
  });
  assert.equal(otherRoot.action, "conflict");
  assert.equal(otherRoot.signal, null);

  const unknown = decideListenerAction({
    health: null,
    listenerCommand: "node src/server/serve.mjs",
    listenerCwd: appA,
    expectedAppDir: appA,
    expectedVersion: "1.16.0",
    expectedInstanceId: instanceIdFor(appA),
  });
  assert.equal(unknown.action, "conflict");
  assert.equal(unknown.signal, null);

  const foreign = decideListenerAction({
    health: { ok: true, version: "1.16.0", instanceId: instanceIdFor(appA) },
    listenerCommand: "python3 -m http.server",
    listenerCwd: appA,
    expectedAppDir: appA,
    expectedVersion: "1.16.0",
    expectedInstanceId: instanceIdFor(appA),
  });
  assert.equal(foreign.signal, null);
  assert.equal(resolveListenPort({ INFANS_PORT: "5199" }), 5199);
});

test("INF-OSS-001 启动脚本不再固定写死探测端口，也不按版本直接 kill", async () => {
  const startLocal = await fs.readFile(path.join(appRoot, "scripts/start-local.sh"), "utf8");
  assert.match(startLocal, /INFANS_PORT:-5173/);
  assert.match(startLocal, /decide-workbench-listener\.mjs/);
  assert.doesNotMatch(startLocal, /^PORT=5173$/m);
  assert.match(startLocal, /expected_instance_id/);
  assert.match(startLocal, /mode: "recover"/);
});

test("INF-OSS-002 公开命名空间拒绝私人会话，且不改标记放行", async () => {
  assert.equal(PUBLIC_THREAD_KEY, "infans-oss-ai-thread-v1");
  assert.ok(FOREIGN_THREAD_KEYS.includes("infans-ai-thread-v2"));
  assert.throws(
    () => assertPublicChatPayload({ privacy: "private", messages: [{ role: "user", content: "CANARY-PRIVATE" }] }),
    (error) => error instanceof WorkbenchWriteError && error.code === "CHAT_PRIVACY_REJECTED",
  );
  assert.throws(
    () => assertPublicChatPayload({ indexPolicy: "never", messages: [{ role: "user", content: "CANARY-NEVER" }] }),
    (error) => error.code === "CHAT_PRIVACY_REJECTED",
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-002-"));
  await assert.rejects(
    () => saveSecretaryChat(root, {
      indexPolicy: "never",
      messages: [{ role: "user", content: "CANARY-NEVER" }],
    }),
    (error) => error.code === "CHAT_PRIVACY_REJECTED",
  );
  const saved = await saveSecretaryChat(root, {
    messages: [
      { role: "user", content: "CANARY-PUBLIC" },
      { role: "assistant", speaker: "yinyue", content: "收到。" },
    ],
  });
  assert.equal(saved.indexPolicy, "allow");
});

test("INF-OSS-003 演示默认不读操作系统日历，也不碰共享缓存", async () => {
  assert.equal(osCalendarEnabled({}), false);
  assert.equal(osCalendarEnabled({ INFANS_CALENDAR_OS: "1" }), true);
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-003-home-"));
  const shared = path.join(fakeHome, "Library/Caches/com.infans.digitalsecretary");
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, "calendar-window.json"), JSON.stringify({
    schemaVersion: 1,
    from: new Date().toISOString(),
    to: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    value: { available: true, events: [{ title: "CANARY-CALENDAR" }] },
  }));
  const snapshot = await readAppleCalendar(new Date(), new Date(Date.now() + 86400000), {
    osEnabled: false,
    cacheDir: shared,
  });
  assert.equal(snapshot.permission, "disabled");
  assert.equal(snapshot.events.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /CANARY-CALENDAR/);
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "infans-oss-003-vault-"));
  assert.match(instanceCalendarCacheDir(vault), /派生数据\/calendar-cache$/);
});

test("INF-OSS-004 Watch 会话服务按约定拒绝，不恢复私人实现", async () => {
  assert.equal(existsSync(path.join(appRoot, "src/server/workbench-watch-secretary.mjs")), false);
  const routes = await fs.readFile(path.join(appRoot, "src/server/workbench-routes.mjs"), "utf8");
  assert.match(routes, /WATCH_EXCLUDED/);
  const bridge = await fs.readFile(path.join(appRoot, "native/InfansHealthSync/InfansHealthSync/PhoneCommandBridge.swift"), "utf8");
  assert.doesNotMatch(bridge, /WCSession/);
  assert.doesNotMatch(bridge, /WatchConnectivity/);
});

test("INF-OSS-005 网页叠层去掉 invite 入口", async () => {
  const overlays = await fs.readFile(path.join(appRoot, "src/shell/WorkbenchOverlays.tsx"), "utf8");
  const main = await fs.readFile(path.join(appRoot, "src/main.tsx"), "utf8");
  assert.match(overlays, /infans-oss-ai-thread-v1|PUBLIC_THREAD_KEY/);
  assert.doesNotMatch(overlays, /get\("invite"\) === "1"/);
  assert.doesNotMatch(main, /get\("invite"\) === "1"/);
});

test("INF-OSS-007 关系记忆 preview/commit 明确 404", async () => {
  const memory = createRelationshipMemoryService();
  await assert.rejects(() => memory.preview({}), (error) => error.code === "RELATIONSHIP_EXCLUDED" && error.status === 404);
  await assert.rejects(() => memory.commit("token"), (error) => error.code === "RELATIONSHIP_EXCLUDED");
});

test("INF-OSS-008 快速开始要求独立数据根和公开检查入口", async () => {
  const docs = await fs.readFile(path.join(appRoot, "../../../docs/quickstart.md"), "utf8");
  const pkg = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
  assert.match(docs, /pnpm init:data/);
  assert.match(docs, /check:public/);
  assert.match(docs, /不要把仓库本身当可写数据根/);
  assert.match(docs, /pnpm bind:data/);
  assert.match(docs, /不要再跑 init:data/);
  assert.equal(pkg.scripts["init:data"], "node scripts/init-opensource-data.mjs");
  assert.equal(pkg.scripts["bind:data"], "node scripts/init-opensource-data.mjs --bind");
  assert.ok(pkg.scripts["check:public"]);
  assert.ok(pkg.scripts["asset-password"]);
});

test("INF-OSS-001 隔离一次性监听器不会被判断脚本误杀", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, version: "1.16.0", instanceId: "foreign-canary" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const helper = spawn("node", [path.join(appRoot, "scripts/decide-workbench-listener.mjs")], { cwd: appRoot, stdio: ["pipe", "pipe", "pipe"] });
  helper.stdin.end(JSON.stringify({
    health: { ok: true, version: "1.16.0", instanceId: "foreign-canary" },
    listenerCommand: "node src/server/serve.mjs",
    listenerCwd: "/tmp/other-infans",
    expectedAppDir: appRoot,
    expectedVersion: "1.16.0",
    expectedInstanceId: instanceIdFor(appRoot),
  }));
  const stdout = await new Promise((resolve, reject) => {
    let out = "";
    helper.stdout.on("data", (chunk) => { out += chunk; });
    helper.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });
  server.close();
  const decision = JSON.parse(stdout);
  assert.equal(decision.action, "conflict");
  assert.equal(decision.signal, null);
  void port;
});
