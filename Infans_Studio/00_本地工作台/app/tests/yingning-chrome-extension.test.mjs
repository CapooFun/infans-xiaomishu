import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  HEALTH_ENDPOINT,
  INTAKE_ENDPOINT,
  buildContextDraft,
  createQueueItem,
  inferContextKind,
  makeQueueDueNow,
  markRetryPending,
  retryDelayMs,
  validateMacPersistedReceipt,
} from "../../chrome-extension-发给秘书/core.mjs";

const extensionRoot = new URL("../../chrome-extension-发给秘书/", import.meta.url);
const FIXED_UUID = "72742e43-35ed-4c3e-8e65-753ce8dc7f42";
const CONFIG = {
  token: "x".repeat(43),
  deviceId: "chrome-72742e43-35ed-4c3e-8e65-753ce8dc7f42",
  deviceName: "Mac Chrome",
};

test("Chrome 扩展权限只覆盖主动分享与 Mac 回环收件口", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("manifest.json", extensionRoot), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "alarms", "contextMenus", "scripting", "storage"]);
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.version, "1.1.5");
  assert.equal(manifest.icons[16], "icons/yingning-16.png");
  assert.equal(manifest.action.default_icon[32], "icons/yingning-32.png");
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ["icons/yingning-128.png"]);
  assert.deepEqual(manifest.web_accessible_resources[0].matches, ["http://*/*", "https://*/*"]);
  assert.equal("content_scripts" in manifest, false);
  assert.equal("key" in manifest, false);
  assert.equal(INTAKE_ENDPOINT, "http://127.0.0.1:5173/api/inbox");
  assert.equal(HEALTH_ENDPOINT, "http://127.0.0.1:5173/api/health");
});

test("右键网页、链接、选中文字和图片只构造统一契约允许的轻量来件", () => {
  const tab = { title: "来源页", url: "https://example.com/page" };
  assert.deepEqual(buildContextDraft("page", {}, tab), {
    kind: "page", url: "https://example.com/page", title: "来源页", text: "",
  });
  assert.equal(buildContextDraft("link", { linkUrl: "https://openai.com/" }, tab).url, "https://openai.com/");
  assert.equal(buildContextDraft("selection", { selectionText: "  选中文字  " }, tab).text, "选中文字");
  assert.equal(buildContextDraft("image", { srcUrl: "https://example.com/image.jpg" }, tab).url, "https://example.com/image.jpg");
  assert.throws(() => buildContextDraft("image", { srcUrl: "data:image/png;base64,abc" }, tab), /只能发送公开/u);
  assert.throws(() => buildContextDraft("page", {}, { url: "chrome://extensions" }), /HTTP／HTTPS/u);
  assert.equal(inferContextKind({}), "page");
  assert.equal(inferContextKind({ selectionText: "文字" }), "selection");
  assert.equal(inferContextKind({ linkUrl: "https://example.com/" }), "link");
  assert.equal(inferContextKind({ linkUrl: "https://example.com/", srcUrl: "https://example.com/a.jpg" }), "image");
});

test("首次入队生成稳定 UUID，Chrome 来源进入无备注 payload", () => {
  const item = createQueueItem({
    url: "https://example.com/article",
    title: "文章",
    text: "",
    note: "这个旧字段不应进入 payload",
  }, CONFIG, {
    uuid: () => FIXED_UUID,
    now: () => new Date("2026-09-02T03:00:00.000Z"),
  });
  assert.equal(item.intakeId, FIXED_UUID);
  assert.equal(item.payload.intakeId, FIXED_UUID);
  assert.equal("note" in item.payload, false);
  assert.equal(item.payload.source, "chrome_extension");
  assert.equal(item.payload.sourceApp, "Google Chrome");
  assert.equal(item.status, "pending");
  assert.equal(item.attempts, 0);
  assert.equal("attachment" in item.payload, false);
  assert.equal("attachments" in item.payload, false);
});

test("浏览器默认 UUID 生成器保持 crypto 方法调用上下文", async () => {
  const coreSource = await fs.readFile(new URL("core.mjs", extensionRoot), "utf8");
  assert.match(coreSource, /\(\) => crypto\.randomUUID\(\)/u);
  assert.doesNotMatch(coreSource, /dependencies\.uuid \|\| crypto\.randomUUID;/u);
});

test("退避有上限，重试队列不需要更换来件 ID", () => {
  assert.equal(retryDelayMs(1, () => 0), 30_000);
  assert.equal(retryDelayMs(2, () => 0), 60_000);
  assert.equal(retryDelayMs(20, () => 0), 3_600_000);
  const jittered = retryDelayMs(1, () => 1);
  assert.equal(jittered, 34_500);
  const original = createQueueItem({ url: "https://example.com/", title: "", text: "", note: "" }, CONFIG, {
    uuid: () => FIXED_UUID,
    now: () => new Date("2026-09-02T03:00:00.000Z"),
  });
  const failed = markRetryPending(original, "Mac 服务未启动", { nowMs: 1_000, random: () => 0 });
  assert.equal(failed.intakeId, original.intakeId);
  assert.equal(failed.payload.intakeId, original.payload.intakeId);
  assert.equal(failed.status, "failed_retry_pending");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.nextAttemptAt, 31_000);
  const forced = makeQueueDueNow([failed], 2_000)[0];
  assert.equal(forced.nextAttemptAt, 2_000);
  assert.equal(forced.intakeId, original.intakeId);
});

test("只有同一 intakeId 的 mac_persisted 回执可以标记已送达", () => {
  const receipt = {
    ok: true,
    duplicate: false,
    intakeId: FIXED_UUID,
    canonicalItemId: FIXED_UUID,
    status: "delivered",
    deliveredAt: "2026-09-02T03:00:04.000Z",
    deliveryBoundary: "mac_persisted",
  };
  assert.equal(validateMacPersistedReceipt(receipt, FIXED_UUID).status, "delivered");
  assert.throws(() => validateMacPersistedReceipt({ ...receipt, deliveryBoundary: "http_accepted" }, FIXED_UUID), /未返回/u);
  assert.throws(() => validateMacPersistedReceipt({ ...receipt, intakeId: crypto.randomUUID() }, FIXED_UUID), /未返回/u);
  assert.throws(() => validateMacPersistedReceipt({ ...receipt, ok: false }, FIXED_UUID), /未返回/u);
});

test("扩展令牌只使用本地存储，并且不读浏览历史或监听页面", async () => {
  const [background, options, optionsScript, readme, icon] = await Promise.all([
    fs.readFile(new URL("background.js", extensionRoot), "utf8"),
    fs.readFile(new URL("options.html", extensionRoot), "utf8"),
    fs.readFile(new URL("options.js", extensionRoot), "utf8"),
    fs.readFile(new URL("README.md", extensionRoot), "utf8"),
    fs.readFile(new URL("icons/yingning-16.png", extensionRoot)),
  ]);
  assert.match(background, /chrome\.storage\.local\.setAccessLevel/u);
  assert.doesNotMatch(background, /chrome\.storage\.sync/u);
  assert.doesNotMatch(background, /chrome\.history|webNavigation|contentScripts/u);
  assert.match(background, /validateMacPersistedReceipt\(body, item\.intakeId\)/u);
  assert.match(background, /variant: "success", message: "小秘书已收到"/u);
  assert.match(background, /icons\/yingning-128\.png/u);
  assert.match(background, /width:82px; height:82px/u);
  assert.match(background, /border-radius:18px/u);
  assert.match(background, /还没送达 · 请允许 Chrome 连接这台 Mac/u);
  assert.match(background, /chrome\.runtime\.openOptionsPage/u);
  assert.equal(background.match(/chrome\.contextMenus\.create/gu)?.length, 1);
  assert.doesNotMatch(background, /openComposer|note-|chrome\.storage\.session|chrome\.windows\.create/u);
  assert.match(options, /type="password"/u);
  assert.match(optionsScript, /INFANS_CODEX_COMMAND_TOKEN=/u);
  assert.match(optionsScript, /workbenchEndpoints\(/u);
  assert.match(optionsScript, /loopback-network/u);
  assert.match(options, /Chrome 本机通道/u);
  assert.doesNotMatch(options, /[A-Za-z0-9_-]{43,128}/u);
  assert.match(readme, /安全边界/u);
  assert.match(readme, /本人验收清单/u);
  assert.match(readme, /只有一个「发给秘书」/u);
  assert.ok(icon.length > 100);
  await assert.rejects(fs.access(new URL("compose.html", extensionRoot)));
  await assert.rejects(fs.access(new URL("compose.js", extensionRoot)));
});
