import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { readSecretaryChat, saveSecretaryChat } from "./workbench-secretary-chats.mjs";
import { SECRETARY_RUNTIME_DIR } from "./vault-paths.mjs";

const SCHEMA_VERSION = 1;
const CORRECTION_DIRECTORY = path.posix.join(SECRETARY_RUNTIME_DIR, "voice-corrections");
const CORRECTION_ID = /^voicefix_[a-f0-9]{32}$/u;
const MAX_TRANSCRIPT_CHARS = 2_000;
const MAX_TERM_CHARS = 80;

function clean(value, limit) {
  return String(value ?? "").replace(/\0/g, "").slice(0, limit);
}

function stableCorrectionId(payload) {
  const supplied = clean(payload?.correctionId, 64).trim();
  if (CORRECTION_ID.test(supplied)) return supplied;
  const digest = crypto.createHash("sha256").update([
    payload?.conversationId,
    payload?.messageId,
    payload?.attachmentId,
    payload?.expectedTranscript,
    payload?.correctedTranscript || payload?.selectedOriginal,
    payload?.correctedTranscript || payload?.replacement,
  ].map((value) => String(value ?? "")).join("\0")).digest("hex").slice(0, 32);
  return `voicefix_${digest}`;
}

function changedSpan(original, corrected) {
  const before = [...original];
  const after = [...corrected];
  let prefixLength = 0;
  while (prefixLength < before.length
    && prefixLength < after.length
    && before[prefixLength] === after[prefixLength]) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (suffixLength < before.length - prefixLength
    && suffixLength < after.length - prefixLength
    && before[before.length - suffixLength - 1] === after[after.length - suffixLength - 1]) {
    suffixLength += 1;
  }
  return {
    prefix: before.slice(0, prefixLength).join(""),
    selectedOriginal: before.slice(prefixLength, before.length - suffixLength).join(""),
    replacement: after.slice(prefixLength, after.length - suffixLength).join(""),
    suffix: before.slice(before.length - suffixLength).join(""),
  };
}

function locateVoiceSource(chat, messageId, attachmentId, expectedTranscript) {
  const message = chat.messages.find((item) => item.id === messageId && item.role === "user");
  const attachment = message?.attachments?.find((item) => item.id === attachmentId
    && (item.kind === "audio" || String(item.mime || "").startsWith("audio/")));
  const voiceSource = message?.voiceSources?.find((item) => item.id === attachmentId);
  // Compatibility for voice messages already persisted before voiceSources existed.
  // Their stable relation is messageId == `msg-${attachmentId}`, and the archived
  // text is exactly the transcript that the device is asking to correct.
  const legacyTextVoice = !attachment && !voiceSource
    && message?.id === `msg-${attachmentId}`
    && String(message?.content || "").trim() === expectedTranscript;
  if (!message || (!attachment && !voiceSource && !legacyTextVoice)) return null;
  return { message, attachment, voiceSource, legacyTextVoice };
}

function currentTranscript(source) {
  if (source.attachment) return String(source.attachment.transcript || "").trim();
  if (source.voiceSource) return String(source.voiceSource.transcript || "").trim();
  return String(source.message.content || "").trim();
}

function replaceTranscript(source, expectedTranscript, correctedTranscript) {
  if (source.attachment) source.attachment.transcript = correctedTranscript;
  if (source.voiceSource) source.voiceSource.transcript = correctedTranscript;
  const content = String(source.message.content || "");
  if (!source.attachment && content.trim() === expectedTranscript) {
    source.message.content = correctedTranscript;
  } else if (source.voiceSource && content.includes(expectedTranscript)) {
    source.message.content = content.replace(expectedTranscript, correctedTranscript);
  }
}

function publicRecord(record) {
  return {
    schemaVersion: record.schemaVersion,
    correctionId: record.correctionId,
    conversationId: record.conversationId,
    messageId: record.messageId,
    attachmentId: record.attachmentId,
    selectedOriginal: record.selectedOriginal,
    replacement: record.replacement,
    prefix: record.prefix,
    suffix: record.suffix,
    originalTranscript: record.originalTranscript,
    correctedTranscript: record.correctedTranscript,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt || null,
  };
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createSecretaryVoiceCorrectionService(vaultRoot, options = {}) {
  const directory = options.directory || path.join(path.resolve(vaultRoot), CORRECTION_DIRECTORY);
  const readChat = options.readChat || readSecretaryChat;
  const saveChat = options.saveChat || saveSecretaryChat;
  const now = options.now || (() => new Date());
  const locks = new Map();

  const fileFor = (id) => path.join(directory, `${id}.json`);

  async function readRecord(id) {
    if (!CORRECTION_ID.test(id)) throw new WorkbenchWriteError("纠正记录编号不合法", 400, "VOICE_CORRECTION_ID_INVALID");
    try {
      return JSON.parse(await fs.readFile(fileFor(id), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function allRecords() {
    let names;
    try { names = await fs.readdir(directory); } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => /^voicefix_[a-f0-9]{32}\.json$/u.test(name)).map(async (name) => {
      try { return JSON.parse(await fs.readFile(path.join(directory, name), "utf8")); } catch { return null; }
    }));
    return records.filter(Boolean);
  }

  function withConversationLock(conversationId, operation) {
    const previous = locks.get(conversationId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    locks.set(conversationId, current);
    return current.finally(() => {
      if (locks.get(conversationId) === current) locks.delete(conversationId);
    });
  }

  async function list() {
    const corrections = (await allRecords())
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map(publicRecord);
    const hints = [...new Set(corrections
      .filter((item) => !item.revokedAt)
      .map((item) => item.replacement.trim())
      .filter((item) => item && item.length <= 40))]
      .slice(0, 64);
    return { schemaVersion: SCHEMA_VERSION, corrections, hints };
  }

  async function apply(payload = {}) {
    const conversationId = clean(payload.conversationId, 80).trim();
    const messageId = clean(payload.messageId, 80).trim();
    const attachmentId = clean(payload.attachmentId, 80).trim();
    const expectedTranscript = clean(payload.expectedTranscript, MAX_TRANSCRIPT_CHARS).trim();
    const editedTranscript = clean(payload.correctedTranscript, MAX_TRANSCRIPT_CHARS).trim();
    const usesWholeTranscript = Object.hasOwn(payload, "correctedTranscript");
    const legacyPrefix = clean(payload.prefix, MAX_TRANSCRIPT_CHARS);
    const legacySuffix = clean(payload.suffix, MAX_TRANSCRIPT_CHARS);
    const legacyOriginal = clean(payload.selectedOriginal, MAX_TERM_CHARS);
    const legacyReplacement = clean(payload.replacement, MAX_TERM_CHARS).trim();
    if (!conversationId || !messageId || !attachmentId || !expectedTranscript
      || (usesWholeTranscript ? !editedTranscript : (!legacyOriginal || !legacyReplacement))) {
      throw new WorkbenchWriteError("纠正内容不完整", 400, "VOICE_CORRECTION_INCOMPLETE");
    }
    if (!usesWholeTranscript && `${legacyPrefix}${legacyOriginal}${legacySuffix}` !== expectedTranscript) {
      throw new WorkbenchWriteError("所选词与逐字稿上下文不一致", 409, "VOICE_CORRECTION_SELECTION_STALE");
    }
    const correctedTranscript = usesWholeTranscript
      ? editedTranscript
      : `${legacyPrefix}${legacyReplacement}${legacySuffix}`.trim();
    if (!correctedTranscript || correctedTranscript.length > MAX_TRANSCRIPT_CHARS) {
      throw new WorkbenchWriteError("纠正后的逐字稿过长或为空", 400, "VOICE_CORRECTION_RESULT_INVALID");
    }
    if (correctedTranscript === expectedTranscript) {
      throw new WorkbenchWriteError("还没有修改识别文字", 400, "VOICE_CORRECTION_UNCHANGED");
    }
    const parts = usesWholeTranscript
      ? changedSpan(expectedTranscript, correctedTranscript)
      : {
          prefix: legacyPrefix,
          selectedOriginal: legacyOriginal,
          replacement: legacyReplacement,
          suffix: legacySuffix,
        };
    const correctionId = stableCorrectionId({ ...payload, expectedTranscript, correctedTranscript });
    return withConversationLock(conversationId, async () => {
      const duplicate = await readRecord(correctionId);
      if (duplicate) {
        return {
          duplicate: true,
          correction: publicRecord(duplicate),
          transcript: duplicate.revokedAt ? duplicate.originalTranscript : duplicate.correctedTranscript,
        };
      }
      const chat = await readChat(vaultRoot, conversationId);
      const source = locateVoiceSource(chat, messageId, attachmentId, expectedTranscript);
      if (!source) throw new WorkbenchWriteError("找不到这条语音消息", 404, "VOICE_MESSAGE_NOT_FOUND");
      if (currentTranscript(source) !== expectedTranscript) {
        throw new WorkbenchWriteError("逐字稿已经变化，请重新选择要纠正的词", 409, "VOICE_TRANSCRIPT_CHANGED");
      }
      replaceTranscript(source, expectedTranscript, correctedTranscript);
      await saveChat(vaultRoot, {
        id: chat.id,
        title: chat.title,
        auto: true,
        indexPolicy: chat.indexPolicy,
        chatState: chat.chatState,
        messages: chat.messages,
      });
      const record = {
        schemaVersion: SCHEMA_VERSION,
        correctionId,
        conversationId,
        messageId,
        attachmentId,
        selectedOriginal: parts.selectedOriginal,
        replacement: parts.replacement,
        prefix: parts.prefix,
        suffix: parts.suffix,
        originalTranscript: expectedTranscript,
        correctedTranscript,
        createdAt: new Date(now()).toISOString(),
        revokedAt: null,
      };
      await atomicJson(fileFor(correctionId), record);
      return { duplicate: false, correction: publicRecord(record), transcript: correctedTranscript };
    });
  }

  async function revert(correctionId) {
    const initial = await readRecord(correctionId);
    if (!initial) throw new WorkbenchWriteError("找不到这条纠正记录", 404, "VOICE_CORRECTION_NOT_FOUND");
    return withConversationLock(initial.conversationId, async () => {
      const record = await readRecord(correctionId);
      if (record.revokedAt) return { duplicate: true, correction: publicRecord(record), transcript: record.originalTranscript };
      const chat = await readChat(vaultRoot, record.conversationId);
      const source = locateVoiceSource(chat, record.messageId, record.attachmentId, record.correctedTranscript);
      if (!source) throw new WorkbenchWriteError("找不到这条语音消息", 404, "VOICE_MESSAGE_NOT_FOUND");
      if (currentTranscript(source) !== record.correctedTranscript) {
        throw new WorkbenchWriteError("逐字稿后来又被修改，不能直接撤销", 409, "VOICE_CORRECTION_REVERT_STALE");
      }
      replaceTranscript(source, record.correctedTranscript, record.originalTranscript);
      await saveChat(vaultRoot, {
        id: chat.id,
        title: chat.title,
        auto: true,
        indexPolicy: chat.indexPolicy,
        chatState: chat.chatState,
        messages: chat.messages,
      });
      record.revokedAt = new Date(now()).toISOString();
      await atomicJson(fileFor(correctionId), record);
      return { duplicate: false, correction: publicRecord(record), transcript: record.originalTranscript };
    });
  }

  return { list, apply, revert };
}
