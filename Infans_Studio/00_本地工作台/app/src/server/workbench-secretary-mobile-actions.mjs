import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { SECRETARY_RUNTIME_DIR } from "./vault-paths.mjs";
import { aiWriteNeedsConfirmation } from "../write-confirmation-policy.mjs";

const SCHEMA_VERSION = 1;
const ACTION_DIRECTORY = path.posix.join(SECRETARY_RUNTIME_DIR, "mobile-actions");
const TERMINAL_STATES = new Set(["completed", "cancelled", "failed"]);
const STALE_CODES = new Set([
  "PREVIEW_EXPIRED",
  "WRITE_CONFLICT",
  "RELATIONSHIP_MEMORY_PREVIEW_MISSING",
  "RELATIONSHIP_MEMORY_PREVIEW_EXPIRED",
  "RELATIONSHIP_MEMORY_CHANGED",
]);

function cleanText(value, limit = 8_000) {
  return String(value ?? "").replace(/\0/g, "").slice(0, limit);
}

function safeTargetPath(value) {
  const target = cleanText(value, 1_000).trim();
  if (!target || path.isAbsolute(target) || /^~[\\/]|^[A-Za-z]:[\\/]/u.test(target) || target.split(/[\\/]+/u).includes("..")) return null;
  return target;
}

function safeTargetLabel(preview) {
  const candidate = cleanText(preview?.targetLabel || preview?.target || "", 300).trim();
  if (candidate && !path.isAbsolute(candidate) && !/^~[\\/]|^[A-Za-z]:[\\/]/u.test(candidate)) return candidate;
  return safeTargetPath(preview?.targetPath) || "受控写入目标";
}

function stableActionId(conversationId, generationId, order) {
  const digest = crypto.createHash("sha256").update(`${conversationId}\0${generationId}\0${order}`).digest("hex").slice(0, 32);
  return `action_${digest}`;
}

function publicPreview(preview = {}, requiresConfirm = true) {
  return {
    kind: cleanText(preview.kind || "write", 120),
    targetLabel: safeTargetLabel(preview),
    targetPath: safeTargetPath(preview.targetPath),
    summary: cleanText(preview.summary, 2_000),
    before: cleanText(preview.before, 8_000),
    after: cleanText(preview.after, 8_000),
    expiresAt: cleanText(preview.expiresAt, 100) || null,
    requiresConfirm: Boolean(requiresConfirm),
  };
}

function publicRecord(record) {
  return {
    actionId: record.actionId,
    conversationId: record.conversationId,
    generationId: record.generationId,
    assistantMessageId: record.assistantMessageId,
    order: record.order,
    label: record.label,
    publicPreview: record.publicPreview,
    state: record.state,
    ...(record.result ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
}

function staleError(error) {
  if (STALE_CODES.has(String(error?.code || ""))) return true;
  return /预览.*(?:过期|失效)|原件.*变化|源文件.*修改|日历预览已过期/u.test(String(error?.message || ""));
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createSecretaryMobileActionService(vaultRoot, options = {}) {
  const directory = options.directory || path.join(path.resolve(vaultRoot), ACTION_DIRECTORY);
  const previewAction = options.previewAction;
  const commitPreview = options.commitPreview;
  const runtimeId = options.runtimeId || crypto.randomUUID();
  const now = options.now || (() => new Date());
  const decisions = new Map();

  if (typeof previewAction !== "function" || typeof commitPreview !== "function") {
    throw new TypeError("mobile action service requires previewAction and commitPreview");
  }

  const fileFor = (actionId) => path.join(directory, `${actionId}.json`);

  async function read(actionId) {
    try {
      return JSON.parse(await fs.readFile(fileFor(actionId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function save(record) {
    record.updatedAt = new Date(now()).toISOString();
    await atomicJson(fileFor(record.actionId), record);
    return record;
  }

  async function allRecords() {
    let names;
    try { names = await fs.readdir(directory); } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => /^action_[a-f0-9]{32}\.json$/u.test(name)).map(async (name) => {
      try { return JSON.parse(await fs.readFile(path.join(directory, name), "utf8")); } catch { return null; }
    }));
    return records.filter(Boolean);
  }

  async function list(conversationId, generationId = null) {
    const items = (await allRecords())
      .filter((item) => item.conversationId === conversationId && (!generationId || item.generationId === generationId))
      .sort((left, right) => left.generationId.localeCompare(right.generationId) || left.order - right.order);
    return { actions: items.map(publicRecord) };
  }

  async function prepare(record, confirmationOverride = null) {
    const prepared = await previewAction(record.rawAction);
    const requiresConfirm = confirmationOverride === null
      ? aiWriteNeedsConfirmation(record.rawAction, prepared.preview)
      : Boolean(confirmationOverride);
    record.authority = cleanText(prepared.authority, 40);
    record.previewToken = prepared.preview?.token;
    record.previewRuntimeId = runtimeId;
    record.publicPreview = publicPreview(prepared.preview, requiresConfirm);
    record.state = requiresConfirm ? "pending" : "committing";
    await save(record);
    return prepared;
  }

  async function register({ conversationId, generationId, assistantMessageId, actions }) {
    if (!Array.isArray(actions) || !actions.length) return { actions: [] };
    const output = [];
    for (let order = 0; order < actions.length; order += 1) {
      const rawAction = actions[order];
      const actionId = stableActionId(conversationId, generationId, order);
      let record = await read(actionId);
      if (record) { output.push(publicRecord(record)); continue; }
      record = {
        schemaVersion: SCHEMA_VERSION,
        actionId,
        conversationId,
        generationId,
        assistantMessageId,
        order,
        label: cleanText(rawAction?.label || rawAction?.summary || "受控写入", 300),
        rawAction,
        state: "preparing",
        createdAt: new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString(),
      };
      await save(record);
      try {
        await prepare(record);
        if (!record.publicPreview.requiresConfirm) {
          const result = await commitPreview(record.authority, record.previewToken);
          record.state = "completed";
          record.result = { ok: true, targetLabel: record.publicPreview.targetLabel };
          record.previewToken = null;
          await save(record);
        }
      } catch (error) {
        record.state = "failed";
        record.error = { code: cleanText(error?.code || "MOBILE_ACTION_FAILED", 120), message: cleanText(error?.message || "受控写入没有完成", 500) };
        record.previewToken = null;
        await save(record);
      }
      output.push(publicRecord(record));
    }
    return { actions: output };
  }

  async function refreshStale(record) {
    try {
      await prepare(record, true);
      record.state = "pending";
      record.error = null;
      await save(record);
      return { stale: true, action: publicRecord(record) };
    } catch (error) {
      record.state = "failed";
      record.error = { code: cleanText(error?.code || "MOBILE_ACTION_REFRESH_FAILED", 120), message: cleanText(error?.message || "无法重新生成预览", 500) };
      record.previewToken = null;
      await save(record);
      return { stale: false, action: publicRecord(record) };
    }
  }

  async function decide(actionId, binding) {
    const running = decisions.get(actionId);
    if (running) return running;
    const operation = (async () => {
      const record = await read(actionId);
      if (!record) throw new WorkbenchWriteError("找不到这项受控写入", 404, "NATIVE_CHAT_ACTION_NOT_FOUND");
      if (record.conversationId !== binding.conversationId || record.generationId !== binding.generationId) {
        throw new WorkbenchWriteError("受控写入与会话或回复不匹配", 409, "NATIVE_CHAT_ACTION_BINDING_MISMATCH");
      }
      if (TERMINAL_STATES.has(record.state)) return { duplicate: true, stale: false, action: publicRecord(record) };
      const earlier = (await allRecords()).find((item) => item.conversationId === record.conversationId
        && item.generationId === record.generationId && item.order < record.order && !TERMINAL_STATES.has(item.state));
      if (earlier) throw new WorkbenchWriteError("请先处理前一项受控写入", 409, "NATIVE_CHAT_ACTION_ORDER_REQUIRED");
      if (binding.decision === "cancel") {
        record.state = "cancelled";
        record.previewToken = null;
        record.result = { ok: true, cancelled: true };
        await save(record);
        return { duplicate: false, stale: false, action: publicRecord(record) };
      }
      if (record.previewRuntimeId !== runtimeId || !record.previewToken) return refreshStale(record);
      record.state = "committing";
      await save(record);
      try {
        await commitPreview(record.authority, record.previewToken);
        record.state = "completed";
        record.previewToken = null;
        record.result = { ok: true, targetLabel: record.publicPreview.targetLabel };
        await save(record);
        return { duplicate: false, stale: false, action: publicRecord(record) };
      } catch (error) {
        if (staleError(error)) return refreshStale(record);
        record.state = "failed";
        record.previewToken = null;
        record.error = { code: cleanText(error?.code || "MOBILE_ACTION_COMMIT_FAILED", 120), message: cleanText(error?.message || "受控写入没有完成", 500) };
        await save(record);
        return { duplicate: false, stale: false, action: publicRecord(record) };
      }
    })();
    decisions.set(actionId, operation);
    try { return await operation; } finally { decisions.delete(actionId); }
  }

  return { register, list, decide };
}
