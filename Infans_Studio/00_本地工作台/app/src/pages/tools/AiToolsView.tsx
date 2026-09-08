import { useEffect, useMemo, useState } from "react";
import { Bookmark, ChevronDown, CircleHelp, ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { Empty, jsonFetch } from "../../page-shared";
import { createToolSessionCache } from "../../tool-session-cache";
import "./ai-tools.css";

type Category = "all" | "model" | "art" | "video" | "audio" | "coding" | "research" | "3d-game" | "document" | "asset" | "network" | "interesting" | "course" | "game-career" | "niche-content" | "other";
type ToolStatus = "recently-used" | "used-before" | "recently-discovered" | "to-try";

type AiTool = {
  id: string;
  name: string;
  url: string;
  kind: "web" | "software";
  category: Exclude<Category, "all">;
  summary: string;
  logoText: string;
  logoPath: string;
  origin: "bookmark" | "recommendation";
  browserSources: Array<"safari" | "chrome">;
  discoveryStatus: "baseline" | "recent";
  releaseStatus: "established" | "new";
  status: ToolStatus;
  usage: null | {
    everUsed: true;
    firstUsedAt: string;
    lastUsedAt: string;
    useCount: number;
    note: string | null;
  };
};

type AiToolsSnapshot = {
  updatedAt: string | null;
  recentUseDays: number;
  scan: null | { marketCheckedAt?: string; browserImportedAt?: string };
  quarterlyReport: null | {
    period: string;
    generatedAt: string | null;
    title: string;
    summary: string;
    highlights: string[];
  };
  tools: AiTool[];
};

type AiToolsCollection = "tools" | "bookmarks";
const aiToolsEndpoint = (collection: AiToolsCollection) => collection === "bookmarks" ? "/api/tools/web-bookmarks" : "/api/tools/ai-tools";
const aiToolsCache = createToolSessionCache<AiToolsCollection, AiToolsSnapshot>((collection) => jsonFetch<AiToolsSnapshot>(aiToolsEndpoint(collection)));

const TOOL_CATEGORIES: Array<{ id: Category; label: string }> = [
  { id: "all", label: "全部" },
  { id: "model", label: "模型对话" },
  { id: "art", label: "AI 美术" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
  { id: "coding", label: "编程" },
  { id: "research", label: "研究" },
  { id: "3d-game", label: "3D / 游戏" },
  { id: "document", label: "文档演示" },
  { id: "asset", label: "素材资源" },
  { id: "network", label: "网络工具" },
];

const BOOKMARK_CATEGORIES: Array<{ id: Category; label: string }> = [
  { id: "all", label: "全部" },
  { id: "interesting", label: "有趣学习" },
  { id: "course", label: "公开课" },
  { id: "game-career", label: "游戏事业" },
  { id: "niche-content", label: "小众内容" },
];

const TOOL_SECTIONS: Array<{ id: ToolStatus; title: string; note: string }> = [
  { id: "recently-used", title: "最近在用", note: "最近 30 天有真实使用记录" },
  { id: "used-before", title: "以前用过", note: "用过就是用过，永久保留" },
  { id: "recently-discovered", title: "最近发现", note: "新挖到，尚未体验，不会自动下沉" },
  { id: "to-try", title: "待体验", note: "市场常用或浏览器收藏，尚无使用证据" },
];

const BOOKMARK_SECTIONS: Array<{ id: ToolStatus; title: string; note: string }> = [
  { id: "recently-used", title: "最近在用", note: "最近 30 天从这里打开过" },
  { id: "used-before", title: "以前用过", note: "用过就是用过，永久保留" },
  { id: "to-try", title: "收藏入口", note: "已经收藏，尚无使用记录" },
];

function shortDate(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function sourceLabel(tool: AiTool) {
  if (tool.browserSources.length) return tool.browserSources.map((source) => source === "safari" ? "Safari" : "Chrome").join(" + ");
  if (tool.origin === "bookmark") return "手动收藏";
  return "AI 推荐";
}

function AiToolCard({ tool, onOpen }: { tool: AiTool; onOpen: (tool: AiTool) => void }) {
  const isUsed = Boolean(tool.usage?.everUsed);
  return (
    <button type="button" className={`ai-tool-card is-${tool.category}`} onClick={() => onOpen(tool)} aria-label={`打开 ${tool.name}`}>
      <span className="ai-tool-card-top">
        <span className="ai-tool-mark" aria-hidden="true">
          <span className="ai-tool-mark-fallback">{tool.logoText}</span>
          <img
            src={tool.logoPath}
            alt=""
            width={128}
            height={128}
            loading="lazy"
            decoding="async"
            onError={(event) => { event.currentTarget.hidden = true; }}
          />
        </span>
        <span className="ai-tool-source" title={sourceLabel(tool)} aria-label={sourceLabel(tool)}>
          {tool.origin === "bookmark" ? <Bookmark size={14} /> : (!isUsed ? <CircleHelp size={15} /> : null)}
        </span>
      </span>
      <span className="ai-tool-name-row">
        <strong>{tool.name}</strong>
        <ExternalLink size={13} aria-hidden="true" />
      </span>
      <span className="ai-tool-summary">{tool.summary}</span>
      <span className="ai-tool-meta">
        {tool.status === "recently-discovered" ? (
          <em>{tool.releaseStatus === "new" ? "新推出" : "新发现"}</em>
        ) : tool.usage?.lastUsedAt ? (
          <span>上次使用 · {shortDate(tool.usage.lastUsedAt)}</span>
        ) : (
          <span>{tool.kind === "software" ? "软件" : "网站"} · {sourceLabel(tool)}</span>
        )}
      </span>
      {tool.usage?.note ? <span className="ai-tool-note">{tool.usage.note}</span> : null}
    </button>
  );
}

export default function AiToolsView({ active, collection = "tools" }: { active: boolean; collection?: AiToolsCollection }) {
  const [data, setData] = useState<AiToolsSnapshot | null>(() => aiToolsCache.get(collection));
  const [category, setCategory] = useState<Category>("all");
  const [loading, setLoading] = useState(() => !aiToolsCache.get(collection));
  const [error, setError] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const isBookmarks = collection === "bookmarks";
  const categories = isBookmarks ? BOOKMARK_CATEGORIES : TOOL_CATEGORIES;
  const sections = isBookmarks ? BOOKMARK_SECTIONS : TOOL_SECTIONS;
  const endpoint = aiToolsEndpoint(collection);

  const load = async (force = false) => {
    setLoading(true);
    setError("");
    try {
      setData(await aiToolsCache.load(collection, { force }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `读不到${isBookmarks ? "网页收藏" : "工具与素材收藏"}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setCategory("all");
    const cached = aiToolsCache.get(collection);
    setData(cached);
    setLoading(!cached);
    if (active) void load();
  }, [active, collection]);

  const visible = useMemo(() => data?.tools.filter((tool) => category === "all" || tool.category === category) || [], [category, data]);

  const openTool = (tool: AiTool) => {
    window.open(tool.url, "_blank", "noopener,noreferrer");
    void jsonFetch<AiToolsSnapshot>(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: tool.id }),
    }).then((next) => { aiToolsCache.set(collection, next); setData(next); }).catch(() => undefined);
  };

  if (loading && !data) return <Empty>正在整理{isBookmarks ? "网页收藏" : "工具与素材收藏"}卡片。</Empty>;

  return (
    <div className="ai-tools-view">
      {!isBookmarks && data?.quarterlyReport ? (
        <section className="ai-tools-report" aria-label="最新 AI 工具季度报告">
          <div className="ai-tools-report-symbol" aria-hidden="true"><Sparkles size={22} /></div>
          <div className="ai-tools-report-copy">
            <span>{data.quarterlyReport.period} · 工具季度动态</span>
            <strong>{data.quarterlyReport.title}</strong>
            <p>{data.quarterlyReport.summary}</p>
            {reportOpen && data.quarterlyReport.highlights.length ? (
              <ul>{data.quarterlyReport.highlights.map((item) => <li key={item}>{item}</li>)}</ul>
            ) : null}
          </div>
          {data.quarterlyReport.highlights.length ? (
            <button type="button" onClick={() => setReportOpen((value) => !value)} aria-expanded={reportOpen}>
              {reportOpen ? "收起" : "查收"}<ChevronDown size={14} className={reportOpen ? "is-open" : ""} />
            </button>
          ) : null}
        </section>
      ) : null}

      <header className="ai-tools-intro">
        <div>
          <span>{isBookmarks ? "个人网页收藏" : "个人工具池"}</span>
          <p>{data ? `${data.tools.length} 个入口 · 使用记录会自动置顶` : `${isBookmarks ? "网页收藏" : "工具与素材收藏"}入口`}</p>
        </div>
        <button type="button" onClick={() => void load(true)} disabled={loading} aria-label={`刷新${isBookmarks ? "网页收藏" : "工具与素材收藏"}`}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          刷新
        </button>
      </header>

      <nav className="ai-tools-categories" aria-label={`${isBookmarks ? "网页收藏" : "工具与素材收藏"}分类`}>
        {categories.map((item) => {
          const count = data?.tools.filter((tool) => item.id === "all" || tool.category === item.id).length || 0;
          return (
            <button type="button" key={item.id} className={category === item.id ? "is-active" : ""} onClick={() => setCategory(item.id)}>
              {item.label}<small>{count}</small>
            </button>
          );
        })}
      </nav>

      {error ? <div className="ai-tools-error">{error}</div> : null}

      <div className="ai-tools-sections">
        {sections.map((section) => {
          const tools = visible.filter((tool) => tool.status === section.id);
          if (!tools.length) return null;
          return (
            <section className="ai-tools-section" key={section.id}>
              <header>
                <div><h2>{section.title}</h2><span>{tools.length}</span></div>
                <p>{section.note}</p>
              </header>
              <div className="ai-tools-grid">
                {tools.map((tool) => <AiToolCard key={tool.id} tool={tool} onOpen={openTool} />)}
              </div>
            </section>
          );
        })}
      </div>
      {!visible.length && !loading ? <Empty>这个分类暂时没有{isBookmarks ? "网页收藏" : "工具"}。</Empty> : null}
    </div>
  );
}
