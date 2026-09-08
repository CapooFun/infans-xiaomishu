import assert from "node:assert/strict";
import test from "node:test";
import {
  parseJmaTokyoQuake,
  parseJmaTokyoWarningCodes,
  selectTokyoWeatherAlert,
} from "../src/server/weather-alert.mjs";
import {
  clientWeatherRegion,
  shouldShowLocalWeatherAlert,
} from "../src/weather-alert-state.ts";
import {
  isWorkbenchNewsHash,
  queryVisibleWorkbenchNewsTarget,
  revealWorldNewsTarget,
} from "../src/world-news-target.ts";
import { readFileSync } from "node:fs";

test("tokyo mainland heavy rain warning becomes a storm alert", () => {
  const codes = parseJmaTokyoWarningCodes({
    warning: {
      class10Items: [
        { areaCode: "130010", kinds: [{ code: "03", status: "発表" }] },
        { areaCode: "130020", kinds: [{ code: "14", status: "継続" }] },
      ],
    },
  });
  assert.deepEqual(codes, ["03"]);
  const alert = selectTokyoWeatherAlert({ warningCodes: codes });
  assert.equal(alert?.title, "暴雨预警");
  assert.equal(alert?.shortTitle, "暴雨");
  assert.equal(alert?.href, "/markets#market-events");
  assert.equal(alert?.location, "东京");
});

test("izu thunder and cancelled tokyo warnings do not become tokyo alerts", () => {
  const codes = parseJmaTokyoWarningCodes([
    {
      warning: {
        class10Items: [
          { areaCode: "130010", kinds: [{ status: "発表警報・注意報はなし" }] },
          { areaCode: "130020", kinds: [{ code: "14", status: "継続" }] },
        ],
      },
    },
    {
      areaTypes: [{
        areas: [
          { code: "130010", warnings: [{ status: "発表警報・注意報はなし" }] },
          { code: "130030", warnings: [{ code: "14", status: "継続" }] },
        ],
      }],
    },
  ]);
  assert.deepEqual(codes, []);
  assert.equal(selectTokyoWeatherAlert({ warningCodes: codes }), null);
});

test("ordinary tokyo rain stays a plain weather reading", () => {
  assert.equal(selectTokyoWeatherAlert({ weatherCode: 55, precipitationMm: 0.3 }), null);
  assert.equal(selectTokyoWeatherAlert({ weatherCode: 63, precipitationMm: 2.1 }), null);
});

test("official warning still shows when it is also raining", () => {
  const alert = selectTokyoWeatherAlert({
    warningCodes: ["03"],
    weatherCode: 55,
    precipitationMm: 0.3,
  });
  assert.equal(alert?.title, "暴雨预警");
});

test("recent tokyo quake becomes an earthquake reminder", () => {
  const quake = parseJmaTokyoQuake([
    { anm: "東京都２３区", maxi: "3", at: "2026-09-05T01:40:00+09:00" },
    { anm: "熊本県", maxi: "5", at: "2026-09-05T01:50:00+09:00" },
  ], new Date("2026-09-05T02:10:00+09:00"));
  assert.equal(quake?.intensity, 3);
  const alert = selectTokyoWeatherAlert({ quake });
  assert.equal(alert?.title, "地震提醒");
  assert.equal(alert?.shortTitle, "地震");
  assert.equal(alert?.kind, "earthquake");
});

test("china timezone hides tokyo weather alerts; japan and unknown still show", () => {
  assert.equal(clientWeatherRegion("Asia/Tokyo"), "japan");
  assert.equal(clientWeatherRegion("Asia/Shanghai"), "china");
  assert.equal(shouldShowLocalWeatherAlert("Asia/Shanghai"), false);
  assert.equal(shouldShowLocalWeatherAlert("Asia/Tokyo"), true);
  assert.equal(shouldShowLocalWeatherAlert("UTC"), true);
});

test("weather alerts stay visible and expose a two-character phone title", () => {
  const storm = selectTokyoWeatherAlert({ warningCodes: ["03"] });
  const observed = selectTokyoWeatherAlert({ weatherCode: 65 });
  const quake = selectTokyoWeatherAlert({
    quake: { intensity: 3, at: Date.parse("2026-09-05T01:40:00+09:00") },
  });
  assert.equal(storm?.shortTitle, "暴雨");
  assert.equal(observed?.shortTitle, "暴雨");
  assert.equal(quake?.shortTitle, "地震");
});

test("storm alert jumps to the matching japan disaster news card", () => {
  const alert = selectTokyoWeatherAlert({
    warningCodes: ["03"],
    events: [
      { id: "isa-fee-20261001", category: "签证", title: "10 月 1 日起在留手续费改定", fact: "入管官网改定手续费。" },
      { id: "jma-tokyo-rain-20260904", category: "灾害", title: "东京今天大致在下雨，雨会持续到午后", fact: "气象厅东京地方天气概述：现在大致在下雨。" },
    ],
  });
  assert.equal(alert?.href, "/markets#world-event-jma-tokyo-rain-20260904");
});

function pageNode(active, ids) {
  const elements = new Map(ids.map((id) => [id, {
    id,
    scrolled: false,
    scrollIntoView() { this.scrolled = true; },
    querySelector() { return null; },
  }]));
  return {
    active,
    querySelector(selector) {
      if (!selector.startsWith("#")) return null;
      return elements.get(selector.slice(1)) ?? null;
    },
  };
}

function documentRoot(pages) {
  return {
    querySelector(selector) {
      if (selector !== ".page.is-active") return null;
      return pages.find((page) => page.active) ?? null;
    },
  };
}

test("first weather click does not reveal a KeepAlive-hidden markets page", () => {
  const hash = "#world-event-jma-tokyo-rain-20260904";
  const cachedMarkets = pageNode(false, ["world-event-jma-tokyo-rain-20260904", "market-events"]);
  const activeHealth = pageNode(true, []);
  assert.equal(isWorkbenchNewsHash(hash), true);
  assert.equal(queryVisibleWorkbenchNewsTarget(documentRoot([cachedMarkets, activeHealth]), hash), null);

  cachedMarkets.active = true;
  activeHealth.active = false;
  const visible = queryVisibleWorkbenchNewsTarget(documentRoot([cachedMarkets, activeHealth]), hash);
  assert.equal(visible?.id, "world-event-jma-tokyo-rain-20260904");
});

test("reveal waits until the KeepAlive markets page is active, not a later timeout", () => {
  const hash = "#world-event-jma-tokyo-rain-20260904";
  const cachedMarkets = pageNode(false, ["world-event-jma-tokyo-rain-20260904"]);
  const activeHealth = pageNode(true, []);
  const originalWindow = globalThis.window;
  globalThis.window = {
    location: { hash },
    matchMedia: () => ({ matches: true }),
  };
  try {
    assert.equal(revealWorldNewsTarget(documentRoot([cachedMarkets, activeHealth])), false);
    assert.equal(cachedMarkets.querySelector("#world-event-jma-tokyo-rain-20260904").scrolled, false);

    cachedMarkets.active = true;
    activeHealth.active = false;
    assert.equal(revealWorldNewsTarget(documentRoot([cachedMarkets, activeHealth])), true);
    assert.equal(cachedMarkets.querySelector("#world-event-jma-tokyo-rain-20260904").scrolled, true);
  } finally {
    globalThis.window = originalWindow;
  }

  const lanes = readFileSync(new URL("../src/pages/world-news-lanes.tsx", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const memory = readFileSync(new URL("../src/workbench-position-memory.ts", import.meta.url), "utf8");
  const target = readFileSync(new URL("../src/world-news-target.ts", import.meta.url), "utf8");
  assert.match(lanes, /usePageNavigationActive/);
  assert.match(lanes, /if \(!pageActive\) return;/);
  assert.match(lanes, /\[brief\.events, lane, pageActive\]/);
  assert.match(lanes, /useLayoutEffect/);
  assert.equal(target.includes("getElementById"), false);
  assert.match(target, /\.page\.is-active/);
  assert.doesNotMatch(lanes, /setTimeout\([^)]*revealWorldNewsTarget/);
  assert.match(memory, /isWorkbenchNewsHash\(window\.location\.hash\)/);
  assert.match(main, /!isWorkbenchNewsHash\(window\.location\.hash\)/);
});
