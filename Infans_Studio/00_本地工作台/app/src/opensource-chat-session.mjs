import { WorkbenchWriteError } from "./server/workbench-errors.mjs";

export const PUBLIC_THREAD_KEY = "infans-oss-ai-thread-v1";
export const FOREIGN_THREAD_KEYS = Object.freeze(["infans-ai-thread-v2", "infans-ai-thread-v1"]);

export function publicThreadStorageKey(instanceId = "") {
  const id = String(instanceId || "").trim();
  return id ? `${PUBLIC_THREAD_KEY}:${id}` : PUBLIC_THREAD_KEY;
}

export function assistantShiftIsPublic(messages = [], residentSpeaker = "yinyue") {
  return (messages || []).every((item) => {
    if (!item || item.role !== "assistant") return true;
    const speaker = String(item.speaker || "");
    return speaker === "yinyue" || speaker === "meining" || speaker === residentSpeaker || speaker === "";
  });
}

export function browserSessionLooksPrivate(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Array.isArray(parsed);
  }
  if (parsed.private === true) return true;
  if (parsed.indexPolicy === "never" || parsed.privacy === "private") return true;
  return false;
}

export function assertPublicChatPayload(payload = {}) {
  const chatState = payload.chatState && typeof payload.chatState === "object" ? payload.chatState : {};
  const privacy = String(payload.privacy || chatState.privacy || "standard");
  const indexPolicy = String(payload.indexPolicy || chatState.indexPolicy || "allow");
  if (privacy === "private" || indexPolicy === "never" || browserSessionLooksPrivate({ ...chatState, ...payload })) {
    throw new WorkbenchWriteError("公开版只接收一对一会话", 403, "CHAT_PRIVACY_REJECTED");
  }
}
