import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendGameAnalyticsEvents,
  gameAnalyticsPath,
  isLocalGameAnalyticsOrigin,
  normalizeGameAnalyticsEvent,
  readGameAnalyticsSummary,
  readGameAnalyticsPrivateToken,
  readOfficialGameAnalyticsSummary,
  resetOfficialGameAnalyticsCacheForTests,
} from "../src/server/workbench-game-analytics.mjs";

const NOW = Date.parse("2026-08-19T06:00:00.000Z");
const IDS = [
  "019ffed0-11b0-7ccd-8f31-0aa0ea210001",
  "019ffed0-11b0-7ccd-8f31-0aa0ea210002",
  "019ffed0-11b0-7ccd-8f31-0aa0ea210003",
  "019ffed0-11b0-7ccd-8f31-0aa0ea210004",
  "019ffed0-11b0-7ccd-8f31-0aa0ea210005",
  "019ffed0-11b0-7ccd-8f31-0aa0ea210006",
];

function event(index, name, environment = "development", properties = {}) {
  return {
    schema_version: 1,
    event_id: IDS[index],
    session_id: "019ffed0-11b0-7ccd-8f31-0aa0ea219999",
    game_id: "example-game",
    version: "0.2.3-local",
    channel: "local",
    environment,
    event: name,
    occurred_at: new Date(NOW - 1_000 + index).toISOString(),
    properties,
  };
}

test("经营事件只保留白名单字段和业务属性", () => {
  const normalized = normalizeGameAnalyticsEvent({
    ...event(0, "run_end", "development", { tier: "S", steps: 23, floor: 2, outcome: "return", seed: 8899 }),
    player_id: "should-not-survive",
    screen: "390x844",
    ip: "127.0.0.1",
  }, NOW);
  assert.deepEqual(normalized.properties, { tier: "S", outcome: "return", steps: 23, floor: 2 });
  assert.equal("player_id" in normalized, false);
  assert.equal("screen" in normalized, false);
  assert.equal("ip" in normalized, false);
});

test("开发和正式环境分开汇总，重复事件不重复计数", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-game-analytics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const developmentEvents = [
    event(0, "page_view"),
    event(1, "play_start"),
    event(2, "play_5m"),
    event(3, "run_start", "development", { tier: "S" }),
    event(4, "run_end", "development", { tier: "S", outcome: "return", steps: 18, floor: 1 }),
  ];
  assert.deepEqual(await appendGameAnalyticsEvents(root, { events: developmentEvents }, NOW), { accepted: 5, duplicated: 0 });
  assert.deepEqual(await appendGameAnalyticsEvents(root, { events: [developmentEvents[0]] }, NOW), { accepted: 0, duplicated: 1 });

  const development = await readGameAnalyticsSummary(root, { environment: "development", days: 30, now: NOW });
  assert.equal(development.metrics.pageViews, 1);
  assert.equal(development.metrics.playStarts, 1);
  assert.equal(development.metrics.playStartRate, 100);
  assert.equal(development.metrics.play5mRate, 100);
  assert.equal(development.metrics.runEndRate, 100);
  assert.equal(development.income.connected, false);

  const production = await readGameAnalyticsSummary(root, { environment: "production", days: 30, now: NOW });
  assert.equal(production.eventCount, 0);
  assert.equal(production.metrics.pageViews, 0);
  assert.match(production.boundary, /正式官网尚未接入/);

  const mode = (await fs.stat(gameAnalyticsPath(root))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("本机收集端只接受回环 Host 与本地开发 Origin", () => {
  assert.equal(isLocalGameAnalyticsOrigin({ headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5180" } }), true);
  assert.equal(isLocalGameAnalyticsOrigin({ headers: { host: "127.0.0.1:5173", origin: "http://localhost:5180" } }), true);
  assert.equal(isLocalGameAnalyticsOrigin({ headers: { host: "127.0.0.1:5173", origin: "https://www.ifansstudio.com" } }), false);
  assert.equal(isLocalGameAnalyticsOrigin({ headers: { host: "mailbox.example.invalid", origin: "https://www.ifansstudio.com" } }), false);
});

test("正式汇总密钥只从 macOS 钥匙串读取", async () => {
  const execFileImpl = async (file, args) => {
    assert.equal(file, "/usr/bin/security");
    assert.deepEqual(args, [
      "find-generic-password",
      "-a", "Infans",
      "-s", "Infans Game Analytics",
      "-w",
    ]);
    return { stdout: "private-test-token\n" };
  };
  assert.equal(await readGameAnalyticsPrivateToken({ execFileImpl }), "private-test-token");
});

test("梅凝服务端读取正式汇总，浏览器响应不包含私有令牌", async () => {
  resetOfficialGameAnalyticsCacheForTests();
  const remote = {
    schemaVersion: 1,
    game: { id: "example-game", name: "示例游戏", productLine: "示例网页体验" },
    environment: "production",
    days: 30,
    observedAt: "2026-08-19T06:00:00.000Z",
    dataUpdatedAt: "2026-08-19T05:59:00.000Z",
    eventCount: 2,
    metrics: {
      pageViews: 1, playStarts: 1, playStartRate: 100,
      play5m: 0, play5mRate: 0, play15m: 0, play15mRate: 0,
      sessionEnds: 0, runStarts: 0, runEnds: 0, runEndRate: null,
      deaths: 0, reincarnations: 0, steamClicks: 0,
    },
    versions: [{ label: "test-build", eventCount: 2 }],
    channels: [{ label: "official-website", eventCount: 2 }],
    income: { connected: false, advertising: null, steamSales: null, other: null },
    boundary: "正式匿名汇总",
  };
  const fetchImpl = async (url, init) => {
    assert.equal(url.searchParams.get("days"), "30");
    assert.equal(init.headers.Authorization, "Bearer private-test-token");
    return new Response(JSON.stringify(remote), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await readOfficialGameAnalyticsSummary({ days: 30, token: "private-test-token", endpoint: "https://example.test/game-analytics", fetchImpl });
  assert.equal(result.eventCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-test-token|Authorization|Bearer/);
});

test("正式汇总鉴权失败时返回真实错误且不泄漏令牌", async () => {
  await assert.rejects(
    readOfficialGameAnalyticsSummary({
      days: 30,
      token: "private-test-token",
      endpoint: "https://example.test/game-analytics",
      fetchImpl: async () => new Response(JSON.stringify({ error: "no" }), { status: 401 }),
    }),
    (error) => error.code === "GAME_ANALYTICS_AUTH_FAILED" && !/private-test-token/.test(error.message),
  );
});
