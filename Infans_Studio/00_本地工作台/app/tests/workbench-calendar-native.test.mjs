import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readNativeCalendar, readNativeCalendarStatus, watchNativeCalendarStatus } from "../src/server/workbench-calendar-native.mjs";
import { readAppleCalendar, readDiskCalendarSnapshot, invalidateAppleCalendarCache } from "../src/server/workbench-calendar.mjs";

const from = new Date("2026-09-03T15:00:00Z");
const to = new Date("2026-09-11T15:00:00Z");
const now = new Date("2026-09-04T03:00:00Z");
const snapshot = (revision = "one") => ({ available: true, permission: "granted", backend: "eventkit", revision,
  calendars: ["个人"], events: [{ id: "uid1", calendar: "个人", title: revision, start: from.toISOString(), end: to.toISOString(), allDay: true, recurring: false, editable: true }] });

async function nativeFixture(t, handler) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cal-ek-"));
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) handler(socket, JSON.parse(input.split("\n")[0]));
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path.join(cacheDir, "calendar-eventkit.sock"), resolve); });
  t.after(async () => {
    for (const client of clients) client.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(cacheDir, { recursive: true, force: true });
  });
  return cacheDir;
}

async function status(cacheDir, revision, permission = "granted") {
  const target = path.join(cacheDir, "calendar-eventkit-status.json");
  await fs.writeFile(`${target}.tmp`, JSON.stringify({ schemaVersion: 1, backend: "eventkit", revision, permission }), { mode: 0o600 });
  await fs.rename(`${target}.tmp`, target);
}

test("native bridge sends only a date-window read and handles fragmented replies", async (t) => {
  let request;
  const cacheDir = await nativeFixture(t, (socket, value) => {
    request = value;
    const text = JSON.stringify(snapshot());
    socket.write(text.slice(0, 30));
    setImmediate(() => socket.end(`${text.slice(30)}\n`));
  });
  const result = await readNativeCalendar(from, to, { cacheDir });
  assert.deepEqual(request, { operation: "events", from: from.toISOString(), to: to.toISOString() });
  assert.equal(result.events[0].id, "uid1");
  assert.equal(result.backend, "eventkit");
});

test("native bridge bounds stalled sockets and rejects malformed replies", async (t) => {
  let reply = false;
  const cacheDir = await nativeFixture(t, (socket) => { if (reply) socket.end('{"available":true}\n'); });
  await assert.rejects(readNativeCalendar(from, to, { cacheDir, timeoutMs: 20 }), /超时/);
  reply = true;
  await assert.rejects(readNativeCalendar(from, to, { cacheDir }), /响应无效/);
});

test("native revision refreshes same-day cache and revoked access is not masked by cached success", async (t) => {
  let revision = "one";
  let calls = 0;
  const cacheDir = await nativeFixture(t, (socket) => { calls++; socket.end(`${JSON.stringify(snapshot(revision))}\n`); });
  await status(cacheDir, revision);
  const first = await readAppleCalendar(from, to, { cacheDir, now });
  assert.equal(first.available, true);
  await readAppleCalendar(from, to, { cacheDir, now });
  assert.equal(calls, 1);
  // Health and schedule share the expanded native window.
  await readAppleCalendar(new Date("2026-08-21T15:00:00Z"), to, { cacheDir, now });
  assert.equal(calls, 1);
  revision = "two";
  await status(cacheDir, revision);
  const old = await readAppleCalendar(from, to, { cacheDir, now });
  assert.equal(old.stale, true);
  assert.equal(old.revision, "one");
  const fresh = await readAppleCalendar(from, to, { cacheDir, now, force: true });
  assert.equal(fresh.revision, "two");
  assert.equal(calls, 2);
  await status(cacheDir, "denied", "denied");
  const denied = await readAppleCalendar(from, to, { cacheDir, now });
  assert.equal(denied.available, false);
  assert.deepEqual(denied.events, []);
  assert.equal(calls, 2);
});

test("change watcher follows atomic replacement without duplicate notifications", async (t) => {
  const cacheDir = await nativeFixture(t, () => {});
  await status(cacheDir, "one");
  const changes = [];
  let release;
  const initial = new Promise((resolve) => { release = resolve; });
  const stop = watchNativeCalendarStatus(cacheDir, () => { changes.push(1); release(); });
  t.after(stop);
  await initial;
  const next = new Promise((resolve) => { release = resolve; });
  await status(cacheDir, "two");
  await next;
  assert.equal(changes.length, 2);
  assert.equal((await readNativeCalendarStatus(cacheDir)).revision, "two");
});

test("write invalidation prevents an earlier in-flight result from replacing newer data", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cal-generation-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const pending = readAppleCalendar(from, to, { cacheDir, now, force: true, reader: async () => { started(); await gate; return snapshot("old"); } });
  await start;
  await invalidateAppleCalendarCache(cacheDir);
  await readAppleCalendar(from, to, { cacheDir, now, force: true, reader: async () => snapshot("new") });
  release();
  assert.equal((await pending).stale, true);
  assert.equal((await readDiskCalendarSnapshot(cacheDir)).value.revision, "new");
});

test("calendar rejects invalid or unbounded windows before reading", async () => {
  let calls = 0;
  const reader = async () => { calls++; return snapshot(); };
  await assert.rejects(readAppleCalendar(new Date("invalid"), to, { reader }), /日期范围无效/);
  await assert.rejects(readAppleCalendar(to, from, { reader }), /日期范围无效/);
  await assert.rejects(readAppleCalendar(from, new Date(+from + 367 * 86400000), { reader }), /日期范围无效/);
  assert.equal(calls, 0);
});
