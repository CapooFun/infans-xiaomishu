// 秘书收件箱·原图保存/分享的纯逻辑（无 DOM/网络依赖），方便用 node --test 做真实输入输出单测。
// 组件只负责 fetch / File / crypto.subtle / navigator 等副作用，判定与状态清理集中在这里。

export type SavePhase = "idle" | "preparing" | "armed" | "sharing" | "opened" | "downloaded" | "error" | "fallback";

const TRANSIENT_PHASES: readonly SavePhase[] = ["preparing", "armed", "sharing", "fallback"];

export const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif", "image/webp": "webp",
};

export const FILE_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

export type OriginalNameInput = { contentType: string; fileName: string; evidenceId?: string };

export function downloadNameFor(attachment: OriginalNameInput): string {
  const fallbackExt = (attachment.fileName.split(".").pop() || "bin").toLowerCase();
  const ext = IMAGE_EXTENSIONS[attachment.contentType] || FILE_EXTENSIONS[attachment.contentType] || fallbackExt;
  const base = attachment.evidenceId || attachment.fileName.replace(/\.[^.]+$/u, "") || (attachment.contentType.startsWith("image/") ? "photo" : "file");
  const safe = base.replace(/[\\/]+/gu, "-");
  return `${safe}.${ext}`;
}

export function magicMatches(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/png") return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/webp") return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (contentType === "image/heic" || contentType === "image/heif") return bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  if (contentType === "application/pdf") return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  return !contentType.startsWith("image/");
}

export type IntegrityInput = {
  bytes: Uint8Array;
  headerType: string;
  attachmentContentType: string;
  attachmentByteCount?: number | null;
  attachmentSha256?: string;
  actualSha256?: string;
};

export function checkOriginalIntegrity(input: IntegrityInput): { type: string } {
  const type = input.headerType || input.attachmentContentType;
  const isImage = type.startsWith("image/");
  if (input.attachmentContentType && type !== input.attachmentContentType) {
    throw new Error(isImage ? "取回的图片类型和记录不一致，请刷新后再试" : "取回的文件类型和记录不一致，请刷新后再试");
  }
  if (!type) throw new Error("取回的不是有效附件，请刷新后再试");
  if (!IMAGE_EXTENSIONS[type] && !FILE_EXTENSIONS[type]) {
    throw new Error(isImage ? "取回的不是图片，请刷新后再试" : "取回的不是有效附件，请刷新后再试");
  }
  if (input.attachmentByteCount != null && input.bytes.byteLength !== input.attachmentByteCount) {
    throw new Error(isImage ? "原图大小和记录不一致，请刷新后再试" : "文件大小和记录不一致，请刷新后再试");
  }
  if (!magicMatches(input.bytes, type)) throw new Error(isImage ? "取回的不是有效原图，请刷新后再试" : "取回的不是有效文件，请刷新后再试");
  if (input.attachmentSha256 && input.actualSha256 && input.actualSha256 !== input.attachmentSha256) {
    throw new Error(isImage ? "原图校验没通过，请刷新后再试" : "文件校验没通过，请刷新后再试");
  }
  return { type };
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function isAbortError(reason: unknown): boolean {
  return (reason as { name?: string })?.name === "AbortError";
}

export function classifyShareError(reason: unknown): "aborted" | "blocked" {
  return isAbortError(reason) ? "aborted" : "blocked";
}

export function canShareFileSafely(canShare: ((data: { files: File[] }) => boolean) | undefined, file: File): boolean {
  if (typeof canShare !== "function") return false;
  try {
    return Boolean(canShare({ files: [file] }));
  } catch {
    return false;
  }
}

export function pruneTempSaveState(state: Record<string, SavePhase>): Record<string, SavePhase> {
  let changed = false;
  const next: Record<string, SavePhase> = {};
  for (const [key, phase] of Object.entries(state)) {
    if (TRANSIENT_PHASES.includes(phase)) { changed = true; continue; }
    next[key] = phase;
  }
  return changed ? next : state;
}

export function saveButtonLabel(phase: SavePhase, armedShare: boolean, kind: "image" | "file" = "image"): string {
  const noun = kind === "file" ? "文件" : "图片";
  if (phase === "preparing") return "正在准备…";
  if (phase === "armed") return armedShare ? "再点一次·打开面板" : `保存${noun}`;
  if (phase === "sharing") return "正在打开面板…";
  if (phase === "opened") return "已打开保存面板";
  if (phase === "fallback") return kind === "file" ? "下载文件" : "下载原图";
  if (phase === "downloaded") return "已开始下载";
  if (phase === "error") return "重试保存";
  return `保存${noun}`;
}

export function decodeTextFileBytes(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  return new TextDecoder("utf-8").decode(bytes);
}
