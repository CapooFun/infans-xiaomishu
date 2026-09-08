export const FRONTEND_HANDOFF_MARKER = "__infans_frontend";
export const FRONTEND_HANDOFF_FEEDBACK_KEY = "infans-frontend-handoff-feedback-v1";
export const FRONTEND_BUILD_META_NAME = "infans-frontend-build";

type LocationLike = Pick<Location, "origin" | "pathname" | "search" | "hash">;
type HistoryLike = Pick<History, "state" | "replaceState">;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type DocumentLike = Pick<Document, "querySelector">;

export function loadedFrontendBuildId(document: DocumentLike): string | null {
  const value = document.querySelector(`meta[name="${FRONTEND_BUILD_META_NAME}"]`)?.getAttribute("content")?.trim() ?? "";
  return /^[a-zA-Z0-9_-]{1,80}$/u.test(value) ? value : null;
}

export function frontendBuildNeedsHandoff(input: { rebuilt: boolean; serverBuildId: string | null; loadedBuildId: string | null }): boolean {
  if (input.rebuilt) return true;
  return Boolean(input.serverBuildId && input.serverBuildId !== input.loadedBuildId);
}

function cleanNonce(value: string | number): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || Date.now().toString(36);
}

/** 先跳到独立的交接地址，避免 iOS WebKit 把同一 URL 的 reload 恢复成旧页面快照。 */
export function frontendHandoffUrl(location: LocationLike, nonce: string | number = Date.now()): string {
  const target = `${location.pathname}${location.search}${location.hash}`;
  const handoff = new URL("/__frontend-handoff", location.origin);
  handoff.searchParams.set("to", target);
  handoff.searchParams.set("v", cleanNonce(nonce));
  return `${handoff.pathname}${handoff.search}`;
}

/** 新页面已挂载后清掉临时版本参数，不污染页面地址与位置记忆。 */
export function clearFrontendHandoffMarker(location: LocationLike, history: HistoryLike): boolean {
  const query = new URLSearchParams(location.search);
  if (!query.has(FRONTEND_HANDOFF_MARKER)) return false;
  query.delete(FRONTEND_HANDOFF_MARKER);
  const search = query.toString();
  history.replaceState(history.state, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
  return true;
}

export function markFrontendHandoffFeedback(storage: StorageLike, now = Date.now()) {
  try { storage.setItem(FRONTEND_HANDOFF_FEEDBACK_KEY, String(now)); }
  catch { /* Safari 存储受限时只少一次提示，不阻断切换。 */ }
}

export function consumeFrontendHandoffFeedback(storage: StorageLike, now = Date.now(), maxAgeMs = 120_000): boolean {
  try {
    const raw = storage.getItem(FRONTEND_HANDOFF_FEEDBACK_KEY);
    storage.removeItem(FRONTEND_HANDOFF_FEEDBACK_KEY);
    const markedAt = Number(raw);
    return Number.isFinite(markedAt) && markedAt > 0 && now >= markedAt && now - markedAt <= maxAgeMs;
  } catch {
    return false;
  }
}
