import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const nativeRoot = path.join(root, "app/native/InfansHealthSync");
const chromeRoot = path.join(root, "chrome-extension-发给秘书");

test("iOS 主 App 默认进入银月聊天，设置与分享保留统一名称", async () => {
  const [appInfo, app, contentView, rootView, settingsView, shareInfo, quickPhoto] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/Info.plist"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/InfansHealthSyncApp.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/ContentView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryChatRootView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretarySettingsView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansShareExtension/Info.plist"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/QuickPhotoInbox.swift"), "utf8"),
  ]);
  assert.match(appInfo, /<string>小秘书<\/string>/u);
  assert.match(contentView, /SecretaryChatRootView\(\)/u);
  assert.match(rootView, /SecretaryConversationView\(store: store\)[\s\S]*SecretaryMessageComposer\(store: store\)/u);
  assert.match(settingsView, /navigationTitle\("设置"\)/u);
  assert.match(settingsView, /Section\("健康自动同步"\)/u);
  assert.match(shareInfo, /<string>发给秘书<\/string>/u);
  assert.match(app, /updateAppShortcutParameters[\s\S]*IntentDonationManager\.shared\.donate/u);
  assert.match(quickPhoto, /Label\("最近收件", systemImage: "photo\.stack"\)/u);
  assert.match(quickPhoto, /secretary\.quickPhoto\.lastSavedItemID/u);
  assert.doesNotMatch(appInfo, /银月在帮前辈同步哟/u);
  assert.doesNotMatch(contentView + rootView + settingsView, /银月在帮前辈同步哟/u);
});

test("iPhone 与 iPad 分享框用银月第一人称表达真实送达状态", async () => {
  const swift = await fs.readFile(path.join(nativeRoot, "InfansShareExtension/ShareComposerView.swift"), "utf8");
  assert.match(swift, /我先替你收着啦/u);
  assert.match(swift, /有什么要悄悄嘱咐我的吗？/u);
  assert.match(swift, /留一句给我的悄悄话，或者直接发送…/u);
  assert.match(swift, /TextEditor\(text: \$model\.note\)/u);
  assert.match(swift, /return "交给银月"/u);
  assert.match(swift, /return "正在接过来…"/u);
  assert.match(swift, /return "收好啦！"/u);
  assert.match(swift, /case delivered/u);
  assert.match(swift, /case failedRetryPending\(String\)/u);
  assert.match(swift, /service\.enqueue\(item,/u);
  assert.match(swift, /phase = \.failedRetryPending\(error\.localizedDescription\)/u);
  assert.match(swift, /resultVisibilityNanoseconds: UInt64 = 800_000_000/u);
  assert.match(swift, /Text\("已经安全收好啦！"\)/u);
  assert.match(swift, /Text\("先在这台设备存好了，联网后会自动送达～"\)/u);
  assert.match(swift, /accessibilityLabel\("先不发了"\)/u);
  assert.doesNotMatch(swift, /她会先|持久化|可靠队列|等待续传/u);
  assert.doesNotMatch(swift, /Task\.detached[\s\S]*service\.deliver/u);
  assert.doesNotMatch(swift, /NavigationStack|\bForm\s*\{/u);
  assert.doesNotMatch(swift, /已送达 Mac 收件箱/u);
});

test("iPad 横屏只保留单聊画布", async () => {
  const [rootView, listView, conversationView] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryChatRootView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryConversationListView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryConversationView.swift"), "utf8"),
  ]);
  assert.match(rootView, /usesPadLandscapeCanvas[\s\S]*UIDevice\.current\.userInterfaceIdiom == \.pad[\s\S]*geometry\.size\.width > geometry\.size\.height/u);
  assert.match(rootView, /padLandscapeCanvas\(geometry: geometry\)[\s\S]*SecretaryChatBackground[\s\S]*ignoresSafeArea\(\)/u);
  assert.doesNotMatch(rootView, /padGroupSurface|padGroupConversationColumn|CandidateIpadGroupStage/u);
  assert.match(rootView, /showsConversations: \$showsConversationDrawer/u);
  assert.match(rootView, /\.inspector\(isPresented: \$showsInspector\)/u);
  assert.match(listView, /句话待送出/u);
  assert.match(conversationView, /正在输入中/u);
  assert.doesNotMatch(conversationView, /Text\("正在回"\)/u);
  assert.doesNotMatch(rootView + listView + conversationView, /附件引用|待续传/u);
});

test("开源树不含 Watch App 与表盘源码，设置页也不再当产品入口", async () => {
  await assert.rejects(fs.stat(path.join(nativeRoot, "InfansHealthSyncWatch")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(nativeRoot, "InfansCodexComplication")), { code: "ENOENT" });
  const settings = await fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretarySettingsView.swift"), "utf8");
  assert.doesNotMatch(settings, /Apple Watch 入口|重试 Watch 待发送/u);
});

test("原生聊天只用私有鉴权读附件与 Mac 银月语音，并提供明确授权的本地通知", async () => {
  const [attachmentView, client, conversation, experience, settings, composer] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryAttachmentView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryChatClient.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryConversationView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryChatExperience.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretarySettingsView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryMessageComposer.swift"), "utf8"),
  ]);
  assert.match(attachmentView, /store\.localAttachmentURL\(for: attachment\)/u);
  assert.match(attachmentView, /case \.image[\s\S]*case \.audio[\s\S]*case \.file/u);
  assert.doesNotMatch(attachmentView, /AsyncImage|\bLink\s*\(/u);
  assert.match(client, /attachmentResource[\s\S]*makeRequest\(path: path, method: "GET"/u);
  assert.match(client, /Bearer[\s\S]*Authorization/u);
  assert.match(conversation, /speaker\.wave\.2/u);
  assert.match(conversation, /ForEach\(message\.attachments\)/u);
  assert.match(experience, /api\/secretary-mobile\/tts/u);
  assert.match(experience, /AVAudioPlayer/u);
  assert.match(experience, /setCategory\(\.playback, mode: \.spokenAudio/u);
  assert.match(experience, /暂不可朗读，文字仍在/u);
  assert.doesNotMatch(experience, /AVSpeechSynthesizer|AVSpeechUtterance/u);
  assert.match(experience, /UIApplication\.shared\.applicationState == \.active/u);
  assert.match(experience, /requestAuthorization\(options:/u);
  assert.match(experience, /conversation\.privacy == "private"/u);
  assert.match(settings, /Section\("聊天体验"\)/u);
  assert.match(settings, /Button\("允许聊天通知"\)/u);
  assert.match(settings, /Toggle\("秘书回复完后自动朗读"/u);
  assert.match(settings, /Toggle\("后台收到完整回复时提醒我"/u);
  assert.doesNotMatch(settings, /使用 iPhone 系统中文声音/u);
  assert.match(composer, /accessoryActions: SecretaryComposerAccessoryActions = \.unavailable/u);
  assert.match(composer, /(?=[\s\S]*PhotosPicker\()(?=[\s\S]*\.fileImporter\()(?=[\s\S]*accessibilityLabel\("选择照片"\))(?=[\s\S]*accessibilityLabel\("选择文件"\))/u);
});

test("原生检查器只介绍一对一会话", async () => {
  const inspector = await fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryConversationInspectorView.swift"), "utf8");
  assert.match(inspector, /一对一会话/u);
});

test("开源版 iPad 主界面只挂载一对一画布", async () => {
  const rootView = await fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryChatRootView.swift"), "utf8");
  assert.doesNotMatch(rootView, /padGroupSurface|SecretaryGuestStageView\(/u);
});

test("原生会话控制只使用 bootstrap 下发的模型和只读用量契约", async () => {
  const [models, inspector, store] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryChatModels.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryConversationInspectorView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "InfansHealthSync/SecretaryChatStore.swift"), "utf8"),
  ]);
  assert.match(models, /struct SecretaryChatModelRuntime[\s\S]*let ordinary: SecretaryChatModelChannel/u);
  assert.match(inspector, /一对一会话/u);
  assert.match(inspector, /allowedOrdinaryBackends/u);
  assert.match(inspector, /allowedCursorModels/u);
  assert.match(inspector, /当前会话执行（只读）/u);
  assert.match(store, /if turn\.autoChat == true \{ continue \}/u);
  assert.match(store, /status == 409[\s\S]*resolveHTTPConflict[\s\S]*allowResyncRetry: false/u);
  assert.doesNotMatch(inspector + store, /cursor-grok-4\.6-high|aion-labs\/aion-3\.0/u);
});

test("成年银月背景进入原生扩展资源，并为表单保留半透明阅读层", async () => {
  const swift = await fs.readFile(path.join(nativeRoot, "InfansShareExtension/ShareComposerView.swift"), "utf8");
  const project = await fs.readFile(path.join(nativeRoot, "InfansHealthSync.xcodeproj/project.pbxproj"), "utf8");
  const imagePath = path.join(nativeRoot, "InfansShareExtension/YinyueShareBackground.jpg");
  const image = await fs.stat(imagePath);
  assert.match(swift, /Bundle\.main\.url\([\s\S]*forResource: "YinyueShareBackground"[\s\S]*withExtension: "jpg"/u);
  assert.match(swift, /Image\(uiImage: backgroundImage\)/u);
  assert.match(swift, /scaleEffect\(/u);
  assert.match(swift, /opacity\(0\.72\)[\s\S]*opacity\(0\.56\)/u);
  assert.match(project, /YinyueShareBackground\.jpg in Resources/u);
  assert.ok(image.size > 0);
});

test("Chrome 不再弹二级填写窗，工具栏和右键都直接安全入队", async () => {
  const [manifest, background, readme] = await Promise.all([
    fs.readFile(path.join(chromeRoot, "manifest.json"), "utf8"),
    fs.readFile(path.join(chromeRoot, "background.js"), "utf8"),
    fs.readFile(path.join(chromeRoot, "README.md"), "utf8"),
  ]);
  assert.doesNotMatch(manifest, /default_popup/u);
  assert.match(background, /chrome\.action\.onClicked[\s\S]*enqueueDraft/u);
  assert.match(background, /contexts: \["page", "link", "selection", "image"\]/u);
  assert.match(readme, /现行交互只有“一键发送”，没有备注窗或二级菜单/u);
  await assert.rejects(fs.stat(path.join(chromeRoot, "compose.html")), { code: "ENOENT" });
});
