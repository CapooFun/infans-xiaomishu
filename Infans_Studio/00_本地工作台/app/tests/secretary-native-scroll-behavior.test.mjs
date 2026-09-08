import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve(import.meta.dirname, "../native/InfansHealthSync/InfansHealthSync");

test("native long chat follows only when the reader was near the bottom or sent the new message", async () => {
  const source = await fs.readFile(path.join(nativeRoot, "SecretaryConversationView.swift"), "utf8");

  assert.match(source, /@State private var isNearBottom = true/u);
  assert.match(source, /let wasNearBottom = isNearBottom/u);
  assert.match(source, /let appendedMessages = newValue\.messageIDs\.count > oldValue\.messageIDs\.count[\s\S]*newValue\.messageIDs\.starts\(with: oldValue\.messageIDs\)/u);
  assert.match(source, /guard newValue\.lastMessageIsFromCapoo \|\| wasNearBottom else \{ return \}/u);
  assert.match(source, /streamedLastMessageChanged && wasNearBottom/u);
  assert.doesNotMatch(source, /\.onChange\(of: store\.messages\.last\?\.id\)[\s\S]{0,220}proxy\.scrollTo/u);
  assert.doesNotMatch(source, /\.onChange\(of: store\.messages\.last\?\.text\)[\s\S]{0,220}proxy\.scrollTo/u);
});

test("native long chat measures bottom proximity and exposes a manual latest-message control", async () => {
  const source = await fs.readFile(path.join(nativeRoot, "SecretaryConversationView.swift"), "utf8");

  assert.match(source, /SecretaryConversationBottomOffsetKey/u);
  assert.match(source, /geometry\.frame\(in: \.named\("secretary-conversation-scroll"\)\)\.maxY/u);
  assert.match(source, /bottomOffset <= viewport\.size\.height \+ bottomFollowDistance/u);
  assert.match(source, /if !isNearBottom \{[\s\S]*Label\("\u56de\u5230\u5e95\u90e8", systemImage: "arrow\.down"\)/u);
  assert.match(source, /\.accessibilityLabel\("\u56de\u5230\u6700\u65b0\u6d88\u606f"\)/u);
  assert.match(source, /proxy\.scrollTo\(bottomAnchorID, anchor: \.bottom\)/u);
});
