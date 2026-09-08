// 秘书收件箱·原图保存/分享的纯逻辑（无 DOM/网络依赖），方便用 node --test 做真实输入输出单测。
// 组件只负责 fetch / File / crypto.subtle / navigator 等副作用，判定与状态清理集中在这里。

export type SavePhase = "idle" | "preparing" | "armed" | "sharing" | "opened" | "downloaded" | "error" | "fallback";

const TRANSIENT_PHASES: readonly SavePhase[] = ["preparing", "armed", "sharing", "fallback"];

export const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif", "image/webp": "webp",
};

export type OriginalNameInput = { contentType: string; fileName: string; evidenceId?: string };

export function downloadNameFor(attachment: OriginalNameInput): string {
  const fallbackExt = (attachment.fileName.split(".").pop() || "img").toLowerCase();
  const ext = IMAGE_EXTENSIONS[attachment.contentType] || fallbackExt;
  const base = attachment.evidenceId || attachment.fileName.replace(/\.[^.]+$/u, "") || "photo";
  const safe = base.replace(/[\\/]+/gu, "-");
  return `${safe}.${ext}`;
}

export function magicMatches(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/png") return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/webp") return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (contentType === "image/heic" || contentType === "image/heif") return bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  return false;
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
  if (input.attachmentContentType && type !== input.attachmentContentType) {
    throw new Error("取回的图片类型和记录不一致，请刷新后再试");
  }
  if (!type.startsWith("image/")) throw new Error("取回的不是图片，请刷新后再试");
  if (input.attachmentByteCount != null && input.bytes.byteLength !== input.attachmentByteCount) {
    throw new Error("原图大小和记录不一致，请刷新后再试");
  }
  if (!magicMatches(input.bytes, type)) throw new Error("取回的不是有效原图，请刷新后再试");
  if (input.attachmentSha256 && input.actualSha256 && input.actualSha256 !== input.attachmentSha256) {
    throw new Error("原图校验没通过，请刷新后再试");
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

export function saveButtonLabel(phase: SavePhase, armedShare: boolean): string {
  if (phase === "preparing") return "正在准备…";
  if (phase === "armed") return armedShare ? "再点一次·打开面板" : "保存图片";
  if (phase === "sharing") return "正在打开面板…";
  if (phase === "opened") return "已打开保存面板";
  if (phase === "fallback") return "下载原图";
  if (phase === "downloaded") return "已开始下载";
  if (phase === "error") return "重试保存";
  return "保存图片";
}
