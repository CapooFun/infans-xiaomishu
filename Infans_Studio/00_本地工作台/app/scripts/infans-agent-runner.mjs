#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VAULT_ROOT = path.resolve(SCRIPT_DIR, "../../..");
export const DEFAULT_BINDINGS_PATH = path.join(
  DEFAULT_VAULT_ROOT,
  "00_本地工作台/40_数据/agent-runtime-bindings.json",
);
export const WORKBENCH_RELEASE_AUTHORITY_PATH = "90_使用说明/00_工程基准/小秘书版本治理.md";
const VALUE_ARGS = new Set(["--bindings", "--role", "--workspace", "--prompt", "--prompt-file", "--model", "--trigger", "--timeout-ms"]);
const FLAG_ARGS = new Set(["--dry-run"]);
const PLACEHOLDERS = new Set(["workspace", "model", "prompt"]);
const RUN_PACKAGE_POLICIES = new Set([
  "domain-native",
  "shared-evidence",
  "shared-selection",
  "shared-operational",
  "authority-native",
]);
const SHARED_RUN_PACKAGE_POLICIES = new Set([
  "shared-evidence",
  "shared-selection",
  "shared-operational",
]);

export function parseCliArgs(argv) {
  const parsed = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (FLAG_ARGS.has(arg)) {
      parsed.dryRun = true;
      continue;
    }
    if (!VALUE_ARGS.has(arg)) throw new Error(`未知参数：${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
    index += 1;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[key] = value;
  }
  return parsed;
}

export async function loadAgentRuntimeBindings(bindingsPath = DEFAULT_BINDINGS_PATH) {
  const raw = await fs.readFile(bindingsPath, "utf8");
  const config = JSON.parse(raw);
  validateAgentRuntimeBindings(config);
  return config;
}

export function validateAgentRuntimeBindings(config) {
  if (config?.schemaVersion !== 1) throw new Error("岗位绑定表 schemaVersion 必须为 1");
  if (!config.adapters || typeof config.adapters !== "object") throw new Error("岗位绑定表缺少 adapters");
  if (!config.roles || typeof config.roles !== "object") throw new Error("岗位绑定表缺少 roles");

  for (const [adapterId, adapter] of Object.entries(config.adapters)) {
    if (adapter?.kind === "heartbeat") {
      if (typeof adapter.platform !== "string" || !adapter.platform) throw new Error(`心跳适配器 ${adapterId} 缺少 platform`);
      if (typeof adapter.automationId !== "string" || !adapter.automationId) throw new Error(`心跳适配器 ${adapterId} 缺少 automationId`);
      continue;
    }
    if (adapter?.kind === "thread-resume" || adapter?.kind === "turn-create") {
      if (typeof adapter.platform !== "string" || !adapter.platform) throw new Error(`真实回合适配器 ${adapterId} 缺少 platform`);
      if (typeof adapter.bindingKey !== "string" || !adapter.bindingKey) throw new Error(`真实回合适配器 ${adapterId} 缺少 bindingKey`);
      continue;
    }
    if (adapter?.kind !== "cli") throw new Error(`适配器 ${adapterId} 的 kind 不受支持`);
    if (typeof adapter.command !== "string" || !adapter.command) throw new Error(`适配器 ${adapterId} 缺少 command`);
    if (path.isAbsolute(adapter.command)) throw new Error(`适配器 ${adapterId} 的 command 不得写绝对路径`);
    if (!Array.isArray(adapter.args) || !adapter.args.length) throw new Error(`适配器 ${adapterId} 缺少 args`);
    for (const arg of adapter.args) {
      if (typeof arg !== "string") throw new Error(`适配器 ${adapterId} 的 args 必须是字符串`);
      for (const match of arg.matchAll(/\{([^}]+)\}/g)) {
        if (!PLACEHOLDERS.has(match[1])) throw new Error(`适配器 ${adapterId} 使用未知占位符 {${match[1]}}`);
      }
    }
    if (!adapter.args.some((arg) => arg.includes("{prompt}"))) throw new Error(`适配器 ${adapterId} 必须传入 {prompt}`);
  }

  for (const [roleId, role] of Object.entries(config.roles)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(roleId)) throw new Error(`岗位 ID 非法：${roleId}`);
    if (!config.adapters[role?.adapter]) throw new Error(`岗位 ${roleId} 引用了不存在的适配器 ${role?.adapter}`);
    if (role.dynamicPrompt === true) {
      if (role.taskPromptPath) throw new Error(`动态岗位 ${roleId} 不得同时设置 taskPromptPath`);
    } else if (typeof role.taskPromptPath !== "string" || path.isAbsolute(role.taskPromptPath)) {
      throw new Error(`岗位 ${roleId} 的 taskPromptPath 必须是 Vault 相对路径`);
    }
    if (!Array.isArray(role.instructionPaths) || role.instructionPaths.some((item) => typeof item !== "string" || path.isAbsolute(item))) {
      throw new Error(`岗位 ${roleId} 的 instructionPaths 必须是相对路径数组`);
    }
    if (config.adapters[role.adapter].kind === "cli") {
      if (!role.modelEnv || !/^INFANS_[A-Z0-9_]+$/.test(role.modelEnv)) throw new Error(`岗位 ${roleId} 的 modelEnv 非法`);
    } else if (role.modelEnv || role.defaultModel || role.requiresExplicitModel) {
      throw new Error(`非 CLI 岗位 ${roleId} 不得在本表保存模型参数`);
    }
    if (!new Set(["single-writer", "candidate", "read-only"]).has(role.writePolicy)) {
      throw new Error(`岗位 ${roleId} 的 writePolicy 非法`);
    }
    if (role.runPackagePolicy !== undefined && !RUN_PACKAGE_POLICIES.has(role.runPackagePolicy)) {
      throw new Error(`岗位 ${roleId} 的 runPackagePolicy 非法`);
    }
    if (role.writePolicy === "read-only" && role.runPackagePolicy !== undefined) {
      throw new Error(`只读岗位 ${roleId} 不应登记定时运行包`);
    }
    if (role.requiresExplicitModel && role.defaultModel) {
      throw new Error(`岗位 ${roleId} 要求显式模型时不得设置 defaultModel`);
    }
    if (role.timeoutMinutes !== undefined) {
      if (config.adapters[role.adapter].kind !== "cli") {
        throw new Error(`非 CLI 岗位 ${roleId} 不得登记 timeoutMinutes`);
      }
      if (!Number.isInteger(role.timeoutMinutes) || role.timeoutMinutes < 1 || role.timeoutMinutes > 180) {
        throw new Error(`岗位 ${roleId} 的 timeoutMinutes 必须是 1–180 的整数`);
      }
    }
  }

  const releaseRole = config.roles["workbench-daily-release"];
  if (releaseRole && releaseRole.instructionPaths[0] !== WORKBENCH_RELEASE_AUTHORITY_PATH) {
    throw new Error(`岗位 workbench-daily-release 必须把版本治理权威放在 instructionPaths 首位：${WORKBENCH_RELEASE_AUTHORITY_PATH}`);
  }
}

export function resolveRole(config, roleId, { explicitModel, env = process.env } = {}) {
  const role = config.roles[roleId];
  if (!role) throw new Error(`未登记岗位：${roleId}`);
  const adapter = config.adapters[role.adapter];
  if (adapter.kind !== "cli") return { role, adapter, model: "" };
  const envModel = env[role.modelEnv]?.trim();
  const model = explicitModel?.trim() || envModel || role.defaultModel || "";
  if (role.requiresExplicitModel && !explicitModel?.trim() && !envModel) {
    throw new Error(`岗位 ${roleId} 需要通过 --model 或 ${role.modelEnv} 显式确认模型`);
  }
  if (!model && adapter.args.some((arg) => arg.includes("{model}"))) throw new Error(`岗位 ${roleId} 缺少模型`);
  return { role, adapter, model };
}

function tokyoDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function tokyoDateTime(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
}

function runPackagePolicyInstruction(policy) {
  if (policy === "shared-selection") {
    return "记录实际核验的来源范围、进入候选的项目、采用与排除项及理由、仍未知的内容、正式写回位置；不复制整页网页。";
  }
  if (policy === "shared-operational") {
    return "记录运行前状态、检查或门禁、采用与保留事项、运行后状态、正式写回位置和唯一遗留；不复制大段终端输出。";
  }
  return "记录实际读取范围与缺口、形成的候选判断、采用与未采用内容、冲突或未知、正式写回位置。";
}

export async function readReleaseAuthority(workspace) {
  const absolutePath = path.join(workspace, WORKBENCH_RELEASE_AUTHORITY_PATH);
  const body = await fs.readFile(absolutePath, "utf8");
  const match = body.match(/^policyVersion:\s*(\d+)\s*$/m);
  if (!match) throw new Error(`版本治理权威缺少 policyVersion：${WORKBENCH_RELEASE_AUTHORITY_PATH}`);
  if (!/^authority:\s*canonical\s*$/m.test(body)) {
    throw new Error(`版本治理文档未声明 authority: canonical：${WORKBENCH_RELEASE_AUTHORITY_PATH}`);
  }
  return {
    relativePath: WORKBENCH_RELEASE_AUTHORITY_PATH,
    absolutePath,
    policyVersion: Number(match[1]),
  };
}

export function createRunPackageContext({ roleId, role, workspace, adapterId, model, authority = null, now = new Date() }) {
  if (!SHARED_RUN_PACKAGE_POLICIES.has(role.runPackagePolicy)) return null;
  const startedAt = tokyoDateTime(now);
  const stamp = startedAt.replace(/:/g, "-");
  const runId = `${roleId}-${stamp}-${randomUUID().slice(0, 8)}`;
  const relativePath = path.join(
    "00_本地工作台/30_证据/AI定时任务运行包",
    roleId,
    `${runId}.md`,
  );
  return {
    runId,
    roleId,
    adapterId,
    model,
    policy: role.runPackagePolicy,
    writePolicy: role.writePolicy,
    startedAt,
    requiredAuthorityPath: authority?.relativePath || null,
    requiredPolicyVersion: authority?.policyVersion ?? null,
    relativePath,
    absolutePath: path.join(workspace, relativePath),
  };
}

export function appendAuthorityInstruction(prompt, authority) {
  if (!authority) return prompt;
  return `${prompt}\n\n<required-authority version="1">\n开始判断或执行版本收口前，必须完整读取：${authority.relativePath}\n当前 policyVersion：${authority.policyVersion}\n完成时必须在本轮运行包“节点交接”的“实际读取”中原样写出上述相对路径，并写出 policyVersion: ${authority.policyVersion}。缺少任一项时执行器将以门禁码 22 失败关闭。\n</required-authority>`;
}

export function appendRunPackageInstruction(prompt, runPackage) {
  if (!runPackage) return prompt;
  return `${prompt}\n\n<run-package version="1">\n本轮运行 ID：${runPackage.runId}\n本轮运行包：${runPackage.absolutePath}\n这是审计证据，不是第二份业务原件。完成任务时必须保留该文件的 frontmatter，并把“节点交接”中的占位内容改成简短、可核验的本轮记录。${runPackagePolicyInstruction(runPackage.policy)}不要保存完整聊天、隐藏推理、认证 token／凭据或无关私密正文；允许保留数值 Token 用量字段，但不保存完整原始 JSON。即使正式稿跳过或失败，也要如实留下已读范围、已尝试内容、未写入原因和下一步。\n</run-package>`;
}

function quoted(value) {
  return JSON.stringify(String(value ?? ""));
}

export async function initializeRunPackage(runPackage, prompt) {
  if (!runPackage) return;
  await fs.mkdir(path.dirname(runPackage.absolutePath), { recursive: true });
  const body = `---
description: ${runPackage.roleId} 的一次定时 AI 运行交接与审计记录
tags: [本地工作台, AI自动化, 运行包]
sensitivity: S1
schemaVersion: 1
runId: ${quoted(runPackage.runId)}
roleId: ${quoted(runPackage.roleId)}
adapter: ${quoted(runPackage.adapterId)}
model: ${quoted(runPackage.model)}
writePolicy: ${quoted(runPackage.writePolicy)}
runPackagePolicy: ${quoted(runPackage.policy)}
startedAt: ${quoted(runPackage.startedAt)}
${runPackage.requiredAuthorityPath ? `requiredAuthorityPath: ${quoted(runPackage.requiredAuthorityPath)}\nrequiredPolicyVersion: ${runPackage.requiredPolicyVersion}\n` : ""}processState: running
finishedAt: null
exitCode: null
promptSha256: ${quoted(createHash("sha256").update(prompt).digest("hex"))}
---

# AI 定时任务运行包 · ${runPackage.roleId}

> 本文件只保存本轮可核验的交接与运行证据；正式业务事实仍以任务白名单原件为准。

## 节点交接

- 实际读取：待执行 Agent 填写。
- 来源缺口：待执行 Agent 填写。
- 候选／筛选：待执行 Agent 填写。
- 采用、排除与冲突：待执行 Agent 填写。
- 正式写回：待执行 Agent 填写。
- 结果与下一步：待执行 Agent 填写。
`;
  await fs.writeFile(runPackage.absolutePath, body, { encoding: "utf8", flag: "wx" });
}

function readNonNegative(source, key) {
  const value = Number(source?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function extractCursorCliResult(output) {
  const text = String(output || "");
  const candidates = [];
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"type"')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.type === "result") candidates.push(parsed);
    } catch {
      // 非 JSON 行忽略；CLI 可能在最终结果前打印状态。
    }
  }
  if (candidates.length) return candidates.at(-1);
  const start = text.lastIndexOf('{"type":"result"');
  if (start < 0) return null;
  const slice = text.slice(start);
  try {
    const parsed = JSON.parse(slice);
    return parsed?.type === "result" ? parsed : null;
  } catch {
    let depth = 0;
    let end = -1;
    for (let index = 0; index < slice.length; index += 1) {
      const char = slice[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) return null;
    try {
      const parsed = JSON.parse(slice.slice(0, end + 1));
      return parsed?.type === "result" ? parsed : null;
    } catch {
      return null;
    }
  }
}

export function normalizeCursorCliUsage(result) {
  const parsed = typeof result === "string" ? extractCursorCliResult(result) : result;
  if (!parsed || typeof parsed !== "object" || parsed.type !== "result" || !parsed.usage || typeof parsed.usage !== "object") return null;
  const freshInputTokens = readNonNegative(parsed.usage, "inputTokens");
  const cacheReadTokens = readNonNegative(parsed.usage, "cacheReadTokens");
  const cacheWriteTokens = readNonNegative(parsed.usage, "cacheWriteTokens");
  const outputTokens = readNonNegative(parsed.usage, "outputTokens");
  const inputTokens = freshInputTokens + cacheReadTokens + cacheWriteTokens;
  if (!inputTokens && !outputTokens) return null;
  return {
    usageSource: "cursor-headless-json",
    sessionId: String(parsed.session_id || "").slice(0, 80) || null,
    requestId: String(parsed.request_id || "").slice(0, 80) || null,
    inputTokens,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function capturesCursorUsage(adapterId, args = []) {
  const formatIndex = args.indexOf("--output-format");
  const format = formatIndex >= 0 ? String(args[formatIndex + 1] || "") : "";
  return (adapterId === "cursor-cli" || adapterId === "cursor-cli-ask") && (format === "json" || format === "stream-json");
}

export async function appendCursorBatchLedger(workspace, batch) {
  if (!batch?.runId) return null;
  const relativePath = "00_本地工作台/派生数据/agent-observability-cursor-batches.jsonl";
  const filePath = path.join(workspace, relativePath);
  const row = {
    schemaVersion: 2,
    bucket: "scheduled-batch",
    source: batch.usage?.usageSource || "cursor-runner",
    runId: String(batch.runId).slice(0, 180),
    roleId: String(batch.roleId || "").slice(0, 80),
    adapter: String(batch.adapterId || "cursor-cli").slice(0, 48),
    model: String(batch.model || "Cursor").slice(0, 128),
    trigger: String(batch.trigger || "unknown").slice(0, 40),
    processState: String(batch.processState || "unknown").slice(0, 32),
    exitCode: Number.isInteger(batch.exitCode) ? batch.exitCode : null,
    sessionId: batch.usage?.sessionId || null,
    requestId: batch.usage?.requestId || null,
    startedAt: batch.startedAt || null,
    finishedAt: batch.finishedAt || null,
    usage: batch.usage ? {
      inputTokens: batch.usage.inputTokens,
      freshInputTokens: batch.usage.freshInputTokens,
      cacheReadTokens: batch.usage.cacheReadTokens,
      cacheWriteTokens: batch.usage.cacheWriteTokens,
      outputTokens: batch.usage.outputTokens,
      totalTokens: batch.usage.totalTokens,
    } : null,
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  return relativePath;
}

export async function finalizeRunPackage(runPackage, { exitCode, error, usage = null, now = new Date() }) {
  if (!runPackage) return { effectiveExitCode: exitCode, processState: error || exitCode !== 0 ? "failed" : "exited", missingHandoff: false, missingAuthorityReceipt: false };
  let body;
  try {
    body = await fs.readFile(runPackage.absolutePath, "utf8");
  } catch (readError) {
    if (readError?.code !== "ENOENT") throw readError;
    await initializeRunPackage(runPackage, "run-package-recovery");
    body = await fs.readFile(runPackage.absolutePath, "utf8");
  }
  const finishedAt = tokyoDateTime(now);
  const missingHandoff = body.includes("待执行 Agent 填写");
  const handoff = body.split("## 节点交接")[1]?.split("## 执行器回执")[0] || "";
  const missingAuthorityReceipt = Boolean(runPackage.requiredAuthorityPath) && !(
    handoff.includes(runPackage.requiredAuthorityPath)
    && handoff.includes(`policyVersion: ${runPackage.requiredPolicyVersion}`)
  );
  const effectiveExitCode = error || exitCode !== 0
    ? (Number.isInteger(exitCode) ? exitCode : 1)
    : missingHandoff
      ? 21
      : missingAuthorityReceipt
        ? 22
        : 0;
  const processState = error || exitCode !== 0 ? "failed" : (missingHandoff || missingAuthorityReceipt ? "incomplete" : "exited");
  body = body
    .replace(/^processState:.*$/m, `processState: ${processState}`)
    .replace(/^finishedAt:.*$/m, `finishedAt: ${quoted(finishedAt)}`)
    .replace(/^exitCode:.*$/m, `exitCode: ${effectiveExitCode}`);
  if (usage?.usageSource && !/^usageSource:/m.test(body)) {
    const fields = [
      `usageSource: ${quoted(usage.usageSource)}`,
      `cursorSessionId: ${quoted(usage.sessionId || "")}`,
      `cursorRequestId: ${quoted(usage.requestId || "")}`,
      `inputTokens: ${usage.inputTokens}`,
      `freshInputTokens: ${usage.freshInputTokens}`,
      `cacheReadTokens: ${usage.cacheReadTokens}`,
      `cacheWriteTokens: ${usage.cacheWriteTokens}`,
      `outputTokens: ${usage.outputTokens}`,
      `totalTokens: ${usage.totalTokens}`,
    ].join("\n");
    body = body.replace(/^(promptSha256:.*)$/m, `$1\n${fields}`);
  }
  const processResult = processState === "exited"
    ? "正常退出（0）"
    : processState === "incomplete"
      ? missingHandoff
        ? "Agent 进程退出 0，但交接不完整（运行包门禁 21）"
        : "Agent 进程退出 0，但缺少版本治理回读凭证（运行包门禁 22）"
      : `失败（${effectiveExitCode}）`;
  const usageReceipt = usage?.usageSource
    ? `\n- Token：输入 ${usage.inputTokens}（缓存读 ${usage.cacheReadTokens}，缓存写 ${usage.cacheWriteTokens}）／输出 ${usage.outputTokens}／合计 ${usage.totalTokens}`
    : "\n- Token：CLI 未回传可信用量字段，本批次不补零";
  const authorityReceipt = runPackage.requiredAuthorityPath
    ? `\n- 版本治理回读：${missingAuthorityReceipt ? `缺少 ${runPackage.requiredAuthorityPath} / policyVersion: ${runPackage.requiredPolicyVersion} 的节点交接凭证` : `已确认 ${runPackage.requiredAuthorityPath} / policyVersion: ${runPackage.requiredPolicyVersion}`}`
    : "";
  const receipt = `\n\n## 执行器回执\n\n- 结束时间：${finishedAt}\n- 进程结果：${processResult}\n- 交接完整性：${missingHandoff ? "Agent 未完整替换占位内容，需在复盘时视为缺口" : "已留下节点交接"}${authorityReceipt}${usageReceipt}${error ? `\n- 启动错误：${String(error.message || error).slice(0, 300)}` : ""}\n`;
  await fs.writeFile(runPackage.absolutePath, `${body.trimEnd()}${receipt}`, "utf8");
  return { effectiveExitCode, processState, missingHandoff, missingAuthorityReceipt };
}

export function createDefaultRolePrompt(role, workspace, now = new Date()) {
  if (role.dynamicPrompt) throw new Error("动态 prompt 岗位必须通过调用方传入 --prompt");
  const taskPrompt = path.join(workspace, role.taskPromptPath);
  const instructionLines = role.instructionPaths.map((item) => path.join(workspace, item));
  const readFirst = instructionLines.length
    ? `请先完整阅读下列本地规则原件：\n${instructionLines.join("\n")}\n\n`
    : "";
  return `<automation role="${role.id ?? "scheduled"}">\n今天是日本时间 ${tokyoDate(now)}。\n${readFirst}然后严格执行下列本地任务说明文件中的全部规则：\n${taskPrompt}\n\n只允许写入任务说明列出的白名单路径；失败时保留旧原件并用说人话的一句话汇报。\n</automation>`;
}

export function renderAdapterInvocation(adapter, values, env = process.env) {
  if (adapter.kind !== "cli") throw new Error(`适配器 ${adapter.kind} 不能通过本机 CLI 入口执行`);
  const command = env[adapter.commandEnv]?.trim() || adapter.command;
  const args = adapter.args.map((template) => template.replace(/\{(workspace|model|prompt)\}/g, (_, key) => values[key]));
  return { command, args };
}

export function buildDryRunSummary({ roleId, role, adapterId, command, args, workspace, model, prompt, runPackage, timeoutMs }) {
  const promptIndexes = args.flatMap((arg, index) => arg === prompt ? [index] : []);
  return {
    schemaVersion: 1,
    roleId,
    adapter: adapterId,
    writePolicy: role.writePolicy,
    command: path.basename(command),
    model,
    workspace,
    timeoutMs,
    prompt: {
      sha256: createHash("sha256").update(prompt).digest("hex"),
      length: prompt.length,
      argumentIndexes: promptIndexes,
    },
    runPackage: runPackage ? {
      policy: runPackage.policy,
      relativePath: runPackage.relativePath,
    } : null,
  };
}

async function readPrompt(options, role, workspace, now) {
  if (options.prompt && options.promptFile) throw new Error("--prompt 与 --prompt-file 只能选一个");
  if (options.prompt) return options.prompt;
  if (options.promptFile) return fs.readFile(path.resolve(options.promptFile), "utf8");
  return createDefaultRolePrompt(role, workspace, now);
}

async function assertLocalInputs(role, workspace) {
  const paths = [role.taskPromptPath, ...role.instructionPaths].filter(Boolean);
  for (const relativePath of paths) {
    await fs.access(path.join(workspace, relativePath));
  }
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseCliArgs(argv);
  if (!options.role) throw new Error("缺少 --role");
  const workspace = path.resolve(options.workspace || DEFAULT_VAULT_ROOT);
  const bindingsPath = path.resolve(options.bindings || DEFAULT_BINDINGS_PATH);
  const config = await loadAgentRuntimeBindings(bindingsPath);
  const { role, adapter, model } = resolveRole(config, options.role, { explicitModel: options.model, env });
  if (adapter.kind !== "cli") throw new Error(`岗位 ${options.role} 由 ${adapter.kind} 平台调度，不通过本机 CLI 入口执行`);
  await fs.access(workspace);
  await assertLocalInputs(role, workspace);
  const explicitTimeoutMs = options.timeoutMs === undefined ? null : Number(options.timeoutMs);
  if (explicitTimeoutMs !== null && (!Number.isInteger(explicitTimeoutMs) || explicitTimeoutMs < 1)) {
    throw new Error("--timeout-ms 必须是正整数");
  }
  const timeoutMs = explicitTimeoutMs ?? (role.timeoutMinutes ? role.timeoutMinutes * 60_000 : 0);
  const now = new Date();
  const startedAt = tokyoDateTime(now);
  const fallbackRunId = `${options.role}-${startedAt.replace(/:/g, "-")}-${randomUUID().slice(0, 8)}`;
  const authority = options.role === "workbench-daily-release"
    ? await readReleaseAuthority(workspace)
    : null;
  const runPackage = createRunPackageContext({
    roleId: options.role,
    role,
    workspace,
    adapterId: role.adapter,
    model,
    authority,
    now,
  });
  const basePrompt = await readPrompt(options, role, workspace, now);
  const prompt = appendRunPackageInstruction(appendAuthorityInstruction(basePrompt, authority), runPackage);
  const invocation = renderAdapterInvocation(adapter, { workspace, model, prompt }, env);
  const summary = buildDryRunSummary({
    roleId: options.role,
    role,
    adapterId: role.adapter,
    ...invocation,
    workspace,
    model,
    prompt,
    runPackage,
    timeoutMs,
  });

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  }

  await initializeRunPackage(runPackage, prompt);
  process.stdout.write(`Agent 岗位启动：role=${options.role} adapter=${role.adapter} model=${model}\n`);
  if (runPackage) process.stdout.write(`Agent 运行包：${runPackage.absolutePath}\n`);
  try {
    let resultOutput = "";
    const exitCode = await new Promise((resolve, reject) => {
      const captureJson = capturesCursorUsage(role.adapter, invocation.args);
      const child = spawn(invocation.command, invocation.args, { stdio: captureJson ? ["inherit", "pipe", "inherit"] : "inherit", env });
      let timedOut = false;
      let killTimer = null;
      const timeoutTimer = timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          killTimer.unref?.();
        }, timeoutMs)
        : null;
      timeoutTimer?.unref?.();
      if (captureJson && child.stdout) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          resultOutput = `${resultOutput}${chunk}`.slice(-2_000_000);
        });
      }
      child.on("error", (error) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (timedOut) {
          const error = new Error(`Agent 岗位超过运行上限 ${Math.ceil(timeoutMs / 60_000)} 分钟，已终止`);
          error.exitCode = 124;
          reject(error);
        } else if (signal) reject(new Error(`Agent 进程被信号 ${signal} 终止`));
        else resolve(code ?? 1);
      });
    });
    const extracted = extractCursorCliResult(resultOutput);
    const usage = normalizeCursorCliUsage(extracted || resultOutput);
    const finishedAt = tokyoDateTime(new Date());
    const finalized = await finalizeRunPackage(runPackage, { exitCode, usage });
    await appendCursorBatchLedger(workspace, {
        runId: runPackage?.runId || fallbackRunId,
        roleId: options.role,
        adapterId: role.adapter,
        model,
        trigger: options.trigger || "unknown",
        processState: finalized.processState,
        exitCode: finalized.effectiveExitCode,
        startedAt: runPackage?.startedAt || startedAt,
        finishedAt,
        usage,
      });
    return finalized.effectiveExitCode;
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    const finalized = await finalizeRunPackage(runPackage, { exitCode, error });
    await appendCursorBatchLedger(workspace, {
      runId: runPackage?.runId || fallbackRunId,
      roleId: options.role,
      adapterId: role.adapter,
      model,
      trigger: options.trigger || "unknown",
      processState: finalized.processState,
      exitCode: finalized.effectiveExitCode,
      startedAt: runPackage?.startedAt || startedAt,
      finishedAt: tokyoDateTime(new Date()),
      usage: null,
    });
    if (error?.exitCode === 124) {
      process.stderr.write(`${error.message}\n`);
      return finalized.effectiveExitCode;
    }
    throw error;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`Agent 岗位执行失败：${error.message}\n`);
      process.exitCode = 1;
    });
}
