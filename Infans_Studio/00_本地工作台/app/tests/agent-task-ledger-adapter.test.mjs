import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeEligibilityRevision,
  parseAgentTaskContract,
} from "../src/server/workbench-agent-task-contract.mjs";
import { parseProjectManagementDocument } from "../src/server/workbench-project-management.mjs";
import {
  ackStarted,
  claimRuntimeRun,
  eligibilityKeyHash,
  prepareRuntimeEffect,
  readRuntimeLedger,
  settleRuntimeRun,
  stableEffectId,
} from "../scripts/agent-task-runtime-ledger.mjs";
import { createAgentTaskLedgerAdapter } from "../scripts/agent-task-ledger-adapter.mjs";
import {
  createResultProposal,
  recordProcessExit as recordAgentTaskProcessExit,
  selfScheduleReviewEffectId,
  sourceContentHash,
  taskSnapshotFingerprint,
  taskWritebackEffectId,
  writeBackAgentTaskResult,
} from "../scripts/agent-task-writeback.mjs";

const SOURCE_PATH = "30_事业顺利/桥接测试/项目进度与待办.md";
const TASK_ID = "agent-ledger-adapter-fixture-20260904";
const EXECUTOR_ID = "codex-ai-acceptance";
const OWNER = "dispatcher-fixture";
const TRIGGER_ID = "review-time";
const PLATFORM_EXECUTION = Object.freeze({ platformId: "codex", executionId: "exec-ledger-adapter-1" });

function contract(overrides = {}) {
  return {
    version: 1,
    mode: "automatic",
    authorization: ["vault:read", "task:writeback"],
    lifecycle: 1,
    selfScheduleReview: true,
    triggers: [{ id: TRIGGER_ID, type: "time", at: "2026-09-04T00:00:00+09:00" }],
    ...overrides,
  };
}

function markdownFor(spec = contract(), sourceReviewAt = null) {
  return `---
description: 运行账桥接隔离测试
tags: [测试]
---

# 桥接测试

## 正在做

- [ ] 公司：验收：2026-09-04 · AI· 验证运行账桥接｜ID：${TASK_ID}｜执行器：${EXECUTOR_ID}${sourceReviewAt ? `｜复验时间：${sourceReviewAt}` : ""}
  - 完成门：隔离测试通过并能回读。
  - 自动推进：${JSON.stringify(spec)}

## 下一步

- 无

## 阻塞

- 无

## 最近完成

- 无
`;
}

function parsedTask(markdown) {
  const management = parseProjectManagementDocument(markdown, {
    sourcePath: SOURCE_PATH,
    projectId: "adapter-fixture",
    projectName: "桥接测试",
    todayKey: "2026-09-04",
  });
  return [...management.doing, ...management.next, ...management.blocked].find((task) => task.id === TASK_ID);
}

async function fixture(t, {
  spec = contract(),
  authorizedEffects = ["task.progress", "task.selfScheduleReview"],
  verifiedEvidence = [],
  started = true,
  platformExecution = PLATFORM_EXECUTION,
  sourceFileApi = fs,
  sourceReviewAt = null,
} = {}) {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "infans-ledger-adapter-"));
  t.after(() => fs.rm(vaultRoot, { recursive: true, force: true }));
  const sourceFile = path.join(vaultRoot, ...SOURCE_PATH.split("/"));
  const ledgerPath = path.join(vaultRoot, "runtime", "ledger.v2.json");
  const proposalPath = path.join(vaultRoot, "runtime", "proposal.json");
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  const markdown = markdownFor(spec, sourceReviewAt);
  await fs.writeFile(sourceFile, markdown, { mode: 0o600 });
  const task = parsedTask(markdown);
  assert.ok(task, "fixture task must parse");
  const parsed = parseAgentTaskContract(task.details);
  assert.equal(parsed.valid, true, JSON.stringify(parsed.errors));
  const eligibilityRevision = computeEligibilityRevision(task, parsed);
  const trigger = parsed.contract.triggers.find((item) => item.id === TRIGGER_ID) || parsed.contract.triggers[0];
  const eligibilityKey = {
    taskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityRevision,
    triggerId: trigger.id,
    triggerCursor: `time:${trigger.at}`,
  };
  const claim = await claimRuntimeRun(ledgerPath, {
    eligibilityKey,
    owner: OWNER,
    leaseDurationMs: 60 * 60 * 1_000,
  });
  if (started) {
    await ackStarted(ledgerPath, {
      runId: claim.runId,
      attemptNo: claim.attemptNo,
      owner: OWNER,
      evidence: {
        kind: "platform-execution",
        source: "codex",
        ...PLATFORM_EXECUTION,
      },
    });
  }
  const coordinatorContext = {
    runId: claim.runId,
    attemptNo: claim.attemptNo,
    taskId: TASK_ID,
    sourcePath: SOURCE_PATH,
    executorId: EXECUTOR_ID,
    eligibilityRevision,
    triggerId: trigger.id,
    triggerCursor: eligibilityKey.triggerCursor,
    effectId: taskWritebackEffectId({ taskId: TASK_ID, sourcePath: SOURCE_PATH }),
    taskFingerprint: taskSnapshotFingerprint(task),
    expectedSourceHash: sourceContentHash(markdown),
    authorizedEffects: [...authorizedEffects],
    verifiedEvidence: verifiedEvidence.map((item) => ({ ...item })),
  };
  const adapter = createAgentTaskLedgerAdapter({
    ledgerPath,
    vaultRoot,
    owner: OWNER,
    coordinatorContext,
    triggerId: trigger.id,
    platformExecution: started ? platformExecution : null,
    sourceFileApi,
  });
  return { vaultRoot, sourceFile, ledgerPath, proposalPath, markdown, task, parsed, eligibilityKey, claim, coordinatorContext, adapter };
}

async function proposal(setup, outcome) {
  await createResultProposal({ proposalPath: setup.proposalPath, effectId: setup.coordinatorContext.effectId });
  const value = JSON.parse(await fs.readFile(setup.proposalPath, "utf8"));
  value.outcome = outcome;
  await fs.writeFile(setup.proposalPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function recoverAttempt(setup) {
  await settleRuntimeRun(setup.ledgerPath, {
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    owner: OWNER,
    processOutcome: { status: "failed", exitCode: 70 },
    writebackOutcome: { status: "failed", reasonCode: "process-crashed" },
    readbackOutcome: { status: "failed", reasonCode: "effect-state-unknown" },
    errors: [{ code: "process-crashed", stage: "process", retryable: true }],
  });
  const claim = await claimRuntimeRun(setup.ledgerPath, {
    eligibilityKey: setup.eligibilityKey,
    owner: OWNER,
    leaseDurationMs: 60 * 60 * 1_000,
    retrySettled: true,
  });
  const platformExecution = { platformId: "codex", executionId: `exec-ledger-adapter-${claim.attemptNo}` };
  await ackStarted(setup.ledgerPath, {
    runId: claim.runId,
    attemptNo: claim.attemptNo,
    owner: OWNER,
    evidence: { kind: "platform-execution", source: "codex", ...platformExecution },
  });
  const coordinatorContext = {
    ...setup.coordinatorContext,
    attemptNo: claim.attemptNo,
    expectedSourceHash: sourceContentHash(await fs.readFile(setup.sourceFile)),
  };
  const adapter = createAgentTaskLedgerAdapter({
    ledgerPath: setup.ledgerPath,
    vaultRoot: setup.vaultRoot,
    owner: OWNER,
    coordinatorContext,
    triggerId: TRIGGER_ID,
    platformExecution,
  });
  return { ...setup, claim, coordinatorContext, adapter };
}

function writebackInput(setup) {
  return {
    vaultRoot: setup.vaultRoot,
    proposalPath: setup.proposalPath,
    coordinatorContext: setup.coordinatorContext,
    ledger: setup.adapter,
  };
}

function scheduleMeta(setup, nextReviewAt) {
  return {
    runId: setup.coordinatorContext.runId,
    attemptNo: setup.coordinatorContext.attemptNo,
    taskId: TASK_ID,
    sourcePath: SOURCE_PATH,
    executorId: EXECUTOR_ID,
    eligibilityRevision: setup.coordinatorContext.eligibilityRevision,
    effectId: selfScheduleReviewEffectId({ taskId: TASK_ID, sourcePath: SOURCE_PATH }),
    nextReviewAt,
  };
}

function verifiedEvidenceFor(...paths) {
  return paths.map((evidencePath) => ({ path: evidencePath, sha256: "f".repeat(64) }));
}

function reviewIntentDigest(nextReviewAt) {
  return crypto.createHash("sha256").update(JSON.stringify({ nextReviewAt })).digest("hex");
}

function normalizedProposalOutcome(value) {
  return {
    status: value.status,
    summary: value.summary,
    evidenceRefs: [...(value.evidenceRefs || [])],
    nextStep: value.nextStep,
    nextReviewAt: value.nextReviewAt ? new Date(value.nextReviewAt).toISOString() : null,
  };
}

function proposalDigestFor(setup, outcome) {
  return crypto.createHash("sha256").update(JSON.stringify({
    outcome: normalizedProposalOutcome(outcome),
    evidence: setup.coordinatorContext.verifiedEvidence,
  })).digest("hex");
}

function withReceiptState(markdown, outcomeInput, receipt) {
  const outcome = normalizedProposalOutcome(outcomeInput);
  const instant = new Date(receipt.writtenAt);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const minute = `${day} ${get("hour")}:${get("minute")}`;
  const statePrefix = { completed: "已完成", blocked: "阻塞", failed: "本轮失败", progress: "进行中" }[outcome.status];
  const resultWord = { completed: "通过", blocked: "受阻", failed: "失败", progress: "进行中" }[outcome.status];
  const evidence = outcome.evidenceRefs.length ? `\n    - 证据：${outcome.evidenceRefs.join("；")}` : "";
  const details = `
  - 进展时间：${minute}
  - 当前状态：${statePrefix}：${outcome.summary}
  - 下一步：${outcome.nextStep || "无需后续动作；本任务完成门已满足。"}
  - ${day} 自动运行结果：${resultWord}｜${outcome.summary}${evidence}
  - 自动回执：\`${JSON.stringify(receipt)}\`
`;
  const checked = outcome.status === "completed"
    ? markdown.replace(`- [ ] 公司：验收：2026-09-04`, `- [x] 公司：验收：2026-09-04`)
    : markdown;
  return checked.replace("\n## 下一步", `${details}\n## 下一步`);
}

function sourceApiFailingReads(sourceFile, { skip = 0, failuresToInject = 2 } = {}) {
  let sourceReads = 0;
  const sourceSuffix = path.relative(path.parse(sourceFile).root, sourceFile);
  const isSource = (value) => String(value).endsWith(sourceSuffix);
  return {
    realpath: (...args) => fs.realpath(...args),
    stat: (...args) => fs.stat(...args),
    open: (...args) => fs.open(...args),
    rename: (...args) => fs.rename(...args),
    rm: (...args) => fs.rm(...args),
    readFile: async (...args) => {
      const value = await fs.readFile(...args);
      if (isSource(args[0])) {
        sourceReads += 1;
      }
      if (isSource(args[0])
        && sourceReads > skip && sourceReads <= skip + failuresToInject) {
        const error = new Error("injected authoritative read failure");
        error.code = "EIO";
        throw error;
      }
      return value;
    },
  };
}

function adapterWithSourceApi(setup, sourceFileApi) {
  return createAgentTaskLedgerAdapter({
    ledgerPath: setup.ledgerPath,
    vaultRoot: setup.vaultRoot,
    owner: OWNER,
    coordinatorContext: setup.coordinatorContext,
    triggerId: TRIGGER_ID,
    platformExecution: PLATFORM_EXECUTION,
    sourceFileApi,
  });
}

test("上下文错配、平台执行错配与过期上下文不能进入公共写回", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    setup.adapter.assertRunContext({ ...setup.coordinatorContext, taskId: "another-task" }),
    (error) => error?.code === "RUN_CONTEXT_MISMATCH",
  );

  const wrongPlatform = createAgentTaskLedgerAdapter({
    ledgerPath: setup.ledgerPath,
    vaultRoot: setup.vaultRoot,
    owner: OWNER,
    coordinatorContext: setup.coordinatorContext,
    triggerId: TRIGGER_ID,
    platformExecution: { platformId: "codex", executionId: "different-execution" },
  });
  await assert.rejects(
    wrongPlatform.assertRunContext(setup.coordinatorContext),
    (error) => error?.code === "PLATFORM_EXECUTION_MISMATCH",
  );
});

test("已核验证据快照是必填密封上下文，顺序、路径或摘要不同都拒绝", async (t) => {
  const setup = await fixture(t, {
    verifiedEvidence: [
      { path: "30_事业顺利/桥接测试/30_证据/result.json", sha256: "A".repeat(64) },
      { path: "30_事业顺利/桥接测试/30_证据/output.log", sha256: "b".repeat(64) },
    ],
  });
  const canonical = await setup.adapter.assertRunContext(setup.coordinatorContext);
  assert.deepEqual(canonical.verifiedEvidence, [
    { path: "30_事业顺利/桥接测试/30_证据/result.json", sha256: "a".repeat(64) },
    { path: "30_事业顺利/桥接测试/30_证据/output.log", sha256: "b".repeat(64) },
  ]);
  assert.equal(Object.isFrozen(canonical), true);
  assert.equal(Object.isFrozen(canonical.verifiedEvidence), true);
  assert.equal(Object.isFrozen(canonical.verifiedEvidence[0]), true);

  await assert.rejects(
    setup.adapter.assertRunContext({
      ...setup.coordinatorContext,
      verifiedEvidence: [...setup.coordinatorContext.verifiedEvidence].reverse(),
    }),
    (error) => error?.code === "RUN_CONTEXT_MISMATCH",
  );
  await assert.rejects(
    setup.adapter.assertRunContext({
      ...setup.coordinatorContext,
      verifiedEvidence: [
        { ...setup.coordinatorContext.verifiedEvidence[0], path: "30_事业顺利/桥接测试/30_证据/other.json" },
        setup.coordinatorContext.verifiedEvidence[1],
      ],
    }),
    (error) => error?.code === "RUN_CONTEXT_MISMATCH",
  );
  await assert.rejects(
    setup.adapter.assertRunContext({
      ...setup.coordinatorContext,
      verifiedEvidence: [{ ...setup.coordinatorContext.verifiedEvidence[0], sha256: "c".repeat(64) }],
    }),
    (error) => error?.code === "RUN_CONTEXT_MISMATCH",
  );

  const baseOptions = {
    ledgerPath: setup.ledgerPath,
    vaultRoot: setup.vaultRoot,
    owner: OWNER,
    triggerId: TRIGGER_ID,
    platformExecution: PLATFORM_EXECUTION,
  };
  const missing = { ...setup.coordinatorContext };
  delete missing.verifiedEvidence;
  assert.throws(
    () => createAgentTaskLedgerAdapter({ ...baseOptions, coordinatorContext: missing }),
    (error) => error?.code === "RUN_CONTEXT_INVALID",
  );
  assert.throws(
    () => createAgentTaskLedgerAdapter({
      ...baseOptions,
      coordinatorContext: {
        ...setup.coordinatorContext,
        verifiedEvidence: [{ path: "../outside.txt", sha256: "d".repeat(64) }],
      },
    }),
    (error) => error?.code === "EVIDENCE_PATH_INVALID",
  );
  assert.throws(
    () => createAgentTaskLedgerAdapter({
      ...baseOptions,
      coordinatorContext: {
        ...setup.coordinatorContext,
        verifiedEvidence: [{ path: "30_事业顺利/evidence.txt", sha256: "e".repeat(64), note: "forged" }],
      },
    }),
    (error) => error?.code === "RUN_CONTEXT_INVALID",
  );
});

test("重复写回只产生一次原件效果和一条执行写回事件", async (t) => {
  const setup = await fixture(t, {
    verifiedEvidence: verifiedEvidenceFor("tests/agent-task-ledger-adapter.test.mjs"),
  });
  await proposal(setup, {
    status: "progress",
    summary: "公共写回已经在隔离环境成立。",
    evidenceRefs: ["tests/agent-task-ledger-adapter.test.mjs"],
    nextStep: "继续执行退出收口。",
  });
  const first = await writeBackAgentTaskResult(writebackInput(setup));
  const once = await fs.readFile(setup.sourceFile, "utf8");
  const second = await writeBackAgentTaskResult(writebackInput(setup));
  const twice = await fs.readFile(setup.sourceFile, "utf8");
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(twice, once);
  assert.equal((twice.match(/自动回执/g) || []).length, 1);

  const state = await readRuntimeLedger(setup.ledgerPath);
  const run = state.runs[setup.claim.runId];
  assert.equal(run.effects[setup.coordinatorContext.effectId].receipts.length, 1);
  assert.equal(state.executionLinkEvents.filter((event) => event.eventType === "writeback").length, 1);
});

test("原件已有回执而旧尝试停在 prepared 时，新尝试只对账不再执行 apply", async (t) => {
  let setup = await fixture(t);
  const proposalOutcome = normalizedProposalOutcome({
    status: "progress",
    summary: "旧尝试已经把业务结果写入原件。",
    evidenceRefs: [],
    nextStep: "新尝试只补齐运行账。",
  });
  const proposalDigest = proposalDigestFor(setup, proposalOutcome);
  const target = `${SOURCE_PATH}#${TASK_ID}`;
  await prepareRuntimeEffect(setup.ledgerPath, {
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    owner: OWNER,
    primaryTaskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityKeyHash: eligibilityKeyHash(setup.eligibilityKey),
    effectType: "task.writeback",
    target,
    effectId: setup.coordinatorContext.effectId,
    intentDigest: proposalDigest,
  });
  const receipt = {
    schemaVersion: 1,
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    effectId: setup.coordinatorContext.effectId,
    outcome: "progress",
    proposalDigest,
    writtenAt: "2026-09-04T00:00:00.000Z",
  };
  const current = await fs.readFile(setup.sourceFile, "utf8");
  await fs.writeFile(setup.sourceFile, withReceiptState(current, proposalOutcome, receipt));
  setup = await recoverAttempt(setup);
  let applyCalls = 0;
  const result = await setup.adapter.runIdempotentEffect({
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    taskId: TASK_ID,
    sourcePath: SOURCE_PATH,
    executorId: EXECUTOR_ID,
    eligibilityRevision: setup.coordinatorContext.eligibilityRevision,
    effectId: setup.coordinatorContext.effectId,
    kind: "task.writeback",
    proposalDigest,
    proposalOutcome,
  }, async () => {
    applyCalls += 1;
    throw new Error("must not run");
  });
  assert.equal(applyCalls, 0);
  assert.equal(result.duplicate, false);
  assert.equal(result.receipt.recovered, true);
  const state = await readRuntimeLedger(setup.ledgerPath);
  assert.ok(state.runs[setup.claim.runId].effects[setup.coordinatorContext.effectId].appliedAt);
});

test("旧尝试 prepared 后崩溃且权威原件证明未写时，新尝试释放占位后只重写一次", async (t) => {
  let setup = await fixture(t, {
    verifiedEvidence: verifiedEvidenceFor("tests/agent-task-ledger-adapter.test.mjs"),
  });
  await prepareRuntimeEffect(setup.ledgerPath, {
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    owner: OWNER,
    primaryTaskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityKeyHash: eligibilityKeyHash(setup.eligibilityKey),
    effectType: "task.writeback",
    target: `${SOURCE_PATH}#${TASK_ID}`,
    effectId: setup.coordinatorContext.effectId,
    intentDigest: "a".repeat(64),
  });
  setup = await recoverAttempt(setup);
  await proposal(setup, {
    status: "progress",
    summary: "负回读后的安全重试已成立。",
    evidenceRefs: ["tests/agent-task-ledger-adapter.test.mjs"],
    nextStep: "核对运行账审计链。",
  });
  const result = await writeBackAgentTaskResult(writebackInput(setup));
  assert.equal(result.duplicate, false);
  const written = await fs.readFile(setup.sourceFile, "utf8");
  assert.equal((written.match(/自动回执/g) || []).length, 1);
  const state = await readRuntimeLedger(setup.ledgerPath);
  const effect = state.runs[setup.claim.runId].effects[setup.coordinatorContext.effectId];
  assert.ok(effect.appliedAt && effect.verifiedAt);
  assert.equal(effect.receipts.length, 2);
  assert.equal(effect.receipts[0].reconciliationEvidence.kind, "authoritative-negative-readback");
  assert.equal(effect.receipts[0].writebackOutcome.status, "failed");
  assert.equal(effect.receipts[1].writebackOutcome.status, "succeeded");
  assert.equal(state.executionLinkEvents.filter((event) => event.eventType === "writeback").length, 1);
});

test("主原件 rename 后回读暂时失败会保留 prepared，并在重试时只对账不重复写", async (t) => {
  let setup = await fixture(t, {
    verifiedEvidence: verifiedEvidenceFor("tests/agent-task-ledger-adapter.test.mjs"),
  });
  const faulting = sourceApiFailingReads(setup.sourceFile);
  setup = { ...setup, adapter: adapterWithSourceApi(setup, faulting) };
  await proposal(setup, {
    status: "progress",
    summary: "原件已经原子写入，等待运行账回读对账。",
    evidenceRefs: ["tests/agent-task-ledger-adapter.test.mjs"],
    nextStep: "重试时只补账。",
  });
  await assert.rejects(
    writeBackAgentTaskResult(writebackInput(setup)),
    (error) => error?.code === "EIO",
  );
  const once = await fs.readFile(setup.sourceFile, "utf8");
  assert.equal((once.match(/自动回执/g) || []).length, 1);
  let state = await readRuntimeLedger(setup.ledgerPath);
  const effect = state.runs[setup.claim.runId].effects[setup.coordinatorContext.effectId];
  assert.ok(effect.preparedAt);
  assert.equal(effect.appliedAt, null);

  setup = { ...setup, adapter: adapterWithSourceApi(setup, fs) };
  const recovered = await writeBackAgentTaskResult(writebackInput(setup));
  assert.equal(recovered.duplicate, false);
  const twice = await fs.readFile(setup.sourceFile, "utf8");
  assert.equal(twice, once);
  state = await readRuntimeLedger(setup.ledgerPath);
  assert.ok(state.runs[setup.claim.runId].effects[setup.coordinatorContext.effectId].verifiedAt);
});

test("残缺、错 attempt 与坏 JSON 回执都不能补记成功或触发负回读重写", async (t) => {
  const cases = [
    {
      name: "残缺回执",
      receipt: (setup) => JSON.stringify({
        runId: setup.claim.runId,
        effectId: setup.coordinatorContext.effectId,
        proposalDigest: "a".repeat(64),
      }),
      code: "SOURCE_RECEIPT_MISMATCH",
    },
    {
      name: "错 attempt",
      receipt: (setup) => JSON.stringify({
        schemaVersion: 1,
        runId: setup.claim.runId,
        attemptNo: 999,
        effectId: setup.coordinatorContext.effectId,
        outcome: "progress",
        proposalDigest: "a".repeat(64),
        writtenAt: "2026-09-04T00:00:00.000Z",
      }),
      code: "SOURCE_RECEIPT_INVALID",
    },
    {
      name: "坏 JSON",
      receipt: (setup) => `{"runId":"${setup.claim.runId}","effectId":"${setup.coordinatorContext.effectId}","bad":}`,
      code: "SOURCE_RECEIPT_INVALID",
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async (st) => {
      let setup = await fixture(st);
      const proposalOutcome = normalizedProposalOutcome({
        status: "progress",
        summary: "本次回执必须先通过严格校验。",
        evidenceRefs: [],
        nextStep: "保留 prepared 等待人工对账。",
      });
      const proposalDigest = proposalDigestFor(setup, proposalOutcome);
      await prepareRuntimeEffect(setup.ledgerPath, {
        runId: setup.claim.runId,
        attemptNo: setup.claim.attemptNo,
        owner: OWNER,
        primaryTaskId: TASK_ID,
        executorRoleId: EXECUTOR_ID,
        eligibilityKeyHash: eligibilityKeyHash(setup.eligibilityKey),
        effectType: "task.writeback",
        target: `${SOURCE_PATH}#${TASK_ID}`,
        effectId: setup.coordinatorContext.effectId,
        intentDigest: proposalDigest,
      });
      const current = await fs.readFile(setup.sourceFile, "utf8");
      await fs.writeFile(setup.sourceFile, current.replace(
        "\n## 下一步",
        `\n  - 自动回执：\`${item.receipt(setup)}\`\n\n## 下一步`,
      ));
      setup = await recoverAttempt(setup);
      let applyCalls = 0;
      await assert.rejects(
        setup.adapter.runIdempotentEffect({
          runId: setup.claim.runId,
          attemptNo: setup.claim.attemptNo,
          taskId: TASK_ID,
          sourcePath: SOURCE_PATH,
          executorId: EXECUTOR_ID,
          eligibilityRevision: setup.coordinatorContext.eligibilityRevision,
          effectId: setup.coordinatorContext.effectId,
          kind: "task.writeback",
          proposalDigest,
          proposalOutcome,
        }, async () => {
          applyCalls += 1;
          return {};
        }),
        (error) => error?.code === item.code,
      );
      assert.equal(applyCalls, 0);
      const state = await readRuntimeLedger(setup.ledgerPath);
      const effect = state.runs[setup.claim.runId].effects[setup.coordinatorContext.effectId];
      assert.ok(effect.preparedAt);
      assert.equal(effect.appliedAt, null);
      assert.equal(effect.receipts.length, 0);
    });
  }
});

test("格式合法但 outcome 或实际状态与提议不一致的回执必须失败关闭", async (t) => {
  for (const mode of ["wrong-outcome", "missing-state-field"]) {
    await t.test(mode, async (st) => {
      const setup = await fixture(st);
      await proposal(setup, {
        status: "progress",
        summary: "严格回执必须对得上实际写入状态。",
        evidenceRefs: [],
        nextStep: "核对原件投影。",
      });
      await writeBackAgentTaskResult({ ...writebackInput(setup), now: new Date("2026-09-04T00:00:00.000Z") });
      const written = await fs.readFile(setup.sourceFile, "utf8");
      const corrupted = mode === "wrong-outcome"
        ? written.replace('"outcome":"progress"', '"outcome":"blocked"')
        : written.replace(/^  - 当前状态：.*\n/mu, "");
      await fs.writeFile(setup.sourceFile, corrupted, "utf8");

      await assert.rejects(
        writeBackAgentTaskResult({ ...writebackInput(setup), now: new Date("2026-09-04T00:00:00.000Z") }),
        (error) => error?.code === "SOURCE_RECEIPT_STATE_MISMATCH",
      );
      assert.equal(await fs.readFile(setup.sourceFile, "utf8"), corrupted);
    });
  }
});

test("apply 异常后严格回读发现 schema、attempt 或 evidence 异常时保留 prepared", async (t) => {
  for (const mode of ["schema", "attempt", "evidence"]) {
    await t.test(mode, async (st) => {
      const setup = await fixture(st);
      const proposalOutcome = normalizedProposalOutcome({
        status: "progress",
        summary: "源端现场可疑时不得清除 prepared。",
        evidenceRefs: [],
        nextStep: "保留现场并等待对账。",
      });
      const proposalDigest = proposalDigestFor(setup, proposalOutcome);
      const receipt = {
        schemaVersion: mode === "schema" ? 99 : 1,
        runId: setup.claim.runId,
        attemptNo: mode === "attempt" ? 999 : setup.claim.attemptNo,
        effectId: setup.coordinatorContext.effectId,
        outcome: "progress",
        proposalDigest,
        writtenAt: "2026-09-04T00:00:00.000Z",
        ...(mode === "evidence" ? { evidence: [{ path: "tests/agent-task-ledger-adapter.test.mjs", sha256: "f".repeat(64) }] } : {}),
      };
      await assert.rejects(
        setup.adapter.runIdempotentEffect({
          runId: setup.claim.runId,
          attemptNo: setup.claim.attemptNo,
          taskId: TASK_ID,
          sourcePath: SOURCE_PATH,
          executorId: EXECUTOR_ID,
          eligibilityRevision: setup.coordinatorContext.eligibilityRevision,
          effectId: setup.coordinatorContext.effectId,
          kind: "task.writeback",
          proposalDigest,
          proposalOutcome,
        }, async () => {
          const current = await fs.readFile(setup.sourceFile, "utf8");
          await fs.writeFile(setup.sourceFile, current.replace(
            "\n## 下一步",
            `\n  - 自动回执：\`${JSON.stringify(receipt)}\`\n\n## 下一步`,
          ));
          throw new Error("simulated-apply-crash");
        }),
        (error) => new Set([
          "SOURCE_RECEIPT_MISMATCH",
          "SOURCE_RECEIPT_INVALID",
          "SOURCE_RECEIPT_EVIDENCE_MISMATCH",
        ]).has(error?.code),
      );
      const state = await readRuntimeLedger(setup.ledgerPath);
      const effect = state.runs[setup.claim.runId].effects[setup.coordinatorContext.effectId];
      assert.ok(effect.preparedAt);
      assert.equal(effect.intentDigest, proposalDigest);
      assert.equal(effect.appliedAt, null);
      assert.equal(effect.receipts.length, 0);
    });
  }
});

test("原件单写者门会串行同文件的协作写者并清理锁", async (t) => {
  const setup = await fixture(t);
  let active = 0;
  let maximum = 0;
  let enterFirst;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const first = setup.adapter.withSourceMutation(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    enterFirst();
    await firstRelease;
    active -= 1;
  });
  await firstEntered;
  let secondEntered = false;
  const second = setup.adapter.withSourceMutation(async () => {
    secondEntered = true;
    active += 1;
    maximum = Math.max(maximum, active);
    active -= 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
  await assert.rejects(fs.stat(`${setup.sourceFile}.agent-task-source.lock`), (error) => error?.code === "ENOENT");
});

test("非零退出保留已成立写回，但运行不成为可信完成", async (t) => {
  const setup = await fixture(t, {
    verifiedEvidence: verifiedEvidenceFor("evidence/before-process-exit.txt"),
  });
  await proposal(setup, {
    status: "progress",
    summary: "业务事实已经写回。",
    evidenceRefs: ["evidence/before-process-exit.txt"],
    nextStep: "下次尝试继续收口。",
  });
  await writeBackAgentTaskResult(writebackInput(setup));
  const event = await recordAgentTaskProcessExit({
    coordinatorContext: setup.coordinatorContext,
    ledger: setup.adapter,
    exitCode: 17,
    errorCode: "PROCESS_EXIT",
  });
  assert.equal(event.phase, "process-failed-after-writeback");
  const state = await readRuntimeLedger(setup.ledgerPath);
  const attempt = state.runs[setup.claim.runId].attempts[0];
  assert.equal(attempt.processOutcome.status, "failed");
  assert.equal(attempt.processOutcome.exitCode, 17);
  assert.equal(attempt.writebackOutcome.status, "succeeded");
  assert.equal(attempt.readbackOutcome.status, "succeeded");
});

test("零退出没有可信写回时只结算进程，不得宣称自动完成", async (t) => {
  const setup = await fixture(t);
  const event = await recordAgentTaskProcessExit({
    coordinatorContext: setup.coordinatorContext,
    ledger: setup.adapter,
    exitCode: 0,
  });
  assert.equal(event.phase, "incomplete");
  const state = await readRuntimeLedger(setup.ledgerPath);
  const attempt = state.runs[setup.claim.runId].attempts[0];
  assert.equal(attempt.processOutcome.status, "succeeded");
  assert.equal(attempt.writebackOutcome.status, "failed");
  assert.equal(attempt.readbackOutcome.status, "failed");
  assert.match(attempt.errors.map((item) => item.code).join(" "), /trusted-writeback-missing/u);
});

test("零退出但带调度错误时，已写回主效果也不得伪装成功", async (t) => {
  const setup = await fixture(t);
  await proposal(setup, {
    status: "progress",
    summary: "主写回已经成立。",
    evidenceRefs: [],
    nextStep: "继续完成调度。",
  });
  await writeBackAgentTaskResult(writebackInput(setup));
  await setup.adapter.recordProcessExit({
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    taskId: TASK_ID,
    sourcePath: SOURCE_PATH,
    executorId: EXECUTOR_ID,
    effectId: setup.coordinatorContext.effectId,
    exitCode: 0,
    signal: null,
    errorCode: "SCHEDULE_WRITE_FAILED",
  });
  const state = await readRuntimeLedger(setup.ledgerPath);
  const attempt = state.runs[setup.claim.runId].attempts[0];
  assert.equal(attempt.processOutcome.status, "failed");
  assert.equal(attempt.processOutcome.exitCode, undefined);
  assert.equal(attempt.processOutcome.reasonCode, "process-reported-error");
  assert.equal(attempt.writebackOutcome.status, "succeeded");
});

test("启动前失败可以结算为 not-started，但不放宽正式写回门", async (t) => {
  const setup = await fixture(t, { started: false });
  const result = await setup.adapter.recordProcessExit({
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    taskId: TASK_ID,
    sourcePath: SOURCE_PATH,
    executorId: EXECUTOR_ID,
    effectId: setup.coordinatorContext.effectId,
    exitCode: null,
    signal: null,
    errorCode: "spawn-failed",
  });
  assert.equal(result.trustedCompletion, false);
  const state = await readRuntimeLedger(setup.ledgerPath);
  const attempt = state.runs[setup.claim.runId].attempts[0];
  assert.equal(attempt.processOutcome.status, "not-started");
  assert.equal(attempt.writebackOutcome.status, "failed");
  assert.equal(attempt.readbackOutcome.status, "failed");
});

test("没有可信启动回执时始终收口为 not-started，并保留启动失败分类", async (t) => {
  const cases = [
    { name: "进程退出 0 但没有 started 回执", exitCode: 0, errorCode: null, expected: "start-receipt-missing" },
    { name: "active writer", exitCode: 1, errorCode: "ACTIVE_WRITER", expected: "active-writer" },
    { name: "启动回执被拒绝", exitCode: 0, errorCode: "start-receipt-rejected", expected: "start-receipt-rejected" },
  ];
  for (const item of cases) {
    await t.test(item.name, async (st) => {
      const setup = await fixture(st, { started: false });
      const result = await setup.adapter.recordProcessExit({
        runId: setup.claim.runId,
        attemptNo: setup.claim.attemptNo,
        taskId: TASK_ID,
        sourcePath: SOURCE_PATH,
        executorId: EXECUTOR_ID,
        effectId: setup.coordinatorContext.effectId,
        exitCode: item.exitCode,
        signal: null,
        errorCode: item.errorCode,
      });
      assert.equal(result.trustedCompletion, false);
      const state = await readRuntimeLedger(setup.ledgerPath);
      const run = state.runs[setup.claim.runId];
      const attempt = run.attempts[0];
      assert.equal(run.status, "settled");
      assert.equal(run.lease, null);
      assert.equal(attempt.startEvidence, null);
      assert.deepEqual(attempt.processOutcome, { status: "not-started", reasonCode: item.expected });
      assert.equal(attempt.errors[0].code, item.expected);
      assert.equal(attempt.errors[0].stage, "start");
    });
  }
});

test("自排复验只替换唯一同 ID 时间触发，重放不重复生效", async (t) => {
  const setup = await fixture(t);
  const nextReviewAt = "2026-09-05T01:00:00.000Z";
  await fs.writeFile(setup.sourceFile, setup.markdown.replace("# 桥接测试\n\n", "# 桥接测试\r\n\n"));
  const first = await setup.adapter.scheduleReview(scheduleMeta(setup, nextReviewAt));
  const once = await fs.readFile(setup.sourceFile, "utf8");
  const second = await setup.adapter.scheduleReview(scheduleMeta(setup, nextReviewAt));
  const twice = await fs.readFile(setup.sourceFile, "utf8");
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(twice, once);
  assert.match(twice, /"id":"review-time","type":"time","at":"2026-09-05T01:00:00.000Z"/u);
  assert.match(twice, /｜复验时间：2026-09-05 10:00/u);
  assert.match(twice, /# 桥接测试\r\n\n/u, "不得顺手规范化任务块外的行尾");
  const state = await readRuntimeLedger(setup.ledgerPath);
  const effectId = stableEffectId("task.selfScheduleReview", `${SOURCE_PATH}#${TASK_ID}`);
  assert.equal(state.runs[setup.claim.runId].effects[effectId].receipts.length, 1);
});

test("公共写回后的自排复验可以整体重放，任务行与触发器始终一致", async (t) => {
  const setup = await fixture(t, {
    verifiedEvidence: verifiedEvidenceFor("tests/agent-task-ledger-adapter.test.mjs"),
  });
  await proposal(setup, {
    status: "progress",
    summary: "等待下一个复验窗口。",
    evidenceRefs: ["tests/agent-task-ledger-adapter.test.mjs"],
    nextStep: "按新时间复验。",
    nextReviewAt: "2026-09-05T10:00:00+09:00",
  });
  const first = await writeBackAgentTaskResult(writebackInput(setup));
  const once = await fs.readFile(setup.sourceFile, "utf8");
  const second = await writeBackAgentTaskResult(writebackInput(setup));
  const twice = await fs.readFile(setup.sourceFile, "utf8");
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(twice, once);
  assert.match(twice, /｜复验时间：2026-09-05 10:00/u);
  assert.match(twice, /"id":"review-time","type":"time","at":"2026-09-05T01:00:00.000Z"/u);
  const state = await readRuntimeLedger(setup.ledgerPath);
  assert.equal(Object.values(state.runs[setup.claim.runId].effects).filter((effect) => effect.appliedAt).length, 2);
});

test("自排复验在旧尝试 prepare 后未写入时，新尝试负回读后安全重试", async (t) => {
  let setup = await fixture(t);
  const nextReviewAt = "2026-09-05T01:00:00.000Z";
  const effectId = selfScheduleReviewEffectId({ taskId: TASK_ID, sourcePath: SOURCE_PATH });
  await prepareRuntimeEffect(setup.ledgerPath, {
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    owner: OWNER,
    primaryTaskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityKeyHash: eligibilityKeyHash(setup.eligibilityKey),
    effectType: "task.selfScheduleReview",
    target: `${SOURCE_PATH}#${TASK_ID}`,
    effectId,
    intentDigest: reviewIntentDigest(nextReviewAt),
  });
  setup = await recoverAttempt(setup);
  await setup.adapter.scheduleReview(scheduleMeta(setup, nextReviewAt));
  const written = await fs.readFile(setup.sourceFile, "utf8");
  assert.match(written, /｜复验时间：2026-09-05 10:00/u);
  assert.match(written, /"id":"review-time","type":"time","at":"2026-09-05T01:00:00.000Z"/u);
  const state = await readRuntimeLedger(setup.ledgerPath);
  const effect = state.runs[setup.claim.runId].effects[effectId];
  assert.ok(effect.appliedAt && effect.verifiedAt);
  assert.equal(effect.receipts.length, 2);
  assert.equal(effect.receipts[0].reconciliationEvidence.kind, "authoritative-negative-readback");
  assert.equal(effect.receipts[1].writebackOutcome.status, "succeeded");
});

test("自排复验 rename 后回读失败保留 prepared，健康重试只补账", async (t) => {
  let setup = await fixture(t);
  const nextReviewAt = "2026-09-05T01:00:00.000Z";
  const faulting = sourceApiFailingReads(setup.sourceFile, { skip: 2 });
  setup = { ...setup, adapter: adapterWithSourceApi(setup, faulting) };
  await assert.rejects(
    setup.adapter.scheduleReview(scheduleMeta(setup, nextReviewAt)),
    (error) => error?.code === "EIO",
  );
  const once = await fs.readFile(setup.sourceFile, "utf8");
  assert.match(once, /｜复验时间：2026-09-05 10:00/u);
  let state = await readRuntimeLedger(setup.ledgerPath);
  const effectId = selfScheduleReviewEffectId({ taskId: TASK_ID, sourcePath: SOURCE_PATH });
  assert.ok(state.runs[setup.claim.runId].effects[effectId].preparedAt);
  assert.equal(state.runs[setup.claim.runId].effects[effectId].appliedAt, null);

  setup = { ...setup, adapter: adapterWithSourceApi(setup, fs) };
  await setup.adapter.scheduleReview(scheduleMeta(setup, nextReviewAt));
  assert.equal(await fs.readFile(setup.sourceFile, "utf8"), once);
  state = await readRuntimeLedger(setup.ledgerPath);
  assert.ok(state.runs[setup.claim.runId].effects[effectId].verifiedAt);
});

test("新结果省略旧 prepared 自排复验时会退役次效果，主写回仍可可信结算", async (t) => {
  let setup = await fixture(t, {
    verifiedEvidence: verifiedEvidenceFor("tests/agent-task-ledger-adapter.test.mjs"),
  });
  const effectId = selfScheduleReviewEffectId({ taskId: TASK_ID, sourcePath: SOURCE_PATH });
  await prepareRuntimeEffect(setup.ledgerPath, {
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    owner: OWNER,
    primaryTaskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityKeyHash: eligibilityKeyHash(setup.eligibilityKey),
    effectType: "task.selfScheduleReview",
    target: `${SOURCE_PATH}#${TASK_ID}`,
    effectId,
    intentDigest: reviewIntentDigest("2026-09-05T01:00:00.000Z"),
  });
  setup = await recoverAttempt(setup);
  await proposal(setup, {
    status: "progress",
    summary: "本轮不再需要安排复验。",
    evidenceRefs: ["tests/agent-task-ledger-adapter.test.mjs"],
    nextStep: "收口本轮运行。",
  });
  await writeBackAgentTaskResult({ ...writebackInput(setup), now: new Date("2026-09-04T06:00:00.000Z") });
  const exit = await recordAgentTaskProcessExit({
    coordinatorContext: setup.coordinatorContext,
    ledger: setup.adapter,
    exitCode: 0,
    now: new Date("2026-09-04T06:01:00.000Z"),
  });
  assert.equal(exit.phase, "settled");
  const state = await readRuntimeLedger(setup.ledgerPath);
  const run = state.runs[setup.claim.runId];
  assert.equal(run.status, "settled");
  assert.ok(run.effects[effectId].retiredAt);
  assert.equal(run.effects[effectId].receipts[0].intentDigest, reviewIntentDigest("2026-09-05T01:00:00.000Z"));
  assert.ok(run.effects[setup.coordinatorContext.effectId].appliedAt);
  assert.deepEqual(run.attempts.at(-1).writebackOutcome.effectIds, [setup.coordinatorContext.effectId]);
});

test("上一轮双字段时间 P 不得被误认为当前 prepared A，新尝试可安全省略 review", async (t) => {
  let setup = await fixture(t, { sourceReviewAt: "2026-09-04 00:00" });
  const preparedReviewAt = "2026-09-05T01:00:00.000Z";
  const effectId = selfScheduleReviewEffectId({ taskId: TASK_ID, sourcePath: SOURCE_PATH });
  await prepareRuntimeEffect(setup.ledgerPath, {
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    owner: OWNER,
    primaryTaskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityKeyHash: eligibilityKeyHash(setup.eligibilityKey),
    effectType: "task.selfScheduleReview",
    target: `${SOURCE_PATH}#${TASK_ID}`,
    effectId,
    intentDigest: reviewIntentDigest(preparedReviewAt),
  });
  setup = await recoverAttempt(setup);
  await proposal(setup, {
    status: "progress",
    summary: "本轮明确不再自排下一次复验。",
    evidenceRefs: [],
    nextStep: "保留上轮触发时间作为历史现场。",
  });
  await writeBackAgentTaskResult({ ...writebackInput(setup), now: new Date("2026-09-04T06:00:00.000Z") });

  const written = await fs.readFile(setup.sourceFile, "utf8");
  assert.match(written, /｜复验时间：2026-09-04 00:00/u);
  assert.doesNotMatch(written, /｜复验时间：2026-09-05 10:00/u);
  const state = await readRuntimeLedger(setup.ledgerPath);
  const effect = state.runs[setup.claim.runId].effects[effectId];
  assert.ok(effect.retiredAt);
  assert.equal(effect.receipts[0].intentDigest, reviewIntentDigest(preparedReviewAt));
  assert.equal(effect.receipts[0].reconciliationEvidence.kind, "authoritative-negative-readback");
});

test("旧 prepared 自排复验 A 可在主写前负回读，再以 B 恰好生效一次", async (t) => {
  let setup = await fixture(t, {
    verifiedEvidence: verifiedEvidenceFor("tests/agent-task-ledger-adapter.test.mjs"),
  });
  const reviewA = "2026-09-05T01:00:00.000Z";
  const reviewB = "2026-09-06T02:00:00.000Z";
  const effectId = selfScheduleReviewEffectId({ taskId: TASK_ID, sourcePath: SOURCE_PATH });
  await prepareRuntimeEffect(setup.ledgerPath, {
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    owner: OWNER,
    primaryTaskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityKeyHash: eligibilityKeyHash(setup.eligibilityKey),
    effectType: "task.selfScheduleReview",
    target: `${SOURCE_PATH}#${TASK_ID}`,
    effectId,
    intentDigest: reviewIntentDigest(reviewA),
  });
  setup = await recoverAttempt(setup);
  await proposal(setup, {
    status: "progress",
    summary: "改到新的复验时刻继续。",
    evidenceRefs: ["tests/agent-task-ledger-adapter.test.mjs"],
    nextStep: "到新时刻复验。",
    nextReviewAt: reviewB,
  });
  await writeBackAgentTaskResult({ ...writebackInput(setup), now: new Date("2026-09-04T06:00:00.000Z") });
  const written = await fs.readFile(setup.sourceFile, "utf8");
  assert.match(written, /｜复验时间：2026-09-06 11:00/u);
  assert.match(written, /"at":"2026-09-06T02:00:00.000Z"/u);
  const state = await readRuntimeLedger(setup.ledgerPath);
  const effect = state.runs[setup.claim.runId].effects[effectId];
  assert.equal(effect.intentDigest, reviewIntentDigest(reviewB));
  assert.equal(effect.receipts.length, 2);
  assert.equal(effect.receipts[0].intentDigest, reviewIntentDigest(reviewA));
  assert.equal(effect.receipts[0].reconciliationEvidence.kind, "authoritative-negative-readback");
  assert.equal(effect.receipts[1].intentDigest, reviewIntentDigest(reviewB));
  assert.equal(effect.receipts[1].writebackOutcome.status, "succeeded");
});

test("原件已完整成立旧排期时，改成 B 或省略都不能静默覆盖", async (t) => {
  for (const mode of ["replace", "omit"]) {
    await t.test(mode, async (st) => {
      let setup = await fixture(st, {
        verifiedEvidence: verifiedEvidenceFor("tests/agent-task-ledger-adapter.test.mjs"),
      });
      const reviewA = "2026-09-05T01:00:00.000Z";
      const faulting = sourceApiFailingReads(setup.sourceFile, { skip: 2 });
      setup = { ...setup, adapter: adapterWithSourceApi(setup, faulting) };
      await assert.rejects(
        setup.adapter.scheduleReview(scheduleMeta(setup, reviewA)),
        (error) => error?.code === "EIO",
      );
      const before = await fs.readFile(setup.sourceFile, "utf8");
      setup = await recoverAttempt(setup);
      await proposal(setup, {
        status: "progress",
        summary: mode === "replace" ? "尝试替换已成立排期。" : "尝试省略已成立排期。",
        evidenceRefs: ["tests/agent-task-ledger-adapter.test.mjs"],
        nextStep: "等待明确冲突处理。",
        ...(mode === "replace" ? { nextReviewAt: "2026-09-06T02:00:00.000Z" } : {}),
      });
      await assert.rejects(
        writeBackAgentTaskResult({ ...writebackInput(setup), now: new Date("2026-09-04T06:00:00.000Z") }),
        (error) => error?.code === "EFFECT_PAYLOAD_CONFLICT",
      );
      assert.equal(await fs.readFile(setup.sourceFile, "utf8"), before);
      const state = await readRuntimeLedger(setup.ledgerPath);
      assert.equal(Boolean(state.runs[setup.claim.runId].effects[setup.coordinatorContext.effectId]?.appliedAt), false);
    });
  }
});

test("原件只写入一半排期状态时必须人工对账，不能自动换绑", async (t) => {
  let setup = await fixture(t, {
    verifiedEvidence: verifiedEvidenceFor("tests/agent-task-ledger-adapter.test.mjs"),
  });
  const reviewA = "2026-09-05T01:00:00.000Z";
  const effectId = selfScheduleReviewEffectId({ taskId: TASK_ID, sourcePath: SOURCE_PATH });
  await prepareRuntimeEffect(setup.ledgerPath, {
    runId: setup.claim.runId,
    attemptNo: setup.claim.attemptNo,
    owner: OWNER,
    primaryTaskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityKeyHash: eligibilityKeyHash(setup.eligibilityKey),
    effectType: "task.selfScheduleReview",
    target: `${SOURCE_PATH}#${TASK_ID}`,
    effectId,
    intentDigest: reviewIntentDigest(reviewA),
  });
  const partial = (await fs.readFile(setup.sourceFile, "utf8")).replace(
    `｜ID：${TASK_ID}｜执行器：${EXECUTOR_ID}`,
    `｜ID：${TASK_ID}｜执行器：${EXECUTOR_ID}｜复验时间：2026-09-05 10:00`,
  );
  await fs.writeFile(setup.sourceFile, partial);
  setup = await recoverAttempt(setup);
  await proposal(setup, {
    status: "progress",
    summary: "半份排期不得被覆盖。",
    evidenceRefs: ["tests/agent-task-ledger-adapter.test.mjs"],
    nextStep: "人工核对原件。",
    nextReviewAt: "2026-09-06T02:00:00.000Z",
  });
  await assert.rejects(
    writeBackAgentTaskResult({ ...writebackInput(setup), now: new Date("2026-09-04T06:00:00.000Z") }),
    (error) => error?.code === "EFFECT_RECONCILIATION_REQUIRED",
  );
  assert.equal(await fs.readFile(setup.sourceFile, "utf8"), partial);
});

test("自排复验的协调器越权与非单时间 v1 契约都失败关闭", async (t) => {
  await t.test("协调器未授权", async (st) => {
    const setup = await fixture(st, { authorizedEffects: ["task.progress"] });
    await assert.rejects(
      setup.adapter.scheduleReview(scheduleMeta(setup, "2026-09-05T01:00:00.000Z")),
      (error) => error?.code === "SELF_SCHEDULE_REVIEW_FORBIDDEN",
    );
    assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
  });

  await t.test("两个时间触发", async (st) => {
    const spec = contract({
      triggers: [
        { id: TRIGGER_ID, type: "time", at: "2026-09-04T00:00:00+09:00" },
        { id: "another-time", type: "time", at: "2026-09-06T00:00:00+09:00" },
      ],
    });
    const setup = await fixture(st, { spec });
    await assert.rejects(
      setup.adapter.scheduleReview(scheduleMeta(setup, "2026-09-05T01:00:00.000Z")),
      (error) => error?.code === "SELF_SCHEDULE_REVIEW_UNSUPPORTED",
    );
    assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
  });
});
