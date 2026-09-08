import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  computeEligibilityRevision,
  parseAgentTaskContract,
  validateVaultEvidencePath,
} from "../src/server/workbench-agent-task-contract.mjs";
import { findTaskLine } from "../src/server/workbench-project-management.mjs";
import {
  createRuntimeLedgerFileApi,
  eligibilityKeyHash,
  normalizeEligibilityKey,
  stableEffectId,
} from "./agent-task-runtime-ledger.mjs";

const HASH_RE = /^[a-f0-9]{64}$/u;
const MAX_VERIFIED_EVIDENCE = 24;
const RECEIPT_RE = /^\s*-\s+自动回执\s*[：:]\s*`(\{.*\})`\s*$/u;
const CONTRACT_RE = /^(\s*-\s*自动推进\s*[：:]\s*)(\{.*\})(\s*)$/u;
const SELF_SCHEDULE_EFFECT = "task.selfScheduleReview";
const TASK_WRITEBACK_EFFECT = "task.writeback";
const RECEIPT_OUTCOMES = new Set(["completed", "blocked", "failed", "progress"]);
const SOURCE_LOCK_TIMEOUT_MS = 5_000;
const SOURCE_LOCK_RETRY_MS = 10;
const SOURCE_LOCK_STALE_MS = 30_000;

export class AgentTaskLedgerAdapterError extends Error {
  constructor(message, code = "AGENT_TASK_LEDGER_ADAPTER_INVALID", details = {}) {
    super(message);
    this.name = "AgentTaskLedgerAdapterError";
    this.code = code;
    this.details = details;
  }
}

function fail(condition, message, code, details) {
  if (!condition) throw new AgentTaskLedgerAdapterError(message, code, details);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSet(left = [], right = []) {
  return sameValue([...new Set(left)].sort(), [...new Set(right)].sort());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function removeStaleSourceLock(lockPath) {
  let text;
  let stat;
  try {
    [text, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  if (Date.now() - stat.mtimeMs <= SOURCE_LOCK_STALE_MS) return false;
  let lock = null;
  try { lock = JSON.parse(text); } catch { lock = null; }
  if (lock && await processIsAlive(lock.pid)) return false;
  const stalePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, stalePath);
    await fs.rm(stalePath, { force: true });
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function withSourceFileLock(absolute, callback) {
  const lockPath = `${absolute}.agent-task-source.lock`;
  const token = crypto.randomUUID();
  const startedAt = Date.now();
  let handle = null;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = null;
      if (error?.code !== "EEXIST") throw error;
      if (await removeStaleSourceLock(lockPath)) continue;
      if (Date.now() - startedAt >= SOURCE_LOCK_TIMEOUT_MS) {
        fail(false, "等待任务原件单写者锁超时", "SOURCE_LOCK_TIMEOUT");
      }
      await sleep(SOURCE_LOCK_RETRY_MS);
    }
  }
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => undefined);
    try {
      const current = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (current.token === token) await fs.rm(lockPath, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function normalizedReasonCode(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-")
    .replace(/[^a-z0-9.:@/+~-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 128);
  return normalized || fallback;
}

function normalizedSourcePath(value) {
  fail(typeof value === "string" && value.trim() === value && value.length > 0,
    "sourcePath 不能为空", "SOURCE_PATH_INVALID");
  fail(!path.posix.isAbsolute(value) && !value.includes("\\") && !value.includes("\0"),
    "sourcePath 必须是 Vault 内相对路径", "SOURCE_PATH_INVALID");
  const normalized = path.posix.normalize(value);
  fail(normalized === value && normalized !== "." && !normalized.startsWith("../"),
    "sourcePath 不能越过 Vault", "SOURCE_PATH_INVALID");
  fail(value.endsWith(".md"), "自动任务只能写回 Markdown 原件", "SOURCE_PATH_INVALID");
  fail(!value.split("/").some((segment) => new Set([".git", "node_modules", "案头", "本人草稿"]).has(segment)),
    "sourcePath 命中禁止目录", "SOURCE_PATH_FORBIDDEN");
  return normalized;
}

function normalizeVerifiedEvidence(value, sourcePath) {
  fail(Array.isArray(value) && value.length <= MAX_VERIFIED_EVIDENCE,
    "verifiedEvidence 必须是有上限的数组（允许为空）", "RUN_CONTEXT_INVALID");
  const seen = new Set();
  const normalized = value.map((item, index) => {
    fail(item && typeof item === "object" && !Array.isArray(item)
      && sameValue(Object.keys(item).sort(), ["path", "sha256"]),
    `verifiedEvidence[${index}] 只能包含 path 与 sha256`, "RUN_CONTEXT_INVALID");
    const checkedPath = validateVaultEvidencePath(item.path);
    fail(checkedPath.valid && checkedPath.path !== sourcePath,
      `verifiedEvidence[${index}].path 不安全或指向任务原件自身`, "EVIDENCE_PATH_INVALID", {
      evidenceCode: checkedPath.code,
    });
    fail(!seen.has(checkedPath.path), `verifiedEvidence[${index}].path 重复`, "RUN_CONTEXT_INVALID");
    seen.add(checkedPath.path);
    const digest = typeof item.sha256 === "string" ? item.sha256.toLowerCase() : "";
    fail(HASH_RE.test(digest), `verifiedEvidence[${index}].sha256 必须是 64 位 SHA-256`, "RUN_CONTEXT_INVALID");
    return Object.freeze({ path: checkedPath.path, sha256: digest });
  });
  return Object.freeze(normalized);
}

function normalizePlatformExecution(value) {
  if (value == null) return null;
  fail(value && typeof value === "object" && !Array.isArray(value),
    "platformExecution 必须是执行身份", "PLATFORM_EXECUTION_INVALID");
  const platformId = String(value.platformId || "").trim();
  const executionId = String(value.executionId || "").trim();
  fail(platformId && executionId && !/[\r\n\0]/u.test(`${platformId}${executionId}`),
    "platformExecution 缺少稳定身份", "PLATFORM_EXECUTION_INVALID");
  return Object.freeze({ platformId, executionId });
}

function executionIdentityFromEvidence(evidence) {
  fail(evidence && typeof evidence === "object", "当前尝试没有可回读的启动回执", "RUN_NOT_STARTED");
  if (evidence.kind === "platform-execution") {
    return { platformId: evidence.platformId, executionId: evidence.executionId };
  }
  if (evidence.kind === "protocol-handshake") {
    return { platformId: evidence.source, executionId: `${evidence.protocol}:${evidence.receiptId}` };
  }
  if (evidence.kind === "structured-event") {
    return { platformId: evidence.source, executionId: `${evidence.eventType}:${evidence.eventId}` };
  }
  throw new AgentTaskLedgerAdapterError("启动回执不能形成执行身份", "RUN_NOT_STARTED");
}

function normalizeCoordinatorContext(input, triggerIdInput) {
  fail(input && typeof input === "object" && !Array.isArray(input),
    "缺少协调器运行上下文", "RUN_CONTEXT_MISSING");
  const nestedKey = input.eligibilityKey && typeof input.eligibilityKey === "object" ? input.eligibilityKey : {};
  const taskId = String(input.taskId || input.primaryTaskId || nestedKey.taskId || "").trim();
  const executorId = String(input.executorId || input.executorRoleId || nestedKey.executorRoleId || "").trim();
  const sourcePath = normalizedSourcePath(String(input.sourcePath || ""));
  const triggerId = String(triggerIdInput || input.triggerId || nestedKey.triggerId || "").trim();
  const triggerCursor = String(input.triggerCursor || nestedKey.triggerCursor || "").trim();
  const eligibilityRevision = String(input.eligibilityRevision || nestedKey.eligibilityRevision || "").trim();
  const eligibilityKey = normalizeEligibilityKey({
    taskId,
    executorRoleId: executorId,
    eligibilityRevision,
    triggerId,
    triggerCursor,
  });
  const context = {
    runId: String(input.runId || "").trim(),
    attemptNo: Number(input.attemptNo),
    taskId,
    sourcePath,
    executorId,
    eligibilityRevision,
    effectId: String(input.effectId || "").trim(),
    taskFingerprint: String(input.taskFingerprint || "").trim(),
    expectedSourceHash: String(input.expectedSourceHash || "").trim(),
    authorizedEffects: Array.isArray(input.authorizedEffects) ? [...new Set(input.authorizedEffects.map(String))] : [],
    verifiedEvidence: normalizeVerifiedEvidence(input.verifiedEvidence, sourcePath),
    triggerId,
    triggerCursor,
    eligibilityKey,
    eligibilityKeyHash: eligibilityKeyHash(eligibilityKey),
  };
  fail(context.runId.length > 0, "runId 不能为空", "RUN_CONTEXT_INVALID");
  fail(Number.isSafeInteger(context.attemptNo) && context.attemptNo > 0,
    "attemptNo 必须是正整数", "RUN_CONTEXT_INVALID");
  fail(HASH_RE.test(context.taskFingerprint) && HASH_RE.test(context.expectedSourceHash),
    "任务快照与来源哈希格式不正确", "RUN_CONTEXT_INVALID");
  const target = `${sourcePath}#${taskId}`;
  fail(context.effectId === stableEffectId(TASK_WRITEBACK_EFFECT, target),
    "主写回 effectId 与任务原件不一致", "EFFECT_ID_MISMATCH");
  fail(context.authorizedEffects.length > 0 && context.authorizedEffects.every((item) => item.trim() === item && item.length > 0),
    "authorizedEffects 必须是非空稳定授权", "RUN_CONTEXT_INVALID");
  return Object.freeze(context);
}

function publicCoordinatorContext(context) {
  return Object.freeze({
    runId: context.runId,
    attemptNo: context.attemptNo,
    taskId: context.taskId,
    sourcePath: context.sourcePath,
    executorId: context.executorId,
    eligibilityRevision: context.eligibilityRevision,
    effectId: context.effectId,
    taskFingerprint: context.taskFingerprint,
    expectedSourceHash: context.expectedSourceHash,
    authorizedEffects: Object.freeze([...context.authorizedEffects]),
    verifiedEvidence: Object.freeze(context.verifiedEvidence.map((item) => Object.freeze({ ...item }))),
  });
}

function runtimeContext(context, owner) {
  return {
    runId: context.runId,
    attemptNo: context.attemptNo,
    owner,
    primaryTaskId: context.taskId,
    executorRoleId: context.executorId,
    eligibilityKeyHash: context.eligibilityKeyHash,
  };
}

function assertRequestedContext(requested, context) {
  fail(requested && typeof requested === "object", "缺少写回运行上下文", "RUN_CONTEXT_MISSING");
  const expected = publicCoordinatorContext(context);
  for (const key of [
    "runId", "attemptNo", "taskId", "sourcePath", "executorId", "eligibilityRevision",
    "effectId", "taskFingerprint", "expectedSourceHash",
  ]) {
    fail(requested[key] === expected[key], `写回上下文的 ${key} 与当前认领不一致`, "RUN_CONTEXT_MISMATCH", { key });
  }
  fail(sameSet(requested.authorizedEffects, expected.authorizedEffects),
    "写回授权与当前认领不一致", "RUN_CONTEXT_MISMATCH");
  const requestedEvidence = normalizeVerifiedEvidence(requested.verifiedEvidence, context.sourcePath);
  fail(sameValue(requestedEvidence, context.verifiedEvidence),
    "写回上下文的已核验证据快照与协调器不一致", "RUN_CONTEXT_MISMATCH");
}

function taskBlockBounds(lines, taskIndex) {
  const baseIndent = lines[taskIndex].match(/^[ \t]*/u)?.[0] || "";
  let end = lines.length;
  for (let index = taskIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    if (/^\s*-\s+\[/u.test(lines[index]) || /^#{1,6}\s+/u.test(lines[index])) {
      end = index;
      break;
    }
    const indent = lines[index].match(/^[ \t]*/u)?.[0] || "";
    if (indent.length <= baseIndent.length) {
      end = index;
      break;
    }
  }
  return { start: taskIndex, end, baseIndent };
}

function detailLines(lines, bounds) {
  return lines.slice(bounds.start + 1, bounds.end)
    .filter((line) => /^\s+-\s+/u.test(line))
    .map((line) => line.replace(/^\s*-\s*/u, "").trim());
}

function splitLineRecords(content) {
  const records = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline < 0 ? content.length : newline + 1;
    const raw = content.slice(start, end);
    const eol = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    records.push({ text: eol ? raw.slice(0, -eol.length) : raw, eol });
    start = end;
  }
  if (!records.length) records.push({ text: "", eol: "" });
  return records;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function withTaskMetadata(text, key, value) {
  const matcher = new RegExp(`[｜|]\\s*${escapeRegExp(key)}\\s*[：:]\\s*[^｜|]+`, "gu");
  const cleaned = String(text).replace(matcher, "").trim();
  return `${cleaned}｜${key}：${value}`;
}

function tokyoMinute(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function normalizeProposalOutcome(value) {
  fail(value && typeof value === "object" && !Array.isArray(value),
    "写回效果缺少已校验的提议结果", "EFFECT_PAYLOAD_INVALID");
  fail(sameValue(Object.keys(value).sort(), ["evidenceRefs", "nextReviewAt", "nextStep", "status", "summary"]),
    "写回效果的提议结果形状不正确", "EFFECT_PAYLOAD_INVALID");
  fail(RECEIPT_OUTCOMES.has(value.status), "写回效果的提议状态不受支持", "EFFECT_PAYLOAD_INVALID");
  fail(typeof value.summary === "string" && value.summary.length > 0 && value.summary.length <= 1_200
    && !/[\r\n\0]/u.test(value.summary),
  "写回效果的提议摘要无效", "EFFECT_PAYLOAD_INVALID");
  fail(typeof value.nextStep === "string" && value.nextStep.length <= 1_200 && !/[\r\n\0]/u.test(value.nextStep),
    "写回效果的下一步无效", "EFFECT_PAYLOAD_INVALID");
  fail(Array.isArray(value.evidenceRefs) && value.evidenceRefs.length <= MAX_VERIFIED_EVIDENCE
    && value.evidenceRefs.every((item) => typeof item === "string" && item.length > 0 && item.length <= 500 && !/[\r\n\0]/u.test(item)),
  "写回效果的证据引用无效", "EFFECT_PAYLOAD_INVALID");
  let nextReviewAt = null;
  if (value.nextReviewAt !== null) {
    fail(typeof value.nextReviewAt === "string" && Number.isFinite(Date.parse(value.nextReviewAt)),
      "写回效果的复验时间无效", "EFFECT_PAYLOAD_INVALID");
    nextReviewAt = new Date(value.nextReviewAt).toISOString();
  }
  return Object.freeze({
    status: value.status,
    summary: value.summary,
    evidenceRefs: Object.freeze([...value.evidenceRefs]),
    nextStep: value.nextStep,
    nextReviewAt,
  });
}

function directFieldValue(block, field) {
  const prefix = `${block.bounds.baseIndent}  `;
  const matcher = new RegExp(`^${escapeRegExp(prefix)}-\\s+${escapeRegExp(field)}\\s*[\uff1a:]\\s*(.*)$`, "u");
  const matches = block.lines.slice(block.bounds.start + 1, block.bounds.end)
    .map((line) => line.match(matcher))
    .filter(Boolean);
  fail(matches.length === 1, `原件中的${field}不唯一`, "SOURCE_RECEIPT_STATE_MISMATCH");
  return matches[0][1];
}

function validateReceiptSourceState(receipt, receiptIndex, block, context, expectedOutcome) {
  fail(receipt.outcome === expectedOutcome.status,
    "原件自动回执 outcome 与本次提议状态不一致", "SOURCE_RECEIPT_STATE_MISMATCH");
  const receiptReviewAt = receipt.nextReviewAt === undefined ? null : new Date(receipt.nextReviewAt).toISOString();
  fail(receiptReviewAt === expectedOutcome.nextReviewAt,
    "原件自动回执的复验时间与本次提议不一致", "SOURCE_RECEIPT_STATE_MISMATCH");
  const completed = expectedOutcome.status === "completed";
  fail(Boolean(block.candidate.task.done) === completed,
    "原件任务勾选状态与本次提议不一致", "SOURCE_RECEIPT_STATE_MISMATCH");

  const statePrefix = {
    completed: "已完成",
    blocked: "阻塞",
    failed: "本轮失败",
    progress: "进行中",
  }[expectedOutcome.status];
  const expectedNextStep = expectedOutcome.nextStep || "无需后续动作；本任务完成门已满足。";
  fail(directFieldValue(block, "当前状态") === `${statePrefix}：${expectedOutcome.summary}`,
    "原件当前状态与本次提议不一致", "SOURCE_RECEIPT_STATE_MISMATCH");
  fail(directFieldValue(block, "下一步") === expectedNextStep,
    "原件下一步与本次提议不一致", "SOURCE_RECEIPT_STATE_MISMATCH");
  const minute = tokyoMinute(receipt.writtenAt);
  fail(directFieldValue(block, "进展时间") === minute,
    "原件进展时间与回执时间不一致", "SOURCE_RECEIPT_STATE_MISMATCH");

  const resultWord = { completed: "通过", blocked: "受阻", failed: "失败", progress: "进行中" }[expectedOutcome.status];
  let previousIndex = receiptIndex - 1;
  if (expectedOutcome.evidenceRefs.length) {
    const expectedEvidence = `${block.bounds.baseIndent}    - 证据：${expectedOutcome.evidenceRefs.join("；")}`;
    fail(block.lines[previousIndex] === expectedEvidence,
      "原件历史证据行与本次提议不一致", "SOURCE_RECEIPT_STATE_MISMATCH");
    previousIndex -= 1;
  }
  const expectedResult = `${block.bounds.baseIndent}  - ${minute.slice(0, 10)} 自动运行结果：${resultWord}｜${expectedOutcome.summary}`;
  fail(block.lines[previousIndex] === expectedResult,
    "原件历史结果行与本次提议不一致", "SOURCE_RECEIPT_STATE_MISMATCH");

  if (expectedOutcome.nextReviewAt) {
    const contract = inspectContract(block, context, context.triggerId);
    fail(block.candidate.task.reviewAt === expectedOutcome.nextReviewAt
      && contract.contract.triggers[0].at === expectedOutcome.nextReviewAt,
    "原件复验时间与时间触发器未同时成立", "SOURCE_RECEIPT_STATE_MISMATCH");
  }
}

async function resolveSource(vaultRoot, sourcePath, sourceFs = fs) {
  const root = await sourceFs.realpath(path.resolve(vaultRoot));
  const absolute = path.resolve(root, ...sourcePath.split("/"));
  fail(absolute.startsWith(`${root}${path.sep}`), "来源路径越过 Vault", "SOURCE_PATH_INVALID");
  let real;
  try {
    real = await sourceFs.realpath(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") throw new AgentTaskLedgerAdapterError("任务原件不存在", "SOURCE_MISSING");
    throw error;
  }
  fail(real === absolute && real.startsWith(`${root}${path.sep}`),
    "任务原件不能通过符号链接越界", "SOURCE_PATH_FORBIDDEN");
  return absolute;
}

async function readTaskBlock(vaultRoot, context, sourceFs = fs) {
  const absolute = await resolveSource(vaultRoot, context.sourcePath, sourceFs);
  const buffer = await sourceFs.readFile(absolute);
  const content = buffer.toString("utf8");
  const lines = content.split(/\r?\n/u);
  const { candidates } = findTaskLine(content, { sourcePath: context.sourcePath, id: context.taskId });
  fail(candidates.length === 1, candidates.length ? "任务 ID 在原件中不唯一" : "原件中找不到任务 ID",
    candidates.length ? "TASK_ID_DUPLICATE" : "TASK_NOT_FOUND");
  const candidate = candidates[0];
  const bounds = taskBlockBounds(lines, candidate.index);
  return {
    absolute,
    buffer,
    content,
    contentHash: sha256(buffer),
    lines,
    records: splitLineRecords(content),
    candidate,
    bounds,
    details: detailLines(lines, bounds),
  };
}

function validateAuthoritativeReceipt(receipt, receiptIndex, block, context, proposalDigest, expectedAttemptNo, expectedOutcome = null) {
  fail(receipt && typeof receipt === "object" && !Array.isArray(receipt),
    "原件自动回执不是对象", "SOURCE_RECEIPT_INVALID");
  const allowed = new Set([
    "schemaVersion", "runId", "attemptNo", "effectId", "outcome", "proposalDigest", "writtenAt", "nextReviewAt", "evidence",
  ]);
  fail(Object.keys(receipt).every((key) => allowed.has(key)),
    "原件自动回执含非白名单字段", "SOURCE_RECEIPT_INVALID");
  fail(receipt.schemaVersion === 1 && receipt.runId === context.runId && receipt.effectId === context.effectId,
    "原件自动回执与当前运行效果不一致", "SOURCE_RECEIPT_MISMATCH");
  fail(Number.isSafeInteger(receipt.attemptNo) && receipt.attemptNo > 0 && receipt.attemptNo <= context.attemptNo,
    "原件自动回执 attemptNo 无效", "SOURCE_RECEIPT_INVALID");
  if (expectedAttemptNo != null) {
    fail(receipt.attemptNo === expectedAttemptNo,
      "原件自动回执不属于已准备的尝试", "SOURCE_RECEIPT_ATTEMPT_MISMATCH");
  }
  fail(RECEIPT_OUTCOMES.has(receipt.outcome),
    "原件自动回执 outcome 无效", "SOURCE_RECEIPT_INVALID");
  fail(typeof receipt.proposalDigest === "string" && HASH_RE.test(receipt.proposalDigest),
    "原件自动回执缺少提议摘要", "SOURCE_RECEIPT_INVALID");
  if (proposalDigest) fail(receipt.proposalDigest === proposalDigest,
    "同一运行效果的提议内容发生冲突", "EFFECT_PAYLOAD_CONFLICT");
  fail(typeof receipt.writtenAt === "string" && Number.isFinite(Date.parse(receipt.writtenAt)),
    "原件自动回执 writtenAt 无效", "SOURCE_RECEIPT_INVALID");
  if (receipt.nextReviewAt !== undefined) {
    fail(typeof receipt.nextReviewAt === "string" && Number.isFinite(Date.parse(receipt.nextReviewAt)),
      "原件自动回执 nextReviewAt 无效", "SOURCE_RECEIPT_INVALID");
  }
  const evidence = receipt.evidence === undefined ? [] : receipt.evidence;
  fail(Array.isArray(evidence) && evidence.length <= MAX_VERIFIED_EVIDENCE,
    "原件自动回执 evidence 无效", "SOURCE_RECEIPT_INVALID");
  const normalizedEvidence = normalizeVerifiedEvidence(evidence, context.sourcePath);
  fail(sameValue(normalizedEvidence, context.verifiedEvidence),
    "原件自动回执的证据快照与协调器不一致", "SOURCE_RECEIPT_EVIDENCE_MISMATCH");
  fail(receipt.outcome !== "completed" || normalizedEvidence.length > 0,
    "completed 原件回执必须有证据", "SOURCE_RECEIPT_INVALID");
  fail(!(receipt.outcome === "completed" && receipt.nextReviewAt),
    "completed 原件回执不能同时自排复验", "SOURCE_RECEIPT_INVALID");
  fail(receipt.outcome !== "completed" || block.candidate.task.done,
    "completed 回执与任务状态不一致", "SOURCE_RECEIPT_STATE_MISMATCH");
  if (expectedOutcome) validateReceiptSourceState(receipt, receiptIndex, block, context, expectedOutcome);
  return receipt;
}

function authoritativeReceipt(block, context, proposalDigest, expectedAttemptNo = null, expectedOutcome = null) {
  const matches = [];
  for (let index = block.bounds.start + 1; index < block.bounds.end; index += 1) {
    const match = block.lines[index].match(RECEIPT_RE);
    if (!match) continue;
    let receipt;
    try { receipt = JSON.parse(match[1]); }
    catch {
      fail(false, "任务块中存在无法解析的自动回执", "SOURCE_RECEIPT_INVALID");
    }
    if (receipt?.runId === context.runId && receipt?.effectId === context.effectId) matches.push({ receipt, index });
    else if (receipt?.runId === context.runId) {
      fail(false, "同一运行的原件回执指向了其他效果", "SOURCE_RECEIPT_MISMATCH");
    }
  }
  fail(matches.length <= 1, "同一运行效果在原件中出现多份回执", "DUPLICATE_SOURCE_RECEIPT");
  if (!matches.length) return null;
  const receipt = validateAuthoritativeReceipt(
    matches[0].receipt,
    matches[0].index,
    block,
    context,
    proposalDigest,
    expectedAttemptNo,
    expectedOutcome,
  );
  return {
    receipt: {
      ...receipt,
      recovered: true,
      sourceHash: block.contentHash,
      sourcePath: context.sourcePath,
      taskId: context.taskId,
    },
    reconciliationEvidence: {
      kind: "authoritative-readback",
      sourceRevision: `sha256:${block.contentHash}`,
      digest: block.contentHash,
    },
  };
}

function inspectContract(block, context, triggerId) {
  fail(block.candidate.task.idKind === "explicit" && !block.candidate.task.done,
    "自排复验只能修改开放的显式 ID 任务", "TASK_NOT_OPEN");
  fail(block.candidate.task.executorId === context.executorId,
    "任务执行岗位与运行上下文不一致", "TASK_EXECUTOR_MISMATCH");
  const matches = [];
  for (let index = block.bounds.start + 1; index < block.bounds.end; index += 1) {
    const match = block.lines[index].match(CONTRACT_RE);
    if (match) matches.push({ index, match });
  }
  fail(matches.length === 1, "自排复验要求任务块只有一份自动推进契约", "AUTOMATION_CONTRACT_CONFLICT");
  let raw;
  try { raw = JSON.parse(matches[0].match[2]); }
  catch { throw new AgentTaskLedgerAdapterError("自动推进契约 JSON 无法解析", "AUTOMATION_CONTRACT_INVALID"); }
  const parsed = parseAgentTaskContract([`自动推进：${JSON.stringify(raw)}`]);
  fail(parsed.valid && parsed.contract?.version === 1,
    "自排复验只支持有效的 v1 自动契约", "AUTOMATION_CONTRACT_INVALID", { errors: parsed.errors });
  fail(parsed.contract.selfScheduleReview === true,
    "任务原契约没有授权自排复验", "SELF_SCHEDULE_REVIEW_FORBIDDEN");
  fail(parsed.contract.triggers.length === 1
    && parsed.contract.triggers[0].type === "time"
    && parsed.contract.triggers[0].id === triggerId,
  "v1 自排复验只能替换同一个单时间触发", "SELF_SCHEDULE_REVIEW_UNSUPPORTED");
  const task = { ...block.candidate.task, details: block.details };
  return {
    ...matches[0],
    raw,
    contract: parsed.contract,
    eligibilityRevision: computeEligibilityRevision(task, parsed),
  };
}

async function atomicReplaceChecked(block, nextContent, sourceFs = fs) {
  const stat = await sourceFs.stat(block.absolute);
  const temporary = `${block.absolute}.agent-schedule-${process.pid}-${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await sourceFs.open(temporary, "wx", stat.mode & 0o777);
    await handle.writeFile(nextContent, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    const fresh = await sourceFs.readFile(block.absolute);
    fail(sha256(fresh) === block.contentHash,
      "自排复验写入前原件发生并行变化", "SOURCE_CONFLICT");
    await sourceFs.rename(temporary, block.absolute);
    const directoryHandle = await sourceFs.open(path.dirname(block.absolute), "r");
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await sourceFs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function normalizedReviewAt(value) {
  fail(typeof value === "string"
    && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value),
  "nextReviewAt 必须是带时区的 ISO 时刻", "NEXT_REVIEW_INVALID");
  const parsed = new Date(value);
  fail(Number.isFinite(parsed.getTime()), "nextReviewAt 无效", "NEXT_REVIEW_INVALID");
  return parsed.toISOString();
}

function reviewIntentDigest(nextReviewAt) {
  return sha256(JSON.stringify({ nextReviewAt }));
}

function assertScheduledReadback(block, contract, nextReviewAt) {
  fail(contract.contract.triggers[0].at === nextReviewAt,
    "自排复验写入后无法回读时间触发器", "WRITEBACK_READBACK_FAILED");
  fail(block.candidate.task.reviewAt === nextReviewAt,
    "自排复验写入后无法回读任务行复验时间", "WRITEBACK_READBACK_FAILED");
}

function scheduledContent(block, contract, nextReviewAt) {
  const updatedRaw = structuredClone(contract.raw);
  updatedRaw.triggers[0].at = nextReviewAt;
  const updatedRecords = block.records.map((record) => ({ ...record }));
  updatedRecords[contract.index].text = `${contract.match[1]}${JSON.stringify(updatedRaw)}${contract.match[3]}`;
  const taskMatch = block.candidate.match;
  fail(taskMatch, "任务行无法用受控格式更新", "TASK_LINE_INVALID");
  const taskText = withTaskMetadata(taskMatch[4], "复验时间", tokyoMinute(nextReviewAt));
  updatedRecords[block.candidate.index].text = `${taskMatch[1]}${taskMatch[2]}${taskMatch[3]}${taskText}`;
  return updatedRecords.map((record) => `${record.text}${record.eol}`).join("");
}

function effectMeta(context, owner, effectType, effectId, intentDigest = null) {
  return {
    ...runtimeContext(context, owner),
    effectType,
    target: `${context.sourcePath}#${context.taskId}`,
    effectId,
    ...(intentDigest ? { intentDigest } : {}),
  };
}

function settlementOutcomes(run) {
  const effects = Object.values(run.effects || {}).filter((effect) => !effect.retiredAt);
  const applied = effects.filter((effect) => effect.appliedAt).map((effect) => effect.effectId).sort();
  const verified = effects.filter((effect) => effect.verifiedAt).map((effect) => effect.effectId).sort();
  const allApplied = effects.length > 0 && applied.length === effects.length;
  const allVerified = allApplied && verified.length === applied.length;
  return {
    writebackOutcome: applied.length
      ? { status: allApplied ? "succeeded" : "partial", effectIds: applied }
      : { status: "failed", effectIds: [], reasonCode: "trusted-writeback-missing" },
    readbackOutcome: verified.length
      ? { status: allVerified ? "succeeded" : "partial", effectIds: verified }
      : { status: "failed", effectIds: [], reasonCode: "trusted-readback-missing" },
    allApplied,
    allVerified,
  };
}

/**
 * Bind the public task-result protocol to one already claimed and started
 * runtime attempt. The returned object is the exact ledger interface consumed
 * by agent-task-writeback.mjs; run identity never comes from the proposal.
 */
export function createAgentTaskLedgerAdapter({
  ledgerPath,
  vaultRoot,
  owner,
  coordinatorContext,
  triggerId,
  platformExecution = null,
  sourceFileApi = fs,
}) {
  fail(typeof ledgerPath === "string" && path.isAbsolute(ledgerPath),
    "ledgerPath 必须是明确绝对路径", "LEDGER_PATH_INVALID");
  fail(typeof vaultRoot === "string" && path.isAbsolute(vaultRoot),
    "vaultRoot 必须是明确绝对路径", "VAULT_ROOT_INVALID");
  fail(typeof owner === "string" && owner.trim() === owner && owner.length > 0,
    "owner 不能为空", "RUN_CONTEXT_INVALID");
  fail(sourceFileApi && ["realpath", "readFile", "stat", "open", "rename", "rm"].every((name) => typeof sourceFileApi[name] === "function"),
    "sourceFileApi 缺少必要文件操作", "LEDGER_ADAPTER_INVALID");
  const context = normalizeCoordinatorContext(coordinatorContext, triggerId);
  const expectedPlatformExecution = normalizePlatformExecution(platformExecution);
  const runtime = createRuntimeLedgerFileApi({ filePath: ledgerPath });
  const mainEffectId = stableEffectId(TASK_WRITEBACK_EFFECT, `${context.sourcePath}#${context.taskId}`);
  const scheduleEffectId = stableEffectId(SELF_SCHEDULE_EFFECT, `${context.sourcePath}#${context.taskId}`);

  async function readBoundAttempt({ allowClaimed = false } = {}) {
    const state = await runtime.read();
    const run = state.runs[context.runId];
    const attempt = run?.attempts?.[context.attemptNo - 1];
    fail(run && sameValue(run.eligibilityKey, context.eligibilityKey),
      "运行账中的五元资格与协调器上下文不一致", "ELIGIBILITY_TUPLE_MISMATCH");
    fail(run.currentAttemptNo === context.attemptNo && attempt,
      "当前尝试不再是运行账中的有效尝试", "ATTEMPT_NOT_CURRENT");
    fail(run.lease?.owner === owner && run.lease?.attemptNo === context.attemptNo
      && Date.parse(run.lease.expiresAt) > Date.now(),
    "当前尝试没有属于协调器的活租约", "LEASE_MISMATCH");
    fail(attempt.status === "running" || (allowClaimed && attempt.status === "claimed"),
      "当前尝试不在可收口阶段", "INVALID_RUN_STATE");
    if (attempt.status === "running" && expectedPlatformExecution) {
      fail(sameValue(executionIdentityFromEvidence(attempt.startEvidence), expectedPlatformExecution),
        "平台执行身份与可信启动回执不一致", "PLATFORM_EXECUTION_MISMATCH");
    }
    return { state, run, attempt };
  }

  async function assertLiveRuntime() {
    const checked = await runtime.assertRunContext(runtimeContext(context, owner));
    fail(sameValue(checked.eligibilityKey, context.eligibilityKey),
      "运行账中的五元资格与协调器上下文不一致", "ELIGIBILITY_TUPLE_MISMATCH");
    await readBoundAttempt();
    return checked;
  }

  async function assertRunContext(requested) {
    assertRequestedContext(requested, context);
    await assertLiveRuntime();
    return publicCoordinatorContext(context);
  }

  async function withSourceMutation(apply) {
    fail(typeof apply === "function", "原件变更必须提供回调", "LEDGER_ADAPTER_INVALID");
    await assertLiveRuntime();
    const absolute = await resolveSource(vaultRoot, context.sourcePath, sourceFileApi);
    return withSourceFileLock(absolute, apply);
  }

  async function runIdempotentEffect(meta, apply) {
    fail(typeof apply === "function", "apply 必须是函数", "LEDGER_ADAPTER_INVALID");
    await assertLiveRuntime();
    fail(meta?.runId === context.runId && meta?.attemptNo === context.attemptNo
      && meta?.taskId === context.taskId && meta?.sourcePath === context.sourcePath
      && meta?.executorId === context.executorId && meta?.eligibilityRevision === context.eligibilityRevision,
    "写回效果与当前运行不一致", "RUN_CONTEXT_MISMATCH");
    fail(meta?.kind === TASK_WRITEBACK_EFFECT && meta?.effectId === mainEffectId,
      "公共写回只能记录当前任务的稳定 task.writeback 效果", "EFFECT_ID_MISMATCH");
    fail(HASH_RE.test(String(meta?.proposalDigest || "")),
      "写回提议缺少稳定摘要", "EFFECT_PAYLOAD_INVALID");
    const expectedOutcome = normalizeProposalOutcome(meta.proposalOutcome);
    fail(sha256(JSON.stringify({ outcome: expectedOutcome, evidence: context.verifiedEvidence })) === meta.proposalDigest,
      "写回提议内容与其稳定摘要不一致", "EFFECT_PAYLOAD_CONFLICT");
    const parameters = effectMeta(context, owner, TASK_WRITEBACK_EFFECT, mainEffectId, meta.proposalDigest);
    let prepared = await runtime.prepareEffect(parameters);
    if (prepared.duplicate) {
      const block = await readTaskBlock(vaultRoot, context, sourceFileApi);
      const source = authoritativeReceipt(block, context, meta.proposalDigest, prepared.receipt?.attemptNo ?? null, expectedOutcome);
      fail(source, "运行账称效果已成立，但任务原件缺少回执", "SOURCE_RECEIPT_MISSING");
      return { duplicate: true, receipt: source.receipt };
    }
    if (prepared.reconciliationRequired) {
      const block = await readTaskBlock(vaultRoot, context, sourceFileApi);
      const source = authoritativeReceipt(block, context, meta.proposalDigest, prepared.preparedAttemptNo, expectedOutcome);
      if (source) {
        const completed = {
          ...parameters,
          writebackOutcome: { status: "succeeded" },
          readbackOutcome: { status: "succeeded" },
        };
        if (prepared.preparedAttemptNo === context.attemptNo) {
          await runtime.recordEffect(completed);
        } else {
          await runtime.reconcileEffect({ ...completed, reconciliationEvidence: source.reconciliationEvidence });
        }
        return { duplicate: false, receipt: source.receipt };
      }
      fail(prepared.preparedAttemptNo < context.attemptNo,
        "当前尝试的 prepared 效果尚可能正在执行，拒绝并发重写", "EFFECT_RECONCILIATION_REQUIRED");
      await runtime.releaseEffectPreparation({
        ...effectMeta(context, owner, TASK_WRITEBACK_EFFECT, mainEffectId, prepared.intentDigest),
        reconciliationEvidence: {
          kind: "authoritative-negative-readback",
          sourceRevision: `sha256:${block.contentHash}`,
          digest: block.contentHash,
        },
      });
      prepared = await runtime.prepareEffect(parameters);
      fail(prepared.shouldApply,
        "释放旧 prepared 占位后未能获得新效果执行权", "EFFECT_RECONCILIATION_REQUIRED");
    }

    let applied;
    try {
      applied = await apply({ runId: context.runId, effectId: mainEffectId, idempotencyKey: `${context.runId}:${mainEffectId}` });
      const block = await readTaskBlock(vaultRoot, context, sourceFileApi);
      const source = authoritativeReceipt(block, context, meta.proposalDigest, context.attemptNo, expectedOutcome);
      fail(source, "写回返回后无法从原件回读结构化回执", "WRITEBACK_READBACK_FAILED");
      await runtime.recordEffect({
        ...parameters,
        writebackOutcome: { status: "succeeded" },
        readbackOutcome: { status: "succeeded" },
      });
      const receipt = applied && typeof applied === "object"
        ? { ...source.receipt, ...applied, sourceHash: block.contentHash, sourcePath: context.sourcePath, taskId: context.taskId }
        : source.receipt;
      return { duplicate: false, receipt };
    } catch (error) {
      let source = null;
      let authoritativeReadback = false;
      try {
        const block = await readTaskBlock(vaultRoot, context, sourceFileApi);
        source = authoritativeReceipt(block, context, meta.proposalDigest, context.attemptNo, expectedOutcome);
        authoritativeReadback = true;
      } catch (readError) {
        // A readable but malformed/conflicting receipt is an unknown applied
        // state, never proof that the source effect failed. Keep `prepared`
        // intact so a later attempt must reconcile instead of re-applying.
        if (readError instanceof AgentTaskLedgerAdapterError) throw readError;
      }
      if (source) {
        await runtime.recordEffect({
          ...parameters,
          writebackOutcome: { status: "succeeded" },
          readbackOutcome: { status: "succeeded" },
        });
      } else if (authoritativeReadback) {
        await runtime.recordEffect({
          ...parameters,
          writebackOutcome: { status: "failed", reasonCode: "source-write-failed" },
          readbackOutcome: { status: "failed", reasonCode: "source-receipt-missing" },
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async function hasCommittedEffect({ runId, effectId }) {
    fail(runId === context.runId && new Set([mainEffectId, scheduleEffectId]).has(effectId),
      "效果查询越过当前运行边界", "RUN_CONTEXT_MISMATCH");
    return runtime.hasCommittedEffect({ runId, effectId });
  }

  async function recordProcessExit(event) {
    fail(event?.runId === context.runId && event?.attemptNo === context.attemptNo
      && event?.taskId === context.taskId && event?.sourcePath === context.sourcePath
      && event?.executorId === context.executorId && event?.effectId === mainEffectId,
    "进程退出事件与当前运行不一致", "RUN_CONTEXT_MISMATCH");
    const bound = await readBoundAttempt({ allowClaimed: true });
    if (bound.attempt.status === "claimed") {
      const reasonCode = normalizedReasonCode(event.errorCode, "start-receipt-missing");
      return runtime.settle({
        runId: context.runId,
        attemptNo: context.attemptNo,
        owner,
        processOutcome: { status: "not-started", reasonCode },
        writebackOutcome: { status: "failed", reasonCode: "trusted-writeback-missing" },
        readbackOutcome: { status: "failed", reasonCode: "trusted-readback-missing" },
        errors: [{ code: reasonCode, stage: "start", retryable: true, source: "ledger-adapter" }],
      });
    }
    await assertLiveRuntime();
    const state = await runtime.read();
    const run = state.runs[context.runId];
    const outcomes = settlementOutcomes(run);
    const reportedError = typeof event.errorCode === "string" && event.errorCode.length > 0;
    const successfulExit = event.exitCode === 0 && event.signal == null && !reportedError;
    const processOutcome = successfulExit
      ? { status: "succeeded", exitCode: 0 }
      : reportedError
        ? {
          status: "failed",
          ...((Number.isInteger(event.exitCode) && event.exitCode !== 0) ? { exitCode: event.exitCode } : {}),
          ...(event.signal ? { signal: event.signal } : {}),
          reasonCode: "process-reported-error",
        }
      : event.exitCode == null && event.signal == null
        ? { status: "unknown", reasonCode: "process-outcome-unknown" }
        : { status: "failed", ...(Number.isInteger(event.exitCode) ? { exitCode: event.exitCode } : {}), ...(event.signal ? { signal: event.signal } : {}) };
    const errors = [];
    if (!successfulExit) errors.push({
      code: reportedError ? "process-reported-error" : event.signal ? "process-signal" : event.exitCode == null ? "process-outcome-unknown" : "process-exit-nonzero",
      stage: "process",
      retryable: true,
      source: "ledger-adapter",
    });
    if (!outcomes.allApplied || !outcomes.allVerified || !run.effects[mainEffectId]?.appliedAt) errors.push({
      code: "trusted-writeback-missing",
      stage: "writeback",
      retryable: true,
      source: "ledger-adapter",
    });
    return runtime.settle({
      runId: context.runId,
      attemptNo: context.attemptNo,
      owner,
      processOutcome,
      writebackOutcome: outcomes.writebackOutcome,
      readbackOutcome: outcomes.readbackOutcome,
      errors,
    });
  }

  async function prepareReview(meta) {
    await assertLiveRuntime();
    fail(context.authorizedEffects.includes(SELF_SCHEDULE_EFFECT),
      "协调器没有授权自排复验", "SELF_SCHEDULE_REVIEW_FORBIDDEN");
    fail(meta?.runId === context.runId && meta?.attemptNo === context.attemptNo
      && meta?.taskId === context.taskId && meta?.sourcePath === context.sourcePath
      && meta?.executorId === context.executorId && meta?.eligibilityRevision === context.eligibilityRevision
      && meta?.effectId === scheduleEffectId,
    "自排复验效果与当前运行不一致", "RUN_CONTEXT_MISMATCH");
    const nextReviewAt = normalizedReviewAt(meta.nextReviewAt);
    const block = await readTaskBlock(vaultRoot, context, sourceFileApi);
    const contract = inspectContract(block, context, context.triggerId);
    if (block.candidate.task.reviewAt
      && contract.contract.triggers[0].at !== block.candidate.task.reviewAt) {
      fail(false,
        "原件中的复验时间与时间触发器只成立一半，拒绝猜测修复",
        "EFFECT_RECONCILIATION_REQUIRED");
    }
    const state = await runtime.read();
    const known = state.runs[context.runId]?.effects?.[scheduleEffectId];
    const alreadyScheduled = contract.contract.triggers[0].at === nextReviewAt
      && block.candidate.task.reviewAt === nextReviewAt;
    if (!alreadyScheduled && !known?.appliedAt && !known?.preparedAt) {
      fail(contract.eligibilityRevision === context.eligibilityRevision,
        "自排复验预备前任务施工意图已变化", "ELIGIBILITY_REVISION_CONFLICT");
    }
    const parameters = effectMeta(
      context,
      owner,
      SELF_SCHEDULE_EFFECT,
      scheduleEffectId,
      reviewIntentDigest(nextReviewAt),
    );
    let prepared = await runtime.prepareEffect(parameters);
    if (prepared.duplicate) {
      fail(alreadyScheduled,
        "自排复验运行账已成立，但原件没有对应时间", "EFFECT_PAYLOAD_CONFLICT");
      return prepared;
    }
    if (!prepared.reconciliationRequired) return prepared;

    const sourceReviewAt = contract.contract.triggers[0].at === block.candidate.task.reviewAt
      ? contract.contract.triggers[0].at
      : null;
    if (sourceReviewAt && prepared.intentDigest === reviewIntentDigest(sourceReviewAt)) {
      const completed = {
        ...effectMeta(context, owner, SELF_SCHEDULE_EFFECT, scheduleEffectId, prepared.intentDigest),
        writebackOutcome: { status: "succeeded" },
        readbackOutcome: { status: "succeeded" },
      };
      if (prepared.preparedAttemptNo === context.attemptNo) await runtime.recordEffect(completed);
      else await runtime.reconcileEffect({
        ...completed,
        reconciliationEvidence: {
          kind: "authoritative-readback",
          sourceRevision: `sha256:${block.contentHash}`,
          digest: block.contentHash,
        },
      });
      fail(prepared.intentDigest === parameters.intentDigest,
        "原件已成立的自排复验与新提议时间冲突", "EFFECT_PAYLOAD_CONFLICT");
      return { ...prepared, duplicate: true, reconciliationRequired: false };
    }

    fail(prepared.preparedAttemptNo < context.attemptNo,
      "当前尝试的 prepared 自排复验不能被重新准备", "EFFECT_RECONCILIATION_REQUIRED");
    fail(contract.eligibilityRevision === context.eligibilityRevision,
      "原件不能证明旧自排复验未写入", "EFFECT_RECONCILIATION_REQUIRED");
    await runtime.releaseEffectPreparation({
      ...effectMeta(context, owner, SELF_SCHEDULE_EFFECT, scheduleEffectId, prepared.intentDigest),
      reconciliationEvidence: {
        kind: "authoritative-negative-readback",
        sourceRevision: `sha256:${block.contentHash}`,
        digest: block.contentHash,
      },
    });
    prepared = await runtime.prepareEffect(parameters);
    fail(prepared.shouldApply,
      "释放旧 prepared 自排复验后未获得新提议执行权", "EFFECT_RECONCILIATION_REQUIRED");
    return prepared;
  }

  async function releaseOmittedReview(meta) {
    await assertLiveRuntime();
    fail(meta?.runId === context.runId && meta?.attemptNo === context.attemptNo
      && meta?.taskId === context.taskId && meta?.sourcePath === context.sourcePath
      && meta?.executorId === context.executorId && meta?.eligibilityRevision === context.eligibilityRevision
      && meta?.effectId === scheduleEffectId,
    "省略自排复验的清理请求与当前运行不一致", "RUN_CONTEXT_MISMATCH");
    const state = await runtime.read();
    const effect = state.runs[context.runId]?.effects?.[scheduleEffectId];
    if (!effect?.preparedAt) return { released: false, reason: "no-stale-review" };
    fail(effect.preparedAttemptNo < context.attemptNo,
      "当前尝试准备的自排复验不能被同次结果静默取消", "EFFECT_RECONCILIATION_REQUIRED");
    const block = await readTaskBlock(vaultRoot, context, sourceFileApi);
    fail(!authoritativeReceipt(block, context),
      "原件已有本逻辑运行回执，不能把遗留自排复验当作未写入", "EFFECT_RECONCILIATION_REQUIRED");
    const contract = inspectContract(block, context, context.triggerId);
    if (block.candidate.task.reviewAt) {
      fail(contract.contract.triggers[0].at === block.candidate.task.reviewAt,
        "原件中的复验时间与时间触发器只成立一半，拒绝猜测清理",
        "EFFECT_RECONCILIATION_REQUIRED");
      fail(reviewIntentDigest(block.candidate.task.reviewAt) !== effect.intentDigest,
        "原件已经完整成立当前 prepared 自排复验，新的省略不能静默撤销既有正式效果",
        "EFFECT_PAYLOAD_CONFLICT");
    }
    fail(contract.eligibilityRevision === context.eligibilityRevision,
      "原件不能证明旧自排复验未写入", "EFFECT_RECONCILIATION_REQUIRED");
    return runtime.releaseEffectPreparation({
      ...effectMeta(context, owner, SELF_SCHEDULE_EFFECT, scheduleEffectId, effect.intentDigest),
      retireEffect: true,
      reconciliationEvidence: {
        kind: "authoritative-negative-readback",
        sourceRevision: `sha256:${block.contentHash}`,
        digest: block.contentHash,
      },
    });
  }

  async function scheduleReview(meta) {
    await assertLiveRuntime();
    fail(context.authorizedEffects.includes(SELF_SCHEDULE_EFFECT),
      "协调器没有授权自排复验", "SELF_SCHEDULE_REVIEW_FORBIDDEN");
    fail(meta?.runId === context.runId && meta?.attemptNo === context.attemptNo
      && meta?.taskId === context.taskId && meta?.sourcePath === context.sourcePath
      && meta?.executorId === context.executorId && meta?.eligibilityRevision === context.eligibilityRevision
      && meta?.effectId === scheduleEffectId,
    "自排复验效果与当前运行不一致", "RUN_CONTEXT_MISMATCH");
    const nextReviewAt = normalizedReviewAt(meta.nextReviewAt);
    const initialBlock = await readTaskBlock(vaultRoot, context, sourceFileApi);
    const initialContract = inspectContract(initialBlock, context, context.triggerId);
    if (initialBlock.candidate.task.reviewAt
      && initialContract.contract.triggers[0].at !== initialBlock.candidate.task.reviewAt) {
      fail(false,
        "原件中的复验时间与时间触发器只成立一半，拒绝猜测修复",
        "EFFECT_RECONCILIATION_REQUIRED");
    }
    const initialAlreadyScheduled = initialContract.contract.triggers[0].at === nextReviewAt
      && initialBlock.candidate.task.reviewAt === nextReviewAt;
    const beforePrepare = await runtime.read();
    const knownScheduleEffect = beforePrepare.runs[context.runId]?.effects?.[scheduleEffectId];
    if (!initialAlreadyScheduled && !knownScheduleEffect?.appliedAt && !knownScheduleEffect?.preparedAt) {
      fail(initialContract.eligibilityRevision === context.eligibilityRevision,
        "自排复验前任务施工意图已变化", "ELIGIBILITY_REVISION_CONFLICT");
    }

    let writeBlock = initialBlock;
    let writeContract = initialContract;
    let nextContent = scheduledContent(writeBlock, writeContract, nextReviewAt);
    const parameters = effectMeta(
      context,
      owner,
      SELF_SCHEDULE_EFFECT,
      scheduleEffectId,
      reviewIntentDigest(nextReviewAt),
    );
    let prepared = await runtime.prepareEffect(parameters);

    if (prepared.shouldApply && initialAlreadyScheduled) {
      await runtime.recordEffect({
        ...parameters,
        writebackOutcome: { status: "succeeded" },
        readbackOutcome: { status: "succeeded" },
      });
      return {
        duplicate: false,
        schedule: { triggerId: context.triggerId, nextReviewAt, sourcePath: context.sourcePath, taskId: context.taskId },
      };
    }

    if (prepared.duplicate) {
      const current = await readTaskBlock(vaultRoot, context, sourceFileApi);
      const currentContract = inspectContract(current, context, context.triggerId);
      try {
        assertScheduledReadback(current, currentContract, nextReviewAt);
      } catch (error) {
        if (error?.code === "WRITEBACK_READBACK_FAILED") {
          throw new AgentTaskLedgerAdapterError(
            "自排复验效果已占用，但原件中的任务时间与触发器未同时成立",
            "EFFECT_PAYLOAD_CONFLICT",
          );
        }
        throw error;
      }
      return {
        duplicate: true,
        schedule: { triggerId: context.triggerId, nextReviewAt, sourcePath: context.sourcePath, taskId: context.taskId },
      };
    }

    if (prepared.reconciliationRequired) {
      const current = await readTaskBlock(vaultRoot, context, sourceFileApi);
      const currentContract = inspectContract(current, context, context.triggerId);
      const triggerMatches = currentContract.contract.triggers[0].at === nextReviewAt;
      const taskTimeMatches = current.candidate.task.reviewAt === nextReviewAt;
      if (triggerMatches && taskTimeMatches) {
        const completed = {
          ...parameters,
          writebackOutcome: { status: "succeeded" },
          readbackOutcome: { status: "succeeded" },
        };
        if (prepared.preparedAttemptNo === context.attemptNo) {
          await runtime.recordEffect(completed);
        } else {
          await runtime.reconcileEffect({
            ...completed,
            reconciliationEvidence: {
              kind: "authoritative-readback",
              sourceRevision: `sha256:${current.contentHash}`,
              digest: current.contentHash,
            },
          });
        }
        return {
          duplicate: false,
          schedule: { triggerId: context.triggerId, nextReviewAt, sourcePath: context.sourcePath, taskId: context.taskId },
        };
      }
      fail(!triggerMatches && !taskTimeMatches,
        "prepared 自排复验只有半份原件状态，拒绝猜测修复", "EFFECT_RECONCILIATION_REQUIRED");
      fail(prepared.preparedAttemptNo < context.attemptNo,
        "当前尝试的 prepared 自排复验尚可能正在执行", "EFFECT_RECONCILIATION_REQUIRED");
      fail(currentContract.eligibilityRevision === context.eligibilityRevision,
        "负回读后发现任务施工意图已变化，拒绝自动重试", "ELIGIBILITY_REVISION_CONFLICT");
      await runtime.releaseEffectPreparation({
        ...effectMeta(context, owner, SELF_SCHEDULE_EFFECT, scheduleEffectId, prepared.intentDigest),
        reconciliationEvidence: {
          kind: "authoritative-negative-readback",
          sourceRevision: `sha256:${current.contentHash}`,
          digest: current.contentHash,
        },
      });
      prepared = await runtime.prepareEffect(parameters);
      fail(prepared.shouldApply,
        "释放旧 prepared 自排复验后未获得新执行权", "EFFECT_RECONCILIATION_REQUIRED");
      writeBlock = current;
      writeContract = currentContract;
      nextContent = scheduledContent(writeBlock, writeContract, nextReviewAt);
    }

    try {
      await withSourceMutation(() => atomicReplaceChecked(writeBlock, nextContent, sourceFileApi));
      const readback = await readTaskBlock(vaultRoot, context, sourceFileApi);
      const readbackContract = inspectContract(readback, context, context.triggerId);
      assertScheduledReadback(readback, readbackContract, nextReviewAt);
      await runtime.recordEffect({
        ...parameters,
        writebackOutcome: { status: "succeeded" },
        readbackOutcome: { status: "succeeded" },
      });
      return {
        duplicate: false,
        schedule: { triggerId: context.triggerId, nextReviewAt, sourcePath: context.sourcePath, taskId: context.taskId },
      };
    } catch (error) {
      let current = null;
      let currentContract = null;
      try {
        current = await readTaskBlock(vaultRoot, context, sourceFileApi);
        currentContract = inspectContract(current, context, context.triggerId);
      } catch {
        current = null;
        currentContract = null;
      }
      const triggerMatches = currentContract?.contract.triggers[0].at === nextReviewAt;
      const taskTimeMatches = current?.candidate.task.reviewAt === nextReviewAt;
      if (current && currentContract && triggerMatches && taskTimeMatches) {
        await runtime.recordEffect({
          ...parameters,
          writebackOutcome: { status: "succeeded" },
          readbackOutcome: { status: "succeeded" },
        });
      } else if (current && currentContract && !triggerMatches && !taskTimeMatches) {
        await runtime.recordEffect({
          ...parameters,
          writebackOutcome: { status: "failed", reasonCode: "schedule-write-failed" },
          readbackOutcome: { status: "failed", reasonCode: "schedule-readback-failed" },
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  return Object.freeze({
    assertRunContext,
    withSourceMutation,
    runIdempotentEffect,
    hasCommittedEffect,
    recordProcessExit,
    prepareReview,
    releaseOmittedReview,
    scheduleReview,
  });
}
