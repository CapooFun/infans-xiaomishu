import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertCodexCommandDeviceAccess } from "../src/server/workbench-codex-command-inbox.mjs";
import { createYingningInboxService, normalizeYingningIntake, pasteboardCopyScript } from "../src/server/workbench-yingning-inbox.mjs";

const TOKEN = "x".repeat(43);

test("Mac rejects changed content under original or deduplicated intake IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-conflict-"));
  const service = createYingningInboxService(root);
  const original = sample({ schemaVersion: 2, sourceSemantic: "photo_share", attachments: [photoAttachment()] });
  await service.accept(original);
  assert.equal((await service.accept(original)).duplicate, true);
  const alias = "23cf8cc3-9081-4c19-af4a-361719457dbf";
  await service.accept({ ...original, intakeId: alias });
  for (const intakeId of [original.intakeId, alias]) {
    await assert.rejects(service.accept({ ...original, intakeId, text: "changed" }), error => error.code === "YINGNING_INTAKE_ID_CONFLICT");
  }
  await assert.rejects(service.accept({ ...original, attachments: [photoAttachment(Buffer.from("changed original bytes"))] }), error => error.status === 409);
  assert.equal((await service.list()).items.length, 1);
  assert.equal((await service.readAttachment(original.intakeId, original.attachments[0].attachmentId)).data.toString(), "original-photo-bytes");
});

function sample(overrides = {}) {
  return {
    schemaVersion: 1,
    intakeId: "72742e43-35ed-4c3e-8e65-753ce8dc7f42",
    url: "https://example.com/article#part",
    title: "值得回来看的文章",
    text: "这是分享出来的一段文字。",
    note: "晚上看。",
    source: "ios_share_extension",
    sourceApp: "Safari",
    deviceId: "demo-iphone",
    deviceName: "iPhone",
    createdAt: "2026-09-02T03:00:00.000Z",
    ...overrides,
  };
}

function photoAttachment(data = Buffer.from("original-photo-bytes")) {
  return {
    attachmentId: "8d55b9db-1dd3-4d75-a644-2fe8951cd1a6",
    role: "original",
    fileName: "IMG_2048.HEIC",
    contentType: "image/heic",
    byteCount: data.length,
    pixelWidth: 4032,
    pixelHeight: 3024,
    createdAt: "2026-09-05T03:00:00.000Z",
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    data: data.toString("base64"),
  };
}

test("统一来件契约保持首版兼容并仅接受受控来源", () => {
  const normalized = normalizeYingningIntake(sample());
  assert.equal(normalized.intakeId, "72742e43-35ed-4c3e-8e65-753ce8dc7f42");
  assert.equal(normalized.source, "ios_share_extension");
  assert.equal(normalized.url, "https://example.com/article#part");
  assert.equal(normalized.deviceId, "demo-iphone");
  assert.equal(normalized.fingerprint.length, 64);
  assert.throws(() => normalizeYingningIntake(sample({ source: "browser_history_monitor" })), /来源不在白名单/u);
  assert.throws(() => normalizeYingningIntake(sample({ url: "file:///tmp/private", text: "" })), /HTTP 或 HTTPS/u);
  assert.throws(() => normalizeYingningIntake(sample({ url: "", text: "" })), /至少需要网址、分享文字、照片或文件/u);
  assert.throws(() => normalizeYingningIntake(sample({ attachments: [{ name: "video.mp4" }] })), /首版来件不接收附件/u);
});

test("第二版照片来件校验原图完整性与显式语义", () => {
  const attachment = photoAttachment();
  const normalized = normalizeYingningIntake(sample({
    schemaVersion: 2, url: "", text: "", source: "ios_quick_photo", sourceSemantic: "quick_photo_inbox", attachments: [attachment],
  }));
  assert.equal(normalized.attachments[0].fileName, "IMG_2048.HEIC");
  assert.equal(normalized.attachmentPayloads[0].data.toString(), "original-photo-bytes");
  assert.throws(() => normalizeYingningIntake(sample({
    schemaVersion: 2, url: "", text: "", source: "ios_quick_photo", sourceSemantic: "quick_photo_inbox",
    attachments: [{ ...attachment, sha256: "0".repeat(64) }],
  })), /大小或摘要不匹配/u);
  assert.throws(() => normalizeYingningIntake(sample({
    schemaVersion: 2, url: "", text: "", source: "ios_quick_photo", sourceSemantic: "shared_content", attachments: [{ ...attachment, contentType: "video/mp4" }],
  })), /格式不受支持/u);
});

test("截屏复用已上线的快速照片附件契约", () => {
  const attachment = photoAttachment(Buffer.from("screenshot-png-bytes"));
  const normalized = normalizeYingningIntake(sample({
    schemaVersion: 2,
    url: "",
    text: "",
    source: "ios_quick_photo",
    sourceSemantic: "quick_photo_inbox",
    attachments: [{ ...attachment, fileName: "SCREENSHOT_20260905_120000.PNG", contentType: "image/png" }],
  }));
  assert.equal(normalized.source, "ios_quick_photo");
  assert.equal(normalized.sourceSemantic, "quick_photo_inbox");
  assert.equal(normalized.attachments[0].fileName, "SCREENSHOT_20260905_120000.PNG");
});

test("收件箱原子持久化并用稳定 ID 幂等去重", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createYingningInboxService(root, { inboxDir: path.join(root, "runtime") });
  const first = await service.accept(sample(), new Date("2026-09-02T03:00:04.000Z"));
  const retry = await service.accept(sample(), new Date("2026-09-02T03:00:08.000Z"));
  assert.equal(first.status, "delivered");
  assert.equal(first.deliveryBoundary, "mac_persisted");
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.duplicateReason, "same_id");
  assert.equal(retry.canonicalItemId, first.canonicalItemId);

  const snapshot = await service.list();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.items[0].duplicateCount, 1);
  assert.equal(snapshot.items[0].status, "delivered");
  assert.equal("fingerprint" in snapshot.items[0], false);
  assert.match(snapshot.deliveryBoundary, /待送达和失败待重试/u);
  assert.equal((await fs.stat(service.inboxDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(service.inboxFile)).mode & 0o777, 0o600);
});

test("七天内同内容跨设备合并，超过窗口仍允许再次收藏", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yinyue-content-dedupe-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createYingningInboxService(root, { inboxDir: path.join(root, "runtime") });
  const first = await service.accept(sample(), new Date("2026-09-02T03:00:04.000Z"));
  const second = await service.accept(sample({
    intakeId: "a27265db-624c-4198-a010-7e96cf8bb4db",
    source: "chrome_extension",
    deviceId: "capoo-mac",
    deviceName: "Mac",
  }), new Date("2026-09-03T03:00:04.000Z"));
  assert.equal(second.duplicate, true);
  assert.equal(second.duplicateReason, "same_content");
  assert.equal(second.canonicalItemId, first.canonicalItemId);

  const later = await service.accept(sample({
    intakeId: "23cf8cc3-9081-4c19-af4a-361719457dbf",
    source: "ipados_share_extension",
    deviceId: "capoo-ipad",
    deviceName: "iPad",
  }), new Date("2026-09-10T03:00:05.000Z"));
  assert.equal(later.duplicate, false);
  assert.equal((await service.list()).total, 2);
});

test("原图先持久化再回执，列表不暴露 base64 且可私有读回", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yinyue-photo-inbox-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createYingningInboxService(root, { inboxDir: path.join(root, "runtime") });
  const attachment = photoAttachment();
  const input = sample({ schemaVersion: 2, url: "", text: "", source: "ipados_share_extension", sourceSemantic: "photo_share", attachments: [attachment] });
  const receipt = await service.accept(input);
  assert.equal(receipt.deliveryBoundary, "mac_persisted");
  const snapshot = await service.list();
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.items[0].attachments[0].sha256, attachment.sha256);
  assert.equal("data" in snapshot.items[0].attachments[0], false);
  assert.doesNotMatch(JSON.stringify(snapshot), /b3JpZ2luYWwtcGhvdG8tYnl0ZXM=/u);
  const stored = await service.readAttachment(input.intakeId, attachment.attachmentId);
  assert.equal(stored.data.toString(), "original-photo-bytes");
  assert.equal(stored.contentType, "image/heic");
  const storedPath = path.join(service.inboxDir, "attachments", input.intakeId, `${attachment.attachmentId}.heic`);
  assert.equal((await fs.stat(storedPath)).mode & 0o777, 0o600);
  const retry = await service.accept(input);
  assert.equal(retry.duplicateReason, "same_id");
});

test("并发投递串行写入，不丢任何一条已回执来件", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-serial-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createYingningInboxService(root, { inboxDir: path.join(root, "runtime") });
  await Promise.all([
    service.accept(sample({ text: "第一条。", url: "" })),
    service.accept(sample({ intakeId: "6f5da99f-0965-4196-bb03-39ddd94c0802", text: "第二条。", url: "" })),
  ]);
  assert.equal((await service.list()).total, 2);
});

test("删除进入回收站，可复原；清空后才真正去掉原图", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-remove-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createYingningInboxService(root, { inboxDir: path.join(root, "runtime") });
  const attachment = photoAttachment();
  const input = sample({
    schemaVersion: 2, url: "", text: "", source: "ios_quick_photo", sourceSemantic: "quick_photo_inbox", attachments: [attachment],
  });
  await service.accept(input);
  const alias = "23cf8cc3-9081-4c19-af4a-361719457dbf";
  await service.accept({ ...input, intakeId: alias });
  const storedPath = path.join(service.inboxDir, "attachments", input.intakeId, `${attachment.attachmentId}.heic`);
  assert.equal((await fs.stat(storedPath)).isFile(), true);
  const removed = await service.remove(alias);
  assert.equal(removed.ok, true);
  assert.equal(removed.trashed, true);
  assert.equal(removed.intakeId, input.intakeId);
  const afterDelete = await service.list();
  assert.equal(afterDelete.total, 0);
  assert.equal(afterDelete.trashCount, 1);
  assert.equal(afterDelete.trash[0].intakeId, input.intakeId);
  assert.equal((await fs.stat(storedPath)).isFile(), true);
  await assert.rejects(service.remove(input.intakeId), (error) => error.code === "YINGNING_INTAKE_NOT_FOUND");
  await assert.rejects(service.remove("not-a-uuid"), (error) => error.code === "YINGNING_INTAKE_ID_INVALID");
  const retry = await service.accept(input);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.duplicateReason, "same_id");
  const restored = await service.restore(alias);
  assert.equal(restored.ok, true);
  assert.equal(restored.intakeId, input.intakeId);
  assert.equal((await service.list()).total, 1);
  assert.equal((await service.list()).trashCount, 0);
  await service.remove(input.intakeId);
  const emptied = await service.emptyTrash();
  assert.equal(emptied.emptied, true);
  assert.equal(emptied.deleted, 1);
  await assert.rejects(fs.stat(storedPath), { code: "ENOENT" });
  await assert.rejects(service.restore(input.intakeId), (error) => error.code === "YINGNING_TRASH_NOT_FOUND");
  const again = await service.accept(input);
  assert.equal(again.duplicate, false);
  assert.equal((await service.list()).total, 1);
});

test("复制照片给出可发送的 JPEG，不把原图格式塞进剪贴板", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-share-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createYingningInboxService(root, { inboxDir: path.join(root, "runtime") });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const attachment = {
    ...photoAttachment(png),
    fileName: "snap.png",
    contentType: "image/png",
    pixelWidth: 1,
    pixelHeight: 1,
  };
  const input = sample({
    schemaVersion: 2, url: "", text: "", source: "ios_quick_photo", sourceSemantic: "quick_photo_inbox", attachments: [attachment],
  });
  await service.accept(input);
  const share = await service.readShareCopy(input.intakeId, attachment.attachmentId);
  assert.equal(share.contentType, "image/jpeg");
  assert.equal(share.fileName, "snap.jpg");
  assert.equal(share.data[0], 0xff);
  assert.equal(share.data[1], 0xd8);
  const original = await service.readAttachment(input.intakeId, attachment.attachmentId);
  assert.equal(original.contentType, "image/png");
  await assert.rejects(
    service.readShareCopy(input.intakeId, "8d55b9db-1dd3-4d75-a644-2fe8951cd1a7"),
    (error) => error.code === "YINGNING_ATTACHMENT_NOT_FOUND",
  );
});

test("Chrome 扩展只能在显式允许时复用设备令牌访问本机收件口", () => {
  const request = {
    headers: {
      host: "127.0.0.1:5173",
      origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.throws(() => assertCodexCommandDeviceAccess(request, "", TOKEN), /本机身份校验/u);
  assert.doesNotThrow(() => assertCodexCommandDeviceAccess(request, "", TOKEN, { allowChromeExtensionOrigin: true }));
  assert.throws(
    () => assertCodexCommandDeviceAccess({ ...request, headers: { ...request.headers, authorization: "Bearer wrong" } }, "", TOKEN, { allowChromeExtensionOrigin: true }),
    /未配对/u,
  );
});

test("生产路由将设备投递与私有查看分开保护", async () => {
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /router\.use\("\/api\/inbox"[\s\S]*?assertCodexCommandDeviceAccess\([\s\S]*?allowChromeExtensionOrigin: true/u);
  assert.match(routes, /router\.use\("\/api\/tools\/inbox"[\s\S]*?protectAssetResponse\(response\);[\s\S]*?assertPrivateAssetAccess\(request\)/u);
  assert.match(routes, /router\.use\("\/api\/tools\/inbox"[\s\S]*?request\.method === "DELETE"[\s\S]*?assertPersistentWrite\(request\)[\s\S]*?yingningInbox\.remove/u);
  assert.match(routes, /router\.use\("\/api\/tools\/inbox"[\s\S]*?action === "restore"[\s\S]*?yingningInbox\.restore/u);
  assert.match(routes, /router\.use\("\/api\/tools\/inbox"[\s\S]*?action === "empty-trash"[\s\S]*?yingningInbox\.emptyTrash/u);
  assert.match(routes, /router\.use\("\/api\/tools\/inbox"[\s\S]*?action === "copy-to-pasteboard"[\s\S]*?yingningInbox\.copyToPasteboard/u);
  assert.match(routes, /readJson\(request, 48 \* 1024 \* 1024\)/u);
  assert.match(routes, /query\.get\("share"\) === "1"/u);
  assert.match(routes, /yingningInbox\.readShareCopy/u);
  assert.match(routes, /yingningInbox\.readAttachment[\s\S]*?Content-Disposition/u);
});

test("实用工具接入独立收件箱，页面只将 Mac 持久化称为已送达", async () => {
  const [tools, view, styles, bookmarks] = await Promise.all([
    fs.readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/pages/tools/YingningInboxView.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/pages/tools/yingning-inbox.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/sidebar-bookmarks.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(tools, /lazy\(\(\) => import\("\.\/tools\/YingningInboxView"\)\)/u);
  assert.match(tools, /id: "inbox"[\s\S]*?name: "秘书收件箱"/u);
  assert.match(tools, /displayMode && id === "inbox"/u);
  assert.match(view, /没经确认，它们不会自动进入知识库/u);
  assert.match(view, /Mac 已安全保存/u);
  assert.match(view, /已合并 \{item\.duplicateCount\} 次重复投递/u);
  assert.match(styles, /\.inbox-postmark/u);
  assert.match(view, /inbox-tab-photos[\s\S]*inbox-tab-bookmarks[\s\S]*inbox-tab-files[\s\S]*inbox-tab-projects[\s\S]*inbox-tab-trash/u);
  assert.match(view, />项目收件</u);
  assert.match(view, /id="inbox-panel-projects"/u);
  assert.match(view, /还没有项目来件/u);
  assert.match(view, /inbox-photo-grid/u);
  assert.match(view, /HEIC 原图/u);
  assert.match(view, /role="tablist" aria-label="收件分类"/u);
  assert.match(view, /aria-selected=\{section === "photos"\}/u);
  assert.match(view, /aria-selected=\{section === "trash"\}/u);
  assert.match(view, /id="inbox-panel-trash"/u);
  assert.match(view, /createPortal/u);
  assert.match(view, /inbox-lightbox/u);
  assert.match(view, /关闭全图/u);
  assert.match(view, /inbox-lightbox-copy/u);
  assert.match(view, /inbox-lightbox-save/u);
  assert.match(view, /isAppleMobileBrowser/u);
  assert.match(view, /showSaveImage/u);
  assert.match(view, /if \(!showSaveImage\) return null/u);
  assert.match(view, /const fileSaveSlot[\s\S]*?if \(!showSaveImage\) return null/u);
  assert.match(view, /const showSave = showSaveImage/u);
  assert.doesNotMatch(view, /isFile \|\| showSaveImage/u);
  assert.doesNotMatch(view, /文件在 Mac 也可下载/u);
  assert.match(view, /prepareOriginalFile/u);
  assert.match(view, /async function prepareOriginalFile[\s\S]*?attachmentURL\(item, attachment\.attachmentId\), \{ credentials/u);
  assert.match(view, /navigator\.share\(\{/u);
  assert.match(view, /存储到照片|存储到文件/u);
  assert.match(view, /多张照片：点开你要的那张再保存/u);
  assert.doesNotMatch(view, /已保存到相册/u);
  assert.match(styles, /\.inbox-lightbox-save/u);
  assert.match(styles, /\.inbox-savenote/u);
  assert.match(view, /aria-label=\{`复制 \$\{titleFor\(item\)\}`\}/u);
  assert.match(view, /copyShareImage/u);
  assert.match(view, /copyInboxFile/u);
  assert.match(view, /copyMacPasteboard/u);
  assert.match(view, /copyPlainTextSoon/u);
  assert.match(view, /copy-to-pasteboard/u);
  assert.match(view, /if \(isMacDesktopBrowser\(\)\) \{\s*await copyMacPasteboard/u);
  assert.match(view, /"text\/plain": textPromise/u);
  assert.match(view, /clipboard\?\.writeText[\s\S]*catch \{/u);
  assert.match(view, /\[\\u4e00-\\u9fff\]\/u\.test\(message\)\) return message/u);
  assert.match(view, /isPlainTextFile/u);
  assert.match(view, /decodeTextFileBytes/u);
  assert.match(view, /new ClipboardItem\(\{ "image\/png": shareImagePng\(url\) \}\)/u);
  assert.doesNotMatch(view, /isFileContentType\(attachment\.contentType\)\) await copyText\(item\.url \|\| attachment\.fileName\)/u);
  assert.match(view, /params\.set\("share", "1"\)/u);
  assert.doesNotMatch(view, /确认删除/u);
  assert.match(view, />回收站</u);
  assert.match(view, /全部清理/u);
  assert.match(view, /action: "restore"/u);
  assert.match(view, /action: "empty-trash"/u);
  assert.match(view, /method: "DELETE"/u);
  assert.match(view, /event\.preventDefault\(\)/u);
  assert.match(view, /event\.stopImmediatePropagation\(\)/u);
  assert.match(view, /window\.addEventListener\("keydown", onKey, \{ capture: true \}\)/u);
  assert.doesNotMatch(view, /inbox-photo-preview[\s\S]*target="_blank"/u);
  assert.match(styles, /\.inbox-lightbox/u);
  assert.match(styles, /\.inbox-lightbox-close/u);
  assert.match(styles, /\.inbox-lightbox > header > div span/u);
  assert.match(styles, /\.inbox-lightbox-close,\.inbox-lightbox-copy \{[^}]*white-space:nowrap/u);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.inbox-lightbox > header > div span \{ display:none; \}/u);
  assert.match(styles, /\.inbox-tabs \{[^}]*repeat\(5,/u);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.inbox-tabs \{[^}]*overflow-x:auto/u);
  assert.match(styles, /@media \(max-width: 400px\)[\s\S]*\.inbox-tabs button svg \{ display:none; \}/u);
  assert.match(styles, /\.inbox-bookmark-tab/u);
  assert.match(styles, /\.inbox-bookmark-list \{[^}]*grid-auto-rows:1fr/u);
  assert.match(styles, /\.inbox-bookmark-card \{[^}]*height:100%/u);
  assert.match(styles, /\.inbox-item-actions/u);
  assert.match(styles, /\.inbox-trash/u);
  assert.match(view, /inbox-trash-group/u);
  assert.match(view, /inbox-trash-heading/u);
  assert.match(view, /inbox-trash-break/u);
  assert.match(view, /inbox-card-end/u);
  assert.match(view, /bookmarkCard\(item, "trash"\)/u);
  assert.match(view, /photoCard\(item, "trash"\)/u);
  assert.doesNotMatch(view, /inbox-trash-row/u);
  assert.match(styles, /\.inbox-card-end/u);
  assert.match(styles, /\.inbox-bookmark-body \{[^}]*flex-direction:column/u);
  assert.match(styles, /\.inbox-trash-heading/u);
  assert.match(styles, /\.inbox-trash-break/u);
  assert.doesNotMatch(styles, /\.inbox-trash-row/u);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.inbox-item-actions button \{ min-height:44px; \}/u);
  assert.match(styles, /@media \(max-width: 720px\)/u);
  assert.match(styles, /\.inbox-photo-grid \{[^}]*align-items:stretch/u);
  assert.match(styles, /\.inbox-judgment \{[^}]*flex:1/u);
  assert.match(styles, /\.inbox-lightbox-previous/u);
  assert.match(styles, /\.inbox-checkpoint-chip \{ color:var\(--teal\)/u);
  assert.match(view, /from "\.\/yingning-inbox-save"/u);
  assert.match(view, /from "\.\/yingning-inbox-checkpoint-filter"/u);
  assert.match(view, /from "\.\/yingning-inbox-section"/u);
  assert.match(view, /resolveInboxSection\(window\.location\.search/u);
  assert.match(view, /inboxLocationForSection/u);
  assert.match(view, /chooseSection\("projects"\)/u);
  assert.match(view, /useLayoutEffect/u);
  assert.match(view, /history\.replaceState/u);
  assert.doesNotMatch(view, /useState<"photos" \| "bookmarks" \| "files" \| "projects" \| "trash">\("photos"\)/u);
  assert.match(view, /CheckpointFilterBar/u);
  assert.match(view, /checkpointFilterChips/u);
  assert.match(view, /projectInboxCardCopy/u);
  assert.match(view, /flattenInboxImageSlides/u);
  assert.match(view, /inboxSlideStep/u);
  assert.match(view, /inbox-lightbox-previous/u);
  assert.match(view, /ArrowLeft/u);
  assert.match(view, /inbox-related-task/u);
  assert.match(view, /inbox-judgment/u);
  assert.match(view, />请你判断</u);
  assert.match(view, />关联任务</u);
  assert.match(view, /id="inbox-tab-files"/u);
  assert.match(view, /URLSearchParams\(\{ projectId: id/u);
  assert.match(view, /inbox-project-tabs/u);
  assert.doesNotMatch(view, /className="inbox-evidence-chip"/u);
  assert.doesNotMatch(view, /inbox-project-entry/u);
  assert.doesNotMatch(view, /水箭|3D辞职修仙传|rtc3d|裸辞/u);
  assert.match(bookmarks, /"inbox": "秘书收件箱"/u);
  assert.match(bookmarks, /"\/tools\/inbox": \["section"\]/u);
  assert.match(bookmarks, /DISPLAY_MODE_BLOCKED_TOOLS = new Set\(\[[^\]]*"inbox"/u);
  assert.doesNotMatch(`${view}\n${styles}`, /\/Users\//u);
});

function pdfAttachment(data = Buffer.from("%PDF-1.4 test-file")) {
  return {
    attachmentId: "9d55b9db-1dd3-4d75-a644-2fe8951cd1a7",
    role: "original",
    fileName: "notes.pdf",
    contentType: "application/pdf",
    byteCount: data.length,
    createdAt: "2026-09-10T03:00:00.000Z",
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    data: data.toString("base64"),
  };
}

test("第二版文件来件接收 PDF 并拒绝做成发送照片", async (context) => {
  const attachment = pdfAttachment();
  const normalized = normalizeYingningIntake(sample({
    schemaVersion: 2, url: "", text: "", source: "ios_share_extension", sourceSemantic: "file_share", attachments: [attachment],
  }));
  assert.equal(normalized.sourceSemantic, "file_share");
  assert.equal(normalized.attachments[0].fileName, "notes.pdf");
  assert.equal(normalized.attachmentPayloads[0].data.toString(), "%PDF-1.4 test-file");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-pdf-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createYingningInboxService(root, { inboxDir: path.join(root, "runtime") });
  await service.accept(sample({
    schemaVersion: 2, url: "", text: "", source: "ios_share_extension", sourceSemantic: "file_share", attachments: [attachment],
  }));
  const stored = await service.readAttachment(sample().intakeId, attachment.attachmentId);
  assert.equal(stored.contentType, "application/pdf");
  assert.equal(stored.data.toString(), "%PDF-1.4 test-file");
  await assert.rejects(service.readShareCopy(sample().intakeId, attachment.attachmentId), (error) => error.code === "YINGNING_SHARE_COPY_UNAVAILABLE");
});

test("电脑复制 PDF 会按原文件名放到剪贴板暂存，不走文件名字符串", async (context) => {
  const attachment = pdfAttachment();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-clip-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let staged = "";
  let pasteOptions = null;
  const service = createYingningInboxService(root, {
    inboxDir: path.join(root, "runtime"),
    copyFileToPasteboard: async (filePath, options) => {
      staged = filePath;
      pasteOptions = options;
    },
  });
  await service.accept(sample({
    schemaVersion: 2, url: "", text: "", source: "ios_share_extension", sourceSemantic: "file_share", attachments: [attachment],
  }));
  const copied = await service.copyToPasteboard(sample().intakeId, attachment.attachmentId);
  assert.equal(copied.ok, true);
  assert.equal(copied.mode, "mac-file");
  assert.equal(copied.fileName, "notes.pdf");
  assert.equal(pasteOptions?.alsoText, false);
  assert.equal(path.basename(staged), "notes.pdf");
  assert.equal(await fs.readFile(staged, "utf8"), "%PDF-1.4 test-file");
  await assert.rejects(service.copyToPasteboard("not-a-uuid", attachment.attachmentId), (error) => error.code === "YINGNING_ATTACHMENT_ID_INVALID");
});

test("电脑复制文本文档会把正文和原文件名一起放进系统剪贴板", async (context) => {
  const data = Buffer.from("date,amount\n1,2\n");
  const attachment = {
    attachmentId: "ad55b9db-1dd3-4d75-a644-2fe8951cd1a8",
    role: "original",
    fileName: "layout-copy.csv",
    contentType: "text/csv",
    byteCount: data.length,
    createdAt: "2026-09-10T03:00:00.000Z",
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    data: data.toString("base64"),
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-csv-clip-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let staged = "";
  let pasteOptions = null;
  const service = createYingningInboxService(root, {
    inboxDir: path.join(root, "runtime"),
    copyFileToPasteboard: async (filePath, options) => {
      staged = filePath;
      pasteOptions = options;
    },
  });
  await service.accept(sample({
    schemaVersion: 2, url: "", text: "", source: "ios_share_extension", sourceSemantic: "file_share", attachments: [attachment],
  }));
  const copied = await service.copyToPasteboard(sample().intakeId, attachment.attachmentId);
  assert.equal(copied.ok, true);
  assert.equal(copied.mode, "mac-file-and-text");
  assert.equal(copied.fileName, "layout-copy.csv");
  assert.equal(pasteOptions?.alsoText, true);
  assert.equal(path.basename(staged), "layout-copy.csv");
  assert.equal(await fs.readFile(staged, "utf8"), "date,amount\n1,2\n");
});

test("系统剪贴板脚本：文本文档带正文，PDF 只带文件", () => {
  const withText = pasteboardCopyScript(true);
  const fileOnly = pasteboardCopyScript(false);
  assert.match(withText, /NSPasteboardTypeString/u);
  assert.match(withText, /writeObjects:\{theURL\}/u);
  assert.doesNotMatch(fileOnly, /NSPasteboardTypeString/u);
  assert.match(fileOnly, /writeObjects:\{theURL\}/u);
});

function projectPhoto(overrides = {}, data = Buffer.from("evidence-shot-bytes")) {
  return sample({
    schemaVersion: 2, url: "", text: "",
    source: "ios_share_extension", sourceSemantic: "photo_share",
    projectId: "demo-project", projectName: "示例项目", checkpointId: "cp-01",
    checkpoint: { name: "封面检查", source: "snapshot-demo", build: "example-1", manifestSha: "a".repeat(64) },
    attachments: [{ ...photoAttachment(data), evidenceId: "cover-01" }],
    ...overrides,
  });
}

test("项目字段：校验并保存项目/检查点/证据身份，检查点必须带项目", () => {
  const normalized = normalizeYingningIntake(projectPhoto());
  assert.equal(normalized.projectId, "demo-project");
  assert.equal(normalized.projectName, "示例项目");
  assert.equal(normalized.checkpointId, "cp-01");
  assert.equal(normalized.checkpoint.build, "example-1");
  assert.equal(normalized.attachments[0].evidenceId, "cover-01");
  assert.throws(() => normalizeYingningIntake(projectPhoto({ projectId: "", checkpointId: "cp-01" })), (error) => error.code === "YINGNING_INTAKE_PROJECT_REQUIRED");
  assert.throws(() => normalizeYingningIntake(projectPhoto({ projectId: "非法 ID" })), (error) => error.code === "YINGNING_INTAKE_PROJECT_INVALID");
  assert.throws(() => normalizeYingningIntake(projectPhoto({ attachments: [{ ...photoAttachment(), evidenceId: "有空格 编号" }] })), (error) => error.code === "YINGNING_ATTACHMENT_EVIDENCE_INVALID");
});

test("相同字节跨检查点不误并，日常来件指纹保持旧版兼容", () => {
  const daily = normalizeYingningIntake(sample());
  const dailyBase = crypto.createHash("sha256").update(JSON.stringify({
    url: daily.url, title: daily.title, text: daily.text, note: daily.note, attachments: [],
  })).digest("hex");
  assert.equal(daily.fingerprint, dailyBase);
  const first = normalizeYingningIntake(projectPhoto());
  const second = normalizeYingningIntake(projectPhoto({ checkpointId: "cp-02" }));
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("服务端先分流再分页：默认只回日常并附项目汇总，项目视图按检查点筛选", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-project-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createYingningInboxService(root, { inboxDir: path.join(root, "runtime") });
  await service.accept(sample());
  await service.accept(projectPhoto({ intakeId: "11111111-1111-4111-8111-111111111111" }));
  await service.accept(projectPhoto({
    intakeId: "22222222-2222-4222-8222-222222222222", checkpointId: "cp-02",
    attachments: [{ ...photoAttachment(Buffer.from("evidence-shot-bytes")), attachmentId: "33333333-3333-4333-8333-333333333333", evidenceId: "cover-02" }],
  }));

  const daily = await service.list();
  assert.equal(daily.scope, "daily");
  assert.equal(daily.total, 1);
  assert.equal(daily.items.length, 1);
  assert.equal(daily.projectItemCount, 2);
  assert.equal(daily.projects.length, 1);
  assert.equal(daily.projects[0].projectId, "demo-project");
  assert.equal(daily.projects[0].checkpointCount, 2);
  assert.equal(daily.projects[0].attachmentCount, 2);

  const project = await service.list({ projectId: "demo-project" });
  assert.equal(project.scope, "project");
  assert.equal(project.total, 2);
  assert.equal(project.projectName, "示例项目");
  assert.equal(project.checkpoints.length, 2);

  const scoped = await service.list({ projectId: "demo-project", checkpointId: "cp-02" });
  assert.equal(scoped.total, 1);
  assert.equal(scoped.items[0].checkpointId, "cp-02");
  assert.equal(scoped.items[0].attachments[0].evidenceId, "cover-02");
});

test("项目历史分页：服务端筛选后按 offset/limit 取页", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-project-page-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createYingningInboxService(root, { inboxDir: path.join(root, "runtime") });
  for (let index = 0; index < 5; index += 1) {
    const data = Buffer.from(`evidence-shot-${index}`);
    await service.accept(projectPhoto({
      intakeId: crypto.randomUUID(),
      checkpointId: index % 2 ? "cp-02" : "cp-01",
      attachments: [{ ...photoAttachment(data), attachmentId: crypto.randomUUID(), evidenceId: `cover-${index}` }],
    }));
  }
  const page1 = await service.list({ projectId: "demo-project", limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.nextOffset, 2);
  const page2 = await service.list({ projectId: "demo-project", limit: 2, offset: 2 });
  assert.equal(page2.items.length, 2);
  const page3 = await service.list({ projectId: "demo-project", limit: 2, offset: 4 });
  assert.equal(page3.items.length, 1);
  assert.equal(page3.nextOffset, null);
});

test("生产路由按项目/检查点参数在服务端筛选列表", async () => {
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /yingningInbox\.list\(\{[\s\S]*projectId: query\.get\("projectId"\)[\s\S]*checkpointId: query\.get\("checkpointId"\)/u);
});
