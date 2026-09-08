import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve(import.meta.dirname, "../native/InfansHealthSync/InfansHealthSync");

test("iPhone and portrait windows use portrait chat art while regular landscape uses iPad art", async () => {
  const [rootView, conversationView, portraitContents, landscapeContents] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "SecretaryChatRootView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "SecretaryConversationView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "Assets.xcassets/YinyueChatBackgroundPortrait.imageset/Contents.json"), "utf8"),
    fs.readFile(path.join(nativeRoot, "Assets.xcassets/YinyueChatBackgroundLandscape.imageset/Contents.json"), "utf8"),
  ]);

  assert.match(rootView, /horizontalSizeClass != \.compact[\s\S]*geometry\.size\.width > geometry\.size\.height/u);
  assert.match(rootView, /standardChatColumn\(layout: layout\)[\s\S]*secretaryChatUsesLandscapeBackground, layout != \.compact && usesLandscapeChatBackground/u);
  assert.match(rootView, /SecretaryChatBackground\(/u);
  assert.doesNotMatch(rootView, /showsFireflies/u);
  assert.match(conversationView, /@Environment\(\\\.secretaryChatUsesLandscapeBackground\)/u);
  assert.match(conversationView, /SecretaryBundledArt\.backgroundAssetName\(for: secretaryID, landscape: usesLandscapeImage\)/u);
  assert.match(conversationView, /aspectRatio\(contentMode: \.fill\)[\s\S]*\.clipped\(\)/u);
  assert.match(conversationView, /\.fill\(\.ultraThinMaterial\)[\s\S]*LinearGradient/u);
  assert.match(conversationView, /\.allowsHitTesting\(false\)[\s\S]*\.accessibilityHidden\(true\)/u);
  assert.doesNotMatch(conversationView, /struct SecretaryChatFireflies/u);
  assert.doesNotMatch(conversationView, /showsFireflies/u);
  assert.doesNotMatch(conversationView, /TimelineView\(\.animation/u);
  const artworkView = conversationView.slice(
    conversationView.indexOf("private struct SecretaryFillAlignedArtwork"),
    conversationView.indexOf("struct SecretaryChatBackground"),
  );
  assert.doesNotMatch(artworkView, /withAnimation|repeatForever|TimelineView/u);
  const backgroundView = conversationView.slice(
    conversationView.indexOf("struct SecretaryChatBackground"),
    conversationView.indexOf("struct SecretaryConversationView"),
  );
  assert.doesNotMatch(backgroundView, /SecretaryChatFireflies/u);
  assert.doesNotMatch(backgroundView, /YingningChatBackground/u);

  const portrait = JSON.parse(portraitContents);
  const landscape = JSON.parse(landscapeContents);
  assert.equal(portrait.images[0].filename, "YinyueChatBackgroundPortrait.jpg");
  assert.equal(landscape.images[0].filename, "YinyueChatBackgroundLandscape.jpg");
});

test("standard layouts keep their chat background while iPad landscape owns one full-screen background", async () => {
  const rootView = await fs.readFile(path.join(nativeRoot, "SecretaryChatRootView.swift"), "utf8");
  assert.match(rootView, /private func standardChatColumn[\s\S]*SecretaryChatBackground\(\s*secretaryID:[\s\S]*SecretaryConversationView[\s\S]*SecretaryMessageComposer/u);
  assert.match(rootView, /private func padLandscapeCanvas[\s\S]*SecretaryChatBackground\(\s*secretaryID:[\s\S]*ignoresSafeArea\(\)[\s\S]*HStack/u);
  const padChatSurface = rootView.slice(rootView.indexOf("private var padChatSurface"), rootView.indexOf("private func padSidebarPanel"));
  assert.doesNotMatch(padChatSurface, /SecretaryChatBackground\(/u);
});

test("empty conversation greeting follows the active secretary", async () => {
  const conversationSource = await fs.readFile(path.join(nativeRoot, "SecretaryConversationView.swift"), "utf8");
  const storeSource = await fs.readFile(path.join(nativeRoot, "SecretaryChatStore.swift"), "utf8");
  const composerSource = await fs.readFile(path.join(nativeRoot, "SecretaryMessageComposer.swift"), "utf8");
  assert.match(conversationSource, /Text\("你好，\\\(store\.activeSecretaryName\)在呢～"\)/u);
  assert.doesNotMatch(conversationSource, /Text\("我在这里。"\)/u);
  assert.match(storeSource, /var composerStatusPlaceholder: String/u);
  assert.match(storeSource, /displaySecretaryID == "yinyue"/u);
  assert.match(composerSource, /store\.composerStatusPlaceholder/u);
  assert.doesNotMatch(composerSource, /和\\\(store\.activeSecretaryName\)说说话/u);
});
