import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertTriangle, Archive, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Columns2, Copy,
  FolderOpen, FolderTree, Image as ImageIcon, Layers, LoaderCircle, Type, Languages, AudioLines, Clapperboard,
  Maximize2, MoveRight, PenLine, RefreshCw, Save, Search, ShieldCheck, Undo2, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { Empty, ExternalSourceDisclosure, fmtBytes, fmtDateTime, jsonFetch } from "../../page-shared";
import { createPortal } from "react-dom";
import "./art-library.css";
import ProjectAssetsView from "./ProjectAssetsView";
import ProjectAssetRelations from "./ProjectAssetRelations";
import { AttentionMark as AttentionCircle } from "../../components/AttentionMark";

type ZoneId = "formal" | "candidate" | "archive";
type ReferenceStatus = "using" | "unreferenced" | "unknown";
type SystemFilter = "" | "attention" | "using" | "unreferenced" | "duplicate" | "unknown";
type AssetKind = "art" | "font" | "text" | "audio" | "video";
type ArtViewMode = "semantic" | "library";
type AssetLibraryLocation = { projectId: string; assetKind: AssetKind; viewMode: ArtViewMode };
const ASSET_LIBRARY_LOCATION_KEY = "infans-project-asset-location-v1";
const DEFAULT_ASSET_LIBRARY_LOCATION: AssetLibraryLocation = { projectId: "secretary-visual-assets", assetKind: "art", viewMode: "semantic" };
function readAssetLibraryLocation(): AssetLibraryLocation {
  if (typeof window === "undefined") return DEFAULT_ASSET_LIBRARY_LOCATION;
  try {
    const value = JSON.parse(window.localStorage.getItem(ASSET_LIBRARY_LOCATION_KEY) || "null") as Partial<AssetLibraryLocation> | null;
    const assetKind = value && ["art", "font", "text", "audio", "video"].includes(value.assetKind || "") ? value.assetKind as AssetKind : DEFAULT_ASSET_LIBRARY_LOCATION.assetKind;
    const viewMode = value?.viewMode === "semantic" || value?.viewMode === "library" ? value.viewMode : DEFAULT_ASSET_LIBRARY_LOCATION.viewMode;
    const projectId = typeof value?.projectId === "string" && value.projectId.trim() ? value.projectId : DEFAULT_ASSET_LIBRARY_LOCATION.projectId;
    return { projectId, assetKind, viewMode };
  } catch { return DEFAULT_ASSET_LIBRARY_LOCATION; }
}
type ArtProject = { id: string; name: string; kind?: "non-game-visual"; configured: boolean; indexedAt: string | null; total: number; error?: string };
type ArtAnnotation = {
  purpose: string; subject: string; form: string; scene: string; avoid: string;
  tags: string[]; needsAttention: boolean;
  provenance: "ai-draft" | "capoo-confirmed"; updatedAt: string | null; attentionChangedAt: string | null;
};
type SavePurpose = (purpose: string, expectedPurpose: string) => Promise<void>;
type ArtItem = {
  moveTargets?: Record<ZoneId, string>;
  editPurpose?: boolean;
  displayPurpose?: string;
  id: string; name: string; relativePath: string; relativeToRoot: string; subdirectory: string; directory: string;
  bytes: number; modifiedAt: string; format: string; mimeType: string; width: number | null; height: number | null;
  hasAlpha: boolean | null; hash: string; scanRootId: string; scanRootLabel: string;
  role: "runtime" | "archive" | "source" | "platform"; zone: ZoneId | "platform"; category: string; qualityTags: string[];
  gitStatus: "tracked" | "untracked" | "not-repository"; referenceStatus: ReferenceStatus;
  duplicate: boolean; duplicateCount: number; duplicateOf: string | null;
  references: Array<{ path: string; kind: "scene" | "resource" | "script" | "project" | "source" }>;
  assetUid: string | null; annotation: ArtAnnotation | null; suggestedTagGroups: Array<{ label: string; tags: string[] }>;
};
type ArtDirectory = {
  id: string; rootId: string; path: string; label: string; parent: string; depth: number;
  count: number; directCount: number; sample: ArtItem; samples: ArtItem[];
};
type ZoneRoot = {
  id: string; path: string; label: string; exists: boolean; movable: boolean; count: number;
  directCount: number; directories: ArtDirectory[];
};
type ArtZone = { id: ZoneId; label: string; description: string; configured: boolean; count: number; roots: ZoneRoot[] };
type Destination = { rootId: string; subdirectory: string; path: string; label: string; exists: boolean };
type PlatformSlot = {
  id: string; name: string; required: boolean; width?: number; height?: number; minWidth?: number; minHeight?: number;
  eitherWidth?: number; eitherHeight?: number; formats?: string[]; safeArea: string; candidates: ArtItem[];
  checks: { specification: "pass" | "missing"; characterIdentity: "human-review"; logo: "human-review"; visualConsistency: "human-review" };
};
type PlatformSet = {
  id: string; name: string; available: boolean; verifiedAt?: string; note?: string;
  source?: { label: string; url: string } | null; slots: PlatformSlot[];
};
type ArtSnapshot = {
  available: boolean; projects: ArtProject[]; project?: { id: string; name: string; root: string; kind?: "non-game-visual" }; generatedAt?: string;
  stats?: { total: number; attention: number; using: number; unreferenced: number; duplicates: number; referenceUnknown: number };
  zones: ArtZone[]; destinations: Record<ZoneId, Destination[]>;
  lastMove: { batchId: string; movedAt: string; count: number; targetZone: ZoneId; sourceZones: ZoneId[] } | null;
  platformSets: PlatformSet[];
  policy?: { readOnly?: boolean; attentionWritable?: boolean; annotationWritable?: boolean; manifestDerived?: boolean };
};
type BrowseResult = {
  project: { id: string; name: string; root: string };
  root: { id: string; path: string; label: string; zone: ZoneId; exists: boolean };
  directory: string; breadcrumbs: Array<{ path: string; label: string }>;
  directories: ArtDirectory[]; items: ArtItem[]; total: number; filteredZoneTotal: number;
  filter: { system: SystemFilter; query: string }; truncated: boolean;
};
type MoveDestination = Destination & { preserveSubdirectories?: boolean };
type SemanticTreeNode = {
  id: string; label: string; path: string; entityCount: number; assetCount: number; children: SemanticTreeNode[];
};
type SemanticAsset = {
  id: string; path: string; fileName: string; categoryPath: string[]; semanticSource: string;
  sourceZones: string[]; usageStatus: string; entityIds: string[]; references: Array<{ file: string; line?: number }>;
  libraryItem: ArtItem | null;
};
type SemanticEntity = {
  id: string; entityType: string; gameId: string; displayName: string; categoryPath: string[];
  sourceFiles: string[]; fields: Record<string, unknown>; confidence: string;
  assetRelations: Array<{ assetId: string; assetPath: string; role: string; form?: string; sourceFile: string; confidence: string }>;
};
type SemanticSnapshot = {
  available: boolean; project: { id: string; name: string }; schemaVersion: number; sourceFingerprint: string | null;
  tree: SemanticTreeNode[];
  selection: {
    id: string; label: string; path: string; breadcrumbs: Array<{ path: string; label: string }>;
    children: Array<{ id: string; label: string; path: string; entityCount: number; assetCount: number }>;
    entityCount: number; assetCount: number;
  };
  entities: SemanticEntity[]; assets: SemanticAsset[];
  truncated: { entities: boolean; assets: boolean };
};

const semanticSnapshotCache = new Map<string, SemanticSnapshot>();

const RELATION_ROLE_LABELS: Record<string, string> = {
  portrait: "头像", "portrait-or-combat-texture": "角色图", icon: "图标", illustration: "插图", texture: "画面", "combat-effect": "战斗特效",
};

function compactArtFolder(item: ArtItem | null) {
  if (!item) return "尚未接入素材目录";
  const parts = item.subdirectory.split("/").filter(Boolean);
  const tail = parts.slice(-3).join(" / ");
  return tail ? `${item.scanRootLabel} / ${tail}` : item.scanRootLabel;
}

const ZONE_META: Record<ZoneId, { icon: typeof CheckCircle2; action: string }> = {
  formal: { icon: CheckCircle2, action: "升为正式" },
  candidate: { icon: Bot, action: "移到 AI 候选" },
  archive: { icon: Archive, action: "移入归档" },
};
const SYSTEM_FILTERS: Array<{ id: SystemFilter; label: string }> = [
  { id: "", label: "不限事实" }, { id: "attention", label: "已标记" }, { id: "using", label: "使用中" },
  { id: "unreferenced", label: "未引用" }, { id: "duplicate", label: "重复文件" },
  { id: "unknown", label: "引用未知" },
];

function localLoopback() { return window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"; }
function thumbUrl(projectId: string, itemId: string, size: "tiny" | "small" | "medium" | "preview" = "small") {
  return `/api/tools/art-library/thumb?${new URLSearchParams({ project: projectId, id: itemId, size })}`;
}

function useCompactPreviews() {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}
function previewUrl(projectId: string, itemId: string) {
  return `/api/tools/art-library/preview?${new URLSearchParams({ project: projectId, id: itemId })}`;
}
function referenceLabel(value: ReferenceStatus) { return value === "using" ? "使用中" : value === "unreferenced" ? "未引用" : "引用未知"; }
function gitLabel(value: ArtItem["gitStatus"]) { return value === "tracked" ? "Git 已跟踪" : value === "untracked" ? "Git 未跟踪" : "非 Git 项目"; }
function alphaLabel(value: boolean | null) { return value === true ? "有透明通道" : value === false ? "无透明通道" : "透明通道未知"; }
function zoneLabel(zone: ArtItem["zone"]) { return zone === "formal" ? "正式素材" : zone === "candidate" ? "AI 候选素材" : zone === "archive" ? "归档素材" : "平台交付"; }
function matchesFactFilter(item: ArtItem, system: SystemFilter, query: string) {
  const search = query.trim().toLowerCase();
  if (search && !`${item.name}\n${item.relativePath}\n${item.category}\n${item.annotation?.purpose || ""}\n${item.annotation?.tags?.join(" ") || ""}`.toLowerCase().includes(search)) return false;
  if (system === "using") return item.referenceStatus === "using";
  if (system === "unreferenced") return item.referenceStatus === "unreferenced";
  if (system === "duplicate") return item.duplicate;
  if (system === "unknown") return item.referenceStatus === "unknown";
  return true;
}

const AssetCard = memo(function AssetCard({ projectId, item, selected, comparisonOrder, compareMode, canMark, canAnnotate, attentionSaving, onToggle, onOpen, onToggleAttention }: {
  projectId: string; item: ArtItem; selected: boolean; comparisonOrder: number; compareMode: boolean; canMark: boolean; canAnnotate: boolean; attentionSaving: boolean;
  onToggle: (item: ArtItem) => void; onOpen: (item: ArtItem) => void; onToggleAttention: (item: ArtItem) => void;
}) {
  return <article className={`art-file-card${selected ? " is-selected" : ""}${compareMode ? " is-compare-mode" : ""}`}>
    {!compareMode && (canMark || canAnnotate) ? <header className="art-asset-toolbar">
      {canMark ? <button type="button" className="art-attention-file" aria-pressed={item.annotation?.needsAttention === true} disabled={attentionSaving} onClick={() => onToggleAttention(item)} aria-label={item.annotation?.needsAttention ? `取消待处理标记 ${item.name}` : `标记待处理 ${item.name}`} title={item.annotation?.needsAttention ? "取消待处理" : "标记待处理"}><AttentionCircle marked={item.annotation?.needsAttention === true} /></button> : null}
      {canAnnotate ? <button type="button" className="art-edit-file" aria-label={`编辑说明 ${item.name}`} title="编辑说明" onClick={() => onOpen({ ...item, editPurpose: true })}><span className={visiblePurpose(item) ? undefined : "is-placeholder"}>{visiblePurpose(item) || "添加说明"}</span><PenLine size={17} /></button> : null}
    </header> : null}
    <button type="button" className="art-file-image" tabIndex={compareMode ? -1 : 0} aria-hidden={compareMode ? true : undefined} onClick={() => onOpen(item)} aria-label={`查看 ${item.name}`}>
      <img loading="lazy" decoding="async" src={thumbUrl(projectId, item.id, "small")} alt="" />
      <span>{item.width && item.height ? `${item.width} × ${item.height}` : "尺寸未知"}</span>
    </button>
    <div className="art-file-copy">
      <button type="button" className="art-file-name" tabIndex={compareMode ? -1 : 0} aria-hidden={compareMode ? true : undefined} onClick={() => onOpen(item)} title={item.name}>{item.name}</button>
      <small>{item.format} · {fmtBytes(item.bytes)}</small>
      <div className="art-chip-row">
        <i className={`art-chip reference-${item.referenceStatus}`}>{referenceLabel(item.referenceStatus)}</i>

        {item.duplicate ? <i className="art-chip is-warning">重复 ×{item.duplicateCount}</i> : null}
      </div>
    </div>
    {compareMode ? <button type="button" className="art-compare-select-surface" aria-pressed={selected} onClick={() => onToggle(item)} aria-label={selected ? `取消对比选择 ${item.name}` : `选择 ${item.name} 进行对比`}><span>{selected ? comparisonOrder : <Columns2 size={16} />}</span><strong>{selected ? `第 ${comparisonOrder} 张` : "加入对比"}</strong></button> : <button type="button" className="art-select-file" aria-pressed={selected} onClick={() => onToggle(item)} aria-label={selected ? `取消选择 ${item.name}` : `选择 ${item.name}`}>{selected ? <Check size={15} /> : null}</button>}
  </article>;
});

const FolderCard = memo(function FolderCard({ projectId, folder, compact, onOpen }: {
  projectId: string; folder: ArtDirectory; compact: boolean; onOpen: (path: string) => void;
}) {
  const samples = folder.samples?.length ? folder.samples.slice(0, compact ? 1 : 3) : folder.sample ? [folder.sample] : [];
  return <button type="button" className="art-folder-card" onClick={() => onOpen(folder.path)} aria-label={`进入文件夹 ${folder.label}`}>
    <span className={`art-folder-preview art-folder-preview-${samples.length}`} aria-hidden="true">
      {samples.map((item, index) => <i style={{ "--card-index": index } as CSSProperties} key={item.id}><img loading="lazy" decoding="async" src={thumbUrl(projectId, item.id, "tiny")} alt="" /></i>)}
      {!samples.length ? <i className="is-empty"><FolderOpen size={28} /></i> : null}
    </span>
    <span className="art-folder-copy"><strong title={folder.label}>{folder.label}</strong><small>{folder.count} 件素材{folder.directCount ? ` · 本层 ${folder.directCount} 件` : ""}</small></span>
    <ChevronRight size={17} />
  </button>;
});

function ZoneSection({ zone, projectId, displayMode, query, system, revision, selectedIds, comparisonOrderById, compareMode, canMark, canAnnotate, compactPreviews, attentionSavingId, onToggle, onOpen, onToggleAttention }: {
  zone: ArtZone; projectId: string; displayMode: boolean; query: string; system: SystemFilter; revision: number;
  selectedIds: Set<string>; comparisonOrderById: Map<string, number>; compareMode: boolean; canMark: boolean; canAnnotate: boolean; compactPreviews: boolean; attentionSavingId: string;
  onToggle: (item: ArtItem) => void; onOpen: (item: ArtItem) => void; onToggleAttention: (item: ArtItem) => void;
}) {
  const [rootId, setRootId] = useState(zone.roots[0]?.id || "");
  const [directory, setDirectory] = useState("");
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const meta = ZONE_META[zone.id];
  const Icon = meta.icon;
  const visibleData = data?.filter.system === system && data.filter.query === query ? data : null;
  const filteredCount = query || system ? visibleData?.filteredZoneTotal : zone.count;
  const activeFilterLabel = SYSTEM_FILTERS.find((item) => item.id === system)?.label;

  useEffect(() => {
    if (zone.roots.some((root) => root.id === rootId)) return;
    setRootId(zone.roots[0]?.id || ""); setDirectory("");
  }, [rootId, zone.roots]);

  useEffect(() => {
    if (!rootId) { setData(null); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({ project: projectId, root: rootId, directory, limit: "360" });
    if (displayMode) params.set("display", "1");
    if (query) params.set("q", query); if (system) params.set("system", system);
    setLoading(true); setError("");
    fetch(`/api/tools/art-library/browse?${params}`, { signal: controller.signal })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body?.error || `目录读取失败（${response.status}）`); return body as BrowseResult; })
      .then(setData)
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "目录读取失败"); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [directory, displayMode, projectId, query, revision, rootId, system]);

  const openDirectory = (next: string) => { setDirectory(next); document.getElementById(`art-zone-${zone.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  return <section className={`art-zone art-zone-${zone.id}`} id={`art-zone-${zone.id}`}>
    <header className="art-zone-header"><span className="art-zone-icon"><Icon size={18} /></span><div><h3>{zone.label}</h3><p>{zone.description}</p></div><strong>{filteredCount ?? "—"}<small> 件</small></strong></header>
    {!zone.configured ? <div className="art-zone-unconfigured"><FolderTree size={22} /><span>这个项目还没有登记{zone.label}目录。美术库不会替项目猜一个位置。</span></div> : <>
      <div className="art-directory-bar">
        {zone.roots.length > 1 ? <select value={rootId} onChange={(event) => { setRootId(event.target.value); setDirectory(""); }} aria-label={`${zone.label}根目录`}>{zone.roots.map((root) => <option value={root.id} key={root.id}>{root.label}</option>)}</select> : <span className="art-root-label"><FolderTree size={15} />{zone.roots[0]?.label}</span>}
        <nav aria-label={`${zone.label}当前位置`}>{(visibleData?.breadcrumbs || [{ path: "", label: zone.roots.find((root) => root.id === rootId)?.label || zone.label }]).map((crumb, index, list) => <span key={`${rootId}-${crumb.path}`}><button type="button" onClick={() => openDirectory(crumb.path)} disabled={index === list.length - 1}>{crumb.label}</button>{index < list.length - 1 ? <ChevronRight size={13} /> : null}</span>)}</nav>
        {loading ? <LoaderCircle className="is-spinning" size={16} /> : null}
      </div>
      {error ? <p className="art-inline-error"><AlertTriangle size={15} />{error}</p> : null}
      {visibleData?.directories.length ? <div className="art-folder-grid">{visibleData.directories.map((folder) => <FolderCard projectId={projectId} folder={folder} compact={compactPreviews} onOpen={openDirectory} key={folder.id} />)}</div> : null}
      {visibleData?.items.length ? <div className="art-file-grid">{visibleData.items.map((item) => <AssetCard projectId={projectId} item={item} selected={selectedIds.has(item.id)} comparisonOrder={comparisonOrderById.get(item.id) || 0} compareMode={compareMode} canMark={canMark} canAnnotate={canAnnotate} attentionSaving={attentionSavingId === item.id} onToggle={onToggle} onOpen={onOpen} onToggleAttention={onToggleAttention} key={item.id} />)}</div> : !loading && visibleData && !visibleData.directories.length ? <Empty>{query ? "当前目录及其下级没有匹配搜索的素材。" : system ? `当前目录及其下级没有符合“${activeFilterLabel}”的素材。` : "这个目录目前没有图片素材。"}</Empty> : null}
      {visibleData?.truncated ? <p className="art-truncated">这个目录匹配结果较多，先显示前 360 件；可继续用文件名筛选。</p> : null}
    </>}
  </section>;
}

function FullscreenViewer({ projectId, item, onClose }: { projectId: string; item: ArtItem; onClose: () => void }) {
  const [fit, setFit] = useState(true); const [zoom, setZoom] = useState(1); const [original, setOriginal] = useState(false);
  const loadOriginal = (nextZoom = zoom) => { setOriginal(true); setFit(false); setZoom(nextZoom); };
  return createPortal(<div className="art-fullscreen" role="dialog" aria-modal="true" aria-label={`查看 ${item.name}`}>
    <header><div><strong>{item.name}</strong><span>{item.width && item.height ? `${item.width} × ${item.height} px` : "尺寸未知"} · {original ? "原图" : "轻量预览"}</span></div><nav aria-label="图片缩放"><button type="button" className={fit ? "active" : ""} onClick={() => setFit(true)}>适应窗口</button><button type="button" className={!fit && zoom === 1 ? "active" : ""} onClick={() => loadOriginal(1)}>载入原图 1:1</button><button type="button" onClick={() => loadOriginal(Math.max(.25, zoom - .25))} aria-label="缩小"><ZoomOut size={18} /></button><button type="button" onClick={() => loadOriginal(Math.min(4, zoom + .25))} aria-label="放大"><ZoomIn size={18} /></button><button type="button" onClick={onClose} aria-label="关闭图片"><X size={20} /></button></nav></header>
    <div className={`art-fullscreen-stage${fit ? " is-fit" : " is-actual"}`}><img src={original ? previewUrl(projectId, item.id) : thumbUrl(projectId, item.id, "preview")} alt={item.name} style={!fit && item.width && item.height ? { width: item.width * zoom, height: item.height * zoom } : undefined} /></div>
  </div>, document.body);
}

function CompareViewer({ projectId, items, onClose, onReset }: { projectId: string; items: [ArtItem, ArtItem]; onClose: () => void; onReset: () => void }) {
  return createPortal(<div className="art-fullscreen art-compare" role="dialog" aria-modal="true" aria-label="对比两张素材"><header><div><strong>两图对比</strong><span>轻量预览按原比例适应各自画布</span></div><nav aria-label="对比操作"><button type="button" onClick={onReset}>重新选择</button><button type="button" onClick={onClose} aria-label="关闭对比"><X size={20} /></button></nav></header><div className="art-compare-grid">{items.map((item) => <figure key={item.id}><div><img src={thumbUrl(projectId, item.id, "medium")} alt={item.name} /></div><figcaption><strong>{item.name}</strong><span>{item.width && item.height ? `${item.width} × ${item.height}` : "尺寸未知"} · {zoneLabel(item.zone)}</span></figcaption></figure>)}</div></div>, document.body);
}

function CompareTray({ projectId, items, onRemove, onShow, onClear, onExit }: {
  projectId: string; items: ArtItem[];
  onRemove: (item: ArtItem) => void; onShow: () => void; onClear: () => void; onExit: () => void;
}) {
  return <aside className="art-compare-tray" aria-label="素材对比选择" aria-live="polite">
    <div className="art-compare-tray-title"><span><Columns2 size={17} />对比模式</span><strong>{items.length}/2</strong><p>{items.length === 0 ? "进入任意文件夹，直接点两张图片。" : items.length === 1 ? "第一张已选，再点一张就会自动对比。" : "两张已选，可以查看或换图。"}</p></div>
    <div className="art-compare-slots">{[0, 1].map((index) => { const item = items[index]; return item ? <div className="art-compare-slot is-filled" key={item.id}><span>{index + 1}</span><img src={thumbUrl(projectId, item.id)} alt="" /><strong title={item.name}>{item.name}</strong><small>{zoneLabel(item.zone)}</small><button type="button" onClick={() => onRemove(item)} aria-label={`移除对比素材 ${item.name}`}><X size={14} /></button></div> : <div className="art-compare-slot" key={index}><span>{index + 1}</span><div><ImageIcon size={16} /></div><strong>{index === 0 ? "选择第一张" : "选择第二张"}</strong></div>; })}</div>
    <div className="art-compare-tray-actions">{items.length === 2 ? <button type="button" className="primary" onClick={onShow}><Columns2 size={16} />查看对比</button> : null}{items.length ? <button type="button" onClick={onClear}>清空</button> : null}<button type="button" onClick={onExit}>退出对比</button></div>
  </aside>;
}

function MoveDialog({ items, targetZone, destinations, saving, onClose, onConfirm }: {
  items: ArtItem[]; targetZone: ZoneId; destinations: Destination[]; saving: boolean;
  onClose: () => void; onConfirm: (destination: MoveDestination) => void;
}) {
  const destinationKey = (item: Destination) => JSON.stringify([item.rootId, item.subdirectory]);
  const choices = useMemo<MoveDestination[]>(() => destinations.flatMap((item) => item.subdirectory ? [item] : [
    { ...item, label: `${item.label} · 保留原目录`, preserveSubdirectories: true },
    item,
  ]), [destinations]);
  const [value, setValue] = useState(choices[0] ? `${destinationKey(choices[0])}:${choices[0].preserveSubdirectories ? "mirror" : "flat"}` : "");
  const selected = choices.find((item) => `${destinationKey(item)}:${item.preserveSubdirectories ? "mirror" : "flat"}` === value);
  const blocked = items.filter((item) => item.referenceStatus !== "unreferenced");
  const previewPaths = selected ? items.slice(0, 4).map((item) => {
    if (item.moveTargets) return {source:item.relativePath,target:item.moveTargets[targetZone]};
    const mirrored = selected.preserveSubdirectories && item.subdirectory ? `${item.subdirectory}/` : "";
    return { source: item.relativePath, target: `${selected.path}/${mirrored}${item.name}`.replaceAll("//", "/") };
  }) : [];
  return <div className="art-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="art-move-dialog" role="dialog" aria-modal="true" aria-label={ZONE_META[targetZone].action}>
    <header><div><span>认可位置</span><h3>{ZONE_META[targetZone].action}</h3></div><button type="button" onClick={onClose} aria-label="关闭移动窗口"><X size={18} /></button></header>
    <p>{items[0]?.moveTargets ? "按对象与用途移动到对应目录，保留素材编号与说明；升为正式不会自动替换当前头像或背景。" : "默认沿用素材原来的相对目录；正式、候选与归档表示认可状态，是否使用另看引用事实。"}</p>
    {blocked.length ? <div className="art-move-warning"><AlertTriangle size={17} /><span>{blocked.map((item) => item.name).join("、")} 正在使用或引用不明。请先解除引用；Godot 项目也可从 FileSystem 面板完成迁移。</span></div> : null}
    {choices.length ? <label><span>目标目录</span><select value={value} onChange={(event) => setValue(event.target.value)}>{choices.map((item) => { const key = `${destinationKey(item)}:${item.preserveSubdirectories ? "mirror" : "flat"}`; return <option value={key} key={key}>{item.label}{item.exists ? "" : "（首次移动时建立）"}</option>; })}</select></label> : <div className="art-move-warning"><FolderTree size={17} /><span>这个项目还没有登记目标目录。</span></div>}
    {previewPaths.length ? <div className="art-move-preview"><span>路径预览</span>{previewPaths.map((row) => <div key={`${row.source}-${row.target}`}><code>{row.source}</code><MoveRight size={13} /><code>{row.target}</code></div>)}{items.length > previewPaths.length ? <small>另有 {items.length - previewPaths.length} 件按同一规则移动</small> : null}</div> : null}
    <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={!selected || saving || blocked.length > 0} onClick={() => selected && onConfirm(selected)}>{saving ? <LoaderCircle className="is-spinning" size={16} /> : <MoveRight size={16} />}{ZONE_META[targetZone].action}</button></footer>
  </section></div>;
}

function visiblePurpose(item: ArtItem) {
  const purpose = item.annotation?.purpose?.trim() || "";
  if (item.annotation?.provenance === "ai-draft" && purpose === item.suggestedTagGroups.find((group) => group.label === "用途")?.tags?.[0]) return "";
  // Hide only the old generated template; keep substantive AI and personal notes.
  return /^[^；\n]+；当前(?:已检测到工程引用|未检测到工程直接引用|引用位置仍需核对)。具体对象与最终使用位置待你校正。$/u.test(purpose) ? "" : purpose;
}


function PurposeEditor({ item, canEdit, saving, onSave }: {
  item: ArtItem; canEdit: boolean; saving: boolean; onSave: SavePurpose;
}) {
  const [editing, setEditing] = useState(item.editPurpose === true && canEdit);
  const [draft, setDraft] = useState(() => visiblePurpose(item));
  const [baseline, setBaseline] = useState(() => visiblePurpose(item));
  const [expectedPurpose, setExpectedPurpose] = useState(item.annotation?.purpose || "");
  const [error, setError] = useState("");
  const purpose = visiblePurpose(item);
  const purposeLabel = item.displayPurpose || item.suggestedTagGroups.find((group) => group.label === "用途")?.tags?.[0]
    || item.annotation?.form || item.annotation?.subject || item.category || "用途待补";
  const startEditing = () => {
    setDraft(purpose); setBaseline(purpose); setExpectedPurpose(item.annotation?.purpose || ""); setError(""); setEditing(true);
  };
  const save = async () => {
    setError("");
    try { await onSave(draft.trim(), expectedPurpose); setEditing(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "说明没有保存，请重试。"); }
  };
  return <div className="art-purpose">
    <header><span>具体用途</span>{canEdit && !editing ? <button type="button" className="art-purpose-edit" aria-label="编辑用途说明" title="编辑用途说明" onClick={startEditing}><PenLine size={17} /></button> : null}</header>
    <strong>{purposeLabel}</strong>
    {editing ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <textarea autoFocus aria-label="用途说明" rows={3} maxLength={1200} value={draft} disabled={saving} placeholder="补充一句用途或修改意见" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (!saving) setEditing(false); } }} />
      {error ? <p className="art-purpose-error" role="alert">{error}</p> : null}
      <footer><button type="button" disabled={saving} onClick={() => setEditing(false)}>取消</button><button type="submit" disabled={saving || draft.trim() === baseline}>{saving ? <LoaderCircle className="is-spinning" size={15} /> : <Save size={15} />}保存说明</button></footer>
    </form> : purpose ? <p>{purpose}</p> : canEdit ? <button type="button" className="art-purpose-add" onClick={startEditing}>补充说明</button> : null}
  </div>;
}

function DetailPanel({ project, item, displayMode, canManage, canMark, canAnnotate, saving, attentionSaving, onClose, onFullscreen, onStartCompare, onOpenLocal, onMove, onSaveAnnotation, onToggleAttention }: {
  project: NonNullable<ArtSnapshot["project"]>; item: ArtItem; displayMode: boolean; canManage: boolean; canMark: boolean; canAnnotate: boolean; saving: boolean;
  attentionSaving: boolean;
  onClose: () => void; onFullscreen: () => void; onStartCompare: (item: ArtItem) => void; onOpenLocal: (action: "open" | "reveal") => void; onMove: (zone: ZoneId) => void;
  onSaveAnnotation: SavePurpose; onToggleAttention: (item: ArtItem) => void;
}) {
  const zone = item.zone as ZoneId;
  return <div className="art-detail-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="art-detail" role="dialog" aria-modal="true" aria-label={`素材详情 ${item.name}`}>
    <header>{canMark ? <button type="button" className="art-detail-attention" aria-label={item.annotation?.needsAttention ? `取消待处理标记 ${item.name}` : `标记待处理 ${item.name}`} title="标记待处理" aria-pressed={item.annotation?.needsAttention === true} disabled={attentionSaving || saving} onClick={() => onToggleAttention(item)}><AttentionCircle marked={item.annotation?.needsAttention === true} /></button> : null}<div><span>{zoneLabel(item.zone)}</span><h2>{item.name}</h2></div><button type="button" onClick={onClose} aria-label="关闭素材详情"><X size={19} /></button></header>
    <section className="art-detail-primary"><PurposeEditor key={item.id} item={item} canEdit={canAnnotate} saving={saving || attentionSaving} onSave={onSaveAnnotation} /><div><span>所属分类</span><strong>{zoneLabel(item.zone)}</strong><p>{compactArtFolder(item)}</p></div></section>
    <button type="button" className="art-detail-image" onClick={onFullscreen} aria-label={`全屏查看 ${item.name}`}><img src={thumbUrl(project.id, item.id, "preview")} alt={item.name} /><span><Maximize2 size={15} />轻量预览 · 点击全屏</span></button>
    <ProjectAssetRelations key={item.id} projectId={project.id} assetPath={item.relativePath} displayMode={displayMode} />
    <div className="art-image-actions"><button type="button" onClick={() => onStartCompare(item)}><Columns2 size={16} />与另一张对比</button><button type="button" onClick={onFullscreen}><Maximize2 size={16} />全屏查看</button>{canManage ? <button type="button" disabled={saving} onClick={() => onOpenLocal("open")}><ImageIcon size={16} />打开原图</button> : null}{canManage ? <button type="button" disabled={saving} onClick={() => onOpenLocal("reveal")}><FolderOpen size={16} />在 Finder 中显示</button> : null}</div>
    <div className="art-detail-facts"><section><span>文件事实</span><dl><div><dt>尺寸</dt><dd>{item.width && item.height ? `${item.width} × ${item.height} px` : "未能读取"}</dd></div><div><dt>格式</dt><dd>{item.format}</dd></div><div><dt>透明</dt><dd>{alphaLabel(item.hasAlpha)}</dd></div><div><dt>大小</dt><dd>{fmtBytes(item.bytes)}</dd></div><div><dt>Git</dt><dd>{gitLabel(item.gitStatus)}</dd></div><div><dt>更新</dt><dd>{fmtDateTime(item.modifiedAt)}</dd></div></dl></section><section><span>工程事实</span><dl><div><dt>区域</dt><dd>{zoneLabel(item.zone)}</dd></div><div><dt>目录</dt><dd>{item.scanRootLabel}{item.subdirectory ? ` / ${item.subdirectory}` : ""}</dd></div><div><dt>引用</dt><dd>{referenceLabel(item.referenceStatus)}</dd></div><div><dt>重复</dt><dd>{item.duplicate ? `发现 ${item.duplicateCount} 份同内容文件` : "未发现同内容文件"}</dd></div></dl></section></div>
    <section className="art-reference-list"><span>素材地址</span><code>{item.relativePath}</code></section>
    {item.references?.length ? <section className="art-reference-list"><span>实际使用位置</span>{item.references.map((reference) => <code key={reference.path}>{reference.path}</code>)}</section> : null}
    {canManage && item.zone !== "platform" ? <section className="art-move-panel"><span>移动位置</span><p>位置表示认可状态，引用表示是否正在使用；候选素材可以实装，使用中的文件不会从 Godot 外部强移。</p><div>{(["formal", "candidate", "archive"] as ZoneId[]).filter((target) => target !== zone).map((target) => <button type="button" disabled={saving} onClick={() => onMove(target)} key={target}>{ZONE_META[target].action}</button>)}</div></section> : <p className="art-mobile-readonly"><ShieldCheck size={15} />可在这里补充说明和标记待处理；文件移动与本机打开按项目权限提供。</p>}
    {item.duplicateOf ? <p className="art-detail-note"><AlertTriangle size={15} />同内容文件：{item.duplicateOf}</p> : null}
    <section className="art-real-path"><span>真实路径</span><code>{project.root}/{item.relativePath}</code></section>
  </aside></div>;
}

function SemanticTreeBranch({ nodes, selectedPath, depth = 0, onSelect }: {
  nodes: SemanticTreeNode[]; selectedPath: string; depth?: number; onSelect: (path: string) => void;
}) {
  return <div className="art-semantic-tree-level">{nodes.map((node) => <div className="art-semantic-tree-node" key={node.path}>
    <button type="button" aria-current={selectedPath === node.path ? "page" : undefined} style={{ "--semantic-depth": depth } as CSSProperties} onClick={() => onSelect(node.path)}>
      <span>{node.label}</span><small>{node.entityCount ? `${node.entityCount} 项` : `${node.assetCount} 图`}</small>
    </button>
    {node.children.length ? <SemanticTreeBranch nodes={node.children} selectedPath={selectedPath} depth={depth + 1} onSelect={onSelect} /> : null}
  </div>)}</div>;
}

const CopyAssetFileName = memo(function CopyAssetFileName({ value }: { value: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => { if (resetTimer.current !== null) window.clearTimeout(resetTimer.current); }, []);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const input = document.createElement("textarea");
        input.value = value; input.style.position = "fixed"; input.style.opacity = "0";
        document.body.appendChild(input); input.select();
        if (!document.execCommand("copy")) throw new Error("copy unavailable");
        input.remove();
      }
      setStatus("copied");
    } catch { setStatus("error"); }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setStatus("idle"), 1600);
  };
  return <button type="button" className={`art-semantic-file-name${status === "copied" ? " is-copied" : status === "error" ? " is-error" : ""}`} onClick={() => void copy()} title={`点击复制：${value}`} aria-label={`复制文件名 ${value}`}>
    <code>{value}</code><span aria-live="polite">{status === "copied" ? "已复制" : status === "error" ? "复制失败" : <Copy size={13} />}</span>
  </button>;
});

function SemanticAssetButton({ projectId, asset, relationLabel, canMark, attentionSavingId, onOpen, onToggleAttention }: {
  projectId: string; asset: SemanticAsset; relationLabel?: string; canMark: boolean; attentionSavingId: string;
  onOpen: (item: ArtItem) => void; onToggleAttention: (item: ArtItem) => void;
}) {
  const item = asset.libraryItem;
  const purpose = relationLabel || item?.annotation?.subject?.trim() || item?.annotation?.form?.trim() || (asset.usageStatus === "used" ? "工程使用素材" : "用途待补");
  const purposeDetail = item ? visiblePurpose(item) : "";
  const marked = item?.annotation?.needsAttention === true;
  return <article className={`art-semantic-asset${marked ? " is-attention" : ""}`}>
    <button type="button" className="art-semantic-asset-preview" disabled={!item} onClick={() => item && onOpen({ ...item, displayPurpose: purpose })} title={asset.path} aria-label={`查看 ${asset.fileName}，${purpose}`}>
      <span className="art-semantic-asset-image">{item ? <img loading="lazy" decoding="async" src={thumbUrl(projectId, item.id, "tiny")} alt="" /> : <ImageIcon size={22} />}</span>
    </button>
    <div className="art-semantic-asset-body">
      {item ? <header className="art-semantic-asset-actions">
        {canMark ? <button type="button" className="art-semantic-asset-attention" aria-pressed={marked} disabled={attentionSavingId === item.id} onClick={() => onToggleAttention(item)} title={marked ? "取消关注" : "关注这张素材"} aria-label={marked ? `取消关注 ${asset.fileName}` : `关注 ${asset.fileName}`}><AttentionCircle marked={marked} /></button> : null}
        <button type="button" className="art-semantic-asset-edit" title="编辑说明" aria-label={`编辑说明 ${asset.fileName}`} onClick={() => onOpen({ ...item, displayPurpose: purpose, editPurpose: true })}><PenLine size={17} /></button>
      </header> : null}
      <button type="button" className="art-semantic-asset-summary" disabled={!item} onClick={() => item && onOpen({ ...item, displayPurpose: purpose })}>
        <strong>{purpose}</strong><p className={purposeDetail ? undefined : "is-placeholder"}>{purposeDetail || "添加说明"}</p>
      </button>
      <CopyAssetFileName value={asset.fileName} />
    </div>
  </article>;
}

function PurposeCandidates({label,count,children}: {label:string;count:number;children:React.ReactNode}) {
  const [open,setOpen] = useState(false);
  return <details className="art-purpose-fold" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}<strong>{count}</strong></summary>{open ? children : null}
  </details>;
}

function SemanticEntityCard({ projectId, entity, assetsById, canMark, attentionSavingId, onOpen, onToggleAttention }: {
  projectId: string; entity: SemanticEntity; assetsById: Map<string, SemanticAsset>; canMark: boolean; attentionSavingId: string;
  onOpen: (item: ArtItem) => void; onToggleAttention: (item: ArtItem) => void;
}) {
  const relations = entity.assetRelations.flatMap((relation) => {
    const asset = assetsById.get(relation.assetId);
    return asset ? [{ relation, asset }] : [];
  });
  return <article className="art-semantic-entity">
    <header className="art-semantic-entity-title"><h4>{entity.displayName || "素材"}</h4><small>{relations.length} 件</small></header>
    {relations.length > 4 ? <small className="art-semantic-more">共 {relations.length} 张本用途素材，可在列表中滑动查看</small> : null}
    {(["formal", "candidate", "archive"] as const).map(zone => {
      const rows = relations.filter(({asset}) => asset.libraryItem?.zone === zone || asset.sourceZones.includes(zone));
      const content = rows.length ? <div className="art-semantic-entity-assets">{rows.map(({relation,asset}) => <SemanticAssetButton projectId={projectId} asset={asset} relationLabel={RELATION_ROLE_LABELS[relation.role] || relation.role || "本用途素材"} canMark={canMark} attentionSavingId={attentionSavingId} onOpen={onOpen} onToggleAttention={onToggleAttention} key={asset.id} />)}</div> : <p className="art-semantic-empty-relation">{zone === "formal" ? "还没有正式素材。" : "暂无素材"}</p>;
      return zone === "formal" ? <section className="art-purpose-formal" key={zone}>{content}</section>
        : rows.length ? <PurposeCandidates key={zone} label={zoneLabel(zone)} count={rows.length}>{content}</PurposeCandidates> : null;
    })}
    <details className="art-semantic-technical"><summary>查看素材属性与路径</summary><code>{entity.gameId || "无 ID"}</code><small>{entity.sourceFiles?.[0] || "暂未登记来源路径"}</small></details>
  </article>;
}

function SemanticView({ projectId, zone, displayMode, canMark, revision, attentionSavingId, onOpen, onToggleAttention }: {
  projectId: string; zone: "" | ZoneId; displayMode: boolean; canMark: boolean; revision: number; attentionSavingId: string; onOpen: (item: ArtItem) => void;
  onToggleAttention: (item: ArtItem) => void;
}) {
  const [category, setCategory] = useState("");
  const [treeOpen, setTreeOpen] = useState(false);
  const [entityLimit, setEntityLimit] = useState(20);
  const [assetLimit, setAssetLimit] = useState(24);
  const [data, setData] = useState<SemanticSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setCategory(""); setTreeOpen(false); setData(null); setError(""); }, [projectId]);
  useEffect(() => { setEntityLimit(20); setAssetLimit(24); }, [category, projectId, zone]);
  useEffect(() => {
    let disposed = false;
    const cacheKey = `${projectId}:${displayMode ? "display" : "private"}:${category}`;
    const cached = semanticSnapshotCache.get(cacheKey);
    if (cached) setData(cached);
    setLoading(!cached);
    setError("");
    const params = new URLSearchParams({ project: projectId, limit: "180" });
    if (displayMode) params.set("display", "1");
    if (category) params.set("category", category);
    void jsonFetch<SemanticSnapshot>(`/api/tools/art-library/semantic?${params}`)
      .then((next) => { semanticSnapshotCache.set(cacheKey, next); if (!disposed) setData(next); })
      .catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : "中文内容索引读取失败"); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [category, displayMode, projectId, revision]);
  const visibleData = data?.project.id === projectId ? data : null;
  const filteredAssets = useMemo(() => (visibleData?.assets || []).filter((asset) => !zone || asset.libraryItem?.zone === zone || asset.sourceZones?.includes(zone)), [visibleData?.assets, zone]);
  const assetsById = useMemo(() => new Map(filteredAssets.map((asset) => [asset.id, asset])), [filteredAssets]);
  const filteredEntities = useMemo(() => (visibleData?.entities || []).filter((entity) => !zone || entity.assetRelations.some((relation) => assetsById.has(relation.assetId))), [assetsById, visibleData?.entities, zone]);
  const relatedAssetIds = useMemo(() => new Set(filteredEntities.flatMap((entity) => entity.assetRelations.filter((relation) => assetsById.has(relation.assetId)).map((relation) => relation.assetId))), [assetsById, filteredEntities]);
  const standaloneAssets = useMemo(() => filteredAssets.filter((asset) => !relatedAssetIds.has(asset.id)), [filteredAssets, relatedAssetIds]);
  const visibleEntities = filteredEntities.slice(0, entityLimit);
  const visibleStandaloneAssets = standaloneAssets.slice(0, assetLimit);
  if (error && !visibleData) return <div className="art-library-error" role="alert"><AlertTriangle size={18} /><strong>这个项目还没有可用的中文内容索引</strong><span>{error}。素材目录仍可继续使用。</span></div>;
  if (!visibleData) return <Empty>正在读取项目中文内容索引。</Empty>;
  const selectCategory = (path: string) => { setCategory(path); setTreeOpen(false); };
  return <div className="art-semantic-view" aria-busy={loading}>
    <aside className={`art-semantic-tree${treeOpen ? " is-open" : ""}`}>
      <header><div><span>用途</span><strong>{visibleData.project.name}</strong><small>{visibleData.tree.reduce((sum, node) => sum + node.entityCount, 0)} 个用途 · {visibleData.tree.reduce((sum, node) => sum + node.assetCount, 0)} 件素材</small></div><button type="button" className="art-semantic-tree-toggle" aria-expanded={treeOpen} onClick={() => setTreeOpen((current) => !current)}><span>{visibleData.selection.label}</span><ChevronRight size={16} /></button></header>
      <nav aria-label="中文素材分类"><SemanticTreeBranch nodes={visibleData.tree} selectedPath={visibleData.selection.path} onSelect={selectCategory} /></nav>
    </aside>
    <main className="art-semantic-content">
      <header className="art-semantic-heading">
        <nav aria-label="当前分类路径">{visibleData.selection.breadcrumbs.map((crumb, index) => <span key={crumb.path}>{index ? <ChevronRight size={13} /> : null}<button type="button" disabled={crumb.path === visibleData.selection.path} onClick={() => selectCategory(crumb.path)}>{crumb.label}</button></span>)}</nav>
        <div><h3>{visibleData.selection.label}</h3><p>先按平台或角色找用途，再看对应素材。</p></div>
        <dl><div><dt>用途</dt><dd>{zone ? filteredEntities.length : visibleData.selection.entityCount}</dd></div><div><dt>素材</dt><dd>{zone ? filteredAssets.length : visibleData.selection.assetCount}</dd></div></dl>
      </header>
      {visibleData.selection.children.length ? <section className="art-semantic-children" aria-label="下级分类">{visibleData.selection.children.map((child) => <button type="button" onClick={() => selectCategory(child.path)} key={child.path}><span>{child.label}</span><small>{child.entityCount ? `${child.entityCount} 个用途` : `${child.assetCount} 张素材`}</small><ChevronRight size={16} /></button>)}</section> : null}
      <section className="art-semantic-section">
        <header><div><h3>{filteredEntities.length ? "素材" : "本类暂无素材"}</h3></div><small>{zone ? filteredAssets.length : visibleData.selection.assetCount} 件</small></header>
        {filteredEntities.length ? <div className="art-semantic-entities">{visibleEntities.map((entity) => <SemanticEntityCard projectId={projectId} entity={entity} assetsById={assetsById} canMark={canMark} attentionSavingId={attentionSavingId} onOpen={onOpen} onToggleAttention={onToggleAttention} key={entity.id} />)}</div> : <Empty>{zone ? "这个状态下暂无素材。" : "这个分类目前没有素材。"}</Empty>}
        {filteredEntities.length > visibleEntities.length ? <button type="button" className="art-semantic-show-more" onClick={() => setEntityLimit((current) => current + 20)}>再显示 {Math.min(20, filteredEntities.length - visibleEntities.length)} 个对象</button> : null}
        {visibleData.truncated.entities ? <p className="art-semantic-truncated">项目对象较多，请从中文内容树选择更具体的分类。</p> : null}
      </section>
      {standaloneAssets.length ? <section className="art-semantic-section">
        <header><div><span>分类素材</span><h3>尚未绑定具体对象</h3></div><small>{standaloneAssets.length}{visibleData.truncated.assets ? "+" : ""} 张</small></header>
        <div className="art-semantic-loose-assets">{visibleStandaloneAssets.map((asset) => <SemanticAssetButton projectId={projectId} asset={asset} canMark={canMark} attentionSavingId={attentionSavingId} onOpen={onOpen} onToggleAttention={onToggleAttention} key={asset.id} />)}</div>
        {standaloneAssets.length > visibleStandaloneAssets.length ? <button type="button" className="art-semantic-show-more" onClick={() => setAssetLimit((current) => current + 24)}>再显示 {Math.min(24, standaloneAssets.length - visibleStandaloneAssets.length)} 张素材</button> : null}
        {visibleData.truncated.assets ? <p className="art-semantic-truncated">本类素材较多，已先显示前 180 张；选择下级分类可继续缩小范围。</p> : null}
      </section> : null}
    </main>
  </div>;
}

function specificationLabel(slot: PlatformSlot) {
  if (slot.width && slot.height) return `${slot.width}×${slot.height}`;
  if (slot.eitherWidth || slot.eitherHeight) return `${slot.eitherWidth || "—"} 宽或 ${slot.eitherHeight || "—"} 高`;
  if (slot.minWidth && slot.minHeight) return `至少 ${slot.minWidth}×${slot.minHeight}`;
  return slot.formats?.join("/").toUpperCase() || "按平台规则";
}
function PlatformView({ projectId, sets, query, system, compareMode, selectedIds, onOpen, onToggle }: { projectId: string; sets: PlatformSet[]; query: string; system: SystemFilter; compareMode: boolean; selectedIds: Set<string>; onOpen: (item: ArtItem) => void; onToggle: (item: ArtItem) => void }) {
  if (!sets.length) return <Empty>这个项目还没有登记平台交付集合。</Empty>;
  return <div className="art-platform-list">{sets.map((set) => <section className="art-platform" key={set.id}><header><div><span>平台规格 · {set.verifiedAt || "未核对"}</span><h3>{set.name}</h3><p>{set.note}</p></div>{set.source ? <ExternalSourceDisclosure label="规格来源" sources={[{ label: set.source.label, url: set.source.url }]} /> : null}</header><div className="art-platform-slots">{set.slots.map((slot) => { const candidates = slot.candidates.filter((item) => matchesFactFilter(item, system, query)); return <article className="art-platform-slot" key={slot.id}><div><span>{slot.required ? "必需" : "可选"}</span><strong>{slot.name}</strong><small>{specificationLabel(slot)}</small></div><div className="art-platform-checks"><span className={slot.checks.specification === "pass" ? "pass" : "missing"}>{slot.checks.specification === "pass" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{slot.checks.specification === "pass" ? "有合规候选" : "缺少合规文件"}</span><span><CircleHelp size={15} />角色待确认</span><span><CircleHelp size={15} />Logo 待确认</span><span><CircleHelp size={15} />一致性待确认</span></div>{candidates.length ? <div className={`art-platform-candidates${compareMode ? " is-compare-mode" : ""}`}>{candidates.map((item) => <button type="button" aria-pressed={compareMode ? selectedIds.has(item.id) : undefined} className={selectedIds.has(item.id) ? "is-selected" : ""} onClick={() => compareMode ? onToggle(item) : onOpen(item)} key={item.id}><img src={thumbUrl(projectId, item.id)} alt="" /><span>{item.name}</span></button>)}</div> : <small>{query || system ? "这个规格没有符合当前筛选的文件。" : "规格符合也不会自动进入正式素材。"}</small>}</article>; })}</div></section>)}</div>;
}

function PlatformSection({ projectId, sets, query, system, compareMode, selectedIds, onOpen, onToggle }: { projectId: string; sets: PlatformSet[]; query: string; system: SystemFilter; compareMode: boolean; selectedIds: Set<string>; onOpen: (item: ArtItem) => void; onToggle: (item: ArtItem) => void }) {
  const itemCount = new Set(sets.flatMap((set) => set.slots.flatMap((slot) => slot.candidates.filter((item) => matchesFactFilter(item, system, query)).map((item) => item.id)))).size;
  return <section className="art-zone art-zone-platform" id="art-zone-platform">
    <header className="art-zone-header"><span className="art-zone-icon"><Layers size={18} /></span><div><h3>平台交付</h3><p>按平台规格检查交付文件，不改变素材的认可状态</p></div><strong>{itemCount}<small> 件</small></strong></header>
    <PlatformView projectId={projectId} sets={sets} query={query} system={system} compareMode={compareMode} selectedIds={selectedIds} onOpen={onOpen} onToggle={onToggle} />
  </section>;
}

export default function ArtLibraryView({ active, displayMode = false }: { active: boolean; displayMode?: boolean }) {
  const [initialLocation] = useState(readAssetLibraryLocation);
  const [data, setData] = useState<ArtSnapshot | null>(null); const [projectId, setProjectId] = useState(initialLocation.projectId);
  const [viewMode, setViewMode] = useState<ArtViewMode>(initialLocation.viewMode);
  const [assetKind, setAssetKind] = useState<AssetKind>(initialLocation.assetKind);
  const [artZone, setArtZone] = useState<"" | ZoneId>("");
  const [query, setQuery] = useState(""); const deferredQuery = useDeferredValue(query); const [system, setSystem] = useState<SystemFilter>(""); const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState<ArtItem | null>(null); const [selectedItems, setSelectedItems] = useState<ArtItem[]>([]);
  const [fullscreen, setFullscreen] = useState<ArtItem | null>(null); const [compareMode, setCompareMode] = useState(false); const [comparing, setComparing] = useState(false);
  const [moveTarget, setMoveTarget] = useState<ZoneId | null>(null);
  const [attentionSavingId, setAttentionSavingId] = useState("");
  const [loading, setLoading] = useState(false); const [checking, setChecking] = useState(false); const [saving, setSaving] = useState(false); const [revision, setRevision] = useState(0); const [error, setError] = useState("");
  const canManage = useMemo(localLoopback, []); const compactPreviews = useCompactPreviews(); const selectedIds = useMemo(() => new Set(selectedItems.map((item) => item.id)), [selectedItems]);
  const comparisonOrderById = useMemo(() => new Map(selectedItems.map((item, index) => [item.id, index + 1])), [selectedItems]);
  const searchInputRef = useRef<HTMLInputElement>(null); const refreshInFlight = useRef(false); const requestSequence = useRef(0); const lastRefresh = useRef(new Map<string, number>());

  const load = useCallback(async (refresh = false, background = false) => {
    if (!active || (refresh && refreshInFlight.current)) return;
    const sequence = ++requestSequence.current;
    if (refresh) refreshInFlight.current = true;
    if (background) setChecking(true); else setLoading(true);
    if (!background) setError("");
    const params = new URLSearchParams({ project: projectId, view: "files", limit: "24" });
    if (refresh) params.set("refresh", "incremental");
    if (displayMode) params.set("display", "1");
    try {
      const next = await jsonFetch<ArtSnapshot>(`/api/tools/art-library?${params}`);
      if (sequence !== requestSequence.current) return;
      setData(next);
      if (refresh) { lastRefresh.current.set(projectId, Date.now()); setRevision((value) => value + 1); }
      if (!next.projects.some((item) => item.id === projectId && item.configured)) { const fallback = next.projects.find((item) => item.configured)?.id; if (fallback) setProjectId(fallback); }
    } catch (reason) {
      if (!background && sequence === requestSequence.current) setError(reason instanceof Error ? reason.message : "读不到项目素材库");
    } finally {
      if (refresh) refreshInFlight.current = false;
      if (background) setChecking(false); else setLoading(false);
    }
  }, [active, displayMode, projectId]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void (async () => { await load(); if (!disposed) await load(true, true); })();
    return () => { disposed = true; };
  }, [active, load]);
  useEffect(() => {
    if (!active) return;
    const onFocus = () => { if (Date.now() - (lastRefresh.current.get(projectId) || 0) >= 30_000) void load(true, true); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, load, projectId]);
  useEffect(() => { if (searchOpen) searchInputRef.current?.focus(); }, [searchOpen]);
  useEffect(() => {
    if (!active) return;
    try { window.localStorage.setItem(ASSET_LIBRARY_LOCATION_KEY, JSON.stringify({ projectId, assetKind, viewMode } satisfies AssetLibraryLocation)); } catch { /* Private browsing may disable local storage. */ }
  }, [active, assetKind, projectId, viewMode]);
  useEffect(() => { setSelected(null); setSelectedItems([]); setFullscreen(null); setCompareMode(false); setComparing(false); setSystem(""); setQuery(""); setSearchOpen(false); }, [projectId, assetKind]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key !== "Escape") return; if (fullscreen) setFullscreen(null); else if (comparing) setComparing(false); else if (moveTarget) setMoveTarget(null); else if (selected) setSelected(null); else if (compareMode) { setCompareMode(false); setSelectedItems([]); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [compareMode, comparing, fullscreen, moveTarget, selected]);

  const toggleItem = useCallback((item: ArtItem) => setSelectedItems((current) => current.some((candidate) => candidate.id === item.id) ? current.filter((candidate) => candidate.id !== item.id) : [...current, item]), []);
  const enterCompareMode = useCallback((first?: ArtItem) => { setSelected(null); setSelectedItems(first ? [first] : []); setComparing(false); setCompareMode(true); }, []);
  const exitCompareMode = useCallback(() => { setComparing(false); setSelectedItems([]); setCompareMode(false); }, []);
  const toggleCompareItem = useCallback((item: ArtItem) => {
    const exists = selectedItems.some((candidate) => candidate.id === item.id);
    const next = exists ? selectedItems.filter((candidate) => candidate.id !== item.id) : selectedItems.length >= 2 ? [selectedItems[0], item] : [...selectedItems, item];
    setSelectedItems(next);
    if (!exists && next.length === 2) setComparing(true);
  }, [selectedItems]);
  const moveItems = selectedItems.length ? selectedItems : selected ? [selected] : [];
  const performMove = async (destination: MoveDestination) => {
    if (!data?.project || !moveTarget || !moveItems.length || !canManageProject) return; setSaving(true); setError("");
    try { await jsonFetch("/api/tools/art-library/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: data.project.id, assetIds: moveItems.map((item) => item.id), expected: Object.fromEntries(moveItems.map(item => [item.id, {hash: `sha256:${item.hash}`, path:item.relativePath, zone:item.zone}])), targetRootId: destination.rootId, targetSubdirectory: destination.subdirectory, preserveSubdirectories: destination.preserveSubdirectories === true }) }); setMoveTarget(null); setSelected(null); setSelectedItems([]); await load(); setRevision((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "素材没有移动"); } finally { setSaving(false); }
  };
  const undoLastMove = async () => {
    if (!data?.project || !data.lastMove || !canManage) return; setSaving(true); setError("");
    try { await jsonFetch("/api/tools/art-library/move/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: data.project.id, batchId: data.lastMove.batchId }) }); await load(); setRevision((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "最近一次移动无法撤销"); } finally { setSaving(false); }
  };
  const openLocal = async (action: "open" | "reveal") => {
    if (!data?.project || !selected || !canManage) return; setSaving(true); setError("");
    try { await jsonFetch("/api/tools/art-library/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: data.project.id, assetId: selected.id, action }) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Mac 没有打开这个素材"); } finally { setSaving(false); }
  };
  const saveAnnotation: SavePurpose = async (purpose, expectedPurpose) => {
    if (!data?.project || !selected) throw new Error("请重新打开素材后再保存。");
    setSaving(true);
    try {
      const result = await jsonFetch<{ annotation: ArtAnnotation; assetUid: string }>("/api/tools/art-library/annotation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: data.project.id, assetId: selected.id, mode: "purpose", purpose, expectedPurpose }) });
      const updated = { ...selected, assetUid: result.assetUid, annotation: result.annotation };
      setSelected((current) => current?.id === selected.id ? updated : current);
      setSelectedItems((current) => current.map((item) => item.id === selected.id ? updated : item));
      for (const cacheKey of semanticSnapshotCache.keys()) if (cacheKey.startsWith(`${data.project.id}:`)) semanticSnapshotCache.delete(cacheKey);
      setRevision((value) => value + 1);
    } finally { setSaving(false); }
  };
  const toggleAttention = async (item: ArtItem) => {
    if (!data?.project) return;
    setAttentionSavingId(item.id); setError("");
    try {
      const result = await jsonFetch<{ annotation: ArtAnnotation; assetUid: string }>("/api/tools/art-library/attention", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: data.project.id, assetId: item.id, needsAttention: item.annotation?.needsAttention !== true }) });
      const updated = { ...item, assetUid: result.assetUid, annotation: result.annotation };
      setSelected((current) => current?.id === item.id ? updated : current);
      setSelectedItems((current) => current.map((candidate) => candidate.id === item.id ? updated : candidate));
      for (const cacheKey of semanticSnapshotCache.keys()) if (cacheKey.startsWith(`${data.project.id}:`)) semanticSnapshotCache.delete(cacheKey);
      setRevision((value) => value + 1);
      await load(false, true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "待处理标记没有保存"); } finally { setAttentionSavingId(""); }
  };
  const project = data?.project;
  const canManageProject = !displayMode && (canManage || projectId === "secretary-visual-assets") && data?.policy?.readOnly !== true;
  const canMarkProject = canManageProject || data?.policy?.attentionWritable === true;
  const canAnnotateProject = data?.policy?.readOnly !== true || data?.policy?.annotationWritable === true;
  const zonesById = new Map((data?.zones || []).map((zone) => [zone.id, zone]));
  const artZoneTotal = (["formal", "candidate", "archive"] as ZoneId[]).reduce((total, zone) => total + (zonesById.get(zone)?.count || 0), 0);
  const factCount = (filter: SystemFilter) => filter === "using" ? data?.stats?.using || 0
    : filter === "attention" ? data?.stats?.attention || 0
      : filter === "unreferenced" ? data?.stats?.unreferenced || 0
      : filter === "duplicate" ? data?.stats?.duplicates || 0
        : filter === "unknown" ? data?.stats?.referenceUnknown || 0
          : data?.stats?.total || 0;
  const factButtons = () => SYSTEM_FILTERS.map((item) => <button type="button" role="tab" aria-selected={system === item.id} className={system === item.id ? "active" : ""} onClick={(event) => {
    setSystem(item.id);
    const details = event.currentTarget.closest("details");
    if (details) { details.open = false; details.querySelector("summary")?.focus({ preventScroll: true }); }
  }} key={item.id}><span>{item.label}</span><strong>{factCount(item.id)}</strong></button>);
  return <div className="art-library-page">
    <section className="art-library-controls">
      <header className="art-project-heading"><div><span>素材项目</span><strong>选择要浏览或整理的素材库</strong></div><div><button type="button" disabled={loading || checking} onClick={() => { if (assetKind === "art") void load(true); else setRevision((value) => value + 1); }}>{loading || checking ? <LoaderCircle className="is-spinning" size={16} /> : <RefreshCw size={16} />}检查更新</button><small>{checking ? "正在后台更新" : data?.generatedAt ? `${fmtDateTime(data.generatedAt)} 美术索引` : "等待索引"}</small></div></header>
      <nav className="art-project-tabs" aria-label="选择素材项目" role="tablist">{data?.projects.map((item) => <button type="button" role="tab" aria-selected={item.id === projectId} className={item.id === projectId ? "active" : ""} disabled={!item.configured} onClick={() => setProjectId(item.id)} key={item.id}><span>{item.name}</span><small>{item.configured ? `${item.total} 张美术` : "尚未接入"}</small></button>)}</nav>
      {project ? <nav className="art-view-tabs art-kind-tabs" aria-label="素材类型">{([
        { id: "art", label: "美术", icon: ImageIcon }, { id: "font", label: "字体", icon: Type },
        { id: "text", label: "文本与本地化", icon: Languages }, { id: "audio", label: "音频", icon: AudioLines }, { id: "video", label: "视频", icon: Clapperboard },
      ] as const).map(({ id, label, icon: Icon }) => <button type="button" aria-pressed={assetKind === id} className={assetKind === id ? "active" : ""} onClick={() => setAssetKind(id)} key={id}><Icon size={17} /><span>{label}</span></button>)}</nav> : null}
      {project && assetKind === "art" ? <nav className="art-view-tabs" aria-label="素材视图" role="tablist"><button type="button" role="tab" aria-selected={viewMode === "semantic"} className={viewMode === "semantic" ? "active" : ""} onClick={() => { setViewMode("semantic"); exitCompareMode(); }}><FolderTree size={15} /><span>用途索引</span></button><button type="button" role="tab" aria-selected={viewMode === "library"} className={viewMode === "library" ? "active" : ""} onClick={() => setViewMode("library")}><Layers size={15} /><span>素材目录</span></button></nav> : null}
      {project && assetKind === "art" ? <nav className="project-assets-zones art-library-zone-tabs" aria-label="素材状态"><button type="button" className={!artZone ? "is-selected" : ""} aria-pressed={!artZone} onClick={() => setArtZone("")}><span>全部</span><small>{artZoneTotal}</small></button>{(["formal", "candidate", "archive"] as ZoneId[]).map((zone) => <button type="button" className={artZone === zone ? "is-selected" : ""} aria-pressed={artZone === zone} onClick={() => setArtZone(zone)} key={zone}><span>{zone === "formal" ? "正式素材" : zone === "candidate" ? "AI 候选素材" : "归档素材"}</span><small>{zonesById.get(zone)?.count || 0}</small></button>)}</nav> : null}
      {project && assetKind === "art" && viewMode === "library" ? <nav className="art-fact-tabs" aria-label="素材筛选与工具"><div className="art-fact-wide" role="tablist" aria-label="素材筛选">{factButtons()}</div><details className="art-fact-mobile" onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus({ preventScroll: true }); } }}><summary><span>筛选 · {SYSTEM_FILTERS.find((item) => item.id === system)?.label}</span><strong>{factCount(system)}</strong><ChevronDown size={16} aria-hidden="true"/></summary><div className="art-fact-options" role="tablist" aria-label="素材筛选">{factButtons()}</div></details><div className="art-fact-tools"><button type="button" className={`art-compare-mode-toggle${compareMode ? " active" : ""}`} aria-pressed={compareMode} onClick={() => compareMode ? exitCompareMode() : enterCompareMode()}><Columns2 size={17} /><span>{compareMode ? "退出对比" : "对比"}</span></button><div className={`art-search-control${searchOpen || query ? " active" : ""}`}><button type="button" className="art-search-toggle" aria-expanded={searchOpen} aria-label="搜索素材" title="搜索素材" onClick={() => setSearchOpen((value) => !value)}><Search size={17} /></button>{searchOpen ? <label className="art-search-popover"><Search size={16} /><input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名、目录或素材说明" /><button type="button" aria-label="清空并关闭搜索" onClick={() => { setQuery(""); setSearchOpen(false); }}><X size={15} /></button></label> : null}</div></div></nav> : null}
    </section>
    {assetKind === "art" && data?.lastMove && canManage ? <div className="art-undo-banner"><span>最近移动了 {data.lastMove.count} 件素材到{zoneLabel(data.lastMove.targetZone)}。</span><button type="button" disabled={saving} onClick={() => void undoLastMove()}><Undo2 size={15} />撤销最近移动</button></div> : null}
    {error ? <div className="art-library-error" role="alert"><AlertTriangle size={18} /><strong>这次操作没有完成</strong><span>{error}</span></div> : null}
    {loading && !data ? <Empty>正在读取持久索引。</Empty> : null}
    <ProjectAssetsView projectId={projectId} kind={assetKind === "art" ? "font" : assetKind} active={active && project?.id === projectId && assetKind !== "art"} refreshKey={revision} displayMode={displayMode} />
    {project && assetKind === "art" && viewMode === "semantic" ? <SemanticView projectId={project.id} zone={artZone} displayMode={displayMode} canMark={canMarkProject} revision={revision} attentionSavingId={attentionSavingId} onOpen={compareMode ? toggleCompareItem : setSelected} onToggleAttention={(item) => void toggleAttention(item)} /> : null}
    {project && assetKind === "art" && viewMode === "library" ? <div className={`art-zones${artZone ? "" : " is-all"}`}>{(["formal", "candidate"] as ZoneId[]).filter((id) => !artZone || artZone === id).map((id) => zonesById.get(id)).filter((zone): zone is ArtZone => Boolean(zone)).map((zone) => <ZoneSection zone={zone} projectId={project.id} displayMode={displayMode} query={deferredQuery} system={system} revision={revision} selectedIds={selectedIds} comparisonOrderById={comparisonOrderById} compareMode={compareMode} canMark={canMarkProject} canAnnotate={canAnnotateProject} compactPreviews={compactPreviews} attentionSavingId={attentionSavingId} onToggle={compareMode ? toggleCompareItem : toggleItem} onOpen={setSelected} onToggleAttention={(item) => void toggleAttention(item)} key={zone.id} />)}{!artZone ? <PlatformSection projectId={project.id} sets={data?.platformSets || []} query={deferredQuery} system={system} compareMode={compareMode} selectedIds={selectedIds} onOpen={setSelected} onToggle={toggleCompareItem} /> : null}{(!artZone || artZone === "archive") && zonesById.get("archive") ? <ZoneSection zone={zonesById.get("archive")!} projectId={project.id} displayMode={displayMode} query={deferredQuery} system={system} revision={revision} selectedIds={selectedIds} comparisonOrderById={comparisonOrderById} compareMode={compareMode} canMark={canMarkProject} canAnnotate={canAnnotateProject} compactPreviews={compactPreviews} attentionSavingId={attentionSavingId} onToggle={compareMode ? toggleCompareItem : toggleItem} onOpen={setSelected} onToggleAttention={(item) => void toggleAttention(item)} /> : null}</div> : null}
    {project && compareMode ? <CompareTray projectId={project.id} items={selectedItems} onRemove={toggleCompareItem} onShow={() => setComparing(true)} onClear={() => setSelectedItems([])} onExit={exitCompareMode} /> : selectedItems.length ? <div className="art-bulk-bar"><span><strong>{selectedItems.length}</strong> 件已选</span><div>{canManageProject ? (["formal", "candidate", "archive"] as ZoneId[]).map((zone) => <button type="button" onClick={() => setMoveTarget(zone)} disabled={selectedItems.every((item) => item.zone === zone)} key={zone}>{ZONE_META[zone].action}</button>) : null}<button type="button" onClick={() => setSelectedItems([])}>取消选择</button></div></div> : null}
    {project && selected ? <DetailPanel project={project} item={selected} displayMode={displayMode} canManage={canManageProject} canMark={canMarkProject} canAnnotate={canAnnotateProject} saving={saving} attentionSaving={attentionSavingId === selected.id} onClose={() => setSelected(null)} onFullscreen={() => setFullscreen(selected)} onStartCompare={enterCompareMode} onOpenLocal={(action) => void openLocal(action)} onMove={setMoveTarget} onSaveAnnotation={saveAnnotation} onToggleAttention={(item) => void toggleAttention(item)} /> : null}
    {project && fullscreen ? <FullscreenViewer projectId={project.id} item={fullscreen} onClose={() => setFullscreen(null)} /> : null}
    {project && comparing && selectedItems.length === 2 ? <CompareViewer projectId={project.id} items={selectedItems as [ArtItem, ArtItem]} onClose={() => setComparing(false)} onReset={() => { setComparing(false); setSelectedItems([]); }} /> : null}
    {moveTarget && moveItems.length ? <MoveDialog key={moveTarget} items={moveItems} targetZone={moveTarget} destinations={data?.destinations?.[moveTarget] || []} saving={saving} onClose={() => setMoveTarget(null)} onConfirm={(destination) => void performMove(destination)} /> : null}
  </div>;
}
