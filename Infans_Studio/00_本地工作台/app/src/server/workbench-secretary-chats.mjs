/**
 * 小秘书聊天存档：明文 JSON。开源只有一对一。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import {
  assertSecretaryAttachmentExists,
  deleteSecretaryAttachment,
  withSecretaryArchiveMutation,
} from "./workbench-secretary-attachments.mjs";
import { normalizeChatSpeaker } from "../secretary-characters.mjs";
import { normalizeSecretaryId } from "../secretary-identity.mjs";
import { SECRETARY_CHAT_DIR } from "./vault-paths.mjs";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";
import { assertPublicChatPayload } from "../opensource-chat-session.mjs";

/** 相对 Vault 根。需要换目录时只改 vault-paths.mjs。 */
export const SECRETARY_CHAT_DIR_RELATIVE = SECRETARY_CHAT_DIR;

const SCHEMA_VERSION = 6;
const PRIVATE_CHAT_TITLE = "小秘书会话";
const PRIVATE_CHAT_PREVIEW = "内容已隐藏";

// 全局引用图锁保护不同聊天之间的附件 GC；这个集合另外拒绝同一聊天的重叠写。
const pendingChatMutations = new Set();

function chatMutationKey(vaultRoot, id) {
  return `${path.resolve(vaultRoot)}\0${id}`;
}

function withSecretaryChatMutation(vaultRoot, id, operation) {
  const key = chatMutationKey(vaultRoot, id);
  if (pendingChatMutations.has(key)) {
    return Promise.reject(new WorkbenchWriteError(
      "这份存档刚刚被另一个操作修改，请重新读取后再试。",
      409,
      "CHAT_WRITE_CONFLICT",
    ));
  }
  pendingChatMutations.add(key);
  return withSecretaryArchiveMutation(vaultRoot, operation)
    .finally(() => pendingChatMutations.delete(key));
}

export function secretaryChatDir(vaultRoot) {
  return path.resolve(vaultRoot, SECRETARY_CHAT_DIR_RELATIVE);
}

function tokyoStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    clock: `${get("hour")}${get("minute")}${get("second")}`,
    iso: date.toISOString(),
  };
}

function sanitizeTitle(raw = "") {
  const text = String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/[\\/:*?"<>|#%.]+/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .slice(0, 36);
  return text || "未命名会话";
}

function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object" && item.id)
    .map((item) => {
      const kind = item.kind === "image" || item.kind === "audio" || item.kind === "file" ? item.kind : "file";
      const row = {
        id: String(item.id).slice(0, 80),
        kind,
        name: String(item.name || "附件").slice(0, 120),
        mime: String(item.mime || "").slice(0, 120),
      };
      if (Number.isFinite(Number(item.size)) && Number(item.size) >= 0) row.size = Math.round(Number(item.size));
      if (/^[a-f0-9]{64}$/u.test(String(item.sha256 || ""))) row.sha256 = String(item.sha256);
      if (Number.isFinite(Date.parse(String(item.createdAt || "")))) row.createdAt = new Date(item.createdAt).toISOString();
      if (item.url) row.url = String(item.url).slice(0, 240);
      if (item.path) row.path = String(item.path).slice(0, 240);
      if (Number(item.durationMs) > 0) row.durationMs = Math.round(Number(item.durationMs));
      if (item.transcript) row.transcript = String(item.transcript).slice(0, 2000);
      return row;
    })
    .slice(0, 8);
}

function normalizeVoiceSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object" && item.id)
    .map((item) => {
      const row = {
        id: String(item.id).slice(0, 80),
        mime: String(item.mime || item.mimeType || "audio/mp4").slice(0, 120),
      };
      if (Number(item.durationMs) > 0) row.durationMs = Math.round(Number(item.durationMs));
      if (item.transcript) row.transcript = String(item.transcript).slice(0, 2000);
      return row;
    })
    .slice(0, 4);
}

function normalizeMessages(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new WorkbenchWriteError("聊天消息必须是数组", 400, "INVALID_CHAT_MESSAGES");
  const ids = new Set();
  return raw
    .map((item, index) => {
      if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") {
        throw new WorkbenchWriteError("聊天消息的角色或正文格式不正确", 400, "INVALID_CHAT_MESSAGE");
      }
      const id = String(item.id || `msg-${index + 1}`);
      if (id.length > 80 || ids.has(id)) {
        throw new WorkbenchWriteError("聊天消息编号过长或重复", 400, "INVALID_CHAT_MESSAGE_ID");
      }
      ids.add(id);
      const row = {
        id,
        role: item.role,
        // 存档是原文；模型上下文窗口与输入大小限制由调用入口分别处理。
        content: item.content,
      };
      const createdAt = String(item.createdAt || "").trim();
      if (createdAt && Number.isFinite(Date.parse(createdAt))) {
        row.createdAt = new Date(createdAt).toISOString();
      }
      if (item.role === "assistant") {
        const speaker = normalizeChatSpeaker(item.speaker || "yinyue");
        if (!speaker) {
          throw new WorkbenchWriteError("聊天中含有未知角色", 400, "INVALID_CHAT_SPEAKER");
        }
        row.speaker = speaker;
      }
      const attachments = normalizeAttachments(item.attachments);
      if (attachments.length) row.attachments = attachments;
      const voiceSources = item.role === "user" ? normalizeVoiceSources(item.voiceSources) : [];
      if (voiceSources.length) row.voiceSources = voiceSources;
      return row;
    })
    .filter((item) => item.content.trim() || (item.attachments && item.attachments.length));
}

function messageOriginal(message) {
  // URL、路径、显示名等附件派生信息可以刷新；正文、说话者和原件引用不能静默替换。
  return JSON.stringify([
    message.role, message.speaker || "", message.content,
    (message.attachments || []).map((item) => item.id),
    (message.voiceSources || []).map((item) => [item.id, item.transcript || ""]),
  ]);
}

function mergeSecretaryChatMessages(existing, incoming, allowMessageUpdate = false) {
  const merged = (existing || []).map((item) => ({ ...item }));
  const positions = new Map(merged.map((item, index) => [item.id, index]));
  for (const item of incoming || []) {
    const position = positions.get(item.id);
    if (position === undefined) {
      positions.set(item.id, merged.length);
      merged.push({ ...item });
      continue;
    }
    const next = { ...merged[position], ...item };
    if (!allowMessageUpdate && messageOriginal(next) !== messageOriginal(merged[position])) {
      throw new WorkbenchWriteError("同一条消息已有不同的已保存内容，请重新读取后确认修改。", 409, "CHAT_MESSAGE_CONFLICT");
    }
    merged[position] = next;
  }
  return merged;
}

function archiveVersion(body) {
  return crypto.createHash("sha256").update(JSON.stringify({
    title: body.title,
    chatState: body.chatState,
    indexPolicy: body.indexPolicy,
    messages: body.messages,
  })).digest("hex");
}

function assertExpectedArchiveVersion(body, expectedVersion) {
  if (expectedVersion == null) return;
  if (typeof expectedVersion !== "string" || !/^[a-f0-9]{64}$/u.test(expectedVersion)) {
    throw new WorkbenchWriteError("聊天存档版本格式不正确", 400, "INVALID_CHAT_VERSION");
  }
  if (!body || expectedVersion !== archiveVersion(body)) {
    throw new WorkbenchWriteError("这份存档已有更新，请重新读取后确认修改。", 409, "CHAT_VERSION_CONFLICT");
  }
}

export function normalizeSecretaryChatState(raw) {
  const activeSecretaryId = normalizeSecretaryId(raw?.activeSecretaryId) || "yinyue";
  return {
    activeSecretaryId,
    ordinaryBackend: "",
    cursorModel: String(raw?.cursorModel || "").trim().slice(0, 120),
    privacy: "standard",
  };
}

function titleFromMessages(messages) {
  const firstUser = messages.find((item) => item.role === "user")?.content || messages[0]?.content || "";
  return sanitizeTitle(firstUser);
}

function assertSafeChatId(id) {
  const value = String(id || "").trim();
  if (!/^[0-9A-Za-z_\u4e00-\u9fff.-]{1,120}$/.test(value) || value.includes("..")) {
    throw new WorkbenchWriteError("存档编号不对", 400, "INVALID_CHAT_ID");
  }
  return value;
}

async function ensureChatDir(vaultRoot) {
  const dir = secretaryChatDir(vaultRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  return dir;
}

function privacyForChat(_chatState, _explicitIndexPolicy = "") {
  return {
    privacyClass: "standard",
    indexPolicy: "allow",
  };
}

export function prepareSecretaryChatDocument(payload = {}, options = {}) {
  assertPublicChatPayload(payload);
  const messages = normalizeMessages(payload.messages);
  if (!messages.length && options.allowEmpty !== true) {
    throw new WorkbenchWriteError("没有可保存的聊天内容", 400, "CHAT_EMPTY");
  }
  const chatState = normalizeSecretaryChatState(payload.chatState);
  const privacy = privacyForChat();
  const title = sanitizeTitle(payload.title || titleFromMessages(messages));
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: String(options.savedAt || payload.savedAt || tokyoStamp().iso),
    title,
    auto: Boolean(payload.auto),
    chatState,
    ...privacy,
    messages,
  };
}

function chatItem(id, body, relativePath, fallbackSavedAt = "") {
  const preview = body.messages.find((item) => item.role === "user")?.content || body.messages[0]?.content || "";
  return {
    id,
    title: body.title,
    savedAt: body.savedAt || fallbackSavedAt,
    messageCount: body.messages.length,
    preview: preview.slice(0, 80),
    private: false,
    indexPolicy: body.indexPolicy,
    storage: "plaintext",
    path: relativePath,
    archiveVersion: archiveVersion(body),
  };
}

function parsePlaintextChat(text) {
  let raw;
  try { raw = JSON.parse(text); } catch {
    throw new WorkbenchWriteError("聊天明文存档已损坏", 500, "CHAT_PLAINTEXT_BAD");
  }
  return prepareSecretaryChatDocument(raw, { savedAt: raw?.savedAt, allowEmpty: true });
}

async function atomicWritePlainJson(absolute, body) {
  const temporary = `${absolute}.infans-tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function listDirectoryEntries(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function locateChat(vaultRoot, id) {
  const candidate = {
    absolute: path.join(secretaryChatDir(vaultRoot), `${id}.json`),
    relative: path.join(SECRETARY_CHAT_DIR_RELATIVE, `${id}.json`),
  };
  try {
    await fs.access(candidate.absolute);
    return candidate;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return null;
}

async function writePlaintextSecretaryChatUnlocked(vaultRoot, payload, options = {}) {
  const id = assertSafeChatId(options.id);
  const body = options.preparedBody || prepareSecretaryChatDocument(payload, { savedAt: options.savedAt });
  const relativePath = options.relative || path.join(SECRETARY_CHAT_DIR_RELATIVE, `${id}.json`);
  await withVaultFileWrite(vaultRoot, relativePath, async (target) => {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(target), 0o700);
    await atomicWritePlainJson(target, body);
  });
  return {
    id,
    title: body.title,
    savedAt: body.savedAt,
    messageCount: body.messages.length,
    auto: body.auto,
    private: body.chatState.privacy === "private",
    indexPolicy: body.indexPolicy,
    storage: "plaintext",
    path: relativePath,
    archiveVersion: archiveVersion(body),
  };
}

export async function listSecretaryChats(vaultRoot) {
  const currentDir = secretaryChatDir(vaultRoot);
  const currentEntries = await listDirectoryEntries(currentDir);
  const items = [];
  const errors = [];
  const seen = new Set();

  const add = async (entry, absoluteDir, relativeDir, source) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return;
    const id = entry.name.slice(0, -5);
    if (seen.has(id)) {
      errors.push({ id, code: "CHAT_ID_DUPLICATE", source });
      return;
    }
    seen.add(id);
    const absolute = path.join(absoluteDir, entry.name);
    try {
      const body = parsePlaintextChat(await fs.readFile(absolute, "utf8"));
      const stat = await fs.stat(absolute);
      items.push(chatItem(id, body, path.join(relativeDir, entry.name), stat.mtime.toISOString()));
    } catch (error) {
      errors.push({ id, code: error?.code || "CHAT_READ_FAILED", source });
    }
  };

  for (const entry of currentEntries) await add(entry, currentDir, SECRETARY_CHAT_DIR_RELATIVE, "current");
  items.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return { dir: SECRETARY_CHAT_DIR_RELATIVE, items, errors };
}

export async function listIndexableSecretaryChats(vaultRoot) {
  const listed = await listSecretaryChats(vaultRoot);
  const items = [];
  for (const item of listed.items) {
    try {
      const chat = await readSecretaryChat(vaultRoot, item.id);
      if (chat.chatState.privacy !== "standard" || chat.privacyClass !== "standard" || chat.indexPolicy !== "allow") continue;
      items.push(chatItem(item.id, chat, item.path, item.savedAt));
    } catch {
      // 读取或隐私验证失败时 fail closed，不进普通 Cursor 上下文。
    }
  }
  items.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return { dir: SECRETARY_CHAT_DIR_RELATIVE, items };
}

export async function readSecretaryChat(vaultRoot, chatId) {
  const id = assertSafeChatId(chatId);
  const located = await locateChat(vaultRoot, id);
  if (!located) throw new WorkbenchWriteError("找不到该存档", 404, "CHAT_NOT_FOUND");
  const body = parsePlaintextChat(await fs.readFile(located.absolute, "utf8"));
  return { id, path: located.relative, storage: "plaintext", ...body, archiveVersion: archiveVersion(body) };
}

export function saveSecretaryChat(vaultRoot, payload = {}) {
  const requestedId = payload.id != null && String(payload.id).trim() ? assertSafeChatId(payload.id) : "";
  const id = requestedId || `chat_${crypto.randomBytes(16).toString("hex")}`;
  return withSecretaryChatMutation(vaultRoot, id, async () => {
    const existing = requestedId ? await locateChat(vaultRoot, id) : null;
    let existingBody = null;
    if (existing) existingBody = parsePlaintextChat(await fs.readFile(existing.absolute, "utf8"));
    const expectedVersion = payload.expectedArchiveVersion;
    assertExpectedArchiveVersion(existingBody, expectedVersion);
    const candidate = prepareSecretaryChatDocument({
      ...payload,
      title: payload.title === undefined ? existingBody?.title : payload.title,
      messages: payload.messages === undefined ? existingBody?.messages : payload.messages,
      chatState: { ...existingBody?.chatState, ...payload.chatState },
      indexPolicy: existingBody?.indexPolicy === "never" ? "never" : payload.indexPolicy,
    });
    // 网页自动保存与原生客户端可能持有不同快照。已有存档按稳定消息 ID
    // 合并新 ID；同 ID 不同内容只有通过锁内预期版本校验才能更新。
    const body = existingBody ? prepareSecretaryChatDocument({
      ...candidate,
      messages: mergeSecretaryChatMessages(existingBody.messages, candidate.messages, expectedVersion != null),
    }, { savedAt: candidate.savedAt }) : candidate;
    for (const attachmentId of attachmentIdsFromMessages(body.messages)) {
      await assertSecretaryAttachmentExists(vaultRoot, attachmentId);
    }
    return writePlaintextSecretaryChatUnlocked(vaultRoot, payload, {
      id,
      preparedBody: body,
      absolute: existing?.absolute,
      relative: existing?.relative,
    });
  });
}

/** 建立可由跨端客户端随后写入第一条消息的空会话。 */
export function createSecretaryChat(vaultRoot, payload = {}) {
  const id = assertSafeChatId(payload.id);
  return withSecretaryChatMutation(vaultRoot, id, async () => {
    const existing = await locateChat(vaultRoot, id);
    if (existing) {
      throw new WorkbenchWriteError("这个会话编号已经存在", 409, "CHAT_ALREADY_EXISTS");
    }
    const body = prepareSecretaryChatDocument(payload, { allowEmpty: true });
    await writePlaintextSecretaryChatUnlocked(vaultRoot, payload, { id, preparedBody: body });
    return readSecretaryChat(vaultRoot, id);
  });
}

/** 在同一会话锁内读取最新版本、校验并更新标题或 chatState。 */
export function updateSecretaryChat(vaultRoot, chatId, updater) {
  const id = assertSafeChatId(chatId);
  return withSecretaryChatMutation(vaultRoot, id, async () => {
    const located = await locateChat(vaultRoot, id);
    if (!located) throw new WorkbenchWriteError("找不到该存档", 404, "CHAT_NOT_FOUND");
    const body = parsePlaintextChat(await fs.readFile(located.absolute, "utf8"));
    const current = { id, path: located.relative, storage: "plaintext", ...body, archiveVersion: archiveVersion(body) };
    const patch = await updater(current);
    if (!patch || typeof patch !== "object") return current;
    const next = prepareSecretaryChatDocument({
      ...body,
      ...patch,
      savedAt: undefined,
      title: patch.title === undefined ? body.title : patch.title,
      chatState: { ...body.chatState, ...patch.chatState },
      indexPolicy: body.indexPolicy === "never" ? "never" : patch.indexPolicy || body.indexPolicy,
      messages: body.messages,
    }, { allowEmpty: true });
    for (const attachmentId of attachmentIdsFromMessages(next.messages)) {
      await assertSecretaryAttachmentExists(vaultRoot, attachmentId);
    }
    await writePlaintextSecretaryChatUnlocked(vaultRoot, next, {
      id,
      preparedBody: next,
      absolute: located.absolute,
      relative: located.relative,
    });
    return { id, path: located.relative, storage: "plaintext", ...next, archiveVersion: archiveVersion(next) };
  });
}

function attachmentIdsFromMessages(messages) {
  const ids = new Set();
  for (const message of messages || []) {
    for (const item of message.attachments || []) if (item?.id) ids.add(String(item.id));
  }
  return ids;
}

async function collectAttachmentIdsInOtherChats(vaultRoot, exceptChatId) {
  const { items, errors } = await listSecretaryChats(vaultRoot);
  const used = new Set();
  let complete = errors.length === 0;
  for (const item of items) {
    if (item.id === exceptChatId) continue;
    try {
      const chat = await readSecretaryChat(vaultRoot, item.id);
      for (const id of attachmentIdsFromMessages(chat.messages)) used.add(id);
    } catch {
      // 引用图读不全时 fail closed：宁可暂留孤儿附件，也不删可能仍被引用的原件。
      complete = false;
    }
  }
  return { used, complete };
}

export function renameSecretaryChat(vaultRoot, chatId, rawTitle = "", options = {}) {
  const id = assertSafeChatId(chatId);
  const title = sanitizeTitle(rawTitle);
  if (!String(rawTitle || "").trim()) {
    return Promise.reject(new WorkbenchWriteError("名字不能是空的", 400, "CHAT_TITLE_EMPTY"));
  }
  return withSecretaryChatMutation(vaultRoot, id, async () => {
    const located = await locateChat(vaultRoot, id);
    if (!located) throw new WorkbenchWriteError("找不到该存档", 404, "CHAT_NOT_FOUND");
    const chat = await readSecretaryChat(vaultRoot, id);
    assertExpectedArchiveVersion(chat, options.expectedArchiveVersion);
    return writePlaintextSecretaryChatUnlocked(vaultRoot, { ...chat, title }, {
      id,
      savedAt: chat.savedAt,
      absolute: located.absolute,
      relative: located.relative,
    });
  });
}

/** 删除存档；若附件不再被其他会话引用，一并删掉。 */
export function deleteSecretaryChat(vaultRoot, chatId, options = {}) {
  const id = assertSafeChatId(chatId);
  return withSecretaryChatMutation(vaultRoot, id, async () => {
    const located = await locateChat(vaultRoot, id);
    if (!located) throw new WorkbenchWriteError("找不到该存档", 404, "CHAT_NOT_FOUND");
    const chat = await readSecretaryChat(vaultRoot, id);
    if (typeof options.beforeDelete === "function") await options.beforeDelete(chat);
    const ownAttachments = attachmentIdsFromMessages(chat.messages);
    await fs.rm(located.absolute, { force: true });

    const scan = ownAttachments.size
      ? await collectAttachmentIdsInOtherChats(vaultRoot, id)
      : { used: new Set(), complete: true };
    const removedAttachments = [];
    if (scan.complete) {
      for (const attachmentId of ownAttachments) {
        if (scan.used.has(attachmentId)) continue;
        try {
          await deleteSecretaryAttachment(vaultRoot, attachmentId, { archiveLockHeld: true });
          removedAttachments.push(attachmentId);
        } catch {
          /* 附件删失败不挡聊天删除 */
        }
      }
    }
    return {
      id,
      deleted: true,
      removedAttachments,
      attachmentCleanupDeferred: ownAttachments.size > 0 && !scan.complete,
    };
  });
}
