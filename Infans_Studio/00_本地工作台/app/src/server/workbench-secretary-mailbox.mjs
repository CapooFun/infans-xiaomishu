import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { normalizeYingningIntake } from "./workbench-yingning-inbox.mjs";
import { SECRETARY_RUNTIME_DIR } from "./vault-paths.mjs";

const SCHEMA_VERSION = 1;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const CLAIM_LEASE_MS = 2 * 60 * 1_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60 * 1_000;
const ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:-]{7,159}$/u;

function text(value, name, maximum = 30_000) {
  const result = String(value ?? "").trim();
  if (!result || result.length > maximum) {
    throw new WorkbenchWriteError(`${name}不合法`, 400, "SECRETARY_MAILBOX_INVALID");
  }
  return result;
}

function stableId(value, name) {
  const result = text(value, name, 160);
  if (!ID_PATTERN.test(result) || result.includes("..")) {
    throw new WorkbenchWriteError(`${name}不合法`, 400, "SECRETARY_MAILBOX_INVALID_ID");
  }
  return result;
}

function canonicalMessage(payload, now, retentionMs) {
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  if (attachments.length > 4) {
    throw new WorkbenchWriteError("一条消息最多四份附件", 400, "SECRETARY_MAILBOX_TOO_MANY_ATTACHMENTS");
  }
  const normalizedAttachments = attachments.map((item) => ({
    id: stableId(item?.id, "附件 ID"),
    kind: String(item?.kind || "reference").slice(0, 24),
    mimeType: String(item?.mimeType || "application/octet-stream").slice(0, 120),
    durationMs: item?.durationMs == null ? null : Math.max(1, Math.min(60_000, Number(item.durationMs) || 0)),
    transcript: item?.transcript == null ? null : String(item.transcript).trim().slice(0, 30_000),
    resourcePath: item?.resourcePath == null ? null : String(item.resourcePath).trim().slice(0, 1_000),
  }));
  const createdAt = String(payload?.createdAt || new Date(now).toISOString());
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new WorkbenchWriteError("消息时间不合法", 400, "SECRETARY_MAILBOX_INVALID_TIME");
  }
  const content = String(payload?.text ?? "").trim().slice(0, 30_000);
  if (!content && !normalizedAttachments.length) {
    throw new WorkbenchWriteError("消息不能为空", 400, "SECRETARY_MAILBOX_EMPTY_MESSAGE");
  }
  return {
    protocolVersion: 1,
    conversationId: stableId(payload?.conversationId, "会话 ID"),
    messageId: stableId(payload?.messageId, "消息 ID"),
    generationId: stableId(payload?.generationId, "生成 ID"),
    createdAt,
    text: content,
    expectedConversationVersion: String(payload?.expectedConversationVersion ?? "").slice(0, 200),
    attachments: normalizedAttachments,
    receivedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + retentionMs).toISOString(),
    status: "pending",
    claimedBy: null,
    claimedAt: null,
    attempts: 0,
  };
}

function messageDigest(message) {
  const comparable = {
    protocolVersion: message.protocolVersion,
    conversationId: message.conversationId,
    messageId: message.messageId,
    generationId: message.generationId,
    createdAt: message.createdAt,
    text: message.text,
    expectedConversationVersion: message.expectedConversationVersion,
    attachments: message.attachments,
  };
  return crypto.createHash("sha256").update(JSON.stringify(comparable)).digest("hex");
}

function defaultState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, messages: [], replies: [], intakes: [] };
}

function pruneExpired(state, currentTime) {
  const retainedMessages = state.messages.filter((item) => {
    if (item.status === "failed") return true;
    const expiresAt = Date.parse(item.expiresAt || "");
    return Number.isFinite(expiresAt) && expiresAt > currentTime;
  });
  const intakes = Array.isArray(state.intakes) ? state.intakes : [];
  // A relay receipt transfers custody, not permission to discard an original.
  // Legacy pending_mac rows are protected too, regardless of their old TTL.
  const retainedIntakes = intakes.filter((item) => item.status !== "mac_persisted"
    || (Number.isFinite(Date.parse(item.expiresAt || "")) && Date.parse(item.expiresAt) > currentTime));
  state.__expiredIntakeIds = intakes.filter((item) => !retainedIntakes.includes(item)).map((item) => item.intakeId);
  state.intakes = retainedIntakes;
  if (retainedMessages.length === state.messages.length && retainedIntakes.length === intakes.length) return false;
  const retainedGenerationIds = new Set(retainedMessages.map((item) => item.generationId));
  state.messages = retainedMessages;
  state.replies = state.replies.filter((item) => retainedGenerationIds.has(item.generationId));
  return true;
}

export function createSecretaryMailboxService(root, options = {}) {
  const now = options.now || (() => Date.now());
  const retentionMs = Number(options.retentionMs) > 0 ? Number(options.retentionMs) : DEFAULT_RETENTION_MS;
  const directory = options.directory || path.join(root, SECRETARY_RUNTIME_DIR, "mailbox");
  const statePath = path.join(directory, "secretary-mailbox.v1.json");
  const intakeAttachmentsDirectory = path.join(directory, "intake-attachments");
  let operation = Promise.resolve();

  async function readState() {
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
      if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.messages) || !Array.isArray(parsed.replies)) {
        throw new Error("invalid schema");
      }
      parsed.intakes = Array.isArray(parsed.intakes) ? parsed.intakes : [];
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return defaultState();
      throw new WorkbenchWriteError("小秘书信箱状态无法读取", 500, "SECRETARY_MAILBOX_STATE_INVALID");
    }
  }

  async function writeState(state) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const expiredIntakeIds = (Array.isArray(state.__expiredIntakeIds) ? state.__expiredIntakeIds : [])
      .filter((id) => !state.intakes.some((item) => item.intakeId === id && item.status !== "mac_persisted"));
    delete state.__expiredIntakeIds;
    state.revision = Number(state.revision || 0) + 1;
    const temporary = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, statePath);
    // Cleanup is after the commit and must not turn a committed accept into a
    // failed write (whose caller would roll back the newly accepted original).
    await Promise.all(expiredIntakeIds.map((id) => fs.rm(path.join(intakeAttachmentsDirectory, id), { recursive: true, force: true }).catch(() => {})));
  }

  function exclusive(action) {
    const next = operation.then(action, action);
    operation = next.catch(() => undefined);
    return next;
  }

  async function accept(payload) {
    return exclusive(async () => {
      const state = await readState();
      const currentTime = now();
      const pruned = pruneExpired(state, currentTime);
      const incoming = canonicalMessage(payload, currentTime, retentionMs);
      const existing = state.messages.find((item) => item.messageId === incoming.messageId || item.generationId === incoming.generationId);
      if (existing) {
        if (messageDigest(existing) !== messageDigest(incoming)) {
          throw new WorkbenchWriteError("相同消息 ID 的内容已经不同", 409, "SECRETARY_MAILBOX_ID_CONFLICT");
        }
        if (pruned) await writeState(state);
        return { accepted: true, duplicate: true, revision: state.revision, message: existing };
      }
      state.messages.push(incoming);
      await writeState(state);
      return { accepted: true, duplicate: false, revision: state.revision, message: incoming };
    });
  }

  async function claim(payload = {}) {
    return exclusive(async () => {
      const workerId = stableId(payload.workerId, "工作器 ID");
      const state = await readState();
      const currentTime = now();
      const pruned = pruneExpired(state, currentTime);
      const blockedConversations = new Set();
      const next = state.messages.find((item) => {
        if (state.replies.some((reply) => reply.generationId === item.generationId)) return false;
        // A quarantined permanent failure is visible but no longer holds the
        // conversation. A transient failure or live lease preserves FIFO there.
        if (item.status === "failed") return false;
        if (blockedConversations.has(item.conversationId)) return false;
        blockedConversations.add(item.conversationId);
        if (item.status === "pending") return !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= currentTime;
        return item.status === "processing" && Date.parse(item.claimedAt || "") + CLAIM_LEASE_MS <= currentTime;
      });
      if (!next) {
        if (pruned) await writeState(state);
        return { claimed: false, revision: state.revision, message: null };
      }
      next.status = "processing";
      next.claimedBy = workerId;
      next.claimedAt = new Date(currentTime).toISOString();
      next.attempts = Number(next.attempts || 0) + 1;
      await writeState(state);
      return { claimed: true, revision: state.revision, message: next };
    });
  }

  async function complete(payload) {
    return exclusive(async () => {
      const generationId = stableId(payload?.generationId, "生成 ID");
      const messageId = stableId(payload?.messageId, "消息 ID");
      const state = await readState();
      const pruned = pruneExpired(state, now());
      const message = state.messages.find((item) => item.messageId === messageId && item.generationId === generationId);
      if (!message) {
        if (pruned) await writeState(state);
        throw new WorkbenchWriteError("找不到待回复消息", 404, "SECRETARY_MAILBOX_MESSAGE_NOT_FOUND");
      }
      const existing = state.replies.find((item) => item.generationId === generationId);
      const reply = {
        protocolVersion: 1,
        conversationId: message.conversationId,
        messageId: stableId(payload?.reply?.messageId || `reply-${generationId}`, "回复消息 ID"),
        generationId,
        text: text(payload?.reply?.text, "回复正文"),
        speakerId: String(payload?.reply?.speakerId || "yinyue").slice(0, 80),
        createdAt: String(payload?.reply?.createdAt || existing?.createdAt || new Date(now()).toISOString()),
      };
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(reply)) {
          throw new WorkbenchWriteError("这一条消息已经有另一份回复", 409, "SECRETARY_MAILBOX_REPLY_CONFLICT");
        }
        return { completed: true, duplicate: true, revision: state.revision, reply: existing };
      }
      state.replies.push(reply);
      message.status = "replied";
      message.claimedBy = null;
      message.claimedAt = null;
      await writeState(state);
      return { completed: true, duplicate: false, revision: state.revision, reply };
    });
  }

  async function release(payload) {
    return exclusive(async () => {
      const generationId = stableId(payload?.generationId, "生成 ID");
      const state = await readState();
      const pruned = pruneExpired(state, now());
      const message = state.messages.find((item) => item.generationId === generationId);
      if (!message) {
        if (pruned) await writeState(state);
        throw new WorkbenchWriteError("找不到待回复消息", 404, "SECRETARY_MAILBOX_MESSAGE_NOT_FOUND");
      }
      if (!state.replies.some((item) => item.generationId === generationId)) {
        const permanent = payload?.failureKind === "permanent";
        message.status = permanent ? "failed" : "pending";
        message.lastError = String(payload?.errorCode || "MAILBOX_WORKER_RELEASED").slice(0, 120);
        message.failedAt = permanent ? new Date(now()).toISOString() : null;
        const retryDelay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(16, Math.max(0, Number(message.attempts || 1) - 1)));
        message.nextAttemptAt = permanent ? null : new Date(now() + retryDelay).toISOString();
        message.claimedBy = null;
        message.claimedAt = null;
        await writeState(state);
      }
      return { released: true, revision: state.revision };
    });
  }

  async function sync({ conversationId, afterRevision = 0 } = {}) {
    return exclusive(async () => {
      const state = await readState();
      const id = conversationId ? stableId(conversationId, "会话 ID") : null;
      if (pruneExpired(state, now())) await writeState(state);
      return {
        schemaVersion: SCHEMA_VERSION,
        revision: state.revision,
        changed: state.revision > Number(afterRevision || 0),
        messages: state.messages.filter((item) => !id || item.conversationId === id),
        replies: state.replies.filter((item) => !id || item.conversationId === id),
      };
    });
  }

  async function persistIntakeAttachments(incoming) {
    if (!incoming.attachmentPayloads.length) return;
    await fs.mkdir(intakeAttachmentsDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(intakeAttachmentsDirectory, incoming.intakeId);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      for (const row of incoming.attachmentPayloads) {
        const file = path.join(temporary, row.metadata.attachmentId);
        await fs.writeFile(file, row.data, { mode: 0o600, flag: "wx" });
        await fs.chmod(file, 0o600).catch(() => {});
      }
      await fs.rename(temporary, destination);
      await fs.chmod(destination, 0o700).catch(() => {});
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function acceptIntake(payload) {
    return exclusive(async () => {
      const state = await readState();
      const currentTime = now();
      const pruned = pruneExpired(state, currentTime);
      const incoming = normalizeYingningIntake(payload);
      const exact = state.intakes.find((item) => item.intakeId === incoming.intakeId || item.aliasIntakeIds?.includes(incoming.intakeId));
      if (exact && exact.fingerprint !== incoming.fingerprint) {
        throw new WorkbenchWriteError("相同来件 ID 的内容已经不同", 409, "YINGNING_INTAKE_ID_CONFLICT");
      }
      const sameContent = state.intakes.find((item) => item.fingerprint === incoming.fingerprint);
      const duplicate = exact || sameContent;
      if (duplicate) {
        if (!exact) duplicate.aliasIntakeIds = [...(duplicate.aliasIntakeIds || []), incoming.intakeId];
        duplicate.duplicateCount = Number(duplicate.duplicateCount || 0) + 1;
        duplicate.lastDuplicateAt = new Date(currentTime).toISOString();
        await writeState(state);
        return {
          ok: true, duplicate: true, duplicateReason: exact ? "same_id" : "same_content",
          intakeId: incoming.intakeId, canonicalItemId: duplicate.canonicalItemId || duplicate.intakeId, status: "delivered",
          deliveredAt: duplicate.macPersistedAt || duplicate.receivedAt,
          deliveryBoundary: duplicate.status === "mac_persisted" ? "mac_persisted" : "mailbox_persisted",
        };
      }
      await persistIntakeAttachments(incoming);
      const { attachmentPayloads: _payloads, ...safe } = incoming;
      const row = {
        ...safe,
        receivedAt: new Date(currentTime).toISOString(),
        expiresAt: null,
        status: "pending_mac",
        duplicateCount: 0,
      };
      state.intakes.push(row);
      try { await writeState(state); } catch (error) {
        await fs.rm(path.join(intakeAttachmentsDirectory, incoming.intakeId), { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return {
        ok: true, duplicate: false, intakeId: incoming.intakeId, canonicalItemId: incoming.intakeId,
        status: "delivered", deliveredAt: row.receivedAt, deliveryBoundary: "mailbox_persisted",
      };
    });
  }

  async function syncIntakes() {
    return exclusive(async () => {
      const state = await readState();
      if (pruneExpired(state, now())) await writeState(state);
      return {
        schemaVersion: 1,
        revision: state.revision,
        intakes: state.intakes.filter((item) => item.status !== "mac_persisted").map(({ fingerprint: _fingerprint, ...item }) => item),
      };
    });
  }

  async function readIntakeAttachment(intakeId, attachmentId) {
    return exclusive(async () => {
      const state = await readState();
      const item = state.intakes.find((row) => row.intakeId === intakeId);
      const attachment = item?.attachments?.find((row) => row.attachmentId === attachmentId);
      if (!attachment || item.status === "mac_persisted") throw new WorkbenchWriteError("原图不存在", 404, "SECRETARY_MAILBOX_INTAKE_ATTACHMENT_NOT_FOUND");
      return { attachment, data: await fs.readFile(path.join(intakeAttachmentsDirectory, intakeId, attachmentId)) };
    });
  }

  async function acknowledgeIntake(payload) {
    return exclusive(async () => {
      const intakeId = stableId(payload?.intakeId, "来件 ID");
      const state = await readState();
      const index = state.intakes.findIndex((row) => row.intakeId === intakeId);
      if (index < 0 || state.intakes[index].status === "mac_persisted") return { acknowledged: true, duplicate: true, intakeId, revision: state.revision };
      // Keep a bounded receipt tombstone for the device to reconcile. If it
      // expires before a retry, the Mac inbox still deduplicates the stable ID.
      state.intakes[index].status = "mac_persisted";
      state.intakes[index].canonicalItemId = payload?.canonicalItemId ? stableId(payload.canonicalItemId, "Mac 来件 ID") : intakeId;
      state.intakes[index].macPersistedAt = new Date(now()).toISOString();
      state.intakes[index].expiresAt = new Date(now() + retentionMs).toISOString();
      state.__expiredIntakeIds = [intakeId];
      await writeState(state);
      return { acknowledged: true, duplicate: false, intakeId, revision: state.revision };
    });
  }

  return { accept, claim, complete, release, sync, acceptIntake, syncIntakes, readIntakeAttachment, acknowledgeIntake, statePath };
}

export { DEFAULT_RETENTION_MS as SECRETARY_MAILBOX_RETENTION_MS };
