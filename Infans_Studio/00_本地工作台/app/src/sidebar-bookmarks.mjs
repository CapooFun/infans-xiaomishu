export const SIDEBAR_BOOKMARKS_VERSION = 1;
export const MAX_SIDEBAR_BOOKMARKS = 6;

const ROOT_LABELS = Object.freeze({
  "/": "首页",
  "/schedule": "日程安排",
  "/projects": "事业顺利",
  "/health": "身心健康",
  "/languages": "语言学习",
  "/markets": "世界资讯",
  "/topics": "专题研究",
  "/library": "艺术馆藏",
  "/markets/assets": "资产管理",
  "/tools": "实用工具",
});

const ROOT_PATHS = new Set(Object.keys(ROOT_LABELS));
const ROUTE_QUERY_KEYS = Object.freeze({
  "/schedule": ["todos", "view"],
  "/projects": ["project", "view", "workline", "tree", "module", "feature", "node", "from"],
  "/health": ["band"],
  "/languages": ["section"],
  "/library": ["open", "view", "kind"],
  "/topics": ["tab", "domain", "branch", "node", "card", "open", "course"],
  "/markets": ["topic", "lane"],
  "/markets/assets": ["tab"],
  "/tools/inbox": ["section"],
});

const INBOX_SECTION_LABELS = Object.freeze({
  bookmarks: "书签",
  files: "文件",
  projects: "项目收件",
  trash: "回收站",
});

const TOOL_LABELS = Object.freeze({
  "collaboration-records": "协作记录",
  "inbox": "秘书收件箱",
  "development-log": "工作日志",
  "diary-mode": "对话日志",
  cron: "异常雷达",
  "art-library": "项目素材库",
  "native-ui-design": "设计台",
  "ai-tools": "工具与素材收藏",
  "game-analytics": "游戏数据表现",
  "web-bookmarks": "网页收藏",
  "food-map": "美食地图",
  music: "音乐",
  video: "视频",
  photo: "相册",
  settings: "系统设置",
  renewals: "续费到期",
});

const SCHEDULE_LABELS = Object.freeze({ today: "今日事项", roadmap: "主线进度", local: "本地活动", japan: "本地活动", releases: "新品发售" });
const HEALTH_LABELS = Object.freeze({ body: "体魄", mind: "心理", life: "人生平衡" });
const LANGUAGE_LABELS = Object.freeze({ exploration: "探索成就", course: "课程", vocabulary: "单词", grammar: "文法", reading: "阅读", collection: "收藏" });
const ASSET_LABELS = Object.freeze({ networth: "资产", investments: "投资", income: "收入", expense: "支出" });
const TOPIC_DOMAIN_LABELS = Object.freeze({
  game: "游戏研究",
  ai: "人工智能",
  language: "语言研究",
  "thought-history": "思想史",
  zztj: "资治通鉴",
  "image-management": "形象管理",
  fitness: "运动健身",
  "economics-finance": "经济与金融",
});
const LIBRARY_KIND_LABELS = Object.freeze({ game: "游戏", animation: "动漫", screen: "影视", book: "书籍", writing: "写作" });
const LIBRARY_VIEW_LABELS = Object.freeze({ collection: "作品库", influence: "影响我的", recommendations: "我的推荐", culture: "文化馆藏" });
const DISPLAY_MODE_BLOCKED_TOOLS = new Set(["diary-mode", "inbox"]);
const MAX_LOCATION_LENGTH = 768;
const MAX_LABEL_LENGTH = 48;
const MAX_PARAM_LENGTH = 160;

function cleanText(value, limit) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function normalizedPathname(pathname) {
  if (ROOT_PATHS.has(pathname)) return pathname;
  const toolMatch = pathname.match(/^\/tools\/([a-z0-9-]+)\/?$/);
  if (toolMatch && TOOL_LABELS[toolMatch[1]]) return `/tools/${toolMatch[1]}`;
  return null;
}

function routeKey(pathname) {
  if (ROUTE_QUERY_KEYS[pathname]) return pathname;
  return pathname.startsWith("/tools/") ? "/tools" : pathname;
}

export function normalizeSidebarBookmarkLocation(input, base = "http://127.0.0.1") {
  const raw = cleanText(input, MAX_LOCATION_LENGTH);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  const pathname = normalizedPathname(url.pathname);
  if (!pathname) return null;
  const next = new URLSearchParams();
  for (const key of ROUTE_QUERY_KEYS[routeKey(pathname)] || []) {
    const value = cleanText(url.searchParams.get(key), MAX_PARAM_LENGTH);
    if (value) next.set(key, value);
  }
  const query = next.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

export function isSidebarBookmarkableLocation(input) {
  return Boolean(normalizeSidebarBookmarkLocation(input));
}

export function defaultSidebarBookmarkLabel(input, options = {}) {
  const location = normalizeSidebarBookmarkLocation(input);
  if (!location) return "具体页面";
  const url = new URL(location, "http://127.0.0.1");
  const toolMatch = url.pathname.match(/^\/tools\/([a-z0-9-]+)$/);
  if (toolMatch) {
    if (toolMatch[1] === "inbox") {
      const sectionLabel = INBOX_SECTION_LABELS[url.searchParams.get("section")];
      return sectionLabel ? `秘书收件箱 · ${sectionLabel}` : "秘书收件箱";
    }
    return TOOL_LABELS[toolMatch[1]] || "实用工具";
  }
  const root = ROOT_LABELS[url.pathname] || "具体页面";
  const project = url.searchParams.get("project");
  if (url.pathname === "/projects" && project) {
    const projectName = cleanText(options.projectNames?.[project], 34);
    return projectName || "事业项目";
  }
  if (url.pathname === "/schedule") return `日程 · ${SCHEDULE_LABELS[url.searchParams.get("view")] || "具体分栏"}`;
  if (url.pathname === "/health") return `健康 · ${HEALTH_LABELS[url.searchParams.get("band")] || "具体分栏"}`;
  if (url.pathname === "/languages") return `日语 · ${LANGUAGE_LABELS[url.searchParams.get("section")] || "具体分栏"}`;
  if (url.pathname === "/markets/assets") return `资产 · ${ASSET_LABELS[url.searchParams.get("tab")] || "具体分栏"}`;
  if (url.pathname === "/topics") {
    const domain = TOPIC_DOMAIN_LABELS[url.searchParams.get("domain")] || (url.searchParams.get("tab") === "archive" ? "课程资料" : "知识节点");
    return `专题 · ${domain}`;
  }
  if (url.pathname === "/library") {
    const detail = LIBRARY_KIND_LABELS[url.searchParams.get("kind")] || LIBRARY_VIEW_LABELS[url.searchParams.get("view")] || "具体馆藏";
    return `馆藏 · ${detail}`;
  }
  if (url.pathname === "/markets") {
    const lane = url.searchParams.get("lane");
    if (lane === "ai") return "世界资讯 · AI";
    if (lane === "games") return "世界资讯 · 游戏";
    if (lane === "japan") return "世界资讯 · 日本";
    if (lane === "finance") return "世界资讯 · 金融";
    return url.searchParams.get("topic") ? "世界资讯 · 当前专题" : "世界资讯 · 日本";
  }
  return root;
}

export function normalizeSidebarBookmark(value, options = {}) {
  const location = normalizeSidebarBookmarkLocation(value?.location);
  if (!location || !isSidebarBookmarkableLocation(location)) return null;
  const label = cleanText(value?.label, MAX_LABEL_LENGTH) || defaultSidebarBookmarkLabel(location, options);
  return { location, label };
}

export function normalizeSidebarBookmarks(value, options = {}) {
  const rows = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : [];
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const bookmark = normalizeSidebarBookmark(row, options);
    if (!bookmark || seen.has(bookmark.location)) continue;
    seen.add(bookmark.location);
    items.push(bookmark);
    if (items.length >= MAX_SIDEBAR_BOOKMARKS) break;
  }
  return { version: SIDEBAR_BOOKMARKS_VERSION, items };
}

/**
 * 展示模式保留书签的位置感，只阻止进入真正私密的目标。
 * 返回 false 时前端应显示但禁用该书签，不应将它从列表移除。
 */
export function isSidebarBookmarkNavigableInDisplayMode(bookmark) {
  const normalized = normalizeSidebarBookmark(bookmark);
  if (!normalized) return false;
  if (normalized.label !== defaultSidebarBookmarkLabel(normalized.location)) return false;
  const url = new URL(normalized.location, "http://127.0.0.1");
  if (url.pathname === "/library" && url.searchParams.get("kind") === "writing") return false;
  const toolId = url.pathname.match(/^\/tools\/([a-z0-9-]+)$/)?.[1] || "";
  return !DISPLAY_MODE_BLOCKED_TOOLS.has(toolId);
}

export function sidebarBookmarkRoutePath(input) {
  const location = normalizeSidebarBookmarkLocation(input);
  if (!location) return "/";
  const pathname = new URL(location, "http://127.0.0.1").pathname;
  return pathname.startsWith("/tools/") ? "/tools" : pathname;
}
