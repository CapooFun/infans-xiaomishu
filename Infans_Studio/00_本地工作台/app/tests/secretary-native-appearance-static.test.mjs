import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve(import.meta.dirname, "../native/InfansHealthSync/InfansHealthSync");

async function source(name) {
  return fs.readFile(path.join(nativeRoot, name), "utf8");
}

test("native chat exposes only the two source-backed themes and one surface-opacity control", async () => {
  const [root, settings] = await Promise.all([
    source("SecretaryChatRootView.swift"),
    source("SecretarySettingsView.swift"),
  ]);

  assert.match(root, /enum SecretaryAppearanceTheme:[\s\S]*case night[\s\S]*case day/u);
  assert.match(root, /"玄夜"[\s\S]*"晴岚"/u);
  assert.match(root, /@AppStorage\("secretary\.appearanceTheme"\)/u);
  assert.match(root, /@AppStorage\("secretary\.surfaceOpacity"\)/u);
  assert.match(settings, /Section\("外观"\)/u);
  assert.match(settings, /Picker\("主题"/u);
  assert.match(settings, /Slider\(value: \$surfaceOpacity, in: 0\.64\.\.\.1, step: 0\.04\)/u);
  assert.doesNotMatch(settings, /Section\("统一提醒权限"\)/u);
  assert.match(settings, /if showsMaintenance \{[\s\S]*Section\("系统权限"\)/u);
});

test("conversation chrome uses dynamic theme colors, larger role avatars and a private self avatar", async () => {
  const [root, conversation, composer, catalog] = await Promise.all([
    source("SecretaryChatRootView.swift"),
    source("SecretaryConversationView.swift"),
    source("SecretaryMessageComposer.swift"),
    fs.readFile(path.join(nativeRoot, "Assets.xcassets/UserChatAvatar.imageset/Contents.json"), "utf8"),
  ]);

  assert.match(root, /static let secretaryBarJade = secretaryDynamicColor/u);
  assert.match(root, /static let secretaryUserBubbleTop = secretaryDynamicColor/u);
  assert.match(conversation, /size: 48/u);
  assert.match(conversation, /assetName: "UserChatAvatar"/u);
  assert.match(conversation, /\.scrollIndicators\(\.hidden\)/u);
  assert.match(conversation, /accessibilityLabel\("回到最新消息"\)/u);
  assert.doesNotMatch(conversation, /@Environment\(\\\.colorScheme\) private var colorScheme/u);
  assert.doesNotMatch(conversation, /colors: colorScheme == \.dark/u);
  assert.match(composer, /store\.composerStatusPlaceholder/u);
  assert.doesNotMatch(composer, /和\\\(store\.activeSecretaryName\)说说话/u);
  assert.match(composer, /accessibilityLabel\("发送给\\\(store\.activeSecretaryName\)"\)/u);
  assert.match(catalog, /UserChatAvatar\.jpg/u);
});

test("ordinary conversation history applies the hidden-session policy before search or rendering", async () => {
  const [models, list] = await Promise.all([
    source("SecretaryChatModels.swift"),
    source("SecretaryConversationListView.swift"),
  ]);

  assert.match(models, /enum SecretaryConversationVisibilityPolicy/u);
  assert.match(models, /conversation\.type == "direct"/u);
  assert.match(models, /conversation\.privacy == "standard"/u);
  assert.match(models, /preview != "内容已隐藏"/u);
  assert.match(models, /memberIds\.allSatisfy/u);
  assert.match(models, /static func visibleConversations/u);
  assert.match(list, /visibleConversationSummaries\.filter/u);
  assert.match(list, /ForEach\(filteredConversationSummaries\)/u);
});
