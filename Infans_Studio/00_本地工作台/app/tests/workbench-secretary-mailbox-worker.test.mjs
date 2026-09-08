import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSecretaryMailboxService } from "../src/server/workbench-secretary-mailbox.mjs";
import { createSecretaryMailboxWorker, secretaryMailboxTurn } from "../src/server/workbench-secretary-mailbox-worker.mjs";
import { createYingningInboxService } from "../src/server/workbench-yingning-inbox.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mailboxFetch(service, expectedToken) {
  return async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, `Bearer ${expectedToken}`);
    const payload = JSON.parse(init.body);
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/claim")) return response(await service.claim(payload));
    if (pathname.endsWith("/complete")) return response(await service.complete(payload));
    if (pathname.endsWith("/release")) return response(await service.release(payload));
    return response({ error: "unexpected" }, 404);
  };
}

function message(overrides = {}) {
  return {
    protocolVersion: 1,
    conversationId: "native_yingning_default",
    messageId: "msg-11111111-2222-4333-8444-555555555555",
    generationId: "gen-11111111-2222-4333-8444-555555555555",
    createdAt: "2026-09-05T00:00:00Z",
    text: "",
    expectedConversationVersion: "stale-device-version",
    attachments: [{
      id: "ios_11111111-2222-4333-8444-555555555555",
      kind: "audio",
      mimeType: "audio/mp4",
      durationMs: 4_200,
      transcript: "银月，这是手机本机识别的逐字稿。",
      resourcePath: "local-draft:ios_11111111-2222-4333-8444-555555555555",
    }],
    ...overrides,
  };
}

test("Mac recovery claims one NAS item once and completes one reply across concurrent workers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-mailbox-worker-"));
  const service = createSecretaryMailboxService(root);
  await service.accept(message());
  let generationCalls = 0;
  const seenTurns = [];
  const seenInternal = [];
  const secretaryMobile = {
    async streamTurn(turn, emit, internal) {
      generationCalls += 1;
      seenTurns.push(turn);
      seenInternal.push(internal);
      const reply = {
        id: `reply-${turn.generationId}`,
        role: "assistant",
        sender: { id: "yinyue", kind: "character", displayName: "银月" },
        createdAt: "2026-09-05T00:00:01Z",
        text: "收到了。",
        fallbackText: "收到了。",
      };
      emit({ type: "completed", messages: [reply] });
      return { ok: true };
    },
  };
  const common = {
    mailboxBaseUrl: "https://nas.example.test",
    token: "mailbox-secret",
    secretaryMobile,
    fetchImpl: mailboxFetch(service, "mailbox-secret"),
  };
  const first = createSecretaryMailboxWorker({ ...common, workerId: "mac-worker-first" });
  const second = createSecretaryMailboxWorker({ ...common, workerId: "mac-worker-second" });

  await Promise.all([first.runOnce(), second.runOnce()]);

  const snapshot = await service.sync({ conversationId: message().conversationId });
  assert.equal(generationCalls, 1);
  assert.equal(snapshot.replies.length, 1);
  assert.equal(seenTurns[0].text, "银月，这是手机本机识别的逐字稿。");
  assert.deepEqual(seenTurns[0].attachments, []);
  assert.deepEqual(seenInternal[0].voiceSources, [{
    id: "ios_11111111-2222-4333-8444-555555555555",
    mime: "audio/mp4",
    durationMs: 4_200,
    transcript: "银月，这是手机本机识别的逐字稿。",
  }]);
  assert.equal(seenTurns[0].expectedConversationVersion, "");
  assert.equal((await service.claim({ workerId: "mac-worker-later" })).claimed, false);
});

test("worker completes when generation returns more than one assistant message", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-mailbox-worker-multi-"));
  const service = createSecretaryMailboxService(root);
  await service.accept(message());
  const secretaryMobile = {
    async streamTurn(turn, emit) {
      emit({
        type: "completed",
        messages: [
          {
            id: `reply-${turn.generationId}:1`,
            role: "assistant",
            sender: { id: "yinyue", kind: "character", displayName: "银月" },
            createdAt: "2026-09-05T00:00:01Z",
            text: "第一句。",
            fallbackText: "第一句。",
          },
          {
            id: `reply-${turn.generationId}:2`,
            role: "assistant",
            sender: { id: "yinyue", kind: "character", displayName: "银月" },
            createdAt: "2026-09-05T00:00:02Z",
            text: "第二句。",
            fallbackText: "第二句。",
          },
        ],
      });
      return { ok: true };
    },
  };
  const worker = createSecretaryMailboxWorker({
    mailboxBaseUrl: "https://nas.example.test",
    token: "mailbox-secret",
    workerId: "mac-worker-multi",
    secretaryMobile,
    fetchImpl: mailboxFetch(service, "mailbox-secret"),
  });
  const result = await worker.runOnce();
  assert.equal(result.completed, true);
  const snapshot = await service.sync({ conversationId: message().conversationId });
  assert.equal(snapshot.replies.length, 1);
  assert.equal(snapshot.replies[0].text, "第一句。");
  assert.equal((await service.claim({ workerId: "mac-worker-later" })).claimed, false);
});

test("worker projects only Mac-readable fields and keeps uploaded non-audio references", () => {
  const projected = secretaryMailboxTurn(message({
    text: "看看这份文件。",
    attachments: [
      message().attachments[0],
      {
        id: "iosasset_uploaded_1234",
        kind: "file",
        mimeType: "text/markdown",
        transcript: null,
        resourcePath: "/api/secretary-mobile/attachments/iosasset_uploaded_1234/content",
        claimedBy: "must-not-leak",
      },
    ],
    claimedAt: "must-not-leak",
  }));

  assert.equal(projected.text, "看看这份文件。\n银月，这是手机本机识别的逐字稿。");
  assert.deepEqual(projected.attachments, [{ id: "iosasset_uploaded_1234" }]);
  assert.equal("claimedAt" in projected, false);
  assert.equal(JSON.stringify(projected).includes("must-not-leak"), false);
});

test("worker stays disabled without a valid private HTTPS origin or token", async () => {
  const worker = createSecretaryMailboxWorker({
    mailboxBaseUrl: "http://nas.example.test",
    token: "",
    secretaryMobile: { streamTurn: async () => ({ ok: true }) },
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(worker.configured, false);
  assert.equal(worker.start(), false);
  assert.deepEqual(await worker.runOnce(), { configured: false, claimed: false });
});

test("existing Mac worker copies NAS photo intake byte-for-byte into local inbox then acknowledges it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secretary-intake-worker-"));
  let now = Date.parse("2026-09-05T03:00:00Z");
  const remote = createSecretaryMailboxService(root, { directory: path.join(root, "remote"), now: () => now });
  const local = createYingningInboxService(root, { inboxDir: path.join(root, "local") });
  const data = Buffer.from("worker-photo-original");
  const intake = {
    schemaVersion: 2,
    intakeId: "72742e43-35ed-4c3e-8e65-753ce8dc7f42",
    url: "", title: "", text: "", note: "", source: "ipados_share_extension", sourceSemantic: "photo_share",
    sourceApp: "Photos", deviceId: "capoo-ipad", deviceName: "iPad", createdAt: "2026-09-05T03:00:00Z",
    attachments: [{
      attachmentId: "8d55b9db-1dd3-4d75-a644-2fe8951cd1a6", role: "original", fileName: "IMG_0001.HEIC",
      contentType: "image/heic", byteCount: data.length, pixelWidth: 4032, pixelHeight: 3024,
      createdAt: "2026-09-05T03:00:00Z", sha256: crypto.createHash("sha256").update(data).digest("hex"), data: data.toString("base64"),
    }],
  };
  await remote.acceptIntake(intake);
  const aliasId = "23cf8cc3-9081-4c19-af4a-361719457dbf";
  await remote.acceptIntake({ ...intake, intakeId: aliasId });
  now += 25 * 60 * 60 * 1_000;
  let loseFirstAcknowledgement = true;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (init.method === "GET" && parsed.pathname.endsWith("/intakes")) return response(await remote.syncIntakes());
    if (init.method === "GET" && parsed.pathname.endsWith("/intakes/attachment")) {
      const file = await remote.readIntakeAttachment(parsed.searchParams.get("intakeId"), parsed.searchParams.get("attachmentId"));
      return new Response(file.data, { status: 200, headers: { "Content-Type": file.attachment.contentType } });
    }
    if (parsed.pathname.endsWith("/intakes/ack")) {
      if (loseFirstAcknowledgement) { loseFirstAcknowledgement = false; throw new Error("synthetic lost ACK request"); }
      return response(await remote.acknowledgeIntake(JSON.parse(init.body)));
    }
    if (parsed.pathname.endsWith("/claim")) return response({ claimed: false, message: null });
    return response({ error: "unexpected" }, 404);
  };
  const worker = createSecretaryMailboxWorker({
    mailboxBaseUrl: "https://nas.example.test", token: "mailbox-secret", yingningInbox: local,
    secretaryMobile: { streamTurn: async () => ({ ok: true }) }, fetchImpl,
  });
  await worker.runOnce();
  assert.equal((await remote.syncIntakes()).intakes.length, 1);
  assert.equal((await local.list()).items.length, 1);
  await worker.runOnce();
  const localSnapshot = await local.list();
  assert.equal(localSnapshot.items.length, 1);
  const original = await local.readAttachment(intake.intakeId, intake.attachments[0].attachmentId);
  assert.equal(original.data.toString(), "worker-photo-original");
  assert.equal((await remote.syncIntakes()).intakes.length, 0);
  assert.equal((await remote.acceptIntake(intake)).deliveryBoundary, "mac_persisted");
  // A phone offline longer than the ACK tombstone can resend. Mac stable-ID
  // deduplication must still close the loop without a second original.
  now += 25 * 60 * 60 * 1_000;
  assert.equal((await remote.acceptIntake(intake)).deliveryBoundary, "mailbox_persisted");
  await worker.runOnce();
  assert.equal((await local.list()).items.length, 1);
  assert.equal((await remote.acceptIntake(intake)).deliveryBoundary, "mac_persisted");
  const lateAlias = await local.accept({ ...intake, intakeId: aliasId }, new Date("2027-01-01T00:00:00Z"));
  assert.equal(lateAlias.duplicateReason, "same_id");
  assert.equal((await local.list()).items.length, 1);
});

test("permanently unusable input is quarantined and the next message can complete", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mailbox-poison-message-"));
  const service = createSecretaryMailboxService(root);
  await service.accept(message({ attachments: [{ id: "invalid-local-reference", kind: "file", resourcePath: "local-draft:fixture" }] }));
  await service.accept(message({ messageId: "message-valid-next", generationId: "generation-valid-next", text: "valid", attachments: [] }));
  const worker = createSecretaryMailboxWorker({
    mailboxBaseUrl: "https://nas.example.test", token: "fixture", workerId: "mac-worker-fixture",
    fetchImpl: mailboxFetch(service, "fixture"),
    secretaryMobile: { async streamTurn(turn, emit) {
      emit({ type: "completed", messages: [{ id: `reply-${turn.generationId}`, role: "assistant", text: "done" }] });
      return { ok: true };
    } },
  });
  assert.equal((await worker.runOnce()).completed, false);
  assert.equal((await worker.runOnce()).completed, true);
  const snapshot = await service.sync();
  assert.equal(snapshot.messages[0].status, "failed");
  assert.equal(snapshot.messages[0].lastError, "MAILBOX_MESSAGE_HAS_NO_MAC_INPUT");
  assert.equal(snapshot.messages[0].attempts, 1);
  assert.equal(snapshot.messages[1].status, "replied");
});
