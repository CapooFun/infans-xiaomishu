import fs from "node:fs/promises";
import { WorkbenchWriteError } from "./workbench-errors.mjs";

export const WHISPERKIT_DEFAULT_BASE_URL = "http://127.0.0.1:50060/v1";
export const WHISPERKIT_PROVIDER_ID = "whisperkit-local";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function providerError(message, status, code, cause) {
  return new WorkbenchWriteError(message, status, code, cause === undefined ? undefined : { cause });
}

function normalizedBaseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || WHISPERKIT_DEFAULT_BASE_URL));
  } catch {
    throw new TypeError("WhisperKit baseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new TypeError("WhisperKit baseUrl must use loopback HTTP");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function normalizedModel(raw) {
  const value = String(raw || "").trim();
  if (!value || value.length > 160 || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new TypeError("WhisperKit model must be a non-empty safe identifier");
  }
  return value;
}

function whisperLanguage(language) {
  const value = String(language || "auto").trim();
  if (!value || value === "auto") return "";
  return value.split("-")[0].toLowerCase();
}

function promptForHints(hints = []) {
  const values = [...new Set((Array.isArray(hints) ? hints : []).map((item) => String(item || "").trim()).filter(Boolean))];
  return values.length ? `可能出现这些专有词，请按原样识别：${values.join("、")}` : "";
}

function normalizedSegments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const start = Number(item?.start ?? item?.start_seconds ?? item?.startSeconds);
    const end = Number(item?.end ?? item?.end_seconds ?? item?.endSeconds);
    const text = String(item?.text || "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || !text) return null;
    return { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), text };
  }).filter(Boolean);
}

async function limitedResponseText(response, maximumBytes = 1_048_576) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw providerError("WhisperKit 返回内容过大", 502, "TRANSCRIPTION_PROVIDER_RESULT_INVALID");
  }
  return text;
}

function upstreamFailure(response, body) {
  if (response.status === 404 || response.status === 405) {
    return providerError("本机 WhisperKit 接口与配置不匹配", 503, "WHISPERKIT_ENDPOINT_UNAVAILABLE");
  }
  if (response.status === 413) {
    return providerError("WhisperKit 拒绝了这段录音的大小", 413, "WHISPERKIT_AUDIO_TOO_LARGE");
  }
  const detail = String(body || "").trim().slice(0, 240);
  return providerError(detail ? `WhisperKit 转写失败：${detail}` : "WhisperKit 转写失败", 502, "WHISPERKIT_UPSTREAM_FAILED");
}

/**
 * 连接 Argmax WhisperKit CLI 的本机 OpenAI Audio API。
 * provider 只接受 loopback HTTP，避免把原始录音误发到远端兼容接口。
 */
export function createWhisperKitSecretaryTranscriptionProvider(options = {}) {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const model = normalizedModel(options.model);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const readFile = options.readFile || fs.readFile;
  const probeTimeoutMs = Number(options.probeTimeoutMs || 1_500);
  const probeCacheTtlMs = Number(options.probeCacheTtlMs || 5_000);
  if (typeof fetchImpl !== "function") throw new TypeError("WhisperKit provider requires fetch");
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1) throw new TypeError("probeTimeoutMs must be a positive integer");
  if (!Number.isSafeInteger(probeCacheTtlMs) || probeCacheTtlMs < 1) throw new TypeError("probeCacheTtlMs must be a positive integer");
  const endpoint = `${baseUrl}/audio/transcriptions`;
  const healthEndpoint = new URL("/health", baseUrl).toString();
  let probeCache = null;

  return Object.freeze({
    id: WHISPERKIT_PROVIDER_ID,

    async describe() {
      if (probeCache && Date.now() - probeCache.at < probeCacheTtlMs) return { ...probeCache.value };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
      try {
        const response = await fetchImpl(healthEndpoint, { method: "GET", signal: controller.signal });
        const available = response.ok;
        const value = {
          id: WHISPERKIT_PROVIDER_ID,
          label: available ? "本机 WhisperKit 已就绪" : "本机 WhisperKit 接口没有响应",
          state: available ? "ready" : "unavailable",
          configured: true,
          available,
          model,
          version: null,
          execution: "local-process",
          capabilities: {
            properNounHints: true,
            segments: true,
            confidence: false,
            languageDetection: true,
            cancellation: true,
          },
        };
        probeCache = { at: Date.now(), value };
        return { ...value };
      } catch {
        const value = {
          id: WHISPERKIT_PROVIDER_ID,
          label: "本机 WhisperKit 尚未启动",
          state: "offline",
          configured: true,
          available: false,
          model,
          version: null,
          execution: "local-process",
          capabilities: {
            properNounHints: true,
            segments: true,
            confidence: false,
            languageDetection: true,
            cancellation: true,
          },
        };
        probeCache = { at: Date.now(), value };
        return { ...value };
      } finally {
        clearTimeout(timeout);
      }
    },

    async transcribe(input) {
      const bytes = await readFile(input.filePath);
      const form = new FormData();
      form.set("file", new Blob([bytes], { type: input.mimeType }), `recording${String(input.filePath).match(/\.[A-Za-z0-9]+$/u)?.[0] || ".audio"}`);
      form.set("model", model);
      form.set("response_format", "verbose_json");
      form.set("temperature", "0");
      form.append("timestamp_granularities[]", "segment");
      const language = whisperLanguage(input.language);
      if (language) form.set("language", language);
      const prompt = promptForHints(input.properNounHints);
      if (prompt) form.set("prompt", prompt);

      let response;
      try {
        response = await fetchImpl(endpoint, { method: "POST", body: form, signal: input.signal });
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason || error;
        throw providerError("无法连接本机 WhisperKit", 503, "WHISPERKIT_OFFLINE", error);
      }
      const body = await limitedResponseText(response);
      if (!response.ok) throw upstreamFailure(response, body);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw providerError("WhisperKit 没有返回有效 JSON", 502, "TRANSCRIPTION_PROVIDER_RESULT_INVALID");
      }
      return {
        text: String(parsed?.text || "").trim(),
        language: parsed?.language ? String(parsed.language) : (language || undefined),
        segments: normalizedSegments(parsed?.segments),
        model,
      };
    },
  });
}

export function whisperKitProviderOptionsFromEnvironment(environment = process.env) {
  if (String(environment.INFANS_SECRETARY_TRANSCRIPTION_PROVIDER || "").trim().toLowerCase() !== "whisperkit") return null;
  const model = String(environment.INFANS_WHISPERKIT_MODEL || "").trim();
  if (!model) return null;
  return {
    baseUrl: String(environment.INFANS_WHISPERKIT_BASE_URL || WHISPERKIT_DEFAULT_BASE_URL).trim(),
    model,
  };
}
