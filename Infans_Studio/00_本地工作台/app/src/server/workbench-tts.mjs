/**
 * 角色朗读：Edge TTS 神经声线。银月始终保持自己的身份声线，不因日语片段换人。
 * 银月生成失败时由前端保留文字并停止，不退回另一套系统声线。
 */
import { Communicate } from "edge-tts-universal";
import {
  SECRETARY_EDGE_VOICE,
  detectSpeechLang,
  edgeVoiceForSecretary,
  prosodyForSecretary,
  segmentSpeechByLang,
  stripErhuaForSpeech,
  voiceForSpeechLang,
} from "../secretary-speech-lang.mjs";
import { normalizeChatSpeaker } from "../secretary-characters.mjs";

export { SECRETARY_EDGE_VOICE, detectSpeechLang, segmentSpeechByLang, voiceForSpeechLang, edgeVoiceForSecretary };
export { SECRETARY_EDGE_VOICES } from "../secretary-speech-lang.mjs";

/** @param {string} [speaker] */
function normalizeSecretarySpeaker(speaker = "yinyue") {
  if (speaker == null || String(speaker).trim() === "") return "yinyue";
  const normalized = normalizeChatSpeaker(speaker);
  if (!normalized) throw new Error("未知朗读角色");
  return normalized;
}

const MAX_SPEECH_CHARS = 800;

/** 朗读前去掉代码围栏与行动 JSON，避免念出技术块；碎省略号收成可念停顿。 */
export function prepareSecretarySpeechText(raw = "", maxChars = MAX_SPEECH_CHARS) {
  let text = String(raw);
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/\{[\s\S]*"actions"[\s\S]*\}/g, " ");
  text = text.replace(/[#>*_`]/g, "");
  text = text.replace(/(?:\.{3,}|…{1,}|……+)/g, "，");
  text = text.replace(/，{2,}/g, "，");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/^[，。！？、]+|[，。！？、]+$/g, "").trim();
  text = stripErhuaForSpeech(text);
  const limit = Number.isInteger(maxChars) && maxChars > 0
    ? Math.min(maxChars, 4_000)
    : MAX_SPEECH_CHARS;
  return text.slice(0, limit);
}

/**
 * @param {string} text
 * @param {string} lang
 * @param {"yinyue" | "meining" | string} speaker
 * @param {AbortSignal | undefined} signal
 */
async function synthesizeSegment(text, lang, speaker, signal) {
  const voice = edgeVoiceForSecretary(speaker, lang);
  const prosody = prosodyForSecretary(speaker, lang);
  const communicate = new Communicate(text, {
    voice,
    rate: prosody.rate,
    pitch: prosody.pitch,
  });

  const buffers = [];
  for await (const chunk of communicate.stream()) {
    if (signal?.aborted) {
      const err = new Error("朗读已取消");
      err.code = "ABORTED";
      throw err;
    }
    if (chunk.type === "audio" && chunk.data) buffers.push(Buffer.from(chunk.data));
  }
  if (!buffers.length) {
    const err = new Error("Edge TTS 未返回音频");
    err.code = "NO_AUDIO";
    throw err;
  }
  return { audio: Buffer.concat(buffers), voice, lang };
}

/**
 * @param {string} raw
 * @param {{ signal?: AbortSignal, speaker?: "yinyue" | "meining" | string }} [options]
 * @returns {Promise<{ audio: Buffer, contentType: string, voice: string, voices: string[], langs: string[], text: string, speaker: string } | null>}
 */
export async function synthesizeSecretaryEdgeSpeech(raw, options = {}) {
  const text = prepareSecretarySpeechText(raw, options.maxChars);
  if (!text) return null;
  const speaker = normalizeSecretarySpeaker(options.speaker);

  const segments = segmentSpeechByLang(text);
  if (!segments.length) return null;

  const parts = [];
  for (const segment of segments) {
    parts.push(await synthesizeSegment(segment.text, segment.lang, speaker, options.signal));
  }

  const voices = [...new Set(parts.map((part) => part.voice))];
  const langs = [...new Set(parts.map((part) => part.lang))];
  const fallbackVoice = edgeVoiceForSecretary(speaker, "zh") || SECRETARY_EDGE_VOICE;

  return {
    audio: Buffer.concat(parts.map((part) => part.audio)),
    contentType: "audio/mpeg",
    voice: voices[0] || fallbackVoice,
    voices,
    langs,
    text,
    speaker,
  };
}
