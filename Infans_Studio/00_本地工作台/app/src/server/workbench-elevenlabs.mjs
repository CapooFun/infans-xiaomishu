import { execFile } from "node:child_process";
import { promisify } from "node:util";
import settings from "./secretary-elevenlabs-settings.json" with { type: "json" };
import { normalizeChatSpeaker } from "../secretary-characters.mjs";

const execFileAsync = promisify(execFile);
const MAX_HIGH_QUALITY_CHARS = 500;

function elevenLabsError(message, code, statusCode = 503) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function readElevenLabsKey() {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-w",
      "-s",
      settings.keychainService,
      "-a",
      settings.keychainAccount,
    ], { timeout: 4_000, maxBuffer: 16_384 });
    return String(stdout || "").trim();
  } catch {
    return "";
  }
}

function voiceConfigForSpeaker(raw) {
  const speaker = normalizeChatSpeaker(raw);
  if (!speaker) return null;
  const config = settings.voices?.[speaker];
  return config ? { speaker, ...config } : null;
}

export async function elevenLabsVoiceStatus() {
  const keyConfigured = Boolean(await readElevenLabsKey());
  const roles = Object.fromEntries(Object.keys(settings.voices || {}).map((speaker) => {
    const config = settings.voices[speaker];
    return [speaker, {
      configured: Boolean(config?.voiceId),
      label: config?.label || "未配置声线",
    }];
  }));
  return {
    provider: "elevenlabs",
    optional: true,
    keyConfigured,
    modelId: settings.modelId,
    roles,
    ready: keyConfigured && Object.values(roles).some((role) => role.configured),
    privacy: "试听文字会发送给 ElevenLabs，并可能消耗账户额度。日常朗读仍使用 Edge。",
  };
}

export async function synthesizeSecretaryElevenLabsSpeech(raw, options = {}) {
  const config = voiceConfigForSpeaker(options.speaker);
  if (!config) throw elevenLabsError("该角色没有 ElevenLabs 试听槽位", "ELEVENLABS_ROLE_UNAVAILABLE", 400);
  if (!config.voiceId) throw elevenLabsError("该角色尚未选择 ElevenLabs 声线", "ELEVENLABS_VOICE_NOT_CONFIGURED");
  const key = await readElevenLabsKey();
  if (!key) throw elevenLabsError("ElevenLabs Keychain 密钥尚未配置", "ELEVENLABS_KEY_NOT_CONFIGURED");
  const text = String(raw || "").replace(/\s+/g, " ").trim().slice(0, MAX_HIGH_QUALITY_CHARS);
  if (!text) return null;

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=${encodeURIComponent(settings.outputFormat)}`, {
    method: "POST",
    headers: {
      Accept: "audio/mpeg",
      "Content-Type": "application/json",
      "xi-api-key": key,
    },
    body: JSON.stringify({
      text,
      model_id: settings.modelId,
      voice_settings: {
        stability: 0.48,
        similarity_boost: 0.78,
        style: 0.32,
        use_speaker_boost: true
      }
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const code = response.status === 401
      ? "ELEVENLABS_AUTH_FAILED"
      : response.status === 402 || response.status === 429
        ? "ELEVENLABS_CREDITS_OR_RATE_LIMIT"
        : "ELEVENLABS_REQUEST_FAILED";
    throw elevenLabsError(`ElevenLabs 试听失败（${response.status}）`, code, response.status);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw elevenLabsError("ElevenLabs 未返回音频", "ELEVENLABS_NO_AUDIO");
  return {
    audio,
    contentType: response.headers.get("content-type") || "audio/mpeg",
    voice: config.voiceId,
    voices: [config.voiceId],
    langs: ["multilingual"],
    text,
    speaker: config.speaker,
    provider: "elevenlabs",
  };
}
