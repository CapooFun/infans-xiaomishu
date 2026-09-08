import {
  PUBLIC_THREAD_KEY,
  browserSessionLooksPrivate,
  publicThreadStorageKey,
  assistantShiftIsPublic,
} from "./opensource-chat-session.mjs";

export function normalizeOneOnOneMessages(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((item) => item && typeof item === "object")
    .filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .map((item, index) => ({
      id: String(item.id || `restored-${index}`),
      role: item.role,
      content: String(item.content),
      speaker: item.role === "assistant" && typeof item.speaker === "string" ? item.speaker : undefined,
      sources: Array.isArray(item.sources) ? item.sources.map(String) : undefined,
      attachments: Array.isArray(item.attachments) ? item.attachments : undefined,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
      voiceSources: Array.isArray(item.voiceSources) ? item.voiceSources : undefined,
    }));
}

export function emptyOneOnOneSession() {
  return {
    messages: [],
    archiveId: null,
    title: "",
    archiveVersion: undefined,
    saveConflict: false,
    hasBufferedBody: false,
    bufferedMessageCount: 0,
    generation: 0,
  };
}

export function parseOneOnOneSession(raw, residentSpeaker = "yinyue") {
  if (!raw) return emptyOneOnOneSession();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyOneOnOneSession();
  }
  if (browserSessionLooksPrivate(parsed)) return emptyOneOnOneSession();
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.schemaVersion === 2) {
    return {
      ...emptyOneOnOneSession(),
      archiveId: typeof parsed.archiveId === "string" && parsed.archiveId.trim() ? parsed.archiveId.trim() : null,
    };
  }
  const messages = normalizeOneOnOneMessages(
    Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.messages) ? parsed.messages : []),
  );
  if (!assistantShiftIsPublic(messages, residentSpeaker)) return emptyOneOnOneSession();
  const generation = Number.isFinite(Number(parsed?.generation)) ? Number(parsed.generation) : messages.length;
  return {
    messages,
    archiveId: parsed && typeof parsed.archiveId === "string" && parsed.archiveId.trim() ? parsed.archiveId.trim() : null,
    title: parsed && typeof parsed.title === "string" ? parsed.title : "",
    archiveVersion: parsed && typeof parsed.archiveVersion === "string" ? parsed.archiveVersion : undefined,
    saveConflict: parsed?.saveConflict === true,
    hasBufferedBody: messages.length > 0,
    bufferedMessageCount: messages.length,
    generation,
  };
}

export function serializeOneOnOneSession(session, residentSpeaker = "yinyue") {
  if (browserSessionLooksPrivate(session) || !assistantShiftIsPublic(session.messages, residentSpeaker)) {
    return null;
  }
  const messages = (session.messages || []).filter((item) => !item.pending && (String(item.content || "").trim() || item.attachments?.length));
  return JSON.stringify({
    schemaVersion: 8,
    archiveId: session.archiveId || null,
    archiveVersion: session.archiveVersion || undefined,
    saveConflict: Boolean(session.saveConflict),
    title: session.title || "",
    activeSecretaryId: residentSpeaker || "yinyue",
    generation: Number.isFinite(Number(session.generation)) ? Number(session.generation) : messages.length,
    messages,
  });
}

export function shouldAutoApplyDiskArchive(session) {
  const archiveId = typeof session?.archiveId === "string" && session.archiveId.trim() ? session.archiveId.trim() : null;
  if (!archiveId) return false;
  if (session?.saveConflict === true) return false;
  if (session?.migratedLegacyPlaintext) return false;
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  if (session?.hasBufferedBody === true || messages.length > 0) return false;
  if (Number(session?.generation) > 0 && messages.length > 0) return false;
  return true;
}

export async function resolveInstanceStorageKey(healthPayload, response) {
  if (!response || !response.ok) {
    throw new Error("IDENTITY_HTTP");
  }
  const instanceId = String(healthPayload?.instanceId || "").trim();
  if (!instanceId) throw new Error("IDENTITY_MISSING");
  return publicThreadStorageKey(instanceId);
}

export function createPublicThreadBuffer({
  fetchHealth = () => fetch("/api/health"),
  storage = typeof sessionStorage === "undefined" ? null : sessionStorage,
} = {}) {
  let generation = 0;
  let key = null;
  let persistAllowed = false;
  let identityError = null;

  return {
    get key() { return key; },
    get persistAllowed() { return persistAllowed; },
    get identityError() { return identityError; },
    sharedFallbackKey: PUBLIC_THREAD_KEY,
    async bind(signal) {
      const gen = ++generation;
      persistAllowed = false;
      identityError = null;
      try {
        const response = await fetchHealth();
        if (signal?.aborted || gen !== generation) return { stale: true };
        const payload = typeof response.json === "function" ? await response.json() : response.payload;
        if (signal?.aborted || gen !== generation) return { stale: true };
        key = await resolveInstanceStorageKey(payload, response);
        return { key, instanceId: String(payload.instanceId).trim() };
      } catch (error) {
        if (gen !== generation) return { stale: true };
        key = null;
        persistAllowed = false;
        identityError = error;
        return { error };
      }
    },
    load(residentSpeaker = "yinyue") {
      if (!key || !storage) return emptyOneOnOneSession();
      return parseOneOnOneSession(storage.getItem(key), residentSpeaker);
    },
    markReady() {
      if (!key) return false;
      persistAllowed = true;
      return true;
    },
    persist(session, residentSpeaker = "yinyue") {
      if (!persistAllowed || !key || !storage) return { skipped: true };
      const serialized = serializeOneOnOneSession(session, residentSpeaker);
      if (!serialized) {
        try { storage.removeItem(key); } catch { /* ignore */ }
        return { rejected: true };
      }
      try {
        storage.setItem(key, serialized);
        return { ok: true };
      } catch {
        return { quota: true };
      }
    },
  };
}

export function mergeLoadedSession(loaded, live) {
  const liveMessages = Array.isArray(live?.messages) ? live.messages : [];
  if (liveMessages.length > 0) {
    return {
      ...loaded,
      messages: liveMessages,
      title: live.title || loaded.title,
    };
  }
  return loaded;
}
