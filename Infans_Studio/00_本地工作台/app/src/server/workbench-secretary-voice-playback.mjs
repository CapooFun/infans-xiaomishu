import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeChatSpeaker } from "../secretary-characters.mjs";
import { edgeVoiceForSecretary } from "../secretary-speech-lang.mjs";
import { SECRETARY_RUNTIME_DIR } from "./vault-paths.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import {
  prepareSecretarySpeechText,
  synthesizeSecretaryEdgeSpeech,
} from "./workbench-tts.mjs";

const CACHE_VERSION = "secretary-mobile-edge-v2";
const MAX_TEXT_CHARS = 4_000;
const MAX_CACHE_FILES = 80;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MESSAGE_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{7,127}$/u;

function voiceError(message, code, status = 400) {
  return new WorkbenchWriteError(message, status, code);
}

function normalizedRequest(payload = {}) {
  const messageId = String(payload?.messageId || "").trim();
  if (!MESSAGE_ID.test(messageId)) {
    throw voiceError("朗读消息 ID 不合法", "SECRETARY_VOICE_MESSAGE_ID_INVALID");
  }
  const speaker = normalizeChatSpeaker(payload?.speaker || "yinyue");
  if (!speaker) throw voiceError("未知朗读角色", "SECRETARY_VOICE_SPEAKER_INVALID");
  const text = prepareSecretarySpeechText(payload?.text ?? payload?.content ?? "", MAX_TEXT_CHARS);
  if (!text) throw voiceError("没有可朗读的文字", "SECRETARY_VOICE_TEXT_EMPTY");
  return { messageId, speaker, text };
}

function cacheKeyFor(request) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ version: CACHE_VERSION, speaker: request.speaker, text: request.text }))
    .digest("hex");
}

async function readCached(cacheDir, key) {
  const audioPath = path.join(cacheDir, `${key}.mp3`);
  const metadataPath = path.join(cacheDir, `${key}.json`);
  try {
    const [audio, metadata] = await Promise.all([
      fs.readFile(audioPath),
      fs.readFile(metadataPath, "utf8").then(JSON.parse),
    ]);
    if (!audio.length || metadata?.version !== CACHE_VERSION || metadata?.size !== audio.length) return null;
    const now = new Date();
    await Promise.all([
      fs.utimes(audioPath, now, now).catch(() => {}),
      fs.utimes(metadataPath, now, now).catch(() => {}),
    ]);
    return {
      audio,
      contentType: "audio/mpeg",
      speaker: metadata.speaker,
      voice: metadata.voice,
      voices: metadata.voices || [metadata.voice].filter(Boolean),
      langs: metadata.langs || [],
      cacheKey: key,
      cacheHit: true,
    };
  } catch {
    return null;
  }
}

async function writeCached(cacheDir, key, result) {
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await fs.chmod(cacheDir, 0o700).catch(() => {});
  const audioPath = path.join(cacheDir, `${key}.mp3`);
  const metadataPath = path.join(cacheDir, `${key}.json`);
  const temporaryAudioPath = path.join(cacheDir, `.${key}.${process.pid}.mp3.tmp`);
  const temporaryMetadataPath = path.join(cacheDir, `.${key}.${process.pid}.json.tmp`);
  const metadata = {
    version: CACHE_VERSION,
    speaker: result.speaker,
    voice: result.voice,
    voices: result.voices || [],
    langs: result.langs || [],
    size: result.audio.length,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(temporaryAudioPath, result.audio, { mode: 0o600 });
  await fs.writeFile(temporaryMetadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  await fs.rename(temporaryAudioPath, audioPath);
  await fs.rename(temporaryMetadataPath, metadataPath);
  await Promise.all([fs.chmod(audioPath, 0o600), fs.chmod(metadataPath, 0o600)]);
}

async function pruneCache(cacheDir) {
  let entries;
  try {
    entries = await fs.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }
  const audioFiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.mp3$/u.test(entry.name)) continue;
    const filePath = path.join(cacheDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      audioFiles.push({ key: entry.name.slice(0, -4), filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A concurrent request may be replacing this cache entry.
    }
  }
  audioFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let keptBytes = 0;
  for (let index = 0; index < audioFiles.length; index += 1) {
    const item = audioFiles[index];
    keptBytes += item.size;
    if (index < MAX_CACHE_FILES && keptBytes <= MAX_CACHE_BYTES) continue;
    await Promise.all([
      fs.unlink(item.filePath).catch(() => {}),
      fs.unlink(path.join(cacheDir, `${item.key}.json`)).catch(() => {}),
    ]);
  }
}

export function createSecretaryVoicePlaybackService(vaultRoot, options = {}) {
  const cacheDir = options.cacheDir || path.resolve(vaultRoot, SECRETARY_RUNTIME_DIR, "voice-playback-cache");
  const synthesize = options.synthesize || synthesizeSecretaryEdgeSpeech;
  const inFlight = new Map();

  async function synthesizeRequest(payload, requestOptions = {}) {
    const normalized = normalizedRequest(payload);
    const cacheKey = cacheKeyFor(normalized);
    const cached = await readCached(cacheDir, cacheKey);
    if (cached) return { ...cached, messageId: normalized.messageId };

    let work = inFlight.get(cacheKey);
    if (!work) {
      work = (async () => {
        let result;
        try {
          result = await synthesize(normalized.text, {
            speaker: normalized.speaker,
            signal: requestOptions.signal,
            maxChars: MAX_TEXT_CHARS,
          });
        } catch (error) {
          if (requestOptions.signal?.aborted || error?.code === "ABORTED") throw error;
          throw voiceError("Mac 暂时无法生成银月语音", "SECRETARY_VOICE_SYNTHESIS_UNAVAILABLE", 503);
        }
        if (!result?.audio?.length) {
          throw voiceError("Mac 暂时没有生成语音", "SECRETARY_VOICE_NO_AUDIO", 503);
        }
        await writeCached(cacheDir, cacheKey, result);
        void pruneCache(cacheDir);
        return result;
      })().finally(() => inFlight.delete(cacheKey));
      inFlight.set(cacheKey, work);
    }
    const result = await work;
    return {
      ...result,
      messageId: normalized.messageId,
      cacheKey,
      cacheHit: false,
    };
  }

  function status() {
    return {
      ready: true,
      provider: "edge",
      source: "mac-private-service",
      cache: "private-disk-and-device",
      deviceFallback: "none",
      defaultSpeaker: "yinyue",
      defaultVoice: edgeVoiceForSecretary("yinyue", "zh"),
      maximumTextChars: MAX_TEXT_CHARS,
    };
  }

  return { status, synthesize: synthesizeRequest, cacheDir };
}
