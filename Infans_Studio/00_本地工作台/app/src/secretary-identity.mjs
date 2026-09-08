/**
 * 公开版中性秘书身份。银月是默认一对一工作秘书，梅凝可切换；用户显示名为「我」。
 * 内部认证不得使用显示字符串。
 */
export const SECRETARY_PRODUCT_BRAND = "小秘书";
export const DEFAULT_SECRETARY_ID = "yinyue";
export const ROLE_TIER = Object.freeze({
  secretary: "secretary",
  visitor: "visitor",
});
/** App 一对一切换顺序：默认秘书、另一位秘书。 */
export const APP_SWITCHABLE_IDS = Object.freeze(["yinyue", "meining"]);
/** 秘书席人物顺序，银月在梅凝前。 */
export const SECRETARY_CAST_IDS = Object.freeze(["yinyue", "meining"]);
export const ACTIVE_SECRETARY_STORAGE_KEY = "infans-active-secretary-v1";
export const ACTIVE_SECRETARY_CHANGE_EVENT = "infans:active-secretary-change";
export const PUBLIC_USER_DISPLAY_NAME = "我";

function freezeAppearance({ defaultMode = "formal", formal, chibi }) {
  const modes = {
    formal: Object.freeze(formal),
    chibi: Object.freeze(chibi),
  };
  return Object.freeze({
    defaultMode,
    modes: Object.freeze(modes),
  });
}

function freezeLifeCore(core) {
  return Object.freeze({
    schemaVersion: 1,
    ...core,
    appearance: freezeAppearance(core.appearance),
    continuity: Object.freeze(core.continuity),
    modules: Object.freeze(core.modules),
  });
}

const YINYUE_LIFE_CORE = freezeLifeCore({
  manifestPath: "00_本地工作台/10_设计/人格与陪伴/银月公开工作设定.md",
  lifecycleStage: "established",
  birthDate: null,
  appearance: {
    defaultMode: "formal",
    formal: { label: "工作模样", imageSrc: "/theme/avatar-yinyue-public.svg", iconSrc: "/theme/avatar-yinyue-public.svg" },
    chibi: { label: "简洁模样", imageSrc: "/theme/avatar-yinyue-public.svg", iconSrc: "/theme/avatar-yinyue-public.svg" },
  },
  continuity: {
    identityAuthority: "secretary-profile",
    relationshipMemoryAuthority: null,
    rescueBoundary: "public-setting",
  },
  modules: {
    relationshipMemory: "disabled",
    proactivePresence: "optional",
  },
});

const MEINING_LIFE_CORE = freezeLifeCore({
  manifestPath: "00_本地工作台/10_设计/人格与陪伴/梅凝公开工作设定.md",
  lifecycleStage: "established",
  birthDate: null,
  appearance: {
    defaultMode: "formal",
    formal: { label: "工作模样", imageSrc: "/theme/avatar-meining-public.svg", iconSrc: "/theme/avatar-meining-public.svg" },
    chibi: { label: "简洁模样", imageSrc: "/theme/avatar-meining-public.svg", iconSrc: "/theme/avatar-meining-public.svg" },
  },
  continuity: {
    identityAuthority: "secretary-profile",
    relationshipMemoryAuthority: null,
    rescueBoundary: "public-setting",
  },
  modules: {
    relationshipMemory: "disabled",
    proactivePresence: "optional",
  },
});

export const SECRETARY_PROFILES = Object.freeze([
  Object.freeze({
    id: "yinyue",
    name: "银月",
    fullName: "银月",
    aliases: Object.freeze(["银月"]),
    secretaryEligible: true,
    roleTier: ROLE_TIER.secretary,
    avatarSrc: "/theme/avatar-yinyue-public.svg",
    chatAvatarSrc: "/theme/avatar-yinyue-public.svg",
    refreshPortraitSrc: "/theme/avatar-yinyue-public.svg",
    chatBackgroundSrc: "/theme/avatar-yinyue-public.svg",
    petId: null,
    userAddress: "你",
    selfReference: "银月",
    notificationTitle: "银月",
    edgeZhVoice: "zh-CN-XiaoxiaoNeural",
    realtimeVoice: "shimmer",
    memoryAuthorityPath: null,
    lifeCore: YINYUE_LIFE_CORE,
    companionMode: "work-secretary",
    proactiveTargetPerDay: 0,
    proactiveRangePerDay: Object.freeze([0, 0]),
    proactiveHardMaxPerDay: 0,
    hapticRangePerDay: Object.freeze([0, 0]),
    hapticMinimumIntervalMinutes: 180,
    subtitle: "把事办清楚",
    subtitleLines: Object.freeze(["把事办清楚", "你来决定"]),
  }),
  Object.freeze({
    id: "meining",
    name: "梅凝",
    fullName: "梅凝",
    aliases: Object.freeze(["梅凝"]),
    secretaryEligible: true,
    roleTier: ROLE_TIER.secretary,
    avatarSrc: "/theme/avatar-meining-public.svg",
    chatAvatarSrc: "/theme/avatar-meining-public.svg",
    refreshPortraitSrc: "/theme/avatar-meining-public.svg",
    chatBackgroundSrc: "/theme/avatar-meining-public.svg",
    petId: null,
    userAddress: "你",
    selfReference: "梅凝",
    notificationTitle: "梅凝",
    edgeZhVoice: "zh-CN-XiaoxiaoNeural",
    realtimeVoice: "marin",
    memoryAuthorityPath: null,
    lifeCore: MEINING_LIFE_CORE,
    companionMode: "work-secretary",
    proactiveTargetPerDay: 0,
    proactiveRangePerDay: Object.freeze([0, 0]),
    proactiveHardMaxPerDay: 0,
    hapticRangePerDay: Object.freeze([0, 0]),
    hapticMinimumIntervalMinutes: 180,
    subtitle: "把事办清楚",
    subtitleLines: Object.freeze(["把事办清楚", "你来决定"]),
  }),
]);

export const SECRETARY_IDS = Object.freeze(SECRETARY_PROFILES.map((profile) => profile.id));
const PROFILE_BY_ID = new Map(SECRETARY_PROFILES.map((profile) => [profile.id, profile]));
const ID_BY_ID_OR_NAME = new Map();
for (const profile of SECRETARY_PROFILES) {
  ID_BY_ID_OR_NAME.set(profile.id.toLowerCase(), profile.id);
  ID_BY_ID_OR_NAME.set(profile.name, profile.id);
  ID_BY_ID_OR_NAME.set(profile.fullName, profile.id);
  for (const alias of profile.aliases) ID_BY_ID_OR_NAME.set(alias, profile.id);
}

export function normalizeSecretaryId(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  return ID_BY_ID_OR_NAME.get(value) || ID_BY_ID_OR_NAME.get(value.toLowerCase()) || null;
}

export function secretaryProfileById(raw) {
  const id = normalizeSecretaryId(raw);
  return id ? PROFILE_BY_ID.get(id) || null : null;
}

export function secretaryLifeCoreById(raw) {
  return secretaryProfileById(raw)?.lifeCore || null;
}

export function isAppSwitchableId(raw) {
  const id = normalizeSecretaryId(raw);
  return Boolean(id && APP_SWITCHABLE_IDS.includes(id));
}

export function interpretSecretaryDictation(raw) {
  return String(raw ?? "").trim();
}

export function secretaryRefreshPortraitSrc(profileOrId) {
  const profile = typeof profileOrId === "string" ? secretaryProfileById(profileOrId) : profileOrId;
  return profile?.refreshPortraitSrc || profile?.avatarSrc || "";
}

/** 网页一对一侧栏用的默认立绘。公开版用 SVG 头像铺底，不复制私人壁纸。 */
export function secretaryDutyPortrait(profileOrId) {
  const profile = typeof profileOrId === "string" ? secretaryProfileById(profileOrId) : profileOrId;
  if (!profile) return null;
  const src = profile.chatBackgroundSrc || "";
  if (!src) return null;
  return Object.freeze({
    src,
    fit: "cover",
  });
}

/** 一对一不再叠圆点气感：iPhone／iPad 上会变成可见大圆，已撤回。 */
export const SECRETARY_CHAT_ATMOSPHERE_DEFAULT = null;

export function secretaryChatAtmosphere(profileOrId) {
  const profile = typeof profileOrId === "string" ? secretaryProfileById(profileOrId) : profileOrId;
  if (!profile) return null;
  return SECRETARY_CHAT_ATMOSPHERE_DEFAULT;
}

export function readActiveSecretaryId(storage) {
  try {
    return normalizeSecretaryId(storage?.getItem?.(ACTIVE_SECRETARY_STORAGE_KEY)) || DEFAULT_SECRETARY_ID;
  } catch {
    return DEFAULT_SECRETARY_ID;
  }
}

export function writeActiveSecretaryId(storage, raw) {
  const id = normalizeSecretaryId(raw) || DEFAULT_SECRETARY_ID;
  try { storage?.setItem?.(ACTIVE_SECRETARY_STORAGE_KEY, id); } catch { /* ignore */ }
  return id;
}

const TERMINAL_PUNCTUATION = String.raw`[。！？!?，,、；;]*`;
const SWITCH_PATTERNS = Object.freeze([
  Object.freeze({ trigger: "switch", expression: new RegExp(String.raw`^\s*切换\s*到\s*[：:]?\s*(.+?)\s*${TERMINAL_PUNCTUATION}\s*$`) }),
  Object.freeze({ trigger: "duty", expression: new RegExp(String.raw`^\s*今天\s*让\s*(.+?)\s*值班\s*${TERMINAL_PUNCTUATION}\s*$`) }),
]);

/**
 * 只识别完整、明确的换班命令。普通提到姓名时返回 null。
 *
 * @returns {{ type: "switch-secretary", secretaryId: string, trigger: "switch" | "duty" } | null}
 */
export function extractSecretarySwitchIntent(raw) {
  const source = String(raw ?? "");
  for (const { trigger, expression } of SWITCH_PATTERNS) {
    const match = source.match(expression);
    if (!match) continue;
    const secretaryId = normalizeSecretaryId(match[1]);
    if (!secretaryId || !isAppSwitchableId(secretaryId)) return null;
    const profile = PROFILE_BY_ID.get(secretaryId);
    if (!profile?.secretaryEligible) return null;
    return Object.freeze({ type: "switch-secretary", secretaryId, trigger });
  }
  return null;
}
