import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve(import.meta.dirname, "../native/InfansHealthSync/InfansHealthSync");

test("chat can dismiss the software keyboard by tapping the transcript or dragging a short thread", async () => {
  const [conversation, composer, root] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "SecretaryConversationView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "SecretaryMessageComposer.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "SecretaryChatRootView.swift"), "utf8"),
  ]);

  assert.match(composer, /enum SecretaryKeyboard/u);
  assert.match(composer, /static func resign\(\)/u);
  assert.match(composer, /keyboardDidHideNotification/u);
  assert.match(composer, /SecretaryKeyboard\.dismissNotification/u);
  assert.match(composer, /private func setComposerFocused\(_ next: Bool\)/u);
  assert.match(composer, /setComposerFocused\(!usesHoldToTalk\)/u);
  assert.match(composer, /setComposerFocused\(false\)/u);
  assert.match(composer, /accessoryActions: SecretaryComposerAccessoryActions = \.unavailable/u);

  assert.match(conversation, /scrollDismissesKeyboard\(\.interactively\)/u);
  assert.match(conversation, /scrollBounceBehavior\(\.always\)/u);
  assert.match(conversation, /keyboardDismissMode = \.interactive/u);
  assert.match(conversation, /alwaysBounceVertical = true/u);
  assert.match(conversation, /SecretaryKeyboard\.resign\(\)/u);
  assert.match(conversation, /minHeight: viewport\.size\.height/u);

  assert.match(root, /SecretaryKeyboard\.resign\(\)/u);
  assert.match(root, /showsConversations\.wrappedValue = true/u);
});
