import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const OPENROUTER_MODEL = "";
export const OPENROUTER_MODEL_LABEL = "外部模型";
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_KEY_STATUS_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_KEYCHAIN_ACCOUNT = "Infans";
export const OPENROUTER_KEYCHAIN_SERVICE = "Infans OpenRouter API";
const OPENROUTER_TIMEOUT_MS = 180_000;
const OPENROUTER_STATUS_TIMEOUT_MS = 8_000;
const OPENROUTER_STATUS_CACHE_MS = 30_000;
let openRouterStatusCache = { checkedAt: 0, value: null };

export class OpenRouterRequestError extends Error {
  constructor(message, { code = "OPENROUTER_FAILED", status = 502, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OpenRouterRequestError";
    this.code = code;
    this.status = status;
  }
}

/**
 * 密钥只从 macOS 钥匙串读取，不进入仓库、环境文件或日志。
 */
export async function readOpenRouterApiKey({ execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl("/usr/bin/security", [
      "find-generic-password",
      "-a", OPENROUTER_KEYCHAIN_ACCOUNT,
      "-s", OPENROUTER_KEYCHAIN_SERVICE,
      "-w",
    ], { timeout: 5000 });
    const apiKey = String(stdout || "").trim();
    if (!apiKey) throw new Error("empty key");
    return apiKey;
  } catch {
    throw new OpenRouterRequestError("还没有配置 OpenRouter 密钥。", {
      code: "OPENROUTER_KEY_REQUIRED",
      status: 503,
    });
  }
}

export async function openRouterStatus(options = {}) {
  let apiKey;
  try {
    apiKey = options.apiKey || await readOpenRouterApiKey(options);
  } catch (error) {
    return {
      available: false,
      configured: false,
      health: "missing",
      model: OPENROUTER_MODEL,
      label: error instanceof Error ? error.message : "OpenRouter 尚未配置",
      privacy: "禁止训练；提供方可能保留请求",
    };
  }

  const configured = {
    available: true,
    configured: true,
    health: "configured",
    model: OPENROUTER_MODEL,
    label: `外部模型已配置 · ${OPENROUTER_MODEL_LABEL}`,
    privacy: "禁止训练；提供方可能保留请求",
  };
  if (!options.probe) return configured;

  const useCache = options.cache !== false && !options.fetchImpl && !options.apiKey && !options.execFileImpl;
  if (useCache && openRouterStatusCache.value && Date.now() - openRouterStatusCache.checkedAt < OPENROUTER_STATUS_CACHE_MS) {
    return openRouterStatusCache.value;
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), OPENROUTER_STATUS_TIMEOUT_MS);
  try {
    const response = await fetchImpl(OPENROUTER_KEY_STATUS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ...configured,
        available: false,
        health: "auth_failed",
        label: "OpenRouter 密钥已失效或被停用",
      };
    }
    if (!response.ok) {
      return {
        ...configured,
        health: "unknown",
        label: `外部模型已配置 · ${OPENROUTER_MODEL_LABEL}（暂未核验余额）`,
      };
    }
    const payload = await response.json();
    const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
    const usageUsd = Number.isFinite(Number(data.usage)) ? Number(data.usage) : null;
    const limitUsd = Number.isFinite(Number(data.limit)) ? Number(data.limit) : null;
    const limitRemainingUsd = Number.isFinite(Number(data.limit_remaining)) ? Number(data.limit_remaining) : null;
    const exhausted = limitRemainingUsd != null && limitRemainingUsd <= 0;
    const value = {
      ...configured,
      available: !exhausted,
      health: exhausted ? "credits_required" : "ok",
      label: exhausted
        ? "OpenRouter 密钥额度已用完"
        : `外部模型可用 · ${OPENROUTER_MODEL_LABEL}`,
      usageUsd,
      limitUsd,
      limitRemainingUsd,
      checkedAt: new Date().toISOString(),
    };
    if (useCache) openRouterStatusCache = { checkedAt: Date.now(), value };
    return value;
  } catch {
    return {
      ...configured,
      health: "unknown",
      label: `外部模型已配置 · ${OPENROUTER_MODEL_LABEL}（暂未核验余额）`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessageFromPayload(payload, fallback = "") {
  if (!payload || typeof payload !== "object") return fallback;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.error?.message === "string") return payload.error.message;
  if (typeof payload.message === "string") return payload.message;
  return fallback;
}

function requestError(status, detail = "") {
  const normalized = String(detail || "").toLowerCase();
  if (status === 401 || status === 403) {
    return new OpenRouterRequestError("OpenRouter 密钥无效或已停用。", {
      code: "OPENROUTER_AUTH_FAILED",
      status: 503,
    });
  }
  if (status === 402 || /insufficient|credit|balance|payment/.test(normalized)) {
    return new OpenRouterRequestError("OpenRouter 余额不足，需要充值后再试。", {
      code: "OPENROUTER_CREDITS_REQUIRED",
      status: 402,
    });
  }
  if (/data collection|privacy|data policy|no endpoints/.test(normalized)) {
    return new OpenRouterRequestError("外部模型当前没有符合“不用于训练”要求的可用端点。", {
      code: "OPENROUTER_PRIVACY_UNAVAILABLE",
      status: 503,
    });
  }
  if (status === 429) {
    return new OpenRouterRequestError("OpenRouter 请求太频繁，稍等一会儿再试。", {
      code: "OPENROUTER_RATE_LIMITED",
      status: 429,
    });
  }
  if (status === 503 || status === 502) {
    return new OpenRouterRequestError("外部模型暂时不可用，请稍后再试。", {
      code: "OPENROUTER_UNAVAILABLE",
      status: 503,
    });
  }
  return new OpenRouterRequestError("外部模型这次没有成功回答。", {
    code: "OPENROUTER_FAILED",
    status: 502,
  });
}

/**
 * 解析 OpenRouter 的单个 SSE 事件。注释心跳和 [DONE] 都不会当作 JSON。
 */
export function parseOpenRouterSseEvent(eventText = "") {
  const data = String(eventText)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return { ignored: true };
  if (data === "[DONE]") return { done: true };
  try {
    const payload = JSON.parse(data);
    if (payload?.error) {
      return {
        error: requestError(Number(payload.error?.code) || 502, errorMessageFromPayload(payload)),
      };
    }
    return {
      text: typeof payload?.choices?.[0]?.delta?.content === "string"
        ? payload.choices[0].delta.content
        : "",
      usage: payload?.usage && typeof payload.usage === "object" ? payload.usage : null,
    };
  } catch {
    return { ignored: true };
  }
}

async function consumeOpenRouterStream(body, onChunk) {
  if (!body) throw new OpenRouterRequestError("外部模型没有返回内容。", { code: "OPENROUTER_EMPTY", status: 502 });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let usage = null;
  let streamError = null;

  const consumeEvent = (eventText) => {
    const event = parseOpenRouterSseEvent(eventText);
    if (event.error) {
      streamError = event.error;
      return;
    }
    if (event.usage) usage = event.usage;
    if (event.text) {
      answer += event.text;
      onChunk?.(event.text);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consumeEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (streamError) {
        await reader.cancel().catch(() => {});
        throw streamError;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeEvent(buffer);
  if (streamError) throw streamError;
  if (!answer.trim()) {
    throw new OpenRouterRequestError("外部模型没有返回可显示的文字。", {
      code: "OPENROUTER_EMPTY",
      status: 502,
    });
  }
  return { answer, usage };
}

/**
 * 只承接一对一纯文本。provider.data_collection=deny 会拒绝任何可能训练/收集请求的端点；
 * 开源版不带作者私人模型，也不冒充零留存。
 */
export async function streamOpenRouterChat({
  systemPrompt,
  question,
  signal,
  onChunk,
  fetchImpl = globalThis.fetch,
  apiKey,
  temperature = 0.95,
  maxTokens = 1400,
  requestTitle = "Infans Secretary Chat",
} = {}) {
  const secret = apiKey || await readOpenRouterApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), OPENROUTER_TIMEOUT_MS);
  const abort = () => controller.abort("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "X-Title": String(requestTitle || "Infans Secretary Chat").replace(/[^\x20-\x7e]/g, "").slice(0, 80) || "Infans Secretary Chat",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: String(systemPrompt || "") },
          { role: "user", content: String(question || "") },
        ],
        stream: true,
        temperature: Math.max(0, Math.min(2, Number(temperature) || 0.95)),
        max_tokens: Math.max(64, Math.min(2400, Math.round(Number(maxTokens) || 1400))),
        provider: {
          data_collection: "deny",
          allow_fallbacks: false,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        detail = errorMessageFromPayload(payload);
      } catch {
        detail = "";
      }
      throw requestError(response.status, detail);
    }
    const result = await consumeOpenRouterStream(response.body, onChunk);
    return {
      ...result,
      model: OPENROUTER_MODEL,
      generationId: response.headers.get("x-generation-id") || "",
    };
  } catch (error) {
    if (error instanceof OpenRouterRequestError) throw error;
    if (controller.signal.aborted) {
      if (signal?.aborted || controller.signal.reason === "cancelled") {
        throw new OpenRouterRequestError("已停止生成。", { code: "CANCELLED", status: 499 });
      }
      throw new OpenRouterRequestError("回答超时，已停止生成。", { code: "TIMEOUT", status: 504 });
    }
    throw new OpenRouterRequestError("暂时连不上 OpenRouter。", {
      code: "OPENROUTER_NETWORK_FAILED",
      status: 503,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
