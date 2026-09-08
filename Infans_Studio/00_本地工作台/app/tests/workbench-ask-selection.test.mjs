import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAskSelectionSeedUser,
  clearPendingAskSelection,
  enqueueAskSelection,
  takePendingAskSelection,
} from "../src/server/workbench-ai-selection.mjs";
import { assertAskSelectionOrigin } from "../src/server/workbench-routes.mjs";
import { WorkbenchWriteError } from "../src/server/workbench-errors.mjs";
import { DEFAULT_MODEL } from "../src/server/workbench-ai.mjs";

test("DEFAULT_MODEL is empty in the open-source tree", () => {
  assert.equal(DEFAULT_MODEL, "");
});

test("buildAskSelectionSeedUser uses markets / languages templates", () => {
  const market = buildAskSelectionSeedUser({
    selectedText: "美联储降息",
    pageUrl: "http://127.0.0.1:5173/markets",
  });
  assert.match(market, /世界资讯/);
  assert.match(market, /美联储降息/);

  const lang = buildAskSelectionSeedUser({
    selectedText: "今日はいい天気です",
    route: "/languages",
  });
  assert.match(lang, /日语学习/);
  assert.match(lang, /今日はいい天気です/);

  const external = buildAskSelectionSeedUser({
    selectedText: "CPI rose",
    pageUrl: "https://example.com/news",
    pageTitle: "Markets",
  });
  assert.match(external, /网页「Markets」/);
  assert.match(external, /example\.com/);
});

test("enqueue and take pending ask selection", () => {
  clearPendingAskSelection();
  const queued = enqueueAskSelection({
    selectedText: "测试选区",
    pageUrl: "http://127.0.0.1:5173/markets",
  });
  assert.ok(queued.id);
  assert.match(queued.seedUser, /世界资讯/);
  const taken = takePendingAskSelection();
  assert.equal(taken?.selectedText, "测试选区");
  assert.equal(takePendingAskSelection(), null);
});

test("assertAskSelectionOrigin allows chrome-extension on loopback", () => {
  assert.doesNotThrow(() => assertAskSelectionOrigin({
    headers: { host: "127.0.0.1:5173", origin: "chrome-extension://abcdefghijklmnop" },
  }));
  assert.doesNotThrow(() => assertAskSelectionOrigin({
    headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
  }));
  assert.throws(
    () => assertAskSelectionOrigin({
      headers: { host: "127.0.0.1:5173", origin: "https://evil.example" },
    }),
    (error) => error instanceof WorkbenchWriteError && error.code === "ORIGIN_REJECTED",
  );
  assert.throws(
    () => assertAskSelectionOrigin({
      headers: { host: "example.com", origin: "chrome-extension://abcdefghijklmnop" },
    }),
    (error) => error instanceof WorkbenchWriteError && error.code === "ORIGIN_REJECTED",
  );
});
