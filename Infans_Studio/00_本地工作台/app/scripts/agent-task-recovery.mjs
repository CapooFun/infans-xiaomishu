import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  parseAgentTaskContract,
  validateVaultEvidencePath,
} from "../src/server/workbench-agent-task-contract.mjs";
import { findTaskLine } from "../src/server/workbench-project-management.mjs";
import {
  RuntimeLedgerError,
  readRuntimeLedger,
  recoverExpiredRuntimeRun,
  stableEffectId,
  validateRuntimeLedgerState,
} from "./agent-task-runtime-ledger.mjs";

const HASH_RE = /^[a-f0-9]{64}$/u;
const RECEIPT_RE = /^\s*-\s+自动回执\s*[：:]\s*`(\{.*\})`\s*$/u;
const RECEIPT_OUTCOMES = new Set(["completed", "blocked", "failed", "progress"]);
const MAX_RECEIPT_EVIDENCE = 24;
const TASK_WRITEBACK_EFFECT = "task.writeback";
const SELF_SCHEDULE_EFFECT = "task.selfScheduleReview";
const FORBIDDEN_SOURCE_SEGMENTS = new Set([".git", "node_modules", "案头", "本人草稿"]);

export class AgentTaskRecoveryError extends Error {
  constructor(message, code = "AGENT_TASK_RECOVERY_INVALID", details = {}) {
    super(message);
    this.name = "AgentTaskRecoveryError";
    this.code = code;
    this.details = details;
  }
}

function fail(condition, message, code, details) {
  if (!condition) throw new AgentTaskRecoveryError(message, code, details);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizedNow(value) {
  const date = value instanceof Date ? value : new Date(value);
  fail(Number.isFinite(date.getTime()), "恢复扫描时间无效", "RECOVERY_TIME_INVALID");
  return date;
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
  return { start: taskIndex, end };
}

function taskDetails(lines, bounds) {
  return lines.slice(bounds.start + 1, bounds.end)
    .filter((line) => /^\s+-\s+/u.test(line))
    .map((line) => line.replace(/^\s*-\s*/u, "").trim());
}

function normalizeSourcePath(value) {
  fail(typeof value === "string" && value.length > 0 && value.trim() === value,
    "恢复来源路径为空", "RECOVERY_SOURCE_PATH_INVALID");
  fail(!path.posix.isAbsolute(value) && !value.includes("\\") && !value.includes("\0"),
    "恢复来源必须是 Vault 相对路径", "RECOVERY_SOURCE_PATH_INVALID");
  const normalized = path.posix.normalize(value);
  fail(normalized === value && normalized !== "." && !normalized.startsWith("../") && normalized.endsWith(".md"),
    "恢复来源路径越界或不是 Markdown", "RECOVERY_SOURCE_PATH_INVALID");
  fail(!normalized.split("/").some((segment) => FORBIDDEN_SOURCE_SEGMENTS.has(segment)),
    "恢复来源命中禁止目录", "RECOVERY_SOURCE_PATH_FORBIDDEN");
  return normalized;
}

function normalizeReceiptEvidence(value, sourcePath) {
  if (value === undefined) return [];
  fail(Array.isArray(value) && value.length <= MAX_RECEIPT_EVIDENCE,
    "自动回执 evidence 必须是有界数组", "SOURCE_RECEIPT_INVALID");
  const seen = new Set();
  return value.map((item) => {
    fail(item && typeof item === "object" && !Array.isArray(item)
      && JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["path", "sha256"]),
    "自动回执 evidence 只能包含 path 与 sha256", "SOURCE_RECEIPT_INVALID");
    const checked = validateVaultEvidencePath(item.path);
    fail(checked.valid && checked.path === item.path && checked.path !== sourcePath,
    "自动回执 evidence.path 越界、自指或命中禁止目录", "SOURCE_RECEIPT_INVALID");
    fail(typeof item.sha256 === "string" && HASH_RE.test(item.sha256),
      "自动回执 evidence.sha256 无效", "SOURCE_RECEIPT_INVALID");
    fail(!seen.has(checked.path), "自动回执 evidence.path 重复", "SOURCE_RECEIPT_INVALID");
    seen.add(checked.path);
    return { path: checked.path, sha256: item.sha256 };
  });
}

function sourcePathFromEffect(effect, taskId) {
  if (!effect || !new Set([TASK_WRITEBACK_EFFECT, SELF_SCHEDULE_EFFECT]).has(effect.effectType)) return null;
  const suffix = `#${taskId}`;
  fail(typeof effect.target === "string" && effect.target.endsWith(suffix),
    "运行效果目标与 taskId 不一致", "RECOVERY_EFFECT_TARGET_MISMATCH", { effectId: effect.effectId });
  const sourcePath = normalizeSourcePath(effect.target.slice(0, -suffix.length));
  fail(stableEffectId(effect.effectType, `${sourcePath}${suffix}`) === effect.effectId,
    "运行效果不是稳定 effectId", "RECOVERY_EFFECT_ID_MISMATCH", { effectId: effect.effectId });
  return sourcePath;
}

function recoverySourcePath(run) {
  const paths = [...new Set(Object.values(run.effects || {})
    .map((effect) => sourcePathFromEffect(effect, run.eligibilityKey.taskId))
    .filter(Boolean))];
  fail(paths.length <= 1, "同一运行的任务效果指向多个来源原件", "RECOVERY_SOURCE_CONFLICT", { paths });
  return paths[0] || null;
}

function normalizeReceipt(raw, { run, mainEffectId, sourcePath }) {
  fail(raw && typeof raw === "object" && !Array.isArray(raw), "自动回执不是对象", "SOURCE_RECEIPT_INVALID");
  const allowed = new Set([
    "schemaVersion", "runId", "attemptNo", "effectId", "outcome", "proposalDigest", "writtenAt", "nextReviewAt", "evidence",
  ]);
  fail(Object.keys(raw).every((key) => allowed.has(key)), "自动回执含非白名单字段", "SOURCE_RECEIPT_INVALID");
  fail(raw.schemaVersion === 1 && raw.runId === run.runId && raw.effectId === mainEffectId,
    "自动回执与运行效果不一致", "SOURCE_RECEIPT_MISMATCH");
  fail(Number.isSafeInteger(raw.attemptNo) && raw.attemptNo > 0 && raw.attemptNo <= run.currentAttemptNo,
    "自动回执 attemptNo 无效", "SOURCE_RECEIPT_INVALID");
  fail(RECEIPT_OUTCOMES.has(raw.outcome), "自动回执 outcome 无效", "SOURCE_RECEIPT_INVALID");
  fail(typeof raw.proposalDigest === "string" && HASH_RE.test(raw.proposalDigest),
    "自动回执缺少 proposalDigest", "SOURCE_RECEIPT_INVALID");
  const writtenAt = new Date(raw.writtenAt);
  fail(typeof raw.writtenAt === "string" && Number.isFinite(writtenAt.getTime()),
    "自动回执 writtenAt 无效", "SOURCE_RECEIPT_INVALID");
  let nextReviewAt = null;
  if (raw.nextReviewAt !== undefined) {
    const parsed = new Date(raw.nextReviewAt);
    fail(typeof raw.nextReviewAt === "string" && Number.isFinite(parsed.getTime()),
      "自动回执 nextReviewAt 无效", "SOURCE_RECEIPT_INVALID");
    nextReviewAt = parsed.toISOString();
  }
  const evidence = normalizeReceiptEvidence(raw.evidence, sourcePath);
  fail(raw.outcome !== "completed" || evidence.length > 0,
    "completed 自动回执必须包含已核验证据", "SOURCE_RECEIPT_INVALID");
  fail(!(raw.outcome === "completed" && nextReviewAt),
    "completed 自动回执不能同时自排本任务复验", "SOURCE_RECEIPT_INVALID");
  return Object.freeze({
    schemaVersion: 1,
    runId: raw.runId,
    attemptNo: raw.attemptNo,
    effectId: raw.effectId,
    outcome: raw.outcome,
    proposalDigest: raw.proposalDigest,
    writtenAt: writtenAt.toISOString(),
    ...(nextReviewAt ? { nextReviewAt } : {}),
  });
}

async function resolveSource(vaultRoot, sourcePath) {
  const root = await fs.realpath(path.resolve(vaultRoot));
  const absolute = path.resolve(root, ...sourcePath.split("/"));
  fail(absolute.startsWith(`${root}${path.sep}`), "恢复来源越过 Vault", "RECOVERY_SOURCE_PATH_INVALID");
  let real;
  try {
    real = await fs.realpath(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  fail(real === absolute && real.startsWith(`${root}${path.sep}`),
    "恢复来源不能通过符号链接越界", "RECOVERY_SOURCE_PATH_FORBIDDEN");
  return absolute;
}

function positiveEffect(effect, sourceAttemptNo, sourcePath, taskId, contentHash, recoveryMode = undefined, intentDigest = undefined) {
  return {
    effectType: effect.effectType,
    target: `${sourcePath}#${taskId}`,
    effectId: effect.effectId,
    sourceAttemptNo,
    reconciliationEvidence: {
      kind: "authoritative-readback",
      sourceRevision: `sha256:${contentHash}`,
      digest: contentHash,
    },
    ...(recoveryMode ? { recoveryMode } : {}),
    ...(intentDigest ? { intentDigest } : {}),
  };
}

function reviewIntentDigest(nextReviewAt) {
  return sha256(JSON.stringify({ nextReviewAt }));
}

export function enumerateExpiredRuntimeRuns(ledger, now = new Date()) {
  validateRuntimeLedgerState(ledger);
  const at = normalizedNow(now);
  return Object.values(ledger.runs)
    .filter((run) => run.status !== "settled" && run.lease && Date.parse(run.lease.expiresAt) <= at.getTime())
    .map((run) => Object.freeze({
      runId: run.runId,
      attemptNo: run.currentAttemptNo,
      taskId: run.eligibilityKey.taskId,
      executorRoleId: run.eligibilityKey.executorRoleId,
      leaseExpiresAt: run.lease.expiresAt,
      effectIds: Object.keys(run.effects).sort(),
    }))
    .sort((left, right) => left.leaseExpiresAt.localeCompare(right.leaseExpiresAt) || left.runId.localeCompare(right.runId));
}

export function enumerateRecoverableRuntimeRuns(ledger, now = new Date()) {
  validateRuntimeLedgerState(ledger);
  const at = normalizedNow(now);
  const endedLinks = new Set(ledger.executionLinkEvents
    .filter((event) => event.eventType === "end")
    .map((event) => event.linkEventId));
  const writebackEvents = new Set(ledger.executionLinkEvents
    .filter((event) => event.eventType === "writeback")
    .map((event) => `${event.runId}:${event.attemptNo}:${event.effectId}`));
  const candidates = [];
  for (const run of Object.values(ledger.runs)) {
    const reasons = [];
    const expired = run.status !== "settled" && run.lease && Date.parse(run.lease.expiresAt) <= at.getTime();
    if (expired) reasons.push("EXPIRED_LEASE");
    if (run.status === "settled") {
      const currentAttempt = run.attempts[run.currentAttemptNo - 1];
      const effects = Object.values(run.effects).filter((effect) => !effect.retiredAt);
      if (effects.some((effect) => effect.preparedAt)) reasons.push("PREPARED_EFFECT_PENDING");
      if (effects.some((effect) => effect.appliedAt && !effect.verifiedAt)) reasons.push("EFFECT_READBACK_PENDING");
      if (effects.some((effect) => effect.appliedAt && effect.verifiedAt)
        && (currentAttempt.writebackOutcome?.status !== "succeeded" || currentAttempt.readbackOutcome?.status !== "succeeded")) {
        reasons.push("SETTLEMENT_SUMMARY_STALE");
      }
      for (const effect of effects.filter((item) => item.effectType === TASK_WRITEBACK_EFFECT && item.appliedAt)) {
        const receipt = effect.receipts.find((item) => item.writebackOutcome.status === "succeeded");
        if (receipt && !writebackEvents.has(`${run.runId}:${receipt.attemptNo}:${effect.effectId}`)) {
          reasons.push("WRITEBACK_EVENT_MISSING");
        }
      }
      for (const attempt of run.attempts.filter((item) => item.startEvidence)) {
        const links = ledger.executionLinkEvents.filter((event) => event.eventType === "link"
          && event.runId === run.runId && event.attemptNo === attempt.attemptNo);
        if (!links.length) reasons.push("EXECUTION_LINK_MISSING");
        else if (links.some((link) => !endedLinks.has(link.eventId))) reasons.push("EXECUTION_END_MISSING");
      }
    }
    if (!reasons.length) continue;
    candidates.push(Object.freeze({
      runId: run.runId,
      attemptNo: run.currentAttemptNo,
      taskId: run.eligibilityKey.taskId,
      executorRoleId: run.eligibilityKey.executorRoleId,
      status: run.status,
      leaseExpiresAt: run.lease?.expiresAt || null,
      effectIds: Object.keys(run.effects).sort(),
      reasons: [...new Set(reasons)].sort(),
    }));
  }
  return candidates.sort((left, right) => String(left.leaseExpiresAt || "").localeCompare(String(right.leaseExpiresAt || ""))
    || left.runId.localeCompare(right.runId));
}

/**
 * Read one Vault task original and derive only authoritative ledger evidence.
 * This function never evaluates present eligibility and never writes the source.
 */
export async function inspectExpiredRunSource({ vaultRoot, run }) {
  validateRuntimeLedgerState({
    schemaVersion: 2,
    revision: 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    runs: { [run.runId]: run },
    eligibilityIndex: { [run.eligibilityKeyHash]: run.runId },
    executionLinkEvents: [],
  });
  const taskId = run.eligibilityKey.taskId;
  const sourcePath = recoverySourcePath(run);
  if (!sourcePath) return {
    sourcePath: null,
    sourceHash: null,
    receipt: null,
    recoveredEffects: [],
    requiredEffects: [],
    issues: ["RECOVERY_SOURCE_UNKNOWN"],
  };
  const absolute = await resolveSource(vaultRoot, sourcePath);
  const mainEffectId = stableEffectId(TASK_WRITEBACK_EFFECT, `${sourcePath}#${taskId}`);
  const mainIdentity = { effectType: TASK_WRITEBACK_EFFECT, target: `${sourcePath}#${taskId}`, effectId: mainEffectId };
  if (!absolute) return {
    sourcePath,
    sourceHash: null,
    receipt: null,
    recoveredEffects: [],
    requiredEffects: [mainIdentity],
    issues: ["RECOVERY_SOURCE_MISSING"],
  };

  const source = await fs.readFile(absolute);
  const content = source.toString("utf8");
  const contentHash = sha256(source);
  const lines = content.split(/\r?\n/u);
  const { candidates } = findTaskLine(content, { sourcePath, id: taskId });
  if (candidates.length !== 1) {
    return {
      sourcePath,
      sourceHash: contentHash,
      receipt: null,
      recoveredEffects: [],
      requiredEffects: [mainIdentity],
      issues: [candidates.length ? "RECOVERY_TASK_DUPLICATE" : "RECOVERY_TASK_MISSING"],
    };
  }
  const candidate = candidates[0];
  const bounds = taskBlockBounds(lines, candidate.index);
  const mainEffect = run.effects[mainEffectId] || null;
  const rawMatches = [];
  let malformedMatchingReceipt = false;
  let mismatchedCurrentReceipt = false;
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const match = lines[index].match(RECEIPT_RE);
    if (!match) continue;
    try {
      const raw = JSON.parse(match[1]);
      if (raw?.runId === run.runId && raw?.effectId === mainEffectId) rawMatches.push(raw);
      else if (raw?.runId === run.runId) mismatchedCurrentReceipt = true;
    } catch {
      if (match[1].includes(run.runId)) malformedMatchingReceipt = true;
    }
  }
  const issues = [];
  if (malformedMatchingReceipt) issues.push("SOURCE_RECEIPT_INVALID");
  if (mismatchedCurrentReceipt) issues.push("SOURCE_RECEIPT_EFFECT_MISMATCH");
  if (rawMatches.length > 1) issues.push("SOURCE_RECEIPT_DUPLICATE");
  let receipt = null;
  let receiptStateValid = true;
  if (rawMatches.length === 1 && !malformedMatchingReceipt) {
    try {
      receipt = normalizeReceipt(rawMatches[0], { run, mainEffectId, sourcePath });
      if (receipt.outcome === "completed" && !candidate.task.done) {
        receiptStateValid = false;
        issues.push("SOURCE_RECEIPT_STATE_MISMATCH");
      }
    } catch (error) {
      receipt = null;
      issues.push(error.code || "SOURCE_RECEIPT_INVALID");
    }
  } else if (!rawMatches.length && !malformedMatchingReceipt) {
    issues.push("SOURCE_RECEIPT_MISSING");
  }

  if (receipt && receiptStateValid) {
    if (!mainEffect) {
      receiptStateValid = false;
      issues.push("RUNTIME_MAIN_EFFECT_MISSING");
    } else if (!mainEffect.intentDigest) {
      receiptStateValid = false;
      issues.push("EFFECT_INTENT_UNBOUND");
    } else if (receipt.proposalDigest !== mainEffect.intentDigest) {
      receiptStateValid = false;
      issues.push("SOURCE_RECEIPT_DIGEST_CONFLICT");
    }
    if (receiptStateValid && (mainEffect.appliedAt || mainEffect.verifiedAt)) {
      const successfulAttempts = new Set((mainEffect.receipts || [])
        .filter((item) => item?.writebackOutcome?.status === "succeeded")
        .map((item) => item.attemptNo));
      if (!successfulAttempts.has(receipt.attemptNo)) {
        receiptStateValid = false;
        issues.push("SOURCE_RECEIPT_ATTEMPT_MISMATCH");
      }
    }
  }

  const recoveredEffects = [];
  const requiredEffects = [mainIdentity];
  if (receipt && receiptStateValid && mainEffect && !mainEffect.verifiedAt) {
    if (!mainEffect.appliedAt && mainEffect.preparedAttemptNo !== receipt.attemptNo) {
      issues.push("SOURCE_RECEIPT_ATTEMPT_MISMATCH");
    } else {
      recoveredEffects.push(positiveEffect(mainEffect, receipt.attemptNo, sourcePath, taskId, contentHash, undefined, receipt.proposalDigest));
    }
  }

  const scheduleEffectId = stableEffectId(SELF_SCHEDULE_EFFECT, `${sourcePath}#${taskId}`);
  const scheduleEffect = run.effects[scheduleEffectId]?.retiredAt ? null : run.effects[scheduleEffectId] || null;
  if (receiptStateValid && receipt?.nextReviewAt) requiredEffects.push({
    effectType: SELF_SCHEDULE_EFFECT,
    target: `${sourcePath}#${taskId}`,
    effectId: scheduleEffectId,
  });
  if ((scheduleEffect && !scheduleEffect.verifiedAt) || (receiptStateValid && receipt?.nextReviewAt)) {
    if (!receiptStateValid || !receipt?.nextReviewAt) {
      issues.push("SCHEDULE_RECEIPT_MISSING");
    } else {
      const parsedContract = parseAgentTaskContract(taskDetails(lines, bounds));
      const trustedScheduleContract = parsedContract.valid
        && parsedContract.contract.mode === "automatic"
        && parsedContract.contract.selfScheduleReview === true
        && parsedContract.contract.triggers.length === 1;
      const matchingTriggers = trustedScheduleContract
        ? parsedContract.contract.triggers.filter((trigger) => trigger.id === run.eligibilityKey.triggerId)
        : [];
      const trigger = matchingTriggers.length === 1 ? matchingTriggers[0] : null;
      const triggerMatches = trigger?.type === "time" && trigger.at === receipt.nextReviewAt;
      const taskTimeMatches = candidate.task.reviewAt === receipt.nextReviewAt;
      if (!triggerMatches || !taskTimeMatches) {
        issues.push(triggerMatches !== taskTimeMatches ? "SCHEDULE_PARTIAL_SOURCE_STATE" : "SCHEDULE_SOURCE_MISMATCH");
      } else if (scheduleEffect && !scheduleEffect.appliedAt && scheduleEffect.preparedAttemptNo !== receipt.attemptNo) {
        issues.push("SCHEDULE_ATTEMPT_MISMATCH");
      } else {
        recoveredEffects.push(positiveEffect(
          scheduleEffect || {
            effectType: SELF_SCHEDULE_EFFECT,
            effectId: scheduleEffectId,
          },
          receipt.attemptNo,
          sourcePath,
          taskId,
          contentHash,
          scheduleEffect ? undefined : "authoritative-dual-source",
          reviewIntentDigest(receipt.nextReviewAt),
        ));
      }
    }
  }

  return {
    sourcePath,
    sourceHash: contentHash,
    receipt: receipt ? {
      runId: receipt.runId,
      attemptNo: receipt.attemptNo,
      effectId: receipt.effectId,
      outcome: receipt.outcome,
      proposalDigest: receipt.proposalDigest,
      nextReviewAt: receipt.nextReviewAt || null,
    } : null,
    recoveredEffects,
    requiredEffects,
    issues: [...new Set(issues)].sort(),
  };
}

/**
 * Zero-model crash recovery pass. It scans the runtime ledger first and never
 * asks the current task/contract whether the old run is still eligible.
 */
export async function recoverExpiredAgentTaskRuns({
  vaultRoot,
  ledgerPath,
  now = new Date(),
  ledgerOptions = {},
}) {
  fail(typeof vaultRoot === "string" && path.isAbsolute(vaultRoot),
    "vaultRoot 必须是绝对路径", "RECOVERY_ROOT_INVALID");
  fail(typeof ledgerPath === "string" && path.isAbsolute(ledgerPath),
    "ledgerPath 必须是绝对路径", "RECOVERY_LEDGER_PATH_INVALID");
  const at = normalizedNow(now);
  const options = { ...ledgerOptions, clock: () => at };
  const initial = await readRuntimeLedger(ledgerPath, options);
  const candidates = enumerateRecoverableRuntimeRuns(initial, at);
  const recovered = [];
  const skipped = [];

  for (const candidate of candidates) {
    const run = initial.runs[candidate.runId];
    let source;
    try {
      source = await inspectExpiredRunSource({ vaultRoot, run });
    } catch (error) {
      source = {
        sourcePath: null,
        sourceHash: null,
        receipt: null,
        recoveredEffects: [],
        requiredEffects: [],
        issues: [error.code || "RECOVERY_SOURCE_READ_FAILED"],
      };
    }
    try {
      const result = await recoverExpiredRuntimeRun(ledgerPath, {
        runId: candidate.runId,
        attemptNo: candidate.attemptNo,
        recoveredEffects: source.recoveredEffects,
        requiredEffects: source.requiredEffects,
      }, options);
      recovered.push({
        ...result,
        taskId: candidate.taskId,
        sourcePath: source.sourcePath,
        proposalDigest: source.receipt?.proposalDigest || null,
        nextReviewAt: source.receipt?.nextReviewAt || null,
        sourceConsistent: source.issues.length === 0,
        issues: source.issues,
      });
    } catch (error) {
      const raced = error instanceof RuntimeLedgerError
        && new Set(["LEASE_ACTIVE", "ATTEMPT_NOT_CURRENT"]).has(error.code);
      skipped.push({
        runId: candidate.runId,
        attemptNo: candidate.attemptNo,
        taskId: candidate.taskId,
        code: error.code || "RECOVERY_FAILED",
        raced,
      });
    }
  }

  return {
    scannedRuns: Object.keys(initial.runs).length,
    recoverableRuns: candidates.length,
    expiredRuns: candidates.filter((candidate) => candidate.status !== "settled").length,
    recovered,
    skipped,
    modelsInvoked: 0,
    sourceWrites: 0,
  };
}
