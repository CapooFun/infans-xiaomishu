import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDisplayModeAccessService } from "../src/server/workbench-display-mode.mjs";
import { buildPrompt } from "../src/server/workbench-ai.mjs";
import { DEFAULT_SECRETARY_ID, PUBLIC_USER_DISPLAY_NAME, SECRETARY_PROFILES } from "../src/secretary-identity.mjs";
import { SHORTCUT_COMMANDS } from "../src/workbench-shortcut-bindings.mjs";
import { externalProjectSourceIds } from "../src/server/workbench-project-hubs.mjs";
import { createSecretaryMobileProtocolService } from "../src/server/workbench-secretary-mobile-protocol.mjs";

const appRoot = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const studioRoot = path.resolve(appRoot, "../..");
const repoRoot = path.resolve(studioRoot, "..");

test("默认秘书是银月，梅凝可切换，用户显示名为我", () => {
  assert.equal(DEFAULT_SECRETARY_ID, "yinyue");
  assert.equal(PUBLIC_USER_DISPLAY_NAME, "我");
  assert.deepEqual(SECRETARY_PROFILES.map((item) => item.id), ["yinyue", "meining"]);
  assert.equal(SECRETARY_PROFILES[0].userAddress, "你");
  assert.equal(SECRETARY_PROFILES[1].userAddress, "你");
});

test("一对一协议只暴露通用会话能力", async () => {
  const display = createDisplayModeAccessService();
  assert.throws(() => display.verify("secret"), (error) => error.status === 404);
  const mobile = createSecretaryMobileProtocolService(studioRoot);
  const bootstrap = await mobile.bootstrap();
  assert.equal(bootstrap.protocol.endpoints.streamTurn, "POST /api/secretary-mobile/turns/stream");
  assert.equal(bootstrap.protocol.endpoints.createConversation, "POST /api/secretary-mobile/conversations");
  assert.equal(bootstrap.features.textChat, true);
  assert.equal(bootstrap.features.attachments, true);
});

test("一对一提示词会带上班值班秘书银月", () => {
  const prompt = buildPrompt("今天日程", [{ source: "test", text: "无额外资料" }], ["个人"], [], { activeSecretaryId: "yinyue" });
  assert.match(prompt, /银月/);
});

test("首页和身份切换使用公开示意", async () => {
  const profile = await readFile(new URL("../src/shell/ProfileSwitcher.tsx", import.meta.url), "utf8");
  assert.match(profile, /name: "我"/);
  const home = await readFile(new URL("../src/pages/HomePage.tsx", import.meta.url), "utf8");
  assert.match(home, /阳台种植计划/);
});

test("快捷键表与外部项目源可读取", () => {
  assert.ok(Array.isArray(SHORTCUT_COMMANDS));
  assert.ok(SHORTCUT_COMMANDS.length > 0);
  assert.ok(Array.isArray(externalProjectSourceIds()));
  assert.ok(repoRoot.endsWith("Infans开源版") || existsSync(path.join(repoRoot, "Infans_Studio")));
});

test("实用工具页保留公开工具入口", async () => {
  const tools = await readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  assert.match(tools, /id: "inbox"/u);
  assert.match(tools, /id: "settings"/u);
  assert.equal(existsSync(path.join(appRoot, "src/server/workbench-vpn.mjs")), false);
  assert.equal(existsSync(path.join(appRoot, "src/pages/tools/KitchenOrdersView.tsx")), false);
});

test("音乐视频相册默认不绑定本机目录", async () => {
  const music = await readFile(new URL("../src/server/workbench-music.mjs", import.meta.url), "utf8");
  const catalog = await readFile(new URL("../src/secretary-music-catalog.mjs", import.meta.url), "utf8");
  const demo = await readFile(new URL("../src/server/workbench-public-demo.mjs", import.meta.url), "utf8");
  assert.match(music, /export const DEFAULT_MUSIC_LIBRARY_DIR = ""/);
  assert.match(catalog, /export const FANREN_MUSIC_TRACKS = \[\]/);
  assert.doesNotMatch(demo, /envValue\.trim\(\)/u);
});

test("支付与续约只有示意项", async () => {
  const renewal = await readFile(new URL("../../../80_生活事务/日常杂务/续费到期.md", import.meta.url), "utf8");
  assert.match(renewal, /示例域名续费/);
  const fixed = JSON.parse(await readFile(new URL("../../../80_生活事务/生活账单/固定开销.json", import.meta.url), "utf8"));
  assert.equal(fixed.items[0].id, "example-cloud");
});
