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

test("阅读位置留在会话视图内，滚动不通知全局重建也不逐条落盘", async () => {
  const [conversation, store] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "SecretaryConversationView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "SecretaryChatStore.swift"), "utf8"),
  ]);

  assert.match(conversation, /@State private var readingAnchor: String\?/u);
  assert.match(conversation, /\.scrollPosition\(id: \$readingAnchor\)/u);
  assert.match(
    conversation,
    /\.task\(id: store\.currentConversationId\) \{\s*readingAnchor = store\.restoredScrollAnchor\(\)/u,
  );
  assert.match(
    conversation,
    /\.onChange\(of: readingAnchor\) \{ _, anchor in\s*store\.recordScrollAnchor\(anchor\)/u,
  );
  assert.doesNotMatch(conversation, /store\.scrollAnchor/u);

  assert.doesNotMatch(store, /@Published var scrollAnchor/u);
  const recordStart = store.indexOf("func recordScrollAnchor(");
  const recordEnd = store.indexOf("private func scheduleScrollAnchorPersist");
  assert.ok(recordStart >= 0 && recordEnd > recordStart);
  const record = store.slice(recordStart, recordEnd);
  assert.match(record, /if let messageId, !messages\.contains\(where: \{ \$0\.id == messageId \}\) \{ return \}/u);
  assert.match(record, /guard scrollAnchorsByConversation\[currentConversationId\] != messageId else \{ return \}/u);
  assert.match(record, /scheduleScrollAnchorPersist\(\)/u);
  assert.doesNotMatch(record, /\bpersist\(\)/u);
});

test("信箱对账没有变化时不往界面重推消息、摘要和已读", async () => {
  const store = await fs.readFile(path.join(nativeRoot, "SecretaryChatStore.swift"), "utf8");

  const mailboxStart = store.indexOf("private func applyMailboxSnapshot");
  const mailboxEnd = store.indexOf("private func upsertMailboxMessage");
  assert.ok(mailboxStart >= 0 && mailboxEnd > mailboxStart);
  const mailbox = store.slice(mailboxStart, mailboxEnd);
  assert.match(mailbox, /let pendingBefore = pendingTurns/u);
  assert.match(
    mailbox,
    /guard merged != conversation\.messages \|\| pendingTurns != pendingBefore else \{\s*startPendingTransmissionWorkerIfNeeded\(\)\s*return\s*\}/u,
  );

  const rebuildStart = store.indexOf("private func rebuildMessages");
  const rebuildEnd = store.indexOf("private func replaceVoiceTranscript");
  const rebuild = store.slice(rebuildStart, rebuildEnd);
  assert.match(rebuild, /if messages != next \{ messages = next \}/u);

  const summaryStart = store.indexOf("private func upsertSummary");
  const summaryEnd = store.indexOf("private func reconcilePendingAgainstConversation");
  const summary = store.slice(summaryStart, summaryEnd);
  assert.match(summary, /if conversationSummaries\.first != summary \{/u);

  const readStart = store.indexOf("private func markVisibleConversationRead");
  const readEnd = store.indexOf("private func refreshConversationSummaries");
  const read = store.slice(readStart, readEnd);
  assert.match(read, /guard unreadState\.needsReadMark\(summary\) else \{ return \}/u);

  const serverStart = store.indexOf("private func applyServerConversation");
  const serverEnd = store.indexOf("private func upsertSummary");
  const server = store.slice(serverStart, serverEnd);
  assert.match(server, /if currentConversation != conversation \{ currentConversation = conversation \}/u);
  assert.match(server, /if messages != sorted \{ messages = sorted \}/u);
});
