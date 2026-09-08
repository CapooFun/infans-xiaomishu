export const DEFAULT_WORKBENCH_PORT = 5173;

export function normalizeWorkbenchPort(value) {
  const port = Number(value ?? DEFAULT_WORKBENCH_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_WORKBENCH_PORT;
  return port;
}

export function workbenchEndpoints(port = DEFAULT_WORKBENCH_PORT) {
  const safe = normalizeWorkbenchPort(port);
  return {
    origin: `http://127.0.0.1:${safe}`,
    intake: `http://127.0.0.1:${safe}/api/inbox`,
    health: `http://127.0.0.1:${safe}/api/health`,
  };
}

export const INTAKE_ENDPOINT = workbenchEndpoints().intake;
export const HEALTH_ENDPOINT = workbenchEndpoints().health;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
export const DEVICE_ID_PATTERN = /^[a-z0-9._-]{1,128}$/u;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu;
const FIELD_LIMITS = Object.freeze({
  url: 4_096,
  title: 300,
  text: 8_000,
  deviceName: 120,
});

export function clipText(value, limit) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(CONTROL_CHARACTERS, " ")
    .trim()
    .slice(0, limit);
}

export function normalizeHttpUrl(value) {
  const raw = clipText(value, FIELD_LIMITS.url);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export function buildContextDraft(kind, info = {}, tab = {}) {
  const pageUrl = normalizeHttpUrl(info.pageUrl || tab.url);
  const title = clipText(tab.title, FIELD_LIMITS.title);
  if (kind === "page") {
    if (!pageUrl) throw new Error("当前页不是可发送的 HTTP／HTTPS 网页");
    return { kind, url: pageUrl, title, text: "" };
  }
  if (kind === "link") {
    const url = normalizeHttpUrl(info.linkUrl);
    if (!url) throw new Error("这个链接不是公开 HTTP／HTTPS 网址");
    return { kind, url, title, text: "" };
  }
  if (kind === "selection") {
    const text = clipText(info.selectionText, FIELD_LIMITS.text);
    if (!text) throw new Error("没有可发送的选中文字");
    return { kind, url: pageUrl, title, text };
  }
  if (kind === "image") {
    const url = normalizeHttpUrl(info.srcUrl);
    if (!url) throw new Error("第一版只能发送公开 HTTP／HTTPS 图片网址");
    return { kind, url, title, text: "" };
  }
  throw new Error("不支持的来件类型");
}

export function inferContextKind(info = {}) {
  if (clipText(info.srcUrl, FIELD_LIMITS.url)) return "image";
  if (clipText(info.linkUrl, FIELD_LIMITS.url)) return "link";
  if (clipText(info.selectionText, FIELD_LIMITS.text)) return "selection";
  return "page";
}

export function normalizeLocalConfig(value = {}) {
  const token = clipText(value.token, 128);
  const deviceId = clipText(value.deviceId, 128).toLowerCase();
  const deviceName = clipText(value.deviceName || "Mac Chrome", FIELD_LIMITS.deviceName) || "Mac Chrome";
  return {
    token: TOKEN_PATTERN.test(token) ? token : "",
    deviceId: DEVICE_ID_PATTERN.test(deviceId) ? deviceId : "",
    deviceName,
    port: normalizeWorkbenchPort(value.port),
  };
}

export function createQueueItem(draft, config, dependencies = {}) {
  const uuid = dependencies.uuid || (() => crypto.randomUUID());
  const now = dependencies.now || (() => new Date());
  const normalizedConfig = normalizeLocalConfig(config);
  const intakeId = String(uuid()).toLowerCase();
  if (!UUID_PATTERN.test(intakeId)) throw new Error("无法生成稳定来件 ID");
  if (!normalizedConfig.deviceId) throw new Error("本机 Chrome 设备标识未初始化");
  const url = normalizeHttpUrl(draft?.url);
  const text = clipText(draft?.text, FIELD_LIMITS.text);
  if (!url && !text) throw new Error("来件至少需要网址或文字");
  const createdAt = now().toISOString();
  return {
    intakeId,
    enqueuedAt: createdAt,
    status: "pending",
    attempts: 0,
    nextAttemptAt: Date.parse(createdAt),
    lastAttemptAt: null,
    lastError: "",
    payload: {
      schemaVersion: 1,
      intakeId,
      url,
      title: clipText(draft?.title, FIELD_LIMITS.title),
      text,
      source: "chrome_extension",
      sourceApp: "Google Chrome",
      deviceId: normalizedConfig.deviceId,
      deviceName: normalizedConfig.deviceName,
      createdAt,
    },
  };
}

export function retryDelayMs(attempt, random = Math.random) {
  const safeAttempt = Math.max(1, Math.min(20, Number(attempt) || 1));
  const base = Math.min(60 * 60_000, 30_000 * (2 ** (safeAttempt - 1)));
  const jitter = Math.floor(base * 0.15 * Math.max(0, Math.min(1, Number(random()) || 0)));
  return base + jitter;
}

export function markRetryPending(item, error, dependencies = {}) {
  const nowMs = Number(dependencies.nowMs ?? Date.now());
  const random = dependencies.random || Math.random;
  const attempts = Math.max(0, Number(item?.attempts) || 0) + 1;
  return {
    ...item,
    status: "failed_retry_pending",
    attempts,
    nextAttemptAt: nowMs + retryDelayMs(attempts, random),
    lastError: clipText(error, 300),
  };
}

export function makeQueueDueNow(queue = [], nowMs = Date.now()) {
  const dueAt = Number(nowMs);
  return (Array.isArray(queue) ? queue : []).map((item) => ({
    ...item,
    nextAttemptAt: Number.isFinite(dueAt) ? dueAt : Date.now(),
  }));
}

export function validateMacPersistedReceipt(receipt, intakeId) {
  if (receipt?.ok !== true
    || receipt?.status !== "delivered"
    || receipt?.deliveryBoundary !== "mac_persisted"
    || receipt?.intakeId !== intakeId
    || !UUID_PATTERN.test(String(receipt?.canonicalItemId || ""))) {
    throw new Error("Mac 未返回可确认已落盘的回执");
  }
  return {
    ok: true,
    duplicate: receipt.duplicate === true,
    intakeId,
    canonicalItemId: String(receipt.canonicalItemId).toLowerCase(),
    status: "delivered",
    deliveredAt: String(receipt.deliveredAt || ""),
    deliveryBoundary: "mac_persisted",
  };
}

export function publicQueueStatus(queue = [], recentDeliveries = [], config = {}) {
  const normalizedConfig = normalizeLocalConfig(config);
  const items = Array.isArray(queue) ? queue : [];
  return {
    configured: Boolean(normalizedConfig.token),
    deviceId: normalizedConfig.deviceId,
    deviceName: normalizedConfig.deviceName,
    queued: items.length,
    sending: items.filter((item) => item?.status === "sending").length,
    failedRetryPending: items.filter((item) => item?.status === "failed_retry_pending").length,
    lastError: clipText(items.findLast((item) => item?.lastError)?.lastError, 300),
    lastDelivered: Array.isArray(recentDeliveries) ? (recentDeliveries[0] || null) : null,
    port: normalizedConfig.port,
  };
}
