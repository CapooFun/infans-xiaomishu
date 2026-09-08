import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSecretaryMailboxService, SECRETARY_MAILBOX_RETENTION_MS } from "../src/server/workbench-secretary-mailbox.mjs";

function message(overrides = {}) {
  return {
    protocolVersion: 1,
    conversationId: "native_yingning_default",
    messageId: "msg-11111111-2222-4333-8444-555555555555",
    generationId: "gen-11111111-2222-4333-8444-555555555555",
    createdAt: "2026-09-04T14:00:00.000Z",
    text: "今天想早点休息。",
    expectedConversationVersion: "v1",
    attachments: [],
    ...overrides,
  };
}

function intake(overrides = {}) {
  const data = Buffer.from("nas-original-photo");
  return {
    schemaVersion: 2,
    intakeId: "72742e43-35ed-4c3e-8e65-753ce8dc7f42",
    url: "", title: "", text: "", note: "晚上整理",
    source: "ios_quick_photo", sourceSemantic: "quick_photo_inbox", sourceApp: "小秘书",
    deviceId: "capoo-iphone", deviceName: "iPhone", createdAt: "2026-09-05T03:00:00.000Z",
    attachments: [{
      attachmentId: "8d55b9db-1dd3-4d75-a644-2fe8951cd1a6", role: "original", fileName: "IMG_0001.HEIC",
      contentType: "image/heic", byteCount: data.length, pixelWidth: 4032, pixelHeight: 3024,
      createdAt: "2026-09-05T03:00:00.000Z", sha256: crypto.createHash("sha256").update(data).digest("hex"), data: data.toString("base64"),
    }],
    ...overrides,
  };
}

test("mailbox defaults to the workbench derived-data directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-mailbox-path-"));
  const service = createSecretaryMailboxService(root);
  assert.equal(
    service.statePath,
    path.join(root, "00_本地工作台", "派生数据", "secretary-runtime", "mailbox", "secretary-mailbox.v1.json"),
  );
  assert.equal(service.statePath.startsWith(path.join(root, "派生数据")), false);
});

test("mailbox persists a stable message for 24 hours and retries idempotently", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-mailbox-"));
  let now = Date.parse("2026-09-04T14:00:01.000Z");
  const service = createSecretaryMailboxService(root, { now: () => now });
  const first = await service.accept(message());
  const duplicate = await service.accept(message());
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(Date.parse(first.message.expiresAt) - now, SECRETARY_MAILBOX_RETENTION_MS);

  const reloaded = createSecretaryMailboxService(root, { now: () => now });
  const snapshot = await reloaded.sync({ conversationId: message().conversationId });
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].messageId, message().messageId);

  now += SECRETARY_MAILBOX_RETENTION_MS;
  const expired = await reloaded.sync({ conversationId: message().conversationId });
  assert.equal(expired.messages.length, 0);
  assert.equal((await reloaded.claim({ workerId: "mac-yinyue-worker" })).claimed, false);
});

test("mailbox gives one leased Mac worker one message and accepts exactly one reply", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-mailbox-"));
  const service = createSecretaryMailboxService(root);
  await service.accept(message());
  const claimed = await service.claim({ workerId: "mac-yinyue-worker" });
  assert.equal(claimed.claimed, true);
  assert.equal((await service.claim({ workerId: "another-mac-worker" })).claimed, false);

  const payload = {
    messageId: message().messageId,
    generationId: message().generationId,
    reply: { messageId: `reply-${message().generationId}`, text: "好，今晚我们早点收尾。", speakerId: "yinyue" },
  };
  assert.equal((await service.complete(payload)).duplicate, false);
  assert.equal((await service.complete(payload)).duplicate, true);
  await assert.rejects(
    service.complete({ ...payload, reply: { ...payload.reply, text: "另一份回复" } }),
    (error) => error?.code === "SECRETARY_MAILBOX_REPLY_CONFLICT",
  );
  assert.equal((await service.sync()).replies.length, 1);
});

test("mailbox rejects changed content behind the same stable identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-mailbox-"));
  const service = createSecretaryMailboxService(root);
  await service.accept(message());
  await assert.rejects(
    service.accept(message({ text: "被改过的内容" })),
    (error) => error?.status === 409 && error?.code === "SECRETARY_MAILBOX_ID_CONFLICT",
  );
});

test("mailbox accepts an on-device voice transcript without original audio bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-mailbox-"));
  const service = createSecretaryMailboxService(root);
  const voice = message({
    text: "",
    messageId: "msg-voice-11111111",
    generationId: "gen-voice-11111111",
    attachments: [{
      id: "ios_voice_11111111",
      kind: "audio",
      mimeType: "audio/mp4",
      durationMs: 5_600,
      transcript: "这是手机本机已完成的逐字稿。",
      resourcePath: "local-draft:ios_voice_11111111",
    }],
  });

  const first = await service.accept(voice);
  const duplicate = await service.accept(voice);
  const snapshot = await service.sync({ conversationId: voice.conversationId });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.revision, first.revision);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].attachments[0].transcript, "这是手机本机已完成的逐字稿。");
  assert.equal(snapshot.messages[0].attachments[0].resourcePath, "local-draft:ios_voice_11111111");
});

test("mailbox protects photo originals beyond 25 hours and releases bytes only after Mac ack", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-mailbox-intake-"));
  let now = Date.parse("2026-09-05T03:00:01.000Z");
  const service = createSecretaryMailboxService(root, { now: () => now });
  const first = await service.acceptIntake(intake());
  const duplicate = await service.acceptIntake(intake());
  assert.equal(first.deliveryBoundary, "mailbox_persisted");
  assert.equal(duplicate.duplicateReason, "same_id");
  const snapshot = await service.syncIntakes();
  assert.equal(snapshot.intakes.length, 1);
  assert.equal(snapshot.intakes[0].expiresAt, null);
  now += 25 * 60 * 60 * 1_000;
  assert.equal((await service.syncIntakes()).intakes.length, 1);
  const original = await service.readIntakeAttachment(intake().intakeId, intake().attachments[0].attachmentId);
  assert.equal(original.data.toString(), "nas-original-photo");
  assert.equal((await service.acknowledgeIntake({ intakeId: intake().intakeId })).duplicate, false);
  assert.equal((await service.acknowledgeIntake({ intakeId: intake().intakeId })).duplicate, true);
  assert.equal((await service.acceptIntake(intake())).deliveryBoundary, "mac_persisted");
  assert.equal((await service.syncIntakes()).intakes.length, 0);
  await assert.rejects(service.readIntakeAttachment(intake().intakeId, intake().attachments[0].attachmentId));

  await service.acceptIntake(intake({ intakeId: "23cf8cc3-9081-4c19-af4a-361719457dbf", text: "another original" }));
  now += SECRETARY_MAILBOX_RETENTION_MS;
  assert.equal((await service.syncIntakes()).intakes.length, 1);
});

test("legacy pending_mac rows retain original bytes despite an expired stored TTL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mailbox-legacy-retention-"));
  let now = Date.parse("2026-09-05T03:00:00Z");
  const service = createSecretaryMailboxService(root, { now: () => now });
  await service.acceptIntake(intake());
  const state = JSON.parse(await fs.readFile(service.statePath, "utf8"));
  state.intakes[0].expiresAt = new Date(now + SECRETARY_MAILBOX_RETENTION_MS).toISOString();
  await fs.writeFile(service.statePath, JSON.stringify(state));
  now += 25 * 60 * 60 * 1_000;
  const reloaded = createSecretaryMailboxService(root, { now: () => now });
  assert.equal((await reloaded.syncIntakes()).intakes.length, 1);
  assert.equal((await reloaded.readIntakeAttachment(intake().intakeId, intake().attachments[0].attachmentId)).data.toString(), "nas-original-photo");
});

test("intake IDs and deduplicated aliases reject changed text and attachment bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mailbox-intake-conflicts-"));
  const service = createSecretaryMailboxService(root);
  await service.acceptIntake(intake());
  assert.equal((await service.acceptIntake(intake())).duplicate, true);
  const alias = "23cf8cc3-9081-4c19-af4a-361719457dbf";
  await service.acceptIntake(intake({ intakeId: alias }));
  for (const id of [intake().intakeId, alias]) {
    await assert.rejects(service.acceptIntake(intake({ intakeId: id, text: "changed" })), error => error.status === 409);
  }
  const data = Buffer.from("different-original");
  const attachments = [{ ...intake().attachments[0], byteCount: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"), data: data.toString("base64") }];
  await assert.rejects(service.acceptIntake(intake({ attachments })), error => error.code === "YINGNING_INTAKE_ID_CONFLICT");
  assert.equal((await service.readIntakeAttachment(intake().intakeId, intake().attachments[0].attachmentId)).data.toString(), "nas-original-photo");
});

test("transient failures back off without blocking other conversations or reordering their own", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mailbox-fair-retry-"));
  let now = Date.parse("2026-09-05T03:00:00Z");
  const service = createSecretaryMailboxService(root, { now: () => now });
  await service.accept(message());
  await service.accept(message({ messageId: "message-same-next", generationId: "generation-same-next" }));
  await service.accept(message({ conversationId: "conversation-other", messageId: "message-other-next", generationId: "generation-other-next" }));
  const first = await service.claim({ workerId: "mac-worker-first" });
  await service.release({ generationId: first.message.generationId, failureKind: "transient", errorCode: "MODEL_TIMEOUT" });
  const other = await service.claim({ workerId: "mac-worker-second" });
  assert.equal(other.message.messageId, "message-other-next");
  assert.equal((await service.claim({ workerId: "mac-worker-third" })).claimed, false);
  now += 5_000;
  assert.equal((await service.claim({ workerId: "mac-worker-third" })).message.messageId, message().messageId);
  assert.equal((await service.claim({ workerId: "mac-worker-fourth" })).claimed, false);
});
