import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);
const component = readFileSync(new URL("src/shell/WorkbenchOverlays.tsx", appRoot), "utf8");
const css = readFileSync(new URL("src/styles.css", appRoot), "utf8");
const identity = readFileSync(new URL("src/secretary-identity.mjs", appRoot), "utf8");

test("网页一对一侧栏把公开头像铺进聊天窗口", () => {
  assert.match(identity, /export function secretaryDutyPortrait/);
  assert.match(identity, /profile\.chatBackgroundSrc/);
  assert.match(identity, /\/theme\/avatar-yinyue-public\.svg/);
  assert.match(identity, /\/theme\/avatar-meining-public\.svg/);
  assert.match(component, /ordinaryDutyPortrait = secretaryDutyPortrait\(activeSecretary\)/);
  assert.match(component, /showOrdinaryDutyPortrait = Boolean\(ordinaryDutyPortrait\?\.src\)/);
  assert.match(component, /with-duty-background/);
  assert.match(component, /ai-panel-duty-background/);
  assert.doesNotMatch(component, /ordinaryDutyAtmosphere/);
  assert.doesNotMatch(component, /ai-panel-duty-atmosphere/);
  assert.doesNotMatch(component, /function SecretaryDutyStage/);
  assert.doesNotMatch(component, /with-duty-portrait/);
  assert.match(css, /\.ai-panel-duty-background img\s*\{[^}]*object-fit: cover;/);
  assert.doesNotMatch(css, /\[data-kind="fireflies"\]/);
  assert.match(component, /showOrdinaryDutyPortrait \? null/);
  assert.match(component, /placeholder=\{composerTitle\}/);
  assert.match(component, /title=\{composerTitle\}/);
  assert.match(component, /回车发送，⌘↵ 换行/);
  assert.doesNotMatch(component, /<Sparkles size=\{28\}\/>/);
  assert.doesNotMatch(css, /\.ai-panel\.with-duty-portrait/);
});
