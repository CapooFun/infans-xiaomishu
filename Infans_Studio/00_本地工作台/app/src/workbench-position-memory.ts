/**
 * 工作台页面位置记忆：只保存在当前浏览器与当前站点来源的 localStorage。
 * 不保存正文、搜索词或对话；URL 只保留各页面已经登记的稳定状态参数。
 */

import { isWorkbenchNewsHash } from "./world-news-target.ts";

export const WORKBENCH_POSITION_STORAGE_KEY = "infans-workbench-position-v1";
export const WORKBENCH_POSITION_VERSION = 1;
export const WORKBENCH_POSITION_READY_EVENT = "infans:position-ready";
export const TODO_RETURN_CONTEXT_STORAGE_KEY = "infans-todo-return-v1";

const MAX_SAVED_ROUTES = 24;
const MAX_WIKI_SCOPES = 16;
const MAX_EXPANDED_IDS = 80;
const MAX_ID_LENGTH = 160;
const MAX_SCROLL_Y = 10_000_000;
const MAX_STORED_BYTES = 32 * 1024;
const SCROLL_TOLERANCE_PX = 8;

const ROUTE_QUERY_KEYS: Record<string, readonly string[]> = {
  "/projects": ["project", "view", "workline", "tree", "module", "feature", "node", "from"],
  "/schedule": ["todos", "view"],
  "/health": ["band"],
  "/languages": ["section"],
  "/library": ["open", "view", "kind"],
  "/topics": ["tab", "domain", "branch", "node", "card", "open", "course"],
  "/markets": ["topic", "lane"],
  "/markets/assets": ["tab"],
};

const VALID_ROUTES = new Set([
  "/", "/schedule", "/projects", "/health", "/languages", "/library",
  "/topics", "/markets", "/markets/assets", "/tools",
]);

type ScrollEntry = {
  y: number;
  anchorId?: string;
  anchorOffset?: number;
  updatedAt: number;
};

type TodoReturnContext = {
  location: string;
  scroll: ScrollEntry | null;
};

type WikiEntry = {
  expandedModules: string[];
  expandedNodes: string[];
  updatedAt: number;
};

export type WorkbenchPositionStore = {
  version: 1;
  lastLocation: string;
  scroll: Record<string, ScrollEntry>;
  wiki: Record<string, WikiEntry>;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let activeNavigationPending = false;
let restoreLocked = false;
let saveTimer = 0;
let restoreCleanup: (() => void) | null = null;
let lastReadyLocation = "";

type PositionTraceRow = { at: number; event: string; y: number; target?: number };

function tracePosition(event: string, target?: number) {
  if (typeof window === "undefined") return;
  try { performance.mark(`infans-position:${event}`); } catch { /* 旧浏览器不支持时忽略。 */ }
  const rows = window.__infansPositionTrace ??= [];
  rows.push({ at: Math.round(performance.now()), event, y: Math.round(window.scrollY), ...(target == null ? {} : { target: Math.round(target) }) });
  if (rows.length > 40) rows.splice(0, rows.length - 40);
  document.documentElement.dataset.positionTrace = JSON.stringify(rows.slice(-12));
}

function emptyStore(): WorkbenchPositionStore {
  return { version: WORKBENCH_POSITION_VERSION, lastLocation: "/", scroll: {}, wiki: {} };
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next && next.length <= MAX_ID_LENGTH ? next : null;
}

function cleanIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanId).filter((id): id is string => Boolean(id)))].slice(0, MAX_EXPANDED_IDS);
}

function cleanScrollEntry(value: unknown): ScrollEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<ScrollEntry>;
  const y = Number(entry.y);
  if (!Number.isFinite(y)) return null;
  const cleaned: ScrollEntry = {
    y: Math.min(MAX_SCROLL_Y, Math.max(0, Math.round(y))),
    updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0,
  };
  const anchorId = cleanId(entry.anchorId);
  const anchorOffset = Number(entry.anchorOffset);
  if (anchorId) cleaned.anchorId = anchorId;
  if (anchorId && Number.isFinite(anchorOffset)) cleaned.anchorOffset = Math.max(-2000, Math.min(2000, Math.round(anchorOffset)));
  return cleaned;
}

/** 只保留受控路由和明确登记的 URL 状态；hash、搜索词和临时 AI 参数一律不进入记忆。 */
export function sanitizeWorkbenchLocation(input: string, base = "http://127.0.0.1"): string | null {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  const pathname = url.pathname === "/tools" || url.pathname.startsWith("/tools/") ? "/tools" : url.pathname;
  if (!VALID_ROUTES.has(pathname)) return null;
  const next = new URLSearchParams();
  for (const key of ROUTE_QUERY_KEYS[pathname] || []) {
    const value = cleanId(url.searchParams.get(key));
    if (value) next.set(key, value);
  }
  const query = next.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

export function parseWorkbenchPositionStore(raw: string | null): WorkbenchPositionStore {
  if (!raw || raw.length > MAX_STORED_BYTES) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as Partial<WorkbenchPositionStore>;
    if (parsed.version !== WORKBENCH_POSITION_VERSION) return emptyStore();
    const next = emptyStore();
    next.lastLocation = sanitizeWorkbenchLocation(String(parsed.lastLocation || "/")) || "/";
    if (parsed.scroll && typeof parsed.scroll === "object") {
      const rows = Object.entries(parsed.scroll)
        .flatMap(([key, value]) => {
          const location = sanitizeWorkbenchLocation(key);
          const entry = cleanScrollEntry(value);
          return location && entry ? [[location, entry] as const] : [];
        })
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_SAVED_ROUTES);
      next.scroll = Object.fromEntries(rows);
    }
    if (parsed.wiki && typeof parsed.wiki === "object") {
      const rows = Object.entries(parsed.wiki)
        .flatMap(([scope, value]) => {
          const cleanScope = cleanId(scope);
          if (!cleanScope || !value || typeof value !== "object") return [];
          const entry = value as Partial<WikiEntry>;
          return [[cleanScope, {
            expandedModules: cleanIdArray(entry.expandedModules),
            expandedNodes: cleanIdArray(entry.expandedNodes),
            updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0,
          }] as const];
        })
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_WIKI_SCOPES);
      next.wiki = Object.fromEntries(rows);
    }
    return next;
  } catch {
    return emptyStore();
  }
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readStore(storage = browserStorage()): WorkbenchPositionStore {
  if (!storage) return emptyStore();
  try {
    const raw = storage.getItem(WORKBENCH_POSITION_STORAGE_KEY);
    const parsed = parseWorkbenchPositionStore(raw);
    if (raw && parsed.version !== WORKBENCH_POSITION_VERSION) storage.removeItem(WORKBENCH_POSITION_STORAGE_KEY);
    return parsed;
  } catch {
    return emptyStore();
  }
}

function writeStore(store: WorkbenchPositionStore, storage = browserStorage()) {
  if (!storage) return;
  try {
    const raw = JSON.stringify(store);
    if (raw.length <= MAX_STORED_BYTES) storage.setItem(WORKBENCH_POSITION_STORAGE_KEY, raw);
  } catch {
    /* 浏览器禁用存储或空间不足时，安静退化为不记忆。 */
  }
}

export function currentWorkbenchLocation(): string {
  if (typeof window === "undefined") return "/";
  return sanitizeWorkbenchLocation(`${window.location.pathname}${window.location.search}`) || "/";
}

export function readScheduleTodosOpen(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("todos") === "1";
}

export function writeScheduleTodosOpen(open: boolean) {
  if (typeof window === "undefined") return;
  captureCurrentWorkbenchPosition();
  const url = new URL(window.location.href);
  if (open) url.searchParams.set("todos", "1");
  else url.searchParams.delete("todos");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  rememberCurrentWorkbenchLocation();
}

function validTodoReturnLocation(input: string | null | undefined): string | null {
  const location = input ? sanitizeWorkbenchLocation(input) : null;
  return location && location.startsWith("/schedule") ? location : null;
}

function readTodoReturnContext(): TodoReturnContext | null {
  const raw = browserSessionStorage()?.getItem(TODO_RETURN_CONTEXT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TodoReturnContext>;
    const location = validTodoReturnLocation(typeof parsed.location === "string" ? parsed.location : raw);
    if (!location) return null;
    return { location, scroll: parsed.scroll ? cleanScrollEntry(parsed.scroll) : null };
  } catch {
    const location = validTodoReturnLocation(raw);
    return location ? { location, scroll: null } : null;
  }
}

export function rememberTodoReturnLocation(location = currentWorkbenchLocation()) {
  const valid = validTodoReturnLocation(location);
  if (!valid) return;
  captureCurrentWorkbenchPosition();
  const scroll = readStore().scroll[valid] || null;
  browserSessionStorage()?.setItem(TODO_RETURN_CONTEXT_STORAGE_KEY, JSON.stringify({ location: valid, scroll } satisfies TodoReturnContext));
}

export function readTodoReturnLocation(): string | null {
  return readTodoReturnContext()?.location || null;
}

export function readTodoReturnPosition(location = currentWorkbenchLocation()): ScrollEntry | null {
  const context = readTodoReturnContext();
  return context?.location === location ? context.scroll : null;
}

export function clearTodoReturnLocation() {
  browserSessionStorage()?.removeItem(TODO_RETURN_CONTEXT_STORAGE_KEY);
}

export function rememberCurrentWorkbenchLocation() {
  const store = readStore();
  store.lastLocation = currentWorkbenchLocation();
  writeStore(store);
}

/** 只在打开站点根地址时恢复上次页面；明确 URL 始终优先。 */
export function restoreInitialWorkbenchLocation(): string {
  if (typeof window === "undefined") return "/";
  const explicit = sanitizeWorkbenchLocation(`${window.location.pathname}${window.location.search}`) || "/";
  const store = readStore();
  const target = explicit !== "/" || window.location.hash ? explicit : store.lastLocation || "/";
  if (explicit === "/" && !window.location.hash && target !== "/") window.history.replaceState(window.history.state, "", target);
  if (store.scroll[target]) document.documentElement.dataset.positionRestoring = "true";
  return target;
}

export function markActiveWorkbenchNavigation() {
  captureCurrentWorkbenchPosition();
  activeNavigationPending = true;
}

export function consumeActiveWorkbenchNavigation(): boolean {
  const active = activeNavigationPending;
  activeNavigationPending = false;
  return active;
}

function readAnchor(): Pick<ScrollEntry, "anchorId" | "anchorOffset"> {
  if (typeof document === "undefined") return {};
  const anchors = [...document.querySelectorAll<HTMLElement>("[data-position-anchor]")];
  if (!anchors.length) return {};
  const visible = anchors
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom >= 0 && rect.top <= window.innerHeight)
    .sort((a, b) => Math.abs(a.rect.top) - Math.abs(b.rect.top))[0];
  const id = cleanId(visible?.element.dataset.positionAnchor);
  return id ? { anchorId: id, anchorOffset: Math.round(visible.rect.top) } : {};
}

export function captureCurrentWorkbenchPosition() {
  if (typeof window === "undefined" || restoreLocked) return;
  const location = currentWorkbenchLocation();
  const store = readStore();
  store.lastLocation = location;
  store.scroll[location] = {
    y: Math.min(MAX_SCROLL_Y, Math.max(0, Math.round(window.scrollY))),
    ...readAnchor(),
    updatedAt: Date.now(),
  };
  const rows = Object.entries(store.scroll).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_SAVED_ROUTES);
  store.scroll = Object.fromEntries(rows);
  writeStore(store);
}

export function installWorkbenchPositionCapture(): () => void {
  if (typeof window === "undefined") return () => {};
  const saveSoon = () => {
    tracePosition("scroll");
    if (restoreLocked || saveTimer) return;
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      captureCurrentWorkbenchPosition();
    }, 160);
  };
  const saveNow = () => captureCurrentWorkbenchPosition();
  window.addEventListener("scroll", saveSoon, { passive: true });
  window.addEventListener("pagehide", saveNow);
  document.addEventListener("visibilitychange", saveNow);
  return () => {
    window.removeEventListener("scroll", saveSoon);
    window.removeEventListener("pagehide", saveNow);
    document.removeEventListener("visibilitychange", saveNow);
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = 0;
  };
}

export function clampScrollY(value: number, scrollHeight: number, viewportHeight: number): number {
  const max = Math.max(0, Math.round(scrollHeight) - Math.max(0, Math.round(viewportHeight)));
  return Math.min(max, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}

export function needsScrollCorrection(current: number, target: number, tolerance = SCROLL_TOLERANCE_PX) {
  return Math.abs(current - target) > Math.max(0, tolerance);
}

function targetForEntry(entry: ScrollEntry): number {
  if (entry.anchorId) {
    const target = [...document.querySelectorAll<HTMLElement>("[data-position-anchor]")]
      .find((element) => element.dataset.positionAnchor === entry.anchorId);
    if (target) return window.scrollY + target.getBoundingClientRect().top - (entry.anchorOffset || 0);
  }
  return entry.y;
}

/**
 * 每个导航纪元最多一次主恢复和一次有界校正。没有 ResizeObserver 或 visualViewport 监听，
 * 恢复期间暂停写回，结束后销毁全部计时器，避免 scroll → 写回 → 恢复的反馈环。
 */
export function restoreWorkbenchScroll(options: { activeNavigation: boolean; waitForReady?: boolean } = { activeNavigation: false }): () => void {
  if (typeof window === "undefined") return () => {};
  restoreCleanup?.();
  restoreCleanup = null;
  const location = currentWorkbenchLocation();
  rememberCurrentWorkbenchLocation();
  const returnPosition = readTodoReturnPosition(location);
  const entry = returnPosition || readStore().scroll[location];
  let cancelled = false;
  let correctionTimer = 0;
  let readyTimer = 0;
  let removeReady = () => {};
  restoreLocked = true;
  tracePosition("restore-lock");
  document.documentElement.dataset.positionRestoring = "true";

  const finish = () => {
    if (cancelled) return;
    restoreLocked = false;
    tracePosition("restore-finish");
    delete document.documentElement.dataset.positionRestoring;
    removeReady();
    if (readyTimer) window.clearTimeout(readyTimer);
    if (correctionTimer) window.clearTimeout(correctionTimer);
    restoreCleanup = null;
  };

  const apply = () => {
    if (cancelled) return;
    if (isWorkbenchNewsHash(window.location.hash)) {
      finish();
      return;
    }
    if (options.activeNavigation || !entry) {
      if (needsScrollCorrection(window.scrollY, 0)) {
        tracePosition("restore-main", 0);
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      }
      finish();
      return;
    }
    const target = clampScrollY(targetForEntry(entry), document.documentElement.scrollHeight, window.innerHeight);
    if (needsScrollCorrection(window.scrollY, target)) {
      tracePosition("restore-main", target);
      window.scrollTo({ top: target, left: 0, behavior: "auto" });
    }
    correctionTimer = window.setTimeout(() => {
      if (cancelled) return;
      const corrected = clampScrollY(targetForEntry(entry), document.documentElement.scrollHeight, window.innerHeight);
      if (needsScrollCorrection(window.scrollY, corrected, 12)) {
        tracePosition("restore-correction", corrected);
        window.scrollTo({ top: corrected, left: 0, behavior: "auto" });
      }
      finish();
    }, 140);
  };

  const afterLayout = () => window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
  if (options.waitForReady) {
    const ready = () => afterLayout();
    if (lastReadyLocation === location) afterLayout();
    else {
      window.addEventListener(WORKBENCH_POSITION_READY_EVENT, ready, { once: true });
      removeReady = () => window.removeEventListener(WORKBENCH_POSITION_READY_EVENT, ready);
      readyTimer = window.setTimeout(afterLayout, 900);
    }
  } else afterLayout();

  const cleanup = () => {
    cancelled = true;
    restoreLocked = false;
    delete document.documentElement.dataset.positionRestoring;
    removeReady();
    if (readyTimer) window.clearTimeout(readyTimer);
    if (correctionTimer) window.clearTimeout(correctionTimer);
    if (restoreCleanup === cleanup) restoreCleanup = null;
  };
  restoreCleanup = cleanup;
  return cleanup;
}

export function notifyWorkbenchPositionReady() {
  if (typeof window !== "undefined") {
    lastReadyLocation = currentWorkbenchLocation();
    window.dispatchEvent(new CustomEvent(WORKBENCH_POSITION_READY_EVENT));
  }
}

export function readProjectWikiMemory(scope: string, validModuleIds: Iterable<string>, validNodeIds: Iterable<string>) {
  const entry = readStore().wiki[scope];
  const modules = new Set(validModuleIds);
  const nodes = new Set(validNodeIds);
  return {
    exists: Boolean(entry),
    expandedModules: (entry?.expandedModules || []).filter((id) => modules.has(id)),
    expandedNodes: (entry?.expandedNodes || []).filter((id) => nodes.has(id)),
  };
}

export function writeProjectWikiMemory(scope: string, expandedModules: Iterable<string>, expandedNodes: Iterable<string>) {
  const cleanScope = cleanId(scope);
  if (!cleanScope) return;
  const store = readStore();
  store.wiki[cleanScope] = {
    expandedModules: cleanIdArray([...expandedModules]),
    expandedNodes: cleanIdArray([...expandedNodes]),
    updatedAt: Date.now(),
  };
  const rows = Object.entries(store.wiki).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_WIKI_SCOPES);
  store.wiki = Object.fromEntries(rows);
  writeStore(store);
}

export function readProjectWorkbenchQuery() {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return {
    project: cleanId(params.get("project")),
    view: cleanId(params.get("view")),
    from: cleanId(params.get("from")),
    workline: cleanId(params.get("workline")),
    tree: cleanId(params.get("tree")),
    module: cleanId(params.get("module")),
    feature: cleanId(params.get("feature")),
    node: cleanId(params.get("node")),
  };
}

export function writeProjectWorkbenchQuery(values: { view?: "home" | "wiki" | "governance" | null; workline?: string | null; tree?: string | null; module?: string | null; feature?: string | null; node?: string | null }) {
  if (typeof window === "undefined") return;
  captureCurrentWorkbenchPosition();
  const url = new URL(window.location.href);
  for (const key of ["view", "workline", "tree", "module", "feature", "node"] as const) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const value = cleanId(values[key]);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  rememberCurrentWorkbenchLocation();
}

export function projectWikiScope(projectId: string, treeId?: string | null) {
  return `${projectId}:${treeId || "default"}`.slice(0, MAX_ID_LENGTH);
}

/** 优先使用数据源稳定 ID；旧树缺 ID 时用文本路径哈希，数据变化后自然失效并安全降级。 */
export function projectFeaturePointMemoryId(featureId: string, pointId: string | null | undefined, textPath: string[]) {
  if (pointId) return `node:${pointId}`.slice(0, MAX_ID_LENGTH);
  let hash = 2166136261;
  const source = `${featureId}\u0000${textPath.join("\u0000")}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy:${featureId}:${(hash >>> 0).toString(36)}`.slice(0, MAX_ID_LENGTH);
}

declare global {
  interface Window { __infansPositionTrace?: PositionTraceRow[]; }
}
