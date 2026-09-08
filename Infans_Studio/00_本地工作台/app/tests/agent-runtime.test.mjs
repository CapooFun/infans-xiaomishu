import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BINDINGS_PATH,
  DEFAULT_VAULT_ROOT,
  WORKBENCH_RELEASE_AUTHORITY_PATH,
  appendAuthorityInstruction,
  appendRunPackageInstruction,
  createDefaultRolePrompt,
  createRunPackageContext,
  extractCursorCliResult,
  finalizeRunPackage,
  initializeRunPackage,
  loadAgentRuntimeBindings,
  normalizeCursorCliUsage,
  readReleaseAuthority,
  renderAdapterInvocation,
  resolveRole,
  validateAgentRuntimeBindings,
} from "../scripts/infans-agent-runner.mjs";

test("Cursor JSON 结果只提取数值用量并统一缓存口径", () => {
  const usage = normalizeCursorCliUsage(JSON.stringify({
    type: "result",
    result: "不应写入运行包的正文",
    session_id: "sess-1",
    request_id: "req-1",
    usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 3 },
  }));
  assert.deepEqual(usage, {
    usageSource: "cursor-headless-json",
    sessionId: "sess-1",
    requestId: "req-1",
    inputTokens: 45,
    freshInputTokens: 12,
    cacheReadTokens: 30,
    cacheWriteTokens: 3,
    outputTokens: 5,
    totalTokens: 50,
  });
  assert.equal(JSON.stringify(usage).includes("正文"), false);
  assert.equal(normalizeCursorCliUsage('{"type":"error"}'), null);
  assert.equal(normalizeCursorCliUsage("not-json"), null);
});

test("Cursor CLI 在最终 JSON 前后夹杂文本时仍能提取用量，且不保存回答正文", () => {
  const noisy = [
    "Starting Cursor Agent...",
    '{"type":"system","subtype":"init"}',
    "progress: thinking",
    JSON.stringify({
      type: "result",
      result: "OK 这句不能进账本",
      session_id: "sess-noise",
      usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 },
    }),
    "done",
  ].join("\n");
  const extracted = extractCursorCliResult(noisy);
  assert.equal(extracted?.type, "result");
  const usage = normalizeCursorCliUsage(noisy);
  assert.equal(usage?.totalTokens, 15);
  assert.equal(usage?.sessionId, "sess-noise");
  assert.equal(JSON.stringify(usage).includes("OK"), false);
  assert.equal(JSON.stringify(usage).includes("正文"), false);
});

const runnerPath = fileURLToPath(new URL("../scripts/infans-agent-runner.mjs", import.meta.url));

test("platform-neutral roles resolve through the current adapter without absolute executable paths", async () => {
  const config = await loadAgentRuntimeBindings();
  const resolved = resolveRole(config, "health-daily", { env: {} });
  assert.equal(resolved.role.adapter, "cursor-cli");
  assert.equal(resolved.model, "cursor-grok-4.6-high");
  assert.equal(resolved.adapter.command, "cursor-agent");
  assert.equal(resolved.adapter.command.startsWith("/"), false);

  const prompt = createDefaultRolePrompt(resolved.role, DEFAULT_VAULT_ROOT, new Date("2026-08-27T00:00:00Z"));
  assert.match(prompt, /^<automation role=/);
  assert.match(prompt, /<\/automation>$/);
  assert.match(prompt, /身心日评_本机定时prompt\.md/);
  assert.match(prompt, /人文关怀_AI执行边界与模板\.md/);
  const invocation = renderAdapterInvocation(resolved.adapter, {
    workspace: DEFAULT_VAULT_ROOT,
    model: resolved.model,
    prompt,
  }, {});
  assert.equal(invocation.command, "cursor-agent");
  assert.equal(invocation.args.at(-1), prompt);
});

test("daily release prompt and run package require the canonical version policy receipt", async () => {
  const config = await loadAgentRuntimeBindings();
  const role = config.roles["workbench-daily-release"];
  const authority = await readReleaseAuthority(DEFAULT_VAULT_ROOT);
  assert.equal(role.instructionPaths[0], WORKBENCH_RELEASE_AUTHORITY_PATH);
  assert.equal(authority.relativePath, WORKBENCH_RELEASE_AUTHORITY_PATH);
  assert.equal(authority.policyVersion, 3);

  const basePrompt = createDefaultRolePrompt(role, DEFAULT_VAULT_ROOT, new Date("2026-09-02T00:00:00Z"));
  const prompt = appendAuthorityInstruction(basePrompt, authority);
  assert.match(prompt, /required-authority/);
  assert.ok(prompt.includes(WORKBENCH_RELEASE_AUTHORITY_PATH));
  assert.match(prompt, /policyVersion: 3/);

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "infans-release-authority-"));
  const context = createRunPackageContext({
    roleId: "workbench-daily-release",
    role,
    workspace,
    adapterId: role.adapter,
    model: role.defaultModel,
    authority,
    now: new Date("2026-09-02T00:00:00Z"),
  });
  await initializeRunPackage(context, appendRunPackageInstruction(prompt, context));
  let body = await fs.readFile(context.absolutePath, "utf8");
  body = body.replaceAll("待执行 Agent 填写。", "已完成测试交接。");
  await fs.writeFile(context.absolutePath, body, "utf8");
  let finalized = await finalizeRunPackage(context, { exitCode: 0 });
  assert.equal(finalized.effectiveExitCode, 22);
  assert.equal(finalized.missingAuthorityReceipt, true);

  const passed = createRunPackageContext({
    roleId: "workbench-daily-release",
    role,
    workspace,
    adapterId: role.adapter,
    model: role.defaultModel,
    authority,
    now: new Date("2026-09-02T00:02:00Z"),
  });
  await initializeRunPackage(passed, appendRunPackageInstruction(prompt, passed));
  body = await fs.readFile(passed.absolutePath, "utf8");
  body = body.replace("- 实际读取：待执行 Agent 填写。", `- 实际读取：${WORKBENCH_RELEASE_AUTHORITY_PATH}；policyVersion: 3。`);
  body = body.replaceAll("待执行 Agent 填写。", "已完成测试交接。");
  await fs.writeFile(passed.absolutePath, body, "utf8");
  finalized = await finalizeRunPackage(passed, { exitCode: 0 });
  assert.equal(finalized.effectiveExitCode, 0);
  assert.equal(finalized.missingAuthorityReceipt, false);
});

test("daily release binding fails closed when the canonical policy is not first", async () => {
  const config = structuredClone(await loadAgentRuntimeBindings());
  config.roles["workbench-daily-release"].instructionPaths = [
    "AGENTS.md",
    ...config.roles["workbench-daily-release"].instructionPaths.filter((item) => item !== "AGENTS.md"),
  ];
  assert.throws(
    () => validateAgentRuntimeBindings(config),
    /必须把版本治理权威放在 instructionPaths 首位/,
  );
});

test("roles that require a model never silently inherit another role's default", async () => {
  const config = await loadAgentRuntimeBindings();
  assert.throws(
    () => resolveRole(config, "japan-activities", { env: {} }),
    /需要通过 --model 或 INFANS_JAPAN_ACTIVITIES_MODEL 显式确认模型/,
  );
  const resolved = resolveRole(config, "japan-activities", {
    env: { INFANS_JAPAN_ACTIVITIES_MODEL: "cursor-grok-4.6-high" },
  });
  assert.equal(resolved.model, "cursor-grok-4.6-high");
});

test("dry-run reports routing metadata and a prompt digest without exposing prompt text", () => {
  const prompt = "这段敏感的测试 prompt 不应出现在 dry-run 输出";
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--bindings", DEFAULT_BINDINGS_PATH,
    "--role", "health-daily",
    "--workspace", DEFAULT_VAULT_ROOT,
    "--prompt", prompt,
    "--dry-run",
  ], { encoding: "utf8", env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(prompt), false);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.roleId, "health-daily");
  assert.equal(summary.adapter, "cursor-cli");
  assert.equal(summary.timeoutMs, 25 * 60_000);
  assert.equal(summary.prompt.length, prompt.length);
  assert.match(summary.prompt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(summary.runPackage, null);
});

test("scheduled CLI roles enforce a bounded runtime and permit a smaller one-run override", async () => {
  const config = structuredClone(await loadAgentRuntimeBindings());
  config.roles["health-daily"].timeoutMinutes = 0;
  assert.throws(
    () => validateAgentRuntimeBindings(config),
    /timeoutMinutes 必须是 1–180 的整数/,
  );

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "infans-run-timeout-"));
  await fs.writeFile(path.join(workspace, "task.md"), "# fixture\n", "utf8");
  const bindingsPath = path.join(workspace, "bindings.json");
  await fs.writeFile(bindingsPath, JSON.stringify({
    schemaVersion: 1,
    adapters: {
      fixture: {
        kind: "cli",
        command: "node",
        args: ["-e", "setInterval(() => {}, 1000)", "{prompt}"],
      },
    },
    roles: {
      "fixture-timeout": {
        adapter: "fixture",
        taskPromptPath: "task.md",
        instructionPaths: [],
        modelEnv: "INFANS_FIXTURE_MODEL",
        timeoutMinutes: 1,
        writePolicy: "read-only",
      },
    },
  }), "utf8");
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--bindings", bindingsPath,
    "--role", "fixture-timeout",
    "--workspace", workspace,
    "--timeout-ms", "80",
  ], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 3_000 });
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /超过运行上限 1 分钟，已终止/);
});

test("shared scheduled roles receive one exact run package while domain-native roles keep their existing artifacts", async () => {
  const config = await loadAgentRuntimeBindings();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "infans-run-package-"));
  const monthly = config.roles["monthly-review"];
  const context = createRunPackageContext({
    roleId: "monthly-review",
    role: monthly,
    workspace,
    adapterId: monthly.adapter,
    model: monthly.defaultModel,
    now: new Date("2026-08-30T00:00:00Z"),
  });
  assert.equal(context.policy, "shared-evidence");
  assert.match(context.relativePath, /^00_本地工作台\/30_证据\/AI定时任务运行包\/monthly-review\//);
  const prompt = appendRunPackageInstruction("执行月报", context);
  assert.match(prompt, /本轮运行包/);
  assert.ok(prompt.includes(context.runId));

  await initializeRunPackage(context, prompt);
  let body = await fs.readFile(context.absolutePath, "utf8");
  body = body.replaceAll("待执行 Agent 填写。", "已按测试来源完成。 ");
  await fs.writeFile(context.absolutePath, body, "utf8");
  await finalizeRunPackage(context, {
    exitCode: 0,
    now: new Date("2026-08-30T00:01:00Z"),
    usage: {
      usageSource: "cursor-headless-json",
      sessionId: "sess-run",
      requestId: "req-run",
      inputTokens: 12,
      freshInputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      outputTokens: 4,
      totalTokens: 16,
    },
  });
  const finalized = await fs.readFile(context.absolutePath, "utf8");
  assert.match(finalized, /processState: exited/);
  assert.match(finalized, /交接完整性：已留下节点交接/);
  assert.match(finalized, /usageSource: "cursor-headless-json"/);
  assert.match(finalized, /cursorSessionId: "sess-run"/);
  assert.match(finalized, /合计 16/);
  assert.doesNotMatch(finalized, /不应写入|回答正文/u);

  const health = config.roles["health-daily"];
  assert.equal(createRunPackageContext({
    roleId: "health-daily",
    role: health,
    workspace,
    adapterId: health.adapter,
    model: health.defaultModel,
  }), null);
});

test("the real CLI entry creates and finalizes a package even when the fixture agent leaves no handoff", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "infans-run-cli-"));
  await fs.writeFile(path.join(workspace, "task.md"), "# fixture\n", "utf8");
  const bindingsPath = path.join(workspace, "bindings.json");
  await fs.writeFile(bindingsPath, JSON.stringify({
    schemaVersion: 1,
    adapters: {
      fixture: { kind: "cli", command: "true", args: ["{prompt}"] },
    },
    roles: {
      "fixture-report": {
        adapter: "fixture",
        taskPromptPath: "task.md",
        instructionPaths: [],
        modelEnv: "INFANS_FIXTURE_MODEL",
        defaultModel: "fixture-model",
        requiresExplicitModel: false,
        writePolicy: "single-writer",
        runPackagePolicy: "shared-evidence",
      },
    },
  }), "utf8");
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--bindings", bindingsPath,
    "--role", "fixture-report",
    "--workspace", workspace,
  ], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 21, result.stderr);
  const packageLine = result.stdout.split("\n").find((line) => line.startsWith("Agent 运行包："));
  assert.ok(packageLine);
  const packagePath = packageLine.slice("Agent 运行包：".length);
  const body = await fs.readFile(packagePath, "utf8");
  assert.match(body, /processState: incomplete/);
  assert.match(body, /运行包门禁 21/);
  assert.match(body, /交接完整性：Agent 未完整替换占位内容/);
  const ledger = (await fs.readFile(path.join(workspace, "00_本地工作台/派生数据/agent-observability-cursor-batches.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].processState, "incomplete");
  assert.equal(ledger[0].exitCode, 21);
  assert.equal(ledger[0].trigger, "unknown");
  assert.equal(ledger[0].usage, null);
});

test("candidate heartbeat stays locally described while its platform schedule remains replaceable", async () => {
  const config = await loadAgentRuntimeBindings();
  const resolved = resolveRole(config, "health-fact-handoff", { env: {} });
  assert.equal(resolved.adapter.kind, "heartbeat");
  assert.equal(resolved.role.writePolicy, "candidate");
  assert.equal(resolved.role.taskPromptPath, "40_身心健康/状态报告/GPT交接暂存_定时prompt.md");
});

test("AI acceptance role creates a replaceable ephemeral Codex turn without storing a bound thread id", async () => {
  const config = await loadAgentRuntimeBindings();
  const resolved = resolveRole(config, "agent-task-readonly-verifier", { env: {} });
  assert.equal(resolved.adapter.kind, "turn-create");
  assert.equal(resolved.adapter.bindingKey, "ai-acceptance-runner.json");
  assert.equal(resolved.role.dynamicPrompt, true);
  assert.equal(resolved.role.writePolicy, "single-writer");
  assert.equal(JSON.stringify(config).includes("01a04641-cd38-7ef0-a8a4-42e7d4e66cbc"), false);
});

test("single-writer role can switch CLI adapters without changing its task original or write policy", async () => {
  const config = structuredClone(await loadAgentRuntimeBindings());
  const before = structuredClone(config.roles["health-daily"]);
  config.adapters["replacement-fixture"] = {
    kind: "cli",
    command: "replacement-agent",
    args: ["--workspace", "{workspace}", "--model", "{model}", "--prompt", "{prompt}"],
  };
  config.roles["health-daily"].adapter = "replacement-fixture";
  validateAgentRuntimeBindings(config);
  const resolved = resolveRole(config, "health-daily", { env: {} });
  const invocation = renderAdapterInvocation(resolved.adapter, {
    workspace: DEFAULT_VAULT_ROOT,
    model: resolved.model,
    prompt: "same-local-task",
  }, {});
  assert.equal(invocation.command, "replacement-agent");
  assert.equal(config.roles["health-daily"].taskPromptPath, before.taskPromptPath);
  assert.equal(config.roles["health-daily"].writePolicy, before.writePolicy);
  assert.equal(invocation.args.at(-1), "same-local-task");
});
