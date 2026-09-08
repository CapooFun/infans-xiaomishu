import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("iOS 一对一朗读按钮在对方头像下方，并给出准备与失败反馈", async () => {
  const source = await fs.readFile(
    new URL("../native/InfansHealthSync/InfansHealthSync/SecretaryConversationView.swift", import.meta.url),
    "utf8",
  );
  assert.match(source, /speechToggleButton/);
  assert.match(source, /\.frame\(width: 44, height: 44\)/);
  assert.match(source, /accessibilityIdentifier\("secretary-message-speech-toggle"\)/);
  assert.match(source, /Text\("正在准备朗读"\)/);
  assert.match(source, /accessibilityIdentifier\("secretary-speech-preparing"\)/);
  assert.match(source, /showsSpeechRetry/);
  assert.match(source, /speech\.binding\.canRetry/);
  assert.match(source, /accessibilityIdentifier\("secretary-message-speech-retry"\)/);
  assert.match(source, /assetName: "UserChatAvatar"/);
  assert.doesNotMatch(source, /CapooChatAvatar/);
  assert.doesNotMatch(source, /font\(\.system\(size: 11, weight: \.semibold\)\)/);
});
