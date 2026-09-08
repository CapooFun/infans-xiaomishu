import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  RefreshCw,
  Share2,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { Empty, fmtBytes, jsonFetch } from "../../page-shared";
import "./photo-library.css";

type PhotoView = "year" | "month" | "day" | "all";
type PhotoKind = "all" | "photo" | "video" | "live" | "screenshot";
type PhotoEntry = {
  id: string;
  name: string;
  folder: string;
  kind: "image" | "video" | "live";
  bytes: number;
  capturedAt: string;
  dateSource: "modified" | "folder";
  format: string;
  screenshot: boolean;
  hasMotion: boolean;
};
type PhotoPeriod = { key: string; count: number; coverIds: string[] };
type PhotoSnapshot = {
  available: boolean;
  name: string;
  generatedAt: string;
  total: number;
  libraryTotal: number;
  view: PhotoView;
  anchor: string;
  periods: PhotoPeriod[];
  entries: PhotoEntry[];
  nextCursor: string | null;
  availableYears: string[];
  availableMonths: string[];
  indexUpdate: {
    mode: "full" | "incremental" | "local";
    added: number;
    removed: number;
    changed: number;
  } | null;
  facets: {
    counts: Record<PhotoKind, number>;
    folders: Array<{ folder: string; count: number }>;
  };
};
type PhotoActionResult = {
  itemCount: number;
  fileCount: number;
  directory?: string;
  recoveryFolder?: string;
};
type PhotoActionMessage = { tone: "success" | "error"; text: string } | null;

const VIEW_LABELS: Array<{ id: PhotoView; label: string }> = [
  { id: "year", label: "年" },
  { id: "month", label: "月" },
  { id: "day", label: "日" },
  { id: "all", label: "全部" },
];
const KIND_LABELS: Array<{ id: PhotoKind; label: string }> = [
  { id: "all", label: "全部" },
  { id: "photo", label: "照片" },
  { id: "video", label: "视频" },
  { id: "live", label: "实况" },
  { id: "screenshot", label: "截屏" },
];
const PHOTO_LOAD_RETRY_DELAYS = [800, 1_800] as const;

function thumbUrl(id: string, size: "small" | "medium" | "large" = "small") {
  return `/api/tools/photo/thumb?id=${encodeURIComponent(id)}&size=${size}`;
}

function streamUrl(id: string, options: { motion?: boolean; download?: boolean } = {}) {
  const query = new URLSearchParams({ id });
  if (options.motion) query.set("motion", "1");
  if (options.download) query.set("download", "1");
  return `/api/tools/photo/stream?${query}`;
}

function monthLabel(key: string) {
  const month = Number(key.slice(5, 7));
  return Number.isFinite(month) ? `${month}月` : key;
}

function dayLabel(key: string) {
  const date = new Date(`${key}T12:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(date);
}

function groupByDay(entries: PhotoEntry[]) {
  const groups = new Map<string, PhotoEntry[]>();
  for (const entry of entries) {
    const key = entry.capturedAt.slice(0, 10);
    const current = groups.get(key);
    if (current) current.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.entries()];
}

function coverClass(month: number) {
  return `is-cover-${String(month).padStart(2, "0")}`;
}

function PeriodCover({ period, view }: { period: PhotoPeriod; view: "year" | "month" }) {
  if (view === "year") {
    return <span className={`photo-period-cover photo-year-art is-year-${period.key}`} aria-hidden="true" />;
  }
  const month = Number(period.key.slice(5, 7));
  return <span className={`photo-period-cover photo-period-art is-month ${coverClass(month)}`} aria-hidden="true" />;
}

function MediaBadge({ entry }: { entry: PhotoEntry }) {
  if (entry.kind === "live") return <span className="photo-media-badge"><span className="photo-live-dot" />实况</span>;
  if (entry.kind === "video") return <span className="photo-media-badge"><Video size={11} />视频</span>;
  if (entry.screenshot) return <span className="photo-media-badge">截屏</span>;
  return null;
}

function PhotoViewer({
  entry,
  previous,
  next,
  onPrevious,
  onNext,
  onClose,
}: {
  entry: PhotoEntry;
  previous: boolean;
  next: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const [motion, setMotion] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState("");

  useEffect(() => {
    setMotion(false);
    setDownloadMessage("");
  }, [entry.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft" && previous) onPrevious();
      if (event.key === "ArrowRight" && next) onNext();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [next, onClose, onNext, onPrevious, previous]);

  const downloadPhoto = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadMessage("");
    try {
      const result = await jsonFetch<PhotoActionResult>("/api/tools/photo/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [entry.id] }),
      });
      setDownloadMessage(`已导出 · ${result.fileCount} 个原件`);
    } catch (error) {
      setDownloadMessage(error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  const share = async () => {
    if (entry.bytes > 36 * 1024 * 1024 || typeof navigator.share !== "function") {
      window.location.assign(streamUrl(entry.id, { download: true }));
      return;
    }
    setSharing(true);
    try {
      const response = await fetch(streamUrl(entry.id));
      if (!response.ok) throw new Error("读取失败");
      const blob = await response.blob();
      const file = new File([blob], entry.name, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: entry.name });
      else window.location.assign(streamUrl(entry.id, { download: true }));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        window.location.assign(streamUrl(entry.id, { download: true }));
      }
    } finally {
      setSharing(false);
    }
  };

  return createPortal((
    <div className="photo-viewer" role="dialog" aria-modal="true" aria-label={`查看 ${entry.name}`}>
      <header>
        <div>
          <strong>{entry.name}</strong>
          <span>{dayLabel(entry.capturedAt.slice(0, 10))} · {entry.format} · {fmtBytes(entry.bytes)}</span>
        </div>
        <nav aria-label="照片操作">
          {downloadMessage ? <span className="photo-viewer-action-message" role="status">{downloadMessage}</span> : null}
          <button type="button" onClick={() => void share()} disabled={sharing} aria-label="分享">
            {sharing ? <LoaderCircle className="is-spinning" size={18} /> : <Share2 size={18} />}
          </button>
          <button type="button" className="photo-viewer-labeled-action" onClick={() => void downloadPhoto()} disabled={downloading} aria-label="下载照片">
            {downloading ? <LoaderCircle className="is-spinning" size={18} /> : <Download size={18} />}<span>下载照片</span>
          </button>
          <button type="button" className="photo-viewer-labeled-action" onClick={onClose} aria-label="关闭照片预览"><X size={20} /><span>关闭</span></button>
        </nav>
      </header>
      <div className="photo-viewer-stage">
        {motion || entry.kind === "video" ? (
          <video
            key={`${entry.id}-${motion ? "motion" : "video"}`}
            src={streamUrl(entry.id, { motion })}
            poster={motion ? thumbUrl(entry.id, "large") : undefined}
            controls
            autoPlay
            playsInline
            preload="metadata"
          />
        ) : (
          <img src={thumbUrl(entry.id, "large")} alt={entry.name} />
        )}
        <button className="photo-viewer-previous" type="button" onClick={onPrevious} disabled={!previous} aria-label="上一张"><ChevronLeft size={26} /></button>
        <button className="photo-viewer-next" type="button" onClick={onNext} disabled={!next} aria-label="下一张"><ChevronRight size={26} /></button>
      </div>
      {entry.kind === "live" ? (
        <button className="photo-motion-toggle" type="button" onClick={() => setMotion((value) => !value)}>
          {motion ? <Pause size={15} /> : <Play size={15} />}
          {motion ? "回到照片" : "播放实况"}
        </button>
      ) : null}
    </div>
  ), document.body);
}

export default function PhotoLibraryView({ active }: { active: boolean }) {
  const [view, setView] = useState<PhotoView>("month");
  const [anchor, setAnchor] = useState("");
  const [kind, setKind] = useState<PhotoKind>("all");
  const [folder, setFolder] = useState("");
  const [snapshot, setSnapshot] = useState<PhotoSnapshot | null>(null);
  const [entries, setEntries] = useState<PhotoEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [actionPending, setActionPending] = useState<"export" | "trash" | "">("");
  const [actionMessage, setActionMessage] = useState<PhotoActionMessage>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const forceRefreshRef = useRef(false);
  const announceRefreshRef = useRef(false);
  const [, startTransition] = useTransition();
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const requestUrl = (cursor = "", force = false) => {
    const requestView = view;
    const requestAnchor = anchor;
    const params = new URLSearchParams({ view: requestView, kind });
    if (requestAnchor) params.set("anchor", requestAnchor);
    if (folder) params.set("folder", folder);
    if (cursor) params.set("cursor", cursor);
    if (force) params.set("refresh", "incremental");
    return `/api/tools/photo?${params}`;
  };

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let cancelled = false;
    let retryTimer = 0;
    const force = forceRefreshRef.current;
    const announceRefresh = announceRefreshRef.current;
    forceRefreshRef.current = false;
    announceRefreshRef.current = false;
    setLoading(true);
    setCheckingUpdates(force);
    setError("");
    const load = (attempt = 0) => {
      void jsonFetch<PhotoSnapshot>(requestUrl("", force), { signal: controller.signal })
        .then((data) => {
          if (cancelled) return;
          setSnapshot(data);
          setEntries(data.entries);
          setNextCursor(data.nextCursor);
          if (!anchor && data.anchor) setAnchor(data.anchor);
          if (announceRefresh && data.indexUpdate) {
            const { added, removed, changed } = data.indexUpdate;
            const details = [`新增 ${added} 项`, `移除 ${removed} 项`];
            if (changed) details.push(`更新 ${changed} 项`);
            setActionMessage({ tone: "success", text: `已检查发生变化的月份：${details.join("，")}；共 ${data.libraryTotal.toLocaleString("zh-CN")} 项` });
          }
          setLoading(false);
          setCheckingUpdates(false);
        })
        .catch((reason) => {
          if (cancelled || (reason instanceof DOMException && reason.name === "AbortError")) return;
          if (!force && attempt < PHOTO_LOAD_RETRY_DELAYS.length) {
            retryTimer = window.setTimeout(() => load(attempt + 1), PHOTO_LOAD_RETRY_DELAYS[attempt]);
          } else {
            setError(reason instanceof Error ? reason.message : "读不到相册");
            setLoading(false);
            setCheckingUpdates(false);
          }
        });
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      controller.abort();
    };
  }, [active, anchor, folder, kind, refreshVersion, view]);

  useEffect(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [anchor, folder, kind, view]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await jsonFetch<PhotoSnapshot>(requestUrl(nextCursor));
      setEntries((current) => [...current, ...data.entries]);
      setNextCursor(data.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "后面的照片暂时读不到");
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !nextCursor || !(view === "day" || view === "all")) return;
    const observer = new IntersectionObserver((rows) => {
      if (rows.some((row) => row.isIntersecting)) void loadMore();
    }, { rootMargin: "500px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextCursor, loadingMore, view]);

  const changeView = (next: PhotoView) => startTransition(() => {
    const newestMonth = snapshot?.availableMonths[0] || anchor.slice(0, 7);
    const newestYear = snapshot?.availableYears[0] || newestMonth.slice(0, 4);
    if (next === "month") setAnchor(anchor.slice(0, 4) || newestYear);
    else if (next === "day") setAnchor(/^\d{4}-\d{2}$/.test(anchor) ? anchor : newestMonth);
    else if (next === "year") setAnchor(anchor.slice(0, 4) || newestYear);
    setView(next);
  });

  const drillInto = (period: PhotoPeriod) => startTransition(() => {
    setAnchor(period.key);
    setView(view === "year" ? "month" : "day");
  });

  const groupedEntries = useMemo(() => groupByDay(entries), [entries]);
  const selectedIndex = selectedId ? entries.findIndex((entry) => entry.id === selectedId) : -1;
  const selected = selectedIndex >= 0 ? entries[selectedIndex] : null;
  const selectionAvailable = view === "day" || view === "all";
  const allLoadedSelected = entries.length > 0 && entries.every((entry) => selectedIds.has(entry.id));

  const toggleSelection = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleRows = (rows: PhotoEntry[]) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = rows.every((entry) => next.has(entry.id));
      for (const entry of rows) {
        if (allSelected) next.delete(entry.id);
        else next.add(entry.id);
      }
      return next;
    });
  };

  const finishSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  const exportSelected = async () => {
    if (!selectedIds.size || actionPending) return;
    setActionPending("export");
    setActionMessage(null);
    try {
      const result = await jsonFetch<PhotoActionResult>("/api/tools/photo/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds] }),
      });
      setActionMessage({ tone: "success", text: `已把 ${result.itemCount} 项照片的 ${result.fileCount} 个原件导出` });
      finishSelection();
    } catch (reason) {
      setActionMessage({ tone: "error", text: reason instanceof Error ? reason.message : "导出失败" });
    } finally {
      setActionPending("");
    }
  };

  const trashSelected = async () => {
    if (!selectedIds.size || actionPending) return;
    const confirmed = window.confirm(`把选中的 ${selectedIds.size} 项移出相册？\n\n原件会移到隐藏回收目录，不会立即永久删除。`);
    if (!confirmed) return;
    setActionPending("trash");
    setActionMessage(null);
    try {
      const result = await jsonFetch<PhotoActionResult>("/api/tools/photo/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selectedIds], confirm: true }),
      });
      setActionMessage({ tone: "success", text: `已把 ${result.itemCount} 项移到回收目录；需要时可从 ${result.recoveryFolder || "回收目录"} 找回` });
      finishSelection();
      forceRefreshRef.current = true;
      setRefreshVersion((value) => value + 1);
    } catch (reason) {
      setActionMessage({ tone: "error", text: reason instanceof Error ? reason.message : "移到回收目录失败" });
    } finally {
      setActionPending("");
    }
  };

  return (
    <section className="photo-library-page">
      <div className="photo-library-meta">
        <span><strong>{snapshot ? snapshot.libraryTotal.toLocaleString("zh-CN") : "—"}</strong> 项 · 相册还没配置本地目录</span>
        <button type="button" onClick={() => { forceRefreshRef.current = true; announceRefreshRef.current = true; setRefreshVersion((value) => value + 1); }} disabled={loading}>
          <RefreshCw className={loading ? "is-spinning" : ""} size={14} />检查更新
        </button>
      </div>

      <div className="photo-controls">
        <div className="photo-time-rail" aria-label="时间层级">
          {VIEW_LABELS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? "is-active" : ""}
              aria-pressed={view === item.id}
              onClick={() => changeView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="photo-kind-filters" aria-label="媒体类型">
          {KIND_LABELS.map((item) => (
            <button key={item.id} type="button" className={kind === item.id ? "is-active" : ""} aria-pressed={kind === item.id} onClick={() => setKind(item.id)}>
              {item.label}<span>{snapshot?.facets.counts[item.id] ?? ""}</span>
            </button>
          ))}
        </div>
        <label className="photo-folder-filter">
          <span>来源</span>
          <select value={folder} onChange={(event) => setFolder(event.target.value)}>
            <option value="">全部文件夹</option>
            {(snapshot?.facets.folders || []).map((item) => <option key={item.folder} value={item.folder}>{item.folder || "照片根目录"} · {item.count}</option>)}
          </select>
        </label>
        <button
          type="button"
          className={`photo-selection-enter${selectionMode ? " is-active" : ""}`}
          disabled={!selectionMode && (!selectionAvailable || !entries.length || loading)}
          title={!selectionAvailable ? "切换到“日”或“全部”后可选择照片" : undefined}
          onClick={() => {
            if (selectionMode) finishSelection();
            else {
              setActionMessage(null);
              setSelectionMode(true);
            }
          }}
        >
          <Check size={15} />{selectionMode ? "退出选择" : "选择照片"}
        </button>
      </div>

      {selectionMode ? (
        <div className="photo-selection-bar is-active" role="toolbar" aria-label="照片批量操作">
          <div className="photo-selection-copy">
            <span className="photo-selection-count">{selectedIds.size}</span>
            <span><strong>已选 {selectedIds.size} 项</strong><small>可导出，或移到回收目录</small></span>
          </div>
          <div className="photo-selection-actions">
            <button type="button" onClick={() => toggleRows(entries)} disabled={!entries.length || Boolean(actionPending)}>{allLoadedSelected ? "取消全选" : "全选已加载"}</button>
            <button type="button" className="is-primary" onClick={() => void exportSelected()} disabled={!selectedIds.size || Boolean(actionPending)}>
              {actionPending === "export" ? <LoaderCircle className="is-spinning" size={15} /> : <Download size={15} />}导出
            </button>
            <button type="button" className="is-danger" onClick={() => void trashSelected()} disabled={!selectedIds.size || Boolean(actionPending)}>
              {actionPending === "trash" ? <LoaderCircle className="is-spinning" size={15} /> : <Trash2 size={15} />}删除
            </button>
            <button type="button" onClick={finishSelection} disabled={Boolean(actionPending)}>取消</button>
          </div>
        </div>
      ) : null}

      {actionMessage ? <p className={`photo-action-message is-${actionMessage.tone}`} role="status">{actionMessage.text}</p> : null}

      {error ? (
        <div className="photo-library-error" role="alert">
          <ImageIcon size={22} /><strong>暂时读不到照片</strong><span>{error}</span>
        </div>
      ) : null}
      {loading && !snapshot ? <Empty>正在读取永久照片索引，请稍等一下。</Empty> : null}
      {loading && snapshot ? <div className="photo-filter-progress" role="status"><LoaderCircle className="is-spinning" size={15} />{checkingUpdates ? "正在检查发生变化的月份" : "正在整理这一层"}</div> : null}

      {(view === "year" || view === "month") && snapshot ? (
        <div className={`photo-period-grid is-${view}`}>
          {snapshot.periods.map((period) => (
            <button
              key={period.key}
              type="button"
              className="photo-period-card"
              onClick={() => drillInto(period)}
            >
              <PeriodCover period={period} view={view} />
              <span className="photo-period-meta">
                <strong>{view === "year" ? `${period.key}年` : monthLabel(period.key)}</strong>
                <small>{period.count.toLocaleString("zh-CN")} 项 <ChevronRight size={13} /></small>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {(view === "day" || view === "all") && snapshot ? (
        <div className="photo-day-list">
          {groupedEntries.map(([day, rows]) => (
            <section className="photo-day-group" key={day}>
              <header>
                <strong>{dayLabel(day)}</strong>
                <span>{rows.length} 项{selectionMode ? <button type="button" onClick={() => toggleRows(rows)}>{rows.every((entry) => selectedIds.has(entry.id)) ? "取消这天" : "选择这天"}</button> : null}</span>
              </header>
              <div className="photo-grid">
                {rows.map((entry) => {
                  const isSelected = selectedIds.has(entry.id);
                  return (
                  <button key={entry.id} type="button" className={`photo-tile${selectionMode ? " is-selecting" : ""}${isSelected ? " is-selected" : ""}`} onClick={() => selectionMode ? toggleSelection(entry.id) : setSelectedId(entry.id)} aria-label={selectionMode ? `${isSelected ? "取消选择" : "选择"} ${entry.name}` : `查看 ${entry.name}`} aria-pressed={selectionMode ? isSelected : undefined}>
                    <img src={thumbUrl(entry.id, "medium")} alt="" loading="lazy" decoding="async" />
                    <MediaBadge entry={entry} />
                    <span className="photo-tile-focus"><Maximize2 size={16} /></span>
                    {selectionMode ? <span className="photo-tile-select" aria-hidden="true">{isSelected ? <Check size={16} strokeWidth={3} /> : null}</span> : null}
                  </button>
                  );
                })}
              </div>
            </section>
          ))}
          <div ref={sentinelRef} className="photo-load-sentinel">
            {loadingMore ? <><LoaderCircle className="is-spinning" size={15} />正在取后面的照片</> : nextCursor ? "继续向下加载" : entries.length ? "已经到这里了" : "这个时间段没有照片"}
          </div>
        </div>
      ) : null}

      {snapshot && !loading && !snapshot.periods.length && !entries.length ? <Empty>这个筛选条件下没有照片。</Empty> : null}

      {selected ? (
        <PhotoViewer
          entry={selected}
          previous={selectedIndex > 0}
          next={selectedIndex < entries.length - 1}
          onPrevious={() => setSelectedId(entries[selectedIndex - 1]?.id || selected.id)}
          onNext={() => setSelectedId(entries[selectedIndex + 1]?.id || selected.id)}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </section>
  );
}
