import crypto from "node:crypto";
import { ASK_SELECTION_TEXT_LIMIT } from "./workbench-ai.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";

const PENDING_TTL_MS = 60_000;
let pending = null;

function workbenchPathFromUrl(pageUrl = "") {
  try {
    const url = new URL(String(pageUrl || ""));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return url.pathname || "/";
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** 按来源页组装自动提问文案（金融 / 日语 / 外站通用）。 */
export function buildAskSelectionSeedUser({
  selectedText = "",
  pageUrl = "",
  pageTitle = "",
  route = "",
} = {}) {
  const text = String(selectedText || "").trim().slice(0, ASK_SELECTION_TEXT_LIMIT);
  if (!text) return "";
  const path = String(route || workbenchPathFromUrl(pageUrl) || "");
  const quoted = `「${text}」`;
  if (path.startsWith("/markets")) {
    return `哥哥刚在世界资讯里选了这段，请直接解释含义、影响与注意点（简洁）：\n${quoted}`;
  }
  if (path.startsWith("/languages")) {
    return `哥哥刚在日语学习里选了这段，请做阅读/词汇解析（读音、意思、考点）：\n${quoted}`;
  }
  const title = String(pageTitle || "").trim();
  const url = String(pageUrl || "").trim();
  if (title || url) {
    const where = title || "未命名页面";
    const link = url ? `（${url}）` : "";
    return `哥哥刚在网页「${where}」选了这段${link}，请根据上下文说明含义与要点（简洁）：\n${quoted}`;
  }
  return `请根据当前工作台上下文说明这段文字：\n${quoted}`;
}

export function normalizeAskSelectionPayload(body = {}) {
  const selectedText = String(body.selectedText ?? body.text ?? "").trim().slice(0, ASK_SELECTION_TEXT_LIMIT);
  if (!selectedText) throw new WorkbenchWriteError("选区不能为空", 400, "SELECTION_EMPTY");
  const pageUrl = String(body.pageUrl ?? body.url ?? "").trim().slice(0, 2000);
  const pageTitle = String(body.pageTitle ?? body.title ?? "").trim().slice(0, 300);
  const route = String(body.route ?? "").trim().slice(0, 200);
  const seedUser = buildAskSelectionSeedUser({ selectedText, pageUrl, pageTitle, route });
  if (!seedUser) throw new WorkbenchWriteError("选区不能为空", 400, "SELECTION_EMPTY");
  return { selectedText, pageUrl, pageTitle, route, seedUser };
}

export function enqueueAskSelection(body = {}) {
  const normalized = normalizeAskSelectionPayload(body);
  pending = {
    id: crypto.randomUUID(),
    at: Date.now(),
    ...normalized,
  };
  return { id: pending.id, at: pending.at, seedUser: pending.seedUser };
}

function freshPending() {
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  return pending;
}

/** 取出并清空 pending（前端消费一次）。 */
export function takePendingAskSelection() {
  const current = freshPending();
  pending = null;
  return current
    ? {
        id: current.id,
        at: current.at,
        selectedText: current.selectedText,
        pageUrl: current.pageUrl,
        pageTitle: current.pageTitle,
        route: current.route,
        seedUser: current.seedUser,
      }
    : null;
}

/** 测试用：清空内存队列。 */
export function clearPendingAskSelection() {
  pending = null;
}
