import { Fragment, lazy, Suspense, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { InteractionFeedback } from "./components/InteractionFeedback";
import { showInteractionCue, transitionAppearance } from "./interaction-motion";
import { SceneAtmosphere } from "./visual-effects/SceneAtmosphere";
import { LuminousInteractions } from "./visual-effects/LuminousInteractions";
import { WorkbenchPreferencesProvider, useWorkbenchPreferences, ReadingSizeControl, typographyTokens } from "./workbench-preferences";
import { DEFAULT_SCENE_ADJUSTMENTS } from "./workbench-appearance.mjs";
import { backgroundPosition } from "./workbench-preferences-model.mjs";
import { ACTIVE_SECRETARY_CHANGE_EVENT } from "./secretary-identity.mjs";
import { formatShortcutBinding } from "./workbench-shortcut-bindings.mjs";
import { PageNavigation, PageNavigationScope } from "./shell/PageNavigation";
import { AnimatePresence, MotionConfig, Reorder, motion, useDragControls } from "motion/react";
import {
  AlertTriangle, BookMarked, BriefcaseBusiness, CalendarDays, CheckCircle2, CloudSun,
  GripVertical, HeartPulse, Home, Languages, LibraryBig, LockKeyhole, Monitor, Moon, MoreHorizontal, Music2, Newspaper, Pause, Plus, RefreshCw, Smartphone, Sparkles, Sun, UserRound, Wrench, X,
  type LucideIcon,
} from "lucide-react";
import type { HealthSectionData, HomePins, LanguagesSectionData, LibrarySectionData, MarketsSectionData, WeatherAlert, WeatherSnapshot, WorkbenchSummary, WriteAction, WritePreview } from "./types";
import { invalidateSection, preloadSection, refreshSection, useSectionData } from "./workbench-data-cache";
import { invalidateAllToolSessionCaches } from "./tool-session-cache";
import { jsonFetch, navigate, navigateWithPositionRestore, shouldSoftNavigate, softNavigate } from "./page-shared";
import { homeCalendarWindow } from "./calendar-windows";
import { useCalendarWindows } from "./use-calendar-windows";
import { shouldShowLocalWeatherAlert } from "./weather-alert-state";
import { isWorkbenchNewsHash } from "./world-news-target";
import { directWriteSuccessMessage, skipsWorkbenchWriteConfirmation } from "./write-confirmation-policy";
import { DISPLAY_MODE_STORAGE_KEY, readDisplayMode, writeDisplayMode } from "./display-mode";
import { isIPhoneClient, readPhoneMacView, reloadAfterPhoneMacViewChange, writePhoneMacView } from "./phone-mac-view";
import { getMusicPlayerSnapshot, subscribeMusicPlayer, toggleMusicPlayback } from "./secretary-music-player";
import { SECRETARY_PRODUCT_BRAND, readActiveSecretaryId, secretaryProfileById, secretaryRefreshPortraitSrc, writeActiveSecretaryId } from "./secretary-identity.mjs";
import { shouldCloseMoreSheetAfterRefresh, workbenchRefreshFeedbackText, WORKBENCH_REFRESH_FEEDBACK_SUFFIX } from "./workbench-brand-refresh";
import { clearFrontendHandoffMarker, consumeFrontendHandoffFeedback, frontendBuildNeedsHandoff, frontendHandoffUrl, loadedFrontendBuildId, markFrontendHandoffFeedback } from "./workbench-frontend-handoff";
import { createSidebarVisibilityGate } from "./sidebar-pet-drag";
import { latestDueCompanionPresence, postCompanionPresenceToNative, type CompanionPresenceInteraction } from "./companion-presence";
import {
  MAX_SIDEBAR_BOOKMARKS,
  defaultSidebarBookmarkLabel,
  isSidebarBookmarkNavigableInDisplayMode,
  isSidebarBookmarkableLocation,
  normalizeSidebarBookmarkLocation,
  sidebarBookmarkRoutePath,
  type SidebarBookmark,
  type SidebarBookmarkSnapshot,
} from "./sidebar-bookmarks.mjs";
import HomePage from "./pages/HomePage";
import { AiPanel, IdentityOverlay, PreviewModal, type AiPanelBootstrap, type PreviewState } from "./shell/WorkbenchOverlays";
import { ProfileSwitcher } from "./shell/ProfileSwitcher";
import { SelectionAskFab } from "./shell/SelectionAskFab";
import { SelectionAskMenu } from "./shell/SelectionAskMenu";
import { applyWorkbenchTheme, getPageScene, PAGE_SCENES_BY_THEME, readInitialTheme, WORKBENCH_THEMES, type WorkbenchTheme, type WorkbenchThemeIcon } from "./workbench-theme";
import {
  consumeActiveWorkbenchNavigation,
  captureCurrentWorkbenchPosition,
  installWorkbenchPositionCapture,
  notifyWorkbenchPositionReady,
  rememberCurrentWorkbenchLocation,
  restoreInitialWorkbenchLocation,
  restoreWorkbenchScroll,
} from "./workbench-position-memory.ts";
import {
  WORKBENCH_SHORTCUT_EVENT,
  mergeSidebarBookmarkOrder,
  shouldIgnoreWorkbenchShortcutTarget,
  workbenchShortcutFromCustomEvent,
  workbenchShortcutFromKeyboardEvent,
  type WorkbenchShortcutCommand,
} from "./workbench-shortcuts";
import "./styles.css";
import "./theme.css";
import "./workbench-personalization.css";
import "./workbench-refinements.css";

clearFrontendHandoffMarker(window.location, window.history);
restoreInitialWorkbenchLocation();
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

// 趋势图与肌群图已随健康页静态导入，预取这一个入口即可覆盖整页首屏。
const loadSchedulePage = () => import("./pages/SchedulePage");
const loadProjectsPage = () => import("./pages/ProjectsPage");
const loadHealthPage = () => import("./pages/HealthPage");
const loadLanguagesPage = () => import("./pages/LanguagesPage");
const loadLibraryPage = () => import("./pages/LibraryPage");
const loadTopicsPage = () => import("./pages/TopicsPage");
const loadMarketsPage = () => import("./pages/MarketsPage");
const loadAssetsPage = () => import("./pages/AssetsPage");
const loadToolsPage = () => import("./pages/ToolsPage");
const LazySchedulePage = lazy(loadSchedulePage);
const LazyProjectsPage = lazy(loadProjectsPage);
const LazyHealthPage = lazy(loadHealthPage);
const LazyLanguagesPage = lazy(loadLanguagesPage);
const LazyLibraryPage = lazy(loadLibraryPage);
const LazyTopicsPage = lazy(loadTopicsPage);
const LazyMarketsPage = lazy(loadMarketsPage);
const LazyAssetsPage = lazy(loadAssetsPage);
const LazyToolsPage = lazy(loadToolsPage);
const SIDEBAR_BOOKMARK_COLLAPSED_COUNT = 4;

type SidebarBookmarkItemProps = {
  active: boolean;
  bookmark: SidebarBookmark;
  disabled: boolean;
  navigationDisabled: boolean;
  slotNumber: number;
  theme: WorkbenchTheme;
  variant: "desktop" | "mobile";
  onDragEnd: () => void;
  onDragStart: () => void;
  onMove: (delta: -1 | 1) => void;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>, location: string) => void;
  onRemove: (location: string) => void;
};

function SidebarBookmarkItem({ active, bookmark, disabled, navigationDisabled, slotNumber, theme, variant, onDragEnd, onDragStart, onMove, onOpen, onRemove }: SidebarBookmarkItemProps) {
  const dragControls = useDragControls();
  const bindings = useWorkbenchPreferences().device.shortcuts;
  const shortcut = formatShortcutBinding(bindings[`bookmark-${slotNumber}` as keyof typeof bindings] || null);
  const targetRoute = sidebarBookmarkRoutePath(bookmark.location);
  const rowClass = variant === "desktop" ? "sidebar-bookmark-row" : "more-sheet-bookmark-row";
  return <Reorder.Item
    as="div"
    className={`${rowClass}${navigationDisabled ? " is-navigation-disabled" : ""}`}
    value={bookmark}
    drag={disabled ? false : "y"}
    dragControls={dragControls}
    dragListener={false}
    onDragStart={onDragStart}
    onDragEnd={onDragEnd}
    whileDrag={{ zIndex: 8, scale: 1.015 }}
  >
    <button
      type="button"
      className="sidebar-bookmark-drag"
      aria-label={`拖动调整书签 ${bookmark.label} 的顺序`}
      title="拖动排序；也可用上下方向键"
      disabled={disabled}
      onPointerDown={(event) => { if (!disabled) dragControls.start(event); }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        onMove(event.key === "ArrowUp" ? -1 : 1);
      }}
    ><GripVertical size={14}/></button>
    <a
      className={active ? "active" : ""}
      href={bookmark.location}
      aria-disabled={navigationDisabled || undefined}
      title={navigationDisabled ? "展示模式下暂不可进入" : undefined}
      onPointerEnter={() => { if (!navigationDisabled) void preloadRoute(targetRoute, theme); }}
      onFocus={() => { if (!navigationDisabled) void preloadRoute(targetRoute, theme); }}
      onClick={(event) => onOpen(event, bookmark.location)}
    ><BookMarked size={variant === "desktop" ? 16 : 15}/><span>{bookmark.label}</span></a>
    {variant === "desktop" && shortcut ? <kbd className="sidebar-bookmark-shortcut" aria-label={`快捷键 ${shortcut}`}>{shortcut}</kbd> : null}
    <button type="button" className="sidebar-bookmark-remove" aria-label={`移除书签 ${bookmark.label}`} disabled={disabled} onClick={() => onRemove(bookmark.location)}><X size={variant === "desktop" ? 13 : 12}/></button>
  </Reorder.Item>;
}

const NAV_ITEMS: Array<{ path: string; label: string; icon: LucideIcon; index: string }> = [
  { path: "/", label: "首页", icon: Home, index: "01" },
  { path: "/schedule", label: "日程安排", icon: CalendarDays, index: "02" },
  { path: "/projects", label: "事业顺利", icon: BriefcaseBusiness, index: "03" },
  { path: "/health", label: "身心健康", icon: HeartPulse, index: "04" },
  { path: "/markets", label: "世界资讯", icon: Newspaper, index: "05" },
  { path: "/languages", label: "语言学习", icon: Languages, index: "06" },
  { path: "/topics", label: "专题研究", icon: BookMarked, index: "07" },
  { path: "/library", label: "艺术馆藏", icon: LibraryBig, index: "08" },
  { path: "/markets/assets", label: "资产管理", icon: LockKeyhole, index: "09" },
  { path: "/tools", label: "实用工具", icon: Wrench, index: "10" },
];

/** 窄屏底栏保留六个高频入口；手机隐藏文字后仍维持可靠触控宽度。 */
const PRIMARY_NAV_PATHS = new Set(["/", "/schedule", "/projects", "/health", "/markets", "/languages"]);
const PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => PRIMARY_NAV_PATHS.has(item.path));

const PAGE_META: Record<string, { title: string }> = {
  "/": { title: "小秘书" },
  "/schedule": { title: "日程安排" },
  "/projects": { title: "事业顺利" },
  "/health": { title: "身心健康" },
  "/languages": { title: "日语突破" },
  "/topics": { title: "专题研究" },
  "/library": { title: "艺术馆藏" },
  "/markets": { title: "世界资讯" },
  "/markets/assets": { title: "资产管理" },
  "/tools": { title: "实用工具" },
};

function pageAnnotation(path: string) {
  if (path === "/markets/assets") return "（虚构演示：净资产约一千万，不是真实账户）";
  if (path === "/schedule") return "（虚构演示：示例待办，不是作者当天真事）";
  if (path === "/health") return "（虚构演示：体魄示意，不是真实健康记录）";
  return undefined;
}

function routePath() {
  const path = window.location.pathname;
  if (path === "/tools" || path.startsWith("/tools/")) return "/tools";
  return path in PAGE_META ? path : "/";
}

const ROUTE_LOADERS: Partial<Record<string, () => Promise<unknown>>> = {
  "/schedule": loadSchedulePage,
  "/projects": loadProjectsPage,
  "/health": loadHealthPage,
  "/languages": loadLanguagesPage,
  "/library": loadLibraryPage,
  "/topics": loadTopicsPage,
  "/markets": loadMarketsPage,
  "/markets/assets": loadAssetsPage,
  "/tools": loadToolsPage,
};
const ROUTE_SECTIONS = { "/health": "health", "/languages": "languages", "/library": "library", "/topics": "library", "/markets": "markets" } as const;
// iPad Safari 的内存上限较紧；首页外只保留当前一页，避免健康图表等重页面叠加常驻。
const ROUTE_CACHE_LIMIT = 2;
const WORKBENCH_REFRESH_TIMEOUT_MS = 12_000;
const prefetchedScenes = new Map<string, { image: HTMLImageElement; ready: Promise<void> }>();

async function waitForWorkbenchRefresh(tasks: Array<Promise<unknown>>) {
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("刷新超时")), WORKBENCH_REFRESH_TIMEOUT_MS);
  });
  try {
    await Promise.race([Promise.all(tasks), timeout]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function requestFrontendDeepRefresh() {
  try {
    // 明确的 POST 避免 iPad / iPhone WebKit 把页面 HEAD 探测留在本地缓存。
    const response = await fetch("/api/frontend-refresh", {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = await response.json() as { rebuilt?: boolean; buildId?: string | null };
    return {
      rebuilt: payload.rebuilt === true,
      buildId: typeof payload.buildId === "string" ? payload.buildId : null,
    };
  } catch {
    return null;
  }
}

const THEME_ICONS = { moon: Moon, sun: Sun } as const;

function ThemeGlyph({ icon, size = 14 }: { icon: WorkbenchThemeIcon; size?: number }) {
  const Icon = THEME_ICONS[icon];
  return <Icon size={size} aria-hidden="true"/>;
}

function ThemeSwitch({
  theme,
  switching,
  refreshing,
  onThemeChange,
  onReload,
  className = "",
}: {
  theme: WorkbenchTheme;
  switching: boolean;
  refreshing: boolean;
  onThemeChange: (next: WorkbenchTheme) => void;
  onReload: () => void;
  className?: string;
}) {
  return (
    <div className={`theme-switch${className ? ` ${className}` : ""}`} role="group" aria-label="工作台主题与刷新">
      {WORKBENCH_THEMES.map((item, index) => <Fragment key={item.id}>
        {index === 1 ? (
          <button
            type="button"
            className="theme-reload-ring"
            onClick={onReload}
            disabled={switching || refreshing}
            aria-busy={refreshing || undefined}
            aria-label="刷新工作台"
            title="刷新工作台"
          ><RefreshCw className={refreshing ? "is-spinning" : undefined} size={13} aria-hidden="true"/></button>
        ) : null}
        <button type="button" className={`theme-choice${theme === item.id ? " active" : ""}`} onClick={() => onThemeChange(item.id)} disabled={switching} aria-pressed={theme === item.id} title={item.fullName}><ThemeGlyph icon={item.icon}/><em>{item.name}</em></button>
      </Fragment>)}
    </div>
  );
}

/** 保活 LRU：始终尽量保留首页，其余按最近使用，总数由 iPad 内存安全上限控制。 */
function touchVisitedRoute(prev: string[], path: string): string[] {
  const ordered = [path, ...prev.filter((route) => route !== path)];
  const home = ordered.includes("/") ? ["/"] : [];
  const others = ordered.filter((route) => route !== "/");
  return [...home, ...others.slice(0, Math.max(0, ROUTE_CACHE_LIMIT - home.length))];
}

function preloadScene(source: string) {
  const existing = prefetchedScenes.get(source);
  if (existing) return existing.ready;
  const image = new Image();
  image.decoding = "async";
  image.src = source;
  const ready = typeof image.decode === "function"
    ? image.decode().catch(() => undefined).then(() => undefined)
    : new Promise<void>((resolve) => { image.onload = () => resolve(); image.onerror = () => resolve(); });
  prefetchedScenes.set(source, { image, ready });
  return ready;
}

function preloadRoute(path: string, theme: WorkbenchTheme) {
  const tasks: Array<Promise<unknown>> = [];
  const loader = ROUTE_LOADERS[path];
  if (loader) tasks.push(loader());
  const section = ROUTE_SECTIONS[path as keyof typeof ROUTE_SECTIONS];
  if (section) tasks.push(preloadSection(section));
  const scene = PAGE_SCENES_BY_THEME[theme][path];
  if (scene) tasks.push(preloadScene(scene.image));
  return Promise.all(tasks).then(() => undefined);
}

function scheduleIdlePrefetch(theme: WorkbenchTheme) {
  // 只预热场景图与轻页面；健康/语言等重分区等侧栏悬停再拉
  const queue: Array<() => Promise<unknown>> = [
    () => preloadRoute("/schedule", theme),
    () => preloadRoute("/projects", theme),
    () => preloadScene(PAGE_SCENES_BY_THEME[theme]["/library"].image),
    () => preloadScene(PAGE_SCENES_BY_THEME[theme]["/topics"].image),
    () => preloadScene(PAGE_SCENES_BY_THEME[theme]["/markets"].image),
    () => preloadScene(PAGE_SCENES_BY_THEME[theme]["/markets/assets"].image),
    () => preloadScene(PAGE_SCENES_BY_THEME[theme]["/tools"].image),
    () => preloadRoute("/library", theme),
    () => preloadRoute("/markets", theme),
    () => preloadRoute("/tools", theme),
  ];
  let cancelled = false;
  const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (handle: number) => void };
  const schedule = (callback: () => void) => {
    if (idleWindow.requestIdleCallback) return idleWindow.requestIdleCallback(callback, { timeout: 1600 });
    return window.setTimeout(callback, 220);
  };
  let handle = 0;
  const next = () => {
    if (cancelled || !queue.length) return;
    handle = schedule(() => { void queue.shift()!().finally(next); });
  };
  next();
  return () => {
    cancelled = true;
    if (idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(handle);
    else window.clearTimeout(handle);
  };
}

function RouteSkeleton() { return <div className="route-skeleton" aria-label="正在载入页面"/>; }
function RouteError({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="route-error"><AlertTriangle size={18}/><div><strong>这一页的数据没读到</strong><p>{message}</p></div><button onClick={onRetry}>重新读取</button></div>; }
function SectionState<T>({ data, error, loading, retry, render }: { data: T | null; error: string; loading: boolean; retry: () => void; render: (data: T) => React.ReactNode }) {
  if (!data && (loading || !error)) return <RouteSkeleton/>;
  if (!data) return <RouteError message={error} onRetry={retry}/>;
  return <><PositionReadySignal/>{error ? <div className="route-stale"><AlertTriangle size={14}/>刷新没成功，还显示旧数据。<button onClick={retry}>重试</button></div> : null}{render(data)}</>;
}

function PositionReadySignal() {
  useEffect(() => { notifyWorkbenchPositionReady(); }, []);
  return null;
}

function KeepAliveSlot({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={`page${active ? " is-active" : " is-cached"}`} aria-hidden={!active}>
      <Suspense fallback={<RouteSkeleton/>}>{children}</Suspense>
    </div>
  );
}

function HealthRoute({ onAskCoach, onWritePreview }: { onAskCoach: (seedUser: string) => void; onWritePreview: (action: WriteAction) => void }) {
  const state = useSectionData("health");
  return <SectionState<HealthSectionData> {...state} render={(data) => <LazyHealthPage data={data} onAskCoach={onAskCoach} onWritePreview={onWritePreview}/>}/>;
}
function LanguagesRoute({
  onImport,
  onOpenExamAi,
}: {
  onImport: (file: File) => void;
  onOpenExamAi: (bootstrap: import("./pages/LanguagesPage").JapaneseExamBootstrap) => void;
}) {
  const state = useSectionData("languages");
  return (
    <SectionState<LanguagesSectionData>
      {...state}
      render={(data) => (
        <LazyLanguagesPage
          data={data}
          onLanguageReactorImport={onImport}
          onOpenExamAi={onOpenExamAi}
          onSectionRefresh={() => { invalidateSection("languages"); state.retry(); }}
        />
      )}
    />
  );
}
function LibraryRoute({ displayMode }: { displayMode: boolean }) {
  const state = useSectionData("library");
  useEffect(() => {
    const kind = new URLSearchParams(window.location.search).get("kind");
    if (kind === "topic" || kind === "course") navigate(kind === "course" ? "/topics?tab=archive" : "/topics");
  }, []);
  return <SectionState<LibrarySectionData> {...state} render={(data) => <LazyLibraryPage data={data} displayMode={displayMode}/>}/>;
}
function TopicsRoute({ onAskSecretary }: { onAskSecretary: (seedUser: string) => void }) {
  const state = useSectionData("library");
  const [pins, setPins] = useState<HomePins>({ topicIds: [], likedCourseIds: [], researchDomainId: "zztj" });
  useEffect(() => { jsonFetch<HomePins>("/api/home-pins").then(setPins).catch(() => setPins({ topicIds: [], likedCourseIds: [], researchDomainId: "zztj" })); }, []);
  const togglePin = async (topicId: string) => {
    const has = pins.topicIds.includes(topicId);
    const topicIds = has ? pins.topicIds.filter((id) => id !== topicId) : [...pins.topicIds, topicId].slice(0, 12);
    const next = await jsonFetch<HomePins>("/api/home-pins", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topicIds, likedCourseIds: pins.likedCourseIds }) });
    setPins(next);
  };
  const toggleLike = async (courseId: string) => {
    const has = pins.likedCourseIds.includes(courseId);
    const likedCourseIds = has ? pins.likedCourseIds.filter((id) => id !== courseId) : [...pins.likedCourseIds, courseId].slice(0, 24);
    const next = await jsonFetch<HomePins>("/api/home-pins", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topicIds: pins.topicIds, likedCourseIds }) });
    setPins(next);
  };
  const toggleDomainPin = async (domainId: string) => {
    const researchDomainId = pins.researchDomainId === domainId ? null : domainId;
    const next = await jsonFetch<HomePins>("/api/home-pins", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ researchDomainId }) });
    setPins(next);
  };
  return <SectionState<LibrarySectionData> {...state} render={(data) => <LazyTopicsPage data={data} pinnedTopicIds={pins.topicIds} likedCourseIds={pins.likedCourseIds} pinnedDomainId={pins.researchDomainId} onTogglePin={togglePin} onToggleLike={toggleLike} onToggleDomainPin={toggleDomainPin} onAskSecretary={onAskSecretary}/>}/>;
}
function MarketsRoute() { const state = useSectionData("markets"); return <SectionState<MarketsSectionData> {...state} render={(data) => <LazyMarketsPage data={data}/>}/>; }

const EMPTY_WEATHER: WeatherSnapshot = {
  available: false,
  location: "东京",
  temperatureC: null,
  weatherCode: null,
  condition: "读不到",
  uvIndex: null,
  uvLabel: "—",
  refreshedAt: null,
  message: "天气读取失败",
  alert: null,
};

function useTokyoWeather() {
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => jsonFetch<WeatherSnapshot>("/api/weather").then((next) => { if (!cancelled) setWeather(next); }).catch(() => { if (!cancelled) setWeather(EMPTY_WEATHER); });
    load();
    const timer = window.setInterval(load, 20 * 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const alert = weather?.alert && shouldShowLocalWeatherAlert(timeZone) ? weather.alert : null;
  return { weather, alert };
}

function TopbarStatus({ weather, alert }: { weather: WeatherSnapshot | null; alert: WeatherAlert | null }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const date = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "long" }).format(now);
  const temp = weather?.available && weather.temperatureC != null ? `${weather.temperatureC}°` : "—";
  const condition = weather?.condition || "天气加载中";
  const uv = weather ? `UV ${weather.uvIndex != null ? weather.uvIndex : "—"} · ${weather.uvLabel}` : "UV —";
  const weatherState = !weather ? "loading" : weather.available ? "" : "unavailable";
  const statusClass = `topbar-status ${weatherState}${alert ? ` is-alert is-${alert.level} is-${alert.kind}` : ""}`.trim();
  const title = [weather?.message, alert ? `${alert.location} · ${alert.title}` : ""].filter(Boolean).join(" · ") || undefined;
  const cells = <>
    <span>东京时间</span>
    <span className="topbar-status-weather">{condition}</span>
    {alert ? <span className="topbar-status-alert-label">{alert.title}</span> : null}
    <strong>{time}</strong>
    <strong className="topbar-status-temp"><CloudSun size={20} aria-hidden="true" />{temp}</strong>
    {alert ? <strong className="topbar-status-alert-mark" aria-hidden="true"><AlertTriangle size={18} /></strong> : null}
    <small>{date}</small>
    <small className="topbar-status-weather">{uv}</small>
    {alert ? <small>{alert.location}</small> : null}
  </>;
  return <div className="topbar-status-cluster">
    {alert
      ? <a className={statusClass} href={alert.href} aria-label={`东京时间、天气与${alert.title}`} title={title} onClick={(event) => softNavigate(event, alert.href)}>{cells}</a>
      : <div className={statusClass} aria-label="东京时间与天气" title={title}>{cells}</div>}
  </div>;
}

function TopbarWeatherChip({ alert }: { alert: WeatherAlert | null }) {
  if (!alert) return null;
  return <a className={`topbar-weather-chip is-${alert.level} is-${alert.kind}`} href={alert.href} title={`${alert.location} · ${alert.title}`} onClick={(event) => softNavigate(event, alert.href)}><AlertTriangle size={16} aria-hidden="true" /><span>{alert.shortTitle || alert.title.slice(0, 2)}</span></a>;
}

function App() {
  const [path, setPath] = useState(routePath()); const [pendingPath, setPendingPath] = useState(""); const [data, setData] = useState<WorkbenchSummary | null>(null); const [error, setError] = useState(""); const [identity, setIdentity] = useState(false); const [ai, setAi] = useState(false); const [aiPeeked, setAiPeeked] = useState(false); const [aiBootstrap, setAiBootstrap] = useState<AiPanelBootstrap | null>(null); const [preview, setPreview] = useState<PreviewState>(null); const [toast, setToast] = useState(""); const [moreOpen, setMoreOpen] = useState(false);
  const musicPlayer = useSyncExternalStore(subscribeMusicPlayer, getMusicPlayerSnapshot);
  const { weather, alert: weatherAlert } = useTokyoWeather();
  const homeWindow = homeCalendarWindow();
  const { home: calendar, refresh: refreshCalendarWindows } = useCalendarWindows({
    home: { from: homeWindow.from, to: homeWindow.to, active: true },
    onVisibleRefresh: () => {
      if (routePath() === "/health") void refreshSection("health");
    },
  });
  const [sidebarMode, setSidebarMode] = useState<"navigation" | "bookmarks">(() => {
    try { return window.localStorage.getItem("infans-sidebar-mode-v1") === "bookmarks" ? "bookmarks" : "navigation"; }
    catch { return "navigation"; }
  });
  const [sidebarBookmarks, setSidebarBookmarks] = useState<SidebarBookmark[]>([]);
  const [sidebarBookmarksLoading, setSidebarBookmarksLoading] = useState(true);
  const [sidebarBookmarksError, setSidebarBookmarksError] = useState("");
  const [sidebarBookmarksSaving, setSidebarBookmarksSaving] = useState(false);
  const [sidebarBookmarksExpanded, setSidebarBookmarksExpanded] = useState(false);
  const sidebarBookmarksRef = useRef<SidebarBookmark[]>([]);
  const bookmarkDragOriginRef = useRef<SidebarBookmark[] | null>(null);
  const [, setBookmarkLocationRevision] = useState(0);
  const bookmarkLocationRef = useRef("");
  const preferences = useWorkbenchPreferences();
  const theme = preferences.theme;
  const [activeSecretaryId, setActiveSecretaryId] = useState(() => readActiveSecretaryId(window.localStorage));
  const activeSecretary = secretaryProfileById(activeSecretaryId)!;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const routePreparationRevisionRef = useRef(0);
  const [themeSwitching, setThemeSwitching] = useState(false);
  const [displayMode, setDisplayMode] = useState(readDisplayMode);
  const isIPhone = isIPhoneClient(window.navigator);
  const [phoneMacView, setPhoneMacView] = useState(() => readPhoneMacView(window.localStorage, window.navigator));
  const [refreshing, setRefreshing] = useState(false);
  const [routeRefreshRevisions, setRouteRefreshRevisions] = useState<Record<string, number>>({});
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try { return window.localStorage.getItem("infans-sidebar-hidden-v1") === "1"; }
    catch { return false; }
  });
  const [petPresenceActive, setPetPresenceActive] = useState(false);
  const petPresenceSeenRef = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    const read = () => jsonFetch<{ activeSecretaryId: string }>("/api/secretary")
      .then((state) => {
        const next = secretaryProfileById(state.activeSecretaryId);
        if (cancelled || !next) return;
        writeActiveSecretaryId(window.localStorage, next.id);
        setActiveSecretaryId(next.id);
      })
      .catch(() => { /* 服务端短暂刷新时继续使用最近一次本机值班状态。 */ });
    void read();
    window.addEventListener(ACTIVE_SECRETARY_CHANGE_EVENT, read);
    return () => { cancelled = true; window.removeEventListener(ACTIVE_SECRETARY_CHANGE_EVENT, read); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    let pulseTimer = 0;
    const seenKey = `infans-companion-presence-seen-v1:${activeSecretaryId}`;
    const load = () => jsonFetch<{ items: CompanionPresenceInteraction[] }>("/api/proactive-interactions")
      .then((snapshot) => {
        if (cancelled) return;
        const interaction = latestDueCompanionPresence(snapshot.items || [], activeSecretaryId);
        if (!interaction) return;
        let alreadySeen = petPresenceSeenRef.current.has(interaction.interactionId);
        try { alreadySeen ||= window.localStorage.getItem(seenKey) === interaction.interactionId; }
        catch { /* 受限存储下仍用本页内存去重。 */ }
        if (alreadySeen) return;
        petPresenceSeenRef.current.add(interaction.interactionId);
        try { window.localStorage.setItem(seenKey, interaction.interactionId); }
        catch { /* 受限存储下下一次页面启动可能再演一次，但本页不重复。 */ }
        setPetPresenceActive(true);
        window.clearTimeout(pulseTimer);
        pulseTimer = window.setTimeout(() => setPetPresenceActive(false), 5_000);
        postCompanionPresenceToNative(window, interaction);
      })
      .catch(() => { /* 工作台重启或身份暂不可用时，下一轮安静重试。 */ });
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(pulseTimer);
    };
  }, [activeSecretaryId]);
  const sidebarVisibilityGateRef = useRef<ReturnType<typeof createSidebarVisibilityGate> | null>(null);
  if (!sidebarVisibilityGateRef.current) {
    sidebarVisibilityGateRef.current = createSidebarVisibilityGate({ onChange: setSidebarHidden });
  }
  const navigationIntentRef = useRef<"initial" | "active" | "history">("initial");
  const restoredRevisionRef = useRef("");
  const refreshingRef = useRef(false);
  useEffect(() => {
    try { window.localStorage.setItem("infans-sidebar-hidden-v1", sidebarHidden ? "1" : "0"); }
    catch { /* Safari 私密模式或存储受限时只保留本次会话状态。 */ }
  }, [sidebarHidden]);
  useEffect(() => {
    try { window.localStorage.setItem("infans-sidebar-mode-v1", sidebarMode); }
    catch { /* 受限存储下只保留本次会话。 */ }
  }, [sidebarMode]);
  useEffect(() => {
    let cancelled = false;
    jsonFetch<SidebarBookmarkSnapshot>("/api/sidebar-bookmarks")
      .then((snapshot) => {
        if (cancelled) return;
        setSidebarBookmarks(snapshot.items || []);
        setSidebarBookmarksError("");
      })
      .catch(() => { if (!cancelled) setSidebarBookmarksError("书签暂时读不到"); })
      .finally(() => { if (!cancelled) setSidebarBookmarksLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (phoneMacView) sidebarVisibilityGateRef.current?.(false);
  }, [phoneMacView]);
  // 一级目录先在后台准备分包、分区数据和背景图，准备期间保留当前页。
  // contentPath 再走 transition，避免慢网络下空骨架先替换旧页而被看成黑屏。
  const contentPath = useDeferredValue(path);
  const [cachedRoutes, setCachedRoutes] = useState<string[]>(() => [routePath()]);
  // 目标路由的保活槽位必须在这一次渲染里就存在。放到 effect 里会变成一次独立更新，
  // 那次更新不在 transition 内，于是又会露出骨架屏、又吃满 300ms 节流。
  const visitedRoutes = cachedRoutes.includes(contentPath) ? cachedRoutes : touchVisitedRoute(cachedRoutes, contentPath);
  const load = () => jsonFetch<WorkbenchSummary>("/api/summary").then((next) => { setData(next); setError(""); }).catch((e) => setError(e.message));
  const refreshCurrentPage = async (): Promise<boolean> => {
    if (refreshingRef.current) return false;
    refreshingRef.current = true;
    setRefreshing(true);
    captureCurrentWorkbenchPosition();
    const frontendRefresh = await requestFrontendDeepRefresh();
    if (frontendRefresh && frontendBuildNeedsHandoff({
      rebuilt: frontendRefresh.rebuilt,
      serverBuildId: frontendRefresh.buildId,
      loadedBuildId: loadedFrontendBuildId(document),
    })) {
      markFrontendHandoffFeedback(window.sessionStorage);
      window.location.replace(frontendHandoffUrl(window.location, frontendRefresh.buildId ?? Date.now()));
      return true;
    }
    if (contentPath === "/tools") invalidateAllToolSessionCaches();
    setRouteRefreshRevisions((revisions) => ({
      ...revisions,
      [contentPath]: (revisions[contentPath] ?? 0) + 1,
    }));
    const section = ROUTE_SECTIONS[contentPath as keyof typeof ROUTE_SECTIONS];
    const tasks: Array<Promise<unknown>> = [load()];
    if (section) tasks.push(refreshSection(section));
    // macOS 日历权限链偶尔会长时占住请求；它保持后台更新，不阻塞当前页刷新的反馈。
    if (contentPath === "/" || contentPath === "/schedule") void refreshCalendarWindows("all", { force: true });
    try {
      await waitForWorkbenchRefresh(tasks);
      setToast(workbenchRefreshFeedbackText(activeSecretary.name));
      return true;
    } catch (reason) {
      setToast(reason instanceof Error && reason.message === "刷新超时"
        ? "刷新超时，已停止等待，可以稍后再试"
        : reason instanceof Error ? `刷新失败：${reason.message}` : "刷新失败");
      return false;
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };
  useEffect(() => { void preloadRoute(path, themeRef.current); load(); let disposed = false; const pop = () => {
    const nextPath = routePath();
    const active = consumeActiveWorkbenchNavigation();
    const revision = ++routePreparationRevisionRef.current;
    setPendingPath(nextPath);
    void preloadRoute(nextPath, themeRef.current).catch(() => undefined).finally(() => {
      if (disposed || revision !== routePreparationRevisionRef.current) return;
      setPendingPath("");
      navigationIntentRef.current = active ? "active" : "history";
      if (active && window.scrollY && !isWorkbenchNewsHash(window.location.hash)) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      setPath(nextPath);
      setNavigationRevision((value) => value + 1);
    });
  }; window.addEventListener("popstate", pop); const keys = (e: KeyboardEvent) => { if (e.key === "Escape") { setIdentity(false); setAi(false); setAiPeeked(false); setMoreOpen(false); } }; window.addEventListener("keydown", keys); return () => { disposed = true; routePreparationRevisionRef.current += 1; window.removeEventListener("popstate", pop); window.removeEventListener("keydown", keys); }; }, []);
  useEffect(() => installWorkbenchPositionCapture(), []);
  useEffect(() => {
    if (consumeFrontendHandoffFeedback(window.sessionStorage)) setToast(workbenchRefreshFeedbackText(activeSecretary.name));
  }, [activeSecretary.name]);
  useLayoutEffect(() => {
    // 路由高亮会先于延迟内容更新；旧页面仍在屏幕上时不要启动一次无效恢复，
    // 否则同一次主动导航会经历“旧页恢复 + 新页恢复”两轮锁。
    if (!data || contentPath !== path) return;
    const revisionKey = `${navigationRevision}:${contentPath}`;
    if (restoredRevisionRef.current === revisionKey) return;
    restoredRevisionRef.current = revisionKey;
    const activeNavigation = navigationIntentRef.current === "active";
    navigationIntentRef.current = "history";
    rememberCurrentWorkbenchLocation();
    return restoreWorkbenchScroll({ activeNavigation, waitForReady: !activeNavigation && contentPath !== "/" });
  }, [Boolean(data), contentPath, navigationRevision, path]);
  useEffect(() => {
    const syncDisplayMode = (event: StorageEvent) => {
      if (event.key === DISPLAY_MODE_STORAGE_KEY) setDisplayMode(event.newValue === "on");
    };
    window.addEventListener("storage", syncDisplayMode);
    return () => window.removeEventListener("storage", syncDisplayMode);
  }, []);
  useEffect(() => data ? scheduleIdlePrefetch(theme) : undefined, [Boolean(data), theme]);

  useEffect(() => {
    const root = document.documentElement;
    const showKeyboardFocus = (event: KeyboardEvent) => {
      if (event.key === "Tab") root.dataset.keyboardNavigation = "true";
    };
    const clearKeyboardFocus = () => { delete root.dataset.keyboardNavigation; };
    window.addEventListener("keydown", showKeyboardFocus, true);
    window.addEventListener("pointerdown", clearKeyboardFocus, true);
    window.addEventListener("touchstart", clearKeyboardFocus, true);
    return () => {
      window.removeEventListener("keydown", showKeyboardFocus, true);
      window.removeEventListener("pointerdown", clearKeyboardFocus, true);
      window.removeEventListener("touchstart", clearKeyboardFocus, true);
      clearKeyboardFocus();
    };
  }, []);
  // 只负责把 LRU 顺序落回 state；槽位集合已在渲染阶段算好，这里不会新增 Suspense 边界。
  useEffect(() => {
    setCachedRoutes((prev) => touchVisitedRoute(prev, contentPath));
  }, [contentPath]);
  const requestPreview = async (action: WriteAction) => {
    try {
      const body = await jsonFetch<WritePreview>("/api/write/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      if (skipsWorkbenchWriteConfirmation(action)) {
        await jsonFetch("/api/write/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: body.token }),
        });
        await load();
        setToast(directWriteSuccessMessage(action));
        if (action.kind === "toggleTodo" && !action.expectedDone) showInteractionCue({ kind: "complete", label: "已完成" });
        return;
      }
      setPreview({ preview: body, commitUrl: "/api/write/commit", afterCommit: load });
    } catch (error) {
      setToast(error instanceof Error ? error.message : "没写进去");
    }
  };
  const refreshLanguages = () => { invalidateSection("languages"); preloadSection("languages"); load(); };
  const requestLanguageReactorPreview = async (file: File) => { try { setToast("正在整理 Language Reactor 收藏…"); const response = await fetch("/api/language-reactor/preview", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-Infans-Filename": encodeURIComponent(file.name), "X-Infans-File-Modified": String(file.lastModified || "") }, body: file }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "读不懂这个 Language Reactor 导出"); setToast(""); setPreview({ preview: body, commitUrl: "/api/language-reactor/commit", afterCommit: refreshLanguages }); } catch (e) { setToast(e instanceof Error ? e.message : "读不懂这个 Language Reactor 导出"); } };
  const commit = async () => { if (!preview) return; try { await jsonFetch(preview.commitUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: preview.preview.token }) }); preview.afterCommit?.(); window.dispatchEvent(new Event("infans:vault-updated")); setToast("改好了，文件已经更新。"); setPreview(null); } catch (e) { setToast(e instanceof Error ? e.message : "没写进去"); } };
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(""), toast.endsWith(WORKBENCH_REFRESH_FEEDBACK_SUFFIX) ? 2350 : 3800); return () => clearTimeout(t); }, [toast]);
  const summaryFallback = error ? <RouteError message={error} onRetry={() => { void load(); }}/> : <RouteSkeleton/>;
  const syncCalendar = () => { void refreshCalendarWindows("all", { force: true }); };
  const openAi = (bootstrap?: AiPanelBootstrap) => {
    if (bootstrap) setAiBootstrap(bootstrap);
    setAiPeeked(false);
    setAi(true);
  };
  const closeAi = () => {
    setAi(false);
    setAiPeeked(false);
    setAiBootstrap(null);
  };
  const routeContent = (route: string, active: boolean) => {
    if (route === "/schedule") return data ? <LazySchedulePage data={data} onWritePreview={requestPreview} active={active}/> : summaryFallback;
    if (route === "/projects") return data ? <LazyProjectsPage data={data} displayMode={displayMode} onWritePreview={requestPreview}/> : summaryFallback;
    if (route === "/health") return <HealthRoute onAskCoach={(seedUser) => { openAi({ mode: "healthCoach", seedUser, include: ["health"] }); }} onWritePreview={requestPreview}/>;
    if (route === "/languages") return <LanguagesRoute onImport={requestLanguageReactorPreview} onOpenExamAi={(bootstrap) => { openAi(bootstrap); }}/>;
    if (route === "/library") return <LibraryRoute displayMode={displayMode}/>;
    if (route === "/topics") return <TopicsRoute onAskSecretary={(seedUser) => { openAi({ mode: "askSelection", seedUser, teaching: true }); }}/>;
    if (route === "/markets/assets") return (
      <LazyAssetsPage
        displayMode={displayMode}
        onAskSecretary={(seedUser) => {
          openAi({ mode: "askSelection", seedUser });
        }}
      />
    );
    if (route === "/markets") return <MarketsRoute/>;
    if (route === "/tools") {
      return (
        <LazyToolsPage
          active={active}
          displayMode={displayMode}
          onDisplayModeChange={(enabled) => {
            writeDisplayMode(enabled);
            setDisplayMode(enabled);
          }}
          onWritePreview={requestPreview}
        />
      );
    }
    return data ? <HomePage data={data} calendar={calendar} secretaryName={activeSecretary.name} active={active} refreshSummary={load} onAskSecretary={(seedUser) => { openAi({ mode: "askSelection", seedUser }); }}/> : summaryFallback;
  };
  const toastError = toast.startsWith("导入失败") || /无法|拒绝|过期|不支持|超过|超时|失败/.test(toast);
  const toastRefresh = toast.endsWith(WORKBENCH_REFRESH_FEEDBACK_SUFFIX);
  // 场景图与标题跟着内容一起换，避免背景/标题先变、正文还停在上一页。
  const baseScene = getPageScene(theme, contentPath, activeSecretaryId);
  const adjusted = preferences.appearance.backgrounds[contentPath] || DEFAULT_SCENE_ADJUSTMENTS;
  const chosenAsset = preferences.snapshot.backgrounds.find(asset => asset.id === adjusted.assetId);
  const crop = preferences.previewCrops[`${preferences.appearance.id}:${contentPath}`] || preferences.device.crops[`${preferences.appearance.id}:${contentPath}`];
  const sceneImage = chosenAsset?.url || baseScene.image;
  const scene = { ...baseScene, image: sceneImage, position: backgroundPosition(crop, sceneImage) };
  const readingRoute = window.location.pathname;
  const readingSize = preferences.temporarySize?.route === readingRoute ? preferences.temporarySize.size : preferences.device.pageTextSizes[readingRoute] || preferences.device.textSize;
  const shade = (scene.shade || "linear-gradient(90deg,rgba(4,10,13,.98) 0%,rgba(5,12,15,.91) 37%,rgba(5,12,15,.56) 63%,rgba(4,10,13,.20) 100%)").replace(/rgba\([^)]*,([.\d]+)\)/g, (_color, opacity) => `color-mix(in srgb,var(--bg) ${Number(opacity)*100}%,transparent)`);
  const sceneStyle = { "--scene-brightness": adjusted.brightness, "--scene-saturation": adjusted.saturation, "--scene-contrast": adjusted.contrast, "--scene-blur": `${adjusted.blur}px`, "--scene-veil": adjusted.veil, "--page-scene": `url("${scene.image}")`, "--page-scene-position": scene.position, "--page-scene-shade": shade } as CSSProperties;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const greeting = hour < 2 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好呀" : "晚上好";
  const paymentGuard = data?.paymentGuard;
  const homeIntro = <div className="home-intro"><h2><span className="home-intro-greeting">{greeting}</span><span className="home-intro-comma">，</span><span className="home-intro-address">道友</span></h2>{paymentGuard?.count ? <a className={`home-important-alert is-${paymentGuard.level}`} href={paymentGuard.href} title={paymentGuard.summary} onClick={(event) => softNavigate(event, paymentGuard.href)}><AlertTriangle size={12}/><strong>重要提醒</strong><em>{paymentGuard.count}</em><small>{paymentGuard.summary}</small></a> : null}</div>;
  const primaryNavigation = PRIMARY_NAV_ITEMS;
  const moreNavigation = NAV_ITEMS.filter((item) => !primaryNavigation.includes(item));
  const moreNavActive = moreNavigation.some((item) => path === item.path);
  const projectNames = Object.fromEntries((data?.projectManagement?.projects || []).flatMap((project) => {
    const id = project.projectId || "";
    return id ? [[id, project.name] as const] : [];
  }));
  const currentBookmarkLocation = normalizeSidebarBookmarkLocation(`${window.location.pathname}${window.location.search}`) || "";
  bookmarkLocationRef.current = currentBookmarkLocation;
  const visibleSidebarBookmarks = sidebarBookmarks;
  const currentSidebarBookmark = sidebarBookmarks.find((bookmark) => bookmark.location === currentBookmarkLocation) || null;
  const currentBookmarkAllowedInDisplayMode = !displayMode || isSidebarBookmarkNavigableInDisplayMode({
    location: currentBookmarkLocation,
    label: currentSidebarBookmark?.label || defaultSidebarBookmarkLabel(currentBookmarkLocation, { projectNames }),
  });
  const canBookmarkCurrentPage = isSidebarBookmarkableLocation(currentBookmarkLocation) && currentBookmarkAllowedInDisplayMode;
  const canAddCurrentBookmark = canBookmarkCurrentPage && !currentSidebarBookmark && sidebarBookmarks.length < MAX_SIDEBAR_BOOKMARKS;
  const addCurrentBookmarkLabel = sidebarBookmarks.length >= MAX_SIDEBAR_BOOKMARKS
    ? `已放满 ${MAX_SIDEBAR_BOOKMARKS} 个`
    : currentSidebarBookmark
      ? "当前页面已添加"
      : canBookmarkCurrentPage
        ? "添加当前页面"
        : "当前页面不能添加";
  const displayedSidebarBookmarks = sidebarBookmarksExpanded
    ? visibleSidebarBookmarks
    : visibleSidebarBookmarks.slice(0, SIDEBAR_BOOKMARK_COLLAPSED_COUNT);
  sidebarBookmarksRef.current = sidebarBookmarks;
  const hiddenSidebarBookmarkCount = Math.max(0, visibleSidebarBookmarks.length - SIDEBAR_BOOKMARK_COLLAPSED_COUNT);
  const syncBookmarkLocation = () => {
    window.requestAnimationFrame(() => {
      const next = normalizeSidebarBookmarkLocation(`${window.location.pathname}${window.location.search}`) || "";
      if (next === bookmarkLocationRef.current) return;
      bookmarkLocationRef.current = next;
      setBookmarkLocationRevision((revision) => revision + 1);
    });
  };
  const saveSidebarBookmarks = async (next: SidebarBookmark[], feedback = "", rollback = sidebarBookmarksRef.current) => {
    if (sidebarBookmarksSaving) return false;
    setSidebarBookmarksSaving(true);
    try {
      const saved = await jsonFetch<SidebarBookmarkSnapshot>("/api/sidebar-bookmarks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: next }),
      });
      sidebarBookmarksRef.current = saved.items || [];
      setSidebarBookmarks(sidebarBookmarksRef.current);
      setSidebarBookmarksError("");
      if (feedback) setToast(feedback);
      return true;
    } catch (reason) {
      sidebarBookmarksRef.current = rollback;
      setSidebarBookmarks(rollback);
      setToast(reason instanceof Error ? `书签没有保存：${reason.message}` : "书签没有保存");
      return false;
    } finally {
      setSidebarBookmarksSaving(false);
    }
  };
  const addCurrentBookmark = async () => {
    if (!canAddCurrentBookmark || sidebarBookmarksSaving) return;
    if (sidebarBookmarks.length >= MAX_SIDEBAR_BOOKMARKS) {
      setToast(`侧栏最多放 ${MAX_SIDEBAR_BOOKMARKS} 个，请先移除一个`);
      return;
    }
    const label = defaultSidebarBookmarkLabel(currentBookmarkLocation, { projectNames });
    const nextCount = sidebarBookmarks.length + 1;
    const saved = await saveSidebarBookmarks([...sidebarBookmarks, { location: currentBookmarkLocation, label }], `已添加当前页面 · ${nextCount}/${MAX_SIDEBAR_BOOKMARKS}`);
    if (saved && nextCount > SIDEBAR_BOOKMARK_COLLAPSED_COUNT) setSidebarBookmarksExpanded(true);
  };
  const removeSidebarBookmark = async (location: string) => {
    await saveSidebarBookmarks(sidebarBookmarks.filter((bookmark) => bookmark.location !== location), "已从侧栏移除");
  };
  const openSidebarBookmark = (event: ReactMouseEvent<HTMLAnchorElement>, location: string) => {
    const bookmark = sidebarBookmarksRef.current.find((item) => item.location === location);
    if (displayMode && bookmark && !isSidebarBookmarkNavigableInDisplayMode(bookmark)) {
      event.preventDefault();
      setToast("展示模式下暂不可进入这个书签");
      return;
    }
    if (!shouldSoftNavigate(event)) return;
    event.preventDefault();
    setMoreOpen(false);
    captureCurrentWorkbenchPosition();
    navigateWithPositionRestore(location);
  };
  const beginSidebarBookmarkDrag = () => {
    if (!bookmarkDragOriginRef.current) bookmarkDragOriginRef.current = [...sidebarBookmarksRef.current];
  };
  const reorderVisibleSidebarBookmarks = (nextVisibleOrder: SidebarBookmark[]) => {
    if (displayMode || sidebarBookmarksSaving) return;
    beginSidebarBookmarkDrag();
    const next = mergeSidebarBookmarkOrder(sidebarBookmarksRef.current, nextVisibleOrder);
    sidebarBookmarksRef.current = next;
    setSidebarBookmarks(next);
  };
  const commitSidebarBookmarkDrag = () => {
    const rollback = bookmarkDragOriginRef.current;
    bookmarkDragOriginRef.current = null;
    if (!rollback) return;
    void saveSidebarBookmarks(sidebarBookmarksRef.current, "书签顺序已保存", rollback);
  };
  const moveSidebarBookmark = (location: string, delta: -1 | 1) => {
    if (displayMode || sidebarBookmarksSaving) return;
    const current = sidebarBookmarksRef.current;
    const index = current.findIndex((bookmark) => bookmark.location === location);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= current.length) return;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    sidebarBookmarksRef.current = next;
    setSidebarBookmarks(next);
    if (target >= SIDEBAR_BOOKMARK_COLLAPSED_COUNT) setSidebarBookmarksExpanded(true);
    void saveSidebarBookmarks(next, "书签顺序已保存", current);
  };
  useEffect(() => {
    const executeShortcut = (command: WorkbenchShortcutCommand, target: EventTarget | null) => {
      if (shouldIgnoreWorkbenchShortcutTarget(target)) return false;
      if (false && command === "enable-display-mode") {
        if (!displayMode) {
          writeDisplayMode(true);
          setDisplayMode(true);
          setMoreOpen(false);
          setToast("展示模式已开启");
        }
        return true;
      }
      if (command.startsWith("bookmark-")) {
        const slot = Number(command.slice("bookmark-".length)) - 1;
        const bookmark = sidebarBookmarks[slot];
        if (!bookmark || (displayMode && !isSidebarBookmarkNavigableInDisplayMode(bookmark))) return true;
        setMoreOpen(false);
        captureCurrentWorkbenchPosition();
        navigateWithPositionRestore(bookmark.location);
        return true;
      }
      if (command === "history-back" || command === "history-forward") {
        captureCurrentWorkbenchPosition();
        if (command === "history-back") window.history.back();
        else window.history.forward();
        return true;
      }
      if (command === "toggle-sidebar") {
        if (!window.matchMedia("(min-width: 901px)").matches) return true;
        sidebarVisibilityGateRef.current?.(!sidebarHidden);
        return true;
      }
      return false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const command = workbenchShortcutFromKeyboardEvent(event, preferences.device.shortcuts);
      if (!command || !executeShortcut(command, event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onNativeShortcut = (event: Event) => {
      const command = workbenchShortcutFromCustomEvent(event, preferences.device.shortcuts);
      if (command) executeShortcut(command, document.activeElement);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(WORKBENCH_SHORTCUT_EVENT, onNativeShortcut);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(WORKBENCH_SHORTCUT_EVENT, onNativeShortcut);
    };
  }, [displayMode, sidebarBookmarks, sidebarHidden, preferences.device.shortcuts]);
  const toggleHeaderMusic = () => {
    void toggleMusicPlayback().catch((reason) => {
      setToast(reason instanceof Error ? reason.message : "音乐暂时播放不了");
    });
  };
  const openIdentity = () => { if (data) { setIdentity(true); setMoreOpen(false); } };
  const switchPhoneMacView = (enabled: boolean) => {
    if (!isIPhone) return;
    captureCurrentWorkbenchPosition();
    writePhoneMacView(enabled, window.localStorage);
    setPhoneMacView(enabled);
    setMoreOpen(false);
    if (enabled) sidebarVisibilityGateRef.current?.(false);
    reloadAfterPhoneMacViewChange(enabled);
  };
  const switchTheme = async (next: WorkbenchTheme) => {
    if (themeSwitching || preferences.saving || (next === theme && !preferences.preview)) return;
    setThemeSwitching(true);
    try {
      await preloadScene(getPageScene(next, contentPath, activeSecretaryId).image);
      await preferences.switchTheme(next);
    } catch (error) { setToast(error instanceof Error ? error.message : "主题没有保存成功"); }
    finally { setThemeSwitching(false); }
  };
  const changeActiveSecretary = async (raw: string) => {
    const next = secretaryProfileById(raw);
    if (!next || next.id === activeSecretaryId) return;
    await preloadScene(getPageScene(themeRef.current, "/", next.id).image);
    try {
      const saved = await jsonFetch<{ activeSecretaryId: string }>("/api/secretary", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeSecretaryId: next.id }),
      });
      const accepted = secretaryProfileById(saved.activeSecretaryId);
      if (!accepted) throw new Error("当前秘书状态无效");
      writeActiveSecretaryId(window.localStorage, accepted.id);
      await transitionAppearance(() => {
        setActiveSecretaryId(accepted.id);
      });
      showInteractionCue({ kind: "arrival", label: accepted.name, portrait: accepted.avatarSrc });
    } catch (error) {
      setToast(error instanceof Error ? `切换没有保存：${error.message}` : "切换没有保存");
    }
  };
  const handleHomeClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (path !== "/") {
      softNavigate(event, "/");
      return;
    }
    event.preventDefault();
    window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  };
  const sidebarPetImage = activeSecretary.avatarSrc || "/theme/avatar-yinyue-public.svg";
  return (
    <div className={`app-shell${data ? " is-ready" : " is-booting"}${sidebarHidden ? " sidebar-hidden" : ""}${ai && !aiPeeked ? " ai-open" : ""}${ai && aiPeeked ? " ai-peeked" : ""}${themeSwitching ? " theme-switching" : ""}`} data-theme={theme} data-secretary={activeSecretaryId} data-display-mode={displayMode ? "on" : "off"} style={sceneStyle}>
      <a className="skip-link" href="#main-content">跳到主内容</a>
      <aside className="sidebar">
        <div className="brand">
          <button type="button" className="sidebar-pet-toggle" onClick={() => { sidebarVisibilityGateRef.current?.(!sidebarHidden); }} aria-label={sidebarHidden ? "显示主侧边栏" : "隐藏主侧边栏"} title={sidebarHidden ? "显示主侧边栏" : "隐藏主侧边栏"}><span className={`brand-pet${petPresenceActive ? " brand-pet-present" : ""}`}><img src={sidebarPetImage} alt=""/></span></button>
          <a className="brand-home" href="/" aria-label={`${SECRETARY_PRODUCT_BRAND}首页，当前${activeSecretary.name}值班`} onClick={handleHomeClick}><strong>{activeSecretary.name}{SECRETARY_PRODUCT_BRAND}</strong><small>{activeSecretary.subtitleLines.map((line: string) => <span key={line}>{line}</span>)}</small></a>
        </div>
        <div className="sidebar-mode-switch" role="tablist" aria-label="侧栏内容">
          <button type="button" role="tab" aria-selected={sidebarMode === "navigation"} className={sidebarMode === "navigation" ? "is-active" : ""} onClick={() => setSidebarMode("navigation")}>导航</button>
          <button type="button" role="tab" aria-selected={sidebarMode === "bookmarks"} className={sidebarMode === "bookmarks" ? "is-active" : ""} onClick={() => setSidebarMode("bookmarks")}><span>书签</span>{visibleSidebarBookmarks.length ? <em>{visibleSidebarBookmarks.length}</em> : null}</button>
        </div>
        {sidebarMode === "navigation" ? <nav className="sidebar-nav-desktop" aria-label="主导航">
          {NAV_ITEMS.map((item) => <a className={`${path === item.path ? "active" : ""}${pendingPath === item.path ? " pending" : ""}`.trim()} href={item.path} key={item.path} aria-busy={pendingPath === item.path || undefined} onPointerEnter={() => { void preloadRoute(item.path, theme); }} onFocus={() => { void preloadRoute(item.path, theme); }} onPointerDown={() => { void preloadRoute(item.path, theme); }} onClick={item.path === "/" ? handleHomeClick : (event) => softNavigate(event, item.path)}><item.icon size={17}/><span>{item.label}</span><small>{pendingPath === item.path ? "…" : item.index}</small></a>)}
        </nav> : <nav className="sidebar-nav-desktop sidebar-bookmark-list" aria-label="侧栏书签">
          {sidebarBookmarksLoading ? <p className="sidebar-bookmark-empty">正在取书签…</p> : sidebarBookmarksError ? <p className="sidebar-bookmark-empty is-error">{sidebarBookmarksError}</p> : <>
          <Reorder.Group as="div" axis="y" className="sidebar-bookmark-reorder" values={displayedSidebarBookmarks} onReorder={reorderVisibleSidebarBookmarks}>
            {displayedSidebarBookmarks.map((bookmark) => <SidebarBookmarkItem
              key={bookmark.location}
              variant="desktop"
              bookmark={bookmark}
              slotNumber={sidebarBookmarks.findIndex((item) => item.location === bookmark.location) + 1}
              active={currentBookmarkLocation === bookmark.location}
              disabled={displayMode || sidebarBookmarksSaving}
              navigationDisabled={displayMode && !isSidebarBookmarkNavigableInDisplayMode(bookmark)}
              theme={theme}
              onDragStart={beginSidebarBookmarkDrag}
              onDragEnd={commitSidebarBookmarkDrag}
              onMove={(delta) => moveSidebarBookmark(bookmark.location, delta)}
              onOpen={openSidebarBookmark}
              onRemove={(location) => { void removeSidebarBookmark(location); }}
            />)}
          </Reorder.Group>
          {hiddenSidebarBookmarkCount > 0 ? <button type="button" className="sidebar-bookmark-expand" onClick={() => setSidebarBookmarksExpanded((expanded) => !expanded)}>{sidebarBookmarksExpanded ? "收起" : `展开其余 ${hiddenSidebarBookmarkCount} 个`}</button> : null}
          <button type="button" className={`sidebar-bookmark-add${currentSidebarBookmark ? " is-current" : ""}`} disabled={!canAddCurrentBookmark || sidebarBookmarksSaving} onClick={() => { void addCurrentBookmark(); }}><Plus size={15}/><span>{addCurrentBookmarkLabel}</span></button>
          </>}
        </nav>}
        <nav className="sidebar-nav-mobile" aria-label="手机导航">
          {primaryNavigation.map((item) => {
            const isHome = item.path === "/";
            return <a className={`${path === item.path ? "active" : ""}${pendingPath === item.path ? " pending" : ""}`.trim()} href={item.path} key={item.path} aria-busy={pendingPath === item.path || undefined} onPointerEnter={() => { void preloadRoute(item.path, theme); }} onFocus={() => { void preloadRoute(item.path, theme); }} onPointerDown={() => { void preloadRoute(item.path, theme); }} onClick={(event) => {
              setMoreOpen(false);
              if (isHome) handleHomeClick(event);
              else softNavigate(event, item.path);
            }} aria-label={item.label} title={item.label}><item.icon size={17}/><span>{item.label}</span></a>;
          })}
          <button type="button" className={`nav-more${moreOpen || moreNavActive ? " active" : ""}`} onClick={() => setMoreOpen((open) => !open)} aria-label="更多" title="更多" aria-expanded={moreOpen} aria-controls="mobile-more-sheet"><MoreHorizontal size={17}/><span>更多</span></button>
        </nav>
        <div className="sidebar-footer">
          {phoneMacView ? <button type="button" className="phone-mac-view-exit" onClick={() => switchPhoneMacView(false)}><Smartphone size={16}/><span>返回手机排版</span></button> : null}
          <ThemeSwitch theme={theme} switching={themeSwitching} refreshing={refreshing} onThemeChange={(next) => { void switchTheme(next); }} onReload={() => { void refreshCurrentPage(); }}/>
          <ProfileSwitcher canOpenIdentity={Boolean(data)} onOpenIdentity={openIdentity}/>
        </div>
      </aside>
      <main id="main-content" className="workspace" tabIndex={-1} onClickCapture={syncBookmarkLocation} onKeyUpCapture={syncBookmarkLocation}>
        <div className="workspace-backdrop" data-custom-scene={Boolean(chosenAsset)} aria-hidden="true"><div className="workspace-backdrop-scene"/><div className="workspace-backdrop-veil"/><SceneAtmosphere theme={theme} active={!identity && !(ai && !aiPeeked)}/></div>
        <header className={`topbar${contentPath === "/" ? " topbar-home" : ""}`}>
          {contentPath === "/" ? homeIntro : <PageNavigation route={contentPath} title={PAGE_META[contentPath].title} annotation={pageAnnotation(contentPath)} />}
          <TopbarStatus weather={weather} alert={weatherAlert} />
          <div className="top-actions">
            <ReadingSizeControl route={readingRoute}/>
            <TopbarWeatherChip alert={weatherAlert} />
            <button type="button" className={`header-music-button${musicPlayer.playing ? " is-playing" : ""}`} onClick={toggleHeaderMusic} aria-label={musicPlayer.playing ? "暂停音乐" : "播放音乐"} aria-pressed={musicPlayer.playing} title={musicPlayer.playing ? "暂停音乐" : "播放音乐"}>{musicPlayer.playing ? <Pause size={18}/> : <Music2 size={18}/>}<span>{musicPlayer.playing ? "暂停" : "听歌"}</span></button>
            <button type="button" className="ai-button" onClick={() => openAi()} aria-label={`与${activeSecretary.name}聊天`}><Sparkles size={16}/><span>与{activeSecretary.name}聊天</span></button>
          </div>
        </header>
        <div className="page-stack" data-reading-size={readingSize} style={typographyTokens(readingSize)}>{visitedRoutes.map((route) => <KeepAliveSlot active={contentPath === route} key={`${route}:${routeRefreshRevisions[route] ?? 0}`}><PageNavigationScope route={route} active={contentPath === route}>{routeContent(route, contentPath === route)}</PageNavigationScope></KeepAliveSlot>)}</div>
      </main>
      <AnimatePresence>
        {moreOpen ? <motion.div key="more-sheet" className="more-sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && setMoreOpen(false)}><motion.div id="mobile-more-sheet" className="more-sheet" initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "tween", duration: 0.22 }} role="dialog" aria-label="更多入口"><header><strong>更多</strong><button type="button" onClick={() => setMoreOpen(false)} aria-label="关闭更多"><X size={17}/></button></header><section className="more-sheet-bookmarks" aria-label="侧栏书签"><header><strong>书签</strong><small>{visibleSidebarBookmarks.length}/{MAX_SIDEBAR_BOOKMARKS}</small></header><Reorder.Group as="div" axis="y" className="more-sheet-bookmark-reorder" values={visibleSidebarBookmarks} onReorder={reorderVisibleSidebarBookmarks}>{visibleSidebarBookmarks.map((bookmark) => <SidebarBookmarkItem key={bookmark.location} variant="mobile" bookmark={bookmark} slotNumber={sidebarBookmarks.findIndex((item) => item.location === bookmark.location) + 1} active={currentBookmarkLocation === bookmark.location} disabled={displayMode || sidebarBookmarksSaving} navigationDisabled={displayMode && !isSidebarBookmarkNavigableInDisplayMode(bookmark)} theme={theme} onDragStart={beginSidebarBookmarkDrag} onDragEnd={commitSidebarBookmarkDrag} onMove={(delta) => moveSidebarBookmark(bookmark.location, delta)} onOpen={(event, location) => { setMoreOpen(false); openSidebarBookmark(event, location); }} onRemove={(location) => { void removeSidebarBookmark(location); }}/>)}</Reorder.Group><button type="button" className={`more-sheet-bookmark-add${currentSidebarBookmark ? " is-current" : ""}`} disabled={!canAddCurrentBookmark || sidebarBookmarksSaving} onClick={() => { void addCurrentBookmark(); }}><Plus size={15}/><span>{addCurrentBookmarkLabel}</span></button></section><section className="more-sheet-grid">{moreNavigation.map((item) => <a className={`${path === item.path ? "active" : ""}${pendingPath === item.path ? " pending" : ""}`.trim()} href={item.path} key={item.path} aria-busy={pendingPath === item.path || undefined} onClick={(event) => { setMoreOpen(false); softNavigate(event, item.path); }}><item.icon size={20}/><span>{item.label}</span></a>)}</section><div className="more-sheet-theme"><ThemeSwitch className="theme-switch-mobile" theme={theme} switching={themeSwitching} refreshing={refreshing} onThemeChange={(next) => { setMoreOpen(false); void switchTheme(next); }} onReload={() => { void refreshCurrentPage().then((ok) => { if (shouldCloseMoreSheetAfterRefresh(ok)) setMoreOpen(false); }); }}/></div><section className={`more-sheet-actions${isIPhone ? " has-mac-view" : ""}`}><button type="button" onClick={openIdentity} disabled={!data}><UserRound size={18}/><span>身份档案</span></button>{isIPhone ? <button type="button" className="more-sheet-mac-view" onClick={() => switchPhoneMacView(true)} aria-label="以完整 Mac 页面显示"><Monitor size={18}/><span>Mac</span></button> : null}</section></motion.div></motion.div> : null}
        {identity && data ? <IdentityOverlay data={data} onClose={() => setIdentity(false)}/> : null}
        {ai ? <AiPanel activeSecretaryId={activeSecretaryId} onSecretaryChange={changeActiveSecretary} displayMode={displayMode} peeked={aiPeeked} onPeek={() => setAiPeeked(true)} onExpand={() => setAiPeeked(false)} onClose={closeAi} onToast={setToast} onDataRefresh={load} onCalendarRefresh={syncCalendar} bootstrap={aiBootstrap} onBootstrapConsumed={() => setAiBootstrap(null)}/> : null}
        {preview ? <PreviewModal state={preview} onClose={() => setPreview(null)} onCommit={commit}/> : null}
      </AnimatePresence>
      {null}
      <InteractionFeedback/>
      <LuminousInteractions/>
      <SelectionAskMenu route={path} onAsk={(seedUser) => { openAi({ mode: "askSelection", seedUser }); }}/>
      <SelectionAskFab route={path} onAsk={(seedUser) => { openAi({ mode: "askSelection", seedUser }); }}/>
      {toast ? <div className={`toast${toastRefresh ? " reload-feedback" : ""}${toastError ? " error" : ""}`} role="status" aria-live={toastError ? "assertive" : "polite"} aria-atomic="true">{toastRefresh ? <><img className="reload-feedback-portrait" src={secretaryRefreshPortraitSrc(activeSecretary)} alt="" aria-hidden="true"/><strong className="reload-feedback-copy">{toast}</strong></> : <>{toastError ? <AlertTriangle size={15} aria-hidden="true"/> : <CheckCircle2 size={15} aria-hidden="true"/>}{toast}</>}</div> : null}
    </div>
  );
}

const appRoot = window.__infansReactRoot ??= createRoot(document.getElementById("root")!);
appRoot.render(<MotionConfig reducedMotion="user"><WorkbenchPreferencesProvider><App/></WorkbenchPreferencesProvider></MotionConfig>);

declare global {
  interface Window { __infansReactRoot?: ReturnType<typeof createRoot>; }
}
