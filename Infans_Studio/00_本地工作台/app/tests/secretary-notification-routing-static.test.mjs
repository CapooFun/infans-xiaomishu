import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const nativeRoot = new URL("../native/InfansHealthSync/InfansHealthSync/", import.meta.url);

async function source(name) {
  return fs.readFile(new URL(name, nativeRoot), "utf8");
}

test("notification tap is routed through one pending conversation authority", async () => {
  const [app, experience, root] = await Promise.all([
    source("InfansHealthSyncApp.swift"),
    source("SecretaryChatExperience.swift"),
    source("SecretaryChatRootView.swift"),
  ]);

  assert.match(app, /UNUserNotificationCenter\.current\(\)\.delegate = self/u);
  assert.match(app, /didReceive response: UNNotificationResponse/u);
  assert.match(app, /userInfo\["conversationId"\]/u);
  assert.match(app, /SecretaryChatNotificationRouter\.shared\.receive/u);
  assert.match(experience, /final class SecretaryChatNotificationRouter/u);
  assert.match(experience, /@Published private\(set\) var pendingConversationID/u);
  assert.match(root, /openPendingNotificationConversationIfNeeded/u);
  assert.match(root, /await store\.selectConversation\(conversationID\)/u);
  assert.match(root, /notificationRouter\.consume\(conversationID\)/u);
});
