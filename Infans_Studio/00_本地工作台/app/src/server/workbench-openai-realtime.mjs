import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chatCharacterById, normalizeChatSpeaker } from "../secretary-characters.mjs";
import { readSecretaryPersonaContext } from "./workbench-secretary-personas.mjs";

const execFileAsync = promisify(execFile);

export const OPENAI_REALTIME_MODEL = "gpt-realtime-2.1-mini";
export const OPENAI_REALTIME_MODELS = Object.freeze({
  "gpt-realtime-2.1-mini": Object.freeze({ label: "GPT-Realtime-2.1 mini", cost: "较低成本" }),
  "gpt-realtime-2.1": Object.freeze({ label: "GPT-Realtime-2.1", cost: "较强表现" }),
});
export const OPENAI_REALTIME_API_URL = "https://api.openai.com/v1/realtime/calls";
export const OPENAI_REALTIME_KEYCHAIN_ACCOUNT = "Infans";
export const OPENAI_REALTIME_KEYCHAIN_SERVICE = "Infans OpenAI API";
export const OPENAI_REALTIME_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_REALTIME_TIMEOUT_MS = 20_000;

export class OpenAIRealtimeError extends Error {
  constructor(message, { code = "OPENAI_REALTIME_FAILED", status = 502, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OpenAIRealtimeError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

/** 长期密钥只从 macOS 钥匙串读取，绝不进入浏览器、仓库或日志。 */
export async function readOpenAIRealtimeApiKey({ execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl("/usr/bin/security", [
      "find-generic-password",
      "-a", OPENAI_REALTIME_KEYCHAIN_ACCOUNT,
      "-s", OPENAI_REALTIME_KEYCHAIN_SERVICE,
      "-w",
    ], { timeout: 5_000, maxBuffer: 16_384 });
    const apiKey = String(stdout || "").trim();
    if (!apiKey) throw new Error("empty key");
    return apiKey;
  } catch {
    throw new OpenAIRealtimeError("还没有配置 OpenAI API 密钥。", {
      code: "OPENAI_REALTIME_KEY_REQUIRED",
      status: 503,
    });
  }
}

export async function openAIRealtimeStatus(options = {}) {
  try {
    await readOpenAIRealtimeApiKey(options);
    return {
      available: true,
      configured: true,
      health: "configured",
      model: OPENAI_REALTIME_MODEL,
      models: Object.entries(OPENAI_REALTIME_MODELS).map(([id, item]) => ({ id, ...item })),
      label: "OpenAI 实时语音已配置",
      privacy: "实时语音和当前角色规则会发送给 OpenAI，并消耗 OpenAI API 额度。",
    };
  } catch (error) {
    return {
      available: false,
      configured: false,
      health: "missing",
      model: OPENAI_REALTIME_MODEL,
      models: Object.entries(OPENAI_REALTIME_MODELS).map(([id, item]) => ({ id, ...item })),
      label: error instanceof Error ? error.message : "OpenAI 实时语音尚未配置",
      privacy: "密钥只保存在本机钥匙串；未配置时不会向 OpenAI 发请求。",
    };
  }
}

function normalizeRealtimeModel(raw) {
  const model = String(raw || OPENAI_REALTIME_MODEL).trim();
  if (!Object.hasOwn(OPENAI_REALTIME_MODELS, model)) {
    throw new OpenAIRealtimeError("未知 OpenAI Realtime 模型。", {
      code: "OPENAI_REALTIME_UNKNOWN_MODEL",
      status: 400,
    });
  }
  return model;
}

export function buildOpenAIRealtimeSessionConfig({ speaker, personaContext, includeTranscription = false, model } = {}) {
  const speakerId = normalizeChatSpeaker(speaker);
  const character = speakerId ? chatCharacterById(speakerId) : null;
  if (!character) {
    throw new OpenAIRealtimeError("未知实时语音角色。", {
      code: "OPENAI_REALTIME_UNKNOWN_SPEAKER",
      status: 400,
    });
  }
  const instructions = [
    `你现在只扮演${character.name}，不得切换、模仿或代替其他角色说话。`,
    "这是与用户的一对一实时语音。使用自然、口语化的简体中文；先回应刚听到的话，不复述系统规则。",
    "通常每次只说一至三句，控制在二十秒以内；需要深入时也要给对方随时插话的空间。",
    "如果用户在你说话时开口，立刻停下并听新的内容，不责怪、不解释打断机制。",
    String(personaContext || "").trim(),
  ].filter(Boolean).join("\n\n");

  const input = {
    turn_detection: {
      type: "semantic_vad",
      eagerness: "medium",
      create_response: true,
      interrupt_response: true,
    },
  };
  if (includeTranscription) {
    input.transcription = {
      model: OPENAI_REALTIME_TRANSCRIPTION_MODEL,
      language: "zh",
    };
  }

  return {
    type: "realtime",
    model: normalizeRealtimeModel(model),
    output_modalities: ["audio"],
    instructions,
    audio: {
      input,
      output: { voice: character.realtimeVoice || "marin" },
    },
    truncation: {
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: { post_instructions: 4_000 },
    },
  };
}

function requestError(status) {
  if (status === 401 || status === 403) {
    return new OpenAIRealtimeError("OpenAI API 密钥无效或没有 Realtime 权限。", {
      code: "OPENAI_REALTIME_AUTH_FAILED",
      status: 503,
    });
  }
  if (status === 402 || status === 429) {
    return new OpenAIRealtimeError("OpenAI API 额度不足或请求过于频繁。", {
      code: "OPENAI_REALTIME_CREDITS_OR_RATE_LIMIT",
      status,
    });
  }
  return new OpenAIRealtimeError("OpenAI 实时语音暂时没有建立成功。", {
    code: "OPENAI_REALTIME_UPSTREAM_FAILED",
    status: 502,
  });
}

export async function createOpenAIRealtimeCall({
  sdp,
  speaker,
  vaultRoot,
  includeTranscription = false,
  model,
  apiKey,
  fetchImpl = globalThis.fetch,
  execFileImpl,
  personaReader = readSecretaryPersonaContext,
  signal,
} = {}) {
  const offer = String(sdp || "").trim();
  if (!offer.startsWith("v=0") || offer.length > 262_144) {
    throw new OpenAIRealtimeError("浏览器没有提供有效的 WebRTC 会话。", {
      code: "OPENAI_REALTIME_INVALID_SDP",
      status: 400,
    });
  }
  const speakerId = normalizeChatSpeaker(speaker);
  if (!speakerId) {
    throw new OpenAIRealtimeError("未知实时语音角色。", {
      code: "OPENAI_REALTIME_UNKNOWN_SPEAKER",
      status: 400,
    });
  }
  const secret = apiKey || await readOpenAIRealtimeApiKey({ execFileImpl });
  const personaContext = await personaReader(vaultRoot, [speakerId]);
  const session = buildOpenAIRealtimeSessionConfig({
    speaker: speakerId,
    personaContext,
    includeTranscription,
    model,
  });
  const body = new FormData();
  body.set("sdp", offer);
  body.set("session", JSON.stringify(session));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), OPENAI_REALTIME_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    const response = await fetchImpl(OPENAI_REALTIME_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body,
      signal: requestSignal,
    });
    if (!response.ok) throw requestError(response.status);
    const answerSdp = String(await response.text()).trim();
    if (!answerSdp.startsWith("v=0")) {
      throw new OpenAIRealtimeError("OpenAI 没有返回有效的 WebRTC 会话。", {
        code: "OPENAI_REALTIME_INVALID_ANSWER",
        status: 502,
      });
    }
    return { answerSdp, model: session.model, speaker: speakerId };
  } catch (error) {
    if (error instanceof OpenAIRealtimeError) throw error;
    throw new OpenAIRealtimeError("连接 OpenAI 实时语音超时或网络不可用。", {
      code: "OPENAI_REALTIME_NETWORK_FAILED",
      status: 503,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}
