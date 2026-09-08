import {
  TOKEN_PATTERN,
  buildContextDraft,
  clipText,
  createQueueItem,
  inferContextKind,
  makeQueueDueNow,
  markRetryPending,
  normalizeLocalConfig,
  publicQueueStatus,
  validateMacPersistedReceipt,
  workbenchEndpoints,
} from "./core.mjs";

const STORAGE_KEYS = Object.freeze({
  config: "inboxIntakeConfigV1",
  queue: "inboxIntakeQueueV1",
  delivered: "inboxIntakeDeliveredV1",
});
const RETRY_ALARM = "inbox-intake-retry";
const CLEAR_BADGE_ALARM = "inbox-intake-clear-badge";
const MENU_SEND = "inbox-intake-send";
const REQUEST_TIMEOUT_MS = 12_000;
const RECENT_DELIVERY_LIMIT = 20;
const LOCAL_ACCESS_HELP_COOLDOWN_MS = 10 * 60_000;

let operationChain = Promise.resolve();
let lastLocalAccessHelpAt = 0;

function serialize(operation) {
  const current = operationChain.then(operation, operation);
  operationChain = current.catch(() => undefined);
  return current;
}

async function readLocalState() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  return {
    config: normalizeLocalConfig(stored[STORAGE_KEYS.config]),
    queue: Array.isArray(stored[STORAGE_KEYS.queue]) ? stored[STORAGE_KEYS.queue] : [],
    delivered: Array.isArray(stored[STORAGE_KEYS.delivered]) ? stored[STORAGE_KEYS.delivered] : [],
  };
}

async function ensureLocalIdentity() {
  const state = await readLocalState();
  if (state.config.deviceId) return state.config;
  const config = {
    ...state.config,
    deviceId: `chrome-${crypto.randomUUID()}`,
    deviceName: state.config.deviceName || "Mac Chrome",
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: config });
  return config;
}

async function setBadge(text, color, title) {
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setTitle({ title }),
  ]);
}

async function clearBadgeSoon(delayInMinutes = 0.08) {
  await chrome.alarms.create(CLEAR_BADGE_ALARM, { delayInMinutes });
}

async function showError(error) {
  await setBadge("×", "#9b3d38", clipText(error?.message || error, 180) || "发送失败，已保留待重试");
  await clearBadgeSoon();
}

async function showPageFeedback(tabId, { variant, message }) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [variant, message, chrome.runtime.getURL("icons/yingning-128.png")],
      func: (feedbackVariant, feedbackMessage, avatarUrl) => {
        const id = "__infans-yinyue-delivery-feedback";
        document.getElementById(id)?.remove();
        const host = document.createElement("div");
        host.id = id;
        host.setAttribute("role", "status");
        host.setAttribute("aria-live", "polite");
        host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);pointer-events:none;";
        const root = host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = `
          @keyframes arrive { 0% { opacity:0; transform:translateY(-9px) scale(.96); } 14%,78% { opacity:1; transform:translateY(0) scale(1); } 100% { opacity:0; transform:translateY(-5px) scale(.99); } }
          .receipt { position:relative; min-width:286px; min-height:70px; box-sizing:border-box; margin-left:38px; padding:10px 27px 10px 64px; display:flex; align-items:center; color:#f3e5bd; border:1px solid rgba(199,165,96,.76); border-radius:18px; background:radial-gradient(circle at 8% 50%,rgba(38,112,101,.44),transparent 38%),linear-gradient(102deg,rgba(7,18,20,.97),rgba(19,33,30,.96) 61%,rgba(11,19,19,.98)); box-shadow:0 18px 52px rgba(0,0,0,.38),inset 0 0 24px rgba(130,179,159,.06); animation:arrive 2.6s cubic-bezier(.2,.72,.24,1) both; overflow:visible; }
          .receipt::before { content:""; position:absolute; inset:4px; border:1px solid rgba(218,194,138,.18); border-radius:14px; }
          .receipt[data-variant="failure"] { color:#f2d6c8; border-color:rgba(191,115,88,.78); background:radial-gradient(circle at 13% 48%,rgba(107,64,45,.42),transparent 40%),linear-gradient(102deg,rgba(24,14,13,.97),rgba(48,27,23,.96) 61%,rgba(22,14,13,.98)); }
          img { position:absolute; z-index:2; left:-38px; top:50%; width:82px; height:82px; box-sizing:border-box; border:3px solid rgba(249,235,199,.96); border-radius:50%; object-fit:cover; transform:translateY(-50%); background:#f7ead0; box-shadow:0 10px 24px rgba(0,0,0,.42),0 0 0 1px rgba(164,126,57,.78),0 0 22px rgba(218,194,138,.18); }
          strong { position:relative; z-index:1; display:block; max-width:min(440px,calc(100vw - 150px)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font:600 22px/1.25 "Kaiti SC","STKaiti","KaiTi",serif; letter-spacing:.08em; text-shadow:0 2px 10px rgba(0,0,0,.62); }
          @media (prefers-reduced-motion:reduce) { .receipt { animation:none; } }
        `;
        const receipt = document.createElement("div");
        receipt.className = "receipt";
        receipt.dataset.variant = feedbackVariant;
        const avatar = document.createElement("img");
        avatar.src = avatarUrl;
        avatar.alt = "";
        const copy = document.createElement("strong");
        copy.textContent = feedbackMessage;
        receipt.append(avatar, copy);
        root.append(style, receipt);
        document.documentElement.append(host);
        window.setTimeout(() => host.remove(), 2_700);
      },
    });
  } catch {
    // Chrome 内部页、PDF 或已经离开的标签无法注入；真实回执仍由绿色勾保留。
  }
}

function showDeliveredFeedback(tabId) {
  return showPageFeedback(tabId, { variant: "success", message: "小秘书已收到" });
}

function isLocalConnectionFailure(error) {
  const message = String(error?.message || error || "");
  return /failed to fetch|networkerror|load failed|mac 接口超时/iu.test(message);
}

function showFailedFeedback(tabId, error) {
  const message = isLocalConnectionFailure(error)
    ? "还没送达 · 请允许 Chrome 连接这台 Mac"
    : "还没送达 · 已保留在本地队列";
  return showPageFeedback(tabId, { variant: "failure", message });
}

async function openLocalAccessHelpIfNeeded(candidate, error) {
  if (!Number.isInteger(candidate?.feedbackTabId) || !isLocalConnectionFailure(error)) return;
  const now = Date.now();
  if (now - lastLocalAccessHelpAt < LOCAL_ACCESS_HELP_COOLDOWN_MS) return;
  lastLocalAccessHelpAt = now;
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    // 选项页打不开时仍保留失败提示、徽标和可靠队列。
  }
}

async function updateQueueBadge(queue, { delivered = false, configured = true } = {}) {
  if (delivered && queue.length === 0) {
    await setBadge("✓", "#167b6b", "已送达：Mac 已持久化");
    await clearBadgeSoon();
    return;
  }
  if (!configured && queue.length > 0) {
    await setBadge("配", "#9a6a20", `${queue.length} 件待送达；请先完成本机配对`);
    return;
  }
  if (queue.length > 0) {
    await setBadge(String(Math.min(queue.length, 99)), "#9a6a20", `${queue.length} 件在本地队列等待送达`);
    return;
  }
  await setBadge("", "#167b6b", "一键发给秘书");
}

async function scheduleNextAttempt(queue) {
  await chrome.alarms.clear(RETRY_ALARM);
  if (!queue.length) return;
  const next = Math.min(...queue.map((item) => Number(item?.nextAttemptAt) || Date.now()));
  await chrome.alarms.create(RETRY_ALARM, { when: Math.max(Date.now() + 1_000, next) });
}

async function postIntake(item, token, port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(workbenchEndpoints(port).intake, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(item.payload),
      cache: "no-store",
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `Mac 接口返回 HTTP ${response.status}`);
    return validateMacPersistedReceipt(body, item.intakeId);
  } finally {
    clearTimeout(timeout);
  }
}

async function processQueueUnlocked({ force = false } = {}) {
  const state = await readLocalState();
  const now = Date.now();
  let queue = state.queue.map((item) => item?.status === "sending"
    ? { ...item, status: "failed_retry_pending", nextAttemptAt: now, lastError: "上次发送被中断，已保留原 ID 重试" }
    : item);
  if (force) queue = makeQueueDueNow(queue, now);
  let delivered = state.delivered;
  let deliveredThisRun = false;

  if (!state.config.token) {
    queue = queue.map((item) => ({
      ...item,
      status: "failed_retry_pending",
      nextAttemptAt: Math.max(Number(item?.nextAttemptAt) || 0, now + 5 * 60_000),
      lastError: "尚未配置本机设备令牌",
    }));
    await chrome.storage.local.set({ [STORAGE_KEYS.queue]: queue });
    await scheduleNextAttempt(queue);
    await updateQueueBadge(queue, { configured: false });
    return publicQueueStatus(queue, delivered, state.config);
  }

  for (const candidate of [...queue]) {
    if ((Number(candidate?.nextAttemptAt) || 0) > Date.now()) continue;
    const index = queue.findIndex((item) => item?.intakeId === candidate?.intakeId);
    if (index < 0) continue;
    queue[index] = { ...queue[index], status: "sending", lastAttemptAt: new Date().toISOString() };
    await chrome.storage.local.set({ [STORAGE_KEYS.queue]: queue });
    let deliveredFeedbackTabId = null;
    try {
      const receipt = await postIntake(queue[index], state.config.token, state.config.port);
      delivered = [{
        intakeId: candidate.intakeId,
        title: candidate.payload?.title || candidate.payload?.url || "来件",
        receipt,
      }, ...delivered.filter((item) => item?.intakeId !== candidate.intakeId)].slice(0, RECENT_DELIVERY_LIMIT);
      queue = queue.filter((item) => item?.intakeId !== candidate.intakeId);
      deliveredThisRun = true;
      deliveredFeedbackTabId = Number.isInteger(candidate.feedbackTabId) ? candidate.feedbackTabId : null;
    } catch (error) {
      const deliveryError = error?.name === "AbortError" ? new Error("Mac 接口超时") : error;
      const failedIndex = queue.findIndex((item) => item?.intakeId === candidate?.intakeId);
      if (failedIndex >= 0) {
        queue[failedIndex] = markRetryPending(
          queue[failedIndex],
          deliveryError?.message || deliveryError,
        );
      }
      if (Number.isInteger(candidate.feedbackTabId)) {
        await showFailedFeedback(candidate.feedbackTabId, deliveryError);
      }
      await openLocalAccessHelpIfNeeded(candidate, deliveryError);
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.queue]: queue,
      [STORAGE_KEYS.delivered]: delivered,
    });
    if (deliveredFeedbackTabId !== null) await showDeliveredFeedback(deliveredFeedbackTabId);
  }

  await scheduleNextAttempt(queue);
  await updateQueueBadge(queue, { delivered: deliveredThisRun, configured: true });
  return publicQueueStatus(queue, delivered, state.config);
}

function processQueue(options) {
  return serialize(() => processQueueUnlocked(options));
}

async function enqueueDraft(draft, { feedbackTabId } = {}) {
  const item = await serialize(async () => {
    const config = await ensureLocalIdentity();
    const state = await readLocalState();
    const created = createQueueItem(draft, config);
    if (Number.isInteger(feedbackTabId)) created.feedbackTabId = feedbackTabId;
    const queue = [...state.queue, created];
    await chrome.storage.local.set({ [STORAGE_KEYS.queue]: queue });
    await scheduleNextAttempt(queue);
    await updateQueueBadge(queue, { configured: Boolean(config.token) });
    return created;
  });
  void processQueue();
  return { intakeId: item.intakeId, status: "pending" };
}

async function saveConfig(input = {}) {
  return serialize(async () => {
    const existing = await ensureLocalIdentity();
    const suppliedToken = clipText(input.token, 128);
    if (suppliedToken && !TOKEN_PATTERN.test(suppliedToken)) {
      throw new Error("设备令牌格式不对");
    }
    const config = normalizeLocalConfig({
      ...existing,
      token: suppliedToken || existing.token,
      deviceName: input.deviceName || existing.deviceName,
      port: input.port,
    });
    await chrome.storage.local.set({ [STORAGE_KEYS.config]: config });
    return config;
  }).then(async (config) => {
    void processQueue({ force: true });
    return { ok: true, configured: Boolean(config.token), deviceId: config.deviceId, deviceName: config.deviceName, port: config.port };
  });
}

async function clearPairing() {
  const result = await serialize(async () => {
    const config = await ensureLocalIdentity();
    await chrome.storage.local.set({ [STORAGE_KEYS.config]: { ...config, token: "" } });
    return { ok: true };
  });
  void processQueue();
  return result;
}

async function getStatus() {
  const state = await readLocalState();
  return publicQueueStatus(state.queue, state.delivered, state.config);
}

async function installMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_SEND, title: "发给秘书", contexts: ["page", "link", "selection", "image"] });
}

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    try {
      const result = await enqueueDraft(buildContextDraft("page", { pageUrl: tab?.url }, tab), { feedbackTabId: tab?.id });
      const status = await getStatus();
      if (!status.configured) await chrome.runtime.openOptionsPage();
      return result;
    } catch (error) {
      await showError(error);
    }
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_SEND) return;
  void (async () => {
    try {
      const kind = inferContextKind(info);
      const draft = buildContextDraft(kind, info, tab);
      await enqueueDraft(draft, { feedbackTabId: tab?.id });
      const status = await getStatus();
      if (!status.configured) await chrome.runtime.openOptionsPage();
    } catch (error) {
      await showError(error);
    }
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let responsePromise;
  if (message?.type === "get-status") responsePromise = getStatus();
  if (message?.type === "save-config") responsePromise = saveConfig(message);
  if (message?.type === "clear-pairing") responsePromise = clearPairing();
  if (message?.type === "retry-now") responsePromise = processQueue({ force: true });
  if (!responsePromise) return false;
  Promise.resolve(responsePromise).then(
    (value) => sendResponse(value),
    (error) => sendResponse({ __error: clipText(error?.message || error, 300) || "扩展操作失败" }),
  );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void processQueue();
  if (alarm.name === CLEAR_BADGE_ALARM) void getStatus().then((status) => {
    if (status.queued === 0) return updateQueueBadge([], { configured: status.configured });
    return undefined;
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void installMenus();
});
chrome.runtime.onStartup.addListener(() => {
  void installMenus();
  void processQueue();
});

void (async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    ensureLocalIdentity(),
  ]);
  await processQueue();
})();
