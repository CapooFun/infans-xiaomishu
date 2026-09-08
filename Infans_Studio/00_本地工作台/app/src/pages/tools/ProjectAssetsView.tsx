import { AttentionMark } from '../../components/AttentionMark';
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, FileText, Film, Folder, FolderOpen, LoaderCircle, Music2, PenLine, RefreshCw, Save, Search, Type, X } from "lucide-react";
import { fmtBytes, fmtDateTime } from "../../page-shared";
import ProjectAssetRelations, { type AssetObjectLink } from "./ProjectAssetRelations";
import "./project-assets.css";

export type ProjectAssetKind = "font" | "text" | "audio" | "video";
type AssetZone = "formal" | "candidate" | "archive" | "unknown";
type AssetDirectory = { path: string; label: string; count: number; children: AssetDirectory[] };
type DirectorySelection = { path: string; label: string; legacy: boolean };
type Annotation = { note: string; needsAttention: boolean; revision: string | null };
type Source = { path: string; line?: number; pointer?: string };
type AssetItem = {
  id: string; kind: ProjectAssetKind; name: string; category: string; purpose?: string;
  zone?: AssetZone; path?: string; categoryPath?: string[]; links?: AssetObjectLink[];
  sources?: Source[]; references?: Source[]; metadata?: Record<string, unknown>;
  license?: { label?: string; path?: string }; key?: string; values?: Record<string, string>;
  bytes?: number; format?: string; mimeType?: string; fileAvailable?: boolean; annotation: Annotation;
};
type Locale = { id: string; label: string };
type AssetSnapshot = {
  available: boolean; project?: { id: string; name: string }; generatedAt?: string;
  coverage: string[]; locales: Locale[]; counts: Record<ProjectAssetKind, number>;
  categories: { name: string; count: number }[]; items: AssetItem[];
  directories?: AssetDirectory[]; zoneCounts?: Record<AssetZone, number>;
  total: number; offset: number; hasMore: boolean; message?: string;
};
type Draft = {
  editing: boolean; note: string; expectedRevision: string | null;
  saving: boolean; error?: string; conflict?: boolean; latest?: Annotation; attentionTarget?: boolean;
};
type UpdateDraft = (key: string, update: (current: Draft | undefined) => Draft | undefined) => void;
type Props = { projectId: string; kind: ProjectAssetKind; refreshKey?: string | number; displayMode?: boolean; active?: boolean };
const PAGE_SIZE = 60;
const KIND_META = {
  font: { name: "字体", icon: Type, hint: "加载项目字体，直接对照试写。" },
  text: { name: "文本与本地化", icon: FileText, hint: "同一条文本，按现行语言并排查看。" },
  audio: { name: "音频", icon: Music2, hint: "按需试听，查看用途与来源。" },
  video: { name: "视频", icon: Film, hint: "按需预览，查看用途与来源。" },
};
const ZONE_NAMES = { formal: "正式素材", candidate: "AI 候选素材", archive: "归档素材", unknown: "待确认" };
const ASSET_ZONES: AssetZone[] = ["formal", "candidate", "archive", "unknown"];
const EMPTY_LINKS: AssetObjectLink[] = [];
const DIRECTORY_BATCH = 12;

function DirectoryList({ directories, selected, legacy, onSelect }: {
  directories: AssetDirectory[]; selected: string; legacy: boolean; onSelect: (selection: DirectorySelection) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(DIRECTORY_BATCH);
  // A selected branch stays reachable after a refreshed directory list changes its order.
  const selectedIndex = directories.findIndex((entry) => selected === entry.path || (!legacy && selected.startsWith(`${entry.path}/`)));
  const visible = directories.slice(0, visibleCount);
  if (selectedIndex >= visibleCount) visible.push(directories[selectedIndex]);
  const remaining = directories.length - visible.length;
  return <ul className="project-assets-directory-list">
    {visible.map((entry) => <DirectoryEntry key={entry.path} entry={entry} selected={selected} legacy={legacy} onSelect={onSelect} />)}
    {remaining > 0 ? <li><button className="project-assets-directory-more" type="button" onClick={() => setVisibleCount((count) => count + DIRECTORY_BATCH)}>显示更多目录<span>余 {remaining}</span></button></li> : null}
  </ul>;
}

function DirectoryEntry({ entry, selected, legacy, onSelect }: {
  entry: AssetDirectory; selected: string; legacy: boolean; onSelect: (selection: DirectorySelection) => void;
}) {
  const childrenId = useId();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const inside = !legacy && selected.startsWith(`${entry.path}/`);
  const open = expanded ?? inside;
  const hasChildren = Boolean(entry.children?.length);
  return <li>
    <div className={`project-assets-directory-row${selected === entry.path ? " is-selected" : inside ? " is-ancestor" : ""}`}>
      {hasChildren ? <button className="project-assets-directory-expand" type="button" aria-label={`${open ? "收起" : "展开"}${entry.label}`} aria-expanded={open} aria-controls={childrenId} onClick={() => setExpanded(!open)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="project-assets-directory-leaf" />}
      <button className="project-assets-directory-select" type="button" aria-current={selected === entry.path ? "page" : undefined} title={`${entry.path} · ${entry.count} 项`} onClick={() => { onSelect({ path: entry.path, label: entry.label, legacy }); if (hasChildren) setExpanded(true); }}>
        {open || selected === entry.path ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{entry.label}</span><small>{entry.count}</small>
      </button>
    </div>
    {hasChildren && open ? <div className="project-assets-directory-children" id={childrenId}><DirectoryList directories={entry.children} selected={selected} legacy={legacy} onSelect={onSelect} /></div> : null}
  </li>;
}

function draftKey(projectId: string, id: string) { return JSON.stringify([projectId, id]); }
function fileUrl(projectId: string, id: string, displayMode: boolean) {
  const params = new URLSearchParams({ project: projectId, id });
  if (displayMode) params.set("display", "1");
  return `/api/tools/project-assets/file?${params}`;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "读取失败，请重试。"; }
function metadataText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}
function durationText(value: unknown) {
  const seconds = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 10) return `${Number(seconds.toFixed(2))} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
function newDraft(annotation: Annotation, editing = true): Draft {
  return { editing, note: annotation.note, expectedRevision: annotation.revision, saving: false };
}

const Sources = memo(function Sources({ item }: { item: AssetItem }) {
  const sources = item.sources || [];
  const references = item.references || [];
  return <details className="project-asset-sources">
    <summary>来源与引用{references.length ? ` · ${references.length} 处引用` : ""}</summary>
    <dl>
      {item.purpose ? <div><dt>来源用途</dt><dd>{item.purpose}</dd></div> : null}
      {item.path ? <div><dt>素材文件</dt><dd><code>{item.path}</code></dd></div> : null}
      {item.key ? <div><dt>文本键</dt><dd><code>{item.key}</code></dd></div> : null}
      {sources.length ? <div><dt>来源</dt><dd>{sources.map((source, index) => <code key={`${source.path}:${index}`}>{source.path}{source.line ? `:${source.line}` : ""}{source.pointer ? ` · ${source.pointer}` : ""}</code>)}</dd></div> : null}
      {references.length ? <div><dt>引用位置</dt><dd>{references.map((source, index) => <code key={`${source.path}:${index}`}>{source.path}{source.line ? `:${source.line}` : ""}</code>)}</dd></div> : null}
      {item.license?.path ? <div><dt>授权文件</dt><dd><code>{item.license.path}</code></dd></div> : null}
      {!item.path && !sources.length && !references.length ? <div><dd>目录尚未提供来源位置。</dd></div> : null}
    </dl>
  </details>;
});

function FontPreview({ item, projectId, displayMode, sample }: { item: AssetItem; projectId: string; displayMode: boolean; sample: string }) {
  const element = useRef<HTMLDivElement>(null);
  const fontId = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const family = `infans-project-font-${fontId}`;
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"waiting" | "loading" | "ready" | "error">("waiting");
  const metadata = item.metadata || {};
  const weight = metadataText(metadata.weight);
  const style = metadataText(metadata.style);
  useEffect(() => {
    if (!element.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || item.fileAvailable === false) return;
    let active = true;
    let face: FontFace | undefined;
    setState("loading");
    try {
      if (typeof FontFace === "undefined" || !document.fonts) throw new Error("unsupported");
      const descriptors: FontFaceDescriptors = {};
      if (/^(?:[1-9]\d{0,2}|1000)(?:\s+(?:[1-9]\d{0,2}|1000))?$|^(normal|bold)$/.test(weight)) descriptors.weight = weight;
      if (/^(normal|italic|oblique)$/.test(style)) descriptors.style = style;
      face = new FontFace(family, `url(${JSON.stringify(fileUrl(projectId, item.id, displayMode))})`, descriptors);
      void face.load().then((loaded) => {
        if (!active) return;
        document.fonts.add(loaded);
        setState("ready");
      }).catch(() => { if (active) setState("error"); });
    } catch { setState("error"); }
    return () => { active = false; if (face && document.fonts) document.fonts.delete(face); };
  }, [attempt, displayMode, family, item.fileAvailable, item.id, projectId, style, visible, weight]);
  return <div className="project-asset-font" ref={element}>
    {item.fileAvailable === false ? <div className="project-asset-preview-state is-error" role="status"><AlertTriangle size={18} /><span>字体文件缺失或不可读取，暂时无法试写。可展开来源核对。</span></div> : state === "ready" ? <p className="project-asset-font-sample" style={{ fontFamily: JSON.stringify(family), fontSynthesis: "none" }}>{sample || "山间有清风，心中有天地。\nA journey begins · 0123456789"}</p> :
      <div className={`project-asset-preview-state${state === "error" ? " is-error" : ""}`} role="status">
        {state === "error" ? <><AlertTriangle size={18} /><span>此字体未能加载，暂时无法试写。文件可能缺失，或格式不被当前浏览器支持。</span><button type="button" onClick={() => setAttempt((value) => value + 1)}>重试加载</button></> : <><LoaderCircle className="project-asset-spinner" size={18} /><span>{state === "waiting" ? "滚动至此处加载字体" : "正在加载真实字体…"}</span></>}
      </div>}
    <dl className="project-asset-metadata">
      <div><dt>字体家族</dt><dd>{metadataText(metadata.family) || "未登记"}</dd></div>
      <div><dt>字重</dt><dd>{weight || "未登记"}</dd></div>
      <div><dt>授权</dt><dd>{item.license?.label || (item.license?.path ? "已登记授权文件" : "未登记授权说明")}</dd></div>
    </dl>
    {state === "ready" && item.fileAvailable !== false ? <small className="project-asset-footnote">已加载项目文件；字体不含的字符可能使用系统回退字形。</small> : null}
  </div>;
}

const TextPreview = memo(function TextPreview({ item, locales }: { item: AssetItem; locales: Locale[] }) {
  const registered = new Set(locales.map((locale) => locale.id));
  const extraLocales = Object.keys(item.values || {}).filter((id) => !registered.has(id));
  const columns = [...locales, ...extraLocales.map((id) => ({ id, label: id }))];
  if (!columns.length) return <p className="project-asset-footnote">这条文本尚未提供语言内容。</p>;
  return <div className="project-asset-translations" role="group" aria-label={`${item.name}的语言对照`}>
    {columns.map((locale) => {
      const value = item.values?.[locale.id];
      const present = typeof value === "string" && Boolean(value.trim());
      return <section className={`project-asset-translation${present ? "" : " is-missing"}`} key={locale.id}>
        <header><strong>{locale.label}</strong><span>{locale.id}{!registered.has(locale.id) ? " · 未列入现行语言" : ""}</span>{!present && registered.has(locale.id) ? <em>缺失</em> : null}</header>
        <p lang={locale.id} dir="auto">{present ? value : "尚无内容"}</p>
      </section>;
    })}
  </div>;
});

function MediaPreview({ item, projectId, displayMode }: { item: AssetItem; projectId: string; displayMode: boolean }) {
  const [opened, setOpened] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [runtimeMetadata, setRuntimeMetadata] = useState<{ duration?: number; width?: number; height?: number }>({});
  const metadata = item.metadata || {};
  const duration = durationText(runtimeMetadata.duration ?? metadata.duration);
  const width = runtimeMetadata.width || Number(metadata.width);
  const height = runtimeMetadata.height || Number(metadata.height);
  const showPlayer = item.kind === "audio" || opened;
  const url = fileUrl(projectId, item.id, displayMode);
  const onMetadata = (media: HTMLMediaElement) => {
    setRuntimeMetadata({ duration: Number.isFinite(media.duration) ? media.duration : undefined,
      ...(media instanceof HTMLVideoElement ? { width: media.videoWidth, height: media.videoHeight } : {}) });
  };
  return <div className={`project-asset-media is-${item.kind}`}>
    {item.fileAvailable === false ? <div className="project-asset-preview-state is-error" role="status"><AlertTriangle size={18} /><span>素材文件缺失或不可读取，暂时无法预览。可展开来源核对。</span></div> : showPlayer ? <>
      {item.kind === "video" ? <video key={attempt} controls playsInline preload="metadata" src={url} aria-label={item.name} onLoadedMetadata={(event) => onMetadata(event.currentTarget)} onError={() => setFailed(true)} /> :
        <audio key={attempt} controls preload="metadata" src={url} aria-label={item.name} onLoadedMetadata={(event) => onMetadata(event.currentTarget)} onError={() => setFailed(true)} />}
      {failed ? <div className="project-asset-preview-state is-error" role="alert"><AlertTriangle size={18} /><span>当前浏览器无法播放此文件，可能是编码不兼容、文件缺失或读取失败。</span><button type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>重新加载</button></div> : null}
      {item.kind === "video" ? <button className="project-asset-close-preview" type="button" onClick={() => { setOpened(false); setFailed(false); }}><X size={14} />收起播放器</button> : null}
    </> : <button className="project-asset-media-open" type="button" onClick={() => setOpened(true)}><Film size={24} /><span>打开视频预览</span><small>点击后加载</small></button>}
    <div className="project-asset-media-meta">
      {duration ? <span>时长 {duration}</span> : <span>时长未登记{showPlayer ? "" : " · 打开后读取"}</span>}
      {Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? <span>{width} × {height}</span> : null}
      {metadataText(metadata.codec) ? <span>{metadataText(metadata.codec)}</span> : null}
      {metadataText(metadata.sampleRate) ? <span>{metadataText(metadata.sampleRate)} Hz</span> : null}
      {metadataText(metadata.channels) ? <span>{metadataText(metadata.channels)} 声道</span> : null}
    </div>
  </div>;
}

function AnnotationEditor({ item, projectId, readOnly, draft, updateDraft, onSaved, onReload }: {
  item: AssetItem; projectId: string; readOnly: boolean; draft?: Draft; updateDraft: UpdateDraft;
  onSaved: (id: string, annotation: Annotation) => void; onReload: () => void;
}) {
  const key = draftKey(projectId, item.id);
  const inputId = useId();
  const annotation = item.annotation;
  const saving = Boolean(draft?.saving);
  const update = (next: (current: Draft | undefined) => Draft | undefined) => updateDraft(key, next);
  const latest = draft?.latest || (draft?.conflict && annotation.revision !== draft.expectedRevision ? annotation : undefined);
  const save = async (patch: { note?: string; needsAttention?: boolean }, expectedRevision: string | null) => {
    if (saving || readOnly) return;
    update((current) => ({ ...(current || newDraft(annotation, false)), saving: true, error: undefined, conflict: false, latest: undefined, attentionTarget: patch.needsAttention ?? current?.attentionTarget }));
    try {
      const response = await fetch("/api/tools/project-assets/annotation", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, itemId: item.id, expectedRevision, ...patch }),
      });
      const result = await response.json() as { annotation?: Annotation; message?: string; error?: string };
      if (!response.ok) {
        update((current) => ({ ...(current || newDraft(annotation, patch.note !== undefined)), saving: false,
          error: response.status === 409 ? "这条素材已在别处更新，草稿已保留。" : result.message || result.error || `保存失败（${response.status}），请重试。`,
          conflict: response.status === 409, latest: response.status === 409 ? result.annotation : undefined }));
        return;
      }
      if (!result.annotation || typeof result.annotation.revision !== "string") throw new Error("保存结果不完整，请重读后核对；草稿已保留。");
      onSaved(item.id, result.annotation);
      const saved = result.annotation;
      update((current) => patch.note !== undefined || !current?.editing ? undefined : { ...current, saving: false, expectedRevision: current.expectedRevision === expectedRevision ? saved.revision : current.expectedRevision, error: undefined, conflict: false, latest: undefined });
    } catch (error) {
      update((current) => ({ ...(current || newDraft(annotation, patch.note !== undefined)), saving: false, error: errorMessage(error) }));
    }
  };
  return <div className="project-asset-annotation">
    <div className="project-asset-note-row">
      <button type="button" className="project-asset-attention" aria-label={`${annotation.needsAttention ? "取消标记" : "标记待处理"}：${item.name}`} aria-pressed={annotation.needsAttention} title={readOnly ? "展示模式只读" : annotation.needsAttention ? "取消标记" : "标记待处理"} disabled={saving || readOnly || Boolean(draft?.conflict)} onClick={() => void save({ needsAttention: !annotation.needsAttention }, annotation.revision)}>
        {saving ? <LoaderCircle className="project-asset-spinner" size={19} /> : <AttentionMark marked={annotation.needsAttention} />}
      </button>
      {draft?.editing ? <label htmlFor={inputId}>一句说明</label> : readOnly ? <p>{annotation.note || item.purpose || <span className="project-asset-note-placeholder">尚无说明</span>}</p> : <button className="project-asset-note-trigger" type="button" aria-label={`编辑说明：${item.name}`} disabled={saving} onClick={() => update((current) => current ? { ...current, editing: true } : newDraft(annotation))}><span className={annotation.note || item.purpose ? undefined : "project-asset-note-placeholder"}>{annotation.note || item.purpose || "添加说明"}</span><PenLine size={16} /></button>}
    </div>
    {draft?.editing ? <form className="project-asset-note-form" onSubmit={(event) => { event.preventDefault(); void save({ note: draft.note.trim() }, draft.expectedRevision); }}>
      {annotation.note && item.purpose && annotation.note !== item.purpose ? <p className="project-asset-footnote">来源用途：{item.purpose}</p> : null}
      <textarea id={inputId} value={draft.note} maxLength={1200} rows={2} placeholder="记下用途、想法或需要调整的地方" disabled={saving || readOnly} onChange={(event) => { const note = event.currentTarget.value; update((current) => current ? { ...current, note } : current); }} />
      <footer><button type="button" disabled={saving} onClick={() => update(() => undefined)}>取消</button><button className="is-primary" type="submit" disabled={saving || readOnly || Boolean(draft.conflict)}>{saving ? <LoaderCircle className="project-asset-spinner" size={15} /> : <Save size={15} />}保存说明</button></footer>
    </form> : null}
    {draft?.error ? <div className="project-asset-save-error" role="alert"><p>{draft.error}</p>
      {draft.conflict ? <>
        {latest ? <><p className="project-asset-conflict-note">当前说明：{latest.note || "未填写"} · {latest.needsAttention ? "已标记" : "未标记"}</p>
          <button type="button" disabled={saving || readOnly} onClick={() => void save(draft.editing ? { note: draft.note.trim() } : { needsAttention: draft.attentionTarget ?? !annotation.needsAttention }, latest.revision)}>{draft.editing ? "以当前版本保存草稿" : "以当前版本重试标记"}</button></> :
          <button type="button" onClick={onReload}>读取最新，保留草稿</button>}
      </> : !draft.editing ? <button type="button" onClick={() => update(() => undefined)}>收起提示</button> : null}
    </div> : null}
  </div>;
}

function ProjectAssetPanel({ projectId, kind, refreshKey, displayMode = false, drafts, updateDraft, onCommitted }: Props & { drafts: Record<string, Draft>; updateDraft: UpdateDraft; onCommitted: () => void }) {
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [directory, setDirectory] = useState<DirectorySelection | null>(null);
  const [zone, setZone] = useState<AssetZone | "">("");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [attention, setAttention] = useState(false);
  const [missing, setMissing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<AssetSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sample, setSample] = useState("");
  const headingId = useId();
  const sampleId = useId();
  const directoryId = useId();
  const resultList = useRef<HTMLDivElement>(null);
  const pageRequested = useRef(false);
  const mutationSequence = useRef(0);
  const savedAnnotations = useRef(new Map<string, { sequence: number; annotation: Annotation }>());
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  const filterPending = query !== settledQuery;
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  useEffect(() => {
    const timer = window.setTimeout(() => { setSettledQuery(query); setOffset(0); }, 240);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const mutationAtRequest = mutationSequence.current;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ project: projectId, kind, q: settledQuery, offset: String(offset), limit: String(PAGE_SIZE) });
    if (directory) params.set(directory.legacy ? "category" : "directory", directory.path);
    if (zone) params.set("zone", zone);
    if (attention) params.set("attention", "1");
    if (missing && kind === "text") params.set("missing", "1");
    if (displayMode) params.set("display", "1");
    void fetch(`/api/tools/project-assets?${params}`, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || `读取失败（${response.status}）`);
      if (!Array.isArray(result.items) || !Array.isArray(result.locales)) throw new Error("素材目录响应不完整，请重读。");
      return result as AssetSnapshot;
    }).then((result) => {
      if (!active) return;
      if (result.available && result.total > 0 && offset >= result.total) { setOffset(Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE); return; }
      setData({ ...result, items: result.items.map((item) => {
        const saved = savedAnnotations.current.get(item.id);
        return saved && saved.sequence > mutationAtRequest ? { ...item, annotation: saved.annotation } : item;
      }) });
      if (pageRequested.current) { resultList.current?.scrollIntoView({ block: "start" }); resultList.current?.focus({ preventScroll: true }); pageRequested.current = false; }
    }).catch((reason) => { if (active && !controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [attention, directory, displayMode, kind, missing, offset, projectId, refreshKey, reload, settledQuery, zone]);
  const onSaved = useCallback((id: string, annotation: Annotation) => {
    mutationSequence.current += 1;
    savedAnnotations.current.set(id, { sequence: mutationSequence.current, annotation });
    setData((current) => current ? { ...current, items: current.items.map((item) => item.id === id ? { ...item, annotation } : item) } : current);
    onCommitted();
  }, [onCommitted]);
  const clearFilters = () => { setQuery(""); setSettledQuery(""); setDirectory(null); setZone(""); setAttention(false); setMissing(false); setOffset(0); };
  const hasFilters = Boolean(query || directory || zone || attention || missing);
  const legacyDirectories = !Array.isArray(data?.directories);
  const directories = data?.directories ?? (data?.categories || []).map((entry) => ({ path: entry.name, label: entry.name, count: entry.count, children: [] }));
  const directoryTotal = zone ? data?.zoneCounts?.[zone] : data?.counts?.[kind];
  const selectDirectory = (next: DirectorySelection | null) => { setDirectory(next); setOffset(0); };
  const locales = data?.locales || [];
  const canFilterMissing = locales.length > 1;
  const disabled = loading || filterPending;
  const changePage = (next: number) => { pageRequested.current = true; setOffset(next); };
  return <section className={`project-assets is-${kind}`} aria-labelledby={headingId}>
    <header className="project-assets-heading"><div><Icon size={20} /><h2 id={headingId}>{meta.name}</h2><span>{meta.hint}</span></div><button type="button" onClick={refresh} disabled={loading} aria-label={`重读${meta.name}`}><RefreshCw className={loading ? "project-asset-spinner" : ""} size={16} />重读</button></header>
    <nav className="project-assets-zones" aria-label="素材状态">
      <button type="button" className={!zone ? "is-selected" : ""} aria-pressed={!zone} onClick={() => { setZone(""); setOffset(0); }}><span>全部</span><small>{data?.counts?.[kind] ?? "—"}</small></button>
      {ASSET_ZONES.filter((value) => value !== "unknown" || (data?.zoneCounts?.unknown ?? 0) > 0 || zone === "unknown").map((value) => <button key={value} type="button" className={zone === value ? "is-selected" : ""} aria-pressed={zone === value} disabled={!data?.zoneCounts} title={!data?.zoneCounts ? "当前目录尚未提供状态统计" : undefined} onClick={() => { setZone(value); setOffset(0); }}><span>{ZONE_NAMES[value]}</span><small>{data?.zoneCounts?.[value] ?? "—"}</small></button>)}
    </nav>
    <div className="project-assets-workspace">
      <aside className={`project-assets-directories${directoryOpen ? " is-open" : ""}`} aria-label="素材目录">
        <div className="project-assets-directory-heading"><FolderOpen size={16} /><h3>目录</h3><small>{zone ? ZONE_NAMES[zone] : "全部状态"}</small></div>
        <button className="project-assets-directory-toggle" type="button" aria-controls={directoryId} aria-expanded={directoryOpen} onClick={() => setDirectoryOpen((value) => !value)}><FolderOpen size={17} /><span>目录<small>{directory?.label || "全部目录"}</small></span><ChevronDown className={directoryOpen ? "is-open" : ""} size={17} /></button>
        <nav className="project-assets-directory-body" id={directoryId} aria-label="按目录浏览" aria-busy={loading}>
          <button className={`project-assets-directory-all${!directory ? " is-selected" : ""}`} type="button" aria-current={!directory ? "page" : undefined} onClick={() => selectDirectory(null)}><FolderOpen size={16} /><span>全部目录</span><small>{directoryTotal ?? "—"}</small></button>
          <DirectoryList directories={directories} selected={directory?.path || ""} legacy={legacyDirectories} onSelect={selectDirectory} />
          {!directories.length ? <p className="project-assets-directory-empty">{loading ? "正在读取目录…" : zone ? `暂无${ZONE_NAMES[zone]}目录` : "暂无目录"}</p> : null}
        </nav>
      </aside>
      <div className="project-assets-content">
    <div className="project-assets-location"><span>{zone ? ZONE_NAMES[zone] : "全部素材"}</span><ChevronRight size={13} /><strong title={directory?.path}>{directory?.path.split("/").join(" / ") || "全部目录"}</strong>{directory ? <button type="button" aria-label="返回全部目录" onClick={() => selectDirectory(null)}><X size={14} /></button> : null}</div>
    <div className="project-assets-filters">
      <label className="project-assets-search"><Search size={17} /><input type="search" value={query} placeholder={kind === "text" ? "搜索文本、文本键或说明" : "搜索名称、用途或说明"} aria-label={`搜索${meta.name}`} onChange={(event) => setQuery(event.currentTarget.value)} /></label>
      <button className={attention ? "is-selected" : ""} type="button" aria-pressed={attention} onClick={() => { setAttention((value) => !value); setOffset(0); }}><AttentionMark marked={attention} />已标记</button>
      {kind === "text" ? <button type="button" className={missing ? "is-selected" : ""} aria-pressed={missing} disabled={!canFilterMissing} title={canFilterMissing ? "筛选现行语言中缺少内容的条目" : "尚未登记多个现行语言"} onClick={() => { setMissing((value) => !value); setOffset(0); }}>缺失语言</button> : null}
      {hasFilters ? <button className="project-assets-clear" type="button" onClick={clearFilters}>清除筛选</button> : null}
    </div>
    {data?.available && kind === "font" && data.counts.font > 0 ? <div className="project-assets-specimen"><label htmlFor={sampleId}>统一试写</label><textarea id={sampleId} value={sample} maxLength={600} rows={2} placeholder="山间有清风，心中有天地。  A journey begins · 0123456789" onChange={(event) => setSample(event.currentTarget.value)} /><small>输入后，下方每款字体同步展示。</small></div> : null}
    {data?.available && kind === "text" ? <p className="project-assets-locale-summary">{locales.length ? `现行语言：${locales.map((locale) => locale.label).join("、")}` : "项目尚未登记现行语言。"}{locales.length === 1 ? " · 当前只有一种语言，尚无多语言缺失统计。" : locales.length > 1 ? " · 缺失只按这些语言判断。" : ""}</p> : null}
    {data?.coverage?.length ? <details className="project-assets-coverage"><summary>收录范围{data.generatedAt ? ` · ${fmtDateTime(data.generatedAt)}更新` : ""}</summary><ul>{data.coverage.map((line, index) => <li key={index}>{line}</li>)}</ul></details> : null}
    {error ? <div className="project-assets-state is-error" role="alert"><AlertTriangle size={22} /><div><strong>素材暂时读不到</strong><p>{error}</p></div><button type="button" onClick={refresh}>重试</button></div> : null}
    {!error && loading && !data ? <div className="project-assets-state" role="status"><LoaderCircle className="project-asset-spinner" size={22} /><p>正在读取{meta.name}…</p></div> : null}
    {!error && data && !data.available ? <div className="project-assets-state"><Icon size={26} /><div><strong>{data.project?.name || "这个项目"}尚未接入{meta.name}</strong><p>{data.message || "项目尚未提供此类型的素材目录。"}</p></div></div> : null}
    {!error && data?.available ? <>
      <div className="project-assets-result" role="status"><span>{loading || filterPending ? "正在更新筛选结果…" : `共 ${data.total} 项${data.total ? ` · 第 ${data.offset + 1}–${Math.min(data.offset + data.items.length, data.total)} 项` : ""}`}</span>{displayMode ? <span>展示模式 · 只读</span> : <span><AttentionMark marked />待处理标记</span>}</div>
      <div className="project-assets-list" ref={resultList} tabIndex={-1} aria-busy={disabled}>
        {!data.items.length && !loading ? <div className="project-assets-state"><Icon size={26} /><div><strong>{hasFilters ? "没有符合筛选的素材" : `尚无${meta.name}素材`}</strong><p>{hasFilters ? `${directory ? `「${directory.label}」` : "全部目录"}在${zone ? `「${ZONE_NAMES[zone]}」` : "全部状态"}下${query || attention || missing ? "没有符合当前关键词或筛选条件的素材" : "暂无素材"}。可切换目录、状态，或清除筛选。` : data.message || "当前项目目录中，这一类型为零项。"}</p></div>{hasFilters ? <button type="button" onClick={clearFilters}>清除筛选</button> : null}</div> : null}
        {data.items.map((item) => <article className={`project-asset-card${item.annotation.needsAttention ? " is-attention" : ""}`} key={item.id}>
          <AnnotationEditor item={item} projectId={projectId} readOnly={displayMode || disabled} draft={drafts[draftKey(projectId, item.id)]} updateDraft={updateDraft} onSaved={onSaved} onReload={refresh} />
          <header className="project-asset-card-heading"><div><span>{item.categoryPath?.length ? item.categoryPath.join(" / ") : item.category || "未分类"}{item.zone ? ` · ${ZONE_NAMES[item.zone]}` : ""}</span><h3>{item.name}</h3></div><small>{[item.format?.toUpperCase(), typeof item.bytes === "number" ? fmtBytes(item.bytes) : ""].filter(Boolean).join(" · ")}</small></header>
          {kind === "font" ? <FontPreview item={item} projectId={projectId} displayMode={displayMode} sample={sample} /> : kind === "text" ? <TextPreview item={item} locales={locales} /> : <MediaPreview item={item} projectId={projectId} displayMode={displayMode} />}
          <ProjectAssetRelations projectId={projectId} itemId={item.id} links={item.links || EMPTY_LINKS} displayMode={displayMode} />
          <Sources item={item} />
        </article>)}
      </div>
      {data.total > PAGE_SIZE || offset > 0 ? <nav className="project-assets-pagination" aria-label="素材分页"><button type="button" disabled={disabled || offset === 0} onClick={() => changePage(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={16} />上一页</button><span>第 {Math.floor(data.offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(data.total / PAGE_SIZE))} 页</span><button type="button" disabled={disabled || !data.hasMore} onClick={() => changePage(offset + PAGE_SIZE)}>下一页<ChevronRight size={16} /></button></nav> : null}
    </> : null}
      </div>
    </div>
  </section>;
}

export default function ProjectAssetsView(props: Props) {
  // Keep unsaved notes when a filter, page or project temporarily hides their cards.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [commitRevision, setCommitRevision] = useState(0);
  const onCommitted = useCallback(() => setCommitRevision((value) => value + 1), []);
  const updateDraft = useCallback<UpdateDraft>((key, update) => setDrafts((current) => {
    const nextDraft = update(current[key]);
    const next = { ...current };
    if (nextDraft) next[key] = nextDraft; else delete next[key];
    return next;
  }), []);
  if (props.active === false) return null;
  return <ProjectAssetPanel key={`${props.projectId}:${props.kind}:${Boolean(props.displayMode)}`} {...props} refreshKey={JSON.stringify([props.refreshKey, commitRevision])} drafts={drafts} updateDraft={updateDraft} onCommitted={onCommitted} />;
}
