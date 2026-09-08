/** 角色朗读优先 Edge TTS；银月失败时保持文字，不回退成另一套系统声线。 */

import {
  detectSpeechLang,
  segmentSpeechByLang,
  stripErhuaForSpeech,
  webSpeechLangFor,
  webSpeechLangForSecretary,
} from "./secretary-speech-lang.mjs";
import { chatCharacterById, normalizeChatSpeaker } from "./secretary-characters.mjs";
import {
  adjustSecretaryWebSpeechRate,
  secretarySpeechRateMultiplier,
  normalizeSecretarySpeechRatePreset,
} from "./secretary-speech-rate.mjs";
import type { AiSecretarySpeaker } from "./types";

const VOICE_PREF_KEY = "infans-secretary-voice-on";
const VOICE_RATE_PREF_KEY = "infans-secretary-speech-rate";

export type SecretarySpeechRatePreset = "slow" | "normal" | "fast" | "veryfast";

const FEMALE_NAME_HINT = /ting|mei|ya|xiao|hui|nan|sinji|meijia|shelley|sandy|flo|grandma|yu-?shu|li-?mu|ha-?jie|fangfang|lili|kyoko|nanami|hsiao|chen|female|woman|girl|女|婷|美|雅|晓|慧|佳|怡|臻/i;
const MALE_NAME_HINT = /yunxi|yunyang|yunjian|kangkang|male|man|boy|男|云希|云扬|云健|康康/i;

export type SecretarySpeaker = AiSecretarySpeaker;

type SpeechQueueItem = { speaker: SecretarySpeaker; text: string };

type BlockedListener = (blocked: boolean) => void;
export type SecretarySpeechState = { active: boolean; speaker: SecretarySpeaker };
type SpeechStateListener = (state: SecretarySpeechState) => void;

export const SECRETARY_SPEECH_STATE_EVENT = "infans:secretary-speech-state";

function normalizeSecretarySpeaker(speaker?: string): SecretarySpeaker {
  if (speaker == null || !String(speaker).trim()) return "yinyue";
  const normalized = normalizeChatSpeaker(speaker);
  if (!normalized) throw new Error("未知朗读角色");
  return normalized as SecretarySpeaker;
}

let activeController: AbortController | null = null;
let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;
let sharedAudio: HTMLAudioElement | null = null;
let audioContext: AudioContext | null = null;
let audioUnlocked = false;
/** 递增后可使当前 drain 失效。 */
let speechGeneration = 0;
let playQueue: SpeechQueueItem[] = [];
let draining = false;
let speechBlocked = false;
const blockedListeners = new Set<BlockedListener>();
const speechStateListeners = new Set<SpeechStateListener>();
let speechState: SecretarySpeechState = { active: false, speaker: "yinyue" };

export function isSecretaryVoiceEnabled() {
  try {
    const raw = localStorage.getItem(VOICE_PREF_KEY);
    if (raw == null) return true;
    return raw === "1";
  } catch {
    return true;
  }
}

export function setSecretaryVoiceEnabled(on: boolean) {
  try {
    localStorage.setItem(VOICE_PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function getSecretarySpeechRatePreset(): SecretarySpeechRatePreset {
  try {
    return normalizeSecretarySpeechRatePreset(localStorage.getItem(VOICE_RATE_PREF_KEY) || undefined) as SecretarySpeechRatePreset;
  } catch {
    return "normal";
  }
}

function applySecretarySpeechPlaybackRate(audio: HTMLAudioElement | null = currentAudio) {
  if (!audio) return;
  const rate = secretarySpeechRateMultiplier(getSecretarySpeechRatePreset());
  audio.playbackRate = rate;
  audio.preservesPitch = true;
  const webkitAudio = audio as HTMLAudioElement & { webkitPreservesPitch?: boolean };
  if ("webkitPreservesPitch" in webkitAudio) webkitAudio.webkitPreservesPitch = true;
}

export function setSecretarySpeechRatePreset(raw: SecretarySpeechRatePreset | string) {
  const preset = normalizeSecretarySpeechRatePreset(raw) as SecretarySpeechRatePreset;
  try {
    localStorage.setItem(VOICE_RATE_PREF_KEY, preset);
  } catch {
    /* ignore */
  }
  applySecretarySpeechPlaybackRate(currentAudio);
  return preset;
}

export function isSecretarySpeechBlocked() {
  return speechBlocked;
}

export function onSecretarySpeechBlocked(listener: BlockedListener) {
  blockedListeners.add(listener);
  return () => {
    blockedListeners.delete(listener);
  };
}

export function getSecretarySpeechState() {
  return { ...speechState };
}

export function isNativeSecretaryTalking(state: SecretarySpeechState = speechState) {
  return state.active && state.speaker === "yinyue";
}

export function onSecretarySpeechState(listener: SpeechStateListener) {
  speechStateListeners.add(listener);
  return () => {
    speechStateListeners.delete(listener);
  };
}

/** 页面、测试与原生桥共用的唯一说话状态出口。 */
export function publishSecretarySpeechState(active: boolean, speaker: SecretarySpeaker | string = "yinyue") {
  const next = { active: Boolean(active), speaker: normalizeSecretarySpeaker(speaker) } satisfies SecretarySpeechState;
  if (speechState.active === next.active && speechState.speaker === next.speaker) return next;
  speechState = next;
  for (const listener of speechStateListeners) {
    try {
      listener({ ...next });
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(SECRETARY_SPEECH_STATE_EVENT, { detail: next }));
    } catch {
      /* Node tests / older WebKit */
    }
    try {
      const bridge = (window as unknown as {
        webkit?: { messageHandlers?: { secretaryPet?: { postMessage: (payload: unknown) => void } } };
      }).webkit?.messageHandlers;
      bridge?.secretaryPet?.postMessage({ type: "speech-state", ...next });
    } catch {
      /* 浏览器回退路径没有原生桥 */
    }
  }
  return next;
}

function setSpeechBlocked(next: boolean) {
  if (speechBlocked === next) return;
  speechBlocked = next;
  for (const listener of blockedListeners) {
    try {
      listener(next);
    } catch {
      /* ignore */
    }
  }
}

function ensureSharedAudio() {
  if (typeof window === "undefined") return null;
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.setAttribute("playsinline", "true");
    sharedAudio.preload = "auto";
  }
  return sharedAudio;
}

/** 必须在用户手势里调用：打开侧栏、开朗读、发送、点气泡、点「点一下听」。 */
export function unlockSecretaryAudio() {
  if (typeof window === "undefined") return false;
  const audio = ensureSharedAudio();
  if (!audio) return false;
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) {
      if (!audioContext) audioContext = new Ctx();
      if (audioContext.state === "suspended") void audioContext.resume();
    }
  } catch {
    /* ignore */
  }
  try {
    audio.muted = true;
    const play = audio.play();
    if (play && typeof play.then === "function") {
      void play.then(() => {
        audio.pause();
        audio.muted = false;
        audioUnlocked = true;
      }).catch(() => {
        audio.muted = false;
      });
    } else {
      audio.pause();
      audio.muted = false;
      audioUnlocked = true;
    }
  } catch {
    try {
      audio.muted = false;
    } catch {
      /* ignore */
    }
  }
  audioUnlocked = true;
  return true;
}

/** 用户点「点一下听」：解锁并继续播被拦住的队列。 */
export function resumeBlockedSecretarySpeech() {
  unlockSecretaryAudio();
  setSpeechBlocked(false);
  if (playQueue.length) void drainSpeechQueue();
  return playQueue.length > 0 || draining;
}

function scoreVoice(voice: SpeechSynthesisVoice, preferredLang = "zh", preferMale = false) {
  const lang = String(voice.lang || "").toLowerCase();
  const name = String(voice.name || "");
  const want = webSpeechLangFor(preferredLang).toLowerCase();
  const wantPrimary = want.split("-")[0];
  let score = 0;
  if (lang === want || lang.replace("_", "-") === want) score += 50;
  else if (lang.startsWith(wantPrimary)) score += 35;
  if (wantPrimary === "zh" && (lang.includes("cmn") || lang.includes("china") || lang.includes("taiwan") || lang.includes("tw"))) score += 15;
  if (want.includes("tw") && (lang.includes("tw") || lang.includes("taiwan") || /hsiao|chen|meijia|yating/i.test(name))) score += 20;
  if (preferMale) {
    if (MALE_NAME_HINT.test(name)) score += 40;
    if (FEMALE_NAME_HINT.test(name)) score -= 40;
  } else {
    if (FEMALE_NAME_HINT.test(name)) score += 25;
    if (/tingting.*enhanced|enhanced.*tingting/i.test(name)) score += 30;
    else if (/tingting|ting-ting|kyoko|otoya|nanami/i.test(name)) score += 20;
    if (/male|男|daniel|alex|eddy|reed|rocko|grandpa|tom|yu-?shu/i.test(name) && !FEMALE_NAME_HINT.test(name)) score -= 50;
  }
  if (voice.localService) score += 5;
  return score;
}

export function pickSecretaryVoice(voices: SpeechSynthesisVoice[] = [], preferredLang = "zh", preferMale = false) {
  if (!voices.length) return null;
  const ranked = [...voices].sort((a, b) => scoreVoice(b, preferredLang, preferMale) - scoreVoice(a, preferredLang, preferMale));
  const best = ranked[0];
  const wantPrimary = webSpeechLangFor(preferredLang).split("-")[0].toLowerCase();
  return scoreVoice(best, preferredLang, preferMale) > 0
    ? best
    : ranked.find((v) => v.lang.toLowerCase().startsWith(wantPrimary)) || null;
}

/** 朗读前去掉代码围栏与过长 JSON，避免念出行动块；并把碎省略号收成可念的停顿。 */
export function prepareSecretarySpeechText(raw = "") {
  let text = String(raw);
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/\{[\s\S]*"actions"[\s\S]*\}/g, " ");
  text = text.replace(/[#>*_`]/g, "");
  text = text.replace(/(?:\.{3,}|…{1,}|……+)/g, "，");
  text = text.replace(/，{2,}/g, "，");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/^[，。！？、]+|[，。！？、]+$/g, "").trim();
  text = stripErhuaForSpeech(text);
  return text.slice(0, 800);
}

/**
 * 混合实时模式把外部文本模型的流式输出切成自然可播的小段。
 * 优先等完整句；句子过长时才在逗号处切，flush=true 会交出最后半句。
 */
export function takeHybridSpeechChunks(raw = "", flush = false) {
  let remainder = String(raw || "").replace(/\r/g, "");
  const chunks: string[] = [];
  while (remainder.trim()) {
    const sentence = remainder.match(/^([\s\S]*?[。！？!?；;\n]+)([\s\S]*)$/);
    if (sentence && sentence[1].trim().length >= 4) {
      chunks.push(sentence[1].trim());
      remainder = sentence[2];
      continue;
    }
    if (remainder.length >= 64) {
      const window = remainder.slice(0, 64);
      const commaAt = Math.max(window.lastIndexOf("，"), window.lastIndexOf(","), window.lastIndexOf("、"));
      const cutAt = commaAt >= 28 ? commaAt + 1 : 52;
      chunks.push(remainder.slice(0, cutAt).trim());
      remainder = remainder.slice(cutAt);
      continue;
    }
    break;
  }
  if (flush && remainder.trim()) {
    chunks.push(remainder.trim());
    remainder = "";
  }
  return { chunks: chunks.filter(Boolean), remainder };
}

function clearEdgeAudio() {
  if (currentAudio) {
    try {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio.pause();
      if (currentAudio !== sharedAudio) {
        currentAudio.removeAttribute("src");
        currentAudio.load();
      } else {
        currentAudio.removeAttribute("src");
        try {
          currentAudio.load();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    currentAudio = null;
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

export function stopSecretarySpeech() {
  speechGeneration += 1;
  playQueue = [];
  draining = false;
  activeController?.abort();
  activeController = null;
  clearEdgeAudio();
  setSpeechBlocked(false);
  publishSecretarySpeechState(false, speechState.speaker);
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
}

function speakUtterance(
  text: string,
  preferredLang: string,
  speaker: SecretarySpeaker = "yinyue",
  callbacks: { onStart?: () => void; onEnd?: () => void } = {},
) {
  const utter = new SpeechSynthesisUtterance(text);
  const speechLang = webSpeechLangForSecretary(speaker, preferredLang);
  utter.lang = speechLang;
  const character = chatCharacterById(speaker);
  const baseRate = preferredLang === "la" ? Math.min(1.05, character?.webRate || 1.05) : character?.webRate || 1.1;
  utter.rate = adjustSecretaryWebSpeechRate(baseRate, getSecretarySpeechRatePreset());
  utter.pitch = character?.webPitch || 1.08;
  utter.volume = 1;
  const voice = pickSecretaryVoice(
    window.speechSynthesis.getVoices(),
    speechLang === "zh-TW" ? "zh-TW" : preferredLang,
    false,
  );
  if (voice) {
    utter.voice = voice;
    utter.lang = voice.lang || utter.lang;
  }
  utter.onstart = () => callbacks.onStart?.();
  utter.onend = () => callbacks.onEnd?.();
  utter.onerror = () => callbacks.onEnd?.();
  window.speechSynthesis.speak(utter);
}

function speakWithWebSpeech(text: string, speaker: SecretarySpeaker = "yinyue") {
  if (typeof window === "undefined" || !window.speechSynthesis) return false;
  window.speechSynthesis.cancel();
  const segments = segmentSpeechByLang(text);
  const queue = segments.length ? segments : [{ lang: detectSpeechLang(text), text }];

  const run = () => {
    let remaining = queue.length;
    let started = false;
    const onStart = () => {
      if (started) return;
      started = true;
      publishSecretarySpeechState(true, speaker);
    };
    const onEnd = () => {
      remaining = Math.max(0, remaining - 1);
      if (!remaining) publishSecretarySpeechState(false, speaker);
    };
    for (const segment of queue) speakUtterance(segment.text, segment.lang, speaker, { onStart, onEnd });
  };

  if (window.speechSynthesis.getVoices().length) run();
  else {
    const once = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", once);
      run();
    };
    window.speechSynthesis.addEventListener("voiceschanged", once);
    window.setTimeout(() => {
      window.speechSynthesis.removeEventListener("voiceschanged", once);
      if (!window.speechSynthesis.speaking) run();
    }, 250);
  }
  return true;
}

export function isAutoplayBlockedError(error: unknown) {
  if (!error) return false;
  const name = typeof error === "object" && error && "name" in error ? String((error as { name?: string }).name || "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "NotAllowedError"
    || /notallowed|autoplay|user.?gesture|play\(\) failed because/i.test(message);
}

async function speakWithServerTts(
  text: string,
  signal: AbortSignal,
  speaker: SecretarySpeaker = "yinyue",
  provider: "edge" | "elevenlabs" = "edge",
) {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, speaker, provider }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`TTS ${response.status}`);
  }
  const blob = await response.blob();
  if (signal.aborted) throw Object.assign(new Error("TTS 已取消"), { code: "ABORTED" });
  if (!blob.size) throw new Error("empty audio");

  clearEdgeAudio();
  const url = URL.createObjectURL(blob);
  currentObjectUrl = url;
  const audio = ensureSharedAudio() || new Audio();
  currentAudio = audio;
  audio.muted = false;
  audio.src = url;
  // Safari / WKWebView 会在设置 src 时把 playbackRate 打回 1，必须在 src 之后、开播时再设一次。
  applySecretarySpeechPlaybackRate(audio);
  audio.addEventListener("loadedmetadata", () => applySecretarySpeechPlaybackRate(audio));
  audio.addEventListener("playing", () => applySecretarySpeechPlaybackRate(audio));

  await new Promise<void>((resolve, reject) => {
    audio.onended = () => {
      publishSecretarySpeechState(false, speaker);
      resolve();
    };
    audio.onerror = () => {
      publishSecretarySpeechState(false, speaker);
      reject(new Error("audio play failed"));
    };
    const play = audio.play();
    if (play && typeof play.then === "function") {
      play.then(() => {
        audioUnlocked = true;
        publishSecretarySpeechState(true, speaker);
      }).catch((error) => {
        publishSecretarySpeechState(false, speaker);
        if (isAutoplayBlockedError(error)) {
          reject(Object.assign(new Error("autoplay blocked"), { code: "AUTOPLAY_BLOCKED", cause: error }));
          return;
        }
        reject(error);
      });
    } else {
      publishSecretarySpeechState(true, speaker);
    }
  });
  return {
    provider: response.headers?.get?.("X-Secretary-Provider") || "edge",
    requestedProvider: response.headers?.get?.("X-Secretary-Requested-Provider") || provider,
    fallback: response.headers?.get?.("X-Secretary-Fallback") || "",
  };
}

function toQueueItems(turns: Array<{ speaker?: SecretarySpeaker | string; content?: string }>): SpeechQueueItem[] {
  return turns
    .map((turn) => ({
      speaker: normalizeSecretarySpeaker(turn.speaker),
      text: prepareSecretarySpeechText(turn.content || ""),
    }))
    .filter((turn) => turn.text && turn.text !== "稍等哦" && turn.text !== "已停止生成。");
}

async function drainSpeechQueue() {
  if (draining) return;
  draining = true;
  const gen = speechGeneration;
  while (playQueue.length && gen === speechGeneration) {
    const item = playQueue.shift();
    if (!item) break;
    const controller = new AbortController();
    activeController = controller;
    try {
      await speakWithServerTts(item.text, controller.signal, item.speaker);
      setSpeechBlocked(false);
    } catch (error) {
      if (controller.signal.aborted || gen !== speechGeneration) break;
      const blocked = typeof error === "object" && error && "code" in error
        && (error as { code?: string }).code === "AUTOPLAY_BLOCKED";
      if (blocked) {
        playQueue.unshift(item);
        setSpeechBlocked(true);
        publishSecretarySpeechState(false, item.speaker);
        break;
      }
      if (item.speaker === "yinyue") {
        publishSecretarySpeechState(false, item.speaker);
        playQueue = [];
        break;
      }
      speakWithWebSpeech(item.text, item.speaker);
      // Web Speech 无法可靠 await，后面条目等本轮清空后再说会叠音，先停排队
      playQueue = [];
      break;
    } finally {
      if (activeController === controller) activeController = null;
    }
  }
  draining = false;
  if (playQueue.length && gen === speechGeneration && !speechBlocked) void drainSpeechQueue();
}

function enqueueSpeech(items: SpeechQueueItem[], append: boolean) {
  if (!items.length) return false;
  if (!append) {
    speechGeneration += 1;
    playQueue = [];
    draining = false;
    activeController?.abort();
    activeController = null;
    clearEdgeAudio();
    setSpeechBlocked(false);
    publishSecretarySpeechState(false, speechState.speaker);
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }
  playQueue.push(...items);
  void drainSpeechQueue();
  return true;
}

/** 优先 Edge（按说话人）；银月失败时不换声。append=true 时接到队尾，不打断当前朗读。 */
export function speakAsSecretary(
  raw: string,
  options: { enabled?: boolean; speaker?: SecretarySpeaker; append?: boolean } = {},
) {
  if (typeof window === "undefined") return false;
  const enabled = options.enabled ?? isSecretaryVoiceEnabled();
  if (!enabled) return false;
  const speaker = normalizeSecretarySpeaker(options.speaker);
  const text = prepareSecretarySpeechText(raw);
  if (!text || text === "稍等哦" || text === "已停止生成。") return false;
  return enqueueSpeech([{ speaker, text }], Boolean(options.append));
}

/** 一对一：按气泡顺序依次朗读。append=true 用于自动连聊续播，不掐断前面的句子。 */
export function speakSecretaryTurns(
  turns: Array<{ speaker?: SecretarySpeaker | string; content?: string }>,
  options: { enabled?: boolean; append?: boolean } = {},
) {
  if (typeof window === "undefined") return false;
  const enabled = options.enabled ?? isSecretaryVoiceEnabled();
  if (!enabled) return false;
  return enqueueSpeech(toQueueItems(turns), Boolean(options.append));
}

/**
 * 值班秘书的一次性高质试听。调用方必须先向用户说明会把本段文字发给
 * ElevenLabs 并可能消耗额度；服务端不可用时会诚实回退到该角色的 Edge 声线。
 */
export async function previewSecretaryHighQuality(raw: string, speaker: SecretarySpeaker) {
  if (speaker !== "yinyue" && speaker !== "meining") throw new Error("该角色没有高质试听入口");
  const text = prepareSecretarySpeechText(raw);
  if (!text) throw new Error("没有可试听的文字");
  stopSecretarySpeech();
  const controller = new AbortController();
  activeController = controller;
  try {
    return await speakWithServerTts(text, controller.signal, speaker, "elevenlabs");
  } finally {
    if (activeController === controller) activeController = null;
  }
}

/** 测试与调试用：当前是否已做过手势解锁（不保证系统仍允许播）。 */
export function isSecretaryAudioUnlocked() {
  return audioUnlocked;
}
