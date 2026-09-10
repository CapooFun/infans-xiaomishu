import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shortcutSourceUrl = new URL("../native/CodexShortcutController.swift", import.meta.url);
const appSourceUrl = new URL("../native/SecretaryApp.swift", import.meta.url);

test("秘书朗读用句号，听写用逗号，并读取本机快捷键接口", async () => {
  const [shortcut, app] = await Promise.all([
    readFile(shortcutSourceUrl, "utf8"),
    readFile(appSourceUrl, "utf8"),
  ]);

  assert.match(shortcut, /private let cursorBundleIdentifier = "com\.todesktop\.230313mzl4w4u92"/u);
  assert.match(shortcut, /supportedShortcutBundleIdentifiers/u);
  assert.match(shortcut, /readAloudKeyCode: Int64 = 47/u);
  assert.match(shortcut, /dictationKeyCode: Int64 = 43/u);
  assert.match(shortcut, /controller\.action\(for: comma\) == \.dictation/u);
  assert.match(shortcut, /controller\.action\(for: period\) == \.readAloud/u);
  assert.match(shortcut, /computer-shortcuts/u);
  assert.match(shortcut, /command-period read, command-comma dictate, command-escape lights-off, both-command screenshot/u);
  assert.match(shortcut, /\/api\/tools\/lights-off/u);
  assert.match(shortcut, /agentScreenshot/u);
  assert.match(shortcut, /consumeDualCommand\(flags: bothWithShift\) == true/u);
  assert.match(shortcut, /attachScreenshotToCursor/u);
  assert.match(shortcut, /NSEvent\.mouseLocation/u);
  assert.match(shortcut, /copyMouseDisplayToPasteboard/u);
  assert.doesNotMatch(shortcut, /right-screen-handoff|rightScreenHandoff/u);
  assert.match(shortcut, /\/api\/secretary/u);
  assert.match(shortcut, /activeSecretaryId/u);
  assert.match(shortcut, /cachedReadAloudSpeaker/u);
  assert.match(shortcut, /readAloudSpeakerFallback = "yinyue"/u);
  assert.match(shortcut, /readAloudSpeakerIDs: Set<String> = \["yinyue", "meining"\]/u);
  assert.doesNotMatch(shortcut, /"yingning"/u);
  assert.match(app, /CodexShortcutController\.shortcutMappingSelfTest\(\)/u);
});
