import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  SECRETARY_CHAT_DIR_RELATIVE,
  deleteSecretaryChat,
  listIndexableSecretaryChats,
  listSecretaryChats,
  normalizeSecretaryChatState,
  readSecretaryChat,
  renameSecretaryChat,
  saveSecretaryChat,
} from "../src/server/workbench-secretary-chats.mjs";
import { saveSecretaryAttachment } from "../src/server/workbench-secretary-attachments.mjs";

function fakeRequest(body, headers = {}) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.headers = headers;
  return stream;
}

test("saveSecretaryChat writes a plaintext archive and list/read round-trip", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-"));
  const saved = await saveSecretaryChat(root, {
    chatState: {
      activeSecretaryId: "yinyue",
    },
    messages: [
      { id: "u1", role: "user", content: "公子想听日语。" },
      { id: "a1", role: "assistant", content: "好呀，人家陪你念。" },
    ],
  });
  assert.match(saved.path, /派生数据\/secretary-runtime\/chats/);
  assert.equal(saved.messageCount, 2);

  const absolute = path.join(root, saved.path);
  const disk = JSON.parse(await fs.readFile(absolute, "utf8"));
  assert.equal(disk.messages[0].content, "公子想听日语。");
  assert.equal(disk.privacyClass, "standard");
  assert.equal(disk.indexPolicy, "allow");
  assert.deepEqual(Object.keys(disk.chatState).sort(), ["activeSecretaryId", "cursorModel", "ordinaryBackend", "privacy"]);
  assert.match(saved.id, /^chat_[a-f0-9]{32}$/);
  assert.match(saved.path, /\.json$/);

  const listed = await listSecretaryChats(root);
  assert.equal(listed.dir, SECRETARY_CHAT_DIR_RELATIVE);
  assert.match(listed.dir, /派生数据\/secretary-runtime\/chats/);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, saved.id);

  const loaded = await readSecretaryChat(root, saved.id);
  assert.equal(loaded.messages[0].content, "公子想听日语。");
  assert.equal(loaded.messages[1].role, "assistant");
  assert.deepEqual(Object.keys(loaded.chatState).sort(), ["activeSecretaryId", "cursorModel", "ordinaryBackend", "privacy"]);
  assert.doesNotMatch(JSON.stringify(listed), /窗边的测试记忆/);
  assert.equal(listed.items[0].private, false);
  assert.equal((await listIndexableSecretaryChats(root)).items.length, 1);
  assert.equal((await fs.stat(path.dirname(absolute))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(absolute)).mode & 0o777, 0o600);
});

test("聊天存档只保留值班小秘书", () => {
  const state = normalizeSecretaryChatState({
    activeSecretaryId: "yinyue",
    leftoverSeat: true,
  });
  assert.equal(state.activeSecretaryId, "yinyue");
  assert.deepEqual(Object.keys(state).sort(), ["activeSecretaryId", "cursorModel", "ordinaryBackend", "privacy"]);
});

test("多余会话字段不会改变一对一存档", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-one-on-one-"));
  const saved = await saveSecretaryChat(root, {
    chatState: { leftoverSeat: true },
    messages: [{ role: "user", content: "只和梅凝聊" }],
  });
  const loaded = await readSecretaryChat(root, saved.id);
  assert.deepEqual(Object.keys(loaded.chatState).sort(), ["activeSecretaryId", "cursorModel", "ordinaryBackend", "privacy"]);
});

test("私密会话不会写入公开存档", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-private-sticky-"));
  await assert.rejects(
    () => saveSecretaryChat(root, {
      privacy: "private",
      messages: [
        { role: "user", content: "进入这次见面" },
        { role: "assistant", speaker: "yinyue", content: "好。" },
      ],
    }),
    (error) => error?.code === "CHAT_PRIVACY_REJECTED" && error?.status === 403,
  );
});

test("scene memory is bounded before it enters plaintext chat content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-scene-memory-"));
  const saved = await saveSecretaryChat(root, {
    chatState: { sceneMemory: `  ${"记".repeat(1700)}  ` },
    messages: [
      { id: "u1", role: "user", content: "继续。" },
      { id: "a1", role: "assistant", content: "好。" },
    ],
  });
  const loaded = await readSecretaryChat(root, saved.id);
  assert.equal(loaded.chatState.sceneMemory, undefined);
  assert.equal(loaded.chatState.activeSecretaryId, "yinyue");
});

test("all chats are indexable one-on-one archives", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-index-policy-"));
  const standard = await saveSecretaryChat(root, {
    messages: [{ role: "user", content: "可以进普通上下文" }],
  });
  await assert.rejects(
    () => saveSecretaryChat(root, {
      indexPolicy: "never",
      messages: [{ role: "user", content: "明文但禁止进普通上下文" }],
    }),
    (error) => error?.code === "CHAT_PRIVACY_REJECTED",
  );
  await assert.rejects(
    () => saveSecretaryChat(root, {
      privacy: "private",
      messages: [{ role: "user", content: "私密会话永不进普通上下文" }],
    }),
    (error) => error?.code === "CHAT_PRIVACY_REJECTED",
  );

  const indexable = await listIndexableSecretaryChats(root);
  assert.equal(indexable.items.length, 1);
  assert.equal(indexable.items[0].id, standard.id);
  assert.equal((await readSecretaryChat(root, standard.id)).indexPolicy, "allow");
});

test("saveSecretaryChat round-trips one-on-one state only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-style-"));
  const saved = await saveSecretaryChat(root, {
    chatState: {
      activeSecretaryId: "yinyue",
      leftoverStyle: { basePreset: "normal" },
    },
    messages: [
      { id: "u1", role: "user", content: "继续聊。" },
      { id: "a1", role: "assistant", speaker: "yinyue", content: "我在。" },
    ],
  });
  const loaded = await readSecretaryChat(root, saved.id);
  assert.equal(loaded.chatState.activeSecretaryId, "yinyue");
  assert.deepEqual(Object.keys(loaded.chatState).sort(), ["activeSecretaryId", "cursorModel", "ordinaryBackend", "privacy"]);
});

test("private chat lists and reads with a neutral title and hidden preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-private-summary-"));
  await assert.rejects(
    () => saveSecretaryChat(root, {
      title: "不应出现在列表里的标题",
      privacy: "private",
      messages: [
        { id: "u1", role: "user", content: "不应出现在列表里的正文" },
        { id: "a1", role: "assistant", speaker: "yinyue", content: "回复" },
      ],
    }),
    (error) => error?.code === "CHAT_PRIVACY_REJECTED",
  );
  const saved = await saveSecretaryChat(root, {
    title: "普通一对一标题",
    messages: [
      { id: "u1", role: "user", content: "普通一对一正文" },
      { id: "a1", role: "assistant", speaker: "yinyue", content: "回复" },
    ],
  });
  const listed = await listSecretaryChats(root);
  assert.equal(listed.items[0].id, saved.id);
  assert.equal(listed.items[0].private, false);
  assert.match(listed.items[0].preview, /普通一对一正文/);
});

test("saveSecretaryChat preserves all 1000 messages and long original text on disk and after rename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-long-"));
  const messages = Array.from({ length: 1000 }, (_, index) => ({
    id: `u${index}`,
    role: "user",
    content: index === 0 ? `  ${"长文🌿".repeat(6000)}\n原文末尾  ` : `消息${index}`,
  }));
  const saved = await saveSecretaryChat(root, {
    messages,
  });
  const absolute = path.join(root, saved.path);
  const beforeRead = await fs.readFile(absolute, "utf8");
  assert.deepEqual(JSON.parse(beforeRead).messages, messages);
  const loaded = await readSecretaryChat(root, saved.id);
  assert.deepEqual(loaded.messages, messages);
  assert.equal(await fs.readFile(absolute, "utf8"), beforeRead);
  assert.equal(loaded.archiveVersion, saved.archiveVersion);
  await renameSecretaryChat(root, saved.id, "长会话测试");
  assert.deepEqual(JSON.parse(await fs.readFile(absolute, "utf8")).messages, messages);
  await saveSecretaryChat(root, { id: saved.id, title: "仅修改标题" });
  assert.deepEqual((await readSecretaryChat(root, saved.id)).messages, messages);
});

test("GET and rename preserve a pre-existing archive beyond the former limits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-existing-long-"));
  const saved = await saveSecretaryChat(root, { messages: [{ id: "u1", role: "user", content: "基线" }] });
  const absolute = path.join(root, saved.path);
  const legacy = JSON.parse(await fs.readFile(absolute, "utf8"));
  legacy.messages = Array.from({ length: 1000 }, (_, index) => ({ id: `old-${index}`, role: "user", content: index === 0 ? "原".repeat(21000) : `旧消息${index}` }));
  const bytes = `${JSON.stringify(legacy)}\n`;
  await fs.writeFile(absolute, bytes);
  assert.deepEqual((await readSecretaryChat(root, saved.id)).messages, legacy.messages);
  assert.equal(await fs.readFile(absolute, "utf8"), bytes);
  await renameSecretaryChat(root, saved.id, "旧会话改名");
  assert.deepEqual(JSON.parse(await fs.readFile(absolute, "utf8")).messages, legacy.messages);
});

test("same-ID original edits require the current archive version and stale snapshots cannot overwrite them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-version-"));
  const messages = [{ id: "a1", role: "assistant", speaker: "yinyue", content: "旧正文" }];
  const first = await saveSecretaryChat(root, { messages });
  const changed = { id: first.id, messages: [{ ...messages[0], content: "修改后的正文" }] };
  await assert.rejects(saveSecretaryChat(root, changed), (error) => error.status === 409 && error.code === "CHAT_MESSAGE_CONFLICT");
  const updated = await saveSecretaryChat(root, { ...changed, expectedArchiveVersion: first.archiveVersion });
  assert.notEqual(updated.archiveVersion, first.archiveVersion);
  const absolute = path.join(root, updated.path);
  const before = await fs.readFile(absolute, "utf8");
  await assert.rejects(saveSecretaryChat(root, { id: first.id, messages }), (error) => error.code === "CHAT_MESSAGE_CONFLICT");
  await assert.rejects(saveSecretaryChat(root, { id: first.id, messages, expectedArchiveVersion: first.archiveVersion }), (error) => error.code === "CHAT_VERSION_CONFLICT");
  assert.equal(await fs.readFile(absolute, "utf8"), before);
  // A deliberate shorter edit is valid too: freshness is proven by the version, never text length.
  const shorter = await saveSecretaryChat(root, { ...changed, expectedArchiveVersion: updated.archiveVersion, messages: [{ ...messages[0], content: "短" }] });
  assert.equal((await readSecretaryChat(root, first.id)).messages[0].content, "短");
  const replay = await saveSecretaryChat(root, { id: first.id, messages: [{ ...messages[0], content: "短" }] });
  assert.equal(replay.archiveVersion, shorter.archiveVersion);
});

test("legacy metadata refresh preserves attachment originals and does not require a content edit version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-metadata-"));
  const attachment = await saveSecretaryAttachment(root, fakeRequest("synthetic file", { "content-type": "text/plain", "x-infans-filename": "test.txt" }));
  const messages = [{ id: "u1", role: "user", content: "附件测试", attachments: [{ id: attachment.id, kind: "file", name: "test.txt", mime: "text/plain", url: "/old-url" }] }];
  const saved = await saveSecretaryChat(root, { messages });
  await saveSecretaryChat(root, { id: saved.id, messages: [{ ...messages[0], attachments: [{ ...messages[0].attachments[0], url: "/new-url", name: "刷新显示名" }] }] });
  const loaded = await readSecretaryChat(root, saved.id);
  assert.equal(loaded.messages[0].content, messages[0].content);
  assert.equal(loaded.messages[0].attachments[0].id, attachment.id);
  assert.equal(loaded.messages[0].attachments[0].url, "/new-url");
});

test("web snapshots that omit native original metadata preserve voice sources and timestamps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-web-native-metadata-"));
  const voiceSources = [{ id: "native_voice_00000001", mime: "audio/mp4", transcript: "测试转写", durationMs: 1200 }];
  const saved = await saveSecretaryChat(root, { messages: [{ id: "u1", role: "user", content: "语音测试", createdAt: "2026-09-05T01:00:00Z", voiceSources }] });
  await saveSecretaryChat(root, { id: saved.id, expectedArchiveVersion: saved.archiveVersion, messages: [{ id: "u1", role: "user", content: "语音测试" }] });
  const loaded = await readSecretaryChat(root, saved.id);
  assert.deepEqual(loaded.messages[0].voiceSources, voiceSources);
  assert.equal(loaded.messages[0].createdAt, "2026-09-05T01:00:00.000Z");
});

test("archive input rejects malformed messages and duplicate IDs without replacing the existing document", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-invalid-"));
  const saved = await saveSecretaryChat(root, { messages: [{ id: "u1", role: "user", content: "有效消息" }] });
  const absolute = path.join(root, saved.path);
  const before = await fs.readFile(absolute, "utf8");
  for (const messages of [
    {}, [{ id: "u1", role: "system", content: "非法角色" }], [{ id: "u1", role: "user", content: 123 }],
    [{ id: "u1", role: "user", content: "一" }, { id: "u1", role: "user", content: "二" }],
  ]) {
    await assert.rejects(saveSecretaryChat(root, { id: saved.id, messages, expectedArchiveVersion: saved.archiveVersion }), (error) => error.status === 400);
    assert.equal(await fs.readFile(absolute, "utf8"), before);
  }
});

test("saveSecretaryChat rejects empty thread", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-empty-"));
  await assert.rejects(() => saveSecretaryChat(root, { messages: [] }), /没有可保存/);
});

test("saveSecretaryChat rejects an explicit unknown assistant speaker instead of relabeling it as 梅凝", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-unknown-speaker-"));
  await assert.rejects(
    () => saveSecretaryChat(root, { messages: [{ role: "assistant", speaker: "nangongwan", content: "不应保存" }] }),
    (error) => error?.code === "INVALID_CHAT_SPEAKER",
  );
});

test("saveSecretaryChat with same id overwrites instead of duplicating", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-overwrite-"));
  const first = await saveSecretaryChat(root, {
    messages: [
      { id: "u1", role: "user", content: "续写测试" },
      { id: "a1", role: "assistant", content: "第一版" },
    ],
  });
  const second = await saveSecretaryChat(root, {
    id: first.id,
    title: "续写测试",
    messages: [
      { id: "u1", role: "user", content: "续写测试" },
      { id: "a1", role: "assistant", content: "第一版" },
      { id: "u2", role: "user", content: "再问一句" },
      { id: "a2", role: "assistant", content: "第二版" },
    ],
  });
  assert.equal(second.id, first.id);
  const listed = await listSecretaryChats(root);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].messageCount, 4);
});

test("a stale web autosave preserves messages already persisted by another client", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-stale-client-"));
  const first = await saveSecretaryChat(root, {
    id: "cross_device_chat",
    messages: [
      { id: "u-web-1", role: "user", content: "网页第一轮" },
      { id: "a-web-1", role: "assistant", speaker: "yinyue", content: "网页回复" },
    ],
  });
  await saveSecretaryChat(root, {
    id: first.id,
    messages: [
      { id: "u-web-1", role: "user", content: "网页第一轮" },
      { id: "a-web-1", role: "assistant", speaker: "yinyue", content: "网页回复" },
      { id: "u-native-1", role: "user", content: "原生消息" },
    ],
  });
  await saveSecretaryChat(root, {
    id: first.id,
    // 模拟网页仍拿着没有 u-native-1 的旧快照，随后又产生一轮消息。
    messages: [
      { id: "u-web-1", role: "user", content: "网页第一轮" },
      { id: "a-web-1", role: "assistant", speaker: "yinyue", content: "网页回复" },
      { id: "u-web-2", role: "user", content: "网页第二轮" },
      { id: "a-web-2", role: "assistant", speaker: "yinyue", content: "网页第二次回复" },
    ],
  });
  const loaded = await readSecretaryChat(root, first.id);
  assert.deepEqual(loaded.messages.map((item) => item.id), [
    "u-web-1",
    "a-web-1",
    "u-native-1",
    "u-web-2",
    "a-web-2",
  ]);
});

test("overlapping saves for the same chat reject one writer instead of silently overwriting it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-concurrent-save-"));
  const first = await saveSecretaryChat(root, {
    messages: [
      { id: "u1", role: "user", content: "并发保存基线" },
      { id: "a1", role: "assistant", content: "基线回复" },
    ],
  });
  const version = (label) => ({
    id: first.id,
    messages: [
      { id: "u1", role: "user", content: "并发保存基线" },
      { id: "a1", role: "assistant", content: "基线回复" },
      { id: `u-${label}`, role: "user", content: `写入${label}` },
      { id: `a-${label}`, role: "assistant", content: `回复${label}` },
    ],
  });

  // 同一个 event-loop turn 发起，不靠人工 sleep 制造时序。
  const results = await Promise.allSettled([
    saveSecretaryChat(root, version("甲")),
    saveSecretaryChat(root, version("乙")),
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find((item) => item.status === "rejected");
  assert.equal(rejected.reason?.status, 409);
  assert.equal(rejected.reason?.code, "CHAT_WRITE_CONFLICT");

  const loaded = await readSecretaryChat(root, first.id);
  assert.equal(loaded.messages.length, 4);
  assert.equal(loaded.messages.at(-1)?.content, "回复甲");
  assert.equal((await listSecretaryChats(root)).items.length, 1);
});

test("renameSecretaryChat updates title without changing id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-rename-"));
  const saved = await saveSecretaryChat(root, {
    messages: [
      { id: "u1", role: "user", content: "原来的长标题请改短" },
      { id: "a1", role: "assistant", content: "好" },
    ],
  });
  const renamed = await renameSecretaryChat(root, saved.id, "资产短聊");
  assert.equal(renamed.id, saved.id);
  assert.equal(renamed.title, "资产短聊");
  const listed = await listSecretaryChats(root);
  assert.equal(listed.items[0].title, "资产短聊");
});

test("version-checked rename returns a version for continued saves and rejects stale rename without writing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-rename-version-"));
  const messages = [{ id: "u1", role: "user", content: "保留原文" }];
  const saved = await saveSecretaryChat(root, { messages });
  const renamed = await renameSecretaryChat(root, saved.id, "新标题", { expectedArchiveVersion: saved.archiveVersion });
  assert.notEqual(renamed.archiveVersion, saved.archiveVersion);
  const continued = await saveSecretaryChat(root, {
    id: saved.id,
    expectedArchiveVersion: renamed.archiveVersion,
    messages: [...messages, { id: "u2", role: "user", content: "继续聊天" }],
  });
  const absolute = path.join(root, saved.path);
  const before = await fs.readFile(absolute, "utf8");
  await assert.rejects(renameSecretaryChat(root, saved.id, "旧快照改名", { expectedArchiveVersion: renamed.archiveVersion }), (error) => error.status === 409 && error.code === "CHAT_VERSION_CONFLICT");
  assert.equal(await fs.readFile(absolute, "utf8"), before);
  assert.equal((await readSecretaryChat(root, saved.id)).archiveVersion, continued.archiveVersion);
  const legacyRenamed = await renameSecretaryChat(root, saved.id, "兼容旧调用");
  assert.equal(legacyRenamed.id, saved.id);
  assert.deepEqual((await readSecretaryChat(root, saved.id)).messages, JSON.parse(before).messages);
});

test("deleteSecretaryChat removes chat and unreferenced attachments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-delete-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const attachment = await saveSecretaryAttachment(root, fakeRequest(png, {
    "content-type": "image/png",
    "x-infans-filename": encodeURIComponent("测.png"),
  }));
  const saved = await saveSecretaryChat(root, {
    messages: [
      {
        id: "u1",
        role: "user",
        content: "看图",
        attachments: [{ id: attachment.id, kind: "image", name: "测.png", mime: "image/png", url: attachment.url, path: attachment.path }],
      },
      { id: "a1", role: "assistant", content: "看到了" },
    ],
  });

  const result = await deleteSecretaryChat(root, saved.id);
  assert.equal(result.deleted, true);
  assert.deepEqual(result.removedAttachments, [attachment.id]);

  const listed = await listSecretaryChats(root);
  assert.equal(listed.items.length, 0);

  await assert.rejects(
    () => fs.access(path.join(root, attachment.path)),
    (error) => error?.code === "ENOENT",
  );
});

test("deleteSecretaryChat keeps attachments still used by another chat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-keep-attach-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const attachment = await saveSecretaryAttachment(root, fakeRequest(png, {
    "content-type": "image/png",
    "x-infans-filename": encodeURIComponent("共享.png"),
  }));
  const attachMeta = [{ id: attachment.id, kind: "image", name: "共享.png", mime: "image/png", url: attachment.url, path: attachment.path }];
  const first = await saveSecretaryChat(root, {
    messages: [
      { id: "u1", role: "user", content: "第一份", attachments: attachMeta },
      { id: "a1", role: "assistant", content: "收到" },
    ],
  });
  await saveSecretaryChat(root, {
    messages: [
      { id: "u1", role: "user", content: "第二份也引用", attachments: attachMeta },
      { id: "a1", role: "assistant", content: "也收到" },
    ],
  });

  const result = await deleteSecretaryChat(root, first.id);
  assert.equal(result.deleted, true);
  assert.deepEqual(result.removedAttachments, []);
  await fs.access(path.join(root, attachment.path));
});

test("attachment GC followed by a queued chat save rejects the now-dangling reference", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-gc-before-save-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const attachment = await saveSecretaryAttachment(root, fakeRequest(png, {
    "content-type": "image/png",
    "x-infans-filename": encodeURIComponent("竞争.png"),
  }));
  const attachMeta = [{ id: attachment.id, kind: "image", name: "竞争.png", mime: "image/png", url: attachment.url, path: attachment.path }];
  const owner = await saveSecretaryChat(root, {
    messages: [
      { id: "u1", role: "user", content: "原会话", attachments: attachMeta },
      { id: "a1", role: "assistant", content: "收到" },
    ],
  });

  const [deleted, queuedSave] = await Promise.allSettled([
    deleteSecretaryChat(root, owner.id),
    saveSecretaryChat(root, {
      messages: [
        { id: "u2", role: "user", content: "稍后才引用", attachments: attachMeta },
        { id: "a2", role: "assistant", content: "不应落盘" },
      ],
    }),
  ]);
  assert.equal(deleted.status, "fulfilled");
  assert.deepEqual(deleted.value.removedAttachments, [attachment.id]);
  assert.equal(queuedSave.status, "rejected");
  assert.equal(queuedSave.reason?.code, "ATTACHMENT_NOT_FOUND");
  assert.equal((await listSecretaryChats(root)).items.length, 0);
  await assert.rejects(() => fs.access(path.join(root, attachment.path)), (error) => error?.code === "ENOENT");
});

test("a queued chat delete sees an earlier save and preserves its shared attachment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-save-before-gc-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const attachment = await saveSecretaryAttachment(root, fakeRequest(png, {
    "content-type": "image/png",
    "x-infans-filename": encodeURIComponent("共享竞争.png"),
  }));
  const attachMeta = [{ id: attachment.id, kind: "image", name: "共享竞争.png", mime: "image/png", url: attachment.url, path: attachment.path }];
  const owner = await saveSecretaryChat(root, {
    messages: [
      { id: "u1", role: "user", content: "原会话", attachments: attachMeta },
      { id: "a1", role: "assistant", content: "收到" },
    ],
  });

  const [saved, deleted] = await Promise.all([
    saveSecretaryChat(root, {
      messages: [
        { id: "u2", role: "user", content: "先引用", attachments: attachMeta },
        { id: "a2", role: "assistant", content: "已保存" },
      ],
    }),
    deleteSecretaryChat(root, owner.id),
  ]);
  assert.deepEqual(deleted.removedAttachments, []);
  const loaded = await readSecretaryChat(root, saved.id);
  assert.equal(loaded.messages[0].attachments[0].id, attachment.id);
  await fs.access(path.join(root, attachment.path));
});

test("attachment GC fails closed when another chat cannot be inspected", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-chats-gc-fail-closed-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const attachment = await saveSecretaryAttachment(root, fakeRequest(png, {
    "content-type": "image/png",
    "x-infans-filename": encodeURIComponent("保留.png"),
  }));
  const owner = await saveSecretaryChat(root, {
    messages: [
      {
        id: "u1",
        role: "user",
        content: "不能误删",
        attachments: [{ id: attachment.id, kind: "image", name: "保留.png", mime: "image/png", url: attachment.url, path: attachment.path }],
      },
      { id: "a1", role: "assistant", content: "收到" },
    ],
  });
  const badId = `chat_${"f".repeat(32)}`;
  const chatDir = path.join(root, SECRETARY_CHAT_DIR_RELATIVE);
  await fs.writeFile(path.join(chatDir, `${badId}.json`), "broken plaintext chat");

  const deleted = await deleteSecretaryChat(root, owner.id);
  assert.deepEqual(deleted.removedAttachments, []);
  assert.equal(deleted.attachmentCleanupDeferred, true);
  await fs.access(path.join(root, attachment.path));
});
