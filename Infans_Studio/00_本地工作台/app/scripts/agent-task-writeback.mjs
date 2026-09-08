#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { findTaskLine } from "../src/server/workbench-project-management.mjs";
import { parseAgentTaskContract, validateVaultEvidencePath } from "../src/server/workbench-agent-task-contract.mjs";
import { stableEffectId } from "./agent-task-runtime-ledger.mjs";

export const AGENT_TASK_RESULT_SCHEMA_VERSION = 1;
export const AGENT_TASK_OUTCOMES = Object.freeze(["completed", "blocked", "failed", "progress"]);
export const AGENT_TASK_EFFECTS = Object.freeze({
  completed: "task.complete",
  blocked: "task.block",
  failed: "task.progress",
  progress: "task.progress",
  selfScheduleReview: "task.selfScheduleReview",
});

const RECEIPT_LABEL = "自动回执";
const RESULT_LABEL = "自动运行结果";
const MAX_SUMMARY_LENGTH = 1_200;
const MAX_NEXT_STEP_LENGTH = 1_200;
const MAX_EVIDENCE_REF_LENGTH = 500;
const MAX_EVIDENCE_REFS = 24;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const HASH_RE = /^[a-f0-9]{64}$/u;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const EXECUTOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}$/u;
const FORBIDDEN_PATH_SEGMENTS = new Set([".git", "node_modules", "案头", "本人草稿"]);
const SECRET_LIKE_CONTENT_RE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[A-Z0-9]{16}\b|\bAIza[0-9A-Za-z_-]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:密码|密钥|令牌|api\s*key|password|secret|token)\s*[=:：]\s*\S{8,})/iu;

export class AgentTaskWritebackError extends Error {
  constructor(message, code = "AGENT_TASK_WRITEBACK_INVALID") {
    super(message);
    this.name = "AgentTaskWritebackError";
    this.code = code;
  }
}

function fail(condition, message, code) {
  if (!condition) throw new AgentTaskWritebackError(message, code);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sourceContentHash(content) {
  return sha256(Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8"));
}

export function taskSnapshotFingerprint(task) {
  return sha256(`${task?.sourcePath || ""}#${task?.id || ""}\n${task?.text || ""}\n${(task?.details || []).join("\n")}`);
}

export function taskWritebackEffectId({ taskId, sourcePath }) {
  fail(TASK_ID_RE.test(String(taskId || "")), "任务 ID 格式不正确", "TASK_ID_INVALID");
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  return stableEffectId("task.writeback", `${normalizedSourcePath}#${taskId}`);
}

export function selfScheduleReviewEffectId({ taskId, sourcePath }) {
  fail(TASK_ID_RE.test(String(taskId || "")), "任务 ID 格式不正确", "TASK_ID_INVALID");
  const normalizedSourcePath = normalizeSourcePath(sourcePath);
  return stableEffectId("task.selfScheduleReview", `${normalizedSourcePath}#${taskId}`);
}

function normalizeSourcePath(value) {
  fail(typeof value === "string" && value.trim() === value && value.length > 0, "来源路径不能为空", "SOURCE_PATH_INVALID");
  fail(!value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value), "来源路径必须是 Vault 内相对路径", "SOURCE_PATH_INVALID");
  const normalized = path.posix.normalize(value);
  fail(normalized === value && normalized !== "." && !normalized.startsWith("../"), "来源路径不能越过 Vault", "SOURCE_PATH_INVALID");
  fail(normalized.endsWith(".md"), "自动任务写回只接受 Markdown 原件", "SOURCE_PATH_INVALID");
  fail(!normalized.split("/").some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment)), "来源路径不在自动写回白名单", "SOURCE_PATH_FORBIDDEN");
  return normalized;
}

function validateSafeId(value, field, pattern = SAFE_ID_RE) {
  fail(typeof value === "string" && pattern.test(value), `${field} 格式不正确`, "RUN_CONTEXT_INVALID");
  return value;
}

function normalizeVerifiedEvidence(value, sourcePath) {
  fail(Array.isArray(value) && value.length <= MAX_EVIDENCE_REFS,
    "verifiedEvidence 必须是有上限的协调器证据数组", "RUN_CONTEXT_INVALID");
  const seen = new Set();
  return value.map((item) => {
    fail(item && typeof item === "object" && !Array.isArray(item)
      && sameArray(Object.keys(item).sort(), ["path", "sha256"]),
    "verifiedEvidence 项只能包含 path 与 sha256", "RUN_CONTEXT_INVALID");
    const checked = validateVaultEvidencePath(item.path);
    fail(checked.valid && checked.path === item.path && item.path !== sourcePath,
      "verifiedEvidence 含非法或自指路径", "RUN_CONTEXT_INVALID");
    fail(HASH_RE.test(String(item.sha256 || "")),
      "verifiedEvidence 缺少 SHA-256", "RUN_CONTEXT_INVALID");
    fail(!seen.has(item.path), "verifiedEvidence 不能重复路径", "RUN_CONTEXT_INVALID");
    seen.add(item.path);
    return Object.freeze({ path: item.path, sha256: item.sha256 });
  });
}

function validateRunContextShape(input) {
  fail(input && typeof input === "object" && !Array.isArray(input), "缺少协调器运行上下文", "RUN_CONTEXT_MISSING");
  const sourcePath = normalizeSourcePath(input.sourcePath);
  const context = {
    runId: validateSafeId(input.runId, "runId"),
    attemptNo: Number(input.attemptNo),
    taskId: validateSafeId(input.taskId, "taskId", TASK_ID_RE),
    sourcePath,
    executorId: validateSafeId(input.executorId, "executorId", EXECUTOR_ID_RE),
    eligibilityRevision: validateSafeId(input.eligibilityRevision, "eligibilityRevision"),
    effectId: validateSafeId(input.effectId, "effectId"),
    taskFingerprint: String(input.taskFingerprint || ""),
    expectedSourceHash: String(input.expectedSourceHash || ""),
    authorizedEffects: Array.isArray(input.authorizedEffects) ? [...input.authorizedEffects] : [],
    verifiedEvidence: normalizeVerifiedEvidence(input.verifiedEvidence, sourcePath),
  };
  fail(Number.isSafeInteger(context.attemptNo) && context.attemptNo > 0, "attemptNo 必须是正整数", "RUN_CONTEXT_INVALID");
  fail(HASH_RE.test(context.taskFingerprint), "taskFingerprint 格式不正确", "RUN_CONTEXT_INVALID");
  fail(HASH_RE.test(context.expectedSourceHash), "expectedSourceHash 格式不正确", "RUN_CONTEXT_INVALID");
  fail(context.effectId === taskWritebackEffectId(context), "effectId 不是该任务原件的稳定写回效果 ID", "EFFECT_ID_INVALID");
  fail(context.authorizedEffects.length > 0
    && context.authorizedEffects.every((effect) => typeof effect === "string" && SAFE_ID_RE.test(effect)),
  "authorizedEffects 格式不正确", "RUN_CONTEXT_INVALID");
  context.authorizedEffects = [...new Set(context.authorizedEffects)];
  context.verifiedEvidence = Object.freeze(context.verifiedEvidence);
  return Object.freeze(context);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertCanonicalRunContext(requested, canonical) {
  if (canonical === true) return requested;
  fail(canonical && typeof canonical === "object", "运行账拒绝了当前运行上下文", "RUN_CONTEXT_REJECTED");
  const checked = validateRunContextShape(canonical);
  for (const key of ["runId", "attemptNo", "taskId", "sourcePath", "executorId", "eligibilityRevision", "effectId", "taskFingerprint", "expectedSourceHash"]) {
    fail(checked[key] === requested[key], `运行账中的 ${key} 与协调器上下文不一致`, "RUN_CONTEXT_MISMATCH");
  }
  fail(sameArray([...checked.authorizedEffects].sort(), [...requested.authorizedEffects].sort()),
    "运行账中的授权效果与协调器上下文不一致", "RUN_CONTEXT_MISMATCH");
  fail(JSON.stringify(checked.verifiedEvidence) === JSON.stringify(requested.verifiedEvidence),
    "运行账中的证据快照与协调器上下文不一致", "RUN_CONTEXT_MISMATCH");
  return checked;
}

async function assertTrustedRunContext(ledger, coordinatorContext) {
  fail(ledger && typeof ledger.assertRunContext === "function", "运行账适配器缺少 assertRunContext", "LEDGER_ADAPTER_INVALID");
  const requested = validateRunContextShape(coordinatorContext);
  const canonical = await ledger.assertRunContext(requested);
  return assertCanonicalRunContext(requested, canonical);
}

function normalizeSingleLine(value, field, maxLength, { required = true, plainText = false } = {}) {
  fail(typeof value === "string", `${field} 必须是字符串`, "RESULT_SCHEMA_INVALID");
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (required) fail(normalized.length > 0, `${field} 不能为空`, "RESULT_SCHEMA_INVALID");
  fail(normalized.length <= maxLength, `${field} 过长`, "RESULT_SCHEMA_INVALID");
  fail(!/[\u0000-\u001f\u007f]/u.test(normalized), `${field} 含控制字符`, "RESULT_SCHEMA_INVALID");
  if (plainText) {
    fail(!/(?:[a-z][a-z0-9+.-]*:\/\/|data:|javascript:|!\[|\[[^\]]*\]\(|!?\[\[|<[^>]+>|`)/iu.test(normalized),
      `${field} 只能是无链接、无嵌入的纯文本`, "RESULT_MARKUP_FORBIDDEN");
  }
  return normalized;
}

function assertNoPersonalAcceptanceClaim(values) {
  const text = values.join("\n");
  const positiveAcceptance = /(?:本人|Capoo|用户)\s*(?:已经|已)?\s*(?:明确)?\s*(?:验收通过|已验收|确认通过|确认完成)|(?:已由|已经由)\s*(?:本人|Capoo|用户)\s*(?:完成)?验收/iu;
  fail(!positiveAcceptance.test(text), "自动结果不能代签使用者本人验收", "PERSONAL_ACCEPTANCE_FORBIDDEN");
}

function assertNoSecretLikeContent(values) {
  fail(!SECRET_LIKE_CONTENT_RE.test(values.join("\n")),
    "自动结果疑似包含凭据或高敏认证内容", "RESULT_SENSITIVE_CONTENT_FORBIDDEN");
}

function normalizeReviewAt(value, now) {
  if (value == null || value === "") return null;
  fail(typeof value === "string"
    && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value),
  "nextReviewAt 必须是带时区的 ISO 时间", "NEXT_REVIEW_INVALID");
  const parsed = new Date(value);
  fail(!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime(), "nextReviewAt 必须晚于当前时间", "NEXT_REVIEW_INVALID");
  return parsed.toISOString();
}

function normalizeOutcome(value, now) {
  fail(value && typeof value === "object" && !Array.isArray(value), "outcome 尚未填写", "RESULT_MISSING");
  const allowedKeys = new Set(["status", "summary", "evidenceRefs", "nextStep", "nextReviewAt"]);
  fail(Object.keys(value).every((key) => allowedKeys.has(key)), "outcome 含有公共入口不接受的字段", "RESULT_SCHEMA_INVALID");
  fail(AGENT_TASK_OUTCOMES.includes(value.status), "outcome.status 不受支持", "RESULT_STATUS_INVALID");
  const summary = normalizeSingleLine(value.summary, "summary", MAX_SUMMARY_LENGTH, { plainText: true });
  fail(Array.isArray(value.evidenceRefs) && value.evidenceRefs.length <= MAX_EVIDENCE_REFS,
    "evidenceRefs 必须是有上限的数组", "RESULT_SCHEMA_INVALID");
  const evidenceRefs = [...new Set(Array.from(value.evidenceRefs, (item) => {
    const reference = normalizeSingleLine(item, "evidenceRefs 项", MAX_EVIDENCE_REF_LENGTH);
    const checked = validateVaultEvidencePath(reference);
    fail(checked.valid && checked.path === reference, checked.message || "evidenceRefs 路径无效", checked.code || "EVIDENCE_PATH_INVALID");
    return reference;
  }))];
  const nextStep = normalizeSingleLine(value.nextStep, "nextStep", MAX_NEXT_STEP_LENGTH, { required: value.status !== "completed", plainText: true });
  const nextReviewAt = normalizeReviewAt(value.nextReviewAt, now);
  fail(value.status !== "completed" || evidenceRefs.length > 0,
    "completed 必须同时提供 summary 和至少一条 evidenceRefs", "COMPLETION_EVIDENCE_REQUIRED");
  fail(!(value.status === "completed" && nextReviewAt), "已完成任务不能同时自排本任务复验", "NEXT_REVIEW_CONFLICT");
  assertNoPersonalAcceptanceClaim([summary, nextStep, ...evidenceRefs]);
  assertNoSecretLikeContent([summary, nextStep]);
  return Object.freeze({ status: value.status, summary, evidenceRefs: Object.freeze(evidenceRefs), nextStep, nextReviewAt });
}

function validateProposalShape(proposal, context, now) {
  fail(proposal && typeof proposal === "object" && !Array.isArray(proposal), "结果提议格式不正确", "RESULT_SCHEMA_INVALID");
  const keys = Object.keys(proposal).sort();
  fail(sameArray(keys, ["effectId", "outcome", "schemaVersion"]),
    "结果提议只能包含 schemaVersion、effectId 和 outcome；不得携带 runId", "RESULT_SCHEMA_INVALID");
  fail(proposal.schemaVersion === AGENT_TASK_RESULT_SCHEMA_VERSION, "结果提议版本不受支持", "RESULT_SCHEMA_INVALID");
  fail(proposal.effectId === context.effectId, "结果提议不属于当前稳定效果", "PROPOSAL_EFFECT_MISMATCH");
  const outcome = normalizeOutcome(proposal.outcome, now);
  const verifiedPaths = context.verifiedEvidence.map((item) => item.path);
  fail(outcome.evidenceRefs.every((reference) => verifiedPaths.includes(reference)),
    "模型证据引用不在协调器冻结的触发证据中", "EVIDENCE_SNAPSHOT_MISMATCH");
  return outcome;
}

async function writePrivateExclusive(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createResultProposal({ proposalPath, effectId }) {
  fail(typeof proposalPath === "string" && path.isAbsolute(proposalPath), "proposalPath 必须是绝对路径", "PROPOSAL_PATH_INVALID");
  validateSafeId(effectId, "effectId");
  const proposal = {
    schemaVersion: AGENT_TASK_RESULT_SCHEMA_VERSION,
    effectId,
    outcome: {
      status: null,
      summary: "",
      evidenceRefs: [],
      nextStep: "",
    },
  };
  await writePrivateExclusive(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
  return proposal;
}

export async function readResultProposal(proposalPath) {
  fail(typeof proposalPath === "string" && path.isAbsolute(proposalPath), "proposalPath 必须是绝对路径", "PROPOSAL_PATH_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(proposalPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new AgentTaskWritebackError("找不到结果提议文件", "PROPOSAL_MISSING");
    if (error instanceof SyntaxError) throw new AgentTaskWritebackError("结果提议不是合法 JSON", "RESULT_SCHEMA_INVALID");
    throw error;
  }
  return parsed;
}

function splitLineRecords(content) {
  const records = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline < 0 ? content.length : newline + 1;
    const raw = content.slice(start, end);
    const eol = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    records.push({ text: eol ? raw.slice(0, -eol.length) : raw, eol, start, end });
    start = end;
  }
  if (records.length === 0) records.push({ text: "", eol: "", start: 0, end: 0 });
  return records;
}

function indentation(value) {
  return String(value).match(/^[ \t]*/u)?.[0] || "";
}

function taskBlockBounds(records, taskIndex) {
  const baseIndent = indentation(records[taskIndex].text);
  let end = records.length;
  for (let index = taskIndex + 1; index < records.length; index += 1) {
    const text = records[index].text;
    if (!text.trim()) continue;
    if (/^\s*-\s+\[/u.test(text) || /^#{1,6}\s+/u.test(text)) {
      end = index;
      break;
    }
    if (indentation(text).length <= baseIndent.length) {
      end = index;
      break;
    }
  }
  return { start: taskIndex, end, baseIndent };
}

function cleanInline(value = "") {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, (_match, target) => String(target).split("/").at(-1) ?? target)
    .replace(/<[^>]+>/gu, "")
    .replace(/\*\*|__|~~|`/gu, "")
    .replace(/\\\|/gu, "|")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function taskDetailsForFingerprint(records, taskIndex, blockEnd) {
  const details = [];
  for (let index = taskIndex + 1; index < blockEnd; index += 1) {
    const line = records[index].text;
    if (/^\s{2,}-\s+/u.test(line)) details.push(cleanInline(line.replace(/^\s*-\s*/u, "")));
  }
  return details;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function fieldIndexes(records, bounds, field) {
  const prefix = `${bounds.baseIndent}  `;
  const matcher = new RegExp(`^${escapeRegExp(prefix)}-\\s+${escapeRegExp(field)}\\s*[：:]`, "u");
  const indexes = [];
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    if (matcher.test(records[index].text)) indexes.push(index);
  }
  return indexes;
}

function receiptFromLine(line) {
  const match = String(line).match(/^\s*-\s+自动回执\s*[：:]\s*`(\{.*\})`\s*$/u);
  if (!match) return null;
  try { return JSON.parse(match[1]); }
  catch { return null; }
}

function findExistingReceipt(records, bounds, context, proposalDigest) {
  const matches = [];
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const receipt = receiptFromLine(records[index].text);
    if (receipt?.runId === context.runId && receipt?.effectId === context.effectId) matches.push(receipt);
  }
  fail(matches.length <= 1, "同一运行效果出现多个原件回执", "DUPLICATE_SOURCE_RECEIPT");
  if (!matches.length) return null;
  fail(matches[0].proposalDigest === proposalDigest, "同一运行效果提交了不同结果", "EFFECT_PAYLOAD_CONFLICT");
  return matches[0];
}

function withMetadata(text, key, value) {
  const matcher = new RegExp(`[｜|]\\s*${escapeRegExp(key)}\\s*[：:]\\s*[^｜|]+`, "gu");
  const cleaned = String(text).replace(matcher, "").trim();
  return value == null ? cleaned : `${cleaned}｜${key}：${value}`;
}

function tokyoParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minute: `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}` };
}

function directFieldLine(bounds, field, value) {
  return `${bounds.baseIndent}  - ${field}：${value}`;
}

function upsertDirectField(records, bounds, field, value, eol) {
  const matches = fieldIndexes(records, bounds, field);
  fail(matches.length <= 1, `任务块中“${field}”重复，拒绝猜测覆盖`, "TASK_BLOCK_CONFLICT");
  if (matches.length === 1) {
    records[matches[0]].text = directFieldLine(bounds, field, value);
    return;
  }
  let insertion = bounds.end;
  while (insertion > bounds.start + 1 && !records[insertion - 1].text.trim()) insertion -= 1;
  if (insertion > 0 && records[insertion - 1].eol === "") records[insertion - 1].eol = eol || "\n";
  records.splice(insertion, 0, { text: directFieldLine(bounds, field, value), eol, start: -1, end: -1 });
  bounds.end += 1;
}

function appendTaskDetail(records, bounds, text, eol, extraIndent = "") {
  let insertion = bounds.end;
  while (insertion > bounds.start + 1 && !records[insertion - 1].text.trim()) insertion -= 1;
  if (insertion > 0 && records[insertion - 1].eol === "") records[insertion - 1].eol = eol || "\n";
  records.splice(insertion, 0, {
    text: `${bounds.baseIndent}  ${extraIndent}- ${text}`,
    eol,
    start: -1,
    end: -1,
  });
  bounds.end += 1;
}

function renderReceipt(context, outcome, now, proposalDigest) {
  const receipt = {
    schemaVersion: 1,
    runId: context.runId,
    attemptNo: context.attemptNo,
    effectId: context.effectId,
    outcome: outcome.status,
    proposalDigest,
    writtenAt: now.toISOString(),
  };
  if (context.verifiedEvidence.length) receipt.evidence = context.verifiedEvidence;
  if (outcome.nextReviewAt) receipt.nextReviewAt = outcome.nextReviewAt;
  return receipt;
}

function patchSelfScheduleInTaskBlock(records, bounds, outcome) {
  if (!outcome.nextReviewAt) return;
  const matches = [];
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const match = records[index].text.match(/^(\s*-\s*自动推进\s*[：:]\s*)(\{.*\})(\s*)$/u);
    if (match) matches.push({ index, match });
  }
  fail(matches.length === 1, "自排复验要求任务块只有一份自动推进契约", "AUTOMATION_CONTRACT_CONFLICT");
  let raw;
  try { raw = JSON.parse(matches[0].match[2]); }
  catch { throw new AgentTaskWritebackError("自动推进契约 JSON 无法解析", "AUTOMATION_CONTRACT_INVALID"); }
  const parsed = parseAgentTaskContract([`自动推进：${JSON.stringify(raw)}`]);
  fail(parsed.valid && parsed.contract.selfScheduleReview === true
    && parsed.contract.triggers.length === 1
    && parsed.contract.triggers[0].type === "time",
  "v1 自排复验只支持已授权的唯一时间触发", "SELF_SCHEDULE_REVIEW_UNSUPPORTED");
  raw.triggers[0].at = outcome.nextReviewAt;
  records[matches[0].index].text = `${matches[0].match[1]}${JSON.stringify(raw)}${matches[0].match[3]}`;
}

function patchTaskBlock(content, context, outcome, now, proposalDigest) {
  const records = splitLineRecords(content);
  const { candidates } = findTaskLine(content, { sourcePath: context.sourcePath, id: context.taskId });
  fail(candidates.length === 1, candidates.length ? "任务 ID 在来源原件中重复" : "来源原件中找不到任务 ID",
    candidates.length ? "TASK_ID_DUPLICATE" : "TASK_NOT_FOUND");
  const candidate = candidates[0];
  const bounds = taskBlockBounds(records, candidate.index);
  const existingReceipt = findExistingReceipt(records, bounds, context, proposalDigest);
  if (existingReceipt) return { alreadyWritten: true, receipt: existingReceipt, content };
  fail(candidate.task.idKind === "explicit", "自动写回只接受显式稳定任务 ID", "TASK_ID_INVALID");
  fail(!candidate.task.done, "任务已由其它写入完成，拒绝覆盖", "TASK_NOT_OPEN");
  fail(candidate.task.executorId === context.executorId, "任务执行岗位与当前运行不一致", "TASK_EXECUTOR_MISMATCH");
  const details = taskDetailsForFingerprint(records, candidate.index, bounds.end);
  fail(taskSnapshotFingerprint({ ...candidate.task, details }) === context.taskFingerprint,
    "任务施工输入已变化，拒绝使用旧运行结果", "TASK_FINGERPRINT_CONFLICT");

  const match = candidate.match;
  let taskText = match[4];
  if (outcome.status === "completed") taskText = withMetadata(taskText, "完成时间", now.toISOString());
  if (outcome.nextReviewAt) taskText = withMetadata(taskText, "复验时间", tokyoParts(new Date(outcome.nextReviewAt)).minute);
  records[candidate.index].text = `${match[1]}${outcome.status === "completed" ? "x" : match[2]}${match[3]}${taskText}`;
  patchSelfScheduleInTaskBlock(records, bounds, outcome);

  const { day, minute } = tokyoParts(now);
  const statePrefix = {
    completed: "已完成",
    blocked: "阻塞",
    failed: "本轮失败",
    progress: "进行中",
  }[outcome.status];
  upsertDirectField(records, bounds, "进展时间", minute, records[candidate.index].eol || "\n");
  upsertDirectField(records, bounds, "当前状态", `${statePrefix}：${outcome.summary}`, records[candidate.index].eol || "\n");
  upsertDirectField(records, bounds, "下一步", outcome.nextStep || "无需后续动作；本任务完成门已满足。", records[candidate.index].eol || "\n");

  const resultWord = { completed: "通过", blocked: "受阻", failed: "失败", progress: "进行中" }[outcome.status];
  appendTaskDetail(records, bounds, `${day} ${RESULT_LABEL}：${resultWord}｜${outcome.summary}`, records[candidate.index].eol || "\n");
  if (outcome.evidenceRefs.length) {
    appendTaskDetail(records, bounds, `证据：${outcome.evidenceRefs.join("；")}`, records[candidate.index].eol || "\n", "  ");
  }
  const receipt = renderReceipt(context, outcome, now, proposalDigest);
  appendTaskDetail(records, bounds, `${RECEIPT_LABEL}：\`${JSON.stringify(receipt)}\``, records[candidate.index].eol || "\n");

  return { alreadyWritten: false, receipt, content: records.map((record) => `${record.text}${record.eol}`).join("") };
}

async function resolveSource(vaultRoot, sourcePath) {
  const root = await fs.realpath(path.resolve(vaultRoot));
  const absolute = path.resolve(root, ...sourcePath.split("/"));
  fail(absolute.startsWith(`${root}${path.sep}`), "来源路径越过 Vault", "SOURCE_PATH_INVALID");
  let real;
  try { real = await fs.realpath(absolute); }
  catch (error) {
    if (error?.code === "ENOENT") throw new AgentTaskWritebackError("来源原件不存在", "SOURCE_MISSING");
    throw error;
  }
  fail(real === absolute && real.startsWith(`${root}${path.sep}`), "来源原件不能通过符号链接越界", "SOURCE_PATH_FORBIDDEN");
  return absolute;
}

async function atomicWriteAfterHashCheck(absolute, content, expectedHash, mode) {
  const temporary = `${absolute}.agent-writeback-${process.pid}-${crypto.randomUUID()}.tmp`;
  let temporaryHandle;
  try {
    temporaryHandle = await fs.open(temporary, "wx", mode & 0o777);
    await temporaryHandle.writeFile(content, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    const fresh = await fs.readFile(absolute);
    fail(sourceContentHash(fresh) === expectedHash, "写入前原件发生并行变化，本次已停止", "SOURCE_CONFLICT");
    await fs.rename(temporary, absolute);
    const directoryHandle = await fs.open(path.dirname(absolute), "r");
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function scheduleReviewIfRequested(ledger, context, outcome) {
  if (!outcome.nextReviewAt) return null;
  fail(typeof ledger.scheduleReview === "function", "运行账适配器不支持自排复验", "LEDGER_ADAPTER_INVALID");
  return ledger.scheduleReview({
    runId: context.runId,
    attemptNo: context.attemptNo,
    taskId: context.taskId,
    sourcePath: context.sourcePath,
    executorId: context.executorId,
    eligibilityRevision: context.eligibilityRevision,
    effectId: selfScheduleReviewEffectId(context),
    nextReviewAt: outcome.nextReviewAt,
  });
}

async function prepareReviewIfRequested(ledger, context, outcome) {
  if (!outcome.nextReviewAt) return null;
  fail(typeof ledger.prepareReview === "function", "运行账适配器不支持预备自排复验", "LEDGER_ADAPTER_INVALID");
  return ledger.prepareReview({
    runId: context.runId,
    attemptNo: context.attemptNo,
    taskId: context.taskId,
    sourcePath: context.sourcePath,
    executorId: context.executorId,
    eligibilityRevision: context.eligibilityRevision,
    effectId: selfScheduleReviewEffectId(context),
    nextReviewAt: outcome.nextReviewAt,
  });
}

async function releaseOmittedReviewIfNeeded(ledger, context, outcome) {
  if (outcome.nextReviewAt) return null;
  fail(typeof ledger.releaseOmittedReview === "function", "运行账适配器不支持遗留自排复验收口", "LEDGER_ADAPTER_INVALID");
  return ledger.releaseOmittedReview({
    runId: context.runId,
    attemptNo: context.attemptNo,
    taskId: context.taskId,
    sourcePath: context.sourcePath,
    executorId: context.executorId,
    eligibilityRevision: context.eligibilityRevision,
    effectId: selfScheduleReviewEffectId(context),
  });
}

function assertAuthorizedOutcome(context, outcome) {
  const required = AGENT_TASK_EFFECTS[outcome.status];
  fail(context.authorizedEffects.includes(required), `当前运行未授权效果 ${required}`, "EFFECT_NOT_AUTHORIZED");
  if (outcome.nextReviewAt) {
    fail(context.authorizedEffects.includes(AGENT_TASK_EFFECTS.selfScheduleReview),
      "当前运行没有 selfScheduleReview 授权", "SELF_SCHEDULE_REVIEW_FORBIDDEN");
  }
}

/**
 * Ledger adapter contract:
 * - assertRunContext(context) -> true or the canonical context
 * - runIdempotentEffect(meta, apply) -> { duplicate, receipt }
 * - withSourceMutation(apply) serializes cooperating writers for one source file
 * - prepareReview(meta) persists the expected self-schedule effect before source mutation
 * - releaseOmittedReview(meta) negatively reconciles an older prepared schedule
 * - scheduleReview(meta) when self-scheduling is authorized and requested
 * - hasCommittedEffect({ runId, effectId }) and recordProcessExit(event) for exit settlement
 */
export async function writeBackAgentTaskResult({ vaultRoot, proposalPath, coordinatorContext, ledger, now = new Date() }) {
  fail(now instanceof Date && !Number.isNaN(now.getTime()), "写回时间无效", "WRITEBACK_TIME_INVALID");
  const context = await assertTrustedRunContext(ledger, coordinatorContext);
  fail(typeof ledger.runIdempotentEffect === "function", "运行账适配器缺少 runIdempotentEffect", "LEDGER_ADAPTER_INVALID");
  fail(typeof ledger.withSourceMutation === "function", "运行账适配器缺少原件单写者门", "LEDGER_ADAPTER_INVALID");
  const proposal = await readResultProposal(proposalPath);
  const outcome = validateProposalShape(proposal, context, now);
  assertAuthorizedOutcome(context, outcome);
  const proposalDigest = sha256(JSON.stringify({ outcome, evidence: context.verifiedEvidence }));
  const absolute = await resolveSource(vaultRoot, context.sourcePath);
  const effect = {
    runId: context.runId,
    attemptNo: context.attemptNo,
    effectId: context.effectId,
    kind: "task.writeback",
    taskId: context.taskId,
    sourcePath: context.sourcePath,
    executorId: context.executorId,
    eligibilityRevision: context.eligibilityRevision,
    proposalDigest,
    proposalOutcome: outcome,
  };

  // A retry that no longer requests self-scheduling must not leave an older
  // prepared secondary effect permanently blocking settlement.
  await releaseOmittedReviewIfNeeded(ledger, context, outcome);

  // Persist the secondary-effect manifest before the atomic source mutation.
  // A crash can then be reconciled from the source without losing nextReviewAt.
  await prepareReviewIfRequested(ledger, context, outcome);

  const result = await ledger.runIdempotentEffect(effect, async () => {
    const original = await fs.readFile(absolute);
    const originalText = original.toString("utf8");
    const recovery = patchTaskBlock(originalText, context, outcome, now, proposalDigest);
    if (recovery.alreadyWritten) {
      return {
        ...recovery.receipt,
        recovered: true,
        sourceHash: sourceContentHash(original),
        sourcePath: context.sourcePath,
        taskId: context.taskId,
      };
    }
    fail(sourceContentHash(original) === context.expectedSourceHash,
      "来源原件与协调器认领时的哈希不一致", "SOURCE_CONFLICT");
    await ledger.withSourceMutation(async () => {
      const stat = await fs.stat(absolute);
      await atomicWriteAfterHashCheck(
        absolute,
        recovery.content,
        context.expectedSourceHash,
        stat.mode,
      );
    });
    const readback = await fs.readFile(absolute);
    const readbackText = readback.toString("utf8");
    const readbackRecords = splitLineRecords(readbackText);
    const readbackCandidate = findTaskLine(readbackText, { sourcePath: context.sourcePath, id: context.taskId }).candidates;
    fail(readbackCandidate.length === 1, "写回后无法唯一回读任务", "WRITEBACK_READBACK_FAILED");
    const readbackBounds = taskBlockBounds(readbackRecords, readbackCandidate[0].index);
    fail(Boolean(findExistingReceipt(readbackRecords, readbackBounds, context, proposalDigest)),
      "写回后无法回读结构化回执", "WRITEBACK_READBACK_FAILED");
    return {
      ...recovery.receipt,
      recovered: false,
      sourceHash: sourceContentHash(readback),
      sourcePath: context.sourcePath,
      taskId: context.taskId,
    };
  });

  // 自排复验是与主任务写回分开的正式效果。主效果先落账，再尝试排期；
  // 这样即使调度写入中断，下一 attempt 也能在去重主写回后单独恢复它。
  await scheduleReviewIfRequested(ledger, context, outcome);

  if (result && typeof result === "object" && Object.hasOwn(result, "receipt")) {
    return { ok: true, duplicate: Boolean(result.duplicate), receipt: result.receipt };
  }
  return { ok: true, duplicate: false, receipt: result };
}

export async function recordProcessExit({ coordinatorContext, ledger, exitCode, signal = null, errorCode = null, now = new Date() }) {
  fail(now instanceof Date && !Number.isNaN(now.getTime()), "结束时间无效", "WRITEBACK_TIME_INVALID");
  // 进程可能在平台给出可信启动回执前就失败。结束收口因此只校验
  // 协调器密封的上下文形状，再由 ledger.recordProcessExit 核对当前租约、
  // 岗位与尝试号。正式业务写回仍必须通过 assertTrustedRunContext。
  const context = validateRunContextShape(coordinatorContext);
  fail(Number.isInteger(exitCode) || exitCode == null, "exitCode 格式不正确", "PROCESS_EXIT_INVALID");
  fail(typeof ledger.hasCommittedEffect === "function" && typeof ledger.recordProcessExit === "function",
    "运行账适配器缺少退出收口接口", "LEDGER_ADAPTER_INVALID");
  const trustedWriteback = Boolean(await ledger.hasCommittedEffect({ runId: context.runId, effectId: context.effectId }));
  const successfulExit = exitCode === 0 && signal == null && errorCode == null;
  const phase = successfulExit
    ? trustedWriteback ? "settled" : "incomplete"
    : trustedWriteback ? "process-failed-after-writeback" : "process-failed";
  const event = Object.freeze({
    runId: context.runId,
    attemptNo: context.attemptNo,
    taskId: context.taskId,
    sourcePath: context.sourcePath,
    executorId: context.executorId,
    effectId: context.effectId,
    exitCode,
    signal: signal == null ? null : normalizeSingleLine(String(signal), "signal", 80),
    errorCode: errorCode == null ? null : normalizeSingleLine(String(errorCode), "errorCode", 120),
    trustedWriteback,
    phase,
    finishedAt: now.toISOString(),
  });
  await ledger.recordProcessExit(event);
  return event;
}
