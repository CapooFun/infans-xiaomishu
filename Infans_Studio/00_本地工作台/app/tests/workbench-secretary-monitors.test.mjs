import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parseMonitorRequest, validateMonitorSpec, validateMonitorURL } from "../src/server/secretary-monitor-contract.mjs";
import { createSecretaryMonitorService, fetchMonitorPage, isPublicMonitorAddress, monitorPageText } from "../src/server/workbench-secretary-monitors.mjs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCodexCommandInboxService } from "../src/server/workbench-codex-command-inbox.mjs";
import { createProactiveInteractionService } from "../src/server/workbench-proactive-interactions.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const NOW = new Date("2026-09-03T12:00:00Z");
const SPEC = { url: "https://example.com/tickets", contains: "已开放预约", intervalMinutes: 5, deadline: "2026-09-04T12:00:00Z" };
const TEXT = '监控 https://example.com/tickets 出现「已开放预约」就告诉我，每五分钟检查，截止 2026-09-04 21:00 东京时间';

async function fixture(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yinyue-monitor-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let date = new Date(NOW), calls = 0, notifications = 0;
  const options = { directory, now: () => date, fetchPage: async () => { calls++; return { body: "尚未开放", html: false }; },
    notify: async () => { notifications++; return { queued: true, interaction: { interactionId: "fixture-interaction" } }; }, ...extra };
  const service = createSecretaryMonitorService("/unused", options);
  t.after(() => service.stop());
  return { service, options, directory, later: (ms = 300000) => { date = new Date(date.getTime() + ms); }, calls: () => calls, notifications: () => notifications };
}

test("monitor request requires explicit source/condition/frequency/deadline and has Tokyo confirmation", () => {
  const parsed = parseMonitorRequest(TEXT, NOW);
  assert.equal(parsed.spec.intervalMinutes, 5);
  assert.equal(parsed.spec.deadline, SPEC.deadline.replace("Z", ".000Z"));
  assert.equal(parseMonitorRequest("有票就告诉我", NOW).missing.length, 4);
  assert.equal(parseMonitorRequest("你好", NOW), null);
  assert.equal(parseMonitorRequest("查看监控", NOW).operation, "list");
  assert.ok(parseMonitorRequest("停止监控", NOW).missing.length);
  assert.equal(parseMonitorRequest(TEXT.replace("已开放预约", "取消演出"), NOW).operation, "create");
  assert.ok(parseMonitorRequest(TEXT + " https://example.org", NOW).missing.length);
  assert.ok(parseMonitorRequest(TEXT.replace("每五分钟", "每一分钟"), NOW).missing.length);
  assert.ok(parseMonitorRequest(TEXT.replace("出现", "不出现"), NOW).missing.length);
  assert.ok(parseMonitorRequest(TEXT + '，并出现「可购买」', NOW).missing.length);
  assert.ok(parseMonitorRequest(TEXT + "，每十分钟", NOW).missing.length);
  assert.ok(parseMonitorRequest(TEXT.replace("东京时间", "北京时间"), NOW).missing.length);
});

test("contract rejects credentials/private schemes/invalid dates and unlimited polling", () => {
  for (const url of ["file:///etc/passwd", "http://example.com", "https://user:pass@example.com", "https://localhost", "https://x.local", "https://example.com:8443", "https://example.com/?token=abc", "https://example.com/#anchor"]) assert.throws(() => validateMonitorURL(url));
  for (const patch of [{ intervalMinutes: 0 }, { intervalMinutes: 1441 }, { contains: "" }, { deadline: "2026-09-03T12:00:00" }, { deadline: "2026-02-30T12:00:00Z" }, { deadline: "2026-11-04T12:00:00Z" }]) assert.throws(() => validateMonitorSpec({ ...SPEC, ...patch }, NOW));
});

test("public address policy rejects IPv4, IPv6, mapped, tunnel and metadata addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.100.100.100", "192.168.1.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "224.0.0.1"]) assert.equal(isPublicMonitorAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicMonitorAddress(ip), true, ip);
});

test("fetch rejects mixed private DNS before sending and pins validated DNS on HTTPS request", async () => {
  let requested = false;
  await assert.rejects(fetchMonitorPage(SPEC.url, { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], request: () => { requested = true; } }), /非公开网络/u);
  assert.equal(requested, false);
  const result = await fetchMonitorPage(SPEC.url, { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request: (url, options, callback) => {
    assert.equal(url.hostname, "example.com"); assert.equal(options.agent, false);
    options.lookup("example.com", { all: true }, (_error, entries) => assert.equal(entries[0].address, "8.8.8.8"));
    options.lookup("example.com", {}, (_error, address, family) => { assert.equal(address, "8.8.8.8"); assert.equal(family, 4); });
    assert.equal(options.headers.Cookie, undefined);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => { const response = new PassThrough(); response.headers = { "content-type": "text/html; charset=utf-8" }; response.statusCode = 200; callback(response); response.end("<p>hello</p>"); });
    req.destroy = (error) => { if (error) req.emit("error", error); req.emit("close"); };
    return req;
  } });
  assert.equal(result.body, "<p>hello</p>");
});

test("page extraction ignores instructions in scripts/comments and refuses challenge pages", () => {
  assert.equal(monitorPageText({ body: '<!-- 已开放预约 --><script>已开放预约</script><style>已开放预约</style><p>尚未开放 &amp; 明日</p>' }), "尚未开放 & 明日");
  assert.throws(() => monitorPageText({ body: "<p>Verify you are human</p>" }), /验证页/u);
  assert.throws(() => monitorPageText({ body: "a".repeat(1024 * 1024 + 1) }), /1 MiB/u);
});

test("empty service never writes or accesses network; registration is idempotent and owner bound", async (t) => {
  const f = await fixture(t);
  await f.service.tick(); assert.equal(f.calls(), 0); assert.deepEqual(await fs.readdir(f.directory), []);
  const first = await f.service.register(SPEC, { owner: "watch-one", actionID: "one" });
  assert.equal((await f.service.register(SPEC, { owner: "watch-one", actionID: "one" })).duplicate, true);
  await assert.rejects(f.service.register({ ...SPEC, contains: "不同条件" }, { owner: "watch-one", actionID: "one" }), /边界已变化/u);
  await assert.rejects(f.service.cancel(first.item.id, "other-watch"), /找不到/u);
  assert.equal((await f.service.list("other-watch")).items.length, 0);
  assert.equal((await fs.stat(path.join(f.directory, "state.v1.json"))).mode & 0o777, 0o600);
});

test("periodic checks survive restart, honor frequency, expire without late fetch and allow cancellation", async (t) => {
  const f = await fixture(t);
  const first = await f.service.register(SPEC, { owner: "w", actionID: "one" });
  await f.service.tick(); await f.service.tick(); assert.equal(f.calls(), 1);
  const restarted = createSecretaryMonitorService("/unused", f.options);
  f.later(); await restarted.tick(); assert.equal(f.calls(), 2);
  await restarted.cancel(first.item.id, "w"); f.later(); await restarted.tick(); assert.equal(f.calls(), 2);
  await restarted.register(SPEC, { owner: "w", actionID: "two" });
  f.later(86400000); await restarted.tick(); assert.equal(f.calls(), 2);
  assert.equal((await restarted.list()).items[1].state, "expired");
});

test("match queues once across concurrency/restart and reports actual notification delivery separately", async (t) => {
  let notifications = 0;
  const f = await fixture(t, { fetchPage: async () => ({ body: "已开放预约", html: false }), notify: async () => { notifications++; return { queued: true, interaction: { interactionId: "actual-stable-id" } }; }, deliveryItems: async () => [{ interactionId: "actual-stable-id", state: "delivered_to_phone" }] });
  await f.service.register(SPEC, { owner: "w", actionID: "one" });
  await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
  const restarted = createSecretaryMonitorService("/unused", f.options); f.later(); await restarted.tick();
  assert.equal(notifications, 1);
  const item = (await restarted.list()).items[0];
  assert.equal(item.state, "notification_queued"); assert.equal(item.deliveryState, "delivered_to_phone");
  assert.equal(item.nextCheckAt, null); assert.equal(item.checks, 1);
  await assert.rejects(restarted.cancel(item.id, "w"), /不能撤回/u);
});

test("fetch and notification failures remain visible, retry is bounded, match isn't falsely notified", async (t) => {
  let fetches = 0, notifications = 0;
  const f = await fixture(t, { fetchPage: async () => { fetches++; if (fetches === 1) throw new Error("network-unavailable"); return { body: "已开放预约", html: false }; }, notify: async () => { notifications++; return { queued: false, reason: "daily-max" }; } });
  await f.service.register(SPEC, { owner: "w", actionID: "one" });
  await f.service.tick(); assert.equal((await f.service.list()).items[0].lastError, "network-unavailable");
  f.later(); await f.service.tick(); assert.equal((await f.service.list()).items[0].state, "matched");
  assert.match((await f.service.list()).items[0].lastError, /daily-max/u);
  f.later(); await f.service.tick(); assert.equal(fetches, 2); assert.equal(notifications, 2);
  f.later(86400000); await f.service.tick(); assert.equal(notifications, 2); assert.equal((await f.service.list()).items[0].state, "notification_failed");
});

test("read failure does not overwrite corrupt ledger; expired in-flight check never notifies", async (t) => {
  const f = await fixture(t, { fetchPage: async () => { f.later(86400000); return { body: "已开放预约" }; } });
  await f.service.register(SPEC, { owner: "w", actionID: "one" }); await f.service.tick();
  assert.equal((await f.service.list()).items[0].state, "expired"); assert.equal(f.notifications(), 0);
  const file = path.join(f.directory, "state.v1.json"); await fs.writeFile(file, "invalid");
  await assert.rejects(f.service.tick()); assert.equal(await fs.readFile(file, "utf8"), "invalid");
});

test("Watch 自然语言产品链已排除；监控服务本身仍可独立登记", async (t) => {
  assert.equal(existsSync(path.join(appRoot, "src/server/workbench-watch-secretary.mjs")), false);
  const f = await fixture(t, { fetchPage: async () => ({ body: "<p>已开放预约</p>" }) });
  const inbox = createCodexCommandInboxService({ inboxDir: path.join(f.directory, "inbox") });
  const command = { schemaVersion: 1, commandId: crypto.randomUUID(), source: "apple_watch_app", deviceId: "fixture-watch", route: "companion", conversationKey: "monitor-test", createdAt: NOW.toISOString(), text: TEXT };
  await assert.rejects(() => inbox.accept(command), /手表产品不在公开范围/);
  assert.equal(await fs.access(inbox.inboxFile).then(() => true, () => false), false);
  const first = await f.service.register(SPEC, { owner: command.deviceId, actionID: command.commandId });
  assert.equal(typeof first.item.id, "string");
  assert.ok(first.item.id);
});

test("cancel dialogue keeps ownership; missing and overlong boundaries cannot produce confirmation", async (t) => {
  const f = await fixture(t);
  const command = { commandId: crypto.randomUUID(), deviceId: "watch-one" };
  const missing = await f.service.replyForCommand({ ...command, text: "有票就告诉我" });
  assert.equal(missing.pendingAction, undefined);
  const valid = await f.service.replyForCommand({ ...command, text: TEXT });
  await assert.rejects(f.service.applyAction({ ...valid.pendingAction, summary: "隐藏了真实边界" }, command), /边界不一致/u);
  const tooLong = await f.service.replyForCommand({ ...command, text: TEXT.replace("tickets", "t".repeat(400)) });
  assert.equal(tooLong.pendingAction, undefined); assert.match(tooLong.text, /完整展示/u);
  const first = await f.service.register(SPEC, { owner: command.deviceId, actionID: command.commandId });
  const reply = await f.service.replyForCommand({ ...command, text: `取消监控 ${first.item.id}` });
  assert.equal(reply.pendingAction.operation, "cancel");
  const denied = await f.service.replyForCommand({ ...command, deviceId: "other", text: `取消监控 ${first.item.id}` });
  assert.equal(denied.pendingAction, undefined);
  await f.service.applyAction(reply.pendingAction, command);
  assert.equal((await f.service.list()).items[0].state, "cancelled");
});

test("active cap and confirmation expiry are enforced; replay never restarts terminal tasks", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) await f.service.register(SPEC, { owner: "w", actionID: String(i) });
  await assert.rejects(f.service.register(SPEC, { owner: "w", actionID: "overflow" }), /20 个/u);
  f.later(86400000); await f.service.tick();
  const retry = await f.service.register(SPEC, { owner: "w", actionID: "0" });
  assert.equal(retry.duplicate, true); assert.equal(retry.item.state, "expired");
  await assert.rejects(f.service.register(SPEC, { owner: "w", actionID: "new-expired" }), /晚于现在/u);
});

test("notification persisted before monitor receipt is replayed without duplicating across restart", async (t) => {
  const f = await fixture(t, { fetchPage: async () => ({ body: "已开放预约", html: false }) });
  const delivery = createProactiveInteractionService({ ledgerDir: path.join(f.directory, "notifications"), now: () => NOW });
  let attempts = 0;
  const options = { ...f.options, notify: async (candidate) => { const result = await delivery.plan(candidate, NOW); if (++attempts === 1) throw new Error("lost-receipt"); return result; } };
  const service = createSecretaryMonitorService("/unused", options);
  await service.register(SPEC, { owner: "w", actionID: "1" }); await service.tick();
  assert.equal((await service.list()).items[0].state, "matched");
  const restarted = createSecretaryMonitorService("/unused", options); f.later(); await restarted.tick();
  assert.equal((await restarted.list()).items[0].state, "notification_queued"); assert.equal((await delivery.list()).length, 1);
});

test("HTTPS redirects, non-text and legacy encodings are rejected rather than followed", async () => {
  for (const [statusCode, contentType] of [[302, "text/html"], [200, "application/octet-stream"], [200, "text/html; charset=shift_jis"]]) {
    let requests = 0;
    await assert.rejects(fetchMonitorPage(SPEC.url, { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request: (_url, _options, callback) => {
      requests++; const req = new EventEmitter();
      req.end = () => queueMicrotask(() => { const response = new PassThrough(); response.headers = { "content-type": contentType, location: "http://127.0.0.1" }; response.statusCode = statusCode; callback(response); req.emit("close"); });
      req.destroy = () => req.emit("close"); return req;
    } }), /不可直接读取/u);
    assert.equal(requests, 1);
  }
});
