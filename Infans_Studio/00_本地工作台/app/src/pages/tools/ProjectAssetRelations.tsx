import { useEffect, useId, useState } from "react";
import { ArrowUpRight, Link2, LoaderCircle, X } from "lucide-react";
import { jsonFetch } from "../../page-shared";
import "./project-asset-relations.css";

export type AssetObjectLink = {
  objectId: string; label: string; type?: string; role: string;
  relation: "intended" | "referenced" | "registered" | "source";
  sources: Array<{ path: string; line?: number; pointer?: string }>;
};
type RelatedItem = {
  id: string; kind: "art" | "font" | "text" | "audio" | "video"; name: string; zone: string;
  path?: string; purpose?: string; values?: Record<string, string>; links: AssetObjectLink[];
  fileAvailable?: boolean; previewUrl?: string; originalUrl?: string;
  annotation?: { note: string; needsAttention: boolean };
};
type RelatedResult = { object: { id: string; label: string }; items: RelatedItem[]; total: number; offset: number; hasMore: boolean };
const RELATIONS = { intended: "准备用于", referenced: "实际引用", registered: "已登记", source: "来源对象" };
const KINDS = { art: "美术", font: "字体", text: "文本", audio: "音频", video: "视频" };
const ZONES: Record<string, string> = { formal: "正式素材", candidate: "AI 候选素材", archive: "归档素材", platform: "平台交付", unknown: "状态待核对" };

function RelatedCard({ projectId, item }: { projectId: string; item: RelatedItem }) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const fileUrl = `/api/tools/project-assets/file?${new URLSearchParams({ project: projectId, id: item.id })}`;
  return <article className="project-related-card">
    <header><strong>{item.name}</strong><small>{KINDS[item.kind]} · {ZONES[item.zone] || ZONES.unknown}</small></header>
    {item.kind === "art" && item.previewUrl && !failed ? <img loading="lazy" src={item.previewUrl} alt={item.name} onError={() => setFailed(true)} /> : null}
    {item.kind === "text" ? <dl className="project-related-values">{Object.entries(item.values || {}).map(([locale, value]) => <div key={locale}><dt>{locale}</dt><dd>{value || "尚未填写"}</dd></div>)}</dl> : null}
    {item.kind === "font" && item.fileAvailable ? <a href={fileUrl} download>下载字体文件 <ArrowUpRight size={14} /></a> : null}
    {item.kind === "audio" && item.fileAvailable && !failed ? <audio controls preload="metadata" src={fileUrl} onError={() => setFailed(true)} /> : null}
    {item.kind === "video" && item.fileAvailable && !failed ? playing ? <video controls playsInline preload="metadata" src={fileUrl} onError={() => setFailed(true)} /> : <button type="button" onClick={() => setPlaying(true)}>播放视频</button> : null}
    {failed ? <p role="status">预览暂不可用。</p> : item.fileAvailable === false ? <p>原文件未在当前目录中找到。</p> : null}
    {item.annotation?.note || item.purpose ? <p>{item.annotation?.note || item.purpose}</p> : null}
    <div className="project-related-roles">{[...new Set(item.links.map((link) => `${RELATIONS[link.relation]}${link.role ? ` · ${link.role}` : ""}`))].map((label) => <span key={label}>{label}</span>)}</div>
    <details><summary>查看来源依据</summary>{item.path ? <code>{item.path}</code> : null}{[...new Set(item.links.flatMap((link) => link.sources.map((source) => `${source.path}${source.line ? `:${source.line}` : ""}${source.pointer ? ` ${source.pointer}` : ""}`)))].map((source) => <code key={source}>{source}</code>)}</details>
  </article>;
}

export default function ProjectAssetRelations({ projectId, links, itemId, assetPath, displayMode = false }: {
  projectId: string; links?: AssetObjectLink[]; itemId?: string; assetPath?: string; displayMode?: boolean;
}) {
  const panelId = useId();
  const hasInlineLinks = links !== undefined;
  const [loaded, setLoaded] = useState<AssetObjectLink[]>([]);
  const [linksError, setLinksError] = useState("");
  const [selected, setSelected] = useState<AssetObjectLink | null>(null);
  const [data, setData] = useState<RelatedResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setSelected(null); setData(null); setOffset(0); setLoaded([]); setLinksError("");
    if (hasInlineLinks || (!itemId && !assetPath)) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ project: projectId });
    if (itemId) params.set("id", itemId);
    else if (assetPath) params.set("path", assetPath);
    if (displayMode) params.set("display", "1");
    void jsonFetch<{ links: AssetObjectLink[] }>(`/api/tools/project-assets/links?${params}`, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setLoaded(result.links);
    }).catch((cause) => { if (!controller.signal.aborted) setLinksError(cause instanceof Error ? cause.message : "关联暂时无法读取"); });
    return () => controller.abort();
  }, [projectId, itemId, assetPath, displayMode, hasInlineLinks]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setPending(true); setError("");
    const params = new URLSearchParams({ project: projectId, object: selected.objectId, offset: String(offset), limit: "12" });
    if (displayMode) params.set("display", "1");
    void jsonFetch<RelatedResult>(`/api/tools/project-assets/related?${params}`, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setData((previous) => offset > 0 && previous?.object.id === result.object.id ? { ...result, items: [...previous.items, ...result.items] } : result);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "关联素材暂时无法读取"); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [projectId, selected, offset, revision, displayMode]);
  const availableLinks = links ?? loaded;
  useEffect(() => {
    if (selected && !availableLinks.some((link) => link.objectId === selected.objectId)) {
      setSelected(null); setData(null); setOffset(0);
    }
  }, [availableLinks, selected]);
  if (!availableLinks.length) return linksError ? <p className="project-relations-error" role="status">{linksError}</p> : null;
  const objects = [...new Map(availableLinks.map((link) => [link.objectId, link])).values()];
  return <section className="project-asset-relations" aria-label="关联对象">
    <div className="project-object-links"><span><Link2 size={14} />关联对象</span>{objects.map((link) => <button type="button" key={link.objectId} aria-expanded={selected?.objectId === link.objectId} aria-controls={panelId} title={availableLinks.filter((row) => row.objectId === link.objectId).map((row) => `${RELATIONS[row.relation]}${row.role ? ` · ${row.role}` : ""}`).join("；")} onClick={() => {
      setSelected(selected?.objectId === link.objectId ? null : link); setData(null); setOffset(0);
    }}>{link.label}<small>{[...new Set(availableLinks.filter((row) => row.objectId === link.objectId).map((row) => RELATIONS[row.relation]))].join(" · ")}</small></button>)}</div>
    {selected ? <div id={panelId} className="project-related-panel" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setSelected(null); } }}>
      <header><div><strong>{selected.label}</strong><small>关联素材{data ? ` · ${data.total}` : ""} · 全部类型与状态</small></div><button type="button" aria-label="收起关联素材" onClick={() => setSelected(null)}><X size={17} /></button></header>
      {data ? <div className="project-related-items">{data.items.map((item) => <RelatedCard key={`${item.kind}:${item.id}`} projectId={projectId} item={item} />)}</div> : null}
      {error ? <p role="alert">{error}<button type="button" onClick={() => setRevision((value) => value + 1)}>重试</button></p> : null}
      {pending ? <p role="status"><LoaderCircle size={15} className="is-spinning" />正在读取关联素材…</p> : !error && data?.hasMore ? <button type="button" className="project-related-more" onClick={() => setOffset(data.items.length)}>继续查看</button> : null}
    </div> : null}
  </section>;
}
