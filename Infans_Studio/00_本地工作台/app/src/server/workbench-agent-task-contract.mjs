import crypto from "node:crypto";
import path from "node:path";

export const AGENT_TASK_CONTRACT_VERSION = 1;
export const AGENT_TASK_CONTRACT_FIELD = "自动推进";
export const CURRENT_AUTOMATION_EXECUTOR_ROLE_ID = "agent-task-readonly-verifier";
export const LEGACY_AUTOMATION_EXECUTOR_IDS = Object.freeze(["codex-ai-acceptance"]);

export function isLegacyAutomationExecutor(executorId) {
  return LEGACY_AUTOMATION_EXECUTOR_IDS.includes(String(executorId || "").trim());
}

const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const EXECUTOR_ROLE_RE = /^[a-z0-9][a-z0-9-]{0,119}$/u;
const AUTHORIZATION_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const CONTRACT_LINE_RE = /^自动推进\s*[：:]\s*(.*)$/u;
const CONTRACT_LINE_CANDIDATE_RE = /^自动推进(?:\s*[：:]|\s*$)/u;
const CONTROL_LINE_RE = /^自动派发\s*[：:]\s*(.*)$/u;
const CONTROL_LINE_CANDIDATE_RE = /^自动派发(?:\s*[：:]|\s*$)/u;
const SENSITIVE_FILE_RE = /(^|[._ -])(credential|credentials|secret|secrets|token|tokens|password|passwd|api[-_]?key|private[-_]?key|recovery[-_]?code)([._ -]|$)/iu;
const SENSITIVE_ZH_RE = /(?:账号|凭据|密码|密钥|令牌|恢复码|银行卡)/u;
const VOLATILE_DETAIL_RE = /^(?:进展时间|当前状态|下一步|运行结果|运行结论|最近运行|自动验收|自动复核|自动复验|自然唤醒|自然运行|调度运行|回读结果|写回结果|证据结果|复验时间|完成时间)\s*[：:]/u;
const INTENT_DETAIL_RE = /^(?:目标|完成门|完成条件)\s*[：:]/u;
const COMPLETION_DETAIL_RE = /^(?:完成门|完成条件|自动完成门)\s*[：:]/u;
const AUTOMATIC_COMPLETION_DETAIL_RE = /^自动完成门\s*[：:]/u;
const TOP_LEVEL_FIELDS = Object.freeze(["version", "mode", "authorization", "lifecycle", "selfScheduleReview", "triggers"]);
const TRIGGER_FIELDS = Object.freeze({
  time: ["id", "type", "at"],
  dependency: ["id", "type", "taskId", "expected"],
  evidence: ["id", "type", "path", "expectedSha256"],
  all: ["id", "type", "conditions"],
});
const CONDITION_FIELDS = Object.freeze({
  time: ["type", "at"],
  dependency: ["type", "taskId", "expected"],
  evidence: ["type", "path", "expectedSha256"],
  all: ["type", "conditions"],
});

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

/** Deterministic JSON used only for identities; it never reads time or process state. */
export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function unknownFields(value, allowed, at, errors) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(issue("AUTOMATION_CONTRACT_FIELD_UNKNOWN", `${at} 含未知字段“${key}”。`, { at, field: key }));
  }
}

function normalizeIsoInstant(value, at, errors) {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) {
    errors.push(issue("AUTOMATION_TRIGGER_TIME_INVALID", `${at} 必须是带时区的 ISO 时刻。`, { at }));
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    errors.push(issue("AUTOMATION_TRIGGER_TIME_INVALID", `${at} 不是有效时刻。`, { at }));
    return null;
  }
  return new Date(timestamp).toISOString();
}

/**
 * Evidence paths are declarations, not a general file API. They must name one
 * normalized Vault-relative path and may not point at control/private secrets.
 */
export function validateVaultEvidencePath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_EMPTY", message: "证据路径不能为空。" };
  }
  const candidate = value.trim();
  if (hasUnpairedSurrogate(candidate)) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_INVALID", message: "证据路径含无效 Unicode 字符。" };
  }
  let encodedLength;
  try { encodedLength = encodeURIComponent(candidate).length; }
  catch {
    return { valid: false, path: null, code: "EVIDENCE_PATH_INVALID", message: "证据路径无法安全编码。" };
  }
  if (candidate.length > 500 || encodedLength > 1_000) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_TOO_LONG", message: "证据路径超过运行账安全上限。" };
  }
  if (candidate !== value || candidate.includes("\0") || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_INVALID", message: "证据路径含空白或控制字符。" };
  }
  if (candidate.includes("\\") || path.posix.isAbsolute(candidate) || /^[A-Za-z]:/u.test(candidate) || /^~(?:\/|$)/u.test(candidate) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_ABSOLUTE", message: "证据路径必须是 Vault 相对路径。" };
  }
  if (/[*?\[\]{}]/u.test(candidate)) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_GLOB", message: "证据路径必须指向具体对象，不能使用通配符。" };
  }
  if (/[`()<>!]/u.test(candidate)) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_MARKUP", message: "证据路径不能含会触发 Markdown 或 HTML 的字符。" };
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || path.posix.normalize(candidate) !== candidate) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_TRAVERSAL", message: "证据路径不能含空段、点段或越界段。" };
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_GIT", message: "证据路径不能进入 .git。" };
  }
  if (segments.includes("案头") || segments.includes("本人草稿")) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_DESKTOP", message: "证据路径不能进入本人草稿。" };
  }
  if (candidate.startsWith("00_本地工作台/派生数据/agent-task-runtime/")) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_RUNTIME_STATE", message: "运行账、结果提议和调度回执不能反向成为任务触发证据。" };
  }
  if (segments.some((segment) => {
    const lower = segment.toLowerCase();
    return lower === ".env" || lower.startsWith(".env.") || SENSITIVE_FILE_RE.test(segment) || SENSITIVE_ZH_RE.test(segment);
  })) {
    return { valid: false, path: null, code: "EVIDENCE_PATH_SENSITIVE", message: "证据路径疑似包含凭据或其它敏感认证材料。" };
  }
  return { valid: true, path: candidate, code: null, message: null };
}

function normalizeTrigger(value, options, errors) {
  const { at, topLevel, depth } = options;
  if (depth > 8) {
    errors.push(issue("AUTOMATION_TRIGGER_TOO_DEEP", `${at} 的复合条件嵌套过深。`, { at }));
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(issue("AUTOMATION_TRIGGER_INVALID", `${at} 必须是对象。`, { at }));
    return null;
  }
  const type = value.type;
  if (!Object.hasOwn(TRIGGER_FIELDS, type)) {
    errors.push(issue("AUTOMATION_TRIGGER_TYPE_INVALID", `${at} 的触发类型不受支持。`, { at, type }));
    return null;
  }
  unknownFields(value, topLevel ? TRIGGER_FIELDS[type] : CONDITION_FIELDS[type], at, errors);
  let id;
  if (topLevel) {
    if (typeof value.id !== "string" || !STABLE_ID_RE.test(value.id)) {
      errors.push(issue("AUTOMATION_TRIGGER_ID_INVALID", `${at} 必须有合法稳定 ID。`, { at, triggerId: value.id }));
    } else id = value.id;
  }
  if (topLevel && !id) return null;

  if (type === "time") {
    const normalizedAt = normalizeIsoInstant(value.at, `${at}.at`, errors);
    return normalizedAt ? { ...(id ? { id } : {}), type, at: normalizedAt } : null;
  }
  if (type === "dependency") {
    if (typeof value.taskId !== "string" || !STABLE_ID_RE.test(value.taskId)) {
      errors.push(issue("AUTOMATION_TRIGGER_TASK_ID_INVALID", `${at}.taskId 必须是合法稳定任务 ID。`, { at, taskId: value.taskId }));
    }
    if (!new Set(["completed", "open"]).has(value.expected)) {
      errors.push(issue("AUTOMATION_TRIGGER_EXPECTED_INVALID", `${at}.expected 只能是 completed 或 open。`, { at, expected: value.expected }));
    }
    if (typeof value.taskId !== "string" || !STABLE_ID_RE.test(value.taskId) || !new Set(["completed", "open"]).has(value.expected)) return null;
    return { ...(id ? { id } : {}), type, taskId: value.taskId, expected: value.expected };
  }
  if (type === "evidence") {
    const pathResult = validateVaultEvidencePath(value.path);
    if (!pathResult.valid) errors.push(issue(pathResult.code, `${at}.path：${pathResult.message}`, { at, evidencePath: value.path }));
    let expectedSha256;
    if (value.expectedSha256 !== undefined) {
      const normalized = typeof value.expectedSha256 === "string" ? value.expectedSha256.toLowerCase() : "";
      if (!SHA256_RE.test(normalized)) errors.push(issue("AUTOMATION_TRIGGER_SHA256_INVALID", `${at}.expectedSha256 必须是 64 位 SHA-256。`, { at }));
      else expectedSha256 = normalized;
    }
    if (!pathResult.valid || (value.expectedSha256 !== undefined && !expectedSha256)) return null;
    return { ...(id ? { id } : {}), type, path: pathResult.path, ...(expectedSha256 ? { expectedSha256 } : {}) };
  }

  if (!Array.isArray(value.conditions) || value.conditions.length === 0 || value.conditions.length > 32) {
    errors.push(issue("AUTOMATION_TRIGGER_CONDITIONS_INVALID", `${at}.conditions 必须是非空数组。`, { at }));
    return null;
  }
  const conditions = value.conditions.map((condition, index) => normalizeTrigger(condition, {
    at: `${at}.conditions[${index}]`,
    topLevel: false,
    depth: depth + 1,
  }, errors)).filter(Boolean);
  if (conditions.length !== value.conditions.length) return null;
  conditions.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return { ...(id ? { id } : {}), type, conditions };
}

function validateContractObject(value) {
  const errors = [];
  if (!isPlainObject(value)) return {
    valid: false,
    contract: null,
    errors: [issue("AUTOMATION_CONTRACT_INVALID", "自动推进 JSON 必须是对象。")],
  };
  unknownFields(value, TOP_LEVEL_FIELDS, "contract", errors);
  const version = value.version === undefined ? AGENT_TASK_CONTRACT_VERSION : value.version;
  if (version !== AGENT_TASK_CONTRACT_VERSION) errors.push(issue("AUTOMATION_CONTRACT_VERSION_UNSUPPORTED", "自动推进契约版本必须是 1。", { version }));
  if (value.mode !== "automatic") errors.push(issue("AUTOMATION_CONTRACT_MODE_INVALID", "自动推进 mode 必须是 automatic。", { mode: value.mode }));

  const authorization = [];
  if (!Array.isArray(value.authorization) || value.authorization.length === 0 || value.authorization.length > 32) {
    errors.push(issue("AUTOMATION_CONTRACT_AUTHORIZATION_INVALID", "automatic 任务必须声明非空 authorization 数组。"));
  } else {
    for (const permission of value.authorization) {
      if (typeof permission !== "string" || !AUTHORIZATION_RE.test(permission)) {
        errors.push(issue("AUTOMATION_CONTRACT_AUTHORIZATION_INVALID", "authorization 每一项都必须是有界、无控制字符的稳定能力标识。"));
      } else authorization.push(permission);
    }
    if (new Set(authorization).size !== authorization.length) errors.push(issue("AUTOMATION_CONTRACT_AUTHORIZATION_DUPLICATE", "authorization 不能含重复授权项。"));
  }
  authorization.sort((left, right) => left.localeCompare(right));

  if (!Number.isInteger(value.lifecycle) || value.lifecycle <= 0) errors.push(issue("AUTOMATION_CONTRACT_LIFECYCLE_INVALID", "lifecycle 必须是正整数。", { lifecycle: value.lifecycle }));
  if (typeof value.selfScheduleReview !== "boolean") errors.push(issue("AUTOMATION_CONTRACT_SELF_REVIEW_INVALID", "selfScheduleReview 必须是布尔值。"));

  const triggers = [];
  if (!Array.isArray(value.triggers) || value.triggers.length === 0 || value.triggers.length > 32) {
    errors.push(issue("AUTOMATION_CONTRACT_TRIGGERS_INVALID", "automatic 任务必须声明非空 triggers 数组。"));
  } else {
    for (let index = 0; index < value.triggers.length; index += 1) {
      const trigger = normalizeTrigger(value.triggers[index], { at: `contract.triggers[${index}]`, topLevel: true, depth: 0 }, errors);
      if (trigger) triggers.push(trigger);
    }
    const ids = triggers.map((trigger) => trigger.id);
    if (new Set(ids).size !== ids.length) errors.push(issue("AUTOMATION_TRIGGER_ID_DUPLICATE", "triggers 中的 ID 必须唯一。"));
  }
  triggers.sort((left, right) => left.id.localeCompare(right.id));

  if (errors.length) return { valid: false, contract: null, errors };
  return {
    valid: true,
    errors: [],
    contract: {
      version: AGENT_TASK_CONTRACT_VERSION,
      mode: "automatic",
      authorization,
      lifecycle: value.lifecycle,
      selfScheduleReview: value.selfScheduleReview,
      triggers,
    },
  };
}

/** Parse the one authoritative `自动推进：<JSON>` detail line. */
export function parseAgentTaskContract(details = []) {
  const lines = Array.isArray(details) ? details : Array.isArray(details?.details) ? details.details : [];
  const candidates = lines.map((line) => String(line).trim()).filter((line) => CONTRACT_LINE_CANDIDATE_RE.test(line));
  if (!candidates.length) return { present: false, valid: false, contract: null, errors: [] };
  if (candidates.length !== 1) return {
    present: true,
    valid: false,
    contract: null,
    errors: [issue("AUTOMATION_CONTRACT_CONFLICT", "任务只能有一行自动推进契约。", { count: candidates.length })],
  };
  const match = candidates[0].match(CONTRACT_LINE_RE);
  if (!match || !match[1]) return {
    present: true,
    valid: false,
    contract: null,
    errors: [issue("AUTOMATION_CONTRACT_LINE_INVALID", "自动推进行必须写成“自动推进：<JSON>”。")],
  };
  let parsed;
  try { parsed = JSON.parse(match[1]); }
  catch {
    return {
      present: true,
      valid: false,
      contract: null,
      errors: [issue("AUTOMATION_CONTRACT_JSON_INVALID", "自动推进 JSON 无法解析。")],
    };
  }
  return { present: true, ...validateContractObject(parsed) };
}

function taskExecutorRoleId(task) {
  return String(task?.executorRoleId || task?.executorId || "").trim();
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function taskObjectives(task) {
  const declared = (task?.details || [])
    .map((line) => String(line).trim())
    .filter((line) => /^目标\s*[：:]/u.test(line))
    .map(normalizeText)
    .filter(Boolean);
  if (declared.length) return declared;
  const direct = task?.objective ?? task?.displayText ?? task?.title;
  if (direct != null && normalizeText(direct)) return [normalizeText(direct)];
  return [normalizeText(String(task?.text || "").replace(/\s*[｜|]\s*(?:ID|父级|关联任务|依赖|功能|工作线|执行器|完成时间|复验时间)\s*[：:].*$/u, ""))].filter(Boolean);
}

function completionGates(task) {
  const direct = task?.completionGates ?? task?.completionGate;
  const values = Array.isArray(direct) ? direct : direct == null ? [] : [direct];
  const fromDetails = (task?.details || [])
    .map((line) => String(line).trim())
    .filter((line) => COMPLETION_DETAIL_RE.test(line) && !VOLATILE_DETAIL_RE.test(line));
  return [...new Set([...values, ...fromDetails].map(normalizeText).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function agentTaskCompletionGates(task) {
  return completionGates(task);
}

/**
 * A machine may close a task only when every completion gate was deliberately
 * declared machine-verifiable. Free-form “完成门” remains a human/project gate.
 */
export function agentTaskAutomaticCompletionGates(task) {
  return (task?.details || [])
    .map((line) => String(line).trim())
    .filter((line) => AUTOMATIC_COMPLETION_DETAIL_RE.test(line) && !VOLATILE_DETAIL_RE.test(line))
    .map(normalizeText)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

export function eligibilityIntent(task, contractInput) {
  const validation = contractInput?.valid !== undefined
    ? contractInput
    : contractInput?.mode
    ? validateContractObject(contractInput)
    : parseAgentTaskContract(task?.details || []);
  if (!validation.valid || !validation.contract) return null;
  return {
    version: AGENT_TASK_CONTRACT_VERSION,
    objectives: taskObjectives(task),
    completionGates: completionGates(task),
    executorRoleId: taskExecutorRoleId(task),
    authorization: validation.contract.authorization,
    mode: validation.contract.mode,
    lifecycle: validation.contract.lifecycle,
    selfScheduleReview: validation.contract.selfScheduleReview,
    triggers: validation.contract.triggers,
  };
}

/** Stable revision of construction intent only; run/progress output is excluded. */
export function computeEligibilityRevision(task, contractInput) {
  const intent = eligibilityIntent(task, contractInput);
  return intent ? `eligibility-revision-v1:${sha256(stableJson(intent))}` : null;
}

function lookup(source, key) {
  if (source instanceof Map) return source.get(key);
  return isPlainObject(source) ? source[key] : undefined;
}

function dependencyFact(value) {
  if (!isPlainObject(value)) return null;
  const status = value.status || value.state || (typeof value.done === "boolean" ? (value.done ? "completed" : "open") : null);
  const revision = value.revision ?? value.statusRevision ?? value.version;
  if (!new Set(["completed", "open"]).has(status) || revision === undefined || revision === null || !String(revision).trim()) return null;
  return { status, revision: String(revision).trim() };
}

function evidenceFact(value) {
  const sha = typeof value === "string" ? value : value?.sha256;
  const normalized = typeof sha === "string" ? sha.toLowerCase() : "";
  return SHA256_RE.test(normalized) ? { sha256: normalized } : null;
}

function cursorPart(value) {
  return encodeURIComponent(String(value));
}

/** Evaluate one normalized trigger against an explicit, read-only fact snapshot. */
export function evaluateAgentTaskTrigger(trigger, context = {}) {
  if (!isPlainObject(trigger) || !Object.hasOwn(TRIGGER_FIELDS, trigger.type)) {
    return { met: false, triggerCursor: null, observedCursor: null, reason: "TRIGGER_INVALID", nextWakeAt: null };
  }
  if (trigger.type === "time") {
    const dueAt = Date.parse(String(trigger.at || ""));
    const nowAt = context.now instanceof Date ? context.now.getTime() : Date.parse(String(context.now || ""));
    if (!Number.isFinite(dueAt) || !Number.isFinite(nowAt)) return { met: false, triggerCursor: null, observedCursor: null, reason: "TIME_FACT_INVALID", nextWakeAt: Number.isFinite(dueAt) ? new Date(dueAt).toISOString() : null };
    const cursor = `time:${new Date(dueAt).toISOString()}`;
    return nowAt >= dueAt
      ? { met: true, triggerCursor: cursor, observedCursor: cursor, reason: null, nextWakeAt: null }
      : { met: false, triggerCursor: null, observedCursor: cursor, reason: "TIME_NOT_REACHED", nextWakeAt: new Date(dueAt).toISOString() };
  }
  if (trigger.type === "dependency") {
    const fact = dependencyFact(lookup(context.dependencies || context.dependencyStates, trigger.taskId));
    if (!fact) return { met: false, triggerCursor: null, observedCursor: null, reason: "DEPENDENCY_FACT_MISSING", nextWakeAt: null };
    const cursor = `dependency:${cursorPart(trigger.taskId)}:${cursorPart(fact.revision)}`;
    return fact.status === trigger.expected
      ? { met: true, triggerCursor: cursor, observedCursor: cursor, reason: null, nextWakeAt: null }
      : { met: false, triggerCursor: null, observedCursor: cursor, reason: "DEPENDENCY_PREDICATE_UNMET", nextWakeAt: null };
  }
  if (trigger.type === "evidence") {
    const fact = evidenceFact(lookup(context.evidence || context.evidenceStates, trigger.path));
    if (!fact) return { met: false, triggerCursor: null, observedCursor: null, reason: "EVIDENCE_FACT_MISSING", nextWakeAt: null };
    const cursor = `evidence:${cursorPart(trigger.path)}:${fact.sha256}`;
    const met = !trigger.expectedSha256 || fact.sha256 === trigger.expectedSha256;
    return met
      ? { met: true, triggerCursor: cursor, observedCursor: cursor, reason: null, nextWakeAt: null }
      : { met: false, triggerCursor: null, observedCursor: cursor, reason: "EVIDENCE_PREDICATE_UNMET", nextWakeAt: null };
  }
  if (!Array.isArray(trigger.conditions) || !trigger.conditions.length) return { met: false, triggerCursor: null, observedCursor: null, reason: "ALL_CONDITIONS_INVALID", nextWakeAt: null, conditions: [] };
  const conditions = trigger.conditions.map((condition) => evaluateAgentTaskTrigger(condition, context));
  const observed = conditions.every((result) => result.observedCursor)
    ? `all:${sha256(stableJson(conditions.map((result) => result.observedCursor)))}`
    : null;
  if (conditions.some((result) => !result.met)) {
    const nextWakeAt = conditions.map((result) => result.nextWakeAt).filter(Boolean).sort()[0] || null;
    return { met: false, triggerCursor: null, observedCursor: observed, reason: "ALL_CONDITIONS_UNMET", nextWakeAt, conditions };
  }
  return { met: true, triggerCursor: observed, observedCursor: observed, reason: null, nextWakeAt: null, conditions };
}

/** Full, unambiguous logical eligibility key. */
export function buildEligibilityKey({ taskId, executorRoleId, eligibilityRevision, triggerId, triggerCursor } = {}) {
  const components = { taskId, executorRoleId, eligibilityRevision, triggerId, triggerCursor };
  if (Object.values(components).some((value) => typeof value !== "string" || !value.trim())) return null;
  return stableJson(components);
}

/** Existing one-line manual-takeover control remains a fail-closed current gate. */
export function automationDispatchControl(details = []) {
  const lines = Array.isArray(details) ? details : [];
  const candidates = lines.map((line) => String(line).trim()).filter((line) => CONTROL_LINE_CANDIDATE_RE.test(line));
  if (!candidates.length) return { valid: true, enabled: true, reason: null };
  if (candidates.length !== 1) return { valid: false, enabled: false, reason: "AUTOMATION_CONTROL_CONFLICT" };
  const controls = candidates.map((line) => line.match(CONTROL_LINE_RE)?.[1]?.trim());
  if (!controls[0]) return { valid: false, enabled: false, reason: "AUTOMATION_CONTROL_INVALID" };
  if (controls[0] === "启用") return { valid: true, enabled: true, reason: null };
  if (controls[0] === "暂停") return { valid: true, enabled: false, reason: "AUTOMATION_PAUSED" };
  return { valid: false, enabled: false, reason: "AUTOMATION_CONTROL_INVALID" };
}

/**
 * Compute all currently satisfied independent trigger qualifications. A false
 * dependency/evidence predicate produces no key and consumes no qualification.
 */
export function evaluateAgentTaskEligibility(task, context = {}) {
  const parsed = parseAgentTaskContract(task?.details || []);
  const executorRoleId = taskExecutorRoleId(task);
  const gateReasons = [];
  if (!parsed.present) gateReasons.push("AUTOMATION_CONTRACT_MISSING");
  else if (!parsed.valid) gateReasons.push("AUTOMATION_CONTRACT_INVALID");
  if (!task?.id || !STABLE_ID_RE.test(String(task.id)) || task.idKind === "derived") gateReasons.push("TASK_ID_NOT_EXPLICIT");
  if (!executorRoleId || !STABLE_ID_RE.test(executorRoleId)) gateReasons.push("EXECUTOR_ROLE_INVALID");
  if (task?.done === true) gateReasons.push("TASK_COMPLETED");
  if (task?.section === "blocked" || task?.blocked === true) gateReasons.push("TASK_BLOCKED");
  if (parsed.valid && parsed.contract.triggers.some((trigger) => nestedEvidencePaths(trigger).includes(task?.sourcePath))) {
    gateReasons.push("AUTOMATION_EVIDENCE_SELF_REFERENCE");
  }
  const control = automationDispatchControl(task?.details || []);
  if (!control.enabled) gateReasons.push(control.reason);
  if (context.hasActiveLease === true || context.activeLease === true) gateReasons.push("ACTIVE_LEASE");
  if (context.retryAllowed === false) gateReasons.push("RETRY_NOT_ALLOWED");

  const eligibilityRevision = parsed.valid ? computeEligibilityRevision(task, parsed) : null;
  const triggerEvaluations = parsed.valid ? parsed.contract.triggers.map((trigger) => ({
    triggerId: trigger.id,
    ...evaluateAgentTaskTrigger(trigger, context),
  })) : [];
  const candidates = gateReasons.length || !eligibilityRevision ? [] : triggerEvaluations.filter((result) => result.met && result.triggerCursor).map((result) => ({
    taskId: String(task.id),
    executorRoleId,
    eligibilityRevision,
    triggerId: result.triggerId,
    triggerCursor: result.triggerCursor,
    eligibilityKey: buildEligibilityKey({
      taskId: String(task.id),
      executorRoleId,
      eligibilityRevision,
      triggerId: result.triggerId,
      triggerCursor: result.triggerCursor,
    }),
  }));
  const whyNot = candidates.length ? [] : [...new Set([
    ...gateReasons,
    ...(gateReasons.length ? [] : triggerEvaluations.filter((result) => !result.met).map((result) => result.reason || "TRIGGER_NOT_SATISFIED")),
  ])];
  return {
    eligible: candidates.length > 0,
    candidates,
    eligibilityRevision,
    contract: parsed.contract,
    contractErrors: parsed.errors,
    control,
    gateReasons,
    whyNot,
    triggerEvaluations,
  };
}

function collectDoctorTasks(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.tasks)) return input.tasks;
  const tasks = [];
  if (input?.central) tasks.push(...(input.central.current || []), ...(input.central.longTerm || []));
  for (const project of input?.projects || []) {
    if (!project?.management) continue;
    tasks.push(...(project.management.doing || []), ...(project.management.next || []), ...(project.management.blocked || []));
  }
  if (!tasks.length && Array.isArray(input?.currentTodos)) tasks.push(...input.currentTodos);
  return tasks;
}

function taskRef(task) {
  return {
    taskId: task?.id || null,
    sourcePath: task?.sourcePath || null,
    lineNumber: task?.lineNumber || null,
    projectId: task?.projectId || null,
  };
}

function isAiOwned(task) {
  return /(?:^|[\s：:·])AI·\s*/u.test(String(task?.displayText || task?.text || task?.title || ""));
}

function nestedDependencies(trigger) {
  if (trigger.type === "dependency") return [trigger.taskId];
  if (trigger.type === "all") return trigger.conditions.flatMap(nestedDependencies);
  return [];
}

function nestedEvidencePaths(trigger) {
  if (trigger.type === "evidence") return [trigger.path];
  if (trigger.type === "all") return trigger.conditions.flatMap(nestedEvidencePaths);
  return [];
}

function doctorSeverityRank(severity) {
  return { error: 0, warning: 1, info: 2 }[severity] ?? 3;
}

/** Read-only compliance doctor. It reports facts and never mutates tasks/state. */
export function doctorAgentTasks(input = [], options = {}) {
  const tasks = collectDoctorTasks(input);
  const relationIssues = options.relationIssues || input?.relationIssues || input?.relationIndex?.issues || [];
  const evidenceInventory = options.evidencePaths || input?.evidencePaths || [];
  const evidenceSet = new Set(evidenceInventory instanceof Map ? evidenceInventory.keys() : Array.isArray(evidenceInventory) ? evidenceInventory : Object.keys(evidenceInventory || {}));
  const evidenceInventoryComplete = options.evidenceInventoryComplete === true || input?.evidenceInventoryComplete === true;
  const issues = [];
  const occurrences = new Map();
  for (const task of tasks) {
    if (task?.idKind === "derived" || !task?.id) continue;
    occurrences.set(task.id, [...(occurrences.get(task.id) || []), task]);
  }

  for (const [taskId, matches] of occurrences) {
    if (matches.length > 1) issues.push({
      severity: "error",
      ...issue("DUPLICATE_TASK_ID", `任务 ID“${taskId}”出现 ${matches.length} 次，不能进入自动流程。`, {
        taskId,
        occurrences: matches.map(taskRef),
      }),
    });
  }

  for (const task of tasks) {
    const parsed = parseAgentTaskContract(task?.details || []);
    const executorRoleId = taskExecutorRoleId(task);
    const reference = taskRef(task);
    if (!parsed.present && (isAiOwned(task) || executorRoleId)) {
      if (executorRoleId) issues.push({ severity: "warning", ...issue("EXECUTOR_WITHOUT_AUTOMATION_CONTRACT", `任务“${task.id || "未编号"}”有执行器但没有显式自动推进契约；旧字段不能证明会自动运行。`, reference) });
      else issues.push({ severity: "info", ...issue("AI_TASK_MANUAL_DISPATCH", `AI 任务“${task.id || "未编号"}”没有自动推进契约，按人工派发处理。`, reference) });
    }
    if (parsed.present && !parsed.valid) issues.push({
      severity: "error",
      ...issue("AUTOMATION_CONTRACT_INVALID", `任务“${task.id || "未编号"}”的自动推进契约无效，已失败关闭。`, { ...reference, errors: parsed.errors }),
    });
    if (parsed.valid && !executorRoleId) issues.push({ severity: "error", ...issue("AUTOMATION_EXECUTOR_MISSING", `自动任务“${task.id || "未编号"}”没有执行器。`, reference) });
    if (parsed.valid && executorRoleId && !EXECUTOR_ROLE_RE.test(executorRoleId)) issues.push({ severity: "error", ...issue("AUTOMATION_EXECUTOR_INVALID", `自动任务“${task.id || "未编号"}”的执行器标识超出公共入口边界。`, reference) });
    if (!task?.done && isLegacyAutomationExecutor(executorRoleId)) {
      issues.push({
        severity: "warning",
        ...issue(
          "LEGACY_EXECUTOR_NOT_CURRENT",
          `任务“${task.id || "未编号"}”绑定的是历史岗位 ${executorRoleId}，现行扫描只警告、不认领。`,
          { ...reference, executorId: executorRoleId },
        ),
      });
    }
    if (parsed.valid && (task?.idKind === "derived" || !task?.id || !STABLE_ID_RE.test(String(task.id)))) issues.push({ severity: "error", ...issue("AUTOMATION_TASK_ID_INVALID", "自动任务必须使用合法、显式、全局稳定的任务 ID。", reference) });
    if (parsed.valid && completionGates(task).length === 0) issues.push({ severity: "error", ...issue("AUTOMATION_COMPLETION_GATE_MISSING", `自动任务“${task.id || "未编号"}”缺少可复查完成门。`, reference) });
    if (parsed.valid && taskObjectives(task).length !== 1) issues.push({
      severity: "error",
      ...issue("AUTOMATION_OBJECTIVE_CONFLICT", `自动任务“${task.id || "未编号"}”必须恰好只有一条目标。`, reference),
    });
    if (parsed.valid && parsed.contract.authorization.includes("task:complete")) {
      const allGates = completionGates(task);
      const automaticGates = agentTaskAutomaticCompletionGates(task);
      if (!automaticGates.length || automaticGates.length !== allGates.length) issues.push({
        severity: "error",
        ...issue("AUTOMATION_COMPLETION_GATE_NOT_MACHINE_DECLARED", `自动任务“${task.id || "未编号"}”申请 task:complete 时，每个完成门都必须显式写成“自动完成门：…”。`, reference),
      });
    }
    if (parsed.valid && parsed.contract.triggers.some((trigger) => nestedEvidencePaths(trigger).includes(task?.sourcePath))) {
      issues.push({ severity: "error", ...issue("AUTOMATION_EVIDENCE_SELF_REFERENCE", `自动任务“${task.id}”不能把自己的任务原件当作触发证据。`, reference) });
    }

    for (const [relationType, targetId] of [
      ["parent", task?.parentId],
      ...(task?.dependencyIds || []).map((id) => ["dependency", id]),
      ...(task?.relatedTaskIds || []).map((id) => ["related", id]),
    ]) {
      if (!targetId) continue;
      const matches = occurrences.get(targetId) || [];
      if (targetId === task.id) issues.push({ severity: "error", ...issue("TASK_RELATION_SELF_REFERENCE", `任务“${task.id}”不能把自己声明为 ${relationType} 关系目标。`, { ...reference, relationType, targetId }) });
      else if (!matches.length) issues.push({ severity: "warning", ...issue("TASK_RELATION_TARGET_MISSING", `任务“${task.id || "未编号"}”的 ${relationType} 目标“${targetId}”不存在。`, { ...reference, relationType, targetId }) });
      else if (matches.length > 1) issues.push({ severity: "error", ...issue("TASK_RELATION_TARGET_AMBIGUOUS", `任务“${task.id || "未编号"}”的 ${relationType} 目标“${targetId}”不唯一。`, { ...reference, relationType, targetId }) });
    }

    if (!parsed.valid) continue;
    for (const trigger of parsed.contract.triggers) {
      for (const targetId of nestedDependencies(trigger)) {
        const matches = occurrences.get(targetId) || [];
        if (!matches.length) issues.push({ severity: "error", ...issue("AUTOMATION_TRIGGER_TARGET_MISSING", `自动任务“${task.id}”的触发“${trigger.id}”引用了不存在的任务“${targetId}”。`, { ...reference, triggerId: trigger.id, targetId }) });
        else if (matches.length > 1) issues.push({ severity: "error", ...issue("AUTOMATION_TRIGGER_TARGET_AMBIGUOUS", `自动任务“${task.id}”的触发“${trigger.id}”引用了不唯一的任务“${targetId}”。`, { ...reference, triggerId: trigger.id, targetId }) });
      }
      if (evidenceInventoryComplete) for (const evidencePath of nestedEvidencePaths(trigger)) {
        if (!evidenceSet.has(evidencePath)) issues.push({ severity: "warning", ...issue("AUTOMATION_EVIDENCE_TARGET_MISSING", `自动任务“${task.id}”的触发“${trigger.id}”找不到声明证据“${evidencePath}”。`, { ...reference, triggerId: trigger.id, evidencePath }) });
      }
    }
  }

  for (const relationIssue of relationIssues) {
    const severity = /AMBIGUOUS|DUPLICATE|INVALID|SELF/iu.test(String(relationIssue.code || "")) ? "error" : "warning";
    issues.push({
      severity,
      ...issue("PROJECT_RELATION_ISSUE", `项目关系索引报告：${relationIssue.code || "UNKNOWN"}。`, { relationIssue }),
    });
  }

  const deduplicated = [...new Map(issues.map((item) => [stableJson(item), item])).values()];
  deduplicated.sort((left, right) => doctorSeverityRank(left.severity) - doctorSeverityRank(right.severity)
    || String(left.code).localeCompare(String(right.code))
    || String(left.taskId || "").localeCompare(String(right.taskId || ""))
    || String(left.sourcePath || "").localeCompare(String(right.sourcePath || ""))
    || Number(left.lineNumber || 0) - Number(right.lineNumber || 0));
  return {
    issues: deduplicated,
    summary: {
      tasksScanned: tasks.length,
      errors: deduplicated.filter((item) => item.severity === "error").length,
      warnings: deduplicated.filter((item) => item.severity === "warning").length,
      info: deduplicated.filter((item) => item.severity === "info").length,
    },
  };
}
