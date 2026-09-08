import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve(import.meta.dirname, "../native/InfansHealthSync/InfansHealthSync");

async function source(name) {
  return fs.readFile(path.join(nativeRoot, name), "utf8");
}

test("iPhone 顶栏与会话抽屉只保留一对一入口", async () => {
  const root = await source("SecretaryChatRootView.swift");
  const list = await source("SecretaryConversationListView.swift");
  const store = await source("SecretaryChatStore.swift");
  const header = root.slice(
    root.indexOf("struct SecretaryChatHeader"),
    root.indexOf("private struct SecretaryHeaderButtonStyle"),
  );

  assert.match(header, /store\.activeSecretaryName/u);
  assert.doesNotMatch(header, /padGroupSurface|CandidateIpadGroupStage/u);
  assert.match(header, /Image\(systemName: "sidebar\.left"\)/u);
  assert.match(header, /Image\(systemName: "ellipsis"\)/u);
  assert.doesNotMatch(header, /SecretaryAvatarView|arrow\.clockwise|slider\.horizontal\.3|connectionState\.label/u);
  assert.doesNotMatch(root, /SecretaryGuestStageView\(|SecretaryGuestCompactSpeakerView\(/u);
  assert.match(list, /phoneConversations\(store\.conversationSummaries\)/u);
  assert.match(store, /ensureDirectConversationVisible/u);
});

test("iPhone 会话和连接入口收进左侧抽屉", async () => {
  const [root, list, conversation] = await Promise.all([
    source("SecretaryChatRootView.swift"),
    source("SecretaryConversationListView.swift"),
    source("SecretaryConversationView.swift"),
  ]);

  assert.match(root, /standardConversationDrawer\(availableWidth:/u);
  assert.match(root, /availableWidth \* 0\.86/u);
  assert.match(root, /onOpenSettings:[\s\S]*showsSettings = true/u);
  assert.match(list, /utilityEntry\("设置"|打开设置/u);
  assert.match(list, /最近收件/u);
  assert.match(list, /sheet\(isPresented: \$showsQuickPhotoHistory\)[\s\S]*QuickPhotoHistoryView/u);
  assert.match(conversation, /需要重新配对 · 点此查看/u);
  assert.match(conversation, /连接较弱 · 消息会先留在 iPhone/u);
});

test("iPhone 底栏按微信习惯切换整条语音输入并接系统媒体入口", async () => {
  const composer = await source("SecretaryMessageComposer.swift");

  assert.match(composer, /usesHoldToTalk[\s\S]*SecretaryHoldToTalkSurface/u);
  assert.match(composer, /showsEmojiPicker = true[\s\S]*face\.smiling/u);
  assert.match(composer, /\.sheet\(isPresented: \$showsEmojiPicker\)[\s\S]*SecretaryEmojiPicker\(/u);
  assert.match(composer, /\.presentationDetents\(\[\.medium, \.large\]\)/u);
  assert.match(composer, /showsMoreActions\.toggle\(\)/u);
  assert.match(composer, /PhotosPicker\([\s\S]*composerActionTile\(systemImage: "photo", label: "照片"\)/u);
  assert.match(composer, /openCamera\(\)[\s\S]*composerActionTile\(systemImage: "camera", label: "拍摄"\)/u);
  assert.match(composer, /isFileImporterPresented = true[\s\S]*composerActionTile\(systemImage: "doc", label: "文件"\)/u);
  assert.match(composer, /ignoresSafeArea\(edges: \.bottom\)/u);
});

test("两端聊天栏共享玄夜与晴岚语义色，并让安全区跟随主题", async () => {
  const [root, composer, list, conversation] = await Promise.all([
    source("SecretaryChatRootView.swift"), source("SecretaryMessageComposer.swift"),
    source("SecretaryConversationListView.swift"), source("SecretaryConversationView.swift"),
  ]);
  assert.match(root, /enum SecretaryAppearanceTheme/u);
  assert.match(root, /case night[\s\S]*case day/u);
  assert.match(root, /"玄夜"[\s\S]*"晴岚"/u);
  assert.match(root, /preferredColorScheme\(appearanceTheme\.colorScheme\)/u);
  assert.match(root, /Color\.secretaryBarJade\.ignoresSafeArea\(\)/u);
  assert.match(root, /static let secretaryPanelJade = secretaryDynamicColor/u);
  assert.match(root, /static let secretaryInputJade = secretaryDynamicColor/u);
  assert.match(root, /static let secretaryBarJade = secretaryDynamicColor/u);
  assert.match(composer, /Color\.secretaryPanelJade\.opacity\(surfaceOpacity\)\s*\.ignoresSafeArea\(edges: \.bottom\)/u);
  assert.doesNotMatch(composer, /Color\(red: 0\.12, green: 0\.12, blue: 0\.115\)/u);
  assert.match(list, /Color\.secretaryBarJade\.opacity\(surfaceOpacity\)/u);
  assert.match(conversation, /\.fill\(Color\.secretaryDeepJade\.opacity\(surfaceOpacity\)\)/u);
});
