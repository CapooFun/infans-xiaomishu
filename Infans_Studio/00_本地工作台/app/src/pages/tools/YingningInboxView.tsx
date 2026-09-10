import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Bookmark, Camera, Check, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileText, FolderOpen, Image as ImageIcon, Inbox, Link2, RefreshCw, RotateCcw, StickyNote, Trash2, X } from "lucide-react";
import { Card, Empty, Kicker, fmtDateTime, jsonFetch } from "../../page-shared";
import { checkpointFilterChips, checkpointFilterCollapsible, checkpointFilterToggleLabel } from "./yingning-inbox-checkpoint-filter";
import { fileBadge, inboxItemKind, isFileContentType, isImageContentType, isPlainTextFile } from "./yingning-inbox-kind";
import { flattenInboxImageSlides, inboxSlideIndex, inboxSlideStep } from "./yingning-inbox-preview";
import { projectInboxCardCopy } from "./yingning-inbox-project-card";
import type { InboxSection } from "./yingning-inbox-section";
import { fallbackInboxSection, inboxLocationForSection, readRememberedInboxSection, resolveInboxSection, writeRememberedInboxSection } from "./yingning-inbox-section";
import type { SavePhase } from "./yingning-inbox-save";
import { bytesToHex, canShareFileSafely, checkOriginalIntegrity, decodeTextFileBytes, downloadNameFor, isAbortError, pruneTempSaveState, saveButtonLabel } from "./yingning-inbox-save";
import { isAppleMobileBrowser, isMacDesktopBrowser } from "./guide-share-platform.mjs";
import "./yingning-inbox.css";

type YingningInboxAttachment = {
  attachmentId: string;
  role: "original";
  fileName: string;
  contentType: string;
  byteCount: number;
  pixelWidth?: number | null;
  pixelHeight?: number | null;
  createdAt: string;
  sha256: string;
  evidenceId?: string;
};

type YingningCheckpointMeta = {
  checkpointId?: string;
  name?: string;
  source?: string;
  build?: string;
  manifestSha?: string;
  capturedAt?: string;
};

type YingningInboxItem = {
  schemaVersion: 1 | 2;
  intakeId: string;
  url: string;
  title: string;
  text: string;
  note: string;
  source: "ios_share_extension" | "ipados_share_extension" | "ios_quick_photo" | "ipados_quick_photo" | "chrome_extension";
  sourceSemantic?: "shared_content" | "photo_share" | "file_share" | "quick_photo_inbox";
  sourceApp: string;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  receivedAt: string;
  status: "delivered";
  deliveryBoundary: "mac_persisted";
  duplicateCount: number;
  lastDuplicateAt?: string;
  trashedAt?: string;
  attachments?: YingningInboxAttachment[];
  projectId?: string;
  projectName?: string;
  checkpointId?: string;
  checkpoint?: YingningCheckpointMeta;
};

type YingningProjectSummary = {
  projectId: string;
  projectName: string;
  itemCount: number;
  attachmentCount: number;
  checkpointCount: number;
  latestAt: string;
};

type YingningCheckpointSummary = {
  checkpointId: string;
  name: string;
  source: string;
  build: string;
  manifestSha: string;
  itemCount: number;
  attachmentCount: number;
  latestAt: string;
};

type YingningInboxSnapshot = {
  schemaVersion: 2;
  generatedAt: string;
  scope?: "daily";
  total: number;
  delivered: number;
  items: YingningInboxItem[];
  trash: YingningInboxItem[];
  trashCount: number;
  projects?: YingningProjectSummary[];
  projectItemCount?: number;
  deliveryBoundary: string;
};

type YingningProjectSnapshot = {
  schemaVersion: 2;
  generatedAt: string;
  scope: "project";
  projectId: string;
  projectName: string;
  checkpointId: string | null;
  checkpoints: YingningCheckpointSummary[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  items: YingningInboxItem[];
  deliveryBoundary: string;
};

const PROJECT_PAGE_SIZE = 60;

type PreviewTarget = {
  item: YingningInboxItem;
  attachment: YingningInboxAttachment;
};

const SOURCE_LABELS: Record<YingningInboxItem["source"], string> = {
  ios_share_extension: "iPhone 分享",
  ipados_share_extension: "iPad 分享",
  ios_quick_photo: "iPhone 快速拍照",
  ipados_quick_photo: "iPad 快速拍照",
  chrome_extension: "Chrome 分享",
};

function checkpointTitle(checkpoint: Pick<YingningCheckpointSummary, "name" | "checkpointId">) {
  return checkpoint.name || checkpoint.checkpointId || "未命名检查点";
}

function CheckpointFilterBar({
  checkpoints,
  selectedId,
  expanded,
  onSelect,
  onToggle,
}: {
  checkpoints: YingningCheckpointSummary[];
  selectedId: string | null;
  expanded: boolean;
  onSelect: (checkpointId: string | null) => void;
  onToggle: () => void;
}) {
  const collapsible = checkpointFilterCollapsible(checkpoints.length);
  const chips = checkpointFilterChips(checkpoints, selectedId, expanded);
  return (
    <div
      className="inbox-checkpoint-filter"
      data-collapsed={collapsible && !expanded ? "true" : undefined}
      role="group"
      aria-label="按检查点筛选"
    >
      <button type="button" aria-pressed={!selectedId} onClick={() => onSelect(null)}>全部</button>
      {chips.map((checkpoint) => (
        <button
          key={checkpoint.checkpointId || "none"}
          type="button"
          aria-pressed={selectedId === checkpoint.checkpointId}
          onClick={() => onSelect(checkpoint.checkpointId || null)}
        >
          {checkpointTitle(checkpoint)}<small>{checkpoint.attachmentCount}</small>
        </button>
      ))}
      {collapsible ? (
        <button type="button" className="inbox-checkpoint-toggle" aria-expanded={expanded} onClick={onToggle}>
          {checkpointFilterToggleLabel(checkpoints.length, expanded)}
        </button>
      ) : null}
    </div>
  );
}

function titleFor(item: YingningInboxItem) {
  if (item.title) return item.title;
  if (item.url) {
    try { return new URL(item.url).hostname.replace(/^www\./u, ""); } catch { return "分享网址"; }
  }
  if (item.attachments?.length) {
    if (item.attachments.length === 1) return item.attachments[0].fileName;
    if (item.attachments.every((row) => isFileContentType(row.contentType))) return `${item.attachments.length} 个文件`;
    if (item.attachments.every((row) => isImageContentType(row.contentType))) return `${item.attachments.length} 张照片`;
    return `${item.attachments.length} 个附件`;
  }
  return "分享文字";
}

function hostFor(url: string) {
  try { return new URL(url).hostname.replace(/^www\./u, ""); } catch { return "外部链接"; }
}

function sourceLabelFor(item: YingningInboxItem) {
  if (!item.projectId) return SOURCE_LABELS[item.source];
  const app = String(item.sourceApp || "").split("·")[0].trim();
  return app || "项目来件";
}

function attachmentURL(item: YingningInboxItem, attachmentId: string, share = false) {
  const params = new URLSearchParams({ intakeId: item.intakeId, attachmentId });
  if (share) params.set("share", "1");
  return `/api/tools/inbox?${params}`;
}

function sizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function clipboardTextFor(item: YingningInboxItem) {
  if (item.url) return item.url;
  return [item.title, item.text, item.note].filter(Boolean).join("\n\n") || titleFor(item);
}

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // 小秘书窗口里常有 writeText，但一次点击里先取文件后再写会被拒。
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("浏览器没有允许复制");
}

async function blobToPng(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("没法把照片放进剪贴板");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("没法把照片放进剪贴板")), "image/png");
    });
  } finally {
    bitmap.close();
  }
}

function clipboardFailure(reason: unknown) {
  const message = reason instanceof Error ? reason.message : "";
  if (/[\u4e00-\u9fff]/u.test(message)) return message;
  if (/not allowed|denied permission|not focused|secure context/iu.test(message)) return "没能放进剪贴板，请再点一次复制";
  return "没能放进剪贴板";
}

async function shareImagePng(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("暂时做不出能发送的照片");
  const blob = await response.blob();
  return blob.type === "image/png" ? blob : blobToPng(blob);
}

async function copyShareImage(url: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("当前浏览器还不能复制图片");
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": shareImagePng(url) })]);
  } catch (reason) {
    throw new Error(clipboardFailure(reason));
  }
}

async function copyClipboardFile(file: File) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("这份文件没法直接放进剪贴板");
  }
  const supports = typeof ClipboardItem.supports === "function" ? ClipboardItem.supports(file.type) : file.type === "image/png";
  if (!supports) throw new Error("这份文件没法直接放进剪贴板");
  try {
    await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]);
  } catch (reason) {
    throw new Error(clipboardFailure(reason));
  }
}

async function copyPlainTextSoon(textPromise: Promise<string>) {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": textPromise.then((value) => new Blob([value], { type: "text/plain" })),
        }),
      ]);
      return;
    } catch {
      // 类型不被接受时，再等正文用 writeText／选区复制。
    }
  }
  await copyText(await textPromise);
}

async function copyMacPasteboard(item: YingningInboxItem, attachment: YingningInboxAttachment) {
  await jsonFetch("/api/tools/inbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "copy-to-pasteboard",
      intakeId: item.intakeId,
      attachmentId: attachment.attachmentId,
    }),
  });
}

async function copyInboxFile(item: YingningInboxItem, attachment: YingningInboxAttachment) {
  if (isMacDesktopBrowser()) {
    await copyMacPasteboard(item, attachment);
    return;
  }
  if (isPlainTextFile(attachment.contentType)) {
    const textPromise = prepareOriginalFile(item, attachment).then(async (file) => (
      decodeTextFileBytes(new Uint8Array(await file.arrayBuffer()))
    ));
    await copyPlainTextSoon(textPromise);
    return;
  }
  await copyClipboardFile(await prepareOriginalFile(item, attachment));
}

// 仅用于决定是否展示两步“保存/分享”界面（iPhone／iPad Safari、PWA 常见）；桌面通常为 false 走下载。
// 这个 JPEG 探针只判断“大致能分享文件”，真正保存前必须再用实际文件调 canShare 校验（HEIC 等可能不支持）。
function supportsFileShare() {
  try {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    const probe = new File([new Uint8Array([0])], "probe.jpg", { type: "image/jpeg" });
    return navigator.canShare({ files: [probe] });
  } catch { return false; }
}

function saveKey(item: YingningInboxItem, attachment: YingningInboxAttachment) {
  return `${item.intakeId}:${attachment.attachmentId}`;
}

// 对 PNG/JPEG 额外解码，确认能出图且尺寸与登记一致（HEIC 等浏览器不一定能解码，跳过解码只留魔数）。
async function assertDecodableDimensions(blob: Blob, attachment: YingningInboxAttachment) {
  if (attachment.contentType !== "image/png" && attachment.contentType !== "image/jpeg") return;
  if (typeof createImageBitmap !== "function") return;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error("这张原图解不开，请刷新后再试");
  }
  try {
    if (attachment.pixelWidth && attachment.pixelHeight && (bitmap.width !== attachment.pixelWidth || bitmap.height !== attachment.pixelHeight)) {
      throw new Error("原图尺寸和记录不一致，请刷新后再试");
    }
  } finally {
    bitmap.close();
  }
}

// 只取原始字节（不走 1600 派生复制），并核对 MIME、字节数、SHA-256 与魔数，拒绝伪装 HTML。判定逻辑在纯 helper 里。
async function prepareOriginalFile(item: YingningInboxItem, attachment: YingningInboxAttachment, signal?: AbortSignal) {
  const response = await fetch(attachmentURL(item, attachment.attachmentId), { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("暂时取不到这份原件，请刷新后再试");
  const headerType = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let actualSha256: string | undefined;
  if (attachment.sha256 && crypto?.subtle?.digest) {
    actualSha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
  }
  const { type } = checkOriginalIntegrity({
    bytes,
    headerType,
    attachmentContentType: attachment.contentType,
    attachmentByteCount: attachment.byteCount,
    attachmentSha256: attachment.sha256,
    actualSha256,
  });
  const file = new File([buffer], downloadNameFor(attachment), { type });
  await assertDecodableDimensions(file, attachment);
  return file;
}

function triggerDownload(file: File) {
  const objectUrl = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = file.name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}

function saveFailure(reason: unknown) {
  const message = reason instanceof Error ? reason.message : "";
  if (/原图|图片|文件|刷新/u.test(message)) return message;
  return "这份附件暂时没能保存，请再试一次";
}

function AttachmentLightbox({ item, attachment, onClose, onCopy, copyState, onSave, onDownloadPrepared, saveNote, savePhase, canShareFiles, showSaveImage, onStep, slideLabel, canStep }: PreviewTarget & {
  onClose: () => void;
  onCopy: () => void;
  copyState: "idle" | "copied" | "error";
  onSave: () => void;
  onDownloadPrepared: () => void;
  saveNote: string;
  savePhase: SavePhase;
  canShareFiles: boolean;
  showSaveImage: boolean;
  onStep: (delta: number) => void;
  slideLabel: string;
  canStep: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const didSwipe = useRef(false);
  const [unavailable, setUnavailable] = useState(false);
  const isImage = isImageContentType(attachment.contentType);
  const isPdf = attachment.contentType === "application/pdf";
  const isFile = isFileContentType(attachment.contentType);
  const saveKind = isFile ? "file" : "image";
  const showSave = showSaveImage;

  useEffect(() => {
    setUnavailable(false);
    closeRef.current?.focus({ preventScroll: true });
  }, [item.intakeId, attachment.attachmentId]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.documentElement.classList.add("inbox-lightbox-open");
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (!canStep) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (event.key === "ArrowLeft" || key === "a") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onStep(-1);
        return;
      }
      if (event.key === "ArrowRight" || key === "d") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onStep(1);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.documentElement.classList.remove("inbox-lightbox-open");
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [canStep, onClose, onStep]);

  const src = attachmentURL(item, attachment.attachmentId);
  const size = attachment.pixelWidth && attachment.pixelHeight
    ? `${attachment.pixelWidth}×${attachment.pixelHeight} · ${sizeLabel(attachment.byteCount)}`
    : sizeLabel(attachment.byteCount);

  const onPointerDown = (event: { clientX: number; clientY: number }) => {
    swipe.current = { x: event.clientX, y: event.clientY };
    didSwipe.current = false;
  };
  const onPointerUp = (event: { clientX: number; clientY: number }) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || !canStep) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return;
    didSwipe.current = true;
    onStep(dx < 0 ? 1 : -1);
  };
  const onStageClick = () => {
    if (didSwipe.current) {
      didSwipe.current = false;
      return;
    }
    onClose();
  };

  return createPortal((
    <div className="inbox-lightbox" role="dialog" aria-modal="true" aria-labelledby="inbox-lightbox-title">
      <header>
        <div>
          <strong id="inbox-lightbox-title">{attachment.fileName}</strong>
          <span>{slideLabel ? `${slideLabel} · ${size}` : size}</span>
        </div>
        <nav aria-label={isImage ? "全图操作" : "文件操作"}>
          {showSave ? (
            <button type="button" className="inbox-lightbox-save" onClick={onSave} disabled={savePhase === "preparing" || savePhase === "sharing"} aria-label={`保存 ${attachment.fileName}`}>
              <Download size={16} aria-hidden="true" />
              <span>{saveButtonLabel(savePhase, canShareFiles, saveKind)}</span>
            </button>
          ) : null}
          <button type="button" className="inbox-lightbox-copy" onClick={onCopy} aria-label={`复制 ${attachment.fileName}`}>
            <Copy size={16} aria-hidden="true" />
            <span>{copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制"}</span>
          </button>
          <button ref={closeRef} type="button" className="inbox-lightbox-close" onClick={onClose} aria-label={isImage ? "关闭全图" : "关闭预览"}>
            <X size={20} aria-hidden="true" />
            <span>关闭</span>
          </button>
        </nav>
      </header>
      <div className="inbox-lightbox-feedback">
        {showSave && saveNote ? <p role="status" aria-live="polite">{saveNote}</p> : null}
        {showSave && savePhase === "armed" ? (
          <button type="button" className="inbox-lightbox-save" onClick={onDownloadPrepared}>{isFile ? "下载文件" : "下载原图"}</button>
        ) : null}
      </div>
      <div
        className="inbox-lightbox-stage"
        onClick={onStageClick}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        {isImage ? (
          unavailable ? (
            <span className="inbox-photo-fallback">
              <ImageIcon size={42} aria-hidden="true" />
              <small>{attachment.contentType === "image/heic" ? "HEIC 原图" : "原图暂时打不开"}</small>
            </span>
          ) : (
            <img src={src} alt={attachment.fileName} onClick={(event) => event.stopPropagation()} onError={() => setUnavailable(true)} />
          )
        ) : isPdf && !unavailable ? (
          <iframe className="inbox-file-frame" src={src} title={attachment.fileName} onClick={(event) => event.stopPropagation()} />
        ) : (
          <span className="inbox-photo-fallback" onClick={(event) => event.stopPropagation()}>
            <FileText size={42} aria-hidden="true" />
            <small>{fileBadge(attachment.contentType, attachment.fileName)} · {sizeLabel(attachment.byteCount)}</small>
          </span>
        )}
        {canStep ? (
          <>
            <button type="button" className="inbox-lightbox-previous" onClick={(event) => { event.stopPropagation(); onStep(-1); }} aria-label="上一张">
              <ChevronLeft size={26} aria-hidden="true" />
            </button>
            <button type="button" className="inbox-lightbox-next" onClick={(event) => { event.stopPropagation(); onStep(1); }} aria-label="下一张">
              <ChevronRight size={26} aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  ), document.body);
}

export default function YingningInboxView({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<YingningInboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [section, setSection] = useState<InboxSection>(() => (
    resolveInboxSection(window.location.search, readRememberedInboxSection(window.sessionStorage))
  ));
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [copiedKey, setCopiedKey] = useState("");
  const [copyFailedKey, setCopyFailedKey] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [restoringId, setRestoringId] = useState("");
  const [emptying, setEmptying] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [checkpointFilter, setCheckpointFilter] = useState<string | null>(null);
  const [checkpointExpanded, setCheckpointExpanded] = useState(false);
  const [projectSnapshot, setProjectSnapshot] = useState<YingningProjectSnapshot | null>(null);
  const [projectItems, setProjectItems] = useState<YingningInboxItem[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectLoadingMore, setProjectLoadingMore] = useState(false);
  const [projectError, setProjectError] = useState("");
  const [saveState, setSaveState] = useState<Record<string, SavePhase>>({});
  const [saveNote, setSaveNote] = useState("");
  const armedFile = useRef<{ key: string; file: File } | null>(null);
  const saveRequestRef = useRef(0);
  const savePrepareController = useRef<AbortController | null>(null);
  const projectRequestRef = useRef(0);
  const copyReset = useRef<number | null>(null);
  const canShareFiles = useMemo(() => supportsFileShare(), []);
  const showSaveImage = useMemo(() => isAppleMobileBrowser(), []);
  const closePreview = useCallback(() => setPreview(null), []);
  const chooseSection = useCallback((next: InboxSection) => {
    setSection(next);
    const href = inboxLocationForSection(window.location.pathname, window.location.search, next);
    if (`${window.location.pathname}${window.location.search}` !== href) {
      window.history.replaceState({}, "", `${href}${window.location.hash}`);
    }
  }, []);
  const savePhaseFor = (key: string): SavePhase => saveState[key] ?? "idle";

  // 放弃任何尚未落地的保存准备：换图/换检查点/离开/关闭全图时调用。
  // 无条件作废在途请求与临时态（preparing/armed/sharing/fallback），保留已结束态，并清掉旧提示。
  const clearArmedSave = useCallback(() => {
    saveRequestRef.current += 1;
    savePrepareController.current?.abort();
    savePrepareController.current = null;
    armedFile.current = null;
    setSaveState((current) => pruneTempSaveState(current));
    setSaveNote("");
  }, []);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setSnapshot(await jsonFetch<YingningInboxSnapshot>("/api/tools/inbox?limit=100"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时读不到来件");
    } finally {
      setLoading(false);
    }
  };

  // offset===0 为首页（重置列表）；否则为“加载更多”追加。用请求号防止旧请求覆盖新检查点。
  const loadProject = useCallback(async (id: string, checkpoint: string | null, offset = 0) => {
    const requestId = ++projectRequestRef.current;
    if (offset === 0) setProjectLoading(true); else setProjectLoadingMore(true);
    setProjectError("");
    try {
      const params = new URLSearchParams({ projectId: id, offset: String(offset), limit: String(PROJECT_PAGE_SIZE) });
      if (checkpoint) params.set("checkpointId", checkpoint);
      const data = await jsonFetch<YingningProjectSnapshot>(`/api/tools/inbox?${params}`);
      if (requestId !== projectRequestRef.current) return;
      setProjectSnapshot(data);
      setProjectItems((current) => offset === 0 ? data.items : [...current, ...data.items]);
    } catch (reason) {
      if (requestId !== projectRequestRef.current) return;
      setProjectError(reason instanceof Error ? reason.message : "项目来件暂时读不到");
    } finally {
      if (requestId === projectRequestRef.current) {
        setProjectLoading(false);
        setProjectLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!active) {
      setPreview(null);
      return;
    }
    void load();
  }, [active]);

  useLayoutEffect(() => {
    writeRememberedInboxSection(section, window.sessionStorage);
    const href = inboxLocationForSection(window.location.pathname, window.location.search, section);
    if (`${window.location.pathname}${window.location.search}` !== href) {
      window.history.replaceState({}, "", `${href}${window.location.hash}`);
    }
  }, [section]);

  useEffect(() => {
    const onPop = () => {
      setSection(resolveInboxSection(window.location.search, readRememberedInboxSection(window.sessionStorage)));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    setCheckpointExpanded(false);
  }, [projectId]);

  useEffect(() => {
    // 离开项目标签（非激活/切走标签/无 projectId）时作废在途项目请求，避免旧响应回来后闪现。
    if (!active || section !== "projects" || !projectId) {
      projectRequestRef.current += 1;
      return;
    }
    void loadProject(projectId, checkpointFilter, 0);
  }, [active, section, projectId, checkpointFilter, loadProject]);

  // 面板关闭、切换当前图、检查点或视图时，作废尚未落地的保存准备并清旧提示，保证保存的始终是当前这张。
  useEffect(() => {
    clearArmedSave();
  }, [active, preview?.item.intakeId, preview?.attachment.attachmentId, section, projectId, checkpointFilter, clearArmedSave]);

  useEffect(() => () => {
    if (copyReset.current !== null) window.clearTimeout(copyReset.current);
    savePrepareController.current?.abort();
  }, []);

  const markCopied = (key: string, ok: boolean) => {
    setCopiedKey(ok ? key : "");
    setCopyFailedKey(ok ? "" : key);
    if (copyReset.current !== null) window.clearTimeout(copyReset.current);
    copyReset.current = window.setTimeout(() => {
      setCopiedKey("");
      setCopyFailedKey("");
    }, 1600);
  };

  const copyItem = async (item: YingningInboxItem, attachment?: YingningInboxAttachment) => {
    const key = attachment ? `${item.intakeId}:${attachment.attachmentId}` : item.intakeId;
    try {
      if (attachment) {
        if (isFileContentType(attachment.contentType)) await copyInboxFile(item, attachment);
        else await copyShareImage(attachmentURL(item, attachment.attachmentId, true));
      } else if (item.attachments?.length) {
        const first = item.attachments[0];
        if (isFileContentType(first.contentType)) await copyInboxFile(item, first);
        else await copyShareImage(attachmentURL(item, first.attachmentId, true));
      } else await copyText(clipboardTextFor(item));
      markCopied(key, true);
      setActionError("");
    } catch (reason) {
      markCopied(key, false);
      setActionError(clipboardFailure(reason));
    }
  };

  const markSave = (key: string, phase: SavePhase) => setSaveState((current) => ({ ...current, [key]: phase }));

  // 在用户点击手势里同步下载已备好的原图（后备路径都走这里，保住手势）。
  const downloadArmed = (key: string, file: File, note: string) => {
    armedFile.current = null;
    try {
      triggerDownload(file);
      markSave(key, "downloaded");
      setSaveNote(note);
    } catch (fallbackReason) {
      markSave(key, "error");
      setSaveNote(saveFailure(fallbackReason));
    }
  };

  const downloadPreparedImage = (item: YingningInboxItem, attachment: YingningInboxAttachment) => {
    const key = saveKey(item, attachment);
    const prepared = armedFile.current;
    if (prepared?.key !== key) return;
    downloadArmed(key, prepared.file, `已开始下载 ${prepared.file.name}，请在“下载”或“文件”里查看。`);
  };

  // 开始准备另一张前，先无条件清掉其它图的临时态并作废在途请求，避免旧 key 卡在 preparing。
  const beginPrepare = (key: string): { requestId: number; signal: AbortSignal } => {
    const requestId = ++saveRequestRef.current;
    savePrepareController.current?.abort();
    const controller = new AbortController();
    savePrepareController.current = controller;
    armedFile.current = null;
    setSaveState((current) => ({ ...pruneTempSaveState(current), [key]: "preparing" }));
    setSaveNote("正在准备原件…");
    return { requestId, signal: controller.signal };
  };

  const saveImage = async (item: YingningInboxItem, attachment: YingningInboxAttachment) => {
    const key = saveKey(item, attachment);
    const noun = isFileContentType(attachment.contentType) ? "文件" : "原图";
    setActionError("");

    // 分享被系统拒绝后进入 fallback：这一次点击就是用户手势，直接下载原件。
    if (savePhaseFor(key) === "fallback" && armedFile.current?.key === key) {
      downloadArmed(key, armedFile.current.file, `已开始下载 ${armedFile.current.file.name}，请在“下载”或“文件”里查看。`);
      return;
    }

    if (canShareFiles) {
      // 第二次点击：已备好这份文件。
      if (armedFile.current?.key === key) {
        const file = armedFile.current.file;
        // 同步用实际文件再校验（可能返回 false 或抛错）；手势仍在，不支持就当场下载后备。
        if (!canShareFileSafely(navigator.canShare?.bind(navigator), file)) {
          downloadArmed(key, file, `这台设备不支持直接分享这个格式，已改为下载 ${file.name}，请在“下载”或“文件”里查看。`);
          return;
        }
        armedFile.current = null;
        const shareRequestId = saveRequestRef.current;
        markSave(key, "sharing");
        try {
          await navigator.share({
            files: [file],
            ...(attachment.evidenceId ? { text: attachment.evidenceId } : {}),
          });
          if (shareRequestId !== saveRequestRef.current) return;
          markSave(key, "opened");
          setSaveNote(isFileContentType(attachment.contentType)
            ? "已交给系统的保存/分享面板，请在里面选存储位置；这一步不代表已经保存成功。"
            : "已交给系统的保存/分享面板，请在里面选“存储到照片”或“存储到文件”；这一步不代表已写入相册。");
        } catch (reason) {
          if (shareRequestId !== saveRequestRef.current) return;
          if (isAbortError(reason)) {
            markSave(key, "idle");
            setSaveNote("已取消分享。");
            return;
          }
          armedFile.current = { key, file };
          markSave(key, "fallback");
          setSaveNote(`系统没允许打开分享面板。再点一次“下载${noun === "文件" ? "文件" : "原图"}”，然后在“下载”或“文件”里查看。`);
        }
        return;
      }
      const { requestId, signal } = beginPrepare(key);
      try {
        const file = await prepareOriginalFile(item, attachment, signal);
        if (requestId !== saveRequestRef.current) return;
        armedFile.current = { key, file };
        markSave(key, "armed");
        setSaveNote(isFileContentType(attachment.contentType)
          ? "文件已备好。再点一次打开系统面板，选存储位置。"
          : "原图已备好。再点一次“保存图片”打开系统面板，选“存储到照片”或“存储到文件”。");
      } catch (reason) {
        if (requestId !== saveRequestRef.current || isAbortError(reason)) return;
        markSave(key, "error");
        setSaveNote(saveFailure(reason));
      }
      return;
    }

    const { requestId, signal } = beginPrepare(key);
    try {
      const file = await prepareOriginalFile(item, attachment, signal);
      if (requestId !== saveRequestRef.current) return;
      triggerDownload(file);
      markSave(key, "downloaded");
      setSaveNote(`已开始下载 ${file.name}，请在“下载”或“文件”里查看。`);
    } catch (reason) {
      if (requestId !== saveRequestRef.current || isAbortError(reason)) return;
      markSave(key, "error");
      setSaveNote(saveFailure(reason));
    }
  };

  const deleteItem = async (item: YingningInboxItem) => {
    setDeletingId(item.intakeId);
    setActionError("");
    try {
      await jsonFetch("/api/tools/inbox", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intakeId: item.intakeId }),
      });
      setSnapshot((current) => {
        if (!current) return current;
        const moved = current.items.find((row) => row.intakeId === item.intakeId);
        const items = current.items.filter((row) => row.intakeId !== item.intakeId);
        const trash = moved ? [{ ...moved, trashedAt: new Date().toISOString() }, ...(current.trash ?? [])] : (current.trash ?? []);
        return { ...current, items, trash, total: items.length, delivered: items.length, trashCount: trash.length, generatedAt: new Date().toISOString() };
      });
      setPreview((current) => current?.item.intakeId === item.intakeId ? null : current);
      if (item.projectId && projectId) {
        void loadProject(projectId, checkpointFilter);
        void load();
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "没有删除成功");
    } finally {
      setDeletingId("");
    }
  };

  const restoreItem = async (item: YingningInboxItem) => {
    setRestoringId(item.intakeId);
    setActionError("");
    try {
      await jsonFetch("/api/tools/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", intakeId: item.intakeId }),
      });
      setSnapshot((current) => {
        if (!current) return current;
        const moved = (current.trash ?? []).find((row) => row.intakeId === item.intakeId);
        const trash = (current.trash ?? []).filter((row) => row.intakeId !== item.intakeId);
        const items = moved ? [...current.items.filter((row) => row.intakeId !== item.intakeId), { ...moved, trashedAt: undefined }] : current.items;
        return { ...current, items, trash, total: items.length, delivered: items.length, trashCount: trash.length, generatedAt: new Date().toISOString() };
      });
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "没有复原成功");
    } finally {
      setRestoringId("");
    }
  };

  const emptyTrash = async () => {
    setEmptying(true);
    setActionError("");
    try {
      await jsonFetch("/api/tools/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "empty-trash" }),
      });
      setSnapshot((current) => current ? { ...current, trash: [], trashCount: 0, generatedAt: new Date().toISOString() } : current);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "回收站没有清空");
    } finally {
      setEmptying(false);
    }
  };

  const copyStateFor = (key: string): "idle" | "copied" | "error" => (
    copiedKey === key ? "copied" : copyFailedKey === key ? "error" : "idle"
  );

  const saveButton = (item: YingningInboxItem, attachment: YingningInboxAttachment) => {
    const key = saveKey(item, attachment);
    const phase = savePhaseFor(key);
    const kind = isFileContentType(attachment.contentType) ? "file" : "image";
    return (
      <button type="button" className="inbox-save" data-phase={phase} onClick={() => void saveImage(item, attachment)} aria-label={`保存 ${attachment.fileName}`}>
        <Download size={13} aria-hidden="true" />
        {saveButtonLabel(phase, canShareFiles, kind)}
      </button>
    );
  };

  // 单张直接给保存键；多张不默默存第一张，改成引导本人点开选定那一张。电脑不显示保存图片／保存文件。
  const photoSaveSlot = (item: YingningInboxItem) => {
    if (!showSaveImage) return null;
    const list = item.attachments ?? [];
    if (list.length === 1) return saveButton(item, list[0]);
    if (list.length > 1) return <span className="inbox-photo-pick">多张照片：点开你要的那张再保存</span>;
    return null;
  };

  const fileSaveSlot = (item: YingningInboxItem) => {
    if (!showSaveImage) return null;
    const list = item.attachments ?? [];
    if (list.length === 1) return saveButton(item, list[0]);
    if (list.length > 1) return <span className="inbox-photo-pick">多个文件：点开你要的那个再保存</span>;
    return null;
  };

  const itemActions = (item: YingningInboxItem) => {
    const key = item.intakeId;
    const copyState = copyStateFor(key);
    const busy = deletingId === item.intakeId;
    return (
      <div className="inbox-item-actions">
        <button type="button" onClick={() => void copyItem(item)} aria-label={`复制 ${titleFor(item)}`}>
          <Copy size={13} aria-hidden="true" />
          {copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制"}
        </button>
        <button type="button" disabled={busy} onClick={() => void deleteItem(item)} aria-label={`删除 ${titleFor(item)}`}>
          <Trash2 size={13} aria-hidden="true" />
          {busy ? "正在删除" : "删除"}
        </button>
      </div>
    );
  };

  const restoreActions = (item: YingningInboxItem) => {
    const busy = restoringId === item.intakeId;
    return (
      <div className="inbox-item-actions">
        <button type="button" disabled={busy || emptying} onClick={() => void restoreItem(item)} aria-label={`复原 ${titleFor(item)}`}>
          <RotateCcw size={13} aria-hidden="true" />
          {busy ? "正在复原" : "复原"}
        </button>
      </div>
    );
  };

  const everydayCopy = (item: YingningInboxItem) => (
    <>
      {item.text ? <p>{item.text}</p> : null}
      {item.note ? <div className="inbox-note"><StickyNote size={14} aria-hidden="true" /><span>{item.note}</span></div> : null}
    </>
  );

  const projectCopy = (item: YingningInboxItem) => {
    const copy = projectInboxCardCopy(item);
    if (!copy.relatedTask && !copy.judgment && !copy.checkpointLabel) return everydayCopy(item);
    return (
      <>
        {copy.relatedTask ? (
          <p className="inbox-related-task">
            <span>关联任务</span>
            {" "}
            {copy.relatedTask}
          </p>
        ) : null}
        {copy.judgment ? (
          <div className="inbox-note inbox-judgment" aria-label="请你判断">
            <StickyNote size={14} aria-hidden="true" />
            <div>
              <strong>请你判断</strong>
              <span>{copy.judgment}</span>
            </div>
          </div>
        ) : null}
        {copy.checkpointLabel ? (
          <div className="inbox-evidence-row" aria-label="检查点">
            <span className="inbox-checkpoint-chip">{copy.checkpointLabel}</span>
          </div>
        ) : null}
      </>
    );
  };

  const bookmarkCard = (item: YingningInboxItem, variant: "live" | "trash") => (
    <article className="inbox-bookmark-card">
      <span className="inbox-bookmark-tab" aria-hidden="true">{item.url ? <Bookmark size={15} /> : <FileText size={15} />}</span>
      <div className="inbox-bookmark-body">
        <header>
          <span>{SOURCE_LABELS[item.source]}</span>
          <time dateTime={variant === "trash" && item.trashedAt ? item.trashedAt : item.receivedAt}>
            {variant === "trash" ? (item.trashedAt ? `删于 ${fmtDateTime(item.trashedAt)}` : "已删") : fmtDateTime(item.receivedAt)}
          </time>
        </header>
        <h4>
          {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{titleFor(item)}<ExternalLink size={13} aria-hidden="true" /></a> : titleFor(item)}
        </h4>
        {item.text ? <p>{item.text}</p> : null}
        {item.note ? <div className="inbox-note"><StickyNote size={14} aria-hidden="true" /><span>{item.note}</span></div> : null}
        <div className="inbox-card-end">
          <footer>
            <span>{item.url ? <><Link2 size={13} aria-hidden="true" />{hostFor(item.url)}</> : "文字来件"}</span>
            {variant === "live" ? <span><Check size={12} aria-hidden="true" />已存</span> : null}
            {item.duplicateCount > 0 ? <small>已合并 {item.duplicateCount} 次重复投递</small> : null}
          </footer>
          {variant === "live" ? itemActions(item) : restoreActions(item)}
        </div>
      </div>
    </article>
  );

  const photoCard = (item: YingningInboxItem, variant: "live" | "trash") => (
    <article className="inbox-photo-card">
      <div className={`inbox-photo-preview photo-count-${Math.min(item.attachments?.length ?? 1, 4)}`} aria-label={`${item.attachments?.length ?? 0} 张原图`}>
        {item.attachments?.map((attachment) => (
          <button key={attachment.attachmentId} type="button" onClick={() => setPreview({ item, attachment })} title={`查看 ${attachment.fileName}`}>
            <span className="inbox-photo-fallback" aria-hidden="true"><ImageIcon size={22} /><small>{attachment.contentType === "image/heic" ? "HEIC 原图" : "原图"}</small></span>
            <img src={attachmentURL(item, attachment.attachmentId)} alt={attachment.fileName} loading="lazy" onError={(event) => event.currentTarget.classList.add("is-unavailable")} />
          </button>
        ))}
      </div>
      <div className="inbox-photo-body">
        <header>
          <span>{item.sourceSemantic === "quick_photo_inbox" ? <Camera size={13} aria-hidden="true" /> : <ImageIcon size={13} aria-hidden="true" />}{sourceLabelFor(item)}</span>
          {variant === "live" ? (
            <span className="inbox-photo-status" aria-label="已送达 Mac"><Check size={12} aria-hidden="true" />已存</span>
          ) : (
            <span className="inbox-photo-status is-trashed">{item.trashedAt ? `删于 ${fmtDateTime(item.trashedAt)}` : "已删"}</span>
          )}
        </header>
        <h4>{titleFor(item)}</h4>
        <div className="inbox-photo-meta">
          <time dateTime={item.receivedAt}>{fmtDateTime(item.receivedAt)}</time>
          <span>{item.deviceName || item.deviceId}</span>
        </div>
        {item.projectId ? projectCopy(item) : everydayCopy(item)}
        <div className="inbox-card-end">
          <footer>
            <span>{item.attachments?.map((attachment) => `${attachment.pixelWidth && attachment.pixelHeight ? `${attachment.pixelWidth}×${attachment.pixelHeight} · ` : ""}${sizeLabel(attachment.byteCount)}`).join("；")}</span>
            {item.duplicateCount > 0 ? <small>已合并 {item.duplicateCount} 次重复投递</small> : null}
          </footer>
          {variant === "live" ? (
            <div className="inbox-item-actions inbox-photo-actions">
              {photoSaveSlot(item)}
              <button type="button" onClick={() => void copyItem(item)} aria-label={`复制 ${titleFor(item)}`}>
                <Copy size={13} aria-hidden="true" />
                {copyStateFor(item.intakeId) === "copied" ? "已复制" : copyStateFor(item.intakeId) === "error" ? "复制失败" : "复制"}
              </button>
              <button type="button" disabled={deletingId === item.intakeId} onClick={() => void deleteItem(item)} aria-label={`删除 ${titleFor(item)}`}>
                <Trash2 size={13} aria-hidden="true" />
                {deletingId === item.intakeId ? "正在删除" : "删除"}
              </button>
            </div>
          ) : restoreActions(item)}
        </div>
      </div>
    </article>
  );

  const fileCard = (item: YingningInboxItem, variant: "live" | "trash") => (
    <article className="inbox-file-card">
      <div className="inbox-file-preview" aria-label={`${item.attachments?.length ?? 0} 个文件`}>
        {item.attachments?.map((attachment) => (
          <button key={attachment.attachmentId} type="button" onClick={() => setPreview({ item, attachment })} title={`查看 ${attachment.fileName}`}>
            <FileText size={28} aria-hidden="true" />
            <strong>{fileBadge(attachment.contentType, attachment.fileName)}</strong>
            <small>{sizeLabel(attachment.byteCount)}</small>
          </button>
        ))}
      </div>
      <div className="inbox-photo-body">
        <header>
          <span><FileText size={13} aria-hidden="true" />{sourceLabelFor(item)}</span>
          {variant === "live" ? (
            <span className="inbox-photo-status" aria-label="已送达 Mac"><Check size={12} aria-hidden="true" />已存</span>
          ) : (
            <span className="inbox-photo-status is-trashed">{item.trashedAt ? `删于 ${fmtDateTime(item.trashedAt)}` : "已删"}</span>
          )}
        </header>
        <h4>{titleFor(item)}</h4>
        <div className="inbox-photo-meta">
          <time dateTime={item.receivedAt}>{fmtDateTime(item.receivedAt)}</time>
          <span>{item.deviceName || item.deviceId}</span>
        </div>
        {item.projectId ? projectCopy(item) : everydayCopy(item)}
        <div className="inbox-card-end">
          <footer>
            <span>{item.attachments?.map((attachment) => attachment.fileName).join("；")}</span>
            {item.duplicateCount > 0 ? <small>已合并 {item.duplicateCount} 次重复投递</small> : null}
          </footer>
          {variant === "live" ? (
            <div className="inbox-item-actions inbox-photo-actions">
              {fileSaveSlot(item)}
              <button type="button" onClick={() => void copyItem(item)} aria-label={`复制 ${titleFor(item)}`}>
                <Copy size={13} aria-hidden="true" />
                {copyStateFor(item.intakeId) === "copied" ? "已复制" : copyStateFor(item.intakeId) === "error" ? "复制失败" : "复制"}
              </button>
              <button type="button" disabled={deletingId === item.intakeId} onClick={() => void deleteItem(item)} aria-label={`删除 ${titleFor(item)}`}>
                <Trash2 size={13} aria-hidden="true" />
                {deletingId === item.intakeId ? "正在删除" : "删除"}
              </button>
            </div>
          ) : restoreActions(item)}
        </div>
      </div>
    </article>
  );
  const items = snapshot?.items ?? [];
  const trashItems = snapshot?.trash ?? [];
  const photoItems = items.filter((item) => inboxItemKind(item) === "photo");
  const fileItems = items.filter((item) => inboxItemKind(item) === "file");
  const bookmarkItems = items.filter((item) => inboxItemKind(item) === "bookmark");
  const trashPhotoItems = trashItems.filter((item) => inboxItemKind(item) === "photo");
  const trashFileItems = trashItems.filter((item) => inboxItemKind(item) === "file");
  const trashBookmarkItems = trashItems.filter((item) => inboxItemKind(item) === "bookmark");
  const photoCount = photoItems.reduce((total, item) => total + (item.attachments?.length ?? 0), 0);
  const fileCount = fileItems.reduce((total, item) => total + (item.attachments?.length ?? 0), 0);
  const projectCount = snapshot?.projectItemCount ?? 0;
  const hasLibrary = Boolean(items.length || trashItems.length || projectCount);
  const previewAlbum = section === "projects"
    ? projectItems.filter((item) => inboxItemKind(item) === "photo")
    : section === "trash"
      ? trashPhotoItems
      : photoItems;
  const previewSlides = flattenInboxImageSlides(previewAlbum);
  const previewIndex = preview ? inboxSlideIndex(previewSlides, preview.item.intakeId, preview.attachment.attachmentId) : -1;
  const stepPreview = (delta: number) => {
    setPreview((current) => {
      if (!current) return current;
      const next = inboxSlideStep(previewSlides, current.item.intakeId, current.attachment.attachmentId, delta);
      return next ? { item: next.item, attachment: next.attachment } : current;
    });
  };

  useEffect(() => {
    if (loading && !snapshot) return;
    const next = fallbackInboxSection(section, {
      photos: photoItems.length,
      bookmarks: bookmarkItems.length,
      files: fileItems.length,
      projects: projectCount,
      trash: trashItems.length,
    });
    if (next !== section) chooseSection(next);
  }, [bookmarkItems.length, chooseSection, fileItems.length, loading, photoItems.length, projectCount, section, snapshot, trashItems.length]);

  const projects = snapshot?.projects ?? [];

  useEffect(() => {
    if (!active || section !== "projects" || projectId || !projects.length) return;
    setProjectId(projects[0].projectId);
    setCheckpointFilter(null);
  }, [active, section, projectId, projects]);

  const renderProjects = () => {
    if (!projects.length) {
      return (
        <section className="inbox-projects" aria-label="项目收件">
          <p className="inbox-trash-empty">还没有项目来件。游戏或其它项目按检查点投递证据后，会在这里出现。</p>
        </section>
      );
    }

    const checkpoints = projectSnapshot?.checkpoints ?? [];
    const infoCheckpoints = checkpointFilter ? checkpoints.filter((cp) => cp.checkpointId === checkpointFilter) : checkpoints;
    const projectPhotos = projectItems.filter((item) => inboxItemKind(item) === "photo");
    const projectFiles = projectItems.filter((item) => inboxItemKind(item) === "file");
    const projectBookmarks = projectItems.filter((item) => inboxItemKind(item) === "bookmark");
    const total = projectSnapshot?.total ?? projectItems.length;
    const hasMore = projectSnapshot?.nextOffset != null;
    const selected = projects.find((project) => project.projectId === projectId) || projects[0];
    return (
      <section className="inbox-projects" aria-label="项目收件">
        <header className="inbox-project-heading">
          <div>
            <span>收件项目</span>
            <strong>选择项目后，下面直接看这批收件卡片</strong>
          </div>
          <div>
            <button type="button" className="inbox-refresh-mini" onClick={() => { if (projectId) void loadProject(projectId, checkpointFilter, 0); }} disabled={projectLoading || !projectId}>
              <RefreshCw className={projectLoading ? "spin" : ""} size={14} aria-hidden="true" />刷新
            </button>
            <small>{selected?.attachmentCount ? `${selected.attachmentCount} 件收件` : "等待来件"}</small>
          </div>
        </header>
        <nav className="inbox-project-tabs" aria-label="选择收件项目" role="tablist">
          {projects.map((project) => (
            <button
              key={project.projectId}
              type="button"
              role="tab"
              aria-selected={project.projectId === projectId}
              className={project.projectId === projectId ? "active" : ""}
              onClick={() => { setProjectId(project.projectId); setCheckpointFilter(null); }}
            >
              <span>{project.projectName || project.projectId}</span>
              <small>{project.attachmentCount} 件收件</small>
            </button>
          ))}
        </nav>
        {checkpoints.length ? (
          <CheckpointFilterBar
            checkpoints={checkpoints}
            selectedId={checkpointFilter}
            expanded={checkpointExpanded}
            onSelect={(id) => { setCheckpointFilter(id); setCheckpointExpanded(false); }}
            onToggle={() => setCheckpointExpanded((open) => !open)}
          />
        ) : null}
        {infoCheckpoints.some((cp) => cp.checkpointId || cp.build || cp.source || cp.manifestSha) ? (
          <details className="inbox-checkpoint-info">
            <summary>检查点信息</summary>
            <dl>
              <div><dt>项目</dt><dd>{projectSnapshot?.projectId || projectId}</dd></div>
              {infoCheckpoints.map((cp) => (
                <div key={cp.checkpointId || "none"} className="inbox-checkpoint-info-group">
                  {cp.checkpointId ? <><dt>检查点</dt><dd>{cp.name ? `${cp.name} · ${cp.checkpointId}` : cp.checkpointId}</dd></> : null}
                  {cp.build ? <><dt>构建</dt><dd>{cp.build}</dd></> : null}
                  {cp.source ? <><dt>源码</dt><dd>{cp.source}</dd></> : null}
                  {cp.manifestSha ? <><dt>清单</dt><dd className="inbox-mono">{cp.manifestSha}</dd></> : null}
                </div>
              ))}
            </dl>
          </details>
        ) : null}
        {projectError ? (
          <div className="inbox-error" role="alert"><AlertTriangle size={17} /><div><strong>项目来件打不开</strong><span>{projectError}</span></div></div>
        ) : null}
        {projectLoading && !projectItems.length ? <Empty>正在读取项目来件。</Empty> : null}
        {!projectLoading && projectSnapshot && projectItems.length === 0 ? (
          <p className="inbox-trash-empty">这个检查点还没有证据来件。</p>
        ) : null}
        {projectPhotos.length ? (
          <ol className="inbox-photo-grid">
            {projectPhotos.map((item) => (<li key={item.intakeId}>{photoCard(item, "live")}</li>))}
          </ol>
        ) : null}
        {projectFiles.length ? (
          <ol className="inbox-file-grid">
            {projectFiles.map((item) => (<li key={item.intakeId}>{fileCard(item, "live")}</li>))}
          </ol>
        ) : null}
        {projectBookmarks.length ? (
          <ol className="inbox-bookmark-list">
            {projectBookmarks.map((item) => (<li key={item.intakeId}>{bookmarkCard(item, "live")}</li>))}
          </ol>
        ) : null}
        {hasMore ? (
          <div className="inbox-project-more">
            <button type="button" onClick={() => void loadProject(projectId || "", checkpointFilter, projectSnapshot?.nextOffset ?? projectItems.length)} disabled={projectLoadingMore}>
              {projectLoadingMore ? "正在加载…" : `加载更多（已显示 ${projectItems.length}/${total}）`}
            </button>
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <div className="inbox">
      <Card className="inbox-hero">
        <div className="inbox-hero-copy">
          <Kicker>来件 · 待处理区</Kicker>
          <h2>秘书收件箱</h2>
          <p>照片、书签和文件先在这里分开放好；没经确认，它们不会自动进入知识库。</p>
        </div>
        <div className="inbox-postmark" aria-label={snapshot ? `${snapshot.delivered} 件已送达` : "正在读取来件"}>
          <span>已收</span>
          <strong>{snapshot?.delivered ?? "—"}</strong>
          <small>件</small>
        </div>
        <div className="inbox-hero-actions">
          <span className="inbox-boundary"><Check size={14} aria-hidden="true" />{snapshot?.deliveryBoundary || "Mac 已安全保存"}</span>
          <span className="inbox-updated">{snapshot ? `更新于 ${fmtDateTime(snapshot.generatedAt)}` : "正在读取"}</span>
          <button type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} size={14} />
            刷新
          </button>
        </div>
      </Card>

      {error ? (
        <div className="inbox-error" role="alert">
          <AlertTriangle size={17} />
          <div><strong>秘书收件箱暂时打不开</strong><span>{error}</span></div>
        </div>
      ) : null}
      {actionError ? (
        <div className="inbox-error" role="status">
          <AlertTriangle size={17} />
          <div><strong>这次操作没有完成</strong><span>{actionError}</span></div>
        </div>
      ) : null}
      {saveNote ? (
        <div className="inbox-savenote" role="status">
          <Download size={15} aria-hidden="true" />
          <span>{saveNote}</span>
        </div>
      ) : null}

      {loading && !snapshot ? <Empty>正在查看有没有新来件。</Empty> : null}
      {!loading && snapshot && !hasLibrary ? (
        <Card className="inbox-empty">
          <Inbox size={28} aria-hidden="true" />
          <div><strong>还没有送达的来件</strong><p>秘书收件箱暂时没有新来件。随时可以从手机或浏览器把链接、灵感分享过来。</p></div>
        </Card>
      ) : null}

      {hasLibrary ? (
        <div className="inbox-library">
          <div className="inbox-tabs" role="tablist" aria-label="收件分类">
            <button id="inbox-tab-photos" type="button" role="tab" aria-selected={section === "photos"} aria-controls="inbox-panel-photos" disabled={!photoItems.length} onClick={() => chooseSection("photos")}>
              <ImageIcon size={16} aria-hidden="true" /><span>照片</span><small>{photoCount}</small>
            </button>
            <button id="inbox-tab-bookmarks" type="button" role="tab" aria-selected={section === "bookmarks"} aria-controls="inbox-panel-bookmarks" disabled={!bookmarkItems.length} onClick={() => chooseSection("bookmarks")}>
              <Bookmark size={16} aria-hidden="true" /><span>书签</span><small>{bookmarkItems.length}</small>
            </button>
            <button id="inbox-tab-files" type="button" role="tab" aria-selected={section === "files"} aria-controls="inbox-panel-files" disabled={!fileItems.length} onClick={() => chooseSection("files")}>
              <FileText size={16} aria-hidden="true" /><span>文件</span><small>{fileCount}</small>
            </button>
            <button id="inbox-tab-projects" type="button" role="tab" aria-selected={section === "projects"} aria-controls="inbox-panel-projects" disabled={!projectCount} onClick={() => chooseSection("projects")}>
              <FolderOpen size={16} aria-hidden="true" /><span>项目收件</span><small>{projectCount}</small>
            </button>
            <button id="inbox-tab-trash" type="button" role="tab" aria-selected={section === "trash"} aria-controls="inbox-panel-trash" onClick={() => chooseSection("trash")}>
              <Trash2 size={16} aria-hidden="true" /><span>回收站</span><small>{trashItems.length}</small>
            </button>
          </div>

          {section === "bookmarks" && bookmarkItems.length ? (
            <section id="inbox-panel-bookmarks" className="inbox-panel inbox-bookmarks" role="tabpanel" aria-labelledby="inbox-tab-bookmarks">
              <ol className="inbox-bookmark-list">
                {bookmarkItems.map((item) => (
                  <li key={item.intakeId}>{bookmarkCard(item, "live")}</li>
                ))}
              </ol>
            </section>
          ) : null}

          {section === "files" && fileItems.length ? (
            <section id="inbox-panel-files" className="inbox-panel inbox-file-shelf" role="tabpanel" aria-labelledby="inbox-tab-files">
              <ol className="inbox-file-grid">
                {fileItems.map((item) => (
                  <li key={item.intakeId}>{fileCard(item, "live")}</li>
                ))}
              </ol>
            </section>
          ) : null}

          {section === "photos" && photoItems.length ? (
            <section id="inbox-panel-photos" className="inbox-panel inbox-photo-shelf" role="tabpanel" aria-labelledby="inbox-tab-photos">
              <ol className="inbox-photo-grid">
                {photoItems.map((item) => (
                  <li key={item.intakeId}>{photoCard(item, "live")}</li>
                ))}
              </ol>
            </section>
          ) : null}

          {section === "projects" ? (
            <section id="inbox-panel-projects" className="inbox-panel" role="tabpanel" aria-labelledby="inbox-tab-projects">
              {renderProjects()}
            </section>
          ) : null}

          {section === "trash" ? (
            <section id="inbox-panel-trash" className="inbox-panel inbox-trash" role="tabpanel" aria-labelledby="inbox-tab-trash">
              {trashItems.length ? (
                <>
                  <header>
                    <button type="button" className="is-danger" disabled={emptying} onClick={() => void emptyTrash()}>
                      <Trash2 size={13} aria-hidden="true" />
                      {emptying ? "正在清理" : "全部清理"}
                    </button>
                  </header>
                  {trashPhotoItems.length ? (
                    <div className="inbox-trash-group">
                      <h3 className="inbox-trash-heading">照片</h3>
                      <ol className="inbox-photo-grid">
                        {trashPhotoItems.map((item) => (
                          <li key={item.intakeId}>{photoCard(item, "trash")}</li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                  {trashFileItems.length ? (
                    <div className="inbox-trash-group">
                      <h3 className="inbox-trash-heading">文件</h3>
                      <ol className="inbox-file-grid">
                        {trashFileItems.map((item) => (
                          <li key={item.intakeId}>{fileCard(item, "trash")}</li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                  {(trashPhotoItems.length && trashFileItems.length) || (trashFileItems.length && trashBookmarkItems.length) || (trashPhotoItems.length && trashBookmarkItems.length && !trashFileItems.length) ? (
                    <div className="inbox-trash-break" role="separator" />
                  ) : null}
                  {trashBookmarkItems.length ? (
                    <div className="inbox-trash-group">
                      <h3 className="inbox-trash-heading">书签</h3>
                      <ol className="inbox-bookmark-list">
                        {trashBookmarkItems.map((item) => (
                          <li key={item.intakeId}>{bookmarkCard(item, "trash")}</li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="inbox-trash-empty">删掉的来件会先放在这里，可以再放回去。</p>
              )}
            </section>
          ) : null}
        </div>
      ) : null}

      {preview ? (
        <AttachmentLightbox
          item={preview.item}
          attachment={preview.attachment}
          onClose={closePreview}
          onCopy={() => void copyItem(preview.item, preview.attachment)}
          copyState={copyStateFor(`${preview.item.intakeId}:${preview.attachment.attachmentId}`)}
          onSave={() => void saveImage(preview.item, preview.attachment)}
          onDownloadPrepared={() => downloadPreparedImage(preview.item, preview.attachment)}
          saveNote={saveNote}
          savePhase={savePhaseFor(saveKey(preview.item, preview.attachment))}
          canShareFiles={canShareFiles}
          showSaveImage={showSaveImage}
          onStep={stepPreview}
          slideLabel={previewIndex >= 0 && previewSlides.length > 1 ? `${previewIndex + 1} / ${previewSlides.length}` : ""}
          canStep={previewSlides.length > 1}
        />
      ) : null}
    </div>
  );
}
