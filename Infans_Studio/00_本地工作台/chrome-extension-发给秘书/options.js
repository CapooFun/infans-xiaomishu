import { workbenchEndpoints } from "./core.mjs";

const elements = {
  version: document.querySelector("#extension-version"),
  token: document.querySelector("#token"),
  deviceName: document.querySelector("#device-name"),
  workbenchPort: document.querySelector("#workbench-port"),
  pairState: document.querySelector("#pair-state"),
  save: document.querySelector("#save"),
  clear: document.querySelector("#clear"),
  retry: document.querySelector("#retry"),
  message: document.querySelector("#form-message"),
  queued: document.querySelector("#queued"),
  sending: document.querySelector("#sending"),
  failed: document.querySelector("#failed"),
  lastError: document.querySelector("#last-error"),
  lastDelivered: document.querySelector("#last-delivered"),
  connectionState: document.querySelector("#connection-state"),
  checkConnection: document.querySelector("#check-connection"),
};

elements.version.textContent = chrome.runtime.getManifest().version;

async function rpc(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.__error) throw new Error(response.__error);
  return response;
}

async function loopbackPermissionState() {
  try {
    const status = await navigator.permissions.query({ name: "loopback-network" });
    return status.state;
  } catch {
    return "unknown";
  }
}

async function checkLocalConnection({ retryQueue = false } = {}) {
  elements.checkConnection.disabled = true;
  elements.connectionState.dataset.ready = "pending";
  elements.connectionState.textContent = "正在请求 Chrome 连接这台 Mac…";
  try {
    const response = await fetch(workbenchEndpoints(elements.workbenchPort?.value).health, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) throw new Error(`小秘书健康检查返回 HTTP ${response.status}`);
    elements.connectionState.dataset.ready = "true";
    elements.connectionState.textContent = `本机通道已允许，小秘书 ${body.version ? `v${body.version} ` : ""}在线。`;
    if (retryQueue) render(await rpc({ type: "retry-now" }));
    return true;
  } catch (error) {
    const permissionState = await loopbackPermissionState();
    elements.connectionState.dataset.ready = "false";
    elements.connectionState.textContent = permissionState === "denied"
      ? "Chrome 已拒绝本地网络访问；请在地址栏旁的权限设置中改为允许，再重新检查。"
      : "本机通道尚未连通；请在 Chrome 弹出的“本地网络访问”提示中选允许，再重新检查。";
    throw error;
  } finally {
    elements.checkConnection.disabled = false;
  }
}

function pastedTokenValue(value) {
  const raw = String(value || "").trim();
  const prefix = "INFANS_CODEX_COMMAND_TOKEN=";
  return raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
}

function formatTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false });
}

function render(status) {
  elements.pairState.textContent = status.configured ? "已本机配对" : "等待配对";
  elements.pairState.dataset.ready = status.configured ? "true" : "false";
  elements.deviceName.value = status.deviceName || "Mac Chrome";
  if (elements.workbenchPort) elements.workbenchPort.value = String(status.port || 5173);
  elements.queued.textContent = String(status.queued || 0);
  elements.sending.textContent = String(status.sending || 0);
  elements.failed.textContent = String(status.failedRetryPending || 0);
  elements.lastError.textContent = status.lastError ? `最近失败：${status.lastError}` : "当前没有失败记录。";
  const delivered = status.lastDelivered?.receipt;
  elements.lastDelivered.textContent = delivered?.deliveryBoundary === "mac_persisted"
    ? `最近已送达：${status.lastDelivered.title}（${formatTime(delivered.deliveredAt)}）`
    : "尚无 Mac 持久化回执。";
}

async function refresh() {
  render(await rpc({ type: "get-status" }));
}

elements.save.addEventListener("click", async () => {
  elements.save.disabled = true;
  elements.message.textContent = "正在保存…";
  let configSaved = false;
  try {
    await rpc({
      type: "save-config",
      token: pastedTokenValue(elements.token.value),
      deviceName: elements.deviceName.value.trim(),
      port: elements.workbenchPort?.value,
    });
    configSaved = true;
    elements.token.value = "";
    await checkLocalConnection({ retryQueue: true });
    elements.message.textContent = "已保存在当前 Chrome 本地，本机通道已放行并开始补送队列。";
    await refresh();
  } catch (error) {
    elements.message.textContent = configSaved && elements.connectionState.dataset.ready === "false"
      ? "令牌已保留；先允许 Chrome 访问本地网络，队列会继续保留。"
      : error?.message || "保存失败。";
  } finally {
    elements.save.disabled = false;
  }
});

elements.clear.addEventListener("click", async () => {
  await rpc({ type: "clear-pairing" });
  elements.token.value = "";
  elements.message.textContent = "已取消配对；待送达来件仍保留在本地队列。";
  await refresh();
});

elements.retry.addEventListener("click", async () => {
  elements.retry.disabled = true;
  try {
    await checkLocalConnection({ retryQueue: true });
  } catch {
    elements.message.textContent = "本机通道未连通，尚未把队列标记为送达。";
  } finally {
    elements.retry.disabled = false;
  }
});

elements.checkConnection.addEventListener("click", async () => {
  elements.message.textContent = "";
  try {
    await checkLocalConnection({ retryQueue: true });
    elements.message.textContent = "本机通道正常，待送达队列已立即重试。";
  } catch {
    elements.message.textContent = "仍未连通；队列没有丢失。";
  }
});

await refresh();
try {
  await checkLocalConnection({ retryQueue: true });
} catch {
  // 页面中的本机通道状态已经给出可操作原因。
}
