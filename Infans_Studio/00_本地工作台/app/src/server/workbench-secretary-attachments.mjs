/**
 * 小秘书聊天附件：二进制原文 + 明文 JSON 元数据，落盘到 App 包外的受控运行目录。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { SECRETARY_ATTACHMENTS_DIR } from "./vault-paths.mjs";

export const SECRETARY_ATTACHMENTS_DIR_RELATIVE = SECRETARY_ATTACHMENTS_DIR;
export const MAX_ATTACHMENTS_PER_TURN = 4;

const IMAGE_MAX = 8 * 1024 * 1024;
const AUDIO_MAX = 5 * 1024 * 1024;
const FILE_MAX = 15 * 1024 * 1024;

// 聊天存档与附件共享同一张“引用图”。所有会改变这张图的操作都按 Vault 根串行，
// 避免一份聊天刚引用附件，另一个删除请求就把它当成孤儿清理掉。
const archiveMutationTails = new Map();

export async function withSecretaryArchiveMutation(vaultRoot, operation) {
  const key = path.resolve(vaultRoot);
  const previous = archiveMutationTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  archiveMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (archiveMutationTails.get(key) === tail) archiveMutationTails.delete(key);
  }
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);
const AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-m4a",
  "video/webm", // MediaRecorder 有时标成 video/webm 但只有音轨
]);
const FILE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export const SECRETARY_ATTACHMENT_LIMITS = Object.freeze({
  maximumPerTurn: MAX_ATTACHMENTS_PER_TURN,
  maximumBytes: Object.freeze({ image: IMAGE_MAX, audio: AUDIO_MAX, file: FILE_MAX }),
  maximumDurationMs: Object.freeze({ audio: 90_000 }),
  allowedMimeTypes: Object.freeze([...IMAGE_TYPES, ...AUDIO_TYPES, ...FILE_TYPES]),
});

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-m4a": ".m4a",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

export function secretaryAttachmentsDir(vaultRoot) {
  return path.resolve(vaultRoot, SECRETARY_ATTACHMENTS_DIR_RELATIVE);
}

async function ensureAttachmentsDir(vaultRoot) {
  const dir = secretaryAttachmentsDir(vaultRoot);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  return dir;
}

function normalizeMime(raw = "") {
  return String(raw || "").split(";")[0].trim().toLowerCase();
}

function kindFromMime(mime) {
  if (IMAGE_TYPES.has(mime)) return "image";
  if (AUDIO_TYPES.has(mime)) return "audio";
  if (FILE_TYPES.has(mime)) return "file";
  return "";
}

function maxBytesForKind(kind) {
  if (kind === "image") return IMAGE_MAX;
  if (kind === "audio") return AUDIO_MAX;
  return FILE_MAX;
}

function sanitizeFileName(raw = "") {
  const base = path.basename(String(raw || "附件")).replace(/[\\/:*?"<>|\0]+/g, "_").trim();
  const cleaned = base.replace(/^\.+/, "").slice(0, 120);
  return cleaned || "附件";
}

function extensionFor(mime, fileName) {
  const fromName = path.extname(fileName || "").toLowerCase();
  if (fromName && fromName.length <= 8 && /^\.[a-z0-9.]+$/i.test(fromName)) return fromName;
  return EXT_BY_MIME[mime] || "";
}

function assertSafeAttachmentId(id) {
  const value = String(id || "").trim();
  if (!/^[0-9A-Za-z_-]{8,80}$/.test(value) || value.includes("..")) {
    throw new WorkbenchWriteError("附件编号不对", 400, "INVALID_ATTACHMENT_ID");
  }
  return value;
}

async function readRequestBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new WorkbenchWriteError("附件太大了", 413, "ATTACHMENT_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function atomicWritePrivate(absolute, bytes) {
  const temporary = `${absolute}.infans-tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function attachmentUrl(id) {
  return `/api/secretary-attachments/${encodeURIComponent(id)}`;
}

export function attachmentVaultPath(id, storedName) {
  return path.posix.join(SECRETARY_ATTACHMENTS_DIR_RELATIVE, storedName || id);
}

function publicAttachmentMeta(raw, id, storedName) {
  const mime = normalizeMime(raw?.mime) || "application/octet-stream";
  const kind = raw?.kind === "image" || raw?.kind === "audio" || raw?.kind === "file"
    ? raw.kind
    : kindFromMime(mime) || "file";
  const meta = {
    id,
    kind,
    name: sanitizeFileName(raw?.name || "附件"),
    mime,
    size: Number(raw?.size) || 0,
    sha256: /^[a-f0-9]{64}$/u.test(String(raw?.sha256 || "")) ? String(raw.sha256) : null,
    createdAt: Number.isFinite(Date.parse(String(raw?.createdAt || ""))) ? new Date(raw.createdAt).toISOString() : null,
    path: attachmentVaultPath(id, storedName),
    url: attachmentUrl(id),
  };
  if (Number(raw?.durationMs) > 0) meta.durationMs = Number(raw.durationMs);
  return meta;
}

async function writePlaintextSecretaryAttachmentUnlocked(vaultRoot, input) {
  const id = input.id ? assertSafeAttachmentId(input.id) : `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data || "");
  const mime = normalizeMime(input.meta?.mime);
  const ext = extensionFor(mime, input.meta?.name);
  // application/json 的原文不能与 `${id}.json` 元数据同名。
  const storedName = ext === ".json" ? `${id}.data.json` : `${id}${ext}`;
  const dir = await ensureAttachmentsDir(vaultRoot);
  const absolute = path.join(dir, storedName);
  const metaPath = path.join(dir, `${id}.json`);
  const meta = publicAttachmentMeta({
    ...input.meta,
    mime,
    size: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    createdAt: input.meta?.createdAt || new Date().toISOString(),
  }, id, storedName);
  try {
    await atomicWritePrivate(absolute, data);
    await atomicWritePrivate(metaPath, Buffer.from(`${JSON.stringify({ ...meta, storedName }, null, 2)}\n`, "utf8"));
  } catch (error) {
    await fs.rm(absolute, { force: true }).catch(() => undefined);
    await fs.rm(metaPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { ...meta, _absolute: absolute };
}

/**
 * @returns {Promise<{ id: string, kind: "image"|"audio"|"file", name: string, mime: string, size: number, path: string, url: string, durationMs?: number }>}
 */
export async function saveSecretaryAttachment(vaultRoot, request) {
  const mime = normalizeMime(request.headers["content-type"] || request.headers["x-infans-mime"] || "");
  const kind = kindFromMime(mime);
  if (!kind) throw new WorkbenchWriteError("这种文件还不能发给秘书", 415, "ATTACHMENT_TYPE_UNSUPPORTED");

  const fileName = sanitizeFileName(decodeURIComponent(String(request.headers["x-infans-filename"] || "附件")));
  const durationHeader = Number(request.headers["x-infans-duration-ms"] || 0);
  if (kind === "audio" && Number.isFinite(durationHeader) && durationHeader > 90_000) {
    throw new WorkbenchWriteError("语音太长了，九十秒以内就好", 413, "ATTACHMENT_AUDIO_TOO_LONG");
  }
  const durationMs = Number.isFinite(durationHeader) && durationHeader > 0 ? Math.round(durationHeader) : undefined;

  const body = await readRequestBody(request, maxBytesForKind(kind));
  if (!body.length) throw new WorkbenchWriteError("没有收到附件内容", 400, "ATTACHMENT_EMPTY");

  const requestedId = String(request.headers["x-infans-attachment-id"] || "").trim();
  const stableId = requestedId ? assertSafeAttachmentId(requestedId) : "";
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");

  const saved = await withSecretaryArchiveMutation(vaultRoot, async () => {
    if (stableId) {
      let existing = null;
      try {
        existing = await readSecretaryAttachment(vaultRoot, stableId);
      } catch (error) {
        if (error?.code !== "ATTACHMENT_NOT_FOUND") throw error;
      }
      if (existing) {
        const existingSha = existing.sha256 || crypto.createHash("sha256").update(existing.data).digest("hex");
        const same = existingSha === sha256
          && existing.mime === mime
          && existing.kind === kind
          && existing.name === fileName
          && Number(existing.durationMs || 0) === Number(durationMs || 0);
        if (!same) {
          throw new WorkbenchWriteError("同一附件 ID 已对应不同内容", 409, "ATTACHMENT_IDEMPOTENCY_CONFLICT");
        }
        const { data: _data, absolute: _absolute, storedName: _storedName, ...meta } = existing;
        return { ...meta, sha256: existingSha, created: false, duplicate: true };
      }
    }
    const created = await writePlaintextSecretaryAttachmentUnlocked(vaultRoot, {
      id: stableId || undefined,
      meta: { kind, name: fileName, mime, durationMs, sha256 },
      data: body,
    });
    return { ...created, created: true, duplicate: false };
  });
  const { _absolute, ...meta } = saved;
  return meta;
}

async function loadMeta(vaultRoot, id) {
  const safeId = assertSafeAttachmentId(id);
  const dir = secretaryAttachmentsDir(vaultRoot);
  const metaPath = path.join(dir, `${safeId}.json`);
  try {
    const raw = JSON.parse(await fs.readFile(metaPath, "utf8"));
    const storedName = sanitizeFileName(raw?.storedName || `${safeId}${extensionFor(normalizeMime(raw?.mime), raw?.name)}`);
    if (storedName.includes("..")) throw new WorkbenchWriteError("附件元数据坏了", 500, "ATTACHMENT_META_BAD");
    return {
      ...publicAttachmentMeta(raw, safeId, storedName),
      storedName,
      absolute: path.join(dir, storedName),
    };
  } catch (error) {
    if (error instanceof WorkbenchWriteError) throw error;
    if (error?.code === "ENOENT") throw new WorkbenchWriteError("找不到该附件", 404, "ATTACHMENT_NOT_FOUND");
    throw error;
  }
}

/**
 * 只检查引用目标是否还在，不读入大文件。
 * 调用方需在 withSecretaryArchiveMutation 内完成“检查 + 写聊天”。
 */
export async function assertSecretaryAttachmentExists(vaultRoot, id) {
  const meta = await loadMeta(vaultRoot, id);
  try {
    await fs.access(meta.absolute);
  } catch (error) {
    if (error?.code === "ENOENT") throw new WorkbenchWriteError("找不到该附件", 404, "ATTACHMENT_NOT_FOUND");
    throw error;
  }
}

export async function resolveSecretaryAttachments(vaultRoot, ids = []) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const unique = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, MAX_ATTACHMENTS_PER_TURN);
  const items = [];
  for (const id of unique) items.push(await loadMeta(vaultRoot, id));
  return items.map(({ absolute, storedName, ...rest }) => rest);
}

export async function describeSecretaryAttachment(vaultRoot, id) {
  const [item] = await resolveSecretaryAttachments(vaultRoot, [id]);
  if (!item) throw new WorkbenchWriteError("找不到该附件", 404, "ATTACHMENT_NOT_FOUND");
  return item;
}

export async function readSecretaryAttachment(vaultRoot, id) {
  const meta = await loadMeta(vaultRoot, id);
  let data;
  try {
    data = await fs.readFile(meta.absolute);
  } catch (error) {
    if (error?.code === "ENOENT") throw new WorkbenchWriteError("找不到该附件", 404, "ATTACHMENT_NOT_FOUND");
    throw error;
  }
  return { ...meta, data };
}

/** 删除附件二进制与旁路元数据；不存在时静默成功。 */
async function deleteSecretaryAttachmentUnlocked(vaultRoot, id) {
  const safeId = assertSafeAttachmentId(id);
  const dir = secretaryAttachmentsDir(vaultRoot);
  const metaPath = path.join(dir, `${safeId}.json`);
  let storedName = "";
  try {
    const raw = JSON.parse(await fs.readFile(metaPath, "utf8"));
    storedName = sanitizeFileName(raw?.storedName || "");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (storedName && !storedName.includes("..")) {
    await fs.rm(path.join(dir, storedName), { force: true });
  } else {
    let entries = [];
    try { entries = await fs.readdir(dir); } catch { entries = []; }
    for (const name of entries) {
      if (name === `${safeId}.json`) continue;
      if (name === safeId || name.startsWith(`${safeId}.`)) await fs.rm(path.join(dir, name), { force: true });
    }
  }
  await fs.rm(metaPath, { force: true });
  return { id: safeId, deleted: true };
}

export function deleteSecretaryAttachment(vaultRoot, id, options = {}) {
  if (options.archiveLockHeld) return deleteSecretaryAttachmentUnlocked(vaultRoot, id);
  return withSecretaryArchiveMutation(vaultRoot, () => deleteSecretaryAttachmentUnlocked(vaultRoot, id));
}
