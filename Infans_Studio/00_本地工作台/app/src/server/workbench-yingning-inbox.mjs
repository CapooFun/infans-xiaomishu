import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { SECRETARY_INTAKE_DIR } from "./vault-paths.mjs";

const execFileAsync = promisify(execFile);

const INTAKE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEVICE_ID = /^[a-z0-9._-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const CHECKPOINT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;
const ALLOWED_SOURCES = new Set([
  "ios_share_extension", "ipados_share_extension", "ios_quick_photo", "ipados_quick_photo",
  "chrome_extension",
]);
const SOURCE_SEMANTICS = new Set(["shared_content", "photo_share", "file_share", "quick_photo_inbox"]);
const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"], ["image/heic", "heic"],
  ["image/heif", "heif"], ["image/webp", "webp"],
]);
const FILE_TYPES = new Map([
  ["application/pdf", "pdf"],
  ["text/plain", "txt"],
  ["text/markdown", "md"],
  ["text/csv", "csv"],
  ["application/json", "json"],
  ["application/msword", "doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.ms-excel", "xls"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.ms-powerpoint", "ppt"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
]);
const ATTACHMENT_TYPES = new Map([...IMAGE_TYPES, ...FILE_TYPES]);

function attachmentExtension(contentType) {
  return ATTACHMENT_TYPES.get(contentType) || "";
}

function isPlainTextContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  return type === "text/plain" || type === "text/markdown" || type === "text/csv" || type === "application/json";
}

const MAX_TEXT_PASTEBOARD_BYTES = 1_048_576;

export function pasteboardCopyScript(alsoText) {
  const textBlock = alsoText ? `
  set theData to current application's NSData's dataWithContentsOfFile:thePath
  set theString to (current application's NSString's alloc()'s initWithData:theData encoding:(current application's NSUTF8StringEncoding))
  if theString is missing value then
    set theString to (current application's NSString's alloc()'s initWithData:theData encoding:(current application's NSUTF16LittleEndianStringEncoding))
  end if
  if theString is missing value then
    set theString to (current application's NSString's alloc()'s initWithData:theData encoding:(current application's NSUTF16BigEndianStringEncoding))
  end if
  if theString is not missing value then
    pb's setString:theString forType:(current application's NSPasteboardTypeString)
  end if` : "";
  return `use framework "AppKit"
use framework "Foundation"
on run argv
  set thePath to item 1 of argv
  set theURL to current application's NSURL's fileURLWithPath:thePath
  set pb to current application's NSPasteboard's generalPasteboard()
  pb's clearContents()
  set wrote to pb's writeObjects:{theURL}
  ${textBlock}
  return wrote
end run`;
}

function clipboardFileName(attachment) {
  const ext = attachmentExtension(attachment.contentType) || "bin";
  const raw = String(attachment.fileName || "file").replace(/[\\/]+/gu, "-").trim() || "file";
  const base = raw.replace(/\.[^.]+$/u, "") || "file";
  return `${base}.${ext}`;
}

async function stageClipboardCopy(sourcePath, fileName) {
  const dir = path.join(os.tmpdir(), "infans-inbox-clipboard");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  const staged = path.join(dir, fileName);
  if (path.dirname(staged) !== dir || path.basename(staged) !== fileName) {
    throw new WorkbenchWriteError("文件名不合法", 400, "YINGNING_ATTACHMENT_NAME_INVALID");
  }
  for (const name of await fs.readdir(dir)) {
    if (name !== fileName) await fs.rm(path.join(dir, name), { force: true });
  }
  await fs.copyFile(sourcePath, staged);
  await fs.chmod(staged, 0o600).catch(() => {});
  return staged;
}

async function defaultCopyFileToPasteboard(filePath, { alsoText = false } = {}) {
  if (process.platform !== "darwin") {
    throw new WorkbenchWriteError("这台电脑不能把文件放进系统剪贴板", 501, "YINGNING_CLIPBOARD_UNAVAILABLE");
  }
  const { stdout } = await execFileAsync("/usr/bin/osascript", [
    "-e",
    pasteboardCopyScript(alsoText),
    filePath,
  ], { timeout: 8_000 });
  if (!/true/iu.test(String(stdout))) {
    throw new WorkbenchWriteError("没能把文件放进剪贴板", 500, "YINGNING_CLIPBOARD_FAILED");
  }
}

function isImageAttachmentType(contentType) {
  return IMAGE_TYPES.has(contentType);
}

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const CONTENT_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60_000;
const SHARE_COPY_PIXELS = 1600;

function textField(value, maxLength, label, { optional = true } = {}) {
  const normalized = String(value ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!normalized && optional) return "";
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTERS.test(normalized)) {
    throw new WorkbenchWriteError(`${label}不合法`, 400, "YINGNING_INTAKE_TEXT_INVALID");
  }
  return normalized;
}

function normalizeUrl(value) {
  const raw = textField(value, 4_096, "来件网址");
  if (!raw) return "";
  let parsed;
  try { parsed = new URL(raw); } catch { throw new WorkbenchWriteError("来件网址不合法", 400, "YINGNING_INTAKE_URL_INVALID"); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new WorkbenchWriteError("来件网址只支持 HTTP 或 HTTPS", 400, "YINGNING_INTAKE_URL_INVALID");
  }
  return parsed.toString();
}

function optionalIdField(value, regex, label, code, { lowercase = false } = {}) {
  let raw = String(value ?? "").trim();
  if (!raw) return "";
  if (lowercase) raw = raw.toLowerCase();
  if (!regex.test(raw)) throw new WorkbenchWriteError(label, 400, code);
  return raw;
}

function normalizeCheckpointMeta(input, checkpointId) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new WorkbenchWriteError("检查点信息不合法", 400, "YINGNING_INTAKE_CHECKPOINT_META_INVALID");
  }
  const name = textField(input.name, 120, "检查点名称");
  const source = textField(input.source, 200, "检查点源码标识");
  const build = textField(input.build, 200, "检查点构建标识");
  const manifestSha = optionalIdField(input.manifestSha, SHA256, "检查点清单摘要不合法", "YINGNING_INTAKE_CHECKPOINT_MANIFEST_INVALID", { lowercase: true });
  const capturedRaw = String(input.capturedAt ?? "").trim();
  let capturedAt = "";
  if (capturedRaw) {
    const parsed = new Date(capturedRaw);
    if (Number.isNaN(parsed.getTime())) throw new WorkbenchWriteError("检查点采集时间不合法", 400, "YINGNING_INTAKE_CHECKPOINT_TIME_INVALID");
    capturedAt = parsed.toISOString();
  }
  const meta = {
    ...(checkpointId ? { checkpointId } : {}),
    ...(name ? { name } : {}),
    ...(source ? { source } : {}),
    ...(build ? { build } : {}),
    ...(manifestSha ? { manifestSha } : {}),
    ...(capturedAt ? { capturedAt } : {}),
  };
  return Object.keys(meta).length ? meta : null;
}

function normalizeAttachment(input) {
  const attachmentId = String(input?.attachmentId || "").trim().toLowerCase();
  const role = String(input?.role || "").trim();
  const contentType = String(input?.contentType || "").trim().toLowerCase();
  const declaredBytes = Number(input?.byteCount);
  const declaredHash = String(input?.sha256 || "").trim().toLowerCase();
  const createdAt = String(input?.createdAt || "").trim();
  const isImage = isImageAttachmentType(contentType);
  if (!INTAKE_ID.test(attachmentId)) throw new WorkbenchWriteError("附件 ID 不合法", 400, "YINGNING_ATTACHMENT_ID_INVALID");
  if (role !== "original") throw new WorkbenchWriteError("只接收原件附件", 400, "YINGNING_ATTACHMENT_ROLE_INVALID");
  if (!ATTACHMENT_TYPES.has(contentType)) throw new WorkbenchWriteError(isImage ? "照片格式不受支持" : "文件格式不受支持", 415, "YINGNING_ATTACHMENT_TYPE_INVALID");
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > MAX_ATTACHMENT_BYTES) {
    throw new WorkbenchWriteError(isImage ? "单张照片不能超过 24 MB" : "单个文件不能超过 24 MB", 413, "YINGNING_ATTACHMENT_TOO_LARGE");
  }
  if (!SHA256.test(declaredHash)) throw new WorkbenchWriteError(isImage ? "原图摘要不合法" : "文件摘要不合法", 400, "YINGNING_ATTACHMENT_HASH_INVALID");
  if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) throw new WorkbenchWriteError(isImage ? "原图时间不合法" : "文件时间不合法", 400, "YINGNING_ATTACHMENT_TIME_INVALID");
  if (typeof input?.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data)) {
    throw new WorkbenchWriteError(isImage ? "原图数据不完整" : "文件数据不完整", 400, "YINGNING_ATTACHMENT_DATA_INVALID");
  }
  const data = Buffer.from(input.data, "base64");
  if (data.length !== declaredBytes || crypto.createHash("sha256").update(data).digest("hex") !== declaredHash) {
    throw new WorkbenchWriteError(isImage ? "原图大小或摘要不匹配" : "文件大小或摘要不匹配", 400, "YINGNING_ATTACHMENT_INTEGRITY_INVALID");
  }
  const fileName = path.basename(textField(input?.fileName, 240, isImage ? "原图文件名" : "来件文件名", { optional: false }));
  const pixelWidth = Number.isSafeInteger(input?.pixelWidth) && input.pixelWidth > 0 ? input.pixelWidth : null;
  const pixelHeight = Number.isSafeInteger(input?.pixelHeight) && input.pixelHeight > 0 ? input.pixelHeight : null;
  const evidenceId = optionalIdField(input?.evidenceId, EVIDENCE_ID, "证据编号不合法", "YINGNING_ATTACHMENT_EVIDENCE_INVALID");
  return {
    metadata: {
      attachmentId, role, fileName, contentType, byteCount: data.length, pixelWidth, pixelHeight,
      createdAt: new Date(createdAt).toISOString(), sha256: declaredHash,
      ...(evidenceId ? { evidenceId } : {}),
    },
    data,
  };
}

function fingerprintFor(item) {
  const base = {
    url: item.url, title: item.title, text: item.text, note: item.note,
    attachments: item.attachments.map(({ sha256, byteCount, contentType }) => ({ sha256, byteCount, contentType })),
  };
  if (item.projectId) {
    base.projectId = item.projectId;
    base.checkpointId = item.checkpointId || "";
    base.evidenceIds = item.attachments.map((row) => row.evidenceId || "");
  }
  return crypto.createHash("sha256").update(JSON.stringify(base)).digest("hex");
}

export function normalizeYingningIntake(input) {
  const schemaVersion = Number(input?.schemaVersion);
  if (![1, 2].includes(schemaVersion)) throw new WorkbenchWriteError("来件版本不受支持", 400, "YINGNING_INTAKE_SCHEMA_INVALID");
  if (schemaVersion === 1 && (input?.attachment || input?.attachments?.length || input?.payload?.attachment || input?.payload?.attachments)) {
    throw new WorkbenchWriteError("首版来件不接收附件", 415, "YINGNING_INTAKE_ATTACHMENT_UNSUPPORTED");
  }
  const intakeId = String(input?.intakeId || "").trim().toLowerCase();
  const source = String(input?.source || "").trim().toLowerCase();
  const sourceSemantic = String(input?.sourceSemantic || (schemaVersion === 1 ? "shared_content" : "")).trim().toLowerCase();
  const deviceId = String(input?.deviceId || "").trim().toLowerCase();
  const createdAt = String(input?.createdAt || "").trim();
  const projectId = optionalIdField(input?.projectId, PROJECT_ID, "项目标识不合法", "YINGNING_INTAKE_PROJECT_INVALID", { lowercase: true });
  const checkpointId = optionalIdField(input?.checkpointId, CHECKPOINT_ID, "检查点标识不合法", "YINGNING_INTAKE_CHECKPOINT_INVALID", { lowercase: true });
  if ((checkpointId || input?.checkpoint || input?.projectName) && !projectId) {
    throw new WorkbenchWriteError("检查点或项目名必须带项目标识", 400, "YINGNING_INTAKE_PROJECT_REQUIRED");
  }
  const projectName = projectId ? textField(input?.projectName, 120, "项目名称") : "";
  const checkpoint = projectId ? normalizeCheckpointMeta(input?.checkpoint, checkpointId) : null;
  if (!INTAKE_ID.test(intakeId)) throw new WorkbenchWriteError("来件 ID 不合法", 400, "YINGNING_INTAKE_ID_INVALID");
  if (!ALLOWED_SOURCES.has(source)) throw new WorkbenchWriteError("来件来源不在白名单", 400, "YINGNING_INTAKE_SOURCE_INVALID");
  if (!SOURCE_SEMANTICS.has(sourceSemantic)) throw new WorkbenchWriteError("来件语义不合法", 400, "YINGNING_INTAKE_SEMANTIC_INVALID");
  if (!DEVICE_ID.test(deviceId)) throw new WorkbenchWriteError("来件设备标识不合法", 400, "YINGNING_INTAKE_DEVICE_INVALID");
  const created = new Date(createdAt);
  if (!createdAt || Number.isNaN(created.getTime())) throw new WorkbenchWriteError("来件时间不合法", 400, "YINGNING_INTAKE_TIME_INVALID");
  const attachmentPayloads = (input?.attachments || []).map(normalizeAttachment);
  if (attachmentPayloads.length > MAX_ATTACHMENTS) throw new WorkbenchWriteError("一次最多接收 4 个附件", 413, "YINGNING_ATTACHMENTS_TOO_MANY");
  if (attachmentPayloads.reduce((sum, row) => sum + row.data.length, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new WorkbenchWriteError("一次附件总大小不能超过 32 MB", 413, "YINGNING_ATTACHMENTS_TOO_LARGE");
  }
  const normalized = {
    schemaVersion, intakeId, url: normalizeUrl(input?.url), title: textField(input?.title, 300, "来件标题"),
    text: textField(input?.text, 8_000, "分享文字"), note: textField(input?.note, 2_000, "来件备注"),
    source, sourceSemantic, sourceApp: textField(input?.sourceApp, 120, "来源 App"), deviceId,
    deviceName: textField(input?.deviceName, 120, "设备名称"), createdAt: created.toISOString(),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    attachments: attachmentPayloads.map((row) => row.metadata),
  };
  if (!normalized.url && !normalized.text && normalized.attachments.length === 0) {
    throw new WorkbenchWriteError("来件至少需要网址、分享文字、照片或文件", 400, "YINGNING_INTAKE_CONTENT_REQUIRED");
  }
  return { ...normalized, fingerprint: fingerprintFor(normalized), attachmentPayloads };
}

function publicItem(item) {
  const { fingerprint: _fingerprint, ...safe } = item;
  return safe;
}

function latestStamp(item) {
  return item.receivedAt || item.createdAt || "";
}

function summarizeProjects(projectItems) {
  const byId = new Map();
  for (const item of projectItems) {
    const entry = byId.get(item.projectId) || {
      projectId: item.projectId, projectName: "", itemCount: 0, attachmentCount: 0,
      checkpointIds: new Set(), latestAt: "",
    };
    entry.itemCount += 1;
    entry.attachmentCount += item.attachments?.length || 0;
    if (item.checkpointId) entry.checkpointIds.add(item.checkpointId);
    if (item.projectName) entry.projectName = item.projectName;
    const stamp = latestStamp(item);
    if (stamp > entry.latestAt) entry.latestAt = stamp;
    byId.set(item.projectId, entry);
  }
  return [...byId.values()]
    .map(({ checkpointIds, ...rest }) => ({ ...rest, checkpointCount: checkpointIds.size }))
    .sort((a, b) => (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0));
}

function summarizeCheckpoints(scopedItems) {
  const byId = new Map();
  for (const item of scopedItems) {
    const key = item.checkpointId || "";
    const entry = byId.get(key) || {
      checkpointId: key, name: "", source: "", build: "", manifestSha: "",
      itemCount: 0, attachmentCount: 0, latestAt: "",
    };
    entry.itemCount += 1;
    entry.attachmentCount += item.attachments?.length || 0;
    if (item.checkpoint?.name) entry.name = item.checkpoint.name;
    if (item.checkpoint?.source) entry.source = item.checkpoint.source;
    if (item.checkpoint?.build) entry.build = item.checkpoint.build;
    if (item.checkpoint?.manifestSha) entry.manifestSha = item.checkpoint.manifestSha;
    const stamp = latestStamp(item);
    if (stamp > entry.latestAt) entry.latestAt = stamp;
    byId.set(key, entry);
  }
  return [...byId.values()].sort((a, b) => (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0));
}

function matchesIntake(item, id) {
  return item.intakeId === id || item.aliasIntakeIds?.includes(id);
}

function receiptFor(requestedId, item, duplicate = false, duplicateReason = null) {
  return { ok: true, duplicate, ...(duplicateReason ? { duplicateReason } : {}), intakeId: requestedId,
    canonicalItemId: item.intakeId, status: "delivered", deliveredAt: item.receivedAt, deliveryBoundary: "mac_persisted" };
}

export function createYingningInboxService(root, options = {}) {
  const inboxDir = path.resolve(options.inboxDir || path.join(root, SECRETARY_INTAKE_DIR));
  const inboxFile = path.join(inboxDir, "inbox.json");
  const attachmentsDir = path.join(inboxDir, "attachments");
  let serial = Promise.resolve();

  async function ensureInboxDir() {
    await fs.mkdir(inboxDir, { recursive: true, mode: 0o700 });
    await fs.chmod(inboxDir, 0o700).catch(() => {});
  }
  async function readState() {
    try {
      const parsed = JSON.parse(await fs.readFile(inboxFile, "utf8"));
      if (![1, 2].includes(Number(parsed?.schemaVersion)) || !Array.isArray(parsed?.items)) throw new Error("schema");
      return { ...parsed, trash: Array.isArray(parsed.trash) ? parsed.trash : [] };
    } catch (error) {
      if (error?.code === "ENOENT") return { schemaVersion: 2, updatedAt: null, items: [], trash: [] };
      throw new WorkbenchWriteError("收件箱状态损坏", 500, "YINGNING_INTAKE_STATE_INVALID");
    }
  }
  async function writeState(state) {
    await ensureInboxDir();
    const temporary = path.join(inboxDir, `.inbox.${process.pid}.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify({ ...state, schemaVersion: 2 })}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporary, 0o600).catch(() => {});
    await fs.rename(temporary, inboxFile);
    await fs.chmod(inboxFile, 0o600).catch(() => {});
  }
  async function persistAttachments(incoming) {
    if (!incoming.attachmentPayloads.length) return;
    await fs.mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
    const destination = path.join(attachmentsDir, incoming.intakeId);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      for (const row of incoming.attachmentPayloads) {
        const file = path.join(temporary, `${row.metadata.attachmentId}.${attachmentExtension(row.metadata.contentType)}`);
        await fs.writeFile(file, row.data, { mode: 0o600, flag: "wx" });
        await fs.chmod(file, 0o600).catch(() => {});
      }
      await fs.rename(temporary, destination);
      await fs.chmod(destination, 0o700).catch(() => {});
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  async function acceptUnlocked(input, now = new Date()) {
    const incoming = normalizeYingningIntake(input);
    const state = await readState();
    const exact = [...state.items, ...state.trash].find((item) => matchesIntake(item, incoming.intakeId));
    if (exact && exact.fingerprint !== incoming.fingerprint) {
      throw new WorkbenchWriteError("相同来件 ID 的内容已经不同", 409, "YINGNING_INTAKE_ID_CONFLICT");
    }
    const cutoff = now.getTime() - CONTENT_DEDUPE_WINDOW_MS;
    const sameContent = state.items.find((item) => item.fingerprint === incoming.fingerprint
      && Math.max(Date.parse(item.receivedAt) || 0, Date.parse(item.lastDuplicateAt) || 0) >= cutoff);
    const duplicate = exact || sameContent;
    if (duplicate) {
      if (!exact) duplicate.aliasIntakeIds = [...(duplicate.aliasIntakeIds || []), incoming.intakeId];
      duplicate.duplicateCount = Math.max(0, Number(duplicate.duplicateCount) || 0) + 1;
      duplicate.lastDuplicateAt = now.toISOString();
      state.updatedAt = now.toISOString();
      await writeState(state);
      return receiptFor(incoming.intakeId, duplicate, true, exact ? "same_id" : "same_content");
    }
    await persistAttachments(incoming);
    const { attachmentPayloads: _payloads, ...storedIncoming } = incoming;
    const item = { ...storedIncoming, receivedAt: now.toISOString(), status: "delivered", deliveryBoundary: "mac_persisted", duplicateCount: 0 };
    state.items.push(item);
    state.updatedAt = now.toISOString();
    await writeState(state);
    return receiptFor(incoming.intakeId, item);
  }

  async function removeUnlocked(intakeId) {
    const id = String(intakeId || "").trim().toLowerCase();
    if (!INTAKE_ID.test(id)) throw new WorkbenchWriteError("来件 ID 不合法", 400, "YINGNING_INTAKE_ID_INVALID");
    const state = await readState();
    const index = state.items.findIndex((item) => matchesIntake(item, id));
    if (index < 0) throw new WorkbenchWriteError("来件不存在", 404, "YINGNING_INTAKE_NOT_FOUND");
    const [removed] = state.items.splice(index, 1);
    const { trashedAt: _trashedAt, ...rest } = removed;
    state.trash = [{ ...rest, trashedAt: new Date().toISOString() }, ...state.trash];
    state.updatedAt = new Date().toISOString();
    await writeState(state);
    return { ok: true, trashed: true, intakeId: removed.intakeId };
  }

  async function restoreUnlocked(intakeId) {
    const id = String(intakeId || "").trim().toLowerCase();
    if (!INTAKE_ID.test(id)) throw new WorkbenchWriteError("来件 ID 不合法", 400, "YINGNING_INTAKE_ID_INVALID");
    const state = await readState();
    const index = state.trash.findIndex((item) => matchesIntake(item, id));
    if (index < 0) throw new WorkbenchWriteError("回收站里没有这条来件", 404, "YINGNING_TRASH_NOT_FOUND");
    const [restored] = state.trash.splice(index, 1);
    const { trashedAt: _trashedAt, ...item } = restored;
    state.items.push(item);
    state.updatedAt = new Date().toISOString();
    await writeState(state);
    return { ok: true, restored: true, intakeId: item.intakeId };
  }

  async function emptyTrashUnlocked() {
    const state = await readState();
    const trash = state.trash;
    state.trash = [];
    state.updatedAt = new Date().toISOString();
    await writeState(state);
    await Promise.all(trash.map((item) => fs.rm(path.join(attachmentsDir, item.intakeId), { recursive: true, force: true })));
    return { ok: true, emptied: true, deleted: trash.length };
  }

  function enqueue(task) {
    const operation = serial.then(task);
    serial = operation.catch(() => {});
    return operation;
  }

  async function locateAttachment(intakeId, attachmentId) {
    if (!INTAKE_ID.test(String(intakeId || "")) || !INTAKE_ID.test(String(attachmentId || ""))) {
      throw new WorkbenchWriteError("原图标识不合法", 400, "YINGNING_ATTACHMENT_ID_INVALID");
    }
    const state = await readState();
    const item = [...state.items, ...state.trash].find((row) => row.intakeId === intakeId);
    const attachment = item?.attachments?.find((row) => row.attachmentId === attachmentId);
    if (!attachment) throw new WorkbenchWriteError("附件不存在", 404, "YINGNING_ATTACHMENT_NOT_FOUND");
    const file = path.join(attachmentsDir, intakeId, `${attachmentId}.${attachmentExtension(attachment.contentType)}`);
    return { attachment, file };
  }

  return {
    inboxDir, inboxFile,
    accept(input, now) {
      return enqueue(() => acceptUnlocked(input, now));
    },
    remove(intakeId) {
      return enqueue(() => removeUnlocked(intakeId));
    },
    restore(intakeId) {
      return enqueue(() => restoreUnlocked(intakeId));
    },
    emptyTrash() {
      return enqueue(() => emptyTrashUnlocked());
    },
    async list(options = {}) {
      const opts = options && typeof options === "object" ? options : { limit: options };
      const safeLimit = Math.max(1, Math.min(200, Number(opts.limit) || 100));
      const safeOffset = Math.max(0, Math.min(1_000_000, Math.trunc(Number(opts.offset) || 0)));
      const boundary = "这里只显示已由 Mac 原子持久化的来件；待送达和失败待重试仍留在发送设备的可靠队列。";
      const paginate = (ordered) => {
        const total = ordered.length;
        const page = ordered.slice(safeOffset, safeOffset + safeLimit);
        const nextOffset = safeOffset + page.length < total ? safeOffset + page.length : null;
        return { total, page, nextOffset };
      };
      const state = await readState();
      const dailyItems = state.items.filter((item) => !item.projectId);
      const projectItems = state.items.filter((item) => item.projectId);

      const requestedProject = optionalIdField(opts.projectId, PROJECT_ID, "项目标识不合法", "YINGNING_INTAKE_PROJECT_INVALID", { lowercase: true });
      if (requestedProject) {
        const requestedCheckpoint = optionalIdField(opts.checkpointId, CHECKPOINT_ID, "检查点标识不合法", "YINGNING_INTAKE_CHECKPOINT_INVALID", { lowercase: true });
        const scoped = projectItems.filter((item) => item.projectId === requestedProject);
        const checkpoints = summarizeCheckpoints(scoped);
        const filtered = requestedCheckpoint ? scoped.filter((item) => (item.checkpointId || "") === requestedCheckpoint) : scoped;
        const named = [...scoped].reverse().find((item) => item.projectName)?.projectName || "";
        const { total, page, nextOffset } = paginate([...filtered].reverse());
        return {
          schemaVersion: 2, generatedAt: new Date().toISOString(), scope: "project",
          projectId: requestedProject, projectName: named,
          checkpointId: requestedCheckpoint || null,
          checkpoints,
          total, offset: safeOffset, limit: safeLimit, nextOffset,
          items: page.map(publicItem),
          deliveryBoundary: boundary,
        };
      }

      const daily = paginate([...dailyItems].reverse());
      return {
        schemaVersion: 2, generatedAt: new Date().toISOString(), scope: "daily",
        total: daily.total, delivered: daily.total, offset: safeOffset, limit: safeLimit, nextOffset: daily.nextOffset,
        items: daily.page.map(publicItem),
        trash: state.trash.slice(safeOffset, safeOffset + safeLimit).map(publicItem),
        trashCount: state.trash.length,
        projects: summarizeProjects(projectItems),
        projectItemCount: projectItems.length,
        deliveryBoundary: boundary,
      };
    },
    async readAttachment(intakeId, attachmentId) {
      const located = await locateAttachment(intakeId, attachmentId);
      return { data: await fs.readFile(located.file), contentType: located.attachment.contentType, fileName: located.attachment.fileName };
    },
    async readShareCopy(intakeId, attachmentId) {
      const located = await locateAttachment(intakeId, attachmentId);
      if (!isImageAttachmentType(located.attachment.contentType)) {
        throw new WorkbenchWriteError("文件不能做成发送照片", 415, "YINGNING_SHARE_COPY_UNAVAILABLE");
      }
      const stem = path.parse(located.attachment.fileName).name || "photo";
      const temporary = path.join(os.tmpdir(), `inbox-share-${process.pid}-${crypto.randomUUID()}.jpg`);
      try {
        await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", String(SHARE_COPY_PIXELS), located.file, "--out", temporary], {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        await fs.chmod(temporary, 0o600).catch(() => {});
        return { data: await fs.readFile(temporary), contentType: "image/jpeg", fileName: `${stem}.jpg` };
      } catch (error) {
        if (error instanceof WorkbenchWriteError) throw error;
        throw new WorkbenchWriteError("暂时做不出能发送的照片", 415, "YINGNING_SHARE_COPY_UNAVAILABLE");
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    },
    async copyToPasteboard(intakeId, attachmentId) {
      const located = await locateAttachment(intakeId, attachmentId);
      const staged = await stageClipboardCopy(located.file, clipboardFileName(located.attachment));
      const copy = options.copyFileToPasteboard || defaultCopyFileToPasteboard;
      const alsoText = isPlainTextContentType(located.attachment.contentType)
        && Number(located.attachment.byteCount || 0) <= MAX_TEXT_PASTEBOARD_BYTES;
      await copy(staged, { alsoText });
      return { ok: true, mode: alsoText ? "mac-file-and-text" : "mac-file", fileName: path.basename(staged) };
    },
  };
}
