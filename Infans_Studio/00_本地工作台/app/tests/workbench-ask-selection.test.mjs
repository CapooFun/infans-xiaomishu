import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAskSelectionSeedUser } from "../src/shell/ask-selection.ts";
import { DEFAULT_MODEL } from "../src/server/workbench-ai.mjs";

const workbenchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

test("问问空接口已退场，发给秘书 Origin 留下，页内划字仍在", () => {
  const routes = fs.readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(routes, /\/api\/ai\/ask-selection/);
  assert.doesNotMatch(routes, /\/api\/ai\/pending-selection/);
  assert.doesNotMatch(routes, /assertAskSelectionOrigin/);
  assert.doesNotMatch(routes, /writeAskSelectionCors/);
  assert.match(routes, /writeYingningIntakeCors/);
  assert.match(routes, /allowChromeExtensionOrigin:\s*true/);

  const selectionQueue = path.join(workbenchRoot, "app/src/server/workbench-ai-selection.mjs");
  assert.equal(fs.existsSync(selectionQueue), false);

  const askExt = path.join(workbenchRoot, "chrome-extension-问问小秘书");
  const sendExt = path.join(workbenchRoot, "chrome-extension-发给秘书");
  assert.equal(fs.existsSync(askExt), false);
  assert.equal(fs.existsSync(path.join(sendExt, "manifest.json")), true);

  const launcher = fs.readFileSync(path.join(workbenchRoot, "app/scripts/launch-chrome-workbench.sh"), "utf8");
  assert.doesNotMatch(launcher, /--load-extension/);
  assert.doesNotMatch(launcher, /chrome-extension-问问/);
  assert.doesNotMatch(launcher, /user-data-dir=/);
  assert.match(launcher, /日常桌面入口是原生 小秘书\.app/);
  assert.match(launcher, /open -a "Google Chrome"/);

  const main = fs.readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(main, /pending-selection/);
  assert.doesNotMatch(main, /askSecretary/);
  assert.doesNotMatch(main, /setInterval\(tick, 1500\)/);
  assert.match(main, /<SelectionAskMenu route=\{path\}/);
  assert.match(main, /<SelectionAskFab route=\{path\}/);
});
