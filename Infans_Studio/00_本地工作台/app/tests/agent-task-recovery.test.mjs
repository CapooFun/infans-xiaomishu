import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ackStarted,
  appendExecutionLinkEvent,
  claimRuntimeRun,
  eligibilityKeyHash,
  prepareRuntimeEffect,
  readRuntimeLedger,
  recordRuntimeEffect,
  recoverExpiredRuntimeRun,
  settleRuntimeRun,
  stableEffectId,
} from "../scripts/agent-task-runtime-ledger.mjs";
import {
  enumerateExpiredRuntimeRuns,
  recoverExpiredAgentTaskRuns,
} from "../scripts/agent-task-recovery.mjs";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:00:01.000Z";
const T2 = "2026-09-04T00:00:02.000Z";
const T3 = "2026-09-04T00:00:03.000Z";
const SOURCE_PATH = "30_事业顺利/恢复测试/项目进度与待办.md";
const TASK_ID = "agent-task-crash-recovery-20260904";
const EXECUTOR_ID = "codex-ai-acceptance";
const OWNER = "dispatcher-before-crash";
const NEXT_REVIEW_AT = "2026-09-04T18:30:00.000Z";
const DEFAULT_EVIDENCE = Object.freeze([
  Object.freeze({ path: "30_事业顺利/恢复测试/30_证据/recovery-proof.md", sha256: "e".repeat(64) }),
]);

function reviewIntentDigest(nextReviewAt = NEXT_REVIEW_AT) {
  return crypto.createHash("sha256").update(JSON.stringify({ nextReviewAt })).digest("hex");
}

function eligibility(overrides = {}) {
  return {
    taskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityRevision: "intent-before-crash",
    triggerId: "review-time",
    triggerCursor: "time:2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

function contract(at = "2026-09-04T00:00:00Z") {
  return {
    version: 1,
    mode: "automatic",
    authorization: ["vault:read", "task:writeback"],
    lifecycle: 1,
    selfScheduleReview: true,
    triggers: [{ id: "review-time", type: "time", at }],
  };
}

function markdown({
  runId = null,
  attemptNo = 1,
  effectId = null,
  proposalDigest = "a".repeat(64),
  outcome = "completed",
  nextReviewAt = null,
  evidence = outcome === "completed" ? DEFAULT_EVIDENCE : [],
  completed = outcome === "completed",
  scheduled = false,
} = {}) {
  const review = scheduled ? "｜复验时间：2026-09-05 03:30" : "";
  const spec = contract(scheduled ? "2026-09-05T03:30:00+09:00" : "2026-09-04T00:00:00Z");
  const receipt = runId && effectId
    ? `\n  - 自动回执：\`${JSON.stringify({
      schemaVersion: 1,
      runId,
      attemptNo,
      effectId,
      outcome,
      proposalDigest,
      writtenAt: T1,
      ...(evidence.length ? { evidence } : {}),
      ...(nextReviewAt ? { nextReviewAt } : {}),
    })}\``
    : "";
  return `---
description: crash recovery 隔离测试
tags: [测试]
---

# 恢复测试

## ${completed ? "最近完成" : "正在做"}

- [${completed ? "x" : " "}] 公司：验收：2026-09-04 · AI· 恢复旧运行｜ID：${TASK_ID}｜执行器：${EXECUTOR_ID}${review}
  - 完成门：恢复后账本与原件一致。
  - 自动推进：${JSON.stringify(spec)}${receipt}
`;
}

async function fixture(t) {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "infans-task-recovery-"));
  t.after(() => fs.rm(vaultRoot, { recursive: true, force: true }));
  const sourceFile = path.join(vaultRoot, ...SOURCE_PATH.split("/"));
  const ledgerPath = path.join(vaultRoot, "runtime", "ledger.v2.json");
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, markdown(), "utf8");
  return { vaultRoot, sourceFile, ledgerPath };
}

async function claimedRun(setup, t0 = T0, leaseDurationMs = 1_000, started = true) {
  const key = eligibility();
  const claim = await claimRuntimeRun(setup.ledgerPath, {
    eligibilityKey: key,
    owner: OWNER,
    leaseDurationMs,
  }, { clock: () => t0 });
  if (started) {
    await ackStarted(setup.ledgerPath, {
      runId: claim.runId,
      attemptNo: claim.attemptNo,
      owner: OWNER,
      evidence: {
        kind: "platform-execution",
        source: "codex-app",
        platformId: "codex",
        executionId: `exec-recovery-${claim.attemptNo}`,
        observedAt: t0,
      },
    }, { clock: () => t0 });
  }
  return { key, claim };
}

function context(key, claim) {
  return {
    runId: claim.runId,
    attemptNo: claim.attemptNo,
    owner: OWNER,
    primaryTaskId: TASK_ID,
    executorRoleId: EXECUTOR_ID,
    eligibilityKeyHash: eligibilityKeyHash(key),
  };
}

async function prepare(setup, run, effectType, now = T0) {
  const target = `${SOURCE_PATH}#${TASK_ID}`;
  const effectId = stableEffectId(effectType, target);
  await prepareRuntimeEffect(setup.ledgerPath, {
    ...context(run.key, run.claim),
    effectType,
    target,
    effectId,
    intentDigest: effectType === "task.writeback" ? "a".repeat(64) : reviewIntentDigest(),
  }, { clock: () => now });
  return effectId;
}

async function linkAttempt(setup, claim, now = T0) {
  return appendExecutionLinkEvent(setup.ledgerPath, {
    eventType: "link",
    platformId: "codex",
    executionId: `exec-recovery-${claim.attemptNo}`,
    taskId: TASK_ID,
    relation: "primary",
    runId: claim.runId,
    attemptNo: claim.attemptNo,
  }, { clock: () => now });
}

test("expired-run enumeration excludes active leases and settled runs", async (t) => {
  const setup = await fixture(t);
  await claimedRun(setup, T0, 60_000);
  const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T1 });
  assert.deepEqual(enumerateExpiredRuntimeRuns(state, T1), []);

  const result = await recoverExpiredAgentTaskRuns({
    vaultRoot: setup.vaultRoot,
    ledgerPath: setup.ledgerPath,
    now: new Date(T1),
  });
  assert.equal(result.expiredRuns, 0);
  assert.equal(result.modelsInvoked, 0);
  assert.equal(result.sourceWrites, 0);
  assert.equal((await readRuntimeLedger(setup.ledgerPath, { clock: () => T1 })).revision, state.revision);
});

test("source receipt and dual self-schedule fields reconcile an expired run without eligibility or source writes", async (t) => {
  const setup = await fixture(t);
  const run = await claimedRun(setup);
  const mainEffectId = await prepare(setup, run, "task.writeback");
  const scheduleEffectId = await prepare(setup, run, "task.selfScheduleReview");
  const link = await linkAttempt(setup, run.claim);
  const source = markdown({
    runId: run.claim.runId,
    effectId: mainEffectId,
    intentDigest: "a".repeat(64),
    outcome: "progress",
    nextReviewAt: NEXT_REVIEW_AT,
    evidence: DEFAULT_EVIDENCE,
    completed: false,
    scheduled: true,
  });
  await fs.writeFile(setup.sourceFile, source, "utf8");
  const beforeRecovery = await fs.readFile(setup.sourceFile);

  const result = await recoverExpiredAgentTaskRuns({
    vaultRoot: setup.vaultRoot,
    ledgerPath: setup.ledgerPath,
    now: new Date(T2),
  });
  assert.equal(result.expiredRuns, 1);
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].recoveredCompletely, true);
  assert.deepEqual(result.recovered[0].recoveredEffectIds, [mainEffectId, scheduleEffectId].sort());
  assert.equal(result.recovered[0].proposalDigest, "a".repeat(64));
  assert.equal(result.recovered[0].nextReviewAt, NEXT_REVIEW_AT);
  assert.ok(!result.recovered[0].issues.includes("SOURCE_RECEIPT_INVALID"));
  assert.equal(result.modelsInvoked, 0);
  assert.equal(result.sourceWrites, 0);
  assert.deepEqual(await fs.readFile(setup.sourceFile), beforeRecovery);

  const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T2 });
  const recoveredRun = state.runs[run.claim.runId];
  assert.equal(recoveredRun.status, "settled");
  assert.equal(recoveredRun.lease, null);
  assert.equal(recoveredRun.attempts[0].processOutcome.status, "unknown");
  assert.equal(recoveredRun.attempts[0].writebackOutcome.status, "succeeded");
  assert.equal(recoveredRun.attempts[0].readbackOutcome.status, "succeeded");
  assert.ok(recoveredRun.effects[mainEffectId].appliedAt && recoveredRun.effects[mainEffectId].verifiedAt);
  assert.ok(recoveredRun.effects[scheduleEffectId].appliedAt && recoveredRun.effects[scheduleEffectId].verifiedAt);
  assert.equal(state.executionLinkEvents.filter((event) => event.eventType === "writeback").length, 1);
  assert.equal(state.executionLinkEvents.filter((event) => event.eventType === "end" && event.linkEventId === link.eventId).length, 1);
});

test("an already committed effect closes its stale lease but remains source-inconsistent when the receipt disappeared", async (t) => {
  const setup = await fixture(t);
  const run = await claimedRun(setup);
  const mainEffectId = await prepare(setup, run, "task.writeback");
  await recordRuntimeEffect(setup.ledgerPath, {
    ...context(run.key, run.claim),
    effectType: "task.writeback",
    target: `${SOURCE_PATH}#${TASK_ID}`,
    effectId: mainEffectId,
    intentDigest: "a".repeat(64),
    writebackOutcome: { status: "succeeded" },
    readbackOutcome: { status: "succeeded" },
  }, { clock: () => T0 });
  const before = await fs.readFile(setup.sourceFile);

  const result = await recoverExpiredAgentTaskRuns({
    vaultRoot: setup.vaultRoot,
    ledgerPath: setup.ledgerPath,
    now: new Date(T2),
  });
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].recoveredCompletely, true);
  assert.equal(result.recovered[0].sourceConsistent, false);
  assert.ok(result.recovered[0].issues.includes("SOURCE_RECEIPT_MISSING"));
  assert.deepEqual(await fs.readFile(setup.sourceFile), before);
  const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T2 });
  assert.equal(state.runs[run.claim.runId].status, "settled");
  const repairedLink = state.executionLinkEvents.find((event) => event.eventType === "link"
    && event.runId === run.claim.runId && event.attemptNo === 1);
  assert.ok(repairedLink, "ledger recovery may close the old execution link without blessing source drift");
  assert.ok(state.executionLinkEvents.some((event) => event.eventType === "end" && event.linkEventId === repairedLink.eventId));
});

test("a verified A intent never blesses a legal-looking source B receipt or reconstructs B schedule", async (t) => {
  const setup = await fixture(t);
  const run = await claimedRun(setup);
  const mainEffectId = await prepare(setup, run, "task.writeback");
  await recordRuntimeEffect(setup.ledgerPath, {
    ...context(run.key, run.claim),
    effectType: "task.writeback",
    target: `${SOURCE_PATH}#${TASK_ID}`,
    effectId: mainEffectId,
    intentDigest: "a".repeat(64),
    writebackOutcome: { status: "succeeded" },
    readbackOutcome: { status: "succeeded" },
  }, { clock: () => T0 });
  const conflictingSource = markdown({
    runId: run.claim.runId,
    effectId: mainEffectId,
    proposalDigest: "b".repeat(64),
    outcome: "progress",
    nextReviewAt: NEXT_REVIEW_AT,
    evidence: [],
    completed: false,
    scheduled: true,
  });
  await fs.writeFile(setup.sourceFile, conflictingSource, "utf8");
  const before = await fs.readFile(setup.sourceFile);

  const result = await recoverExpiredAgentTaskRuns({
    vaultRoot: setup.vaultRoot,
    ledgerPath: setup.ledgerPath,
    now: new Date(T2),
  });
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].recoveredCompletely, true);
  assert.equal(result.recovered[0].sourceConsistent, false);
  assert.ok(result.recovered[0].issues.includes("SOURCE_RECEIPT_DIGEST_CONFLICT"));
  assert.deepEqual(await fs.readFile(setup.sourceFile), before);

  const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T2 });
  const scheduleEffectId = stableEffectId("task.selfScheduleReview", `${SOURCE_PATH}#${TASK_ID}`);
  assert.equal(state.runs[run.claim.runId].status, "settled");
  assert.equal(state.runs[run.claim.runId].effects[scheduleEffectId], undefined);
});

test("a settled failed attempt is reconciled when its authoritative source receipt is ahead of the ledger", async (t) => {
  const setup = await fixture(t);
  const run = await claimedRun(setup, T0, 60_000);
  const mainEffectId = await prepare(setup, run, "task.writeback");
  const link = await linkAttempt(setup, run.claim);
  const source = markdown({
    runId: run.claim.runId,
    effectId: mainEffectId,
    completed: true,
  });
  await fs.writeFile(setup.sourceFile, source, "utf8");
  await settleRuntimeRun(setup.ledgerPath, {
    runId: run.claim.runId,
    attemptNo: 1,
    owner: OWNER,
    processOutcome: { status: "failed", exitCode: 70 },
    writebackOutcome: { status: "failed", reasonCode: "record-effect-failed" },
    readbackOutcome: { status: "failed", reasonCode: "ledger-receipt-missing" },
    errors: [{ code: "record-effect-failed", stage: "process", retryable: true }],
  }, { clock: () => T1 });
  const before = await fs.readFile(setup.sourceFile);

  const result = await recoverExpiredAgentTaskRuns({
    vaultRoot: setup.vaultRoot,
    ledgerPath: setup.ledgerPath,
    now: new Date(T2),
  });
  assert.equal(result.expiredRuns, 0);
  assert.equal(result.recoverableRuns, 1);
  assert.equal(result.recovered[0].reconciledSettledRun, true);
  assert.equal(result.recovered[0].recoveredCompletely, true);
  assert.deepEqual(await fs.readFile(setup.sourceFile), before);

  const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T2 });
  const recoveredRun = state.runs[run.claim.runId];
  assert.equal(recoveredRun.attempts.length, 1);
  assert.deepEqual(recoveredRun.attempts[0].processOutcome, { status: "failed", exitCode: 70 });
  assert.equal(recoveredRun.attempts[0].writebackOutcome.status, "succeeded");
  assert.equal(recoveredRun.attempts[0].readbackOutcome.status, "succeeded");
  assert.ok(recoveredRun.attempts[0].errors.every((error) => error.retryable === false));
  assert.ok(recoveredRun.effects[mainEffectId].appliedAt && recoveredRun.effects[mainEffectId].verifiedAt);
  assert.equal(state.executionLinkEvents.filter((event) => event.eventType === "end" && event.linkEventId === link.eventId).length, 1);
});

test("receipt-declared self schedule remains incomplete when its required effect and dual source fields are absent", async (t) => {
  const setup = await fixture(t);
  const run = await claimedRun(setup);
  const mainEffectId = await prepare(setup, run, "task.writeback");
  const scheduleEffectId = stableEffectId("task.selfScheduleReview", `${SOURCE_PATH}#${TASK_ID}`);
  await fs.writeFile(setup.sourceFile, markdown({
    runId: run.claim.runId,
    effectId: mainEffectId,
    outcome: "progress",
    nextReviewAt: NEXT_REVIEW_AT,
    completed: false,
    scheduled: false,
  }), "utf8");

  const result = await recoverExpiredAgentTaskRuns({
    vaultRoot: setup.vaultRoot,
    ledgerPath: setup.ledgerPath,
    now: new Date(T2),
  });
  const recovered = result.recovered[0];
  assert.equal(recovered.recoveredCompletely, false);
  assert.equal(recovered.retryable, true);
  assert.deepEqual(recovered.recoveredEffectIds, [mainEffectId]);
  assert.ok(recovered.missingRequiredEffectIds.includes(scheduleEffectId));
  const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T2 });
  assert.equal(state.runs[run.claim.runId].attempts[0].writebackOutcome.status, "partial");
  assert.equal(state.runs[run.claim.runId].effects[scheduleEffectId], undefined);
});

test("dual source schedule state can reconstruct a stable schedule effect missing after the source rename crash", async (t) => {
  const setup = await fixture(t);
  const run = await claimedRun(setup);
  const mainEffectId = await prepare(setup, run, "task.writeback");
  const scheduleEffectId = stableEffectId("task.selfScheduleReview", `${SOURCE_PATH}#${TASK_ID}`);
  await fs.writeFile(setup.sourceFile, markdown({
    runId: run.claim.runId,
    effectId: mainEffectId,
    outcome: "progress",
    nextReviewAt: NEXT_REVIEW_AT,
    completed: false,
    scheduled: true,
  }), "utf8");

  const result = await recoverExpiredAgentTaskRuns({
    vaultRoot: setup.vaultRoot,
    ledgerPath: setup.ledgerPath,
    now: new Date(T2),
  });
  const recovered = result.recovered[0];
  assert.equal(recovered.recoveredCompletely, true);
  assert.deepEqual(recovered.recoveredEffectIds, [mainEffectId, scheduleEffectId].sort());
  assert.deepEqual(recovered.missingRequiredEffectIds, []);
  const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T2 });
  const schedule = state.runs[run.claim.runId].effects[scheduleEffectId];
  assert.equal(schedule.effectType, "task.selfScheduleReview");
  assert.ok(schedule.appliedAt && schedule.verifiedAt);
  assert.equal(schedule.receipts[0].attemptNo, 1);
  assert.equal(schedule.receipts[0].reconciliationEvidence.kind, "authoritative-readback");
});

test("no source effect settles explicitly, preserves missing start evidence, ends its link and permits same-key retry", async (t) => {
  const setup = await fixture(t);
  const run = await claimedRun(setup, T0, 1_000, false);
  const result = await recoverExpiredAgentTaskRuns({
    vaultRoot: setup.vaultRoot,
    ledgerPath: setup.ledgerPath,
    now: new Date(T2),
  });
  assert.equal(result.recovered[0].recoveredCompletely, false);
  assert.equal(result.recovered[0].retryable, true);

  let state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T2 });
  const oldAttempt = state.runs[run.claim.runId].attempts[0];
  assert.equal(oldAttempt.status, "settled");
  assert.equal(oldAttempt.startEvidence, null);
  assert.equal(oldAttempt.processOutcome.status, "not-started");
  assert.equal(oldAttempt.writebackOutcome.status, "failed");
  assert.equal(oldAttempt.errors[0].retryable, true);

  const retry = await claimRuntimeRun(setup.ledgerPath, {
    eligibilityKey: run.key,
    owner: "dispatcher-after-recovery",
    leaseDurationMs: 60_000,
  }, { clock: () => T3 });
  assert.equal(retry.runId, run.claim.runId);
  assert.equal(retry.attemptNo, 2);
  state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T3 });
  assert.equal(state.runs[run.claim.runId].attempts.length, 2);
});

test("forged receipt is rejected and cannot turn a prepared effect into applied or verified", async (t) => {
  const setup = await fixture(t);
  const run = await claimedRun(setup);
  const mainEffectId = await prepare(setup, run, "task.writeback");
  await linkAttempt(setup, run.claim);
  await fs.writeFile(setup.sourceFile, markdown({
    runId: run.claim.runId,
    effectId: mainEffectId,
    proposalDigest: "not-a-sha256",
    completed: true,
  }), "utf8");

  const result = await recoverExpiredAgentTaskRuns({
    vaultRoot: setup.vaultRoot,
    ledgerPath: setup.ledgerPath,
    now: new Date(T2),
  });
  assert.ok(result.recovered[0].issues.includes("SOURCE_RECEIPT_INVALID"));
  assert.equal(result.recovered[0].recoveredCompletely, false);
  const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T2 });
  const effect = state.runs[run.claim.runId].effects[mainEffectId];
  assert.equal(effect.appliedAt, null);
  assert.equal(effect.verifiedAt, null);
  assert.equal(state.executionLinkEvents.filter((event) => event.eventType === "writeback").length, 0);
});

test("recovery mirrors completed receipt evidence and scheduling invariants", async (t) => {
  for (const [name, sourceOptions] of [
    ["completed-without-evidence", { evidence: [] }],
    ["completed-with-next-review", { nextReviewAt: NEXT_REVIEW_AT, scheduled: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const setup = await fixture(subtest);
      const run = await claimedRun(setup);
      const mainEffectId = await prepare(setup, run, "task.writeback");
      await fs.writeFile(setup.sourceFile, markdown({
        runId: run.claim.runId,
        effectId: mainEffectId,
        completed: true,
        ...sourceOptions,
      }), "utf8");
      const result = await recoverExpiredAgentTaskRuns({
        vaultRoot: setup.vaultRoot,
        ledgerPath: setup.ledgerPath,
        now: new Date(T2),
      });
      assert.ok(result.recovered[0].issues.includes("SOURCE_RECEIPT_INVALID"));
      const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T2 });
      assert.equal(state.runs[run.claim.runId].effects[mainEffectId].appliedAt, null);
      assert.equal(state.runs[run.claim.runId].effects[mainEffectId].verifiedAt, null);
    });
  }
});

test("strict expired-run API rejects a live lease even with a well-shaped authoritative receipt", async (t) => {
  const setup = await fixture(t);
  const run = await claimedRun(setup, T0, 60_000);
  const mainEffectId = await prepare(setup, run, "task.writeback");
  await assert.rejects(
    recoverExpiredRuntimeRun(setup.ledgerPath, {
      runId: run.claim.runId,
      attemptNo: 1,
      recoveredEffects: [{
        effectType: "task.writeback",
        target: `${SOURCE_PATH}#${TASK_ID}`,
        effectId: mainEffectId,
        sourceAttemptNo: 1,
        reconciliationEvidence: {
          kind: "authoritative-readback",
          sourceRevision: `sha256:${"c".repeat(64)}`,
          digest: "c".repeat(64),
        },
      }],
    }, { clock: () => T1 }),
    (error) => error.code === "LEASE_ACTIVE",
  );
});

test("verification recovery binds an applied effect to its original successful receipt attempt", async (t) => {
  const setup = await fixture(t);
  const first = await claimedRun(setup, T0, 60_000);
  const mainEffectId = await prepare(setup, first, "task.writeback");
  await recordRuntimeEffect(setup.ledgerPath, {
    ...context(first.key, first.claim),
    effectType: "task.writeback",
    target: `${SOURCE_PATH}#${TASK_ID}`,
    effectId: mainEffectId,
    intentDigest: "a".repeat(64),
    writebackOutcome: { status: "succeeded" },
    readbackOutcome: { status: "failed", reasonCode: "readback-crashed" },
  }, { clock: () => T0 });
  await settleRuntimeRun(setup.ledgerPath, {
    runId: first.claim.runId,
    attemptNo: 1,
    owner: OWNER,
    processOutcome: { status: "failed", exitCode: 70 },
    writebackOutcome: { status: "succeeded", effectIds: [mainEffectId] },
    readbackOutcome: { status: "failed", effectIds: [], reasonCode: "readback-crashed" },
    errors: [{ code: "readback-crashed", stage: "readback", retryable: true }],
  }, { clock: () => T1 });
  const secondOwner = "dispatcher-recovery-two";
  const second = await claimRuntimeRun(setup.ledgerPath, {
    eligibilityKey: first.key,
    owner: secondOwner,
    leaseDurationMs: 1_000,
  }, { clock: () => T1 });
  await ackStarted(setup.ledgerPath, {
    runId: second.runId,
    attemptNo: second.attemptNo,
    owner: secondOwner,
    evidence: {
      kind: "platform-execution",
      source: "codex-app",
      platformId: "codex",
      executionId: "exec-recovery-2",
      observedAt: T1,
    },
  }, { clock: () => T1 });
  const evidence = {
    kind: "authoritative-readback",
    sourceRevision: `sha256:${"d".repeat(64)}`,
    digest: "d".repeat(64),
  };

  await assert.rejects(
    recoverExpiredRuntimeRun(setup.ledgerPath, {
      runId: second.runId,
      attemptNo: 2,
      recoveredEffects: [{
        effectType: "task.writeback",
        target: `${SOURCE_PATH}#${TASK_ID}`,
        effectId: mainEffectId,
        intentDigest: "a".repeat(64),
        sourceAttemptNo: 2,
        reconciliationEvidence: evidence,
      }],
    }, { clock: () => T3 }),
    (error) => error.code === "INVALID_RECOVERY_EVIDENCE",
  );

  const recovered = await recoverExpiredRuntimeRun(setup.ledgerPath, {
    runId: second.runId,
    attemptNo: 2,
    recoveredEffects: [{
      effectType: "task.writeback",
      target: `${SOURCE_PATH}#${TASK_ID}`,
      effectId: mainEffectId,
      intentDigest: "a".repeat(64),
      sourceAttemptNo: 1,
      reconciliationEvidence: evidence,
    }],
    requiredEffects: [{
      effectType: "task.writeback",
      target: `${SOURCE_PATH}#${TASK_ID}`,
      effectId: mainEffectId,
    }],
  }, { clock: () => T3 });
  assert.equal(recovered.recoveredCompletely, true);
  const state = await readRuntimeLedger(setup.ledgerPath, { clock: () => T3 });
  const effect = state.runs[first.claim.runId].effects[mainEffectId];
  assert.equal(effect.receipts.at(-1).attemptNo, 1);
  assert.equal(effect.verifiedAt, T3);
});
