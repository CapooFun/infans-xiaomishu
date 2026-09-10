import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const nativeRoot = new URL("../native/InfansHealthSync/", import.meta.url);

test("快速拍照是独立收件入口，不复用聊天相机也不索取相册权限", async () => {
  const [quickPhoto, content, appInfo] = await Promise.all([
    fs.readFile(new URL("InfansHealthSync/QuickPhotoInbox.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("InfansHealthSync/ContentView.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("InfansHealthSync/Info.plist", nativeRoot), "utf8"),
  ]);
  assert.match(quickPhoto, /OpenQuickPhotoInboxIntent[\s\S]*?AppShortcutsProvider/u);
  assert.match(quickPhoto, /supportedModes:\s*IntentModes\s*\{\s*\.foreground\(\.immediate\)\s*\}/u);
  assert.match(quickPhoto, /sourceSemantic: \.quickPhotoInbox/u);
  assert.match(quickPhoto, /fileDataRepresentation\(\)/u);
  assert.match(quickPhoto, /photoOutput[\s\S]*?acceptCapturedPhoto/u);
  assert.match(quickPhoto, /private func acceptCapturedPhoto[\s\S]*?Task \{ await enqueueCapturedPhoto\(data:/u);
  assert.match(quickPhoto, /case \.saved:[\s\S]*?已收下/u);
  assert.match(quickPhoto, /QuickPhotoHistoryView[\s\S]*?事后补一句[\s\S]*?补备注/u);
  assert.doesNotMatch(quickPhoto, /再拍一张|确认发送|SecretaryChatStore|sendMessage|PHPhotoLibrary|PhotosPicker/u);
  assert.match(content, /fullScreenCover[\s\S]*?QuickPhotoInboxView/u);
  assert.match(appInfo, /infans-secretary[\s\S]*?快速拍照收件箱/u);
  assert.doesNotMatch(appInfo, /NSPhotoLibraryUsageDescription/u);
});

test("截屏动作承接快捷指令上一动作的图片并在后台直接入箱", async () => {
  const [quickPhoto, models, appInfo] = await Promise.all([
    fs.readFile(new URL("InfansHealthSync/QuickPhotoInbox.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("InfansHealthSync/YingningIntakeModels.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("InfansHealthSync/Info.plist", nativeRoot), "utf8"),
  ]);
  assert.match(quickPhoto, /SaveScreenshotToInboxIntent:\s*AppIntent/u);
  assert.match(quickPhoto, /supportedModes:\s*IntentModes\s*\{\s*\.background\s*\}/u);
  assert.match(quickPhoto, /supportedTypeIdentifiers:\s*\["public\.image"\][\s\S]*?inputConnectionBehavior:\s*\.connectToPreviousIntentResult/u);
  assert.match(quickPhoto, /SaveScreenshotToInboxIntent[\s\S]*?sourceSemantic:\s*\.quickPhotoInbox/u);
  assert.match(quickPhoto, /service\.enqueue[\s\S]*?service\.deliver/u);
  assert.match(models, /iOSQuickPhoto\s*=\s*"ios_quick_photo"/u);
  assert.match(models, /fileShare\s*=\s*"file_share"/u);
  assert.match(models, /allowedFileTypes/u);
  assert.doesNotMatch(models, /quickScreenshotInbox|ios_quick_screenshot/u);
  assert.doesNotMatch(quickPhoto, /PHPhotoLibrary|PhotosPicker/u);
  assert.doesNotMatch(appInfo, /NSPhotoLibraryUsageDescription/u);
});

test("小秘书在前台时，系统截图会自动复制当前界面进照片收件箱", async () => {
  const [quickPhoto, app, appInfo] = await Promise.all([
    fs.readFile(new URL("InfansHealthSync/QuickPhotoInbox.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("InfansHealthSync/InfansHealthSyncApp.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("InfansHealthSync/Info.plist", nativeRoot), "utf8"),
  ]);
  assert.match(quickPhoto, /ForegroundScreenshotInboxCapture/u);
  assert.match(quickPhoto, /UIApplication\.userDidTakeScreenshotNotification/u);
  assert.match(quickPhoto, /applicationState\s*==\s*\.active/u);
  assert.match(quickPhoto, /drawHierarchy[\s\S]*?SCREENSHOT_[\s\S]*?service\.enqueue[\s\S]*?service\.deliver/u);
  assert.match(app, /ForegroundScreenshotInboxCapture\.shared\.start\(\)/u);
  assert.doesNotMatch(quickPhoto, /PHPhotoLibrary|PhotosPicker/u);
  assert.doesNotMatch(appInfo, /NSPhotoLibraryUsageDescription/u);
});

test("照片分享保留宿主交付的文件字节，文字和网址入口仍保留", async () => {
  const [loader, composer, extensionInfo] = await Promise.all([
    fs.readFile(new URL("InfansShareExtension/SharePayloadLoader.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("InfansShareExtension/ShareComposerView.swift", nativeRoot), "utf8"),
    fs.readFile(new URL("InfansShareExtension/Info.plist", nativeRoot), "utf8"),
  ]);
  assert.match(loader, /loadFileRepresentation[\s\S]*?Data\(contentsOf: fileURL\)/u);
  assert.doesNotMatch(loader, /jpegData|heicData|UIImageJPEGRepresentation/u);
  assert.match(loader, /looksLikeDocument/u);
  assert.match(loader, /UTType\.pdf/u);
  assert.match(loader, /documentLoadTypes/u);
  assert.match(loader, /return provider.hasItemConformingToTypeIdentifier\(UTType\.fileURL\.identifier\)/u);
  assert.match(loader, /!provider\.hasItemConformingToTypeIdentifier\(UTType\.fileURL\.identifier\)/u);
  assert.match(composer, /sourceSemantic: payload\.sourceSemantic/u);
  assert.match(extensionInfo, /NSExtensionActivationSupportsFileWithMaxCount[\s\S]*?<integer>4<\/integer>/u);
  assert.match(extensionInfo, /NSExtensionActivationSupportsImageWithMaxCount[\s\S]*?<integer>4<\/integer>/u);
  assert.match(extensionInfo, /NSExtensionActivationSupportsText/u);
  assert.match(extensionInfo, /NSExtensionActivationSupportsWebURLWithMaxCount/u);
});

test("现有 NAS 信箱发布包完整携带照片来件的依赖", async () => {
  const dockerfile = await fs.readFile(new URL("../deploy/secretary-mailbox/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /workbench-secretary-mailbox\.mjs/u);
  assert.match(dockerfile, /workbench-yingning-inbox\.mjs/u);
  assert.match(dockerfile, /vault-paths\.mjs/u);
});
