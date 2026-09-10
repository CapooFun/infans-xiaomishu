import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CODEX_RUN_TIMEOUT_MS,
  EXECUTOR_ID,
  buildCodexRunArgs,
  buildDispatchPlan,
  buildWakeMessage,
  cleanupSettledResultProposals,
  doctorRuntimeSourceConsistency,
  dispatchSelected,
  evidenceFacts,
  hasNonAutomatableCompletionGate,
  normalizeConfig,
  run,
  runCodexJson,
  runtimeLedgerPath,
  verifyEvidenceSnapshot,
} from "../scripts/ai-acceptance-dispatcher.mjs";
import { createRuntimeLedgerState, readRuntimeLedger } from "../scripts/agent-task-runtime-ledger.mjs";
import { readProjectManagement } from "../src/server/workbench-project-management.mjs";

const SOURCE_PATH = "30_事业顺利/小秘书/项目进度与待办.md";
const THREAD_ID = "01a06871-b1fa-7c80-af04-63472da5f17c";
const FIXTURE_EVIDENCE_PATH = "00_本地工作台/30_证据/agent-task-fixture.md";
const execFileAsync = promisify(execFile);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function automaticContract(triggers, overrides = {}) {
  return `自动推进：${JSON.stringify({
    version: 1,
    mode: "automatic",
    authorization: ["vault:read", "task:complete", "task:writeback"],
    lifecycle: 1,
    selfScheduleReview: false,
    triggers,
    ...overrides,
  })}`;
}

function taskRecord(overrides = {}) {
  const id = overrides.id || "agent-auto-test";
  const result = {
    id,
    idKind: "explicit",
    done: false,
    blocked: false,
    section: "doing",
    executorId: EXECUTOR_ID,
    displayText: `AI· 自动任务 ${id}`,
    text: `AI· 自动任务 ${id}｜ID：${id}｜执行器：${EXECUTOR_ID}`,
    details: [],
    sourcePath: SOURCE_PATH,
    lineNumber: 10,
    dependencyIds: [],
    relatedTaskIds: [],
    parentId: null,
    ...overrides,
  };
  if (result.details.some((line) => String(line).startsWith("自动推进："))
    && !result.details.some((line) => /^(?:完成门|完成条件|自动完成门)\s*[：:]/u.test(String(line)))) {
    result.details = ["自动完成门：声明证据可以由协调器稳定回读。", ...result.details];
  }
  return result;
}

function config() {
  return {
    schemaVersion: 3,
    executorId: EXECUTOR_ID,
    executorRoleId: EXECUTOR_ID,
    platform: "codex-app",
    dispatchMode: "codex-exec-ephemeral-json",
    codexPath: "/synthetic/codex",
    leaseMs: 70 * 60_000,
    maxAttempts: 3,
    retryCooldownMs: 30 * 60_000,
  };
}

function registry() {
  return `# 事业顺利

## 当前重点

| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |
|---|---|---|---|---|
| **AI 协作系统** | 进行中 | [[30_事业顺利/小秘书/小秘书_总览|AI协作系统_总览]] | ai-collaboration | [[${SOURCE_PATH.slice(0, -3)}|项目进度与待办]] |

## 归档

| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |
|---|---|---|---|---|
`;
}

function projectMarkdown({ id = "agent-auto-test", contract, extraDetails = [] } = {}) {
  return `---
description: test
tags: [项目管理]
---
# AI 协作系统

## 当前状态

隔离测试。

## 正在做

- [ ] 公司：开发：S：AI· 隔离自动任务｜ID：${id}｜执行器：${EXECUTOR_ID}
  - 目标：验证可信启动、公共写回与运行账收口。
  - 自动完成门：有可回读证据时才能勾选。
  - ${contract}
${extraDetails.map((line) => `  - ${line}`).join("\n")}

## 下一步

- 无

## 阻塞

- 无

## 最近完成

- 无

## 权威入口

- 无
`;
}

async function fixture(t, options = {}) {
  const now = options.now || new Date();
  const id = options.id || "agent-auto-test";
  const contract = options.contract || automaticContract([{
    id: "due",
    type: "all",
    conditions: [
      { type: "time", at: new Date(now.getTime() - 60_000).toISOString() },
      { type: "evidence", path: FIXTURE_EVIDENCE_PATH },
    ],
  }]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-dispatcher-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, path.dirname(SOURCE_PATH)), { recursive: true });
  await fs.mkdir(path.join(root, path.dirname(FIXTURE_EVIDENCE_PATH)), { recursive: true });
  await fs.writeFile(path.join(root, FIXTURE_EVIDENCE_PATH), "隔离验收证据。\n");
  for (const [relativePath, content] of Object.entries(options.evidenceFiles || {})) {
    const absolute = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
  await fs.writeFile(path.join(root, "30_事业顺利/事业顺利_总览.md"), registry());
  await fs.writeFile(path.join(root, SOURCE_PATH), projectMarkdown({ id, contract, extraDetails: options.extraDetails }));
  if (options.hardLinkEvidence === true) {
    await fs.unlink(path.join(root, FIXTURE_EVIDENCE_PATH));
    await fs.link(path.join(root, SOURCE_PATH), path.join(root, FIXTURE_EVIDENCE_PATH));
  }
  await fs.writeFile(path.join(root, "待办事项与长期规划.md"), "# 待办\n\n## 最近两天\n\n- 无\n\n## 长期在推\n\n- 无\n");
  const snapshot = await readProjectManagement(root, { now });
  const ledger = createRuntimeLedgerState(now);
  const plan = await buildDispatchPlan({ root, snapshot, ledger, config: config(), now });
  assert.ok(plan.selected, "fixture 必须产生一个可执行资格");
  return { root, now, snapshot, ledger, plan, ledgerPath: runtimeLedgerPath(root), sourceAbsolute: path.join(root, SOURCE_PATH) };
}

async function fillCliOutcome(filePath, outcome) {
  await fs.writeFile(filePath, `${JSON.stringify(outcome)}\n`);
}

function cliOutputPath(invocation) {
  const index = invocation.args.indexOf("--output-last-message");
  assert.ok(index >= 0, "Codex 调用必须登记结构化结果路径");
  assert.ok(path.isAbsolute(invocation.args[index + 1]));
  return invocation.args[index + 1];
}

function successfulExecution(threadId = THREAD_ID) {
  return { exitCode: 0, signal: null, timedOut: false, started: true, threadId, error: null, errorCode: null };
}

test("旧 AI· 前缀和执行器在没有显式契约时不产生派发资格", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-plan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = taskRecord({ details: [] });
  const now = new Date("2026-09-04T12:00:00.000Z");
  const plan = await buildDispatchPlan({
    root,
    snapshot: { tasks: [legacy], relationIndex: { issues: [] } },
    ledger: createRuntimeLedgerState(now),
    config: config(),
    now,
  });
  assert.equal(plan.selected, null);
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.doctor.issues.some((item) => item.code === "EXECUTOR_WITHOUT_AUTOMATION_CONTRACT"), true);
});

test("未支持授权与本任务原件证据均失败关闭", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-fail-closed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, path.dirname(SOURCE_PATH)), { recursive: true });
  await fs.writeFile(path.join(root, SOURCE_PATH), "# source\n");
  const now = new Date("2026-09-04T12:00:00.000Z");
  const due = [{ id: "due", type: "time", at: "2026-09-04T09:00:00.000Z" }];
  const unsupported = taskRecord({
    id: "unsupported-authorization",
    details: [automaticContract(due, { authorization: ["vault:read", "task:writeback", "external:delete"] })],
  });
  const selfEvidence = taskRecord({
    id: "self-evidence",
    details: [automaticContract([{ id: "self", type: "evidence", path: SOURCE_PATH }])],
  });
  const plan = await buildDispatchPlan({
    root,
    snapshot: { tasks: [unsupported, selfEvidence], relationIndex: { issues: [] } },
    ledger: createRuntimeLedgerState(now),
    config: config(),
    now,
  });
  assert.equal(plan.selected, null);
  assert.deepEqual(plan.candidates, []);
  assert.ok(plan.skipped.some((item) => item.taskId === unsupported.id && item.reasons.includes("AUTOMATION_AUTHORIZATION_UNSUPPORTED")));
  assert.equal(plan.doctor.issues.some((item) => item.taskId === selfEvidence.id && item.code === "AUTOMATION_EVIDENCE_SELF_REFERENCE"), true);
});

test("历史岗位只警告、不认领，即使契约与触发都满足", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-legacy-executor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = new Date("2026-09-04T12:00:00.000Z");
  const due = [{ id: "due", type: "time", at: "2026-09-04T09:00:00.000Z" }];
  const historical = taskRecord({
    id: "legacy-automatic-ticket",
    executorId: "codex-ai-acceptance",
    displayText: "AI· 历史岗位票",
    text: "AI· 历史岗位票｜ID：legacy-automatic-ticket｜执行器：codex-ai-acceptance",
    details: [automaticContract(due)],
  });
  const current = taskRecord({
    id: "current-automatic-ticket",
    details: [automaticContract(due)],
  });
  const plan = await buildDispatchPlan({
    root,
    snapshot: { tasks: [historical, current], relationIndex: { issues: [] } },
    ledger: createRuntimeLedgerState(now),
    config: config(),
    now,
  });
  assert.equal(plan.selected?.task.id, "current-automatic-ticket");
  assert.equal(plan.candidates.some((item) => item.task.id === "legacy-automatic-ticket"), false);
  const skipped = plan.skipped.find((item) => item.taskId === "legacy-automatic-ticket");
  assert.deepEqual(skipped?.reasons, ["LEGACY_EXECUTOR_NOT_CURRENT"]);
  assert.equal(skipped?.executorId, "codex-ai-acceptance");
  assert.equal(skipped?.expectedExecutorRoleId, EXECUTOR_ID);
  assert.equal(plan.doctor.issues.some((item) => item.taskId === "legacy-automatic-ticket" && item.code === "LEGACY_EXECUTOR_NOT_CURRENT"), true);
});

test("没有完成门的显式自动任务也失败关闭", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-no-gate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = new Date("2026-09-04T12:00:00.000Z");
  const subject = taskRecord({
    id: "automatic-without-completion-gate",
    details: ["目标：有目标但没有完成门。", automaticContract([{ id: "due", type: "time", at: "2026-09-04T09:00:00.000Z" }])],
  });
  subject.details = subject.details.filter((line) => !/^(?:完成门|完成条件|自动完成门)\s*[：:]/u.test(line));
  const plan = await buildDispatchPlan({
    root,
    snapshot: { tasks: [subject], relationIndex: { issues: [] } },
    ledger: createRuntimeLedgerState(now),
    config: config(),
    now,
  });
  assert.equal(plan.selected, null);
  assert.equal(plan.doctor.issues.some((item) => item.taskId === subject.id && item.code === "AUTOMATION_COMPLETION_GATE_MISSING"), true);
});

test("时间、依赖和证据触发各自形成可重放资格，条件不成立时零资格", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-facts-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const evidencePath = "00_本地工作台/30_证据/trigger.txt";
  const evidence = Buffer.from("已完成的可回读证据\n");
  await fs.mkdir(path.join(root, path.dirname(evidencePath)), { recursive: true });
  await fs.writeFile(path.join(root, evidencePath), evidence);
  const dueAt = "2026-09-04T09:00:00.000Z";
  const auto = taskRecord({
    details: [automaticContract([
      { id: "clock", type: "time", at: dueAt },
      { id: "dependency", type: "dependency", taskId: "dependency-done", expected: "completed" },
      { id: "evidence", type: "evidence", path: evidencePath, expectedSha256: sha256(evidence) },
    ])],
  });
  const dependency = taskRecord({ id: "dependency-done", executorId: null, done: true, displayText: "依赖已完成", details: [] });
  const now = new Date("2026-09-04T12:00:00.000Z");
  const ready = await buildDispatchPlan({
    root,
    snapshot: { tasks: [auto, dependency], relationIndex: { issues: [] } },
    ledger: createRuntimeLedgerState(now),
    config: config(),
    now,
  });
  assert.deepEqual(ready.candidates.map((item) => item.candidate.triggerId).sort(), ["clock", "dependency", "evidence"]);
  for (const item of ready.candidates) {
    assert.equal(typeof item.candidate.eligibilityKey, "object");
    assert.equal(item.candidate.eligibilityKey.taskId, auto.id);
    assert.ok(item.candidate.eligibilityKey.triggerCursor);
  }

  await fs.writeFile(path.join(root, evidencePath), "证据已变化\n");
  const early = new Date("2026-09-04T08:00:00.000Z");
  const notReady = await buildDispatchPlan({
    root,
    snapshot: { tasks: [auto, { ...dependency, done: false }], relationIndex: { issues: [] } },
    ledger: createRuntimeLedgerState(early),
    config: config(),
    now: early,
  });
  assert.equal(notReady.selected, null);
  assert.deepEqual(notReady.candidates, []);
  assert.ok(notReady.skipped.some((item) => item.taskId === auto.id));
});

test("Codex 命令使用结构化 JSON 与只读隔离，唤醒文本通过 stdin 而不是参数", () => {
  const outputPath = "/tmp/codex-agent-outcome.json";
  const schemaPath = "/tmp/codex-agent-outcome.schema.json";
  const args = buildCodexRunArgs(config(), "/tmp/vault", { outputPath, schemaPath });
  const message = buildWakeMessage(taskRecord(), { authorization: ["vault:read", "task:writeback"] });
  assert.equal(args.includes("--json"), true);
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.equal(args[args.indexOf("--output-schema") + 1], schemaPath);
  assert.equal(args[args.indexOf("--output-last-message") + 1], outputPath);
  assert.equal(args.includes("--ignore-user-config"), true);
  assert.equal(args.includes("--ephemeral"), true);
  assert.equal(args.includes("resume"), false);
  assert.equal(args.includes(THREAD_ID), false);
  assert.equal(args.includes("--approve-for-me"), false);
  assert.equal(args.at(-1), "-");
  assert.equal(args.includes(message), false);
  assert.match(message, /agent-task-wakeup/);
  assert.match(message, /不要直接修改来源原件/);
  assert.match(message, /简洁纯文本，不含 Markdown、反引号、HTML 或链接/);
  assert.match(message, /不自动 commit、push、tag/);
});

test("长运行持续心跳续租，超时后 SIGTERM 无效会升级为 SIGKILL", async () => {
  let starts = 0;
  let heartbeats = 0;
  const script = [
    'process.on("SIGTERM", () => {});',
    `console.log(JSON.stringify({type:"thread.started",thread_id:"${THREAD_ID}"}));`,
    'console.log(JSON.stringify({type:"turn.started"}));',
    'setInterval(() => {}, 1000);',
  ].join("");
  const result = await runCodexJson({
    command: process.execPath,
    args: ["-e", script],
    input: "",
    env: process.env,
    timeoutMs: 120,
    heartbeatMs: 20,
    killGraceMs: 40,
    onStarted: async () => { starts += 1; },
    onHeartbeat: async () => { heartbeats += 1; },
  });
  assert.equal(starts, 1);
  assert.ok(heartbeats >= 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.errorCode, "timeout");
});

test("Codex 两类启动事件无论先后都要齐备，才建立临时执行关联", async () => {
  let starts = 0;
  const script = [
    'console.log(JSON.stringify({type:"turn.started"}));',
    `console.log(JSON.stringify({type:"thread.started",thread_id:"${THREAD_ID}"}));`,
  ].join("");
  const result = await runCodexJson({
    command: process.execPath,
    args: ["-e", script],
    input: "",
    env: process.env,
    onStarted: async ({ threadId }) => {
      starts += 1;
      assert.equal(threadId, THREAD_ID);
    },
  });
  assert.equal(starts, 1);
  assert.equal(result.started, true);
  assert.equal(result.errorCode, null);
});

test("Codex 启动事件缺失或执行 ID 畸形时失败关闭", async (t) => {
  for (const [scenario, script, expected] of [
    ["missing-thread", 'console.log(JSON.stringify({type:"turn.started"}));', "platform-execution-missing"],
    ["malformed-thread", 'console.log(JSON.stringify({type:"thread.started",thread_id:"not-a-uuid"}));console.log(JSON.stringify({type:"turn.started"}));', "start-receipt-rejected"],
  ]) {
    await t.test(scenario, async () => {
      let starts = 0;
      const result = await runCodexJson({
        command: process.execPath,
        args: ["-e", script],
        input: "",
        env: process.env,
        onStarted: async () => { starts += 1; },
      });
      assert.equal(starts, 0);
      assert.equal(result.started, false);
      assert.equal(result.errorCode, expected);
    });
  }
});

test("真实 run 入口在任何恢复或扫描前拒绝旧 schema 与残留 threadId", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-old-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, "ledger.json");
  await fs.writeFile(ledgerPath, "sentinel\n");
  for (const [name, staleConfig, expected] of [
    ["schema2", { ...config(), schemaVersion: 2 }, /schemaVersion 3/u],
    ["bound-thread", { ...config(), threadId: THREAD_ID }, /不得继续绑定长期任务窗口/u],
  ]) {
    const configPath = path.join(root, `${name}.json`);
    await fs.writeFile(configPath, `${JSON.stringify(staleConfig)}\n`);
    await assert.rejects(
      run(["--workspace", root, "--config", configPath, "--ledger", ledgerPath, "--json"]),
      expected,
    );
    assert.equal(await fs.readFile(ledgerPath, "utf8"), "sentinel\n");
  }
});

test("本机调度配置拒绝会造成并发重跑的无效租约与重试边界", () => {
  assert.throws(() => normalizeConfig({ ...config(), leaseMs: 0 }), /leaseMs/u);
  assert.throws(() => normalizeConfig({ ...config(), leaseMs: CODEX_RUN_TIMEOUT_MS }), /leaseMs/u);
  assert.throws(() => normalizeConfig({ ...config(), maxAttempts: 0 }), /maxAttempts/u);
  assert.throws(() => normalizeConfig({ ...config(), retryCooldownMs: -1 }), /retryCooldownMs/u);
  assert.equal(normalizeConfig(config()).leaseMs, 70 * 60_000);
});

test("完成证据只接受契约预声明且认领后内容未变的普通 Vault 文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reference = "00_本地工作台/30_证据/result.md";
  const absolute = path.join(root, reference);
  const sourceAbsolute = path.join(root, SOURCE_PATH);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.mkdir(path.dirname(sourceAbsolute), { recursive: true });
  await fs.writeFile(sourceAbsolute, "# source\n");
  await fs.writeFile(absolute, "claim snapshot\n");
  const claimEvidence = [{ path: reference, sha256: sha256(Buffer.from("claim snapshot\n")) }];

  const verified = await verifyEvidenceSnapshot({ root, sourcePath: SOURCE_PATH, evidenceRefs: [reference], claimEvidence });
  assert.deepEqual(verified, claimEvidence);

  const before = await fs.stat(absolute);
  await fs.writeFile(absolute, "changed after claim\n");
  await fs.utimes(absolute, before.atime, before.mtime);
  await assert.rejects(
    verifyEvidenceSnapshot({ root, sourcePath: SOURCE_PATH, evidenceRefs: [reference], claimEvidence }),
    (error) => error?.code === "EVIDENCE_CHANGED_AFTER_CLAIM",
  );
  await assert.rejects(
    verifyEvidenceSnapshot({ root, sourcePath: SOURCE_PATH, evidenceRefs: ["00_本地工作台/30_证据/other.md"], claimEvidence }),
    (error) => error?.code === "EVIDENCE_NOT_DECLARED",
  );
});

test("FIFO 证据在打开前即被拒绝，不会阻塞整轮扫描", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-fifo-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fifoPath = "00_本地工作台/30_证据/waiting.pipe";
  const absolute = path.join(root, fifoPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await execFileAsync("mkfifo", [absolute]);
  const subject = taskRecord({
    details: [automaticContract([{ id: "fifo", type: "evidence", path: fifoPath }])],
  });
  const startedAt = Date.now();
  const facts = await Promise.race([
    evidenceFacts(root, [subject]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO evidence scan hung")), 1_000)),
  ]);
  assert.deepEqual(facts, {});
  assert.ok(Date.now() - startedAt < 1_000);
});

test("任务原件的硬链接不能充当触发或完成证据，且不会调用模型", async (t) => {
  const state = await fixture(t, { id: "agent-hardlink-evidence", hardLinkEvidence: true });
  let calls = 0;
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-hardlink",
    now: state.now,
    execute: async () => { calls += 1; return successfulExecution(); },
  });
  assert.equal(calls, 0);
  assert.equal(result.modelsInvoked, 0);
  assert.equal(result.writebackErrorCode, "evidence-path-task-source");
  const ledger = await readRuntimeLedger(state.ledgerPath);
  assert.equal(ledger.runs[result.runId].status, "settled");
  assert.equal(ledger.runs[result.runId].attempts[0].processOutcome.status, "not-started");
});

test("本人、主观、真机或独立复核完成门不能由通用只读岗位自动勾选", () => {
  for (const gate of [
    "完成门：Capoo 本人确认。",
    "完成门：主观观感通过。",
    "完成门：真机实测通过。",
    "完成门：另一 Agent 独立复核。",
    "自动完成门：GPT-6 复核通过。",
    "自动完成门：Cursor 复核通过。",
    "自动完成门：人工确认通过。",
    "自动完成门：iPad 实机检查通过。",
    "自动完成门：用户实际使用无误。",
  ]) {
    assert.equal(hasNonAutomatableCompletionGate(taskRecord({ details: [gate] })), true);
  }
});

test("同契约其它 evidence 触发不能替纯时间资格取得自动完成权", async (t) => {
  const now = new Date();
  const state = await fixture(t, {
    now,
    id: "agent-alternate-evidence",
    contract: automaticContract([
      { id: "due", type: "time", at: new Date(now.getTime() - 60_000).toISOString() },
      { id: "unmet-evidence", type: "evidence", path: FIXTURE_EVIDENCE_PATH, expectedSha256: "f".repeat(64) },
    ]),
  });
  assert.equal(state.plan.selected.candidate.triggerId, "due");
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-alternate-evidence",
    now,
    execute: async (invocation) => {
      await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
      await fillCliOutcome(cliOutputPath(invocation), {
        status: "completed",
        summary: "不应由另一条未满足证据触发授权完成。",
        evidenceRefs: [FIXTURE_EVIDENCE_PATH],
        nextStep: "",
        nextReviewAt: null,
      });
      return successfulExecution();
    },
  });
  assert.equal(result.status, "process-failed");
  assert.equal(result.writeback, false);
  assert.equal(result.writebackErrorCode, "EVIDENCE_SNAPSHOT_MISMATCH");
  assert.match(await fs.readFile(state.sourceAbsolute, "utf8"), /- \[ \].*ID：agent-alternate-evidence/u);
});

test("隔离全流程：可信启动、CLI 结果、公共写回、link/账本结算及防重跑", async (t) => {
  const state = await fixture(t);
  let calls = 0;
  const execute = async (invocation) => {
    calls += 1;
    await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
    await fillCliOutcome(cliOutputPath(invocation), {
      status: "completed",
      summary: "隔离链路已完成并回读。",
      evidenceRefs: [FIXTURE_EVIDENCE_PATH],
      nextStep: "",
      nextReviewAt: null,
    });
    assert.equal(Object.keys(invocation.env).some((key) => /INFANS_AGENT_(?:RUN_ID|ATTEMPT_NO|RESULT_PATH)/u.test(key)), false);
    return successfulExecution();
  };
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-complete",
    now: state.now,
    execute,
  });
  assert.equal(result.status, "settled");
  assert.equal(result.writeback, true);
  assert.equal(result.modelsInvoked, 1);

  const source = await fs.readFile(state.sourceAbsolute, "utf8");
  assert.match(source, /- \[x\].*ID：agent-auto-test/u);
  assert.equal((source.match(/自动回执：/g) || []).length, 1);
  assert.match(source, /隔离链路已完成并回读/);

  const ledger = await readRuntimeLedger(state.ledgerPath);
  const run = ledger.runs[result.runId];
  assert.equal(run.status, "settled");
  assert.equal(run.attempts[0].startEvidence.kind, "platform-execution");
  assert.equal(run.attempts[0].processOutcome.status, "succeeded");
  assert.equal(run.attempts[0].writebackOutcome.status, "succeeded");
  assert.equal(run.attempts[0].readbackOutcome.status, "succeeded");
  assert.equal(Object.values(run.effects).every((effect) => effect.appliedAt && effect.verifiedAt), true);
  assert.deepEqual(ledger.executionLinkEvents.map((event) => event.eventType), ["link", "writeback", "end"]);

  const repeated = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-repeat",
    now: new Date(),
    execute,
  });
  assert.equal(repeated.status, "not-claimed");
  assert.equal(repeated.modelsInvoked, 0);
  assert.equal(calls, 1);
  const proposalDirectory = path.join(
    state.root,
    "00_本地工作台/派生数据/agent-task-runtime/proposals",
    result.runId,
  );
  await fs.mkdir(proposalDirectory, { recursive: true });
  await fs.writeFile(path.join(proposalDirectory, "attempt-1.json"), "stale proposal\n");
  await fs.writeFile(path.join(proposalDirectory, "attempt-1.outcome.json"), "stale outcome\n");
  const cleanup = await cleanupSettledResultProposals(state.root, ledger);
  assert.equal(cleanup.removed, 2);
  await assert.rejects(fs.stat(path.join(proposalDirectory, "attempt-1.json")),
    (error) => error?.code === "ENOENT");
});

test("严格 completed 回执保留时原件重开只迁移一次，新的 progress 回执会终止再次迁移", async (t) => {
  const state = await fixture(t, { id: "agent-strict-migration" });
  let calls = 0;
  const first = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-migration-first",
    now: state.now,
    execute: async (invocation) => {
      calls += 1;
      await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
      await fillCliOutcome(cliOutputPath(invocation), {
        status: "completed",
        summary: "第一代运行已经可信完成。",
        evidenceRefs: [FIXTURE_EVIDENCE_PATH],
        nextStep: "",
        nextReviewAt: null,
      });
      return successfulExecution();
    },
  });
  assert.equal(first.status, "settled");
  const completedSource = await fs.readFile(state.sourceAbsolute, "utf8");
  await fs.writeFile(
    state.sourceAbsolute,
    completedSource.replace(/- \[x\](.*ID：agent-strict-migration)/u, "- [ ]$1"),
  );

  const reopenedNow = new Date(state.now.getTime() + 1_000);
  let [snapshot, ledger] = await Promise.all([
    readProjectManagement(state.root, { now: reopenedNow }),
    readRuntimeLedger(state.ledgerPath, { now: reopenedNow }),
  ]);
  const sourceDoctor = await doctorRuntimeSourceConsistency({ root: state.root, ledger });
  assert.equal(sourceDoctor.issues.length, 1);
  assert.deepEqual(sourceDoctor.issues[0].reasons, ["SOURCE_RECEIPT_STATE_MISMATCH"]);
  assert.equal(sourceDoctor.issues[0].migrationEligible, true);
  const migrationPlan = await buildDispatchPlan({ root: state.root, snapshot, ledger, config: config(), now: reopenedNow });
  assert.ok(migrationPlan.selected);
  assert.equal(migrationPlan.selected.candidate.migrationReopen, true);
  assert.match(migrationPlan.selected.candidate.eligibilityRevision, /^migration-reopen-v1:/u);

  const migrated = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: migrationPlan.selected,
    owner: "dispatcher:test-migration-second",
    now: reopenedNow,
    execute: async (invocation) => {
      calls += 1;
      await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
      await fillCliOutcome(cliOutputPath(invocation), {
        status: "progress",
        summary: "原件重开后已按新一代意图重新判断。",
        evidenceRefs: [FIXTURE_EVIDENCE_PATH],
        nextStep: "等待下一项明确触发。",
        nextReviewAt: null,
      });
      return successfulExecution();
    },
  });
  assert.equal(migrated.status, "settled");
  assert.equal(calls, 2);

  const afterNow = new Date(reopenedNow.getTime() + 1_000);
  [snapshot, ledger] = await Promise.all([
    readProjectManagement(state.root, { now: afterNow }),
    readRuntimeLedger(state.ledgerPath, { now: afterNow }),
  ]);
  const afterDoctor = await doctorRuntimeSourceConsistency({ root: state.root, ledger });
  assert.deepEqual(afterDoctor.issues, []);
  const afterPlan = await buildDispatchPlan({ root: state.root, snapshot, ledger, config: config(), now: afterNow });
  assert.equal(afterPlan.selected, null);
  assert.ok(afterPlan.skipped.some((item) => item.taskId === "agent-strict-migration"
    && item.reasons.includes("formal-result-recorded")));
  const source = await fs.readFile(state.sourceAbsolute, "utf8");
  assert.equal((source.match(/自动回执：/gu) || []).length, 2);
});

test("回执缺失或摘要损坏是 hard drift，不能伪装成历史迁移资格", async (t) => {
  for (const scenario of ["missing", "digest-conflict", "malformed"]) {
    await t.test(scenario, async (st) => {
      const state = await fixture(st, { id: `agent-hard-drift-${scenario}` });
      let calls = 0;
      await dispatchSelected({
        root: state.root,
        ledgerPath: state.ledgerPath,
        config: config(),
        selected: state.plan.selected,
        owner: `dispatcher:test-hard-drift-${scenario}`,
        now: state.now,
        execute: async (invocation) => {
          calls += 1;
          await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
          await fillCliOutcome(cliOutputPath(invocation), {
            status: "completed",
            summary: "先建立一份可信完成基线。",
            evidenceRefs: [FIXTURE_EVIDENCE_PATH],
            nextStep: "",
            nextReviewAt: null,
          });
          return successfulExecution();
        },
      });
      let source = await fs.readFile(state.sourceAbsolute, "utf8");
      source = source.replace(new RegExp(`- \\[x\\](.*ID：agent-hard-drift-${scenario})`, "u"), "- [ ]$1");
      if (scenario === "missing") {
        source = source.replace(/^\s*- 自动回执：`\{.*\}`\r?\n/mu, "");
      } else if (scenario === "digest-conflict") {
        source = source.replace(/"proposalDigest":"[a-f0-9]{64}"/u, `"proposalDigest":"${"b".repeat(64)}"`);
      } else {
        source = source.replace(/(自动回执：`)\{.*\}(`)/u, `$1{"runId":}$2`);
      }
      await fs.writeFile(state.sourceAbsolute, source);
      const now = new Date(state.now.getTime() + 1_000);
      const [snapshot, ledger] = await Promise.all([
        readProjectManagement(state.root, { now }),
        readRuntimeLedger(state.ledgerPath, { now }),
      ]);
      const sourceDoctor = await doctorRuntimeSourceConsistency({ root: state.root, ledger });
      assert.equal(sourceDoctor.issues.length, 1);
      assert.equal(sourceDoctor.issues[0].migrationEligible, false);
      const plan = await buildDispatchPlan({ root: state.root, snapshot, ledger, config: config(), now });
      assert.equal(plan.selected, null);
      assert.ok(plan.skipped.some((item) => item.taskId === `agent-hard-drift-${scenario}`
        && item.reasons.includes("source-ledger-drift")));
      assert.equal(calls, 1, "hard drift must not start another model run");
    });
  }
});

test("复合触发的全部证据快照写入协调器回执，模型说明可引用其中子集", async (t) => {
  const secondPath = "00_本地工作台/30_证据/agent-task-fixture-second.md";
  const now = new Date();
  const state = await fixture(t, {
    now,
    id: "agent-multi-evidence",
    evidenceFiles: { [secondPath]: "第二份隔离验收证据。\n" },
    contract: automaticContract([{
      id: "all-evidence",
      type: "all",
      conditions: [
        { type: "evidence", path: FIXTURE_EVIDENCE_PATH },
        { type: "evidence", path: secondPath },
      ],
    }]),
  });
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-multi-evidence",
    now,
    execute: async (invocation) => {
      await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
      await fillCliOutcome(cliOutputPath(invocation), {
        status: "completed",
        summary: "复合证据门已由协调器整体复核。",
        evidenceRefs: [FIXTURE_EVIDENCE_PATH],
        nextStep: "",
        nextReviewAt: null,
      });
      return successfulExecution();
    },
  });
  assert.equal(result.status, "settled");
  const source = await fs.readFile(state.sourceAbsolute, "utf8");
  const receiptMatch = source.match(/自动回执：`(\{.*\})`/u);
  assert.ok(receiptMatch);
  const receipt = JSON.parse(receiptMatch[1]);
  assert.deepEqual(receipt.evidence.map((item) => item.path).sort(), [FIXTURE_EVIDENCE_PATH, secondPath].sort());
  assert.match(source, new RegExp(`证据：${FIXTURE_EVIDENCE_PATH.replaceAll("/", "\\/")}`, "u"));
});

test("子进程 0 退出但没有合法结果时按 process-failed 收口，不得勾选任务", async (t) => {
  const state = await fixture(t, { id: "agent-empty-result" });
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-empty",
    now: state.now,
    execute: async (invocation) => {
      await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
      return successfulExecution();
    },
  });
  assert.equal(result.status, "process-failed");
  assert.equal(result.writeback, false);
  assert.match(String(result.writebackErrorCode), /^RESULT_/u);
  const source = await fs.readFile(state.sourceAbsolute, "utf8");
  assert.match(source, /- \[ \].*ID：agent-empty-result/u);
  assert.doesNotMatch(source, /自动回执：/u);
  const ledger = await readRuntimeLedger(state.ledgerPath);
  const attempt = ledger.runs[result.runId].attempts[0];
  assert.equal(attempt.processOutcome.status, "failed");
  assert.equal(attempt.processOutcome.reasonCode, "process-reported-error");
  assert.notEqual(attempt.writebackOutcome.status, "succeeded");
});

test("启动回执前进程失败仍会结算为 not-started，不留活租约", async (t) => {
  const state = await fixture(t, { id: "agent-spawn-failed" });
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-spawn-failed",
    now: state.now,
    execute: async () => ({ exitCode: 127, signal: null, timedOut: false, started: false, threadId: null, error: new Error("synthetic spawn failure"), errorCode: "spawn-failed" }),
  });
  assert.equal(result.status, "process-failed");
  assert.equal(result.writeback, false);
  const ledger = await readRuntimeLedger(state.ledgerPath);
  const run = ledger.runs[result.runId];
  assert.equal(run.status, "settled");
  assert.equal(run.lease, null);
  assert.equal(run.attempts[0].startEvidence, null);
  assert.equal(run.attempts[0].processOutcome.status, "not-started");
  assert.deepEqual(ledger.executionLinkEvents, []);
});

test("畸形临时执行 ID 不能写启动回执，并会释放已认领租约", async (t) => {
  const state = await fixture(t, { id: "agent-malformed-execution-id" });
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-malformed-execution-id",
    now: state.now,
    execute: async (invocation) => runCodexJson({
      ...invocation,
      command: process.execPath,
      args: ["-e", 'console.log(JSON.stringify({type:"thread.started",thread_id:"bad"}));console.log(JSON.stringify({type:"turn.started"}));'],
      env: process.env,
    }),
  });
  assert.equal(result.status, "process-failed");
  assert.equal(result.writeback, false);
  assert.equal(result.processErrorCode, "start-receipt-rejected");
  const ledger = await readRuntimeLedger(state.ledgerPath);
  const run = ledger.runs[result.runId];
  assert.equal(run.status, "settled");
  assert.equal(run.lease, null);
  assert.equal(run.attempts[0].startEvidence, null);
  assert.equal(run.attempts[0].processOutcome.status, "not-started");
  assert.deepEqual(ledger.executionLinkEvents, []);
  assert.doesNotMatch(await fs.readFile(state.sourceAbsolute, "utf8"), /自动回执：/u);
});

test("可信启动后执行器 Promise 抛错也会结算租约并闭合执行关联", async (t) => {
  const state = await fixture(t, { id: "agent-executor-rejection" });
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-executor-rejection",
    now: state.now,
    execute: async (invocation) => {
      await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
      const error = new Error("synthetic executor rejection");
      error.code = "EXECUTOR_REJECTED";
      throw error;
    },
  });
  assert.equal(result.status, "process-failed");
  assert.equal(result.finalized, true);
  const ledger = await readRuntimeLedger(state.ledgerPath);
  const run = ledger.runs[result.runId];
  assert.equal(run.status, "settled");
  assert.equal(run.lease, null);
  assert.deepEqual(ledger.executionLinkEvents.map((event) => event.eventType), ["link", "end"]);
});

test("运行中证据版本变化会拒绝旧结果，下一轮以新游标重新取得资格", async (t) => {
  const state = await fixture(t, { id: "agent-evidence-race" });
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-evidence-race",
    now: state.now,
    execute: async (invocation) => {
      await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
      await fs.writeFile(path.join(state.root, FIXTURE_EVIDENCE_PATH), "新一轮隔离证据。\n");
      await fillCliOutcome(cliOutputPath(invocation), {
        status: "completed",
        summary: "旧证据游标下的结果必须作废。",
        evidenceRefs: [FIXTURE_EVIDENCE_PATH],
        nextStep: "",
        nextReviewAt: null,
      });
      return successfulExecution();
    },
  });
  assert.equal(result.status, "process-failed");
  assert.equal(result.writeback, false);
  assert.equal(result.writebackErrorCode, "ELIGIBILITY_CHANGED_DURING_RUN");
  assert.match(await fs.readFile(state.sourceAbsolute, "utf8"), /- \[ \].*ID：agent-evidence-race/u);

  const nextNow = new Date(state.now.getTime() + 1_000);
  const [snapshot, ledger] = await Promise.all([
    readProjectManagement(state.root, { now: nextNow }),
    readRuntimeLedger(state.ledgerPath, { now: nextNow }),
  ]);
  const plan = await buildDispatchPlan({ root: state.root, snapshot, ledger, config: config(), now: nextNow });
  assert.ok(plan.selected);
  assert.notEqual(plan.selected.candidate.triggerCursor, state.plan.selected.candidate.triggerCursor);
});

test("执行期间来源原件并行变化时失败关闭，保留他方修改且不写回旧结果", async (t) => {
  const state = await fixture(t, { id: "agent-source-conflict" });
  const result = await dispatchSelected({
    root: state.root,
    ledgerPath: state.ledgerPath,
    config: config(),
    selected: state.plan.selected,
    owner: "dispatcher:test-source-conflict",
    now: state.now,
    execute: async (invocation) => {
      await invocation.onStarted({ event: { type: "turn.started" }, threadId: THREAD_ID });
      await fs.appendFile(state.sourceAbsolute, "\n> concurrent-writer-marker\n");
      await fillCliOutcome(cliOutputPath(invocation), {
        status: "completed",
        summary: "这份旧结果应被拒绝。",
        evidenceRefs: [FIXTURE_EVIDENCE_PATH],
        nextStep: "",
        nextReviewAt: null,
      });
      return successfulExecution();
    },
  });
  assert.equal(result.status, "process-failed");
  assert.equal(result.writeback, false);
  assert.equal(result.writebackErrorCode, "SOURCE_CONFLICT");
  const source = await fs.readFile(state.sourceAbsolute, "utf8");
  assert.match(source, /concurrent-writer-marker/u);
  assert.match(source, /- \[ \].*ID：agent-source-conflict/u);
  assert.doesNotMatch(source, /这份旧结果应被拒绝/u);
  assert.doesNotMatch(source, /自动回执：/u);
  const ledger = await readRuntimeLedger(state.ledgerPath);
  const run = ledger.runs[result.runId];
  assert.equal(run.status, "settled");
  assert.equal(Object.values(run.effects).some((effect) => effect.appliedAt || effect.verifiedAt), false);
});
