import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Bookmark, Camera, Check, Copy, Download, ExternalLink, FileText, FolderOpen, Image as ImageIcon, Inbox, Link2, RefreshCw, RotateCcw, StickyNote, Trash2, X } from "lucide-react";
import { Card, Empty, Kicker, fmtDateTime, jsonFetch } from "../../page-shared";
import type { SavePhase } from "./yingning-inbox-save";
import { bytesToHex, canShareFileSafely, checkOriginalIntegrity, downloadNameFor, isAbortError, pruneTempSaveState, saveButtonLabel } from "./yingning-inbox-save";
import { isAppleMobileBrowser } from "./guide-share-platform.mjs";
import "./yingning-inbox.css";

type InboxAttachment = {
  attachmentId: string;
  role: "original";
  fileName: string;
  contentType: string;
  byteCount: number;
  pixelWidth?: number | null;
  pixelHeight?: number | null;
  createdAt: string;
  sha256: string;
};

type YingningInboxItem = {
  schemaVersion: 1 | 2;
  intakeId: string;
  url: string;
  title: string;
  text: string;
  note: string;
  source: "ios_share_extension" | "ipados_share_extension" | "ios_quick_photo" | "ipados_quick_photo" | "chrome_extension";
  sourceSemantic?: "shared_content" | "photo_share" | "quick_photo_inbox";
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
  attachments?: InboxAttachment[];
};

type YingningInboxSnapshot = {
  schemaVersion: 2;
  generatedAt: string;
  total: number;
  delivered: number;
  items: YingningInboxItem[];
  trash: YingningInboxItem[];
  trashCount: number;
  deliveryBoundary: string;
};

type PreviewTarget = {
  item: YingningInboxItem;
  attachment: InboxAttachment;
};

const SOURCE_LABELS: Record<YingningInboxItem["source"], string> = {
  ios_share_extension: "iPhone 分享",
  ipados_share_extension: "iPad 分享",
  ios_quick_photo: "iPhone 快速拍照",
  ipados_quick_photo: "iPad 快速拍照",
  chrome_extension: "Chrome 分享",
};

function titleFor(item: YingningInboxItem) {
  if (item.title) return item.title;
  if (item.url) {
    try { return new URL(item.url).hostname.replace(/^www\./u, ""); } catch { return "分享网址"; }
  }
  if (item.attachments?.length) return item.attachments.length === 1 ? item.attachments[0].fileName : `${item.attachments.length} 张照片`;
  return "分享文字";
}

function hostFor(url: string) {
  try { return new URL(url).hostname.replace(/^www\./u, ""); } catch { return "外部链接"; }
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
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
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
  if (/暂时做不出能发送的照片|没法把照片放进剪贴板|当前浏览器还不能复制图片/u.test(message)) return message;
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

function supportsFileShare() {
  try {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    const probe = new File([new Uint8Array([0])], "probe.jpg", { type: "image/jpeg" });
    return navigator.canShare({ files: [probe] });
  } catch { return false; }
}

function saveKey(item: YingningInboxItem, attachment: InboxAttachment) {
  return `${item.intakeId}:${attachment.attachmentId}`;
}

async function assertDecodableDimensions(blob: Blob, attachment: InboxAttachment) {
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

async function prepareOriginalFile(item: YingningInboxItem, attachment: InboxAttachment, signal?: AbortSignal) {
  const response = await fetch(attachmentURL(item, attachment.attachmentId), { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("暂时取不到这张原图，请刷新后再试");
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
  if (/原图|图片|刷新/u.test(message)) return message;
  return "这张图暂时没能保存，请再试一次";
}

function PhotoLightbox({ item, attachment, onClose, onCopy, copyState, onSave, onDownloadPrepared, saveNote, savePhase, canShareFiles, showSaveImage }: PreviewTarget & {
  onClose: () => void;
  onCopy: () => void;
  copyState: "idle" | "copied" | "error";
  onSave: () => void;
  onDownloadPrepared: () => void;
  saveNote: string;
  savePhase: SavePhase;
  canShareFiles: boolean;
  showSaveImage: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setUnavailable(false);
    closeRef.current?.focus({ preventScroll: true });
  }, [item.intakeId, attachment.attachmentId]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.documentElement.classList.add("inbox-lightbox-open");
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.documentElement.classList.remove("inbox-lightbox-open");
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [onClose]);

  const src = attachmentURL(item, attachment.attachmentId);
  const size = attachment.pixelWidth && attachment.pixelHeight
    ? `${attachment.pixelWidth}×${attachment.pixelHeight} · ${sizeLabel(attachment.byteCount)}`
    : sizeLabel(attachment.byteCount);

  return createPortal((
    <div className="inbox-lightbox" role="dialog" aria-modal="true" aria-labelledby="inbox-lightbox-title">
      <header>
        <div>
          <strong id="inbox-lightbox-title">{attachment.fileName}</strong>
          <span>{size}</span>
        </div>
        <nav aria-label="全图操作">
          {showSaveImage ? (
            <button type="button" className="inbox-lightbox-save" onClick={onSave} disabled={savePhase === "preparing" || savePhase === "sharing"} aria-label={`保存 ${attachment.fileName}`}>
              <Download size={16} aria-hidden="true" />
              <span>{saveButtonLabel(savePhase, canShareFiles)}</span>
            </button>
          ) : null}
          <button type="button" className="inbox-lightbox-copy" onClick={onCopy} aria-label={`复制 ${attachment.fileName}`}>
            <Copy size={16} aria-hidden="true" />
            <span>{copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制"}</span>
          </button>
          <button ref={closeRef} type="button" className="inbox-lightbox-close" onClick={onClose} aria-label="关闭全图">
            <X size={20} aria-hidden="true" />
            <span>关闭</span>
          </button>
        </nav>
      </header>
      <div className="inbox-lightbox-feedback">
        {showSaveImage && saveNote ? <p role="status" aria-live="polite">{saveNote}</p> : null}
        {showSaveImage && savePhase === "armed" ? (
          <button type="button" className="inbox-lightbox-save" onClick={onDownloadPrepared}>下载原图</button>
        ) : null}
      </div>
      <div className="inbox-lightbox-stage" onClick={onClose}>
        {unavailable ? (
          <span className="inbox-photo-fallback">
            <ImageIcon size={42} aria-hidden="true" />
            <small>{attachment.contentType === "image/heic" ? "HEIC 原图" : "原图暂时打不开"}</small>
          </span>
        ) : (
          <img src={src} alt={attachment.fileName} onClick={(event) => event.stopPropagation()} onError={() => setUnavailable(true)} />
        )}
      </div>
    </div>
  ), document.body);
}

export default function YingningInboxView({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<YingningInboxSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [section, setSection] = useState<"photos" | "bookmarks" | "projects" | "trash">("photos");
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [copiedKey, setCopiedKey] = useState("");
  const [copyFailedKey, setCopyFailedKey] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [restoringId, setRestoringId] = useState("");
  const [emptying, setEmptying] = useState(false);
  const [saveState, setSaveState] = useState<Record<string, SavePhase>>({});
  const [saveNote, setSaveNote] = useState("");
  const armedFile = useRef<{ key: string; file: File } | null>(null);
  const saveRequestRef = useRef(0);
  const savePrepareController = useRef<AbortController | null>(null);
  const copyReset = useRef<number | null>(null);
  const canShareFiles = useMemo(() => supportsFileShare(), []);
  const showSaveImage = useMemo(() => isAppleMobileBrowser(), []);
  const closePreview = useCallback(() => setPreview(null), []);
  const savePhaseFor = (key: string): SavePhase => saveState[key] ?? "idle";

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

  useEffect(() => {
    if (!active) {
      setPreview(null);
      return;
    }
    void load();
  }, [active]);

  useEffect(() => {
    clearArmedSave();
  }, [active, preview?.item.intakeId, preview?.attachment.attachmentId, section, clearArmedSave]);

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

  const copyItem = async (item: YingningInboxItem, attachment?: InboxAttachment) => {
    const key = attachment ? `${item.intakeId}:${attachment.attachmentId}` : item.intakeId;
    try {
      if (attachment) await copyShareImage(attachmentURL(item, attachment.attachmentId, true));
      else if (item.attachments?.length) await copyShareImage(attachmentURL(item, item.attachments[0].attachmentId, true));
      else await copyText(clipboardTextFor(item));
      markCopied(key, true);
      setActionError("");
    } catch (reason) {
      markCopied(key, false);
      setActionError(clipboardFailure(reason));
    }
  };

  const markSave = (key: string, phase: SavePhase) => setSaveState((current) => ({ ...current, [key]: phase }));

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

  const downloadPreparedImage = (item: YingningInboxItem, attachment: InboxAttachment) => {
    const key = saveKey(item, attachment);
    const prepared = armedFile.current;
    if (prepared?.key !== key) return;
    downloadArmed(key, prepared.file, `已开始下载原图 ${prepared.file.name}，请在“下载”或“文件”里查看。`);
  };

  const beginPrepare = (key: string): { requestId: number; signal: AbortSignal } => {
    const requestId = ++saveRequestRef.current;
    savePrepareController.current?.abort();
    const controller = new AbortController();
    savePrepareController.current = controller;
    armedFile.current = null;
    setSaveState((current) => ({ ...pruneTempSaveState(current), [key]: "preparing" }));
    setSaveNote("正在准备原图…");
    return { requestId, signal: controller.signal };
  };

  const saveImage = async (item: YingningInboxItem, attachment: InboxAttachment) => {
    const key = saveKey(item, attachment);
    setActionError("");

    if (savePhaseFor(key) === "fallback" && armedFile.current?.key === key) {
      downloadArmed(key, armedFile.current.file, `已开始下载原图 ${armedFile.current.file.name}，请在“下载”或“文件”里查看。`);
      return;
    }

    if (canShareFiles) {
      if (armedFile.current?.key === key) {
        const file = armedFile.current.file;
        if (!canShareFileSafely(navigator.canShare?.bind(navigator), file)) {
          downloadArmed(key, file, `这台设备不支持直接分享这个格式，已改为下载原图 ${file.name}，请在“下载”或“文件”里查看。`);
          return;
        }
        armedFile.current = null;
        const shareRequestId = saveRequestRef.current;
        markSave(key, "sharing");
        try {
          await navigator.share({ files: [file] });
          if (shareRequestId !== saveRequestRef.current) return;
          markSave(key, "opened");
          setSaveNote("已交给系统的保存/分享面板，请在里面选“存储到照片”或“存储到文件”；这一步不代表已写入相册。");
        } catch (reason) {
          if (shareRequestId !== saveRequestRef.current) return;
          if (isAbortError(reason)) {
            markSave(key, "idle");
            setSaveNote("已取消分享。");
            return;
          }
          armedFile.current = { key, file };
          markSave(key, "fallback");
          setSaveNote("系统没允许打开分享面板。再点一次“下载原图”，然后在“下载”或“文件”里查看。");
        }
        return;
      }
      const { requestId, signal } = beginPrepare(key);
      try {
        const file = await prepareOriginalFile(item, attachment, signal);
        if (requestId !== saveRequestRef.current) return;
        armedFile.current = { key, file };
        markSave(key, "armed");
        setSaveNote("原图已备好。再点一次“保存图片”打开系统面板，选“存储到照片”或“存储到文件”。");
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
      setSaveNote(`已开始下载原图 ${file.name}，请在“下载”或“文件”里查看。`);
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

  const saveButton = (item: YingningInboxItem, attachment: InboxAttachment) => {
    const key = saveKey(item, attachment);
    const phase = savePhaseFor(key);
    return (
      <button type="button" className="inbox-save" data-phase={phase} onClick={() => void saveImage(item, attachment)} aria-label={`保存 ${attachment.fileName}`}>
        <Download size={13} aria-hidden="true" />
        {saveButtonLabel(phase, canShareFiles)}
      </button>
    );
  };

  const photoSaveSlot = (item: YingningInboxItem) => {
    if (!showSaveImage) return null;
    const list = item.attachments ?? [];
    if (list.length === 1) return saveButton(item, list[0]);
    if (list.length > 1) return <span className="inbox-photo-pick">多张照片：点开你要的那张再保存</span>;
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

  const bookmarkCard = (item: YingningInboxItem, mode: "live" | "trash") => (
    <article className="inbox-bookmark-card">
      <span className="inbox-bookmark-tab" aria-hidden="true">{item.url ? <Bookmark size={15} /> : <FileText size={15} />}</span>
      <div className="inbox-bookmark-body">
        <header>
          <span>{SOURCE_LABELS[item.source]}</span>
          <time dateTime={mode === "trash" && item.trashedAt ? item.trashedAt : item.receivedAt}>
            {mode === "trash" ? (item.trashedAt ? `删于 ${fmtDateTime(item.trashedAt)}` : "已删") : fmtDateTime(item.receivedAt)}
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
            {mode === "live" ? <span><Check size={12} aria-hidden="true" />已存</span> : null}
            {item.duplicateCount > 0 ? <small>已合并 {item.duplicateCount} 次重复投递</small> : null}
          </footer>
          {mode === "live" ? itemActions(item) : restoreActions(item)}
        </div>
      </div>
    </article>
  );

  const photoCard = (item: YingningInboxItem, mode: "live" | "trash") => (
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
          <span>{item.sourceSemantic === "quick_photo_inbox" ? <Camera size={13} aria-hidden="true" /> : <ImageIcon size={13} aria-hidden="true" />}{SOURCE_LABELS[item.source]}</span>
          {mode === "live" ? (
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
        {item.text ? <p>{item.text}</p> : null}
        {item.note ? <div className="inbox-note"><StickyNote size={14} aria-hidden="true" /><span>{item.note}</span></div> : null}
        <div className="inbox-card-end">
          <footer>
            <span>{item.attachments?.map((attachment) => `${attachment.pixelWidth && attachment.pixelHeight ? `${attachment.pixelWidth}×${attachment.pixelHeight} · ` : ""}${sizeLabel(attachment.byteCount)}`).join("；")}</span>
            {item.duplicateCount > 0 ? <small>已合并 {item.duplicateCount} 次重复投递</small> : null}
          </footer>
          {mode === "live" ? (
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

  const items = snapshot?.items ?? [];
  const trashItems = snapshot?.trash ?? [];
  const photoItems = items.filter((item) => Boolean(item.attachments?.length));
  const bookmarkItems = items.filter((item) => !item.attachments?.length);
  const trashPhotoItems = trashItems.filter((item) => Boolean(item.attachments?.length));
  const trashBookmarkItems = trashItems.filter((item) => !item.attachments?.length);
  const photoCount = photoItems.reduce((total, item) => total + (item.attachments?.length ?? 0), 0);

  useEffect(() => {
    if (section === "trash" || section === "projects") return;
    if (section === "photos" && !photoItems.length) {
      if (bookmarkItems.length) setSection("bookmarks");
      else if (trashItems.length) setSection("trash");
    }
    if (section === "bookmarks" && !bookmarkItems.length) {
      if (photoItems.length) setSection("photos");
      else if (trashItems.length) setSection("trash");
    }
  }, [bookmarkItems.length, photoItems.length, section, trashItems.length]);

  return (
    <div className="inbox">
      <Card className="inbox-hero">
        <div className="inbox-hero-copy">
          <Kicker>来件 · 待处理区</Kicker>
          <h2>秘书收件箱</h2>
          <p>照片与书签先在这里分开放好；没经确认，它们不会自动进入知识库。</p>
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
      {showSaveImage && saveNote ? (
        <div className="inbox-savenote" role="status">
          <Download size={15} aria-hidden="true" />
          <span>{saveNote}</span>
        </div>
      ) : null}

      {loading && !snapshot ? <Empty>正在查看有没有新来件。</Empty> : null}
      {!loading && snapshot && items.length === 0 && trashItems.length === 0 ? (
        <Card className="inbox-empty">
          <Inbox size={28} aria-hidden="true" />
          <div><strong>还没有送达的来件</strong><p>秘书收件箱暂时没有新来件。随时可以从手机或浏览器把链接、灵感分享过来。</p></div>
        </Card>
      ) : null}

      {items.length || trashItems.length ? (
        <div className="inbox-library">
          <div className="inbox-tabs" role="tablist" aria-label="收件分类">
            <button id="inbox-tab-photos" type="button" role="tab" aria-selected={section === "photos"} aria-controls="inbox-panel-photos" disabled={!photoItems.length} onClick={() => setSection("photos")}>
              <ImageIcon size={16} aria-hidden="true" /><span>照片</span><small>{photoCount}</small>
            </button>
            <button id="inbox-tab-bookmarks" type="button" role="tab" aria-selected={section === "bookmarks"} aria-controls="inbox-panel-bookmarks" disabled={!bookmarkItems.length} onClick={() => setSection("bookmarks")}>
              <Bookmark size={16} aria-hidden="true" /><span>书签</span><small>{bookmarkItems.length}</small>
            </button>
            <button id="inbox-tab-projects" type="button" role="tab" aria-selected={section === "projects"} aria-controls="inbox-panel-projects" onClick={() => setSection("projects")}>
              <FolderOpen size={16} aria-hidden="true" /><span>项目收件</span><small>0</small>
            </button>
            <button id="inbox-tab-trash" type="button" role="tab" aria-selected={section === "trash"} aria-controls="inbox-panel-trash" onClick={() => setSection("trash")}>
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
              <p className="inbox-trash-empty">还没有项目来件。</p>
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
                  {trashPhotoItems.length && trashBookmarkItems.length ? (
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
        <PhotoLightbox
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
        />
      ) : null}
    </div>
  );
}
