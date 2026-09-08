import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const RUNTIME_LEDGER_SCHEMA_VERSION = 2;

const PROCESS_OUTCOMES = new Set(["succeeded", "failed", "timed-out", "cancelled", "not-started", "unknown"]);
const WRITEBACK_OUTCOMES = new Set(["succeeded", "partial", "failed", "not-required", "unknown"]);
const READBACK_OUTCOMES = new Set(["succeeded", "partial", "failed", "not-required", "unknown"]);
const START_EVIDENCE_KINDS = new Set(["platform-execution", "protocol-handshake", "structured-event"]);
const UNTRUSTED_START_SOURCES = new Set(["coordinator", "scheduler", "local-process", "process", "fallback-id"]);
const UNTRUSTED_EVENT_TYPES = /(?:queue|queued|enqueue|accepted|process[-_. ]?(?:created|spawned)|fallback)/iu;
const TRUSTED_START_SOURCES = new Set(["codex", "codex-app", "codex-cli", "cursor", "cursor-agent", "cursor-cli", "openai-api", "mcp-adapter"]);
const TRUSTED_PROTOCOLS = new Set(["codex-app", "codex-cli", "cursor-agent", "cursor-cli", "mcp", "responses-api"]);
const TRUSTED_STRUCTURED_EVENTS = new Set([
  "agent.started", "response.in_progress", "response.output_item", "run.started", "turn.started", "tool.call",
]);
export const RUNTIME_EFFECT_TYPES = Object.freeze([
  "task.writeback",
  "task.selfScheduleReview",
  "execution.link",
  "execution.writeback",
  "execution.end",
]);
const RUNTIME_EFFECT_TYPE_SET = new Set(RUNTIME_EFFECT_TYPES);
const SENSITIVE_TARGET_SEGMENT = /^(?:\.git|\.env(?:\..*)?|node_modules|案头|本人草稿|(?:credentials?|secrets?|tokens?|passwords?|密码|凭据)(?:\..*)?)$/iu;
export const RUNTIME_LEDGER_LIMITS = Object.freeze({
  maxBytes: 16 * 1_024 * 1_024,
  maxRuns: 5_000,
  maxAttemptsPerRun: 100,
  maxEffectsPerRun: 256,
  maxReceiptsPerEffect: 512,
  maxExecutionLinkEvents: 20_000,
});

export class RuntimeLedgerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeLedgerError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new RuntimeLedgerError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, name) {
  if (!isRecord(value)) fail("INVALID_ARGUMENT", `${name} 必须是对象`);
  return value;
}

function assertOnlyKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail("CORRUPT_LEDGER", `${name} 含非白名单字段`, { fields: unknown.sort() });
}

function singleLine(value, name, maximum = 512) {
  if (typeof value !== "string") fail("INVALID_ARGUMENT", `${name} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f\r\n]/u.test(normalized)) {
    fail("INVALID_ARGUMENT", `${name} 必须是有界单行文本`);
  }
  return normalized;
}

function machineCode(value, name, maximum = 128) {
  const normalized = singleLine(value, name, maximum);
  if (!/^[a-z0-9][a-z0-9._:@/+~-]*$/iu.test(normalized)) {
    fail("INVALID_ARGUMENT", `${name} 必须是稳定机器标识`);
  }
  return normalized;
}

function optionalMachineCode(value, name, maximum = 128) {
  return value === undefined || value === null || value === "" ? undefined : machineCode(value, name, maximum);
}

function normalizeTime(value, name = "时间") {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) fail("INVALID_ARGUMENT", `${name} 无效`);
  return date.toISOString();
}

function timeMs(value, name = "时间") {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail("CORRUPT_LEDGER", `${name} 无效`);
  return result;
}

function positiveDuration(value, name = "leaseDurationMs") {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 24 * 60 * 60 * 1_000) {
    fail("INVALID_ARGUMENT", `${name} 必须是 1 毫秒到 24 小时之间的整数`);
  }
  return value;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  fail("INVALID_ARGUMENT", "稳定身份只能包含 JSON 标量、数组和对象");
}

export function canonicalJson(value) {
  return JSON.stringify(stableJsonValue(value));
}

function digest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function optionalIntentDigest(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = singleLine(value, "intentDigest", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) fail("INVALID_ARGUMENT", "intentDigest 必须是 64 位 SHA-256");
  return normalized;
}

export function normalizeEligibilityKey(raw) {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      fail("INVALID_ARGUMENT", "eligibilityKey 字符串必须是五元组的 canonical JSON");
    }
  }
  assertRecord(raw, "eligibilityKey");
  const revision = typeof raw.eligibilityRevision === "number"
    ? String(raw.eligibilityRevision)
    : raw.eligibilityRevision;
  return Object.freeze({
    taskId: machineCode(raw.taskId, "taskId", 256),
    executorRoleId: machineCode(raw.executorRoleId, "executorRoleId", 128),
    eligibilityRevision: singleLine(revision, "eligibilityRevision", 256),
    triggerId: machineCode(raw.triggerId, "triggerId", 256),
    triggerCursor: singleLine(raw.triggerCursor, "triggerCursor", 1_024),
  });
}

export function eligibilityKeyHash(raw) {
  return digest(normalizeEligibilityKey(raw));
}

export function stableRunId(raw) {
  return `run_${eligibilityKeyHash(raw)}`;
}

export function normalizeEffectTarget(effectType, target) {
  const normalizedType = machineCode(effectType, "effectType", 128);
  if (!RUNTIME_EFFECT_TYPE_SET.has(normalizedType)) fail("INVALID_EFFECT_TYPE", `不支持的逻辑效果种类：${normalizedType}`);
  const normalizedTarget = singleLine(target, "target", 1_024);
  if (normalizedTarget.includes("?") || normalizedTarget.includes("\\") || /(?:^|\/)\.\.(?:\/|$)/u.test(normalizedTarget)) {
    fail("INVALID_EFFECT_TARGET", "效果目标不能含查询串、反斜杠或路径逃逸");
  }
  if (normalizedType.startsWith("task.")) {
    const separator = normalizedTarget.lastIndexOf("#");
    if (separator <= 0 || separator === normalizedTarget.length - 1 || normalizedTarget.indexOf("#") !== separator) {
      fail("INVALID_EFFECT_TARGET", "任务效果目标必须是 sourcePath#taskId");
    }
    const sourcePath = normalizedTarget.slice(0, separator);
    const taskId = normalizedTarget.slice(separator + 1);
    if (path.isAbsolute(sourcePath) || sourcePath.startsWith("./") || sourcePath.startsWith("/")) {
      fail("INVALID_EFFECT_TARGET", "任务效果只能使用 Vault 相对来源路径");
    }
    const segments = sourcePath.split("/");
    if (!segments.length || segments.some((segment) => !segment || segment === "." || SENSITIVE_TARGET_SEGMENT.test(segment))) {
      fail("INVALID_EFFECT_TARGET", "任务效果目标命中空段、敏感目录或禁止路径");
    }
    machineCode(taskId, "target.taskId", 256);
  } else if (!/^[a-z0-9][a-z0-9._:@/+~#-]*$/iu.test(normalizedTarget)) {
    fail("INVALID_EFFECT_TARGET", "执行关联效果目标必须是稳定机器定位");
  }
  return normalizedTarget;
}

export function stableEffectId(effectType, target) {
  const normalized = {
    effectType: machineCode(effectType, "effectType", 128),
    target: normalizeEffectTarget(effectType, target),
  };
  return `effect_${digest(normalized)}`;
}

function normalizedReasonCode(value, name = "reasonCode") {
  return optionalMachineCode(value, name, 128);
}

function uniqueMachineCodes(values, name) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) fail("INVALID_ARGUMENT", `${name} 必须是数组`);
  return [...new Set(values.map((value, index) => machineCode(value, `${name}[${index}]`, 256)))].sort();
}

export function sanitizeProcessOutcome(raw) {
  assertRecord(raw, "processOutcome");
  const status = machineCode(raw.status, "processOutcome.status", 32);
  if (!PROCESS_OUTCOMES.has(status)) fail("INVALID_OUTCOME", `不支持的进程结果：${status}`);
  const result = { status };
  if (raw.exitCode !== undefined && raw.exitCode !== null) {
    if (!Number.isSafeInteger(raw.exitCode) || raw.exitCode < 0 || raw.exitCode > 255) {
      fail("INVALID_OUTCOME", "processOutcome.exitCode 必须是 0–255 的整数");
    }
    result.exitCode = raw.exitCode;
  }
  const signal = optionalMachineCode(raw.signal, "processOutcome.signal", 32);
  const reasonCode = normalizedReasonCode(raw.reasonCode, "processOutcome.reasonCode");
  if (signal) result.signal = signal;
  if (reasonCode) result.reasonCode = reasonCode;
  return result;
}

export function sanitizeWritebackOutcome(raw) {
  assertRecord(raw, "writebackOutcome");
  const status = machineCode(raw.status, "writebackOutcome.status", 32);
  if (!WRITEBACK_OUTCOMES.has(status)) fail("INVALID_OUTCOME", `不支持的写回结果：${status}`);
  const result = { status, effectIds: uniqueMachineCodes(raw.effectIds, "writebackOutcome.effectIds") };
  const reasonCode = normalizedReasonCode(raw.reasonCode, "writebackOutcome.reasonCode");
  if (reasonCode) result.reasonCode = reasonCode;
  return result;
}

export function sanitizeReadbackOutcome(raw) {
  assertRecord(raw, "readbackOutcome");
  const status = machineCode(raw.status, "readbackOutcome.status", 32);
  if (!READBACK_OUTCOMES.has(status)) fail("INVALID_OUTCOME", `不支持的回读结果：${status}`);
  const result = { status, effectIds: uniqueMachineCodes(raw.effectIds, "readbackOutcome.effectIds") };
  const reasonCode = normalizedReasonCode(raw.reasonCode, "readbackOutcome.reasonCode");
  if (reasonCode) result.reasonCode = reasonCode;
  return result;
}

export function sanitizeRuntimeErrors(rawErrors, fallbackAt) {
  if (rawErrors === undefined || rawErrors === null) return [];
  if (!Array.isArray(rawErrors) || rawErrors.length > 32) {
    fail("INVALID_ARGUMENT", "errors 必须是最多 32 项的数组");
  }
  return rawErrors.map((raw, index) => {
    assertRecord(raw, `errors[${index}]`);
    const result = {
      code: machineCode(raw.code, `errors[${index}].code`, 128),
      stage: machineCode(raw.stage, `errors[${index}].stage`, 64),
      retryable: raw.retryable === true,
      at: normalizeTime(raw.at ?? fallbackAt, `errors[${index}].at`),
    };
    const source = optionalMachineCode(raw.source, `errors[${index}].source`, 64);
    if (source) result.source = source;
    return result;
  });
}

export function sanitizeReconciliationEvidence(raw) {
  assertRecord(raw, "reconciliationEvidence");
  const kind = machineCode(raw.kind, "reconciliationEvidence.kind", 64);
  if (!new Set(["authoritative-readback", "authoritative-negative-readback"]).has(kind)) {
    fail("INVALID_RECONCILIATION_EVIDENCE", "效果恢复只接受权威原件正向或负向回读证据");
  }
  const sourceRevision = singleLine(raw.sourceRevision, "reconciliationEvidence.sourceRevision", 256);
  const digestValue = machineCode(raw.digest, "reconciliationEvidence.digest", 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digestValue)) fail("INVALID_RECONCILIATION_EVIDENCE", "效果恢复证据必须带 sha256 内容摘要");
  return { kind, sourceRevision, digest: digestValue };
}

export function sanitizeStartEvidence(raw, now = new Date()) {
  assertRecord(raw, "startEvidence");
  const kind = machineCode(raw.kind, "startEvidence.kind", 64);
  if (!START_EVIDENCE_KINDS.has(kind)) {
    fail("UNTRUSTED_START_EVIDENCE", "队列接收、进程创建或本机回退 ID 不能证明 Agent 已开始工作");
  }
  const source = machineCode(raw.source, "startEvidence.source", 128);
  if (UNTRUSTED_START_SOURCES.has(source.toLowerCase()) || !TRUSTED_START_SOURCES.has(source.toLowerCase())) {
    fail("UNTRUSTED_START_EVIDENCE", "启动证据必须来自独立平台、协议握手或结构化事件");
  }
  const result = { kind, source, observedAt: normalizeTime(raw.observedAt ?? now, "startEvidence.observedAt") };
  if (kind === "platform-execution") {
    result.platformId = machineCode(raw.platformId, "startEvidence.platformId", 128);
    result.executionId = machineCode(raw.executionId, "startEvidence.executionId", 256);
  } else if (kind === "protocol-handshake") {
    result.protocol = machineCode(raw.protocol, "startEvidence.protocol", 128);
    result.receiptId = machineCode(raw.receiptId, "startEvidence.receiptId", 256);
    if (!TRUSTED_PROTOCOLS.has(result.protocol.toLowerCase())) {
      fail("UNTRUSTED_START_EVIDENCE", "协议握手不在已验收的可信协议白名单中");
    }
  } else {
    result.eventType = machineCode(raw.eventType, "startEvidence.eventType", 128);
    result.eventId = machineCode(raw.eventId, "startEvidence.eventId", 256);
    if (UNTRUSTED_EVENT_TYPES.test(result.eventType) || !TRUSTED_STRUCTURED_EVENTS.has(result.eventType.toLowerCase())) {
      fail("UNTRUSTED_START_EVIDENCE", "排队或创建进程事件不能证明 Agent 已开始工作");
    }
  }
  return result;
}

export function createRuntimeLedgerState(now = new Date()) {
  const timestamp = normalizeTime(now, "now");
  return {
    schemaVersion: RUNTIME_LEDGER_SCHEMA_VERSION,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    runs: {},
    eligibilityIndex: {},
    executionLinkEvents: [],
  };
}

function validateAttempt(attempt, expectedAttemptNo) {
  assertRecord(attempt, `attempt ${expectedAttemptNo}`);
  assertOnlyKeys(attempt, new Set([
    "attemptNo", "owner", "claimedAt", "leaseExpiresAt", "status", "startedAt", "startEvidence",
    "settledAt", "processOutcome", "writebackOutcome", "readbackOutcome", "errors",
  ]), `attempt ${expectedAttemptNo}`);
  if (attempt.attemptNo !== expectedAttemptNo) fail("CORRUPT_LEDGER", "attemptNo 必须连续递增");
  machineCode(attempt.owner, "attempt.owner", 256);
  timeMs(attempt.claimedAt, "attempt.claimedAt");
  timeMs(attempt.leaseExpiresAt, "attempt.leaseExpiresAt");
  if (!new Set(["claimed", "running", "settled", "lease-expired"]).has(attempt.status)) {
    fail("CORRUPT_LEDGER", "尝试状态无效");
  }
  if (!Array.isArray(attempt.errors)) fail("CORRUPT_LEDGER", "attempt.errors 必须是数组");
  if (attempt.startedAt !== null) timeMs(attempt.startedAt, "attempt.startedAt");
  if (attempt.settledAt !== null) timeMs(attempt.settledAt, "attempt.settledAt");
  if (attempt.startEvidence !== null) {
    const normalized = sanitizeStartEvidence(attempt.startEvidence, attempt.startedAt ?? attempt.claimedAt);
    if (canonicalJson(normalized) !== canonicalJson(attempt.startEvidence)) fail("CORRUPT_LEDGER", "启动证据含非白名单字段");
  }
  if (attempt.processOutcome !== null && canonicalJson(sanitizeProcessOutcome(attempt.processOutcome)) !== canonicalJson(attempt.processOutcome)) {
    fail("CORRUPT_LEDGER", "进程结果含非白名单字段");
  }
  if (attempt.writebackOutcome !== null && canonicalJson(sanitizeWritebackOutcome(attempt.writebackOutcome)) !== canonicalJson(attempt.writebackOutcome)) {
    fail("CORRUPT_LEDGER", "写回结果含非白名单字段");
  }
  if (attempt.readbackOutcome !== null && canonicalJson(sanitizeReadbackOutcome(attempt.readbackOutcome)) !== canonicalJson(attempt.readbackOutcome)) {
    fail("CORRUPT_LEDGER", "回读结果含非白名单字段");
  }
  if (canonicalJson(sanitizeRuntimeErrors(attempt.errors, attempt.settledAt ?? attempt.claimedAt)) !== canonicalJson(attempt.errors)) {
    fail("CORRUPT_LEDGER", "错误记录含非白名单字段");
  }
  if (attempt.status === "claimed" && (attempt.startedAt !== null || attempt.startEvidence !== null || attempt.settledAt !== null)) {
    fail("CORRUPT_LEDGER", "claimed 尝试不能已有启动或结算回执");
  }
  if (attempt.status === "running" && (!attempt.startedAt || !attempt.startEvidence || attempt.settledAt !== null)) {
    fail("CORRUPT_LEDGER", "running 尝试必须有可信启动回执且尚未结算");
  }
  if (new Set(["settled", "lease-expired"]).has(attempt.status)
    && (!attempt.settledAt || !attempt.processOutcome || !attempt.writebackOutcome || !attempt.readbackOutcome)) {
    fail("CORRUPT_LEDGER", "已结束尝试必须保留三类独立结果");
  }
}

export function validateRuntimeLedgerState(state) {
  assertRecord(state, "ledger");
  assertOnlyKeys(state, new Set([
    "schemaVersion", "revision", "createdAt", "updatedAt", "runs", "eligibilityIndex", "executionLinkEvents",
  ]), "ledger");
  if (state.schemaVersion !== RUNTIME_LEDGER_SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA", `运行账只接受 schema v${RUNTIME_LEDGER_SCHEMA_VERSION}`);
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) fail("CORRUPT_LEDGER", "ledger.revision 无效");
  timeMs(state.createdAt, "ledger.createdAt");
  timeMs(state.updatedAt, "ledger.updatedAt");
  if (Date.parse(state.updatedAt) < Date.parse(state.createdAt)) fail("CORRUPT_LEDGER", "ledger.updatedAt 不能早于 createdAt");
  assertRecord(state.runs, "ledger.runs");
  assertRecord(state.eligibilityIndex, "ledger.eligibilityIndex");
  if (!Array.isArray(state.executionLinkEvents)) fail("CORRUPT_LEDGER", "executionLinkEvents 必须是数组");
  if (Object.keys(state.runs).length > RUNTIME_LEDGER_LIMITS.maxRuns
    || state.executionLinkEvents.length > RUNTIME_LEDGER_LIMITS.maxExecutionLinkEvents) {
    fail("LEDGER_LIMIT_EXCEEDED", "运行账超过有界保留上限，需要先归档已结算记录");
  }

  for (const [runId, run] of Object.entries(state.runs)) {
    assertRecord(run, `run ${runId}`);
    assertOnlyKeys(run, new Set([
      "runId", "eligibilityKey", "eligibilityKeyHash", "status", "createdAt", "updatedAt",
      "currentAttemptNo", "lease", "attempts", "effects",
    ]), `run ${runId}`);
    if (run.runId !== runId) fail("CORRUPT_LEDGER", "runId 与索引不一致");
    assertOnlyKeys(run.eligibilityKey, new Set([
      "taskId", "executorRoleId", "eligibilityRevision", "triggerId", "triggerCursor",
    ]), "eligibilityKey");
    const eligibility = normalizeEligibilityKey(run.eligibilityKey);
    const keyHash = eligibilityKeyHash(eligibility);
    if (run.eligibilityKeyHash !== keyHash || state.eligibilityIndex[keyHash] !== runId || stableRunId(eligibility) !== runId) {
      fail("CORRUPT_LEDGER", "资格键、runId 与索引不一致");
    }
    if (!Array.isArray(run.attempts) || run.attempts.length === 0) fail("CORRUPT_LEDGER", "每个运行至少有一次尝试");
    if (run.attempts.length > RUNTIME_LEDGER_LIMITS.maxAttemptsPerRun) fail("LEDGER_LIMIT_EXCEEDED", "单个运行尝试次数超过上限");
    timeMs(run.createdAt, "run.createdAt");
    timeMs(run.updatedAt, "run.updatedAt");
    if (Date.parse(run.updatedAt) < Date.parse(run.createdAt)) fail("CORRUPT_LEDGER", "运行 updatedAt 不能早于 createdAt");
    run.attempts.forEach((attempt, index) => validateAttempt(attempt, index + 1));
    if (run.currentAttemptNo !== run.attempts.length) fail("CORRUPT_LEDGER", "currentAttemptNo 与尝试数不一致");
    if (!new Set(["claimed", "running", "settled"]).has(run.status)) fail("CORRUPT_LEDGER", "运行状态无效");
    if (run.lease !== null) {
      assertRecord(run.lease, "run.lease");
      assertOnlyKeys(run.lease, new Set(["owner", "attemptNo", "acquiredAt", "expiresAt"]), "run.lease");
      machineCode(run.lease.owner, "run.lease.owner", 256);
      if (run.lease.attemptNo !== run.currentAttemptNo) fail("CORRUPT_LEDGER", "租约尝试号不是当前尝试");
      timeMs(run.lease.acquiredAt, "run.lease.acquiredAt");
      timeMs(run.lease.expiresAt, "run.lease.expiresAt");
    } else if (run.status !== "settled") {
      fail("CORRUPT_LEDGER", "未结算运行必须持有租约");
    }
    assertRecord(run.effects, "run.effects");
    if (Object.keys(run.effects).length > RUNTIME_LEDGER_LIMITS.maxEffectsPerRun) fail("LEDGER_LIMIT_EXCEEDED", "单个运行效果数超过上限");
    for (const [effectId, effect] of Object.entries(run.effects)) {
      assertRecord(effect, `effect ${effectId}`);
      assertOnlyKeys(effect, new Set([
        "effectId", "effectType", "target", "intentDigest", "createdAt", "preparedAt", "preparedAttemptNo", "appliedAt", "verifiedAt", "retiredAt", "receipts",
      ]), `effect ${effectId}`);
      if (effect.effectId !== effectId || stableEffectId(effect.effectType, effect.target) !== effectId) {
        fail("CORRUPT_LEDGER", "effectId 与逻辑效果不一致");
      }
      if (!Array.isArray(effect.receipts)) fail("CORRUPT_LEDGER", "效果回执必须是数组");
      if (effect.intentDigest !== undefined
        && (typeof effect.intentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(effect.intentDigest))) {
        fail("CORRUPT_LEDGER", "效果 intentDigest 无效");
      }
      if (effect.receipts.length > RUNTIME_LEDGER_LIMITS.maxReceiptsPerEffect) fail("LEDGER_LIMIT_EXCEEDED", "单个效果回执数超过上限");
      timeMs(effect.createdAt, "effect.createdAt");
      if (effect.preparedAt !== null) timeMs(effect.preparedAt, "effect.preparedAt");
      if (effect.preparedAttemptNo !== null
        && (!Number.isSafeInteger(effect.preparedAttemptNo) || effect.preparedAttemptNo <= 0 || effect.preparedAttemptNo > run.currentAttemptNo)) {
        fail("CORRUPT_LEDGER", "效果准备记录引用了无效尝试");
      }
      if ((effect.preparedAt === null) !== (effect.preparedAttemptNo === null)) fail("CORRUPT_LEDGER", "效果准备时间与尝试号不一致");
      if (effect.appliedAt !== null) timeMs(effect.appliedAt, "effect.appliedAt");
      if (effect.verifiedAt !== null) timeMs(effect.verifiedAt, "effect.verifiedAt");
      if (effect.retiredAt !== undefined && effect.retiredAt !== null) {
        timeMs(effect.retiredAt, "effect.retiredAt");
        if (effect.preparedAt || effect.appliedAt || effect.verifiedAt) {
          fail("CORRUPT_LEDGER", "已退役效果不能仍处于 prepared/applied/verified 状态");
        }
      }
      let hasAppliedReceipt = false;
      let hasVerifiedReceipt = false;
      for (const receipt of effect.receipts) {
        assertRecord(receipt, "effect.receipt");
        assertOnlyKeys(receipt, new Set([
          "attemptNo", "recordedAt", "intentDigest", "writebackOutcome", "readbackOutcome", "reconciledByAttemptNo", "reconciliationEvidence",
        ]), "effect.receipt");
        if (!Number.isSafeInteger(receipt.attemptNo) || receipt.attemptNo <= 0 || receipt.attemptNo > run.currentAttemptNo) {
          fail("CORRUPT_LEDGER", "效果回执引用了无效尝试");
        }
        timeMs(receipt.recordedAt, "effect.receipt.recordedAt");
        if (receipt.intentDigest !== undefined
          && (typeof receipt.intentDigest !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.intentDigest))) {
          fail("CORRUPT_LEDGER", "效果回执 intentDigest 无效");
        }
        if (receipt.reconciledByAttemptNo !== undefined
          && (!Number.isSafeInteger(receipt.reconciledByAttemptNo)
            || receipt.reconciledByAttemptNo <= 0
            || receipt.reconciledByAttemptNo > run.currentAttemptNo)) {
          fail("CORRUPT_LEDGER", "效果对账回执引用了无效接管尝试");
        }
        if (receipt.reconciliationEvidence !== undefined) {
          const normalizedEvidence = sanitizeReconciliationEvidence(receipt.reconciliationEvidence);
          if (canonicalJson(normalizedEvidence) !== canonicalJson(receipt.reconciliationEvidence)) {
            fail("CORRUPT_LEDGER", "效果对账证据含非白名单字段");
          }
        }
        const writeback = sanitizeWritebackOutcome(receipt.writebackOutcome);
        const readback = sanitizeReadbackOutcome(receipt.readbackOutcome);
        if (writeback.effectIds.length || readback.effectIds.length
          || canonicalJson(writeback) !== canonicalJson(receipt.writebackOutcome)
          || canonicalJson(readback) !== canonicalJson(receipt.readbackOutcome)) {
          fail("CORRUPT_LEDGER", "效果回执含非白名单或嵌套效果字段");
        }
        hasAppliedReceipt ||= writeback.status === "succeeded";
        hasVerifiedReceipt ||= writeback.status === "succeeded" && readback.status === "succeeded";
      }
      if (Boolean(effect.appliedAt) !== hasAppliedReceipt || Boolean(effect.verifiedAt) !== hasVerifiedReceipt) {
        fail("CORRUPT_LEDGER", "效果成功时间与回执不一致");
      }
      if (effect.appliedAt && effect.preparedAt) fail("CORRUPT_LEDGER", "已成功效果不能仍处于准备状态");
      if (!effect.receipts.length && !effect.preparedAt) fail("CORRUPT_LEDGER", "效果既无准备记录也无回执");
    }
    const currentAttempt = run.attempts[run.currentAttemptNo - 1];
    if (run.status === "settled" && (currentAttempt.status !== "settled" || run.lease !== null)) {
      fail("CORRUPT_LEDGER", "settled 运行与当前尝试不一致");
    }
    if (run.status !== "settled" && currentAttempt.status !== run.status) {
      fail("CORRUPT_LEDGER", "运行状态与当前尝试不一致");
    }
  }
  for (const [keyHash, runId] of Object.entries(state.eligibilityIndex)) {
    if (!/^[a-f0-9]{64}$/u.test(keyHash) || !state.runs[runId] || state.runs[runId].eligibilityKeyHash !== keyHash) {
      fail("CORRUPT_LEDGER", "资格索引含孤儿或非法映射");
    }
  }

  const eventIds = new Set();
  for (const event of state.executionLinkEvents) {
    assertRecord(event, "executionLinkEvent");
    const allowed = event.eventType === "end"
      ? new Set(["eventId", "eventType", "linkEventId", "reasonCode", "recordedAt"])
      : event.eventType === "link"
        ? new Set(["eventId", "eventType", "platformId", "executionId", "taskId", "relation", "runId", "attemptNo", "relationCursor", "recordedAt"])
        : new Set(["eventId", "eventType", "platformId", "executionId", "taskId", "runId", "attemptNo", "effectId", "recordedAt"]);
    assertOnlyKeys(event, allowed, "executionLinkEvent");
    if (eventIds.has(event.eventId)) fail("CORRUPT_LEDGER", "执行关联事件重复");
    eventIds.add(event.eventId);
    const { eventId, recordedAt, ...payload } = event;
    timeMs(recordedAt, "executionLinkEvent.recordedAt");
    if (stableExecutionLinkEventId(payload) !== eventId) fail("CORRUPT_LEDGER", "执行关联 eventId 与事件语义不一致");
  }
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > RUNTIME_LEDGER_LIMITS.maxBytes) {
    fail("LEDGER_LIMIT_EXCEEDED", "运行账文件超过大小上限，需要先归档已结算记录");
  }
  return state;
}

function cloneLedger(state) {
  validateRuntimeLedgerState(state);
  return structuredClone(state);
}

function changedState(state, now) {
  const nextTime = normalizeTime(now, "now");
  if (Date.parse(nextTime) < Date.parse(state.updatedAt)) fail("CLOCK_ROLLBACK", "运行账时钟不能早于上一修订");
  state.revision += 1;
  state.updatedAt = nextTime;
  validateRuntimeLedgerState(state);
  return state;
}

function attemptFor(run, attemptNo) {
  if (!Number.isSafeInteger(attemptNo) || attemptNo <= 0) fail("INVALID_ARGUMENT", "attemptNo 必须是正整数");
  const attempt = run.attempts[attemptNo - 1];
  if (!attempt || attempt.attemptNo !== attemptNo) fail("ATTEMPT_NOT_FOUND", "运行尝试不存在", { runId: run.runId, attemptNo });
  return attempt;
}

function runFor(state, runId) {
  const normalized = machineCode(runId, "runId", 128);
  const run = state.runs[normalized];
  if (!run) fail("RUN_NOT_FOUND", "逻辑运行不存在", { runId: normalized });
  return run;
}

function leaseIsActive(lease, nowMs) {
  return lease !== null && timeMs(lease.expiresAt, "lease.expiresAt") > nowMs;
}

function assertCurrentLease(run, { owner, attemptNo, now }) {
  const normalizedOwner = machineCode(owner, "owner", 256);
  const timestamp = normalizeTime(now, "now");
  if (!run.lease || run.lease.owner !== normalizedOwner || run.lease.attemptNo !== attemptNo) {
    fail("LEASE_MISMATCH", "运行不属于当前所有者或尝试", { runId: run.runId, attemptNo });
  }
  if (!leaseIsActive(run.lease, Date.parse(timestamp))) {
    fail("LEASE_EXPIRED", "运行租约已过期，旧执行者不得继续写回", { runId: run.runId, attemptNo });
  }
  return { owner: normalizedOwner, timestamp };
}

export function assertRuntimeRunContextState(inputState, {
  runId,
  attemptNo,
  owner,
  primaryTaskId,
  executorRoleId,
  eligibilityKeyHash: claimedEligibilityKeyHash,
  now = new Date(),
}) {
  validateRuntimeLedgerState(inputState);
  const run = runFor(inputState, runId);
  const { owner: normalizedOwner, timestamp } = assertCurrentLease(run, { owner, attemptNo, now });
  const normalizedTaskId = machineCode(primaryTaskId, "primaryTaskId", 256);
  const normalizedRoleId = machineCode(executorRoleId, "executorRoleId", 128);
  const normalizedKeyHash = machineCode(claimedEligibilityKeyHash, "eligibilityKeyHash", 128);
  if (run.eligibilityKey.taskId !== normalizedTaskId) fail("TASK_MISMATCH", "primaryTaskId 与运行资格不一致");
  if (run.eligibilityKey.executorRoleId !== normalizedRoleId) fail("ROLE_MISMATCH", "执行岗位与运行资格不一致");
  if (run.eligibilityKeyHash !== normalizedKeyHash) fail("ELIGIBILITY_MISMATCH", "资格键与当前认领不一致");
  const attempt = attemptFor(run, attemptNo);
  if (attempt.status !== "running" || !attempt.startEvidence) {
    fail("RUN_NOT_STARTED", "正式写回必须来自已有可信启动回执的尝试");
  }
  return {
    runId: run.runId,
    attemptNo,
    owner: normalizedOwner,
    primaryTaskId: normalizedTaskId,
    executorRoleId: normalizedRoleId,
    eligibilityKeyHash: normalizedKeyHash,
    eligibilityKey: structuredClone(run.eligibilityKey),
    leaseExpiresAt: run.lease.expiresAt,
    checkedAt: timestamp,
  };
}

function newAttempt(attemptNo, owner, timestamp, expiresAt) {
  return {
    attemptNo,
    owner,
    claimedAt: timestamp,
    leaseExpiresAt: expiresAt,
    status: "claimed",
    startedAt: null,
    startEvidence: null,
    settledAt: null,
    processOutcome: null,
    writebackOutcome: null,
    readbackOutcome: null,
    errors: [],
  };
}

function expireAttempt(run, attempt, timestamp) {
  const appliedEffectIds = Object.values(run.effects)
    .filter((effect) => effect.receipts.some((receipt) => receipt.attemptNo === attempt.attemptNo && receipt.writebackOutcome.status === "succeeded"))
    .map((effect) => effect.effectId)
    .sort();
  const verifiedEffectIds = Object.values(run.effects)
    .filter((effect) => effect.receipts.some((receipt) => receipt.attemptNo === attempt.attemptNo && receipt.readbackOutcome.status === "succeeded"))
    .map((effect) => effect.effectId)
    .sort();
  attempt.status = "lease-expired";
  attempt.settledAt = timestamp;
  attempt.processOutcome = { status: "unknown", reasonCode: "lease-expired" };
  attempt.writebackOutcome = { status: appliedEffectIds.length ? "partial" : "unknown", effectIds: appliedEffectIds, reasonCode: "lease-expired" };
  attempt.readbackOutcome = { status: verifiedEffectIds.length ? "partial" : "unknown", effectIds: verifiedEffectIds, reasonCode: "lease-expired" };
  attempt.errors.push({ code: "lease-expired", stage: "lease", retryable: true, at: timestamp, source: "runtime-ledger" });
}

function sameIds(left = [], right = []) {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

function activeRuntimeEffects(run) {
  return Object.values(run.effects).filter((effect) => !effect.retiredAt);
}

function attemptHasTrustedCompletion(run, attempt) {
  const effects = activeRuntimeEffects(run);
  const appliedEffectIds = effects.filter((effect) => effect.appliedAt).map((effect) => effect.effectId).sort();
  const verifiedEffectIds = effects.filter((effect) => effect.verifiedAt).map((effect) => effect.effectId).sort();
  return Boolean(
    attempt?.startEvidence
    && attempt.processOutcome?.status === "succeeded"
    && (attempt.processOutcome.exitCode === undefined || attempt.processOutcome.exitCode === 0)
    && appliedEffectIds.length > 0
    && appliedEffectIds.length === effects.length
    && attempt.writebackOutcome?.status === "succeeded"
    && sameIds(attempt.writebackOutcome.effectIds, appliedEffectIds)
    && attempt.readbackOutcome?.status === "succeeded"
    && sameIds(attempt.readbackOutcome.effectIds, appliedEffectIds)
    && sameIds(verifiedEffectIds, appliedEffectIds),
  );
}

function previousSettledAttempt(run) {
  return attemptFor(run, run.currentAttemptNo);
}

function runtimeAttemptIsRetryable(run, attempt) {
  if (attemptHasTrustedCompletion(run, attempt)) return false;
  if (attempt.errors.length) return attempt.errors.some((error) => error.retryable);
  if (new Set(["not-started", "failed", "timed-out", "unknown"]).has(attempt.processOutcome?.status)) return true;
  if (attempt.processOutcome?.status === "succeeded") {
    return attempt.writebackOutcome?.status !== "succeeded" || attempt.readbackOutcome?.status !== "succeeded";
  }
  return false;
}

export function claimRuntimeState(inputState, {
  eligibilityKey,
  owner,
  leaseDurationMs,
  now = new Date(),
}) {
  const state = cloneLedger(inputState);
  const eligibility = normalizeEligibilityKey(eligibilityKey);
  const keyHash = eligibilityKeyHash(eligibility);
  const runId = stableRunId(eligibility);
  const normalizedOwner = machineCode(owner, "owner", 256);
  const leaseMs = positiveDuration(leaseDurationMs);
  const timestamp = normalizeTime(now, "now");
  const nowMs = Date.parse(timestamp);
  const expiresAt = new Date(nowMs + leaseMs).toISOString();
  const existingRunId = state.eligibilityIndex[keyHash];
  const competingTaskRun = Object.values(state.runs).find((run) => run.runId !== runId
    && run.eligibilityKey.taskId === eligibility.taskId
    && leaseIsActive(run.lease, nowMs));
  if (competingTaskRun) {
    fail("TASK_LEASE_ACTIVE", "同一 taskId 的另一逻辑运行已有活租约，拒绝多触发并行认领", {
      taskId: eligibility.taskId,
      runId: competingTaskRun.runId,
      attemptNo: competingTaskRun.currentAttemptNo,
      owner: competingTaskRun.lease.owner,
      expiresAt: competingTaskRun.lease.expiresAt,
    });
  }

  if (existingRunId) {
    const run = runFor(state, existingRunId);
    if (leaseIsActive(run.lease, nowMs)) {
      fail("LEASE_ACTIVE", "同一资格键已有活租约，拒绝重复认领", {
        runId: run.runId,
        attemptNo: run.currentAttemptNo,
        owner: run.lease.owner,
        expiresAt: run.lease.expiresAt,
      });
    }
    if (run.status === "settled" && !runtimeAttemptIsRetryable(run, previousSettledAttempt(run))) {
      return {
        state,
        result: { claimed: false, reason: "already-settled", runId: run.runId, attemptNo: run.currentAttemptNo },
      };
    }

    const previousAttempt = attemptFor(run, run.currentAttemptNo);
    const staleTakeover = run.lease !== null;
    if (previousAttempt.status === "claimed" || previousAttempt.status === "running") {
      expireAttempt(run, previousAttempt, timestamp);
    }
    const attemptNo = run.currentAttemptNo + 1;
    run.currentAttemptNo = attemptNo;
    run.attempts.push(newAttempt(attemptNo, normalizedOwner, timestamp, expiresAt));
    run.status = "claimed";
    run.lease = { owner: normalizedOwner, attemptNo, acquiredAt: timestamp, expiresAt };
    run.updatedAt = timestamp;
    changedState(state, timestamp);
    return {
      state,
      result: { claimed: true, recovered: staleTakeover, runId: run.runId, attemptNo, lease: structuredClone(run.lease) },
    };
  }

  if (state.runs[runId]) fail("RUN_ID_COLLISION", "runId 已被另一资格键占用");
  const attemptNo = 1;
  const run = {
    runId,
    eligibilityKey: eligibility,
    eligibilityKeyHash: keyHash,
    status: "claimed",
    createdAt: timestamp,
    updatedAt: timestamp,
    currentAttemptNo: attemptNo,
    lease: { owner: normalizedOwner, attemptNo, acquiredAt: timestamp, expiresAt },
    attempts: [newAttempt(attemptNo, normalizedOwner, timestamp, expiresAt)],
    effects: {},
  };
  state.runs[runId] = run;
  state.eligibilityIndex[keyHash] = runId;
  changedState(state, timestamp);
  return {
    state,
    result: { claimed: true, recovered: false, runId, attemptNo, lease: structuredClone(run.lease) },
  };
}

export function renewRuntimeLeaseState(inputState, {
  runId,
  attemptNo,
  owner,
  leaseDurationMs,
  now = new Date(),
}) {
  const state = cloneLedger(inputState);
  const run = runFor(state, runId);
  const { timestamp } = assertCurrentLease(run, { owner, attemptNo, now });
  const duration = positiveDuration(leaseDurationMs);
  const expiresAt = new Date(Math.max(Date.parse(run.lease.expiresAt), Date.parse(timestamp) + duration)).toISOString();
  run.lease.expiresAt = expiresAt;
  attemptFor(run, attemptNo).leaseExpiresAt = expiresAt;
  run.updatedAt = timestamp;
  changedState(state, timestamp);
  return { state, result: { renewed: true, runId: run.runId, attemptNo, expiresAt } };
}

export function ackStartedState(inputState, {
  runId,
  attemptNo,
  owner,
  evidence,
  now = new Date(),
}) {
  const state = cloneLedger(inputState);
  const run = runFor(state, runId);
  const { timestamp } = assertCurrentLease(run, { owner, attemptNo, now });
  const attempt = attemptFor(run, attemptNo);
  const normalizedEvidence = sanitizeStartEvidence(evidence, timestamp);
  if (attempt.startEvidence) {
    if (canonicalJson(attempt.startEvidence) === canonicalJson(normalizedEvidence)) {
      return { state, result: { acknowledged: false, deduplicated: true, runId: run.runId, attemptNo } };
    }
    fail("START_ALREADY_ACKNOWLEDGED", "该尝试已有不同的可信启动回执", { runId: run.runId, attemptNo });
  }
  if (attempt.status !== "claimed") fail("INVALID_RUN_STATE", "只有已认领尝试可以确认启动");
  attempt.status = "running";
  attempt.startedAt = timestamp;
  attempt.startEvidence = normalizedEvidence;
  run.status = "running";
  run.updatedAt = timestamp;
  changedState(state, timestamp);
  return { state, result: { acknowledged: true, deduplicated: false, runId: run.runId, attemptNo } };
}

function validateEffectOutcomes(run, writebackOutcome, readbackOutcome) {
  for (const effectId of writebackOutcome.effectIds) {
    const effect = run.effects[effectId];
    if (!effect) fail("UNKNOWN_EFFECT", "写回汇总引用了未知效果", { effectId });
    if (writebackOutcome.status === "succeeded" && !effect.appliedAt) {
      fail("UNAPPLIED_EFFECT", "写回汇总不能把未成功效果标成成功", { effectId });
    }
  }
  for (const effectId of readbackOutcome.effectIds) {
    const effect = run.effects[effectId];
    if (!effect) fail("UNKNOWN_EFFECT", "回读汇总引用了未知效果", { effectId });
    if (readbackOutcome.status === "succeeded" && !effect.verifiedAt) {
      fail("UNVERIFIED_EFFECT", "回读汇总不能把未验证效果标成成功", { effectId });
    }
  }
  if (writebackOutcome.status === "succeeded" && writebackOutcome.effectIds.length === 0) {
    fail("INVALID_OUTCOME", "有正式写回时必须列出至少一个 effectId；无写回请使用 not-required");
  }
  if (writebackOutcome.status === "succeeded") {
    const allEffects = activeRuntimeEffects(run);
    const appliedEffectIds = allEffects.filter((effect) => effect.appliedAt).map((effect) => effect.effectId).sort();
    if (appliedEffectIds.length !== allEffects.length || !sameIds(writebackOutcome.effectIds, appliedEffectIds)) {
      fail("INCOMPLETE_EFFECT_SUMMARY", "成功结算必须覆盖本逻辑运行的全部效果，不能漏掉失败或待对账效果");
    }
  }
  if (readbackOutcome.status === "succeeded") {
    const appliedEffectIds = activeRuntimeEffects(run).filter((effect) => effect.appliedAt).map((effect) => effect.effectId).sort();
    const verifiedEffectIds = activeRuntimeEffects(run).filter((effect) => effect.verifiedAt).map((effect) => effect.effectId).sort();
    if (!sameIds(readbackOutcome.effectIds, appliedEffectIds) || !sameIds(verifiedEffectIds, appliedEffectIds)) {
      fail("INCOMPLETE_READBACK_SUMMARY", "成功回读必须覆盖全部已写回效果");
    }
  }
}

function effectIdentity(effectType, target, suppliedEffectId) {
  const normalizedType = machineCode(effectType, "effectType", 128);
  const normalizedTarget = normalizeEffectTarget(normalizedType, target);
  const effectId = stableEffectId(normalizedType, normalizedTarget);
  if (suppliedEffectId !== undefined && suppliedEffectId !== effectId) {
    fail("EFFECT_ID_MISMATCH", "effectId 必须由逻辑效果种类和目标稳定生成", { expectedEffectId: effectId });
  }
  return { effectType: normalizedType, target: normalizedTarget, effectId };
}

export function prepareRuntimeEffectState(inputState, {
  runId,
  attemptNo,
  owner,
  primaryTaskId,
  executorRoleId,
  eligibilityKeyHash: claimedEligibilityKeyHash,
  effectType,
  target,
  effectId: suppliedEffectId,
  intentDigest,
  now = new Date(),
}) {
  const state = cloneLedger(inputState);
  const context = assertRuntimeRunContextState(state, {
    runId,
    attemptNo,
    owner,
    primaryTaskId,
    executorRoleId,
    eligibilityKeyHash: claimedEligibilityKeyHash,
    now,
  });
  const run = runFor(state, context.runId);
  const identity = effectIdentity(effectType, target, suppliedEffectId);
  const normalizedIntentDigest = optionalIntentDigest(intentDigest);
  if (identity.effectType.startsWith("task.") && !normalizedIntentDigest) {
    fail("EFFECT_INTENT_REQUIRED", "任务原件效果必须在准备前绑定提议摘要", { effectId: identity.effectId });
  }
  const existing = run.effects[identity.effectId];
  if (existing?.retiredAt) {
    existing.retiredAt = null;
    delete existing.intentDigest;
  }
  if (existing && normalizedIntentDigest) {
    if (existing.intentDigest && existing.intentDigest !== normalizedIntentDigest) {
      if (existing.appliedAt) {
        fail("EFFECT_PAYLOAD_CONFLICT", "同一稳定效果不能更换已应用的提议摘要", { effectId: identity.effectId });
      }
      if (!existing.preparedAt) existing.intentDigest = normalizedIntentDigest;
    }
    if (!existing.intentDigest && (existing.preparedAt || existing.appliedAt)) {
      fail("EFFECT_INTENT_UNBOUND", "既有 prepared/applied 效果没有预先绑定提议摘要，拒绝事后补签", { effectId: identity.effectId });
    }
    if (!existing.intentDigest) existing.intentDigest = normalizedIntentDigest;
  }
  if (existing?.appliedAt) {
    const receipt = existing.receipts.findLast((item) => item.writebackOutcome.status === "succeeded") ?? null;
    return {
      state,
      result: {
        prepared: false,
        duplicate: true,
        shouldApply: false,
        reconciliationRequired: false,
        effectId: identity.effectId,
        receipt: structuredClone(receipt),
      },
    };
  }
  if (existing?.preparedAt) {
    return {
      state,
      result: {
        prepared: false,
        duplicate: false,
        shouldApply: false,
        reconciliationRequired: true,
        effectId: identity.effectId,
        preparedAttemptNo: existing.preparedAttemptNo,
        intentDigest: existing.intentDigest || null,
      },
    };
  }
  if (existing) {
    existing.preparedAt = context.checkedAt;
    existing.preparedAttemptNo = attemptNo;
  } else {
    run.effects[identity.effectId] = {
      ...identity,
      ...(normalizedIntentDigest ? { intentDigest: normalizedIntentDigest } : {}),
      createdAt: context.checkedAt,
      preparedAt: context.checkedAt,
      preparedAttemptNo: attemptNo,
      appliedAt: null,
      verifiedAt: null,
      receipts: [],
    };
  }
  run.updatedAt = context.checkedAt;
  changedState(state, context.checkedAt);
  return {
    state,
    result: { prepared: true, duplicate: false, shouldApply: true, reconciliationRequired: false, effectId: identity.effectId },
  };
}

export function recordRuntimeEffectState(inputState, {
  runId,
  attemptNo,
  owner,
  primaryTaskId,
  executorRoleId,
  eligibilityKeyHash: claimedEligibilityKeyHash,
  effectType,
  target,
  effectId,
  intentDigest,
  writebackOutcome,
  readbackOutcome,
  now = new Date(),
}) {
  const state = cloneLedger(inputState);
  const context = assertRuntimeRunContextState(state, {
    runId,
    attemptNo,
    owner,
    primaryTaskId,
    executorRoleId,
    eligibilityKeyHash: claimedEligibilityKeyHash,
    now,
  });
  const run = runFor(state, context.runId);
  const timestamp = context.checkedAt;
  attemptFor(run, attemptNo);
  const identity = effectIdentity(effectType, target, effectId);
  const expectedEffectId = identity.effectId;
  const normalizedType = identity.effectType;
  const normalizedTarget = identity.target;
  const normalizedWriteback = sanitizeWritebackOutcome(writebackOutcome);
  const normalizedReadback = sanitizeReadbackOutcome(readbackOutcome);
  if (normalizedWriteback.effectIds.length || normalizedReadback.effectIds.length) {
    fail("INVALID_OUTCOME", "单项效果回执不能嵌套 effectIds");
  }
  if (normalizedWriteback.status === "not-required") {
    fail("INVALID_OUTCOME", "效果回执不能把写回标为 not-required");
  }

  const existing = run.effects[expectedEffectId];
  if (!existing) fail("EFFECT_NOT_PREPARED", "正式效果必须先在运行账事务中准备");
  if (existing.effectType !== normalizedType || existing.target !== normalizedTarget) fail("EFFECT_ID_COLLISION", "效果身份冲突");
  const normalizedIntentDigest = optionalIntentDigest(intentDigest);
  if (identity.effectType.startsWith("task.") && !normalizedIntentDigest) {
    fail("EFFECT_INTENT_REQUIRED", "任务原件效果回执必须带预绑定提议摘要", { effectId: expectedEffectId });
  }
  if (normalizedIntentDigest && existing.intentDigest !== normalizedIntentDigest) {
    fail("EFFECT_PAYLOAD_CONFLICT", "正式效果回执与预先绑定的提议摘要不一致", { effectId: expectedEffectId });
  }
  const receipt = {
    attemptNo,
    recordedAt: timestamp,
    ...(existing.intentDigest ? { intentDigest: existing.intentDigest } : {}),
    writebackOutcome: normalizedWriteback,
    readbackOutcome: normalizedReadback,
  };
  if (existing.appliedAt) {
    let readbackUpdated = false;
    if (!existing.verifiedAt && normalizedReadback.status === "succeeded") {
      existing.verifiedAt = timestamp;
      existing.receipts.push({ ...receipt, writebackOutcome: { status: "succeeded", effectIds: [] } });
      run.updatedAt = timestamp;
      changedState(state, timestamp);
      readbackUpdated = true;
    }
    return {
      state,
      result: { recorded: readbackUpdated, deduplicated: true, shouldApply: false, readbackUpdated, effectId: expectedEffectId },
    };
  }
  const sameAttempt = existing.receipts.find((item) => item.attemptNo === attemptNo);
  if (sameAttempt) {
    if (canonicalJson(sameAttempt.writebackOutcome) === canonicalJson(normalizedWriteback)
      && canonicalJson(sameAttempt.readbackOutcome) === canonicalJson(normalizedReadback)) {
      return { state, result: { recorded: false, deduplicated: true, shouldApply: false, readbackUpdated: false, effectId: expectedEffectId } };
    }
    fail("EFFECT_RECEIPT_CONFLICT", "同一尝试不能改写已有的效果回执", { effectId: expectedEffectId, attemptNo });
  }
  if (existing.preparedAttemptNo !== attemptNo || !existing.preparedAt) {
    fail("EFFECT_NOT_PREPARED", "效果未由当前尝试准备；必须先回读现场再决定是否重试", { effectId: expectedEffectId });
  }
  existing.receipts.push(receipt);
  existing.preparedAt = null;
  existing.preparedAttemptNo = null;
  if (normalizedWriteback.status !== "succeeded") delete existing.intentDigest;
  if (normalizedWriteback.status === "succeeded") existing.appliedAt = timestamp;
  if (normalizedWriteback.status === "succeeded" && normalizedReadback.status === "succeeded") existing.verifiedAt = timestamp;
  run.updatedAt = timestamp;
  let nextState = state;
  let writebackEventId = null;
  if (normalizedType === "task.writeback" && normalizedWriteback.status === "succeeded") {
    const execution = executionIdentityFromAttempt(attemptFor(run, attemptNo));
    const linked = appendExecutionLinkEventState(state, {
      eventType: "writeback",
      ...execution,
      taskId: context.primaryTaskId,
      runId: context.runId,
      attemptNo,
      effectId: expectedEffectId,
    }, timestamp);
    nextState = linked.state;
    writebackEventId = linked.result.eventId;
  } else {
    changedState(state, timestamp);
  }
  return {
    state: nextState,
    result: {
      recorded: true,
      deduplicated: false,
      shouldApply: false,
      readbackUpdated: false,
      effectId: expectedEffectId,
      writebackEventId,
    },
  };
}

function assertPreparedRecoveryAttempt(run, effect, recoveringAttemptNo) {
  if (!effect?.preparedAt || !effect.preparedAttemptNo || effect.appliedAt) {
    fail("EFFECT_NOT_RECONCILABLE", "只有遗留在 prepared 状态的效果可以通过权威回读恢复");
  }
  const originalAttemptNo = effect.preparedAttemptNo;
  if (recoveringAttemptNo <= originalAttemptNo) {
    fail("RECOVERY_ATTEMPT_REQUIRED", "prepared 效果只能由更高 attemptNo 的恢复尝试处理", {
      originalAttemptNo,
      recoveringAttemptNo,
    });
  }
  const originalAttempt = attemptFor(run, originalAttemptNo);
  if (!new Set(["lease-expired", "settled"]).has(originalAttempt.status)) {
    fail("PREVIOUS_ATTEMPT_ACTIVE", "原 prepared 尝试尚未失效，拒绝恢复者接管效果", {
      originalAttemptNo,
      status: originalAttempt.status,
    });
  }
  return { originalAttemptNo, originalAttempt };
}

export function reconcileRuntimeEffectState(inputState, {
  runId,
  attemptNo,
  owner,
  primaryTaskId,
  executorRoleId,
  eligibilityKeyHash: claimedEligibilityKeyHash,
  effectType,
  target,
  effectId,
  intentDigest,
  writebackOutcome,
  readbackOutcome,
  reconciliationEvidence,
  now = new Date(),
}) {
  const state = cloneLedger(inputState);
  const context = assertRuntimeRunContextState(state, {
    runId,
    attemptNo,
    owner,
    primaryTaskId,
    executorRoleId,
    eligibilityKeyHash: claimedEligibilityKeyHash,
    now,
  });
  const run = runFor(state, context.runId);
  const identity = effectIdentity(effectType, target, effectId);
  const effect = run.effects[identity.effectId];
  const normalizedIntentDigest = optionalIntentDigest(intentDigest);
  if (identity.effectType.startsWith("task.") && !normalizedIntentDigest) {
    fail("EFFECT_INTENT_REQUIRED", "任务原件效果对账必须带预绑定提议摘要", { effectId: identity.effectId });
  }
  if (normalizedIntentDigest && effect?.intentDigest !== normalizedIntentDigest) {
    fail("EFFECT_PAYLOAD_CONFLICT", "对账回执与预先绑定的提议摘要不一致", { effectId: identity.effectId });
  }
  const { originalAttemptNo, originalAttempt } = assertPreparedRecoveryAttempt(run, effect, attemptNo);
  const normalizedWriteback = sanitizeWritebackOutcome(writebackOutcome);
  const normalizedReadback = sanitizeReadbackOutcome(readbackOutcome);
  if (normalizedWriteback.status !== "succeeded" || normalizedWriteback.effectIds.length
    || normalizedReadback.status !== "succeeded" || normalizedReadback.effectIds.length) {
    fail("INVALID_RECONCILIATION_OUTCOME", "权威回读补账必须明确证明写回和回读都成功");
  }
  const normalizedEvidence = sanitizeReconciliationEvidence(reconciliationEvidence);
  if (normalizedEvidence.kind !== "authoritative-readback") {
    fail("INVALID_RECONCILIATION_EVIDENCE", "成功补账必须使用 authoritative-readback；未应用证明应走负回读释放 API");
  }
  const receipt = {
    attemptNo: originalAttemptNo,
    reconciledByAttemptNo: attemptNo,
    recordedAt: context.checkedAt,
    ...(effect.intentDigest ? { intentDigest: effect.intentDigest } : {}),
    writebackOutcome: normalizedWriteback,
    readbackOutcome: normalizedReadback,
    reconciliationEvidence: normalizedEvidence,
  };
  effect.receipts.push(receipt);
  effect.preparedAt = null;
  effect.preparedAttemptNo = null;
  effect.appliedAt = context.checkedAt;
  effect.verifiedAt = context.checkedAt;
  run.updatedAt = context.checkedAt;
  let nextState = state;
  let writebackEventId = null;
  if (identity.effectType === "task.writeback") {
    const execution = executionIdentityFromAttempt(originalAttempt);
    const linked = appendExecutionLinkEventState(state, {
      eventType: "writeback",
      ...execution,
      taskId: context.primaryTaskId,
      runId: context.runId,
      attemptNo: originalAttemptNo,
      effectId: identity.effectId,
    }, context.checkedAt);
    nextState = linked.state;
    writebackEventId = linked.result.eventId;
  } else {
    changedState(state, context.checkedAt);
  }
  return {
    state: nextState,
    result: {
      reconciled: true,
      effectId: identity.effectId,
      originalAttemptNo,
      reconciledByAttemptNo: attemptNo,
      writebackEventId,
      receipt: structuredClone(receipt),
    },
  };
}

export function releaseRuntimeEffectPreparationState(inputState, {
  runId,
  attemptNo,
  owner,
  primaryTaskId,
  executorRoleId,
  eligibilityKeyHash: claimedEligibilityKeyHash,
  effectType,
  target,
  effectId,
  intentDigest,
  retireEffect = false,
  reconciliationEvidence,
  now = new Date(),
}) {
  const state = cloneLedger(inputState);
  const context = assertRuntimeRunContextState(state, {
    runId,
    attemptNo,
    owner,
    primaryTaskId,
    executorRoleId,
    eligibilityKeyHash: claimedEligibilityKeyHash,
    now,
  });
  const run = runFor(state, context.runId);
  const identity = effectIdentity(effectType, target, effectId);
  if (typeof retireEffect !== "boolean") fail("INVALID_ARGUMENT", "retireEffect 必须是布尔值");
  if (retireEffect && identity.effectType !== "task.selfScheduleReview") {
    fail("INVALID_ARGUMENT", "只有明确被新提议省略的自排复验效果可退役");
  }
  const effect = run.effects[identity.effectId];
  const normalizedIntentDigest = optionalIntentDigest(intentDigest);
  if (identity.effectType.startsWith("task.") && !normalizedIntentDigest) {
    fail("EFFECT_INTENT_REQUIRED", "任务原件效果负回读必须带原预绑定摘要", { effectId: identity.effectId });
  }
  if (normalizedIntentDigest && effect?.intentDigest !== normalizedIntentDigest) {
    fail("EFFECT_PAYLOAD_CONFLICT", "负回读释放与预先绑定的提议摘要不一致", { effectId: identity.effectId });
  }
  const { originalAttemptNo } = assertPreparedRecoveryAttempt(run, effect, attemptNo);
  const normalizedEvidence = sanitizeReconciliationEvidence(reconciliationEvidence);
  if (normalizedEvidence.kind !== "authoritative-negative-readback") {
    fail("INVALID_RECONCILIATION_EVIDENCE", "释放 prepared 占位必须使用 authoritative-negative-readback");
  }
  const receipt = {
    attemptNo: originalAttemptNo,
    reconciledByAttemptNo: attemptNo,
    recordedAt: context.checkedAt,
    ...(effect.intentDigest ? { intentDigest: effect.intentDigest } : {}),
    writebackOutcome: { status: "failed", effectIds: [], reasonCode: "authoritative-not-applied" },
    readbackOutcome: { status: "succeeded", effectIds: [], reasonCode: "authoritative-negative-readback" },
    reconciliationEvidence: normalizedEvidence,
  };
  effect.receipts.push(receipt);
  effect.preparedAt = null;
  effect.preparedAttemptNo = null;
  delete effect.intentDigest;
  if (retireEffect) effect.retiredAt = context.checkedAt;
  run.updatedAt = context.checkedAt;
  changedState(state, context.checkedAt);
  return {
    state,
    result: {
      released: true,
      deduplicated: false,
      effectId: identity.effectId,
      originalAttemptNo,
      releasedByAttemptNo: attemptNo,
      receipt: structuredClone(receipt),
    },
  };
}

/**
 * Close one expired runtime attempt without creating a replacement attempt.
 * `recoveredEffects` is intentionally narrow: callers may turn an existing
 * prepared/applied effect into a verified effect after authoritative positive
 * readback. The sole missing-effect exception is a required
 * `task.selfScheduleReview` reconstructed with `authoritative-dual-source`,
 * after the recovery scanner has proved the task line and its unique trigger
 * carry the same schedule. This path never invents start evidence or writes a
 * business source.
 */
export function recoverExpiredRuntimeRunState(inputState, {
  runId,
  attemptNo,
  recoveredEffects = [],
  requiredEffects = [],
  now = new Date(),
}) {
  const state = cloneLedger(inputState);
  const run = runFor(state, runId);
  const timestamp = normalizeTime(now, "now");
  const nowMs = Date.parse(timestamp);
  const normalizedAttemptNo = positiveAttemptNo(attemptNo);
  if (run.currentAttemptNo !== normalizedAttemptNo) {
    fail("ATTEMPT_NOT_CURRENT", "过期恢复只能处理运行账中的当前尝试", {
      expectedAttemptNo: run.currentAttemptNo,
      attemptNo: normalizedAttemptNo,
    });
  }
  const wasSettled = run.status === "settled";
  if (!wasSettled && (!run.lease || leaseIsActive(run.lease, nowMs))) {
    fail("LEASE_ACTIVE", "过期恢复绝不能处理仍持有活租约的运行", {
      runId: run.runId,
      attemptNo: normalizedAttemptNo,
      expiresAt: run.lease?.expiresAt,
    });
  }
  if (!Array.isArray(recoveredEffects) || recoveredEffects.length > RUNTIME_LEDGER_LIMITS.maxEffectsPerRun) {
    fail("INVALID_ARGUMENT", "recoveredEffects 必须是有界数组");
  }
  if (!Array.isArray(requiredEffects) || requiredEffects.length > RUNTIME_LEDGER_LIMITS.maxEffectsPerRun) {
    fail("INVALID_ARGUMENT", "requiredEffects 必须是有界数组");
  }

  const requiredEffectIds = new Set(activeRuntimeEffects(run).map((effect) => effect.effectId));
  for (const [index, raw] of requiredEffects.entries()) {
    assertRecord(raw, `requiredEffects[${index}]`);
    const allowed = new Set(["effectType", "target", "effectId"]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length) fail("INVALID_ARGUMENT", "恢复必需效果含非白名单字段", { fields: unknown.sort() });
    const identity = effectIdentity(raw.effectType, raw.target, raw.effectId);
    if (identity.effectType.startsWith("task.") && !identity.target.endsWith(`#${run.eligibilityKey.taskId}`)) {
      fail("TASK_MISMATCH", "恢复必需效果目标不属于当前任务", { effectId: identity.effectId });
    }
    requiredEffectIds.add(identity.effectId);
  }

  const recoveredEffectIds = [];
  const seenEffectIds = new Set();
  for (const [index, raw] of recoveredEffects.entries()) {
    assertRecord(raw, `recoveredEffects[${index}]`);
    const allowed = new Set([
      "effectType", "target", "effectId", "intentDigest", "sourceAttemptNo", "reconciliationEvidence", "recoveryMode",
    ]);
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length) fail("INVALID_ARGUMENT", "过期恢复效果含非白名单字段", { fields: unknown.sort() });
    const identity = effectIdentity(raw.effectType, raw.target, raw.effectId);
    const recoveredIntentDigest = optionalIntentDigest(raw.intentDigest);
    if (identity.effectType.startsWith("task.") && !identity.target.endsWith(`#${run.eligibilityKey.taskId}`)) {
      fail("TASK_MISMATCH", "权威回读效果目标不属于当前任务", { effectId: identity.effectId });
    }
    if (seenEffectIds.has(identity.effectId)) fail("INVALID_ARGUMENT", "过期恢复效果重复", { effectId: identity.effectId });
    seenEffectIds.add(identity.effectId);
    const sourceAttemptNo = positiveAttemptNo(raw.sourceAttemptNo, `recoveredEffects[${index}].sourceAttemptNo`);
    if (sourceAttemptNo > normalizedAttemptNo) fail("INVALID_RECOVERY_EVIDENCE", "源回执不能来自未来尝试");
    const sourceAttempt = attemptFor(run, sourceAttemptNo);
    if (!sourceAttempt.startEvidence) fail("RUN_NOT_STARTED", "权威效果回读不能替代可信启动证据", { sourceAttemptNo });
    if (sourceAttemptNo < normalizedAttemptNo && !new Set(["lease-expired", "settled"]).has(sourceAttempt.status)) {
      fail("PREVIOUS_ATTEMPT_ACTIVE", "权威效果回读引用的旧尝试尚未失效", { sourceAttemptNo, status: sourceAttempt.status });
    }
    const evidence = sanitizeReconciliationEvidence(raw.reconciliationEvidence);
    if (evidence.kind !== "authoritative-readback") {
      fail("INVALID_RECONCILIATION_EVIDENCE", "过期运行补账只接受 authoritative-readback 正向证据");
    }
    let effect = run.effects[identity.effectId];
    if (!effect) {
      if (raw.recoveryMode !== "authoritative-dual-source" || identity.effectType !== "task.selfScheduleReview"
        || !requiredEffectIds.has(identity.effectId)) {
        fail("UNKNOWN_EFFECT", "权威回读不能凭空创建未准备的效果", { effectId: identity.effectId });
      }
      effect = {
        ...identity,
        ...(recoveredIntentDigest ? { intentDigest: recoveredIntentDigest } : {}),
        createdAt: timestamp,
        preparedAt: null,
        preparedAttemptNo: null,
        appliedAt: null,
        verifiedAt: null,
        receipts: [],
      };
      run.effects[identity.effectId] = effect;
    } else if (raw.recoveryMode !== undefined) {
      fail("INVALID_ARGUMENT", "已有运行效果不能声明缺失效果恢复模式", { effectId: identity.effectId });
    }
    if (effect.effectType !== identity.effectType || effect.target !== identity.target) {
      fail("EFFECT_ID_COLLISION", "过期恢复效果身份冲突", { effectId: identity.effectId });
    }
    if (identity.effectType.startsWith("task.")) {
      if (!recoveredIntentDigest || !effect.intentDigest) {
        fail("EFFECT_INTENT_UNBOUND", "任务效果恢复缺少 mutation 前绑定的提议摘要", { effectId: identity.effectId });
      }
      if (effect.intentDigest !== recoveredIntentDigest) {
        fail("EFFECT_PAYLOAD_CONFLICT", "源回执摘要与运行账预绑定提议不一致", { effectId: identity.effectId });
      }
    }
    if (!effect.appliedAt) {
      if (raw.recoveryMode !== "authoritative-dual-source"
        && (!effect.preparedAt || effect.preparedAttemptNo !== sourceAttemptNo)) {
        fail("EFFECT_NOT_RECONCILABLE", "正向回读必须对应同一源尝试留下的 prepared 效果", {
          effectId: identity.effectId,
          sourceAttemptNo,
          preparedAttemptNo: effect.preparedAttemptNo,
        });
      }
    } else if (!effect.receipts.some((receipt) => receipt.attemptNo === sourceAttemptNo
      && receipt.writebackOutcome.status === "succeeded")) {
      fail("INVALID_RECOVERY_EVIDENCE", "已写回效果的源 attemptNo 必须绑定原成功回执", {
        effectId: identity.effectId,
        sourceAttemptNo,
      });
    }
    if (!effect.verifiedAt) {
      effect.receipts.push({
        attemptNo: sourceAttemptNo,
        recordedAt: timestamp,
        ...(effect.intentDigest ? { intentDigest: effect.intentDigest } : {}),
        writebackOutcome: { status: "succeeded", effectIds: [] },
        readbackOutcome: { status: "succeeded", effectIds: [] },
        reconciliationEvidence: evidence,
      });
      effect.preparedAt = null;
      effect.preparedAttemptNo = null;
      effect.appliedAt ??= timestamp;
      effect.verifiedAt = timestamp;
      recoveredEffectIds.push(identity.effectId);
    }
  }

  const effects = activeRuntimeEffects(run);
  const appliedEffectIds = effects.filter((effect) => effect.appliedAt).map((effect) => effect.effectId).sort();
  const verifiedEffectIds = effects.filter((effect) => effect.verifiedAt).map((effect) => effect.effectId).sort();
  const hasMainWriteback = effects.some((effect) => effect.effectType === "task.writeback" && effect.appliedAt && effect.verifiedAt);
  const missingRequiredEffectIds = [...requiredEffectIds]
    .filter((effectId) => !run.effects[effectId]?.appliedAt || !run.effects[effectId]?.verifiedAt)
    .sort();
  const allApplied = requiredEffectIds.size > 0
    && [...requiredEffectIds].every((effectId) => Boolean(run.effects[effectId]?.appliedAt));
  const allVerified = allApplied
    && [...requiredEffectIds].every((effectId) => Boolean(run.effects[effectId]?.verifiedAt));
  const recoveredCompletely = hasMainWriteback && allVerified;
  const attempt = attemptFor(run, normalizedAttemptNo);
  const processOutcome = wasSettled
    ? structuredClone(attempt.processOutcome)
    : attempt.startEvidence
      ? { status: "unknown", reasonCode: "lease-expired" }
      : { status: "not-started", reasonCode: "lease-expired-before-start" };
  const writebackOutcome = appliedEffectIds.length
    ? { status: allApplied ? "succeeded" : "partial", effectIds: appliedEffectIds, reasonCode: "runtime-recovery" }
    : { status: "failed", effectIds: [], reasonCode: "trusted-writeback-missing" };
  const readbackOutcome = verifiedEffectIds.length
    ? { status: allVerified ? "succeeded" : "partial", effectIds: verifiedEffectIds, reasonCode: "runtime-recovery" }
    : { status: "failed", effectIds: [], reasonCode: "trusted-readback-missing" };
  const recoveryCode = recoveredCompletely ? "runtime-recovery-complete" : "runtime-recovery-incomplete";
  const preservedErrors = (wasSettled ? attempt.errors : [])
    .filter((error) => !(error.stage === "recovery" && error.source === "runtime-recovery"))
    .map((error) => recoveredCompletely ? { ...error, retryable: false } : error);
  const previousRecoveryError = attempt.errors.find((error) => error.code === recoveryCode
    && error.stage === "recovery" && error.source === "runtime-recovery");
  const errors = [...preservedErrors, previousRecoveryError || {
    code: recoveryCode,
    stage: "recovery",
    retryable: !recoveredCompletely,
    at: timestamp,
    source: "runtime-recovery",
  }];
  const baseChanged = !wasSettled || recoveredEffectIds.length > 0
    || canonicalJson(attempt.writebackOutcome) !== canonicalJson(writebackOutcome)
    || canonicalJson(attempt.readbackOutcome) !== canonicalJson(readbackOutcome)
    || canonicalJson(attempt.errors) !== canonicalJson(errors);
  if (baseChanged) {
    attempt.status = "settled";
    attempt.settledAt ??= timestamp;
    attempt.processOutcome = processOutcome;
    attempt.writebackOutcome = writebackOutcome;
    attempt.readbackOutcome = readbackOutcome;
    attempt.errors = errors;
    run.status = "settled";
    run.lease = null;
    run.updatedAt = timestamp;
    changedState(state, timestamp);
  }

  let nextState = state;
  let eventChanged = false;
  const linkEventIds = [];
  for (const sourceAttempt of nextState.runs[run.runId].attempts) {
    if (!sourceAttempt.startEvidence) continue;
    const existing = nextState.executionLinkEvents.find((event) => event.eventType === "link"
      && event.runId === run.runId && event.attemptNo === sourceAttempt.attemptNo);
    if (existing) {
      linkEventIds.push(existing.eventId);
      continue;
    }
    const execution = executionIdentityFromAttempt(sourceAttempt);
    const linked = appendExecutionLinkEventState(nextState, {
      eventType: "link",
      ...execution,
      taskId: run.eligibilityKey.taskId,
      relation: "primary",
      runId: run.runId,
      attemptNo: sourceAttempt.attemptNo,
      relationCursor: `attempt:${sourceAttempt.attemptNo}`,
    }, timestamp);
    nextState = linked.state;
    eventChanged ||= linked.result.appended;
    linkEventIds.push(linked.result.eventId);
  }

  const writebackEventIds = [];
  for (const effect of Object.values(nextState.runs[run.runId].effects)) {
    if (effect.effectType !== "task.writeback" || !effect.appliedAt) continue;
    const receipt = effect.receipts.find((item) => item.writebackOutcome.status === "succeeded");
    if (!receipt) continue;
    const sourceAttempt = attemptFor(nextState.runs[run.runId], receipt.attemptNo);
    const execution = executionIdentityFromAttempt(sourceAttempt);
    const linked = appendExecutionLinkEventState(nextState, {
      eventType: "writeback",
      ...execution,
      taskId: run.eligibilityKey.taskId,
      runId: run.runId,
      attemptNo: receipt.attemptNo,
      effectId: effect.effectId,
    }, timestamp);
    nextState = linked.state;
    eventChanged ||= linked.result.appended;
    writebackEventIds.push(linked.result.eventId);
  }

  const endedLinks = new Set(nextState.executionLinkEvents
    .filter((event) => event.eventType === "end")
    .map((event) => event.linkEventId));
  const missingEndLinks = nextState.executionLinkEvents
    .filter((event) => event.eventType === "link" && event.runId === run.runId && !endedLinks.has(event.eventId));
  const endEventIds = [];
  for (const link of missingEndLinks) {
    const ended = appendExecutionLinkEventState(nextState, {
      eventType: "end",
      linkEventId: link.eventId,
      reasonCode: recoveredCompletely ? "expired-run-recovered" : "expired-run-incomplete",
    }, timestamp);
    nextState = ended.state;
    eventChanged ||= ended.result.appended;
    endEventIds.push(ended.result.eventId);
  }

  return {
    state: nextState,
    result: {
      settled: true,
      deduplicated: !baseChanged && !eventChanged,
      runId: run.runId,
      attemptNo: normalizedAttemptNo,
      reconciledSettledRun: wasSettled,
      recoveredCompletely,
      retryable: !recoveredCompletely,
      recoveredEffectIds: recoveredEffectIds.sort(),
      requiredEffectIds: [...requiredEffectIds].sort(),
      missingRequiredEffectIds,
      linkEventIds: [...new Set(linkEventIds)].sort(),
      writebackEventIds: [...new Set(writebackEventIds)].sort(),
      endEventIds: endEventIds.sort(),
      processOutcome: structuredClone(processOutcome),
      writebackOutcome: structuredClone(writebackOutcome),
      readbackOutcome: structuredClone(readbackOutcome),
    },
  };
}

export function settleRuntimeState(inputState, {
  runId,
  attemptNo,
  owner,
  processOutcome,
  writebackOutcome,
  readbackOutcome,
  errors = [],
  now = new Date(),
}) {
  const state = cloneLedger(inputState);
  const run = runFor(state, runId);
  const attempt = attemptFor(run, attemptNo);
  const timestamp = normalizeTime(now, "now");
  const normalizedProcess = sanitizeProcessOutcome(processOutcome);
  const normalizedWriteback = sanitizeWritebackOutcome(writebackOutcome);
  const normalizedReadback = sanitizeReadbackOutcome(readbackOutcome);
  const normalizedErrors = sanitizeRuntimeErrors(errors, timestamp);

  if (attempt.status === "settled") {
    const same = canonicalJson({
      processOutcome: attempt.processOutcome,
      writebackOutcome: attempt.writebackOutcome,
      readbackOutcome: attempt.readbackOutcome,
      errors: attempt.errors,
    }) === canonicalJson({
      processOutcome: normalizedProcess,
      writebackOutcome: normalizedWriteback,
      readbackOutcome: normalizedReadback,
      errors: normalizedErrors,
    });
    if (same) return { state, result: { settled: false, deduplicated: true, runId: run.runId, attemptNo } };
    fail("SETTLEMENT_CONFLICT", "同一尝试不能用不同结果重复结算", { runId: run.runId, attemptNo });
  }

  assertCurrentLease(run, { owner, attemptNo, now: timestamp });
  if (!attempt.startEvidence && normalizedProcess.status !== "not-started") {
    fail("RUN_NOT_STARTED", "没有可信启动回执的尝试只能结算为 not-started");
  }
  if (normalizedProcess.status === "succeeded" && normalizedProcess.exitCode !== undefined && normalizedProcess.exitCode !== 0) {
    fail("INVALID_OUTCOME", "进程 succeeded 不能带非零退出码");
  }
  if (normalizedProcess.status === "failed" && normalizedProcess.exitCode === 0) {
    fail("INVALID_OUTCOME", "进程 failed 不能带零退出码");
  }
  validateEffectOutcomes(run, normalizedWriteback, normalizedReadback);
  attempt.status = "settled";
  attempt.settledAt = timestamp;
  attempt.processOutcome = normalizedProcess;
  attempt.writebackOutcome = normalizedWriteback;
  attempt.readbackOutcome = normalizedReadback;
  attempt.errors = normalizedErrors;
  run.status = "settled";
  run.lease = null;
  run.updatedAt = timestamp;
  changedState(state, timestamp);
  const trustedCompletion = attemptHasTrustedCompletion(run, attempt);
  return { state, result: { settled: true, deduplicated: false, trustedCompletion, runId: run.runId, attemptNo } };
}

function normalizeExecutionIdentity(raw) {
  return {
    platformId: machineCode(raw.platformId, "platformId", 128),
    executionId: machineCode(raw.executionId, "executionId", 256),
  };
}

function executionIdentityFromAttempt(attempt) {
  const evidence = attempt?.startEvidence;
  if (!evidence) fail("RUN_NOT_STARTED", "执行关联必须对应可信启动回执");
  if (evidence.kind === "platform-execution") {
    return { platformId: evidence.platformId, executionId: evidence.executionId };
  }
  if (evidence.kind === "protocol-handshake") {
    return { platformId: evidence.source, executionId: `${evidence.protocol}:${evidence.receiptId}` };
  }
  return { platformId: evidence.source, executionId: `${evidence.eventType}:${evidence.eventId}` };
}

function positiveAttemptNo(value, name = "attemptNo") {
  if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_ARGUMENT", `${name} 必须是正整数`);
  return value;
}

function normalizeExecutionLinkEvent(raw) {
  assertRecord(raw, "executionLinkEvent");
  const eventType = machineCode(raw.eventType, "eventType", 32);
  if (!new Set(["link", "writeback", "end"]).has(eventType)) fail("INVALID_EVENT", "执行关联事件只允许 link、writeback 或 end");
  if (eventType === "end") {
    return {
      eventType,
      linkEventId: machineCode(raw.linkEventId, "linkEventId", 128),
      ...(normalizedReasonCode(raw.reasonCode) ? { reasonCode: normalizedReasonCode(raw.reasonCode) } : {}),
    };
  }
  const identity = normalizeExecutionIdentity(raw);
  const result = {
    eventType,
    ...identity,
    taskId: machineCode(raw.taskId, "taskId", 256),
  };
  if (eventType === "link") {
    result.relation = machineCode(raw.relation, "relation", 64);
    const runId = optionalMachineCode(raw.runId, "runId", 128);
    const relationCursor = optionalMachineCode(raw.relationCursor, "relationCursor", 256);
    if (runId) {
      result.runId = runId;
      result.attemptNo = positiveAttemptNo(raw.attemptNo, "executionLinkEvent.attemptNo");
      result.relationCursor = relationCursor ?? `${runId}:${result.attemptNo}`;
    } else {
      if (!relationCursor) fail("INVALID_EVENT", "无 runId 的 link 事件必须提供稳定 relationCursor");
      result.relationCursor = relationCursor;
    }
  } else {
    result.runId = machineCode(raw.runId, "runId", 128);
    result.attemptNo = positiveAttemptNo(raw.attemptNo, "executionLinkEvent.attemptNo");
    result.effectId = machineCode(raw.effectId, "effectId", 128);
  }
  return result;
}

export function stableExecutionLinkEventId(raw) {
  const event = normalizeExecutionLinkEvent(raw);
  const identity = event.eventType === "end"
    ? { eventType: event.eventType, linkEventId: event.linkEventId }
    : event;
  return `execution_${event.eventType}_${digest(identity)}`;
}

export function appendExecutionLinkEventState(inputState, rawEvent, now = new Date()) {
  const state = cloneLedger(inputState);
  const event = normalizeExecutionLinkEvent(rawEvent);
  const eventId = stableExecutionLinkEventId(event);
  if (event.eventType === "end") {
    const link = state.executionLinkEvents.find((item) => item.eventId === event.linkEventId && item.eventType === "link");
    if (!link) fail("LINK_NOT_FOUND", "end 事件必须指向已有 link 事件", { linkEventId: event.linkEventId });
  } else if (event.runId) {
    const run = runFor(state, event.runId);
    if (run.eligibilityKey.taskId !== event.taskId) fail("TASK_MISMATCH", "执行关联的 taskId 与运行资格不一致");
    const attempt = attemptFor(run, event.attemptNo);
    const identity = executionIdentityFromAttempt(attempt);
    if (event.platformId !== identity.platformId || event.executionId !== identity.executionId) {
      fail("EXECUTION_MISMATCH", "执行关联身份与该尝试的可信启动回执不一致");
    }
    if (event.eventType === "writeback") {
      const effect = run.effects[event.effectId];
      if (!effect?.appliedAt || effect.effectType !== "task.writeback"
        || !effect.receipts.some((receipt) => receipt.attemptNo === event.attemptNo && receipt.writebackOutcome.status === "succeeded")) {
        fail("UNKNOWN_EFFECT", "writeback 事件必须引用同一尝试已经成功的 task.writeback 效果", { effectId: event.effectId });
      }
    }
  }
  const existing = state.executionLinkEvents.find((item) => item.eventId === eventId);
  if (existing) {
    const { eventId: ignoredEventId, recordedAt: ignoredRecordedAt, ...existingPayload } = existing;
    if (canonicalJson(existingPayload) !== canonicalJson(event)) fail("EVENT_CONFLICT", "同一执行关联事件身份出现冲突载荷", { eventId });
    return { state, result: { appended: false, deduplicated: true, eventId } };
  }
  const timestamp = normalizeTime(now, "now");
  state.executionLinkEvents.push({ eventId, ...event, recordedAt: timestamp });
  changedState(state, timestamp);
  return { state, result: { appended: true, deduplicated: false, eventId } };
}

function parseLedgerSnapshot(text, source) {
  if (text === null) return { source, exists: false, valid: false, state: null, errorCode: null };
  try {
    const state = JSON.parse(text);
    validateRuntimeLedgerState(state);
    return { source, exists: true, valid: true, state, errorCode: null };
  } catch (error) {
    return {
      source,
      exists: true,
      valid: false,
      state: null,
      errorCode: error instanceof RuntimeLedgerError ? error.code : "INVALID_JSON",
    };
  }
}

export function selectRuntimeLedgerSnapshot({ primaryText = null, backupText = null, now = new Date() } = {}) {
  const primary = parseLedgerSnapshot(primaryText, "primary");
  const backup = parseLedgerSnapshot(backupText, "backup");
  const valid = [primary, backup].filter((candidate) => candidate.valid);
  if (!valid.length) {
    if (!primary.exists && !backup.exists) {
      return {
        state: createRuntimeLedgerState(now),
        source: "new",
        recovery: { primary: "missing", backup: "missing", healed: false },
        needsHealing: true,
      };
    }
    fail("LEDGER_UNRECOVERABLE", "运行账主副本均不可恢复", {
      primary: primary.errorCode ?? "missing",
      backup: backup.errorCode ?? "missing",
    });
  }
  if (primary.valid && backup.valid
    && primary.state.revision === backup.state.revision
    && canonicalJson(primary.state) !== canonicalJson(backup.state)) {
    fail("LEDGER_SPLIT_BRAIN", "运行账主副本处于同一修订但内容分叉，拒绝自动覆盖");
  }
  valid.sort((left, right) => right.state.revision - left.state.revision || (left.source === "primary" ? -1 : 1));
  const selected = valid[0];
  const selectedText = canonicalJson(selected.state);
  const primaryMatches = primary.valid && canonicalJson(primary.state) === selectedText;
  const backupMatches = backup.valid && canonicalJson(backup.state) === selectedText;
  return {
    state: structuredClone(selected.state),
    source: selected.source,
    recovery: {
      primary: primary.valid ? (primaryMatches ? "current" : "stale") : (primary.exists ? "corrupt" : "missing"),
      backup: backup.valid ? (backupMatches ? "current" : "stale") : (backup.exists ? "corrupt" : "missing"),
      healed: false,
    },
    needsHealing: !primaryMatches || !backupMatches,
  };
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM"]).has(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicReplace(filePath, content) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeLedgerPair(filePath, state) {
  validateRuntimeLedgerState(state);
  const content = `${JSON.stringify(state, null, 2)}\n`;
  await atomicReplace(`${filePath}.bak`, content);
  await atomicReplace(filePath, content);
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

async function removeStaleLock(lockPath, staleLockMs) {
  let text;
  let stat;
  try {
    [text, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  if (Date.now() - stat.mtimeMs <= staleLockMs) return false;
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    lock = null;
  }
  if (lock && await processIsAlive(lock.pid)) return false;
  const stalePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, stalePath);
    await fs.rm(stalePath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

async function withLedgerLock(filePath, callback, options = {}) {
  const lockPath = options.lockPath ?? `${filePath}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? 5_000;
  const retryMs = options.lockRetryMs ?? 10;
  const staleLockMs = options.staleLockMs ?? 30_000;
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = crypto.randomUUID();
  const startedAt = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = null;
      if (error?.code !== "EEXIST") throw error;
      if (await removeStaleLock(lockPath, staleLockMs)) continue;
      if (Date.now() - startedAt >= timeoutMs) fail("LOCK_TIMEOUT", "等待运行账进程锁超时");
      await sleep(retryMs);
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

async function loadLedgerUnlocked(filePath, now) {
  const [primaryText, backupText] = await Promise.all([readOptional(filePath), readOptional(`${filePath}.bak`)]);
  return selectRuntimeLedgerSnapshot({ primaryText, backupText, now });
}

function trustedClockNow(options = {}) {
  const value = typeof options.clock === "function" ? options.clock() : new Date();
  return normalizeTime(value, "clock");
}

function resolveLedgerFilePath(filePath, options = {}) {
  const supplied = singleLine(filePath, "filePath", 4_096);
  if (!path.isAbsolute(supplied)) fail("INVALID_LEDGER_PATH", "运行账文件必须使用明确绝对路径");
  const absolute = path.resolve(supplied);
  if (options.allowedRoot) {
    const allowedRoot = path.resolve(singleLine(options.allowedRoot, "allowedRoot", 4_096));
    const relative = path.relative(allowedRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail("INVALID_LEDGER_PATH", "运行账文件超出允许的本机状态目录");
  }
  return absolute;
}

async function transactLedger(filePath, operation, options = {}) {
  return withLedgerLock(filePath, async () => {
    const operationTime = trustedClockNow(options);
    const loaded = await loadLedgerUnlocked(filePath, operationTime);
    const beforeRevision = loaded.state.revision;
    const outcome = await operation(loaded.state, operationTime);
    validateRuntimeLedgerState(outcome.state);
    if (loaded.needsHealing || outcome.state.revision !== beforeRevision) {
      await writeLedgerPair(filePath, outcome.state);
    }
    return { ...outcome.result, recovery: { ...loaded.recovery, healed: loaded.needsHealing } };
  }, options);
}

export async function readRuntimeLedger(filePath, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return withLedgerLock(absolute, async () => {
    const loaded = await loadLedgerUnlocked(absolute, trustedClockNow(options));
    if (loaded.needsHealing) await writeLedgerPair(absolute, loaded.state);
    return structuredClone(loaded.state);
  }, options);
}

export async function claimRuntimeRun(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => claimRuntimeState(state, { ...parameters, now }), options);
}

export async function renewRuntimeLease(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => renewRuntimeLeaseState(state, { ...parameters, now }), options);
}

export async function ackStarted(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => ackStartedState(state, { ...parameters, now }), options);
}

export async function assertRuntimeRunContext(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return withLedgerLock(absolute, async () => {
    const now = trustedClockNow(options);
    const loaded = await loadLedgerUnlocked(absolute, now);
    if (loaded.needsHealing) await writeLedgerPair(absolute, loaded.state);
    return assertRuntimeRunContextState(loaded.state, { ...parameters, now });
  }, options);
}

export async function prepareRuntimeEffect(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => prepareRuntimeEffectState(state, { ...parameters, now }), options);
}

export async function recordRuntimeEffect(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => recordRuntimeEffectState(state, { ...parameters, now }), options);
}

export async function reconcileRuntimeEffect(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => reconcileRuntimeEffectState(state, { ...parameters, now }), options);
}

export async function releaseRuntimeEffectPreparation(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => releaseRuntimeEffectPreparationState(state, { ...parameters, now }), options);
}

export async function recoverExpiredRuntimeRun(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => recoverExpiredRuntimeRunState(state, { ...parameters, now }), options);
}

export async function hasCommittedRuntimeEffect(filePath, { runId, effectId }, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return withLedgerLock(absolute, async () => {
    const loaded = await loadLedgerUnlocked(absolute, trustedClockNow(options));
    if (loaded.needsHealing) await writeLedgerPair(absolute, loaded.state);
    const run = runFor(loaded.state, runId);
    const normalizedEffectId = machineCode(effectId, "effectId", 128);
    return Boolean(run.effects[normalizedEffectId]?.appliedAt);
  }, options);
}

export async function runIdempotentRuntimeEffect(filePath, parameters, apply, options = {}) {
  if (typeof apply !== "function") fail("INVALID_ARGUMENT", "apply 必须是函数");
  const prepared = await prepareRuntimeEffect(filePath, parameters, options);
  if (!prepared.shouldApply) {
    return {
      duplicate: prepared.duplicate,
      deduplicated: prepared.duplicate,
      reconciliationRequired: prepared.reconciliationRequired,
      effectId: prepared.effectId,
      receipt: prepared.receipt ?? null,
    };
  }
  const idempotencyKey = `${parameters.runId}:${prepared.effectId}`;
  const applied = await apply({
    runId: parameters.runId,
    effectId: prepared.effectId,
    idempotencyKey,
  });
  const writebackOutcome = isRecord(applied?.writebackOutcome)
    ? applied.writebackOutcome
    : { status: "succeeded" };
  const readbackOutcome = isRecord(applied?.readbackOutcome)
    ? applied.readbackOutcome
    : { status: "unknown" };
  const recorded = await recordRuntimeEffect(filePath, {
    ...parameters,
    effectId: prepared.effectId,
    writebackOutcome,
    readbackOutcome,
  }, options);
  return {
    duplicate: false,
    deduplicated: false,
    reconciliationRequired: false,
    effectId: prepared.effectId,
    receipt: {
      writebackOutcome: sanitizeWritebackOutcome(writebackOutcome),
      readbackOutcome: sanitizeReadbackOutcome(readbackOutcome),
    },
    recorded: recorded.recorded,
  };
}

export async function settleRuntimeRun(filePath, parameters, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => settleRuntimeState(state, { ...parameters, now }), options);
}

export async function appendExecutionLinkEvent(filePath, event, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  return transactLedger(absolute, (state, now) => appendExecutionLinkEventState(state, event, now), options);
}

export async function inspectRuntimeLedger(filePath, options = {}) {
  const absolute = resolveLedgerFilePath(filePath, options);
  const [primaryText, backupText] = await Promise.all([readOptional(absolute), readOptional(`${absolute}.bak`)]);
  const selected = selectRuntimeLedgerSnapshot({ primaryText, backupText, now: trustedClockNow(options) });
  return {
    state: structuredClone(selected.state),
    source: selected.source,
    recovery: structuredClone(selected.recovery),
    needsHealing: selected.needsHealing,
  };
}

export function createRuntimeLedgerFileApi({
  filePath,
  allowedRoot = path.dirname(filePath),
  clock,
  lockPath,
  lockTimeoutMs,
  lockRetryMs,
  staleLockMs,
}) {
  const options = Object.freeze({
    allowedRoot,
    ...(clock ? { clock } : {}),
    ...(lockPath ? { lockPath } : {}),
    ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}),
    ...(lockRetryMs !== undefined ? { lockRetryMs } : {}),
    ...(staleLockMs !== undefined ? { staleLockMs } : {}),
  });
  const absolute = resolveLedgerFilePath(filePath, options);
  return Object.freeze({
    filePath: absolute,
    read: () => readRuntimeLedger(absolute, options),
    inspect: () => inspectRuntimeLedger(absolute, options),
    claim: (parameters) => claimRuntimeRun(absolute, parameters, options),
    renewLease: (parameters) => renewRuntimeLease(absolute, parameters, options),
    ackStarted: (parameters) => ackStarted(absolute, parameters, options),
    assertRunContext: (parameters) => assertRuntimeRunContext(absolute, parameters, options),
    prepareEffect: (parameters) => prepareRuntimeEffect(absolute, parameters, options),
    recordEffect: (parameters) => recordRuntimeEffect(absolute, parameters, options),
    reconcileEffect: (parameters) => reconcileRuntimeEffect(absolute, parameters, options),
    releaseEffectPreparation: (parameters) => releaseRuntimeEffectPreparation(absolute, parameters, options),
    recoverExpiredRun: (parameters) => recoverExpiredRuntimeRun(absolute, parameters, options),
    runIdempotentEffect: (parameters, apply) => runIdempotentRuntimeEffect(absolute, parameters, apply, options),
    hasCommittedEffect: (parameters) => hasCommittedRuntimeEffect(absolute, parameters, options),
    settle: (parameters) => settleRuntimeRun(absolute, parameters, options),
    appendExecutionLinkEvent: (event) => appendExecutionLinkEvent(absolute, event, options),
  });
}
