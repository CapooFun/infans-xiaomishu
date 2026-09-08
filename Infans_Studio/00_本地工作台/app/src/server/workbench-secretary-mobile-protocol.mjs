import crypto from "node:crypto";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import {
  createSecretaryChat,
  deleteSecretaryChat,
  listSecretaryChats,
  readSecretaryChat,
  saveSecretaryChat,
  updateSecretaryChat,
} from "./workbench-secretary-chats.mjs";
import { CURSOR_HIGH_MODEL, DEFAULT_MODEL, readSecretaryAiRuntimeStatus, streamCursor } from "./workbench-ai.mjs";
import {
  SECRETARY_ATTACHMENT_LIMITS,
  resolveSecretaryAttachments,
} from "./workbench-secretary-attachments.mjs";
import {
  CHAT_CHARACTER_REGISTRY,
  secretaryDutyStage,
  normalizeChatSpeaker,
} from "../secretary-characters.mjs";
import {
  DEFAULT_SECRETARY_ID,
  SECRETARY_PRODUCT_BRAND,
  SECRETARY_PROFILES,
  normalizeSecretaryId,
  secretaryProfileById,
} from "../secretary-identity.mjs";

export const SECRETARY_MOBILE_PROTOCOL_VERSION = 1;
export const SECRETARY_MOBILE_PROTOCOL_ID = "infans.secretary-chat.v1";
export const SECRETARY_MOBILE_MIN_CLIENT_VERSION = "1.0.0";

const TURN_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{7,71}$/u;
const CONVERSATION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{7,71}$/u;
const MAX_TEXT_CHARS = 20_000;
// 只限制模型当轮上下文；正式存档和跨端读取保留完整消息。
const MODEL_HISTORY_MESSAGES = 8;
const MAX_ATTACHMENT_TRANSCRIPT_CHARS = 2_000;
const MAX_RECENT_CONVERSATIONS = 30;
const ATTACHMENT_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,79}$/u;
const CHAT_STATE_FIELDS = new Set([
  "activeSecretaryId",
  "ordinaryBackend",
  "cursorModel",
  "privacy",
]);
const EVENT_TYPES = Object.freeze([
  "started",
  "delta",
  "speaker_changed",
  "attachment",
  "completed",
  "failed",
  "cancelled",
  "resync_required",
]);

function validInstant(value) {
  const text = String(value || "").trim();
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function stableTurnId(value, label) {
  const id = String(value || "").trim();
  if (!TURN_ID.test(id)) {
    throw new WorkbenchWriteError(`${label}必须是 8–72 位稳定标识`, 400, "NATIVE_CHAT_STABLE_ID_INVALID");
  }
  return id;
}

function stableConversationId(value) {
  const id = String(value || "").trim();
  if (!CONVERSATION_ID.test(id)) {
    throw new WorkbenchWriteError("会话 ID 必须是 8–72 位稳定标识", 400, "NATIVE_CHAT_CONVERSATION_ID_INVALID");
  }
  return id;
}

function assertProtocolVersion(payload) {
  if (Number(payload?.protocolVersion) !== SECRETARY_MOBILE_PROTOCOL_VERSION) {
    throw new WorkbenchWriteError("移动端聊天协议版本不受支持，请先重新同步启动信息", 426, "NATIVE_CHAT_PROTOCOL_UNSUPPORTED");
  }
}

function assertOnlyFields(value, allowed, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    throw new WorkbenchWriteError(`${label}含有不支持的字段：${unsupported.join("、")}`, 400, code);
  }
}

function versionConflict(expectedVersion, currentVersion) {
  const error = new WorkbenchWriteError("会话已在其他设备变化，请重新同步后再操作", 409, "NATIVE_CHAT_VERSION_CONFLICT");
  error.type = "resync_required";
  error.expectedVersion = expectedVersion;
  error.currentVersion = currentVersion;
  return error;
}

function requiredExpectedVersion(payload) {
  const version = String(payload?.expectedConversationVersion || "").trim();
  if (!version) {
    throw new WorkbenchWriteError("更新或删除会话前必须提供当前版本", 428, "NATIVE_CHAT_VERSION_REQUIRED");
  }
  return version;
}

function retryableError(error) {
  const status = Number(error?.status || error?.statusCode || 500);
  return status >= 500 || status === 409 || status === 429;
}

function protocolError(error) {
  return {
    code: String(error?.code || "NATIVE_CHAT_FAILED"),
    message: error instanceof Error ? error.message : "移动端聊天没有完成",
    retryable: retryableError(error),
  };
}

function attachmentSignature(items = []) {
  return JSON.stringify((items || []).map((item) => [String(item?.id || ""), String(item?.transcript || "")]));
}

function executionSummary(result, fallbackBackend) {
  const usage = result?.usage && typeof result.usage === "object"
    ? Object.fromEntries(Object.entries(result.usage).filter(([, value]) => Number.isFinite(Number(value))).map(([key, value]) => [key, Number(value)]))
    : null;
  return {
    backend: String(result?.backend || fallbackBackend || "") || null,
    model: String(result?.model || "") || null,
    usage: usage && Object.keys(usage).length ? usage : null,
  };
}

function conversationVersion(chat) {
  return crypto.createHash("sha256").update(JSON.stringify({
    id: chat.id,
    savedAt: chat.savedAt,
    state: chat.chatState,
    messages: (chat.messages || []).map((item) => [item.id, item.role, item.speaker || "", item.content, item.createdAt || "", item.attachments || []]),
  })).digest("hex").slice(0, 24);
}

function characterAsset(character) {
  const secretary = SECRETARY_PROFILES.find((item) => item.id === character.id);
  if (secretary) {
    return {
      avatar: secretary.chatAvatarSrc || secretary.avatarSrc || null,
      portrait: secretary.refreshPortraitSrc || secretary.avatarSrc || null,
      background: secretary.chatBackgroundSrc || null,
      source: "secretary-profile",
    };
  }
  const stage = secretaryDutyStage(character.id);
  return {
    avatar: stage?.avatarSrc || null,
    avatarPresentation: stage?.avatarSrc ? {
      position: stage.avatarPosition || "center",
      scale: stage.avatarScale || 1,
      origin: stage.avatarOrigin || "center",
    } : null,
    portrait: stage?.src || secretary?.refreshPortraitSrc || secretary?.avatarSrc || null,
    source: stage ? "chat-character-registry" : "text-fallback",
  };
}

function protocolCharacter(character) {
  return {
    id: character.id,
    displayName: character.name,
    kind: character.kind,
    secretaryEligible: Boolean(character.secretaryEligible),
    fallbackText: character.name,
    accent: character.accent || null,
    assets: characterAsset(character),
  };
}

export function secretaryMobileAttachmentDescriptor(item) {
  return {
    id: String(item.id),
    kind: item.kind || "file",
    name: item.name || "附件",
    mimeType: item.mime || "application/octet-stream",
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
    sha256: item.sha256 || null,
    createdAt: validInstant(item.createdAt),
    durationMs: Number.isFinite(Number(item.durationMs)) ? Number(item.durationMs) : null,
    transcript: item.transcript || null,
    descriptorPath: `/api/secretary-mobile/attachments/${encodeURIComponent(item.id)}`,
    resourcePath: `/api/secretary-mobile/attachments/${encodeURIComponent(item.id)}/content`,
    fallbackText: item.transcript || item.name || "附件",
  };
}

function protocolMessage(message, sequence, allMessages = null) {
  const speakerId = message.role === "assistant"
    ? normalizeChatSpeaker(message.speaker) || DEFAULT_SECRETARY_ID
    : "capoo";
  const character = message.role === "assistant"
    ? CHAT_CHARACTER_REGISTRY.find((item) => item.id === speakerId)
    : null;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(secretaryMobileAttachmentDescriptor)
    : [];
  const content = String(message.content || "");
  return {
    id: String(message.id),
    sequence,
    role: message.role,
    sender: message.role === "assistant"
      ? { id: speakerId, kind: character?.kind || "character", displayName: character?.name || speakerId }
      : { id: "capoo", kind: "user", displayName: "我" },
    createdAt: validInstant(message.createdAt),
    createdAtKnown: Boolean(validInstant(message.createdAt)),
    text: content,
    fallbackText: content || attachmentFallbackText(attachments) || "消息内容为空",
    attachments,
    deliveryStage: protocolDeliveryStage(message, allMessages),
  };
}

function protocolDeliveryStage(message, allMessages) {
  if (message.role === "assistant") return "device_available";
  const list = Array.isArray(allMessages) ? allMessages : [];
  const index = list.findIndex((item) => item.id === message.id);
  const later = index >= 0 ? list.slice(index + 1) : [];
  const hasReply = later.some((item) => {
    if (item.role === "assistant") {
      return Boolean(String(item.content || item.text || "").trim());
    }
    return false;
  });
  return hasReply ? "device_available" : "mac_persisted";
}

function attachmentFallbackText(attachments) {
  if (!attachments.length) return "";
  const kinds = attachments.map((item) => {
    const mime = String(item.mimeType || "").toLowerCase();
    const kind = String(item.kind || "").toLowerCase();
    if (mime.startsWith("image/") || kind === "image") return "image";
    if (mime.startsWith("audio/") || kind === "audio") return "audio";
    return "file";
  });
  if (kinds.every((kind) => kind === "image")) {
    return attachments.length === 1 ? "发送了一张图片" : `发送了 ${attachments.length} 张图片`;
  }
  if (kinds.every((kind) => kind === "audio")) {
    return attachments.length === 1 ? "发送了一段录音" : `发送了 ${attachments.length} 段录音`;
  }
  if (kinds.every((kind) => kind === "file")) {
    return attachments.length === 1 ? "发送了一个文件" : `发送了 ${attachments.length} 个文件`;
  }
  return `发送了 ${attachments.length} 个附件`;
}

function protocolConversation(chat) {
  const activeSecretaryId = normalizeSecretaryId(chat.chatState?.activeSecretaryId) || DEFAULT_SECRETARY_ID;
  const sourceMessages = chat.messages || [];
  const messages = sourceMessages.map((message, index) => protocolMessage(message, index + 1, sourceMessages));
  return {
    id: chat.id,
    version: conversationVersion(chat),
    type: "direct",
    title: chat.title,
    privacy: "standard",
    activeSecretaryId,
    memberIds: ["capoo", activeSecretaryId],
    chatState: {
      activeSecretaryId,
      privacy: "standard",
      ordinaryBackend: "",
      cursorModel: "",
    },
    updatedAt: validInstant(chat.savedAt),
    messageCount: messages.length,
    messages,
  };
}

function conversationSummary(conversation) {
  const last = conversation.messages.at(-1) || null;
  return {
    id: conversation.id,
    version: conversation.version,
    type: conversation.type,
    title: conversation.title,
    privacy: conversation.privacy,
    activeSecretaryId: conversation.activeSecretaryId,
    memberIds: conversation.memberIds,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messageCount,
    lastMessage: last ? {
      id: last.id,
      sender: last.sender,
      createdAt: last.createdAt,
      fallbackText: conversation.privacy === "private" ? "内容已隐藏" : last.fallbackText.slice(0, 120),
    } : null,
  };
}

async function readExistingConversation(root, id, readChat) {
  try {
    return await readChat(root, id);
  } catch (error) {
    if (error?.code === "CHAT_NOT_FOUND" || Number(error?.status) === 404) return null;
    throw error;
  }
}

function normalizedReplies(result, streamed, activeSecretaryId, assistantBaseId, nowIso, allowedSpeakerIds = null) {
  const allowed = Array.isArray(allowedSpeakerIds) ? new Set(allowedSpeakerIds) : null;
  const rows = Array.isArray(result?.replies) ? result.replies : [];
  const replies = rows.flatMap((item, index) => {
    const speaker = normalizeChatSpeaker(item?.speaker);
    const content = String(item?.content || "").trim();
    if (!speaker || !content || allowed && !allowed.has(speaker)) return [];
    return [{ id: `${assistantBaseId}:${index + 1}`, role: "assistant", speaker, content, createdAt: nowIso }];
  });
  if (replies.length) return replies;
  const content = String(result?.answer || streamed || result?.message || "").trim();
  return content ? [{ id: assistantBaseId, role: "assistant", speaker: activeSecretaryId, content, createdAt: nowIso }] : [];
}

function normalizeTurn(payload, defaultConversationId, nowIso) {
  assertProtocolVersion(payload);
  assertOnlyFields(payload, new Set([
    "protocolVersion", "conversationId", "messageId", "generationId", "createdAt", "text",
    "expectedConversationVersion", "attachments", "autoChat",
  ]), "NATIVE_CHAT_TURN_FIELD_UNSUPPORTED", "发送消息请求");
  const rawAttachments = payload?.attachments == null ? [] : payload.attachments;
  if (!Array.isArray(rawAttachments)) {
    throw new WorkbenchWriteError("附件引用必须是数组", 400, "NATIVE_CHAT_ATTACHMENTS_INVALID");
  }
  if (rawAttachments.length > SECRETARY_ATTACHMENT_LIMITS.maximumPerTurn) {
    throw new WorkbenchWriteError(`每条消息最多附带 ${SECRETARY_ATTACHMENT_LIMITS.maximumPerTurn} 个附件`, 400, "NATIVE_CHAT_ATTACHMENTS_INVALID");
  }
  const attachmentIds = new Set();
  const attachments = rawAttachments.map((item) => {
    assertOnlyFields(item, new Set(["id", "transcript"]), "NATIVE_CHAT_ATTACHMENT_FIELD_UNSUPPORTED", "附件引用");
    const id = String(item?.id || "").trim();
    if (!ATTACHMENT_ID.test(id) || attachmentIds.has(id)) {
      throw new WorkbenchWriteError("附件 ID 不合法或重复", 400, "NATIVE_CHAT_ATTACHMENTS_INVALID");
    }
    attachmentIds.add(id);
    const transcript = String(item?.transcript || "").trim();
    if (transcript.length > MAX_ATTACHMENT_TRANSCRIPT_CHARS) {
      throw new WorkbenchWriteError("附件转写过长", 400, "NATIVE_CHAT_ATTACHMENT_TRANSCRIPT_INVALID");
    }
    return { id, ...(transcript ? { transcript } : {}) };
  });
  const text = String(payload?.text || "").trim();
  if ((!text && !attachments.length) || text.length > MAX_TEXT_CHARS) {
    throw new WorkbenchWriteError("消息必须含有文字或附件，文字最多 20000 个字符", 400, "NATIVE_CHAT_TEXT_INVALID");
  }
  if (payload?.autoChat) {
    throw new WorkbenchWriteError("开源版只有一对一聊天", 400, "NATIVE_CHAT_AUTO_MODE_INVALID");
  }
  const createdAt = validInstant(payload?.createdAt || nowIso);
  if (!createdAt) {
    throw new WorkbenchWriteError("消息时间不合法", 400, "NATIVE_CHAT_TIME_INVALID");
  }
  return {
    conversationId: stableConversationId(payload?.conversationId || defaultConversationId),
    messageId: stableTurnId(payload?.messageId, "消息 ID"),
    generationId: stableTurnId(
      payload?.generationId || `gen-${crypto.createHash("sha256").update(String(payload?.messageId || "")).digest("hex").slice(0, 24)}`,
      "生成 ID",
    ),
    createdAt,
    text,
    attachments,
    autoChat: false,
    expectedConversationVersion: String(payload?.expectedConversationVersion || "").trim(),
  };
}

function normalizeInternalVoiceSources(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.flatMap((item) => {
    const id = String(item?.id || "").trim();
    const transcript = String(item?.transcript || "").trim().slice(0, MAX_ATTACHMENT_TRANSCRIPT_CHARS);
    if (!ATTACHMENT_ID.test(id) || seen.has(id) || !transcript) return [];
    seen.add(id);
    return [{
      id,
      mime: String(item?.mime || item?.mimeType || "audio/mp4").slice(0, 120),
      ...(Number(item?.durationMs) > 0 ? { durationMs: Math.round(Number(item.durationMs)) } : {}),
      transcript,
    }];
  }).slice(0, SECRETARY_ATTACHMENT_LIMITS.maximumPerTurn);
}

function normalizedChatStatePatch(current, rawPatch) {
  if (rawPatch == null) return {};
  if (typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
    throw new WorkbenchWriteError("会话状态必须是对象", 400, "NATIVE_CHAT_STATE_INVALID");
  }
  const activeSecretaryId = rawPatch.activeSecretaryId === undefined
    ? normalizeSecretaryId(current.chatState?.activeSecretaryId) || DEFAULT_SECRETARY_ID
    : normalizeSecretaryId(rawPatch.activeSecretaryId);
  if (!activeSecretaryId || !secretaryProfileById(activeSecretaryId)?.secretaryEligible) {
    throw new WorkbenchWriteError("当前值班角色不是已登记秘书", 400, "NATIVE_CHAT_CHARACTER_INVALID");
  }
  if (rawPatch.ordinaryBackend !== undefined && String(rawPatch.ordinaryBackend || "").trim()) {
    throw new WorkbenchWriteError("开源版不内置对话模型", 400, "NATIVE_CHAT_ORDINARY_BACKEND_INVALID");
  }
  if (rawPatch.cursorModel !== undefined && String(rawPatch.cursorModel || "").trim()) {
    throw new WorkbenchWriteError("开源版不内置对话模型", 400, "NATIVE_CHAT_CURSOR_MODEL_INVALID");
  }
  return {
    activeSecretaryId,
    privacy: "standard",
    ordinaryBackend: "",
    cursorModel: "",
  };
}

export function createSecretaryMobileProtocolService(root, options = {}) {
  const readChat = options.readChat || readSecretaryChat;
  const listChats = options.listChats || listSecretaryChats;
  const saveChat = options.saveChat || saveSecretaryChat;
  const createChat = options.createChat || createSecretaryChat;
  const updateChat = options.updateChat || updateSecretaryChat;
  const deleteChat = options.deleteChat || deleteSecretaryChat;
  const generateReply = options.generateReply || ((payload, hooks) => streamCursor(root, payload, hooks));
  const resolveAttachments = options.resolveAttachments || ((ids) => resolveSecretaryAttachments(root, ids));
  const readAiStatus = options.readAiStatus || (() => readSecretaryAiRuntimeStatus(root));
  const readActiveSecretary = options.readActiveSecretary || (async () => ({ activeSecretaryId: DEFAULT_SECRETARY_ID }));
  const readRelationshipMemory = options.readRelationshipMemory || (async () => null);
  const actionService = options.actionService || null;
  const now = options.now || (() => new Date());
  const serviceVersion = String(options.serviceVersion || "unknown");
  const inFlight = new Map();
  const deletingConversations = new Set();

  const nowIso = () => {
    const value = now();
    return new Date(value instanceof Date ? value.getTime() : value).toISOString();
  };

  async function activeSecretaryId() {
    const state = await readActiveSecretary();
    return normalizeSecretaryId(state?.activeSecretaryId) || DEFAULT_SECRETARY_ID;
  }

  function conversationIsInFlight(id) {
    const prefix = `${id}\0`;
    return [...inFlight.keys()].some((key) => key.startsWith(prefix));
  }

  async function listConversations(settings = {}) {
    const listed = await listChats(root);
    const conversations = [];
    const errors = [...(listed.errors || [])];
    const limit = Number.isInteger(settings.limit) && settings.limit >= 0 ? settings.limit : null;
    const items = limit === null ? (listed.items || []) : (listed.items || []).slice(0, limit);
    for (const item of items) {
      try {
        conversations.push(conversationSummary(protocolConversation(await readChat(root, item.id))));
      } catch (error) {
        errors.push({ id: item.id, code: error?.code || "NATIVE_CHAT_READ_FAILED" });
      }
    }
    return { conversations, errors, complete: limit === null };
  }

  async function bootstrap() {
    const secretaryId = await activeSecretaryId();
    const profile = secretaryProfileById(secretaryId) || secretaryProfileById(DEFAULT_SECRETARY_ID);
    const recent = await listConversations({ limit: MAX_RECENT_CONVERSATIONS });
    const aiStatus = await readAiStatus().catch(() => null);
    const openrouterUsage = aiStatus?.usage?.openrouter || {
      available: false,
      readOnly: true,
      reason: "runtime-status-unavailable",
    };
    return {
      protocol: {
        id: SECRETARY_MOBILE_PROTOCOL_ID,
        version: SECRETARY_MOBILE_PROTOCOL_VERSION,
        minimumClientVersion: SECRETARY_MOBILE_MIN_CLIENT_VERSION,
        eventTypes: EVENT_TYPES,
        endpoints: {
          bootstrap: "GET /api/secretary-mobile/bootstrap",
          listConversations: "GET /api/secretary-mobile/conversations",
          conversation: "GET /api/secretary-mobile/conversations/:id",
          createConversation: "POST /api/secretary-mobile/conversations",
          updateConversation: "PATCH /api/secretary-mobile/conversations/:id",
          deleteConversation: "DELETE /api/secretary-mobile/conversations/:id",
          streamTurn: "POST /api/secretary-mobile/turns/stream",
          cancelTurn: "POST /api/secretary-mobile/turns/cancel",
          persistMailboxMessage: "POST /api/secretary-mobile/mailbox/messages",
          claimMailboxMessage: "POST /api/secretary-mobile/mailbox/claim",
          completeMailboxReply: "POST /api/secretary-mobile/mailbox/complete",
          syncMailbox: "GET /api/secretary-mobile/mailbox/sync",
          uploadAttachment: "POST /api/secretary-mobile/attachments",
          attachment: "GET /api/secretary-mobile/attachments/:id",
          attachmentContent: "GET /api/secretary-mobile/attachments/:id/content",
          controlledActions: "GET /api/secretary-mobile/conversations/:id/actions",
          controlledActionDecision: "POST /api/secretary-mobile/actions/:id/decision",
          voiceCorrections: "GET|POST /api/secretary-mobile/voice-corrections",
          revertVoiceCorrection: "POST /api/secretary-mobile/voice-corrections/:id/revert",
          speechStatus: "GET /api/secretary-mobile/tts/status",
          synthesizeSpeech: "POST /api/secretary-mobile/tts",
        },
        authentication: {
          scheme: "Bearer",
          credential: "existing-device-token",
          contentType: "application/json",
          binaryUploadContentType: "selected-attachment-mime",
          readContentTypeRequired: false,
        },
        idempotency: {
          messageId: "stable-across-retries",
          generationId: "stable-across-retries",
          duplicateResult: "same-persisted-messages",
        },
        resume: {
          cursorField: "cursor",
          cursorScope: "single-ndjson-response",
          partialDeltaReplay: false,
          afterDisconnect: "retry-with-same-ids-then-resync-conversation",
        },
        attachments: {
          ...SECRETARY_ATTACHMENT_LIMITS,
          stableIdHeader: "X-Infans-Attachment-Id",
          metadataFields: ["id", "kind", "name", "mimeType", "size", "sha256", "createdAt", "durationMs", "transcript"],
        },
        conversationMutation: {
          expectedVersionField: "expectedConversationVersion",
          conflict: { status: 409, type: "resync_required" },
          mutableFields: ["title", "chatState"],
          mutableChatStateFields: [...CHAT_STATE_FIELDS],
          allowedPrivacy: ["standard"],
          allowedOrdinaryBackends: [],
          allowedCursorModels: [],
        },
        deliveryBoundaries: ["local_queued", "mac_received", "mac_persisted", "reply_generating", "device_available"],
      },
      service: { version: serviceVersion, reachable: true },
      identity: { valid: true, needsPairing: false },
      product: { id: "infans-secretary", name: SECRETARY_PRODUCT_BRAND },
      activeSecretaryId: secretaryId,
      defaultConversationId: `native_${secretaryId}_default`,
      characters: CHAT_CHARACTER_REGISTRY.map(protocolCharacter),
      assets: { version: "registry-v1", manifestAvailable: false, fallbackCharacterId: profile?.id || DEFAULT_SECRETARY_ID },
      modelRuntime: {
        ordinary: {
          selected: "",
          options: [],
        },
      },
      usage: {
        openrouter: openrouterUsage,
        cursor: aiStatus?.usage?.cursor || { available: false, readOnly: true, reason: "not-reported-by-runtime" },
      },
      features: {
        textChat: true,
        streamingReplies: true,
        reliableRetry: true,
        cancellation: true,
        conversationList: true,
        conversationCreate: true,
        conversationRename: true,
        conversationStateControl: true,
        conversationDelete: true,
        attachments: true,
        modelSelection: true,
        usageSummary: openrouterUsage.available === true,
        controlledActions: Boolean(actionService),
        voice: true,
        notifications: false,
      },
      recentConversations: recent.conversations,
      warnings: recent.errors,
    };
  }

  async function readConversation(id) {
    return protocolConversation(await readChat(root, stableConversationId(id)));
  }

  async function listActions(id) {
    const conversationId = stableConversationId(id);
    if (!actionService) return { actions: [] };
    return actionService.list(conversationId);
  }

  async function decideAction(id, payload = {}) {
    if (!actionService) throw new WorkbenchWriteError("移动端受控写入尚未启用", 404, "NATIVE_CHAT_ACTIONS_UNAVAILABLE");
    assertProtocolVersion(payload);
    assertOnlyFields(payload, new Set(["protocolVersion", "conversationId", "generationId", "decision"]), "NATIVE_CHAT_ACTION_DECISION_FIELD_UNSUPPORTED", "受控写入决定请求");
    const actionId = String(id || "").trim();
    if (!/^action_[a-f0-9]{32}$/u.test(actionId)) throw new WorkbenchWriteError("受控写入 ID 不正确", 400, "NATIVE_CHAT_ACTION_ID_INVALID");
    const conversationId = stableConversationId(payload.conversationId);
    const generationId = stableTurnId(payload.generationId, "生成 ID");
    const decision = String(payload.decision || "");
    if (decision !== "confirm" && decision !== "cancel") throw new WorkbenchWriteError("决定只能是确认或取消", 400, "NATIVE_CHAT_ACTION_DECISION_INVALID");
    return actionService.decide(actionId, { conversationId, generationId, decision });
  }

  async function createConversation(payload = {}) {
    assertProtocolVersion(payload);
    assertOnlyFields(payload, new Set(["protocolVersion", "conversationId", "title", "activeSecretaryId"]), "NATIVE_CHAT_CREATE_FIELD_UNSUPPORTED", "新建会话请求");
    const id = stableConversationId(payload.conversationId);
    const existing = await readExistingConversation(root, id, readChat);
    if (existing) return { created: false, duplicate: true, conversation: protocolConversation(existing) };
    const secretaryId = payload.activeSecretaryId === undefined
      ? await activeSecretaryId()
      : normalizeSecretaryId(payload.activeSecretaryId);
    const profile = secretaryId ? secretaryProfileById(secretaryId) : null;
    if (!profile?.secretaryEligible) {
      throw new WorkbenchWriteError("所选人物不是已登记秘书", 400, "NATIVE_CHAT_CHARACTER_INVALID");
    }
    const title = String(payload.title || `与${profile?.name || "小秘书"}的对话`).trim();
    if (!title) throw new WorkbenchWriteError("会话标题不能为空", 400, "NATIVE_CHAT_TITLE_INVALID");
    try {
      const chat = await createChat(root, {
        id,
        title,
        auto: true,
        chatState: {
          activeSecretaryId: secretaryId,
          privacy: "standard",
          ordinaryBackend: "",
          cursorModel: "",
        },
        messages: [],
      });
      return { created: true, duplicate: false, conversation: protocolConversation(chat) };
    } catch (error) {
      if (error?.code !== "CHAT_ALREADY_EXISTS") throw error;
      return { created: false, duplicate: true, conversation: protocolConversation(await readChat(root, id)) };
    }
  }

  async function updateConversation(id, payload = {}) {
    assertProtocolVersion(payload);
    assertOnlyFields(payload, new Set(["protocolVersion", "expectedConversationVersion", "title", "chatState"]), "NATIVE_CHAT_UPDATE_FIELD_UNSUPPORTED", "更新会话请求");
    const conversationId = stableConversationId(id);
    const expectedVersion = requiredExpectedVersion(payload);
    if (conversationIsInFlight(conversationId) || deletingConversations.has(conversationId)) {
      throw new WorkbenchWriteError("会话正在生成或删除，请稍后重新同步", 409, "NATIVE_CHAT_CONVERSATION_BUSY");
    }
    const title = payload.title === undefined ? undefined : String(payload.title).trim();
    if (title !== undefined && !title) {
      throw new WorkbenchWriteError("会话标题不能为空", 400, "NATIVE_CHAT_TITLE_INVALID");
    }
    const chat = await updateChat(root, conversationId, async (current) => {
      const currentProtocol = protocolConversation(current);
      if (currentProtocol.version !== expectedVersion) throw versionConflict(expectedVersion, currentProtocol.version);
      const chatState = normalizedChatStatePatch(current, payload.chatState);
      return {
        ...(title === undefined ? {} : { title }),
        chatState,
      };
    });
    return { conversation: protocolConversation(chat) };
  }

  async function deleteConversation(id, payload = {}) {
    assertProtocolVersion(payload);
    assertOnlyFields(payload, new Set(["protocolVersion", "expectedConversationVersion"]), "NATIVE_CHAT_DELETE_FIELD_UNSUPPORTED", "删除会话请求");
    const conversationId = stableConversationId(id);
    const expectedVersion = requiredExpectedVersion(payload);
    if (conversationIsInFlight(conversationId)) {
      throw new WorkbenchWriteError("会话仍在生成，不能删除", 409, "NATIVE_CHAT_CONVERSATION_BUSY");
    }
    deletingConversations.add(conversationId);
    try {
      return await deleteChat(root, conversationId, {
        beforeDelete: (current) => {
          const currentVersion = protocolConversation(current).version;
          if (currentVersion !== expectedVersion) throw versionConflict(expectedVersion, currentVersion);
        },
      });
    } finally {
      deletingConversations.delete(conversationId);
    }
  }

  async function streamTurn(payload, emit = () => undefined, internal = {}) {
    let turn = null;
    let key = "";
    let controller = null;
    let eventCursor = 0;
    const push = (event) => emit({ ...event, cursor: ++eventCursor });
    try {
      const secretaryId = await activeSecretaryId();
      turn = normalizeTurn(payload, `native_${secretaryId}_default`, nowIso());
      const voiceSources = normalizeInternalVoiceSources(internal.voiceSources);
      if (deletingConversations.has(turn.conversationId)) {
        throw new WorkbenchWriteError("会话正在删除，请重新同步", 409, "NATIVE_CHAT_CONVERSATION_BUSY");
      }
      key = `${turn.conversationId}\0${turn.generationId}`;
      let existing = await readExistingConversation(root, turn.conversationId, readChat);
      const existingProtocol = existing ? protocolConversation(existing) : null;
      if (turn.expectedConversationVersion && existingProtocol?.version !== turn.expectedConversationVersion) {
        push({
          type: "resync_required",
          conversationId: turn.conversationId,
          expectedVersion: turn.expectedConversationVersion,
          currentVersion: existingProtocol?.version || null,
          fallbackText: "会话已在其他设备变化，请重新同步后再发送。",
        });
        return { ok: false, resyncRequired: true };
      }

      const resolved = await resolveAttachments(turn.attachments.map((item) => item.id));
      const references = new Map(turn.attachments.map((item) => [item.id, item]));
      const inputAttachments = resolved.map((item) => ({
        ...item,
        ...(references.get(item.id)?.transcript ? { transcript: references.get(item.id).transcript } : {}),
      }));
      if (inputAttachments.length !== turn.attachments.length) {
        throw new WorkbenchWriteError("附件引用不完整", 404, "ATTACHMENT_NOT_FOUND");
      }
      const matchingUser = existing?.messages?.find((item) => item.id === turn.messageId);
      if (matchingUser && (matchingUser.role !== "user"
        || matchingUser.content !== turn.text
        || attachmentSignature(matchingUser.attachments) !== attachmentSignature(inputAttachments))) {
        throw new WorkbenchWriteError("同一消息 ID 已对应不同内容", 409, "NATIVE_CHAT_IDEMPOTENCY_CONFLICT");
      }
      const assistantBaseId = `reply-${turn.generationId}`.slice(0, 74);
      const cachedReplies = existing?.messages?.filter((item) => item.id === assistantBaseId || item.id.startsWith(`${assistantBaseId}:`)) || [];
      if (cachedReplies.length) {
        const conversation = protocolConversation(existing);
        push({
          type: "started",
          conversationId: turn.conversationId,
          generationId: turn.generationId,
          duplicate: true,
          deliveryStage: "mac_persisted",
          ...(turn.autoChat
            ? { autoContinuation: true }
            : { userMessage: protocolMessage(matchingUser, existing.messages.indexOf(matchingUser) + 1, existing.messages) }),
        });
        const recoveredActions = actionService
          ? await actionService.list(turn.conversationId, turn.generationId).then((value) => value.actions).catch(() => [])
          : [];
        for (const card of recoveredActions) push({ type: "attachment", conversationId: turn.conversationId, generationId: turn.generationId, card });
        push({
          type: "completed",
          conversationId: turn.conversationId,
          generationId: turn.generationId,
          duplicate: true,
          conversationVersion: conversation.version,
          messages: cachedReplies.map((item) => protocolMessage(item, existing.messages.indexOf(item) + 1, existing.messages)),
          inputAttachments: inputAttachments.map(secretaryMobileAttachmentDescriptor),
          ...(recoveredActions.length ? { actions: recoveredActions } : {}),
          ...(turn.autoChat ? { autoContinuation: true } : {}),
        });
        return { ok: true, duplicate: true, conversation };
      }
      if (inFlight.has(key)) {
        push({
          type: "resync_required",
          conversationId: turn.conversationId,
          generationId: turn.generationId,
          reason: "generation_in_progress",
          retryAfterMs: 800,
          fallbackText: "这条回复仍在 Mac 上生成，请稍后重新同步。",
          ...(turn.autoChat ? { autoContinuation: true } : {}),
        });
        return { ok: false, inProgress: true };
      }

      controller = new AbortController();
      inFlight.set(key, controller);

      if (!turn.autoChat && !matchingUser) {
        const activeId = normalizeSecretaryId(existing?.chatState?.activeSecretaryId) || secretaryId;
        const profile = secretaryProfileById(activeId) || secretaryProfileById(DEFAULT_SECRETARY_ID);
        await saveChat(root, {
          id: turn.conversationId,
          title: existing?.title || `与${profile?.name || "小秘书"}的对话`,
          auto: true,
          indexPolicy: existing?.indexPolicy,
          chatState: existing?.chatState || {
            activeSecretaryId: activeId,
            privacy: "standard",
          },
          messages: [
            ...(existing?.messages || []),
            {
              id: turn.messageId,
              role: "user",
              content: turn.text,
              createdAt: turn.createdAt,
              attachments: inputAttachments,
              ...(voiceSources.length ? { voiceSources } : {}),
            },
          ],
        });
        existing = await readChat(root, turn.conversationId);
      }

      const persisted = protocolConversation(existing);
      push({
        type: "started",
        conversationId: turn.conversationId,
        generationId: turn.generationId,
        deliveryStage: turn.autoChat ? "reply_generating" : "mac_persisted",
        conversationVersion: persisted.version,
        ...(turn.autoChat ? {
          autoContinuation: true,
        } : {
          userMessageId: turn.messageId,
          persistedAt: existing.savedAt,
          userMessage: persisted.messages.find((item) => item.id === turn.messageId),
        }),
      });

      const activeId = normalizeSecretaryId(existing.chatState?.activeSecretaryId) || secretaryId;
      const allowedSpeakers = [activeId];
      const history = existing.messages
        .filter((item) => item.id !== turn.messageId)
        .slice(-MODEL_HISTORY_MESSAGES)
        .map((item) => ({ role: item.role, content: item.content, ...(item.speaker ? { speaker: item.speaker } : {}) }));
      const relationshipMemory = await readRelationshipMemory(activeId).catch(() => null);
      const extraContexts = relationshipMemory?.content ? [{
        source: `infans:relationship-memory:${activeId}`,
        text: `当前秘书经使用者确认的关系记忆原件：\n${relationshipMemory.content.slice(0, 12_000)}\n只把“已确认”内容当事实；待确认候选不能当事实，也不得自动写回。`,
      }] : [];
      let streamed = "";
      let proposedActions = [];
      const result = await generateReply({
        question: turn.text,
        history,
        taskWindowId: turn.conversationId,
        activeSecretaryId: activeId,
        ordinaryBackend: "",
        cursorModel: "",
        attachments: inputAttachments.map((item) => item.id),
        voiceTranscript: inputAttachments.filter((item) => item.kind === "audio" && item.transcript).map((item) => item.transcript).join("\n"),
      }, {
        signal: controller.signal,
        extraContexts,
        onChunk: (text) => {
          const delta = String(text || "");
          streamed += delta;
          if (delta) push({ type: "delta", conversationId: turn.conversationId, generationId: turn.generationId, messageId: assistantBaseId, text: delta });
        },
        onActions: (actions) => {
          proposedActions = Array.isArray(actions) ? actions : [];
        },
        onExternalUsage: options.onExternalUsage,
      });
      if (controller.signal.aborted) {
        push({ type: "cancelled", conversationId: turn.conversationId, generationId: turn.generationId, retryable: true });
        return { ok: false, cancelled: true };
      }
      if (!result?.ok) {
        throw new WorkbenchWriteError(String(result?.message || "小秘书没有生成可保存的回复"), 503, String(result?.code || "NATIVE_CHAT_REPLY_FAILED"));
      }
      const replyTime = nowIso();
      const replies = normalizedReplies(
        result,
        streamed,
        allowedSpeakers[0] || activeId,
        assistantBaseId,
        replyTime,
        allowedSpeakers,
      );
      if (!replies.length) {
        throw new WorkbenchWriteError("小秘书没有生成可读的回复", 503, "NATIVE_CHAT_REPLY_EMPTY");
      }
      const latest = await readChat(root, turn.conversationId);
      const withoutReply = latest.messages.filter((item) => item.id !== assistantBaseId && !item.id.startsWith(`${assistantBaseId}:`));
      const latestHasUser = withoutReply.some((item) => item.id === turn.messageId);
      const nextMessages = [
        ...withoutReply,
        ...(turn.autoChat || latestHasUser ? [] : [{
          id: turn.messageId,
          role: "user",
          content: turn.text,
          createdAt: turn.createdAt,
          attachments: inputAttachments,
          ...(voiceSources.length ? { voiceSources } : {}),
        }]),
        ...replies,
      ];
      await saveChat(root, {
        id: turn.conversationId,
        title: latest.title,
        auto: true,
        indexPolicy: "allow",
        chatState: {
          activeSecretaryId: normalizeSecretaryId(latest.chatState?.activeSecretaryId) || activeId,
          privacy: "standard",
          ordinaryBackend: "",
          cursorModel: "",
        },
        messages: nextMessages,
      });
      const completed = protocolConversation(await readChat(root, turn.conversationId));
      const completedMessages = completed.messages.filter((item) => item.id === assistantBaseId || item.id.startsWith(`${assistantBaseId}:`));
      const registeredActions = actionService ? await actionService.register({
        conversationId: turn.conversationId,
        generationId: turn.generationId,
        assistantMessageId: completedMessages[0]?.id || assistantBaseId,
        actions: Array.isArray(result.actions) ? result.actions : proposedActions,
      }).then((value) => value.actions).catch(() => []) : [];
      for (const card of registeredActions) push({ type: "attachment", conversationId: turn.conversationId, generationId: turn.generationId, card });
      push({
        type: "completed",
        conversationId: turn.conversationId,
        generationId: turn.generationId,
        conversationVersion: completed.version,
        messages: completedMessages,
        inputAttachments: inputAttachments.map(secretaryMobileAttachmentDescriptor),
        ...(registeredActions.length ? { actions: registeredActions } : {}),
        execution: executionSummary(result, existing.chatState?.ordinaryBackend),
        ...(turn.autoChat ? { autoContinuation: true } : {}),
      });
      return { ok: true, duplicate: false, conversation: completed };
    } catch (error) {
      if (controller?.signal.aborted && turn) {
        push({ type: "cancelled", conversationId: turn.conversationId, generationId: turn.generationId, retryable: true });
        return { ok: false, cancelled: true };
      }
      const details = protocolError(error);
      push({
        type: "failed",
        ...(turn ? { conversationId: turn.conversationId, generationId: turn.generationId } : {}),
        ...(turn?.autoChat ? { autoContinuation: true } : {}),
        ...details,
      });
      return { ok: false, error: details };
    } finally {
      if (key && inFlight.get(key) === controller) inFlight.delete(key);
    }
  }

  function cancel(payload = {}) {
    const conversationId = String(payload.conversationId || "").trim();
    const generationId = stableTurnId(payload.generationId, "生成 ID");
    const controller = inFlight.get(`${conversationId}\0${generationId}`);
    if (!controller) return { cancelled: false, reason: "not_in_flight" };
    controller.abort();
    return { cancelled: true, conversationId, generationId };
  }

  return {
    bootstrap,
    listConversations,
    readConversation,
    listActions,
    decideAction,
    createConversation,
    updateConversation,
    deleteConversation,
    streamTurn,
    cancel,
  };
}
