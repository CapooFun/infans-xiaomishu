/** 世界资讯新闻锚点：只在当前可见页滚动，避免 KeepAlive 隐藏页把第一次点击吃掉。 */

export function isWorkbenchNewsHash(hash = ""): boolean {
  const value = decodeURIComponent(String(hash).replace(/^#/, ""));
  return value === "market-events" || value.startsWith("world-event-");
}

export type NewsTargetNode = {
  querySelector: (selector: string) => NewsTargetNode | null;
  scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
};

export type NewsTargetRoot = {
  querySelector: (selector: string) => NewsTargetNode | null;
};

function escapeSelectorId(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export function queryVisibleWorkbenchNewsTarget(root: NewsTargetRoot, hash: string): NewsTargetNode | null {
  if (!isWorkbenchNewsHash(hash)) return null;
  const value = decodeURIComponent(String(hash).replace(/^#/, ""));
  const activePage = root.querySelector(".page.is-active");
  if (!activePage) return null;
  return activePage.querySelector(`#${escapeSelectorId(value)}`)
    || (value === "market-events" ? null : activePage.querySelector("#market-events"));
}

export function revealWorldNewsTarget(root: NewsTargetRoot = typeof document === "undefined" ? { querySelector: () => null } : document): boolean {
  if (typeof window === "undefined") return false;
  const node = queryVisibleWorkbenchNewsTarget(root, window.location.hash);
  if (!node || typeof node.scrollIntoView !== "function") return false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  node.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  return true;
}
