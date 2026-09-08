import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve(import.meta.dirname, "../native/InfansHealthSync/InfansHealthSync");

test("returning to the foreground reconciles Mac state before any reliable retry", async () => {
  const [rootView, store] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "SecretaryChatRootView.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "SecretaryChatStore.swift"), "utf8"),
  ]);
  assert.match(rootView, /phase == \.active[\s\S]*await store\.refresh\(\)/u);
  assert.match(store, /pendingTurns where turn\.conversationId == conversationId && turn\.needsTransmission/u);
  assert.match(store, /!reconciled\.needsTransmission[\s\S]*persist\(\)[\s\S]*return/u);
  assert.match(store, /turn\.state == \.macPersisted \|\| turn\.state == \.replyGenerating/u);
});

test("reply generating shows the character typing on the other side", async () => {
  const conversationView = await fs.readFile(path.join(nativeRoot, "SecretaryConversationView.swift"), "utf8");
  assert.match(conversationView, /showsTypingIndicator/u);
  assert.match(conversationView, /正在输入中/u);
  assert.doesNotMatch(conversationView, /Text\("正在回"\)/u);
  assert.doesNotMatch(conversationView, /正在想怎么回/u);
});

test("Mac-persisted and reply-generating turns stay out of the unsent retry count", async () => {
  const [models, store] = await Promise.all([
    fs.readFile(path.join(nativeRoot, "SecretaryChatModels.swift"), "utf8"),
    fs.readFile(path.join(nativeRoot, "SecretaryChatStore.swift"), "utf8"),
  ]);
  assert.match(models, /var needsTransmission: Bool[\s\S]*state == \.localQueued \|\| state == \.failedRetryPending/u);
  assert.match(store, /pendingTurns\.filter \{ \$0\.conversationId == conversationId && \$0\.needsTransmission \}\.count/u);
  assert.match(models, /case \.localQueued: return "发送中"/u);
  assert.match(models, /case \.macPersisted: return "未读"/u);
  assert.match(models, /case \.replyGenerating, \.deviceAvailable: return "已读"/u);
  assert.doesNotMatch(models, /case \.macPersisted, \.replyGenerating: return "未读"/u);
  assert.match(models, /case \.replyUnavailable: return "已读不回"/u);
  assert.match(models, /static func merging\(_ current: String, with incoming: String\)/u);
  assert.match(models, /static func promotingReadReceipts\(in messages: \[SecretaryChatMessage\]\)/u);
  assert.match(store, /var showsTypingIndicator: Bool/u);
  assert.match(store, /turn\.state == \.replyGenerating/u);
  assert.match(store, /SecretaryChatLocalDeliveryState\.merging\(/u);
  assert.match(store, /SecretaryChatRecovery\.promotingReadReceipts\(in:/u);
  assert.doesNotMatch(store, /merged\[index\]\.deliveryStage = turn\.state\.rawValue/u);
  assert.doesNotMatch(store, /if isStreaming \{ return true \}/u);
});

test("attachment-only messages keep a generic fallback but present the attachment card without fallback body text", async () => {
  const models = await fs.readFile(path.join(nativeRoot, "SecretaryChatModels.swift"), "utf8");
  assert.match(models, /if !attachments\.isEmpty \{ return "" \}/u);
  assert.match(models, /发送了一张图片/u);
  assert.match(models, /fallbackText: fallback\.isEmpty \? SecretaryChatMessageFallback\.attachmentText/u);
});

test("attachment send goes through the ordinary mailbox path", async () => {
  const store = await fs.readFile(path.join(nativeRoot, "SecretaryChatStore.swift"), "utf8");
  assert.match(store, /shouldUseMailbox\(for:/u);
});
