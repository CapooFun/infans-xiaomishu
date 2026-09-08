import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAppleHealthDeviceSyncService,
  healthSyncTokenMatches,
  mergeAppleHealthDevicePayload,
  normalizeAppleHealthDevicePayload,
} from "../src/server/workbench-apple-health-sync.mjs";
import { appleHealthDerivedPath } from "../src/server/workbench-apple-health.mjs";
import { assertAppleHealthDeviceSyncAccess } from "../src/server/workbench-routes.mjs";

const NOW = new Date("2026-08-27T04:00:00.000Z");
const TOKEN = "a".repeat(43);
const BATCH_ID = "c318df90-0322-4f31-8042-57df7a288a73";
const DEVICE_ID = "78f74a4b-15e7-4da3-92be-91de8c0e6992";
const RUN_ID = "98f74a4b-15e7-4da3-92be-91de8c0e6993";

function payload(overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: BATCH_ID,
    deviceId: DEVICE_ID,
    generatedAt: "2026-08-27T03:10:00.000Z",
    windowStart: "2026-08-20",
    windowEnd: "2026-08-27",
    completeThrough: "2026-08-26",
    timeZone: "Asia/Tokyo",
    sampleCount: 27,
    run: {
      runId: RUN_ID,
      trigger: "background-refresh",
      startedAt: "2026-08-27T03:09:00.000Z",
      finishedAt: "2026-08-27T03:10:00.000Z",
    },
    daily: [{
      date: "2026-08-26",
      steps: 8765,
      activeEnergy: 456.7,
      exerciseMinutes: 42,
      standMinutes: 720,
      restingHeartRate: 58,
      asleepMinutes: 438,
      sleepMinutes: 438,
      sources: { steps: "Apple Watch", sleepMinutes: "Apple Watch", asleepMinutes: "Apple Watch" },
    }],
    body: [{ id: "body-1", date: "2026-08-26", metric: "weightKg", value: 74.2, source: "TANITA Record" }],
    workouts: [{
      id: "workout-1",
      day: "2026-08-26",
      date: "2026-08-26T09:00:00.000Z",
      end: "2026-08-26T09:42:00.000Z",
      type: "传统力量训练",
      durationMinutes: 42,
      energyKcal: 260,
      source: "Apple Watch",
    }],
    ...overrides,
  };
}

function request(headers = {}, remoteAddress = "127.0.0.1") {
  return { headers, socket: { remoteAddress } };
}

test("HealthKit 设备同步要求 JSON、设备令牌与可信 Tailscale 身份", () => {
  assert.equal(healthSyncTokenMatches(TOKEN, TOKEN), true);
  assert.equal(healthSyncTokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.doesNotThrow(() => assertAppleHealthDeviceSyncAccess(request({
    host: "127.0.0.1:5173",
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
  }), "capoo@example.com", TOKEN));
  assert.doesNotThrow(() => assertAppleHealthDeviceSyncAccess(request({
    host: "mailbox.example.invalid",
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${TOKEN}`,
    "tailscale-user-login": "capoo@example.com",
  }), "capoo@example.com", TOKEN));
  assert.throws(() => assertAppleHealthDeviceSyncAccess(request({
    host: "mailbox.example.invalid",
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
    "tailscale-user-login": "other@example.com",
  }), "capoo@example.com", TOKEN), /Tailscale/);
  assert.throws(() => assertAppleHealthDeviceSyncAccess(request({
    host: "127.0.0.1:5173",
    "content-type": "application/json",
    authorization: "Bearer wrong",
  }), "capoo@example.com", TOKEN), /未配对/);
});

test("设备正文只接受 46 天内的非医疗白名单数据", () => {
  const normalized = normalizeAppleHealthDevicePayload(payload(), { now: () => NOW });
  assert.equal(normalized.daily[0].steps, 8765);
  assert.equal(normalized.body[0].unit, "kg");
  assert.equal(normalized.workouts[0].type, "传统力量训练");
  assert.deepEqual(normalized.run, {
    runId: RUN_ID,
    trigger: "background-refresh",
    startedAt: "2026-08-27T03:09:00.000Z",
    finishedAt: "2026-08-27T03:10:00.000Z",
  });
  assert.throws(() => normalizeAppleHealthDevicePayload(payload({
    body: [{ date: "2026-08-26", metric: "bloodPressure", value: 120, source: "HealthKit" }],
  }), { now: () => NOW }), /白名单/);
  assert.throws(() => normalizeAppleHealthDevicePayload(payload({
    windowStart: "2026-06-01",
  }), { now: () => NOW }), /46 天/);
  assert.throws(() => normalizeAppleHealthDevicePayload(payload({ timeZone: "UTC" }), { now: () => NOW }), /Asia\/Tokyo/);
  assert.throws(() => normalizeAppleHealthDevicePayload(payload({ run: { ...payload().run, trigger: "unknown" } }), { now: () => NOW }), /白名单/);
  assert.throws(() => normalizeAppleHealthDevicePayload(payload({ run: { ...payload().run, finishedAt: "2026-08-27T02:00:00.000Z" } }), { now: () => NOW }), /时长/);
  assert.equal(normalizeAppleHealthDevicePayload(payload({ run: undefined }), { now: () => NOW }).run, null);
});

test("同步合并保留历史、替换时间窗内同类数据，并按批次幂等", () => {
  const incoming = normalizeAppleHealthDevicePayload(payload(), { now: () => NOW });
  const existing = {
    schemaVersion: 2,
    importedAt: "2026-08-01T00:00:00.000Z",
    exportFile: "导出.zip",
    recordCount: 100,
    daily: [{ date: "2026-08-01", steps: 1000, sources: { steps: "Apple Watch" } }],
    body: [{ date: "2026-08-26", day: "2026-08-26", metric: "weightKg", value: 75, unit: "kg", source: "旧数据" }],
    workouts: [{ day: "2026-08-26", date: "2026-08-26T01:00:00.000Z", end: "2026-08-26T01:30:00.000Z", type: "步行", durationMinutes: 30, source: "旧数据" }],
  };
  const merged = mergeAppleHealthDevicePayload(existing, incoming, { now: () => NOW });
  assert.equal(merged.duplicate, false);
  assert.deepEqual(merged.data.daily.map((row) => row.date), ["2026-08-01", "2026-08-26"]);
  assert.equal(merged.data.body.length, 1);
  assert.equal(merged.data.body[0].value, 74.2);
  assert.equal(merged.data.workouts.length, 1);
  assert.equal(merged.data.workouts[0].type, "传统力量训练");
  assert.equal(merged.data.latestBody.weightKg.value, 74.2);
  assert.equal(merged.data.sync.completeThrough, "2026-08-26");
  assert.equal(merged.data.sync.lastRun.runId, RUN_ID);
  assert.equal(merged.data.sync.lastRun.trigger, "background-refresh");
  assert.equal(mergeAppleHealthDevicePayload(merged.data, incoming, { now: () => NOW }).duplicate, true);
});

test("同步服务写入现有派生 JSON 与 S2 摘要，不另建健康真值", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-health-device-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createAppleHealthDeviceSyncService(root, { now: () => NOW });
  const first = await service.sync(payload());
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  const derived = JSON.parse(await fs.readFile(appleHealthDerivedPath(root), "utf8"));
  assert.equal(derived.daily.at(-1).steps, 8765);
  assert.equal(derived.sync.source, "iphone-healthkit");
  const summary = await fs.readFile(path.join(root, "40_身心健康/体魄/Apple健康导入摘要.md"), "utf8");
  assert.match(summary, /iPhone HealthKit 自动同步/);
  assert.match(summary, /覆盖到 2026-08-26/);
  const second = await service.sync(payload());
  assert.equal(second.duplicate, true);
});

test("iPhone 后台同步保留锁屏令牌、启动期观察、前后台归因与可见调度错误", async () => {
  const nativeRoot = new URL("../native/InfansHealthSync/InfansHealthSync/", import.meta.url);
  const [settings, reader, coordinator, app, content] = await Promise.all([
    fs.readFile(new URL("SettingsStore.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("HealthKitReader.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("SyncCoordinator.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("InfansHealthSyncApp.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("ContentView.swift", nativeRoot), "utf8"),
  ]);

  assert.match(settings, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  assert.match(reader, /enableBackgroundDelivery\(for: type, frequency: \.hourly\)/);
  const workIndex = reader.indexOf("await onChange()", reader.indexOf("HKObserverQuery"));
  const completionIndex = reader.indexOf("completion()", workIndex);
  assert.ok(workIndex >= 0 && completionIndex > workIndex, "HealthKit completion must follow the awaited sync");
  assert.match(app, /configureBackgroundServices\(refreshStatus: application\.backgroundRefreshStatus\)/);
  assert.match(app, /applicationDidBecomeActive[\s\S]*syncForegroundIfDue\(\)/);
  assert.match(coordinator, /func syncForegroundIfDue\(\)[\s\S]*trigger: \.appLaunch/);
  assert.doesNotMatch(content, /model\.start\(\)/);
  assert.doesNotMatch(coordinator, /try\?\s+BGTaskScheduler\.shared\.submit/);
  assert.match(coordinator, /recordBackgroundAttempt/);
});
