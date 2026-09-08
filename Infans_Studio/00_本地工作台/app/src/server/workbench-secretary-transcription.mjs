import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { SECRETARY_ATTACHMENT_LIMITS } from "./workbench-secretary-attachments.mjs";

export const SECRETARY_TRANSCRIPTION_PROTOCOL_ID = "infans.secretary.transcription";
export const SECRETARY_TRANSCRIPTION_PROTOCOL_VERSION = 1;

const TRANSCRIPTION_MIME_TYPES = SECRETARY_ATTACHMENT_LIMITS.allowedMimeTypes
  .filter((mime) => mime.startsWith("audio/") || mime === "video/webm");

export const SECRETARY_TRANSCRIPTION_LIMITS = Object.freeze({
  maximumBytes: SECRETARY_ATTACHMENT_LIMITS.maximumBytes.audio,
  maximumDurationMs: SECRETARY_ATTACHMENT_LIMITS.maximumDurationMs.audio,
  allowedMimeTypes: Object.freeze([...TRANSCRIPTION_MIME_TYPES]),
  maximumProperNounHints: 32,
  maximumProperNounHintChars: 64,
  defaultTimeoutMs: 60_000,
});

const RECORDING_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{7,79}$/u;
const LANGUAGE = /^(?:auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/u;
const EXTENSION_BY_MIME = Object.freeze({
  "audio/webm": ".webm",
  "video/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
});

function transcriptionError(message, status, code) {
  return new WorkbenchWriteError(message, status, code);
}

function header(request, name) {
  const value = request?.headers?.[name];
  return Array.isArray(value) ? value[0] : String(value || "");
}

function normalizeMime(raw) {
  return String(raw || "").split(";")[0].trim().toLowerCase();
}

function normalizeRecordingId(raw) {
  const value = String(raw || "").trim();
  if (!RECORDING_ID.test(value) || value.includes("..")) {
    throw transcriptionError("录音 ID 必须是客户端稳定生成的 8–80 位字符", 400, "TRANSCRIPTION_RECORDING_ID_INVALID");
  }
  return value;
}

function normalizeDurationMs(raw, maximumDurationMs) {
  const value = String(raw || "").trim();
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw transcriptionError("录音时长必须是可验证的正整数毫秒", 400, "TRANSCRIPTION_DURATION_INVALID");
  }
  const durationMs = Number(value);
  if (!Number.isSafeInteger(durationMs) || durationMs > maximumDurationMs) {
    throw transcriptionError("录音超过了当前九十秒的上限", 413, "TRANSCRIPTION_AUDIO_TOO_LONG");
  }
  return durationMs;
}

function normalizeLanguage(raw) {
  const value = String(raw || "auto").trim();
  if (!LANGUAGE.test(value)) {
    throw transcriptionError("语言标记不合法", 400, "TRANSCRIPTION_LANGUAGE_INVALID");
  }
  return value;
}

function normalizeProperNounHints(values, limits) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.length > limits.maximumProperNounHints) {
    throw transcriptionError("专有词提示数量不合法", 400, "TRANSCRIPTION_HINTS_INVALID");
  }
  const unique = [];
  const seen = new Set();
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value || [...value].length > limits.maximumProperNounHintChars || /[\u0000-\u001F\u007F]/u.test(value)) {
      throw transcriptionError("专有词提示内容不合法", 400, "TRANSCRIPTION_HINTS_INVALID");
    }
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

function decodeProperNounHints(raw, limits) {
  const encoded = String(raw || "").trim();
  if (!encoded) return [];
  if (encoded.length > 8_192 || !/^[0-9A-Za-z_-]+$/u.test(encoded)) {
    throw transcriptionError("专有词提示头不合法", 400, "TRANSCRIPTION_HINTS_INVALID");
  }
  try {
    return normalizeProperNounHints(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), limits);
  } catch (error) {
    if (error instanceof WorkbenchWriteError) throw error;
    throw transcriptionError("专有词提示头不合法", 400, "TRANSCRIPTION_HINTS_INVALID");
  }
}

export function encodeSecretaryTranscriptionHints(properNouns) {
  return Buffer.from(JSON.stringify(properNouns || []), "utf8").toString("base64url");
}

function effectiveLimits(overrides = {}) {
  const maximumBytes = Number(overrides.maximumBytes || SECRETARY_TRANSCRIPTION_LIMITS.maximumBytes);
  const maximumDurationMs = Number(overrides.maximumDurationMs || SECRETARY_TRANSCRIPTION_LIMITS.maximumDurationMs);
  const allowedMimeTypes = Array.isArray(overrides.allowedMimeTypes)
    ? overrides.allowedMimeTypes.map(normalizeMime).filter(Boolean)
    : [...SECRETARY_TRANSCRIPTION_LIMITS.allowedMimeTypes];
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError("maximumBytes must be a positive integer");
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1) throw new TypeError("maximumDurationMs must be a positive integer");
  if (!allowedMimeTypes.length) throw new TypeError("allowedMimeTypes must not be empty");
  return Object.freeze({
    maximumBytes,
    maximumDurationMs,
    allowedMimeTypes: Object.freeze([...new Set(allowedMimeTypes)]),
    maximumProperNounHints: SECRETARY_TRANSCRIPTION_LIMITS.maximumProperNounHints,
    maximumProperNounHintChars: SECRETARY_TRANSCRIPTION_LIMITS.maximumProperNounHintChars,
  });
}

function requestMetadata(request, limits) {
  const mimeType = normalizeMime(header(request, "content-type"));
  if (!limits.allowedMimeTypes.includes(mimeType)) {
    throw transcriptionError("这种音频格式还不能用于转写", 415, "TRANSCRIPTION_MIME_UNSUPPORTED");
  }
  const declaredLength = header(request, "content-length").trim();
  if (declaredLength && (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > limits.maximumBytes)) {
    throw transcriptionError("录音文件太大了", 413, "TRANSCRIPTION_AUDIO_TOO_LARGE");
  }
  return {
    recordingId: normalizeRecordingId(header(request, "x-infans-recording-id")),
    mimeType,
    durationMs: normalizeDurationMs(header(request, "x-infans-duration-ms"), limits.maximumDurationMs),
    language: normalizeLanguage(header(request, "x-infans-language")),
    properNounHints: decodeProperNounHints(header(request, "x-infans-proper-noun-hints"), limits),
    declaredLength: declaredLength ? Number(declaredLength) : null,
  };
}

async function spoolTemporaryAudio(request, metadata, { limits, temporaryRoot }) {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, "infans-transcription-"));
  await fs.chmod(directory, 0o700);
  const filePath = path.join(directory, `input${EXTENSION_BY_MIME[metadata.mimeType] || ".audio"}`);
  const file = await fs.open(filePath, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const rawChunk of request) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      sizeBytes += chunk.length;
      if (sizeBytes > limits.maximumBytes) {
        throw transcriptionError("录音文件太大了", 413, "TRANSCRIPTION_AUDIO_TOO_LARGE");
      }
      hash.update(chunk);
      await file.write(chunk);
    }
    if (!sizeBytes) throw transcriptionError("没有收到录音内容", 400, "TRANSCRIPTION_AUDIO_EMPTY");
    if (metadata.declaredLength !== null && metadata.declaredLength !== sizeBytes) {
      throw transcriptionError("录音长度与请求声明不一致", 400, "TRANSCRIPTION_CONTENT_LENGTH_MISMATCH");
    }
    await file.chmod(0o600);
    return {
      filePath,
      directory,
      sizeBytes,
      sha256: hash.digest("hex"),
      cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await file.close().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await file.close().catch(() => undefined);
  }
}

function normalizeProviderDescription(provider, raw = {}) {
  const id = String(raw.id || provider.id || "unknown").trim().slice(0, 80) || "unknown";
  const configured = raw.configured === true;
  const available = configured && raw.available === true;
  const state = available ? "ready" : configured ? String(raw.state || "unavailable") : "unconfigured";
  return {
    id,
    label: String(raw.label || (available ? "本地语音识别已就绪" : "本地语音识别尚未配置")).slice(0, 160),
    state,
    configured,
    available,
    model: raw.model ? String(raw.model).slice(0, 160) : null,
    version: raw.version ? String(raw.version).slice(0, 80) : null,
    execution: raw.execution === "local-process" || raw.execution === "local-library" ? raw.execution : "unspecified",
    capabilities: {
      properNounHints: raw.capabilities?.properNounHints === true,
      segments: raw.capabilities?.segments === true,
      confidence: raw.capabilities?.confidence === true,
      languageDetection: raw.capabilities?.languageDetection === true,
      cancellation: raw.capabilities?.cancellation === true,
    },
  };
}

export function createUnconfiguredSecretaryTranscriptionProvider() {
  return Object.freeze({
    id: "unconfigured",
    describe() {
      return {
        id: "unconfigured",
        label: "尚未配置本地语音识别模型",
        state: "unconfigured",
        configured: false,
        available: false,
        model: null,
        version: null,
        execution: "unspecified",
        capabilities: {
          properNounHints: false,
          segments: false,
          confidence: false,
          languageDetection: false,
          cancellation: false,
        },
      };
    },
    async transcribe() {
      throw transcriptionError("尚未配置本地语音识别模型", 503, "TRANSCRIPTION_PROVIDER_UNCONFIGURED");
    },
  });
}

async function describeProvider(provider) {
  if (!provider || typeof provider.describe !== "function" || typeof provider.transcribe !== "function") {
    throw new TypeError("transcription provider must implement describe() and transcribe()");
  }
  try {
    return normalizeProviderDescription(provider, await provider.describe());
  } catch {
    return normalizeProviderDescription(provider, {
      id: provider.id,
      label: "本地语音识别状态读取失败",
      state: "error",
      configured: true,
      available: false,
    });
  }
}

function normalizeConfidence(raw, field = "confidence") {
  if (raw === undefined || raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw transcriptionError(`provider 返回的 ${field} 不合法`, 502, "TRANSCRIPTION_PROVIDER_RESULT_INVALID");
  }
  return value;
}

function normalizeSegments(raw, durationMs) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 10_000) {
    throw transcriptionError("provider 返回的分段不合法", 502, "TRANSCRIPTION_PROVIDER_RESULT_INVALID");
  }
  let previousEnd = 0;
  return raw.map((segment) => {
    const startMs = Number(segment?.startMs);
    const endMs = Number(segment?.endMs);
    const text = String(segment?.text || "").trim();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < previousEnd || endMs < startMs || endMs > durationMs || !text) {
      throw transcriptionError("provider 返回的分段不合法", 502, "TRANSCRIPTION_PROVIDER_RESULT_INVALID");
    }
    previousEnd = endMs;
    const confidence = normalizeConfidence(segment?.confidence, "segment confidence");
    return { startMs: Math.round(startMs), endMs: Math.round(endMs), text, ...(confidence === undefined ? {} : { confidence }) };
  });
}

function normalizeProviderResult(raw, context) {
  const text = String(raw?.text || "").trim();
  if (!text || text.length > 200_000 || /\u0000/u.test(text)) {
    throw transcriptionError("provider 没有返回有效的转写文本", 502, "TRANSCRIPTION_PROVIDER_RESULT_INVALID");
  }
  const language = raw?.language ? normalizeLanguage(raw.language) : (context.language === "auto" ? null : context.language);
  const confidence = normalizeConfidence(raw?.confidence);
  return {
    protocolVersion: SECRETARY_TRANSCRIPTION_PROTOCOL_VERSION,
    recordingId: context.recordingId,
    duplicate: false,
    transcript: {
      text,
      language,
      segments: normalizeSegments(raw?.segments, context.durationMs),
      ...(confidence === undefined ? {} : { confidence }),
    },
    provider: {
      id: context.provider.id,
      model: raw?.model ? String(raw.model).slice(0, 160) : context.provider.model,
      version: raw?.version ? String(raw.version).slice(0, 80) : context.provider.version,
    },
    audio: {
      mimeType: context.mimeType,
      sizeBytes: context.sizeBytes,
      durationMs: context.durationMs,
      sha256: context.sha256,
    },
    request: {
      language: context.language,
      properNounHints: [...context.properNounHints],
    },
    retention: {
      audioPersisted: false,
      transcriptPersisted: false,
      idempotencyCache: "memory-only",
    },
    completedAt: context.now().toISOString(),
  };
}

function cloneResult(value) {
  return structuredClone(value);
}

function fingerprintFor(metadata, audio) {
  return crypto.createHash("sha256").update(JSON.stringify({
    sha256: audio.sha256,
    mimeType: metadata.mimeType,
    durationMs: metadata.durationMs,
    language: metadata.language,
    properNounHints: metadata.properNounHints,
  })).digest("hex");
}

function abortFailure(signal) {
  if (signal.reason instanceof WorkbenchWriteError) return signal.reason;
  return transcriptionError("转写已取消", 499, "TRANSCRIPTION_CANCELLED");
}

async function waitForProvider(providerPromise, signal) {
  if (signal.aborted) throw abortFailure(signal);
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(abortFailure(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  providerPromise.catch(() => undefined);
  try {
    return await Promise.race([providerPromise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Provider contract:
 * - describe() returns only safe identity/capability metadata.
 * - transcribe({ filePath, recordingId, mimeType, durationMs, sizeBytes, language,
 *   properNounHints, signal }) reads the temporary file and returns { text, ... }.
 * - providers must observe signal; the adapter still enforces a caller-visible timeout.
 */
export function createSecretaryTranscriptionService(options = {}) {
  const provider = options.provider || createUnconfiguredSecretaryTranscriptionProvider();
  const limits = effectiveLimits(options.limits);
  const temporaryRoot = path.resolve(options.temporaryRoot || os.tmpdir());
  const timeoutMs = Number(options.timeoutMs || SECRETARY_TRANSCRIPTION_LIMITS.defaultTimeoutMs);
  const maximumCachedResults = Number(options.maximumCachedResults || 128);
  const now = options.now || (() => new Date());
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");
  if (!Number.isSafeInteger(maximumCachedResults) || maximumCachedResults < 1) throw new TypeError("maximumCachedResults must be a positive integer");
  const inFlight = new Map();
  const completed = new Map();

  const remember = (recordingId, fingerprint, result) => {
    completed.delete(recordingId);
    completed.set(recordingId, { fingerprint, result: cloneResult(result) });
    while (completed.size > maximumCachedResults) completed.delete(completed.keys().next().value);
  };

  return {
    async status() {
      const providerStatus = await describeProvider(provider);
      return {
        protocol: { id: SECRETARY_TRANSCRIPTION_PROTOCOL_ID, version: SECRETARY_TRANSCRIPTION_PROTOCOL_VERSION },
        provider: providerStatus,
        available: providerStatus.available,
        capabilities: {
          transcription: providerStatus.available,
          cancellation: true,
          idempotency: "recording-id-plus-content",
          persistence: "none",
          temporaryAudio: "deleted-after-request",
          input: {
            transport: "raw-body",
            durationEvidence: "required-client-metadata",
            maximumBytes: limits.maximumBytes,
            maximumDurationMs: limits.maximumDurationMs,
            allowedMimeTypes: [...limits.allowedMimeTypes],
          },
          hints: {
            properNouns: true,
            providerReportsSupport: providerStatus.capabilities.properNounHints,
            header: "x-infans-proper-noun-hints",
            encoding: "base64url-json-string-array",
            maximumItems: limits.maximumProperNounHints,
            maximumItemChars: limits.maximumProperNounHintChars,
          },
          timeoutMs,
        },
        request: {
          recordingIdHeader: "x-infans-recording-id",
          durationMsHeader: "x-infans-duration-ms",
          languageHeader: "x-infans-language",
        },
        endpoints: {
          status: "GET /api/secretary-mobile/transcription/status",
          transcribe: "POST /api/secretary-mobile/transcription",
          cancel: "POST /api/secretary-mobile/transcription/cancel",
        },
        runtime: { activeRequests: inFlight.size, cachedResults: completed.size, cachePersistence: "memory-only" },
      };
    },

    async transcribe(request) {
      const providerStatus = await describeProvider(provider);
      if (!providerStatus.available) {
        throw transcriptionError(providerStatus.label, 503, "TRANSCRIPTION_PROVIDER_UNCONFIGURED");
      }
      const metadata = requestMetadata(request, limits);
      const audio = await spoolTemporaryAudio(request, metadata, { limits, temporaryRoot });
      const fingerprint = fingerprintFor(metadata, audio);
      try {
        const cached = completed.get(metadata.recordingId);
        if (cached) {
          if (cached.fingerprint !== fingerprint) {
            throw transcriptionError("同一录音 ID 已对应不同的内容或参数", 409, "TRANSCRIPTION_IDEMPOTENCY_CONFLICT");
          }
          completed.delete(metadata.recordingId);
          completed.set(metadata.recordingId, cached);
          return { ...cloneResult(cached.result), duplicate: true };
        }
        const active = inFlight.get(metadata.recordingId);
        if (active) {
          if (active.fingerprint !== fingerprint) {
            throw transcriptionError("同一录音 ID 正在处理不同的内容或参数", 409, "TRANSCRIPTION_IDEMPOTENCY_CONFLICT");
          }
          return { ...cloneResult(await active.promise), duplicate: true };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(
          transcriptionError("本地语音识别超时", 504, "TRANSCRIPTION_TIMEOUT"),
        ), timeoutMs);
        const providerPromise = Promise.resolve().then(() => provider.transcribe({
          filePath: audio.filePath,
          recordingId: metadata.recordingId,
          mimeType: metadata.mimeType,
          durationMs: metadata.durationMs,
          sizeBytes: audio.sizeBytes,
          sha256: audio.sha256,
          language: metadata.language,
          properNounHints: [...metadata.properNounHints],
          signal: controller.signal,
        }));
        const operation = waitForProvider(providerPromise, controller.signal)
          .then((raw) => normalizeProviderResult(raw, {
            ...metadata,
            ...audio,
            provider: providerStatus,
            now,
          }))
          .then((result) => {
            remember(metadata.recordingId, fingerprint, result);
            return result;
          })
          .catch((error) => {
            if (error instanceof WorkbenchWriteError) throw error;
            throw transcriptionError("本地语音识别没有完成", 502, "TRANSCRIPTION_PROVIDER_FAILED");
          })
          .finally(() => {
            clearTimeout(timeout);
            if (inFlight.get(metadata.recordingId)?.promise === operation) inFlight.delete(metadata.recordingId);
          });
        inFlight.set(metadata.recordingId, { fingerprint, controller, promise: operation });
        return cloneResult(await operation);
      } finally {
        await audio.cleanup().catch(() => undefined);
      }
    },

    cancel(input) {
      const recordingId = normalizeRecordingId(input?.recordingId);
      const active = inFlight.get(recordingId);
      if (!active) {
        return { recordingId, cancelled: false, state: completed.has(recordingId) ? "completed" : "not_found" };
      }
      if (!active.controller.signal.aborted) {
        active.controller.abort(transcriptionError("转写已取消", 499, "TRANSCRIPTION_CANCELLED"));
        return { recordingId, cancelled: true, duplicate: false, state: "cancelling" };
      }
      return { recordingId, cancelled: true, duplicate: true, state: "cancelling" };
    },

    dispose() {
      for (const active of inFlight.values()) {
        if (!active.controller.signal.aborted) {
          active.controller.abort(transcriptionError("转写服务已停止", 503, "TRANSCRIPTION_SERVICE_STOPPED"));
        }
      }
      completed.clear();
    },
  };
}

async function readJson(request, maximumBytes = 4_096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw transcriptionError("请求内容过大", 413, "TRANSCRIPTION_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw transcriptionError("请求内容不是有效 JSON", 400, "TRANSCRIPTION_INVALID_JSON");
  }
}

function sendJson(response, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Length", body.length);
  response.end(body);
}

export function createSecretaryTranscriptionRouteHandler({ service, authorize }) {
  if (!service || typeof service.status !== "function" || typeof service.transcribe !== "function" || typeof service.cancel !== "function") {
    throw new TypeError("transcription route requires a service");
  }
  if (typeof authorize !== "function") throw new TypeError("transcription route requires an authorizer");
  return async (request, response) => {
    const sub = String(request.url || "/").split("?")[0];
    try {
      if (request.method === "GET" && sub === "/status") {
        authorize(request, { requireJson: false });
        return sendJson(response, await service.status());
      }
      if (request.method === "POST" && (sub === "/" || sub === "")) {
        authorize(request, { requireJson: false });
        const recordingId = header(request, "x-infans-recording-id");
        const onClose = () => {
          try { service.cancel({ recordingId }); } catch { /* 无效 ID 由主请求统一返回。 */ }
        };
        response.once("close", onClose);
        try {
          return sendJson(response, await service.transcribe(request));
        } finally {
          response.off("close", onClose);
        }
      }
      if (request.method === "POST" && sub === "/cancel") {
        authorize(request, { requireJson: true });
        return sendJson(response, service.cancel(await readJson(request)));
      }
      authorize(request, { requireJson: request.method === "POST" });
      return sendJson(response, { error: "找不到这项转写能力", code: "TRANSCRIPTION_ROUTE_NOT_FOUND" }, 404);
    } catch (error) {
      if (response.headersSent) return undefined;
      const status = Number(error?.status || error?.statusCode) || 500;
      return sendJson(response, {
        error: error instanceof Error ? error.message : "本地转写没有完成",
        code: String(error?.code || "TRANSCRIPTION_FAILED"),
      }, status);
    }
  };
}
