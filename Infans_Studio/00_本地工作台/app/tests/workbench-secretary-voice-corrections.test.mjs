import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSecretaryVoiceCorrectionService } from "../src/server/workbench-secretary-voice-corrections.mjs";

function fixture() {
  return {
    id: "native_yingning_default",
    title: "银月",
    indexPolicy: "never",
    chatState: { privacy: "private" },
    messages: [{
      id: "msg-ios_12345678",
      role: "user",
      content: "",
      attachments: [{
        id: "ios_12345678",
        kind: "audio",
        name: "语音 · 0:04",
        mime: "audio/mp4",
        transcript: "一年帮我记一下",
      }],
    }],
  };
}

test("voice correction keeps context, shares hints, deduplicates, and can be reverted", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-voice-correction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let chat = fixture();
  let nowIndex = 0;
  const service = createSecretaryVoiceCorrectionService(root, {
    directory: path.join(root, "private-corrections"),
    now: () => new Date(Date.UTC(2026, 8, 4, 0, 0, nowIndex++)),
    readChat: async () => structuredClone(chat),
    saveChat: async (_root, payload) => {
      chat = structuredClone(payload);
      return structuredClone(chat);
    },
  });
  const payload = {
    correctionId: "voicefix_0123456789abcdef0123456789abcdef",
    conversationId: chat.id,
    messageId: "msg-ios_12345678",
    attachmentId: "ios_12345678",
    expectedTranscript: "一年帮我记一下",
    prefix: "",
    selectedOriginal: "一年",
    replacement: "银月",
    suffix: "帮我记一下",
  };

  const applied = await service.apply(payload);
  assert.equal(applied.duplicate, false);
  assert.equal(applied.transcript, "银月帮我记一下");
  assert.equal(chat.messages[0].attachments[0].transcript, "银月帮我记一下");

  const duplicate = await service.apply(payload);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await service.list()).hints[0], "银月");

  const reverted = await service.revert(payload.correctionId);
  assert.equal(reverted.duplicate, false);
  assert.equal(chat.messages[0].attachments[0].transcript, "一年帮我记一下");
  assert.deepEqual((await service.list()).hints, []);

  const duplicateRevert = await service.revert(payload.correctionId);
  assert.equal(duplicateRevert.duplicate, true);

  const duplicateAfterRevert = await service.apply(payload);
  assert.equal(duplicateAfterRevert.duplicate, true);
  assert.equal(duplicateAfterRevert.transcript, "一年帮我记一下");
  assert.equal(chat.messages[0].attachments[0].transcript, "一年帮我记一下");
});

test("voice correction rejects a stale selection without changing the chat", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-voice-correction-stale-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chat = fixture();
  const service = createSecretaryVoiceCorrectionService(root, {
    directory: path.join(root, "private-corrections"),
    readChat: async () => structuredClone(chat),
    saveChat: async () => assert.fail("stale correction must not save"),
  });

  await assert.rejects(
    service.apply({
      conversationId: chat.id,
      messageId: "msg-ios_12345678",
      attachmentId: "ios_12345678",
      expectedTranscript: "莹莹帮我记一下",
      prefix: "",
      selectedOriginal: "莹莹",
      replacement: "银月",
      suffix: "帮我记一下",
    }),
    (error) => error?.code === "VOICE_TRANSCRIPT_CHANGED" && error?.status === 409,
  );
  assert.equal(chat.messages[0].attachments[0].transcript, "一年帮我记一下");
});

test("whole-transcript editing derives the corrected span and supports a NAS voice source", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-voice-correction-mailbox-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let chat = {
    id: "native_yingning_default",
    title: "银月",
    indexPolicy: "never",
    chatState: { privacy: "private" },
    messages: [{
      id: "msg-ios_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      role: "user",
      content: "莹莹帮我记一下",
      voiceSources: [{
        id: "ios_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        mime: "audio/mp4",
        durationMs: 5_000,
        transcript: "莹莹帮我记一下",
      }],
    }],
  };
  const service = createSecretaryVoiceCorrectionService(root, {
    directory: path.join(root, "private-corrections"),
    readChat: async () => structuredClone(chat),
    saveChat: async (_root, payload) => {
      chat = structuredClone(payload);
      return structuredClone(chat);
    },
  });

  const applied = await service.apply({
    correctionId: "voicefix_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    conversationId: chat.id,
    messageId: chat.messages[0].id,
    attachmentId: chat.messages[0].voiceSources[0].id,
    expectedTranscript: "莹莹帮我记一下",
    correctedTranscript: "银月帮我记一下",
  });

  assert.equal(applied.transcript, "银月帮我记一下");
  assert.equal(applied.correction.selectedOriginal, "莹莹");
  assert.equal(applied.correction.replacement, "银月");
  assert.equal(applied.correction.prefix, "");
  assert.equal(applied.correction.suffix, "帮我记一下");
  assert.equal(chat.messages[0].content, "银月帮我记一下");
  assert.equal(chat.messages[0].voiceSources[0].transcript, "银月帮我记一下");
  assert.deepEqual((await service.list()).hints, ["银月"]);
});

test("whole-transcript editing repairs a voice message archived before voiceSources existed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-voice-correction-legacy-mailbox-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let chat = {
    id: "native_yingning_default",
    title: "银月",
    indexPolicy: "never",
    chatState: { privacy: "private" },
    messages: [{
      id: "msg-ios_11111111-2222-4333-8444-555555555555",
      role: "user",
      content: "一年帮我记一下",
      attachments: [],
    }],
  };
  const service = createSecretaryVoiceCorrectionService(root, {
    directory: path.join(root, "private-corrections"),
    readChat: async () => structuredClone(chat),
    saveChat: async (_root, payload) => {
      chat = structuredClone(payload);
      return structuredClone(chat);
    },
  });

  const result = await service.apply({
    conversationId: chat.id,
    messageId: "msg-ios_11111111-2222-4333-8444-555555555555",
    attachmentId: "ios_11111111-2222-4333-8444-555555555555",
    expectedTranscript: "一年帮我记一下",
    correctedTranscript: "银月帮我记一下",
  });

  assert.equal(result.transcript, "银月帮我记一下");
  assert.equal(chat.messages[0].content, "银月帮我记一下");
});
