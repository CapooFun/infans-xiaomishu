import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKBENCH_RELEASE_AUTHORITY_PATH,
  loadAgentRuntimeBindings,
} from "./infans-agent-runner.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const BINDINGS_PATH = path.join(VAULT_ROOT, "00_本地工作台/40_数据/agent-runtime-bindings.json");
const INSTALLER_PATH = path.join(VAULT_ROOT, "00_本地工作台/app/scripts/install-infans-periodic-ai.sh");
const ARCHITECTURE_PATH = path.join(VAULT_ROOT, "90_使用说明/00_工程基准/Agent协作与可替换架构.md");
const HUMAN_CARE_PATH = path.join(VAULT_ROOT, "40_身心健康/心理/人文关怀_AI执行边界与模板.md");
const CURSOR_SKILL_PATH = path.join(VAULT_ROOT, ".cursor/skills/human-care-pulse/SKILL.md");
const CODEX_WORKLOAD_PATH = path.join(VAULT_ROOT, "00_本地工作台/app/scripts/codex-workload-summary.mjs");
const CURSOR_WORKLOAD_PATH = path.join(VAULT_ROOT, "00_本地工作台/app/scripts/cursor-workload-summary.mjs");
const WORKBENCH_AI_PATH = path.join(VAULT_ROOT, "00_本地工作台/app/src/server/workbench-ai.mjs");
const HANDOFF_SCHEMA_PATH = path.join(VAULT_ROOT, "00_本地工作台/40_数据/agent-handoff.schema.json");
const HANDOFF_RULE_PATH = path.join(VAULT_ROOT, "90_使用说明/10_规则手册/Agent交接信封规范.md");
const HANDOFF_TEMPLATE_PATH = path.join(VAULT_ROOT, "90_使用说明/40_模板/Agent交接信封_模板.md");
const AI_ACCEPTANCE_DISPATCHER_PATH = path.join(VAULT_ROOT, "00_本地工作台/app/scripts/ai-acceptance-dispatcher.mjs");
const AI_ACCEPTANCE_INSTALLER_PATH = path.join(VAULT_ROOT, "00_本地工作台/app/scripts/install-ai-acceptance-runner.mjs");
const AI_ACCEPTANCE_RULE_PATH = path.join(VAULT_ROOT, "00_本地工作台/10_设计/定时与自动化/AI自动验收与推进机制.md");
const AGENT_TASK_GOVERNANCE_PATH = "90_使用说明/00_工程基准/跨Agent任务接力与自动推进基本规约.md";
const RUN_PACKAGE_RULE_PATH = path.join(VAULT_ROOT, "00_本地工作台/10_设计/定时与自动化/AI定时任务运行包规范.md");
const RELEASE_AUTHORITY_PATH = path.join(VAULT_ROOT, WORKBENCH_RELEASE_AUTHORITY_PATH);

const config = await loadAgentRuntimeBindings(BINDINGS_PATH);
for (const [roleId, role] of Object.entries(config.roles)) {
  if (role.instructionPaths.some((relativePath) => relativePath.startsWith(".cursor/") || relativePath.startsWith(".codex/"))) {
    throw new Error(`岗位 ${roleId} 不得把平台私有目录当作业务规则原件`);
  }
  for (const relativePath of [role.taskPromptPath, ...role.instructionPaths].filter(Boolean)) {
    try {
      await fs.access(path.join(VAULT_ROOT, relativePath));
    } catch {
      throw new Error(`岗位 ${roleId} 引用的本地原件不存在：${relativePath}`);
    }
  }
}

const expectedRunPackagePolicies = {
  "health-fact-handoff": "domain-native",
  "health-daily": "domain-native",
  "monthly-review": "shared-evidence",
  "training-review": "shared-evidence",
  "market-brief": "shared-selection",
  "world-brief": "shared-selection",
  "japan-activities": "shared-selection",
  "workbench-daily-release": "shared-operational",
  "cursor-usage-probe": "shared-operational",
  "agent-task-readonly-verifier": "authority-native",
};
for (const [roleId, expected] of Object.entries(expectedRunPackagePolicies)) {
  if (config.roles[roleId]?.runPackagePolicy !== expected) {
    throw new Error(`岗位 ${roleId} 的运行包策略应为 ${expected}`);
  }
}
for (const roleId of ["monthly-review", "training-review", "market-brief", "world-brief", "japan-activities", "workbench-daily-release"]) {
  const role = config.roles[roleId];
  const taskPrompt = await fs.readFile(path.join(VAULT_ROOT, role.taskPromptPath), "utf8");
  if (!taskPrompt.includes(`AI定时任务运行包/${roleId}`) || !taskPrompt.includes("运行包")) {
    throw new Error(`岗位 ${roleId} 的任务说明未登记公共运行包白名单与交接内容`);
  }
}
for (const roleId of ["workbench-chat-fast", "workbench-chat-high"]) {
  if (config.roles[roleId]?.runPackagePolicy) throw new Error(`只读对话岗位 ${roleId} 不得生成定时运行包`);
}

const serialized = JSON.stringify(config);
if (/password|token|api[_-]?key|secret/i.test(serialized)) {
  throw new Error("岗位绑定表不得包含凭据字段或正文");
}

const installer = await fs.readFile(INSTALLER_PATH, "utf8");
if (!installer.includes("infans-agent-runner.mjs")) throw new Error("周期任务安装器尚未接入统一 Agent 执行入口");
if (/AGENT_BIN=|\"\$AGENT\"\s+-p/.test(installer)) throw new Error("周期任务安装器仍在直接执行平台 Agent");
const releaseRole = config.roles["workbench-daily-release"];
if (releaseRole?.adapter !== "cursor-cli" || releaseRole?.writePolicy !== "single-writer") {
  throw new Error("小秘书每周版本收口必须由 Cursor 主 Agent 单写");
}
if (releaseRole?.instructionPaths[0] !== WORKBENCH_RELEASE_AUTHORITY_PATH) {
  throw new Error("小秘书每周版本收口必须把版本治理权威放在 instructionPaths 首位");
}
const [releaseAuthority, releasePrompt, dailyHealthPrompt] = await Promise.all([
  fs.readFile(RELEASE_AUTHORITY_PATH, "utf8"),
  fs.readFile(path.join(VAULT_ROOT, releaseRole.taskPromptPath), "utf8"),
  fs.readFile(path.join(VAULT_ROOT, "00_本地工作台/10_设计/定时与自动化/小秘书每日轻量检查_本机定时说明.md"), "utf8"),
]);
for (const required of ["authority: canonical", "policyVersion:", "当轮修复闭环", "不得无限期保持", "每周一", "每日轻量", "不得把缺口写成"]) {
  if (!releaseAuthority.includes(required)) throw new Error(`小秘书版本治理权威缺少：${required}`);
}
for (const required of [WORKBENCH_RELEASE_AUTHORITY_PATH, "policyVersion", "门禁码 22", "不得自行合并", "不得把 GPT／Codex 语义收拢写成已经自动启动"]) {
  if (!releasePrompt.includes(required)) throw new Error(`小秘书每周版本 prompt 未强制回读权威：${required}`);
}
if (!dailyHealthPrompt.includes("不绑定模型") || !dailyHealthPrompt.includes("不运行 `version:inspect`")) {
  throw new Error("每日轻量检查说明不得调用模型或做版本判断");
}
for (const required of [
  "infans_workbench_daily_release.sh",
  "com.capoo.infans-workbench-daily-release",
  "workbench-daily-release",
  "infans_workbench_daily_health.sh",
  "com.capoo.infans-workbench-daily-health",
  'write_plist_weekly_monday "com.capoo.infans-workbench-daily-release"',
  'write_plist_daily "com.capoo.infans-workbench-daily-health"',
]) {
  if (!installer.includes(required)) throw new Error(`周期任务安装器缺少小秘书版本收口或每日轻量检查：${required}`);
}
if (installer.includes('write_plist_daily "com.capoo.infans-workbench-daily-release"')) {
  throw new Error("完整版本收口不得继续按每天安装");
}
const weeklyMondayHelperStart = installer.indexOf("write_plist_weekly_monday() {");
const weeklyMondayHelperEnd = installer.indexOf("\nwrite_plist_weekly() {", weeklyMondayHelperStart);
if (weeklyMondayHelperStart < 0 || weeklyMondayHelperEnd < 0) {
  throw new Error("周期任务安装器缺少 write_plist_weekly_monday helper");
}
const weeklyMondayHelper = installer.slice(weeklyMondayHelperStart, weeklyMondayHelperEnd);
if (weeklyMondayHelper.includes("training-review_launchd.log")) {
  throw new Error("write_plist_weekly_monday 不得把 StandardOutPath／StandardErrorPath 硬编码成训练复盘日志");
}
if (!weeklyMondayHelper.includes('${STATE}/${label#com.capoo.infans-}_launchd.log')) {
  throw new Error("write_plist_weekly_monday 必须按 label 使用各自 launchd 日志");
}

const acceptanceRole = config.roles["agent-task-readonly-verifier"];
if (acceptanceRole?.adapter !== "codex-ephemeral-turn" || acceptanceRole?.writePolicy !== "single-writer" || acceptanceRole?.dynamicPrompt !== true) {
  throw new Error("AI 自动验收必须启动本机 Codex 真实回合，并保持原件单写");
}
if (acceptanceRole?.instructionPaths[0] !== "AGENTS.md" || !acceptanceRole?.instructionPaths.includes(AGENT_TASK_GOVERNANCE_PATH)) {
  throw new Error("AI 自动验收必须先受根入口约束，并显式读取跨 Agent 自动推进正式规约");
}
const [acceptanceDispatcher, acceptanceInstaller, acceptanceRule] = await Promise.all([
  fs.readFile(AI_ACCEPTANCE_DISPATCHER_PATH, "utf8"),
  fs.readFile(AI_ACCEPTANCE_INSTALLER_PATH, "utf8"),
  fs.readFile(AI_ACCEPTANCE_RULE_PATH, "utf8"),
]);
for (const required of [
  "readProjectManagement",
  "agent-task-readonly-verifier",
  '"exec"',
  '"--ephemeral"',
  '"--sandbox", "read-only"',
  '"--output-schema"',
  '"task:complete"',
  "verifiedEvidence",
  "recoverExpiredAgentTaskRuns",
]) {
  if (!acceptanceDispatcher.includes(required)) throw new Error(`AI 自动验收调度器缺少：${required}`);
}
if (acceptanceDispatcher.includes('"queue"')) throw new Error("AI 自动验收不得再把只排队冒充真实启动");
if (acceptanceDispatcher.includes('"resume"')) throw new Error("AI 自动验收不得继续绑定长期 Codex 任务窗口");
for (const required of [
  "com.capoo.infans-ai-acceptance-runner",
  "StartInterval",
  "schemaVersion: 3",
  "codex-exec-ephemeral-json",
  "process.execPath",
  "ensurePrivateDirectory(logDir)",
  "ensurePrivateLog(logPath)",
  "max_log_bytes",
  "max_log_archives",
]) {
  if (!acceptanceInstaller.includes(required)) throw new Error(`AI 自动验收安装器缺少：${required}`);
}
for (const required of [
  "显式 `自动推进` JSON 契约",
  "五元资格",
  "运行账 v2",
  "agent-task-readonly-verifier",
  "广域只读信任面",
  "真实自然票",
  "不自动 commit",
]) {
  if (!acceptanceRule.includes(required)) throw new Error(`AI 自动验收原件缺少：${required}`);
}

const architecture = await fs.readFile(ARCHITECTURE_PATH, "utf8");
for (const required of ["事实留在本地原件", "单写者", "runPackagePolicy", "分阶段落实计划", "短验收门"]) {
  if (!architecture.includes(required)) throw new Error(`Agent 架构原件缺少：${required}`);
}
const runPackageRule = await fs.readFile(RUN_PACKAGE_RULE_PATH, "utf8");
for (const required of ["来源覆盖 → 岗位候选／筛选 → 收口取舍 → 正式原件 → 执行器回执", "domain-native", "shared-selection", "authority-native", "不覆盖原则"]) {
  if (!runPackageRule.includes(required)) throw new Error(`AI 定时任务运行包规范缺少：${required}`);
}

const humanCare = await fs.readFile(HUMAN_CARE_PATH, "utf8");
for (const required of ["人文边界", "日评固定写入范围", "当前身心日评模板", "校正闭环"]) {
  if (!humanCare.includes(required)) throw new Error(`人文关怀业务原件缺少：${required}`);
}
const cursorSkill = await fs.readFile(CURSOR_SKILL_PATH, "utf8");
if (!cursorSkill.includes("本 Skill 只负责触发和路由") || !cursorSkill.includes("人文关怀_AI执行边界与模板.md")) {
  throw new Error("Cursor 人文 Skill 必须保持为指向本地业务原件的薄适配器");
}
if (cursorSkill.includes("S = 0.65T") || cursorSkill.includes("## 当前身心日评模板")) {
  throw new Error("Cursor 人文 Skill 不得重新复制正式公式或模板");
}
await fs.access(CODEX_WORKLOAD_PATH);
await fs.access(CURSOR_WORKLOAD_PATH);
const workbenchAi = await fs.readFile(WORKBENCH_AI_PATH, "utf8");
if (!workbenchAi.includes("resolveWorkbenchAgentInvocation") || !workbenchAi.includes("agent-runtime-bindings.json")) {
  throw new Error("小秘书 AI 后端尚未接入本地岗位绑定");
}
if (workbenchAi.includes('${HOME}/.local/bin/cursor-agent')) {
  throw new Error("小秘书 AI 后端不得硬编码 Cursor 可执行文件绝对路径");
}

const handoffSchema = JSON.parse(await fs.readFile(HANDOFF_SCHEMA_PATH, "utf8"));
const requiredHandoffFields = [
  "schemaVersion", "handoffId", "taskId", "fromRole", "toRole", "state",
  "authorityPaths", "sourceRefs", "dedupeKey", "sensitivity", "createdAt",
];
for (const field of requiredHandoffFields) {
  if (!handoffSchema.required?.includes(field)) throw new Error(`Agent 交接 schema 缺少必填字段：${field}`);
}
if (handoffSchema.properties?.sensitivity?.enum?.includes("S3")) {
  throw new Error("通用 Agent 交接信封不得接收 S3");
}
const handoffRule = await fs.readFile(HANDOFF_RULE_PATH, "utf8");
const handoffTemplate = await fs.readFile(HANDOFF_TEMPLATE_PATH, "utf8");
if (!handoffRule.includes("能直接更新项目进度、业务原件或证据时，直接更新") || !handoffRule.includes("接票规则")) {
  throw new Error("Agent 交接规范必须坚持原件优先与接票核验");
}
for (const field of requiredHandoffFields) {
  if (!handoffTemplate.includes(`${field}:`)) throw new Error(`Agent 交接模板缺少字段：${field}`);
}

const roleCount = Object.keys(config.roles).length;
const adapterCount = Object.keys(config.adapters).length;
process.stdout.write(`Agent 可替换契约检查通过：${roleCount} 个岗位／${adapterCount} 个执行适配器；本地原件、统一入口与短验收门已登记。\n`);
