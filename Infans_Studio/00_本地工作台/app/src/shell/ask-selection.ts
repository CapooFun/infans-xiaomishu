/** 工作台页内划字提问模板。 */


const TEXT_LIMIT = 1200;

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

export function buildAskSelectionSeedUser({
  selectedText = "",
  pageUrl = "",
  pageTitle = "",
  route = "",
}: {
  selectedText?: string;
  pageUrl?: string;
  pageTitle?: string;
  route?: string;
} = {}) {
  const text = String(selectedText || "").trim().slice(0, TEXT_LIMIT);
  if (!text) return "";
  const path = String(route || workbenchPathFromUrl(pageUrl) || "");
  const quoted = `「${text}」`;
  if (path.startsWith("/markets")) {
    return `刚在世界资讯里选了这段，请直接解释含义、影响与注意点（简洁）：\n${quoted}`;
  }
  if (path.startsWith("/languages")) {
    return `刚在日语学习里选了这段，请做阅读/词汇解析（读音、意思、考点）：\n${quoted}`;
  }
  if (path.startsWith("/health")) {
    return `刚在身心健康页选了这段，请按 NSCA 教练角色解读（客观、给行动，不降标准、有话直说）：\n${quoted}`;
  }
  const title = String(pageTitle || "").trim();
  const url = String(pageUrl || "").trim();
  if (title || url) {
    const where = title || "未命名页面";
    const link = url ? `（${url}）` : "";
    return `刚在网页「${where}」选了这段${link}，请根据上下文说明含义与要点（简洁）：\n${quoted}`;
  }
  return `请根据当前工作台上下文说明这段文字：\n${quoted}`;
}
