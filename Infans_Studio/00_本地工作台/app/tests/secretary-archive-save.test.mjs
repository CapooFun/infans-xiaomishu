import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { archiveMessageSnapshot, saveCurrentArchiveSnapshot } from "../src/secretary-archive-save.ts";
import { createPublicThreadBuffer } from "../src/opensource-thread-buffer.mjs";

test("a queued save cannot borrow a newer version or cross into another conversation", async () => {
  for (const next of [
    { id: "chat-a", version: "new", epoch: 1 },
    { id: "chat-b", version: "old", epoch: 2 },
    { id: "chat-a", version: "old", epoch: 3 },
  ]) {
    const captured = { id: "chat-a", version: "old", epoch: 1 };
    let current = captured;
    let finish;
    const previous = new Promise((resolve) => { finish = resolve; });
    let posts = 0;
    const result = saveCurrentArchiveSnapshot(captured, () => current, previous, async () => { posts += 1; return true; });
    current = next;
    finish(true);
    assert.equal(await result, undefined);
    assert.equal(posts, 0);
  }
});

test("an unchanged queued identity saves its captured payload, and prior failure stops it", async () => {
  const captured = { id: "chat-a", version: "v1", epoch: 1 };
  let posts = 0;
  assert.equal(await saveCurrentArchiveSnapshot(captured, () => captured, Promise.resolve(true), async () => ++posts), 1);
  assert.equal(await saveCurrentArchiveSnapshot(captured, () => captured, Promise.resolve(false), async () => ++posts), undefined);
  assert.equal(posts, 1);
});

test("save-as-new message serialization retains native timestamps, voice origins, attachments and full text", () => {
  const original = {
    id: "u1", role: "user", content: "原文".repeat(15000), createdAt: "2026-09-05T01:00:00Z",
    voiceSources: [{ id: "voice-1", mime: "audio/mp4", transcript: "测试转写", durationMs: 1200 }],
    attachments: [{ id: "file-1", name: "test.txt", kind: "file", mime: "text/plain" }],
  };
  assert.deepEqual(archiveMessageSnapshot(original), original);
  const unknown = archiveMessageSnapshot({ ...original, privateExtra: "omit", voiceSources: [{ ...original.voiceSources[0], arbitrary: "omit" }], attachments: [{ ...original.attachments[0], arbitrary: "omit" }] });
  assert.deepEqual(unknown, original);
});

// Execute the actual component's cache and privacy-hide functions without mounting its visual tree.
const source = await fs.readFile(new URL("../src/shell/WorkbenchOverlays.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("WorkbenchOverlays.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const js = (text) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function realCache() {
  const values = new Map();
  let full = false;
  const storage = {
    getItem: (key) => values.get(key) || null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => { if (full) throw new Error("quota"); values.set(key, value); },
  };
  const buffer = createPublicThreadBuffer({
    storage,
    fetchHealth: async () => ({ ok: true, json: async () => ({ instanceId: "cache" }) }),
  });
  return {
    values,
    exhaust: () => { full = true; },
    async ready() {
      await buffer.bind();
      buffer.markReady();
    },
    persist(session) {
      return buffer.persist(session, "yinyue").ok === true;
    },
    load() {
      return buffer.load("yinyue");
    },
  };
}

test("the real session cache restores 1000 messages, conflict/version and native origins without exposing a private overlay", async () => {
  const cache = realCache();
  await cache.ready();
  const messages = Array.from({ length: 1000 }, (_, index) => ({ id: `u${index}`, role: "user", content: index ? `消息${index}` : "原文".repeat(15000), createdAt: "2026-09-05T01:00:00Z", voiceSources: [{ id: `voice-${index}`, transcript: "测试" }] }));
  assert.equal(cache.persist({ messages, archiveId: "chat-a", title: "会话", archiveVersion: "v1", saveConflict: true }), true);
  const restored = cache.load();
  assert.equal(restored.messages.length, 1000);
  assert.equal(restored.messages[0].content, messages[0].content);
  assert.equal(restored.messages[0].voiceSources[0].id, "voice-0");
  assert.equal(restored.archiveVersion, "v1");
  assert.equal(restored.saveConflict, true);
  assert.match(source, /useState<AiThreadMessage\[\]>\(\(\) => initialSession\.messages\)/);
  assert.match(source, /if \(displayModeHidesCurrent\) return null/);
  assert.doesNotMatch(source, /function persistAiSession/);
  assert.equal(cache.persist({
    messages: restored.messages,
    archiveId: restored.archiveId,
    title: restored.title,
    archiveVersion: restored.archiveVersion,
    saveConflict: restored.saveConflict,
  }), true);
  const remounted = cache.load();
  assert.equal(remounted.messages.length, 1000);
  assert.equal(remounted.messages[0].content, messages[0].content);
  assert.equal(remounted.saveConflict, true);
  assert.equal(remounted.archiveVersion, "v1");
  const instanceKey = [...cache.values.keys()][0];
  const before = cache.values.get(instanceKey);
  cache.exhaust();
  assert.equal(cache.persist({ messages: [], archiveId: null, title: "" }), false);
  assert.equal(cache.values.get(instanceKey), before);
});

let hideSource = "";
function locateHide(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "hidePrivateConversation") hideSource = node.initializer.getText(ast);
  ts.forEachChild(node, locateHide);
}
locateHide(ast);

test("the actual privacy hide workflow preserves failed drafts and never closes their only in-memory copy", async () => {
  assert.ok(hideSource);
  for (const buffered of [true, false]) {
    const messages = [{ id: "u1", role: "user", content: "未保存测试" }];
    let closes = 0;
    const hide = vm.runInNewContext(js(`(${hideSource});`), {
      currentArchiveSnapshot: () => ({ id: "chat-a", version: "old", epoch: 1 }),
      messages, saveChat: async () => false, cancelled: false,
      archiveEpochRef: { current: 1 },
      persistCurrentSessionRef: { current: () => buffered },
      onClose: () => { closes += 1; },
      resetConversationInMemory: () => { throw new Error("must not discard failed draft"); },
    });
    await hide();
    assert.equal(closes, buffered ? 1 : 0);
    assert.equal(messages[0].content, "未保存测试");
  }
});
