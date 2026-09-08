const MENU_ID = "ask-secretary";
const WORKBENCH_ORIGIN = "http://127.0.0.1:5173";
const TEXT_LIMIT = 1200;

function ensureMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "问问小秘书",
      contexts: ["selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(ensureMenu);
chrome.runtime.onStartup.addListener(ensureMenu);
ensureMenu();

function clipText(value) {
  return String(value || "").trim().slice(0, TEXT_LIMIT);
}

function hashFallbackUrl(payload) {
  const hash = `#askSecretary=${encodeURIComponent(JSON.stringify(payload))}`;
  return `${WORKBENCH_ORIGIN}/?askSecretary=1${hash}`;
}

async function postSelection(payload) {
  const response = await fetch(`${WORKBENCH_ORIGIN}/api/ai/ask-selection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function focusWorkbench(navigateUrl) {
  const tabs = await chrome.tabs.query({
    url: ["http://127.0.0.1:5173/*", "http://localhost:5173/*"],
  });
  const tab = tabs.find((item) => item.id != null) || null;
  if (tab?.id != null) {
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    }
    await chrome.tabs.update(tab.id, { active: true });
    // 仅在需要深链兜底时改 URL；成功 POST 后靠前端轮询消费 pending，避免整页刷新。
    if (navigateUrl) await chrome.tabs.update(tab.id, { url: navigateUrl });
    return;
  }
  await chrome.tabs.create({
    url: navigateUrl || `${WORKBENCH_ORIGIN}/?askSecretary=1`,
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const selectedText = clipText(info.selectionText);
  if (!selectedText) return;

  const payload = {
    selectedText,
    pageUrl: String(info.pageUrl || tab?.url || "").slice(0, 2000),
    pageTitle: String(tab?.title || "").slice(0, 300),
  };

  try {
    await postSelection(payload);
    await focusWorkbench();
  } catch {
    await focusWorkbench(hashFallbackUrl(payload));
  }
});
