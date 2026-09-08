import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSteamLiveForAi,
  hoursFromSteamMinutes,
  parseStoreDate,
  parseSteamCredentials,
  readSteamApiKey,
  readSteamWishlistReleases,
  resetSteamLiveCache,
} from "../src/server/workbench-steam.mjs";
import { toHealthSteamEvidence } from "../scripts/steam-recent-summary.mjs";

const SAMPLE = `# 游戏账号

| 平台 | 登录账号 | 密码 | 备注 |
|---|---|---|---|
| Steam（现行） | example@example.test | secret | 昵称「示例账号」· SteamID \`76561198000000000\` |
| Steam Web API Key | — | AABBCCDDEEFF00112233445566778899 | 查最近玩什么用 |
`;

test("parseSteamCredentials reads SteamID and key from the account table", () => {
  const creds = parseSteamCredentials(SAMPLE);
  assert.equal(creds.steamid, "76561198000000000");
  assert.equal(creds.key, "AABBCCDDEEFF00112233445566778899");
});

test("hoursFromSteamMinutes rounds to one decimal hour", () => {
  assert.equal(hoursFromSteamMinutes(2010), 33.5);
  assert.equal(hoursFromSteamMinutes(0), 0);
});

test("Steam keychain reader requests only the configured service and never prints the key", async () => {
  const calls = [];
  const key = await readSteamApiKey({
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "AABBCCDDEEFF00112233445566778899\n" };
    },
  });
  assert.equal(key.length, 32);
  assert.deepEqual(calls, [{
    command: "/usr/bin/security",
    args: ["find-generic-password", "-s", "Infans Steam Web API", "-w"],
  }]);
});

test("Steam store date keeps exact dates, windows and TBD separate", () => {
  assert.deepEqual(parseStoreDate("2026 年 10 月 2 日"), {
    kind: "confirmed",
    date: "2026-10-02",
    label: "2026 年 10 月 2 日",
  });
  assert.deepEqual(parseStoreDate("2027 年第二季度"), { kind: "window", date: null, label: "2027 年第二季度" });
  assert.deepEqual(parseStoreDate("即将推出"), { kind: "tbd", date: null, label: "即将推出" });
});

test("Steam wishlist release watch is disabled in the open-source tree", async (t) => {
  resetSteamLiveCache();
  t.after(() => resetSteamLiveCache());
  const snapshot = await readSteamWishlistReleases("/tmp/infans-opensource-demo", { force: true, now: Date.parse("2026-08-28T12:00:00+09:00") });
  assert.equal(snapshot.available, false);
  assert.match(String(snapshot.message), /没有 Steam 愿望单/);
  assert.equal(snapshot.items.length, 0);
});

test("formatSteamLiveForAi never includes the API key", () => {
  const text = formatSteamLiveForAi({
    available: true,
    persona: "示例账号",
    playing: { name: "Path of Idle: Old Gods Rising", appid: 4243990 },
    gameCount: 1,
    hours2weeks: 33.5,
    games: [{
      appid: 4243990,
      name: "Path of Idle: Old Gods Rising",
      minutes2weeks: 2010,
      hours2weeks: 33.5,
      minutesForever: 2010,
      hoursForever: 33.5,
    }],
    refreshedAt: "2026-08-15T00:00:00.000Z",
    message: null,
  });
  assert.match(text, /Path of Idle: Old Gods Rising/);
  assert.match(text, /33\.5 小时/);
  assert.equal(text.includes("AABBCCDDEEFF00112233445566778899"), false);
  assert.equal(text.includes("key="), false);
});

test("health Steam evidence exposes only rolling aggregate without credentials or fake daily precision", () => {
  const evidence = toHealthSteamEvidence({
    available: true,
    persona: "private persona",
    playing: { name: "Factorio", appid: 427520 },
    gameCount: 1,
    hours2weeks: 2.5,
    games: [{
      appid: 427520,
      name: "Factorio",
      minutes2weeks: 150,
      hours2weeks: 2.5,
      minutesForever: 29332,
      hoursForever: 488.9,
    }],
    refreshedAt: "2026-09-04T00:00:00.000Z",
    message: null,
    key: "AABBCCDDEEFF00112233445566778899",
    steamid: "76561198000000000",
  });

  assert.equal(evidence.availability, "available");
  assert.equal(evidence.coverage, "rolling-2-weeks");
  assert.equal(evidence.dailyPrecision, false);
  assert.deepEqual(evidence.playing, { name: "Factorio" });
  assert.deepEqual(evidence.games, [{ name: "Factorio", hours2weeks: 2.5, hoursForever: 488.9 }]);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("private persona"), false);
  assert.equal(serialized.includes("AABBCCDDEEFF00112233445566778899"), false);
  assert.equal(serialized.includes("76561198310016808"), false);
  assert.equal(serialized.includes("appid"), false);
});
