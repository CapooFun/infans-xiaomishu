const YINYUE = Object.freeze({
  id: "yinyue",
  name: "银月",
  aliases: Object.freeze(["银月"]),
  kind: "secretary",
  secretaryEligible: true,
  shortTag: "机敏务实",
  accent: "#bcc6e4",
  edgeZhVoice: "zh-CN-XiaoxiaoNeural",
  realtimeVoice: "shimmer",
  webRate: 1.12,
  webPitch: 1.08,
});

const MEINING = Object.freeze({
  id: "meining",
  name: "梅凝",
  aliases: Object.freeze(["梅凝"]),
  kind: "secretary",
  secretaryEligible: true,
  shortTag: "克制清楚",
  accent: "#e4bcc8",
  edgeZhVoice: "zh-CN-XiaoxiaoNeural",
  realtimeVoice: "marin",
  webRate: 1.08,
  webPitch: 1.04,
});

export const CHAT_EXCLUDED_CHARACTER_NAMES = Object.freeze([]);
export const CHAT_CHARACTER_REGISTRY = Object.freeze([YINYUE, MEINING]);
export const CHAT_CHARACTER_IDS = Object.freeze(["yinyue", "meining"]);
export const CHAT_RESIDENT_CHARACTERS = Object.freeze([YINYUE, MEINING]);
export const SECRETARY_DUTY_STAGE = Object.freeze({
  yinyue: Object.freeze({
    src: "/theme/avatar-yinyue-public.svg",
    avatarSrc: "/theme/avatar-yinyue-public.svg",
    fit: "contain",
    position: "center",
    avatarPosition: "center",
  }),
  meining: Object.freeze({
    src: "/theme/avatar-meining-public.svg",
    avatarSrc: "/theme/avatar-meining-public.svg",
    fit: "contain",
    position: "center",
    avatarPosition: "center",
  }),
});

const BY_ID = new Map(CHAT_CHARACTER_REGISTRY.map((item) => [item.id, item]));

export function chatCharacterById(raw) {
  const id = String(raw || "").trim().toLowerCase();
  return BY_ID.get(id) || null;
}
export function normalizeChatSpeaker(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value === "yinyue" || value === "银月" || value === "assistant" || value === "secretary") return "yinyue";
  if (value === "meining" || value === "梅凝") return "meining";
  return chatCharacterById(value.toLowerCase())?.id || null;
}
export function isKnownChatSpeaker(raw) { return normalizeChatSpeaker(raw) !== null; }
export function chatSpeakerLabel(raw) {
  const id = normalizeChatSpeaker(raw);
  return id ? (BY_ID.get(id)?.name || "") : "";
}
export function chatSpeakerAliases(raw) {
  const id = normalizeChatSpeaker(raw);
  return id ? [...(BY_ID.get(id)?.aliases || [])] : [];
}
export function secretaryDutyStage(raw) {
  const id = normalizeChatSpeaker(raw);
  return id && SECRETARY_DUTY_STAGE[id] ? SECRETARY_DUTY_STAGE[id] : null;
}
export function chatAvatarVisual(speaker) {
  if (String(speaker || "") === "user" || String(speaker || "") === "我") {
    return { src: "/theme/avatar-user-me.svg", name: "我", accent: "#d8d2c4" };
  }
  const id = normalizeChatSpeaker(speaker) || "yinyue";
  const character = BY_ID.get(id) || YINYUE;
  return { src: character.id === "meining" ? "/theme/avatar-meining-public.svg" : "/theme/avatar-yinyue-public.svg", name: character.name, accent: character.accent };
}
