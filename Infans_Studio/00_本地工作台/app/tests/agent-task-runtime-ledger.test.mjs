import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RUNTIME_LEDGER_SCHEMA_VERSION,
  RuntimeLedgerError,
  ackStarted,
  appendExecutionLinkEvent,
  claimRuntimeRun,
  claimRuntimeState,
  createRuntimeLedgerState,
  eligibilityKeyHash,
  readRuntimeLedger,
  reconcileRuntimeEffect,
  recordRuntimeEffect,
  releaseRuntimeEffectPreparation,
  renewRuntimeLease,
  runIdempotentRuntimeEffect,
  prepareRuntimeEffect,
  settleRuntimeRun,
  stableEffectId,
  stableRunId,
} from "../scripts/agent-task-runtime-ledger.mjs";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:00:01.000Z";
const T2 = "2026-09-04T00:00:02.000Z";
const T3 = "2026-09-04T00:00:03.000Z";
const T4 = "2026-09-04T00:00:04.000Z";
const INTENT_A = "a".repeat(64);
const INTENT_B = "b".repeat(64);
const INTENT_C = "c".repeat(64);

function eligibility(overrides = {}) {
  return {
    taskId: "agent-contract-runtime-ledger-20260904",
    executorRoleId: "codex-ai-acceptance",
    eligibilityRevision: "intent-2",
    triggerId: "trigger-manual-1",
    triggerCursor: "event-20260904-1",
    ...overrides,
  };
}

async function fixture(t, name = "ledger.json") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "infans-runtime-ledger-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

function platformEvidence(executionId, observedAt = T1) {
  return {
    kind: "platform-execution",
    source: "codex-app",
    platformId: "codex",
    executionId,
    observedAt,
  };
}

function successfulEffectOutcomes(readbackStatus = "succeeded") {
  return {
    writebackOutcome: { status: "succeeded" },
    readbackOutcome: { status: readbackStatus },
  };
}

function runContext(key, claim, owner) {
  return {
    runId: claim.runId,
    attemptNo: claim.attemptNo,
    owner,
    primaryTaskId: key.taskId,
    executorRoleId: key.executorRoleId,
    eligibilityKeyHash: eligibilityKeyHash(key),
  };
}

test("schema v2 pure claims keep one deterministic logical run per full eligibility key", () => {
  const initial = createRuntimeLedgerState(T0);
  const key = eligibility();
  const first = claimRuntimeState(initial, {
    eligibilityKey: key,
    owner: "worker-a",
    leaseDurationMs: 10_000,
    now: T0,
  });

  assert.equal(initial.revision, 0, "pure operation must not mutate its input");
  assert.equal(first.state.schemaVersion, RUNTIME_LEDGER_SCHEMA_VERSION);
  assert.equal(first.result.runId, stableRunId(key));
  assert.equal(first.state.eligibilityIndex[eligibilityKeyHash(key)], first.result.runId);
  assert.equal(first.state.runs[first.result.runId].attempts.length, 1);
  assert.deepEqual(first.state.runs[first.result.runId].lease, {
    owner: "worker-a",
    attemptNo: 1,
    acquiredAt: T0,
    expiresAt: "2026-09-04T00:00:10.000Z",
  });
});

test("file lock makes concurrent claims produce one run and one live attempt", async (t) => {
  const file = await fixture(t);
  const claims = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => claimRuntimeRun(file, {
    eligibilityKey: eligibility(),
    owner: `worker-${index}`,
    leaseDurationMs: 60_000,
    now: T0,
  }, { clock: () => T0, lockRetryMs: 1 })));

  const fulfilled = claims.filter((item) => item.status === "fulfilled");
  const rejected = claims.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 11);
  assert.ok(rejected.every((item) => item.reason instanceof RuntimeLedgerError && item.reason.code === "LEASE_ACTIVE"));

  const state = await readRuntimeLedger(file, { clock: () => T0 });
  assert.equal(Object.keys(state.runs).length, 1);
  const [run] = Object.values(state.runs);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.currentAttemptNo, 1);
  assert.equal(run.status, "claimed");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(`${file}.bak`)).mode & 0o777, 0o600);
});

test("different trigger runs for the same task cannot hold live leases concurrently", async (t) => {
  const file = await fixture(t);
  const firstKey = eligibility({ triggerId: "trigger-a", triggerCursor: "cursor-a" });
  const secondKey = eligibility({ triggerId: "trigger-b", triggerCursor: "cursor-b" });
  const first = await claimRuntimeRun(file, {
    eligibilityKey: firstKey,
    owner: "worker-a",
    leaseDurationMs: 1_500,
  }, { clock: () => T0 });

  await assert.rejects(
    claimRuntimeRun(file, {
      eligibilityKey: secondKey,
      owner: "worker-b",
      leaseDurationMs: 60_000,
    }, { clock: () => T1 }),
    (error) => error.code === "TASK_LEASE_ACTIVE" && error.details.runId === first.runId,
  );

  const second = await claimRuntimeRun(file, {
    eligibilityKey: secondKey,
    owner: "worker-b",
    leaseDurationMs: 60_000,
  }, { clock: () => T2 });
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.attemptNo, 1);
  assert.equal(second.claimed, true);
  const state = await readRuntimeLedger(file, { clock: () => T2 });
  assert.equal(Object.values(state.runs).filter((run) => run.lease && Date.parse(run.lease.expiresAt) > Date.parse(T2)).length, 1);
});

test("an active lease rejects takeover while an expired lease is safely recovered with the same runId", async (t) => {
  const file = await fixture(t);
  const first = await claimRuntimeRun(file, {
    eligibilityKey: eligibility(),
    owner: "worker-a",
    leaseDurationMs: 1_500,
    now: T0,
  }, { clock: () => T0 });
  await ackStarted(file, {
    runId: first.runId,
    attemptNo: first.attemptNo,
    owner: "worker-a",
    evidence: platformEvidence("exec-a", T1),
    now: T1,
  }, { clock: () => T1 });

  await assert.rejects(
    claimRuntimeRun(file, {
      eligibilityKey: eligibility(),
      owner: "worker-b",
      leaseDurationMs: 10_000,
      now: "2026-09-04T00:00:01.400Z",
    }, { clock: () => "2026-09-04T00:00:01.400Z" }),
    (error) => error.code === "LEASE_ACTIVE",
  );

  const recovered = await claimRuntimeRun(file, {
    eligibilityKey: eligibility(),
    owner: "worker-b",
    leaseDurationMs: 10_000,
    now: T2,
  }, { clock: () => T2 });
  assert.equal(recovered.runId, first.runId);
  assert.equal(recovered.attemptNo, 2);
  assert.equal(recovered.recovered, true);

  const state = await readRuntimeLedger(file, { clock: () => T2 });
  const run = state.runs[first.runId];
  assert.equal(run.attempts[0].status, "lease-expired");
  assert.deepEqual(run.attempts[0].processOutcome, { status: "unknown", reasonCode: "lease-expired" });
  assert.equal(run.attempts[1].owner, "worker-b");
  assert.equal(run.lease.owner, "worker-b");

  await assert.rejects(
    ackStarted(file, {
      runId: first.runId,
      attemptNo: 1,
      owner: "worker-a",
      evidence: platformEvidence("exec-too-late", T3),
      now: T3,
    }, { clock: () => T3 }),
    (error) => error.code === "LEASE_MISMATCH",
  );
});

test("primary and backup copies heal either corrupt side and fail closed when both are corrupt", async (t) => {
  const file = await fixture(t);
  const claim = await claimRuntimeRun(file, {
    eligibilityKey: eligibility(),
    owner: "worker-a",
    leaseDurationMs: 60_000,
    now: T0,
  }, { clock: () => T0 });

  await fs.writeFile(`${file}.bak`, "{broken backup", "utf8");
  let state = await readRuntimeLedger(file, { clock: () => T1 });
  assert.ok(state.runs[claim.runId]);
  assert.equal(JSON.parse(await fs.readFile(`${file}.bak`, "utf8")).schemaVersion, 2);

  await fs.writeFile(file, "{broken primary", "utf8");
  state = await readRuntimeLedger(file, { clock: () => T2 });
  assert.ok(state.runs[claim.runId]);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).revision, state.revision);

  await fs.writeFile(file, "not-json", "utf8");
  await fs.writeFile(`${file}.bak`, "also-not-json", "utf8");
  await assert.rejects(
    readRuntimeLedger(file, { clock: () => T3 }),
    (error) => error.code === "LEDGER_UNRECOVERABLE",
  );
});

test("ackStarted rejects queue/process/fallback claims and stores only independent evidence fields", async (t) => {
  const file = await fixture(t);
  const claim = await claimRuntimeRun(file, {
    eligibilityKey: eligibility(),
    owner: "worker-a",
    leaseDurationMs: 60_000,
    now: T0,
  }, { clock: () => T0 });

  for (const evidence of [
    { kind: "queue-accepted", source: "codex-app", receiptId: "queue-1" },
    { kind: "platform-execution", source: "coordinator", platformId: "local", executionId: "pid-1" },
    { kind: "structured-event", source: "codex-app", eventType: "queue.accepted", eventId: "event-1" },
  ]) {
    await assert.rejects(
      ackStarted(file, {
        runId: claim.runId,
        attemptNo: 1,
        owner: "worker-a",
        evidence,
        now: T1,
      }, { clock: () => T1 }),
      (error) => error.code === "UNTRUSTED_START_EVIDENCE",
    );
  }

  await ackStarted(file, {
    runId: claim.runId,
    attemptNo: 1,
    owner: "worker-a",
    evidence: {
      ...platformEvidence("exec-real", T1),
      prompt: "SECRET_PROMPT",
      answer: "SECRET_ANSWER",
      stderr: "SECRET_STDERR",
    },
    now: T1,
  }, { clock: () => T1 });
  const serialized = await fs.readFile(file, "utf8");
  assert.doesNotMatch(serialized, /SECRET_(?:PROMPT|ANSWER|STDERR)/u);
  const state = JSON.parse(serialized);
  assert.deepEqual(state.runs[claim.runId].attempts[0].startEvidence, platformEvidence("exec-real", T1));
});

test("multiple effects remain independently idempotent across attempts and settlements keep three outcomes separate", async (t) => {
  const file = await fixture(t);
  const key = eligibility();
  const first = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-a",
    leaseDurationMs: 60_000,
    now: T0,
  }, { clock: () => T0 });
  await ackStarted(file, {
    runId: first.runId,
    attemptNo: 1,
    owner: "worker-a",
    evidence: platformEvidence("exec-1", T1),
    now: T1,
  }, { clock: () => T1 });

  const effectA = stableEffectId("task.writeback", "project/task-a.md#task-a");
  const effectB = stableEffectId("task.writeback", "project/task-b.md#task-b");
  const effectC = stableEffectId("task.selfScheduleReview", "project/task-a.md#task-a");
  const firstA = await runIdempotentRuntimeEffect(file, {
    ...runContext(key, first, "worker-a"),
    effectType: "task.writeback",
    target: "project/task-a.md#task-a",
    effectId: effectA,
    intentDigest: INTENT_A,
    now: T2,
  }, async () => successfulEffectOutcomes(), { clock: () => T2 });
  const firstB = await runIdempotentRuntimeEffect(file, {
    ...runContext(key, first, "worker-a"),
    effectType: "task.writeback",
    target: "project/task-b.md#task-b",
    effectId: effectB,
    intentDigest: INTENT_B,
    now: T2,
  }, async () => successfulEffectOutcomes("failed"), { clock: () => T2 });
  assert.equal(firstA.effectId, effectA);
  assert.equal(firstB.effectId, effectB);

  const failed = await settleRuntimeRun(file, {
    runId: first.runId,
    attemptNo: 1,
    owner: "worker-a",
    processOutcome: { status: "failed", exitCode: 17, stderr: "DO_NOT_STORE_STDERR" },
    writebackOutcome: { status: "succeeded", effectIds: [effectA, effectB], answer: "DO_NOT_STORE_ANSWER" },
    readbackOutcome: { status: "partial", effectIds: [effectA], prompt: "DO_NOT_STORE_PROMPT" },
    errors: [{ code: "adapter-exit", stage: "process", retryable: true, message: "PRIVATE_ERROR_BODY", stderr: "PRIVATE_STDERR" }],
    now: T3,
  }, { clock: () => T3 });
  assert.equal(failed.trustedCompletion, false);

  const retry = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-b",
    leaseDurationMs: 60_000,
    retrySettled: true,
    now: T4,
  }, { clock: () => T4 });
  assert.equal(retry.runId, first.runId);
  assert.equal(retry.attemptNo, 2);
  await ackStarted(file, {
    runId: retry.runId,
    attemptNo: 2,
    owner: "worker-b",
    evidence: platformEvidence("exec-2", T4),
    now: T4,
  }, { clock: () => T4 });

  let duplicateApplyCalls = 0;
  const duplicateA = await runIdempotentRuntimeEffect(file, {
    ...runContext(key, retry, "worker-b"),
    effectType: "task.writeback",
    target: "project/task-a.md#task-a",
    intentDigest: INTENT_A,
    now: T4,
  }, async () => {
    duplicateApplyCalls += 1;
    return successfulEffectOutcomes();
  }, { clock: () => T4 });
  const readbackB = await recordRuntimeEffect(file, {
    ...runContext(key, retry, "worker-b"),
    effectType: "task.writeback",
    target: "project/task-b.md#task-b",
    intentDigest: INTENT_B,
    ...successfulEffectOutcomes(),
    now: T4,
  }, { clock: () => T4 });
  await runIdempotentRuntimeEffect(file, {
    ...runContext(key, retry, "worker-b"),
    effectType: "task.selfScheduleReview",
    target: "project/task-a.md#task-a",
    intentDigest: INTENT_C,
    now: T4,
  }, async () => successfulEffectOutcomes(), { clock: () => T4 });
  assert.equal(duplicateA.deduplicated, true);
  assert.equal(duplicateA.duplicate, true);
  assert.equal(duplicateApplyCalls, 0);
  assert.equal(readbackB.deduplicated, true);
  assert.equal(readbackB.readbackUpdated, true);

  const link = await appendExecutionLinkEvent(file, {
    eventType: "link",
    platformId: "codex",
    executionId: "exec-2",
    taskId: key.taskId,
    relation: "implementation",
    runId: retry.runId,
    attemptNo: 2,
  }, { clock: () => T4 });
  const duplicateLink = await appendExecutionLinkEvent(file, {
    eventType: "link",
    platformId: "codex",
    executionId: "exec-2",
    taskId: key.taskId,
    relation: "implementation",
    runId: retry.runId,
    attemptNo: 2,
  }, { clock: () => T4 });
  const writeback = await appendExecutionLinkEvent(file, {
    eventType: "writeback",
    platformId: "codex",
    executionId: "exec-1",
    taskId: key.taskId,
    runId: retry.runId,
    attemptNo: 1,
    effectId: effectA,
  }, { clock: () => T4 });
  const duplicateWriteback = await appendExecutionLinkEvent(file, {
    eventType: "writeback",
    platformId: "codex",
    executionId: "exec-1",
    taskId: key.taskId,
    runId: retry.runId,
    attemptNo: 1,
    effectId: effectA,
  }, { clock: () => T4 });
  const end = await appendExecutionLinkEvent(file, {
    eventType: "end",
    linkEventId: link.eventId,
    reasonCode: "attempt-settled",
  }, { clock: () => T4 });
  const duplicateEnd = await appendExecutionLinkEvent(file, {
    eventType: "end",
    linkEventId: link.eventId,
    reasonCode: "attempt-settled",
  }, { clock: () => T4 });
  assert.equal(link.appended, true);
  assert.equal(duplicateLink.deduplicated, true);
  assert.equal(writeback.appended, false);
  assert.equal(writeback.deduplicated, true);
  assert.equal(duplicateWriteback.deduplicated, true);
  assert.equal(end.appended, true);
  assert.equal(duplicateEnd.deduplicated, true);

  const settled = await settleRuntimeRun(file, {
    runId: retry.runId,
    attemptNo: 2,
    owner: "worker-b",
    processOutcome: { status: "succeeded", exitCode: 0 },
    writebackOutcome: { status: "succeeded", effectIds: [effectA, effectB, effectC] },
    readbackOutcome: { status: "succeeded", effectIds: [effectA, effectB, effectC] },
    errors: [],
    now: T4,
  }, { clock: () => T4 });
  assert.equal(settled.trustedCompletion, true);

  const state = await readRuntimeLedger(file, { clock: () => T4 });
  const run = state.runs[first.runId];
  assert.equal(run.attempts.length, 2);
  assert.equal(Object.keys(run.effects).length, 3);
  assert.equal(run.effects[effectA].receipts.length, 1, "successful writeback must not repeat on retry");
  assert.equal(run.effects[effectB].receipts.length, 2, "readback may be completed without reapplying the write");
  assert.equal(run.effects[effectC].receipts.length, 1);
  assert.equal(state.executionLinkEvents.length, 4);
  assert.deepEqual(run.attempts[1].processOutcome, { status: "succeeded", exitCode: 0 });
  assert.deepEqual(run.attempts[1].writebackOutcome, { status: "succeeded", effectIds: [effectA, effectB, effectC].sort() });
  assert.deepEqual(run.attempts[1].readbackOutcome, { status: "succeeded", effectIds: [effectA, effectB, effectC].sort() });

  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /DO_NOT_STORE|PRIVATE_/u);
  assert.deepEqual(run.attempts[0].errors, [{
    code: "adapter-exit",
    stage: "process",
    retryable: true,
    at: T3,
  }]);
});

test("a zero exit cannot be settled as a started or completed run without trusted start evidence", async (t) => {
  const file = await fixture(t);
  const claim = await claimRuntimeRun(file, {
    eligibilityKey: eligibility({ triggerCursor: "manual-fake-start" }),
    owner: "worker-a",
    leaseDurationMs: 60_000,
    now: T0,
  }, { clock: () => T0 });

  await assert.rejects(
    settleRuntimeRun(file, {
      runId: claim.runId,
      attemptNo: 1,
      owner: "worker-a",
      processOutcome: { status: "succeeded", exitCode: 0 },
      writebackOutcome: { status: "not-required" },
      readbackOutcome: { status: "not-required" },
      now: T1,
    }, { clock: () => T1 }),
    (error) => error.code === "RUN_NOT_STARTED",
  );

  const result = await settleRuntimeRun(file, {
    runId: claim.runId,
    attemptNo: 1,
    owner: "worker-a",
    processOutcome: { status: "not-started", reasonCode: "spawn-failed" },
    writebackOutcome: { status: "not-required" },
    readbackOutcome: { status: "not-required" },
    errors: [{ code: "spawn-failed", stage: "start", retryable: true }],
    now: T1,
  }, { clock: () => T1 });
  assert.equal(result.trustedCompletion, false);

  const retry = await claimRuntimeRun(file, {
    eligibilityKey: eligibility({ triggerCursor: "manual-fake-start" }),
    owner: "worker-b",
    leaseDurationMs: 60_000,
  }, { clock: () => T2 });
  await ackStarted(file, {
    runId: retry.runId,
    attemptNo: 2,
    owner: "worker-b",
    evidence: platformEvidence("exec-no-writeback", T2),
  }, { clock: () => T2 });
  const noWriteback = await settleRuntimeRun(file, {
    runId: retry.runId,
    attemptNo: 2,
    owner: "worker-b",
    processOutcome: { status: "succeeded", exitCode: 0 },
    writebackOutcome: { status: "not-required" },
    readbackOutcome: { status: "not-required" },
  }, { clock: () => T3 });
  assert.equal(noWriteback.trustedCompletion, false, "zero exit without a trusted writeback is not completion");
  assert.equal((await claimRuntimeRun(file, {
    eligibilityKey: eligibility({ triggerCursor: "manual-fake-start" }),
    owner: "worker-c",
    leaseDurationMs: 60_000,
  }, { clock: () => T4 })).attemptNo, 3, "a no-writeback run stays retryable under the same runId");
});

test("canonical eligibility JSON is accepted and a trusted successful run cannot be retried by a boolean override", async (t) => {
  const file = await fixture(t);
  const key = eligibility({ triggerCursor: "success-once" });
  const canonicalKey = JSON.stringify({
    eligibilityRevision: key.eligibilityRevision,
    executorRoleId: key.executorRoleId,
    taskId: key.taskId,
    triggerCursor: key.triggerCursor,
    triggerId: key.triggerId,
  });
  const first = await claimRuntimeRun(file, {
    eligibilityKey: canonicalKey,
    owner: "worker-a",
    leaseDurationMs: 60_000,
  }, { clock: () => T0 });
  assert.equal(first.runId, stableRunId(key));
  await ackStarted(file, {
    runId: first.runId,
    attemptNo: 1,
    owner: "worker-a",
    evidence: platformEvidence("exec-success", T1),
  }, { clock: () => T1 });
  const effectId = stableEffectId("task.writeback", "project/task.md#task-success");
  await runIdempotentRuntimeEffect(file, {
    ...runContext(key, first, "worker-a"),
    effectType: "task.writeback",
    target: "project/task.md#task-success",
    intentDigest: INTENT_A,
  }, async () => successfulEffectOutcomes(), { clock: () => T2 });
  const settled = await settleRuntimeRun(file, {
    runId: first.runId,
    attemptNo: 1,
    owner: "worker-a",
    processOutcome: { status: "succeeded", exitCode: 0 },
    writebackOutcome: { status: "succeeded", effectIds: [effectId] },
    readbackOutcome: { status: "succeeded", effectIds: [effectId] },
  }, { clock: () => T3 });
  assert.equal(settled.trustedCompletion, true);

  const duplicateClaim = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-b",
    leaseDurationMs: 60_000,
    retrySettled: true,
  }, { clock: () => T4 });
  assert.deepEqual({ claimed: duplicateClaim.claimed, reason: duplicateClaim.reason, attemptNo: duplicateClaim.attemptNo }, {
    claimed: false,
    reason: "already-settled",
    attemptNo: 1,
  });
  assert.equal((await readRuntimeLedger(file, { clock: () => T4 })).runs[first.runId].attempts.length, 1);
});

test("same-revision divergent primary and backup copies fail closed instead of overwriting either history", async (t) => {
  const file = await fixture(t);
  const claim = await claimRuntimeRun(file, {
    eligibilityKey: eligibility({ triggerCursor: "split-brain" }),
    owner: "worker-a",
    leaseDurationMs: 60_000,
  }, { clock: () => T0 });
  const divergent = JSON.parse(await fs.readFile(`${file}.bak`, "utf8"));
  divergent.runs[claim.runId].attempts[0].errors.push({
    code: "diagnostic-marker",
    stage: "claim",
    retryable: false,
    at: T0,
  });
  await fs.writeFile(`${file}.bak`, `${JSON.stringify(divergent, null, 2)}\n`, "utf8");
  await assert.rejects(
    readRuntimeLedger(file, { clock: () => T1 }),
    (error) => error.code === "LEDGER_SPLIT_BRAIN",
  );
});

test("file API uses its injected clock and lease renewal never shortens an existing lease", async (t) => {
  const file = await fixture(t);
  const claim = await claimRuntimeRun(file, {
    eligibilityKey: eligibility({ triggerCursor: "trusted-clock" }),
    owner: "worker-a",
    leaseDurationMs: 10_000,
    now: "2099-01-01T00:00:00.000Z",
  }, { clock: () => T0 });
  assert.equal(claim.lease.expiresAt, "2026-09-04T00:00:10.000Z");
  const renewed = await renewRuntimeLease(file, {
    runId: claim.runId,
    attemptNo: 1,
    owner: "worker-a",
    leaseDurationMs: 1_000,
    now: "2099-01-01T00:00:00.000Z",
  }, { clock: () => T1 });
  assert.equal(renewed.expiresAt, "2026-09-04T00:00:10.000Z");
  await assert.rejects(
    renewRuntimeLease(file, {
      runId: claim.runId,
      attemptNo: 1,
      owner: "worker-a",
      leaseDurationMs: 20_000,
    }, { clock: () => T0 }),
    (error) => error.code === "CLOCK_ROLLBACK",
  );
});

test("prepared crash gaps require authoritative reconciliation and never reapply the effect", async (t) => {
  const file = await fixture(t);
  const key = eligibility({ triggerCursor: "prepared-crash" });
  const first = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-a",
    leaseDurationMs: 1_500,
  }, { clock: () => T0 });
  await ackStarted(file, {
    runId: first.runId,
    attemptNo: 1,
    owner: "worker-a",
    evidence: platformEvidence("exec-before-crash", T1),
  }, { clock: () => T1 });
  const target = "project/task.md#task-reconcile";
  const effectId = stableEffectId("task.writeback", target);
  const prepared = await prepareRuntimeEffect(file, {
    ...runContext(key, first, "worker-a"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
  }, { clock: () => T1 });
  assert.equal(prepared.shouldApply, true);

  const recovered = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-b",
    leaseDurationMs: 60_000,
  }, { clock: () => T2 });
  await ackStarted(file, {
    runId: recovered.runId,
    attemptNo: 2,
    owner: "worker-b",
    evidence: platformEvidence("exec-recovery", T2),
  }, { clock: () => T2 });
  const blocked = await prepareRuntimeEffect(file, {
    ...runContext(key, recovered, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
  }, { clock: () => T2 });
  assert.equal(blocked.reconciliationRequired, true);

  const reconciled = await reconcileRuntimeEffect(file, {
    ...runContext(key, recovered, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
    writebackOutcome: { status: "succeeded" },
    readbackOutcome: { status: "succeeded" },
    reconciliationEvidence: {
      kind: "authoritative-readback",
      sourceRevision: "source-revision-9",
      digest: "a".repeat(64),
    },
  }, { clock: () => T3 });
  assert.equal(reconciled.originalAttemptNo, 1);
  assert.equal(reconciled.reconciledByAttemptNo, 2);

  let applyCalls = 0;
  const duplicate = await runIdempotentRuntimeEffect(file, {
    ...runContext(key, recovered, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
  }, async () => {
    applyCalls += 1;
    return successfulEffectOutcomes();
  }, { clock: () => T3 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(applyCalls, 0);

  await assert.rejects(
    appendExecutionLinkEvent(file, {
      eventType: "link",
      platformId: "codex",
      executionId: "forged-execution",
      taskId: key.taskId,
      relation: "implementation",
      runId: recovered.runId,
      attemptNo: 2,
    }, { clock: () => T3 }),
    (error) => error.code === "EXECUTION_MISMATCH",
  );

  const state = await readRuntimeLedger(file, { clock: () => T3 });
  const effect = state.runs[first.runId].effects[effectId];
  assert.ok(effect.appliedAt && effect.verifiedAt);
  assert.equal(effect.receipts[0].attemptNo, 1);
  assert.equal(effect.receipts[0].reconciledByAttemptNo, 2);
  assert.equal(state.executionLinkEvents.filter((event) => event.eventType === "writeback").length, 1);
  assert.equal(state.executionLinkEvents[0].executionId, "exec-before-crash");
});

test("authoritative negative readback releases only an expired older preparation before one safe retry", async (t) => {
  const file = await fixture(t);
  const key = eligibility({ triggerCursor: "prepared-negative-readback" });
  const first = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-a",
    leaseDurationMs: 1_500,
  }, { clock: () => T0 });
  await ackStarted(file, {
    runId: first.runId,
    attemptNo: first.attemptNo,
    owner: "worker-a",
    evidence: platformEvidence("exec-negative-before-crash", T1),
  }, { clock: () => T1 });
  const target = "project/task.md#task-negative-reconcile";
  const effectId = stableEffectId("task.writeback", target);
  await prepareRuntimeEffect(file, {
    ...runContext(key, first, "worker-a"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
  }, { clock: () => T1 });

  const negativeEvidence = {
    kind: "authoritative-negative-readback",
    sourceRevision: "source-revision-absent-10",
    digest: "b".repeat(64),
  };
  await assert.rejects(
    releaseRuntimeEffectPreparation(file, {
      ...runContext(key, first, "worker-a"),
      effectType: "task.writeback",
      target,
      intentDigest: INTENT_A,
      reconciliationEvidence: negativeEvidence,
    }, { clock: () => T1 }),
    (error) => error.code === "RECOVERY_ATTEMPT_REQUIRED",
  );

  const recovered = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-b",
    leaseDurationMs: 60_000,
  }, { clock: () => T2 });
  await ackStarted(file, {
    runId: recovered.runId,
    attemptNo: recovered.attemptNo,
    owner: "worker-b",
    evidence: platformEvidence("exec-negative-recovery", T2),
  }, { clock: () => T2 });

  await assert.rejects(
    releaseRuntimeEffectPreparation(file, {
      ...runContext(key, first, "worker-a"),
      effectType: "task.writeback",
      target,
      intentDigest: INTENT_A,
      reconciliationEvidence: negativeEvidence,
    }, { clock: () => T2 }),
    (error) => error.code === "LEASE_MISMATCH",
  );
  await assert.rejects(
    releaseRuntimeEffectPreparation(file, {
      ...runContext(key, recovered, "worker-b"),
      effectType: "task.writeback",
      target,
      intentDigest: INTENT_A,
      reconciliationEvidence: { ...negativeEvidence, digest: "not-a-sha256" },
    }, { clock: () => T2 }),
    (error) => error.code === "INVALID_RECONCILIATION_EVIDENCE",
  );
  await assert.rejects(
    reconcileRuntimeEffect(file, {
      ...runContext(key, recovered, "worker-b"),
      effectType: "task.writeback",
      target,
      intentDigest: INTENT_A,
      writebackOutcome: { status: "succeeded" },
      readbackOutcome: { status: "succeeded" },
      reconciliationEvidence: negativeEvidence,
    }, { clock: () => T2 }),
    (error) => error.code === "INVALID_RECONCILIATION_EVIDENCE",
  );

  const released = await releaseRuntimeEffectPreparation(file, {
    ...runContext(key, recovered, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
    reconciliationEvidence: negativeEvidence,
  }, { clock: () => T3 });
  assert.deepEqual({
    released: released.released,
    effectId: released.effectId,
    originalAttemptNo: released.originalAttemptNo,
    releasedByAttemptNo: released.releasedByAttemptNo,
  }, {
    released: true,
    effectId,
    originalAttemptNo: 1,
    releasedByAttemptNo: 2,
  });
  assert.equal(released.writebackEventId, undefined);

  let state = await readRuntimeLedger(file, { clock: () => T3 });
  let effect = state.runs[first.runId].effects[effectId];
  assert.equal(effect.preparedAt, null);
  assert.equal(effect.preparedAttemptNo, null);
  assert.equal(effect.appliedAt, null);
  assert.equal(effect.verifiedAt, null);
  assert.equal(effect.receipts.length, 1);
  assert.equal(effect.receipts[0].reconciliationEvidence.kind, "authoritative-negative-readback");
  assert.equal(effect.receipts[0].writebackOutcome.status, "failed");
  assert.equal(state.executionLinkEvents.length, 0);

  let applyCalls = 0;
  const applied = await runIdempotentRuntimeEffect(file, {
    ...runContext(key, recovered, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
  }, async () => {
    applyCalls += 1;
    return successfulEffectOutcomes();
  }, { clock: () => T3 });
  const duplicate = await runIdempotentRuntimeEffect(file, {
    ...runContext(key, recovered, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
  }, async () => {
    applyCalls += 1;
    return successfulEffectOutcomes();
  }, { clock: () => T4 });
  assert.equal(applied.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(applyCalls, 1);

  state = await readRuntimeLedger(file, { clock: () => T4 });
  effect = state.runs[first.runId].effects[effectId];
  assert.ok(effect.appliedAt && effect.verifiedAt);
  assert.equal(effect.receipts.length, 2);
  assert.equal(state.executionLinkEvents.filter((event) => event.eventType === "writeback").length, 1);
  assert.equal(state.executionLinkEvents[0].attemptNo, 2);
  assert.equal(state.executionLinkEvents[0].executionId, "exec-negative-recovery");
});

test("all task effect APIs require the pre-bound intent digest", async (t) => {
  const file = await fixture(t);
  const key = eligibility({ triggerCursor: "intent-required" });
  const first = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-a",
    leaseDurationMs: 1_500,
  }, { clock: () => T0 });
  await ackStarted(file, {
    runId: first.runId,
    attemptNo: first.attemptNo,
    owner: "worker-a",
    evidence: platformEvidence("exec-intent-a", T1),
  }, { clock: () => T1 });
  const target = `project/task.md#${key.taskId}`;
  const base = {
    ...runContext(key, first, "worker-a"),
    effectType: "task.writeback",
    target,
  };
  await assert.rejects(
    prepareRuntimeEffect(file, base, { clock: () => T1 }),
    (error) => error.code === "EFFECT_INTENT_REQUIRED",
  );
  await prepareRuntimeEffect(file, { ...base, intentDigest: INTENT_A }, { clock: () => T1 });
  await assert.rejects(
    recordRuntimeEffect(file, {
      ...base,
      ...successfulEffectOutcomes(),
    }, { clock: () => T1 }),
    (error) => error.code === "EFFECT_INTENT_REQUIRED",
  );

  const second = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-b",
    leaseDurationMs: 60_000,
  }, { clock: () => T2 });
  await ackStarted(file, {
    runId: second.runId,
    attemptNo: second.attemptNo,
    owner: "worker-b",
    evidence: platformEvidence("exec-intent-b", T2),
  }, { clock: () => T2 });
  const recoveryBase = {
    ...runContext(key, second, "worker-b"),
    effectType: "task.writeback",
    target,
  };
  await assert.rejects(
    reconcileRuntimeEffect(file, {
      ...recoveryBase,
      ...successfulEffectOutcomes(),
      reconciliationEvidence: {
        kind: "authoritative-readback",
        sourceRevision: "sha256:intent-required",
        digest: INTENT_A,
      },
    }, { clock: () => T2 }),
    (error) => error.code === "EFFECT_INTENT_REQUIRED",
  );
  await assert.rejects(
    releaseRuntimeEffectPreparation(file, {
      ...recoveryBase,
      reconciliationEvidence: {
        kind: "authoritative-negative-readback",
        sourceRevision: "sha256:intent-required",
        digest: INTENT_A,
      },
    }, { clock: () => T2 }),
    (error) => error.code === "EFFECT_INTENT_REQUIRED",
  );
});

test("prepared intent can be replaced only after negative readback; an applied intent is immutable", async (t) => {
  const file = await fixture(t);
  const key = eligibility({ triggerCursor: "intent-a-to-b" });
  const first = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-a",
    leaseDurationMs: 1_500,
  }, { clock: () => T0 });
  await ackStarted(file, {
    runId: first.runId,
    attemptNo: first.attemptNo,
    owner: "worker-a",
    evidence: platformEvidence("exec-a-to-b-1", T1),
  }, { clock: () => T1 });
  const target = `project/task.md#${key.taskId}`;
  await prepareRuntimeEffect(file, {
    ...runContext(key, first, "worker-a"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
  }, { clock: () => T1 });

  const second = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-b",
    leaseDurationMs: 60_000,
  }, { clock: () => T2 });
  await ackStarted(file, {
    runId: second.runId,
    attemptNo: second.attemptNo,
    owner: "worker-b",
    evidence: platformEvidence("exec-a-to-b-2", T2),
  }, { clock: () => T2 });
  const rebound = await prepareRuntimeEffect(file, {
    ...runContext(key, second, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_B,
  }, { clock: () => T2 });
  assert.equal(rebound.reconciliationRequired, true);
  assert.equal(rebound.intentDigest, INTENT_A);
  await releaseRuntimeEffectPreparation(file, {
    ...runContext(key, second, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_A,
    reconciliationEvidence: {
      kind: "authoritative-negative-readback",
      sourceRevision: "sha256:intent-a-absent",
      digest: INTENT_C,
    },
  }, { clock: () => T2 });
  const preparedB = await prepareRuntimeEffect(file, {
    ...runContext(key, second, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_B,
  }, { clock: () => T2 });
  assert.equal(preparedB.shouldApply, true);
  await recordRuntimeEffect(file, {
    ...runContext(key, second, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_B,
    ...successfulEffectOutcomes(),
  }, { clock: () => T3 });
  await assert.rejects(
    prepareRuntimeEffect(file, {
      ...runContext(key, second, "worker-b"),
      effectType: "task.writeback",
      target,
      intentDigest: INTENT_A,
    }, { clock: () => T3 }),
    (error) => error.code === "EFFECT_PAYLOAD_CONFLICT",
  );
  const effect = (await readRuntimeLedger(file, { clock: () => T3 })).runs[first.runId].effects[stableEffectId("task.writeback", target)];
  assert.equal(effect.intentDigest, INTENT_B);
  assert.equal(effect.receipts[0].intentDigest, INTENT_A);
  assert.equal(effect.receipts[1].intentDigest, INTENT_B);
});

test("a negatively reconciled omitted review retires cleanly and cannot block trusted settlement", async (t) => {
  const file = await fixture(t);
  const key = eligibility({ triggerCursor: "retired-review" });
  const first = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-a",
    leaseDurationMs: 1_500,
  }, { clock: () => T0 });
  await ackStarted(file, {
    runId: first.runId,
    attemptNo: first.attemptNo,
    owner: "worker-a",
    evidence: platformEvidence("exec-review-a", T1),
  }, { clock: () => T1 });
  const target = `project/task.md#${key.taskId}`;
  await prepareRuntimeEffect(file, {
    ...runContext(key, first, "worker-a"),
    effectType: "task.selfScheduleReview",
    target,
    intentDigest: INTENT_A,
  }, { clock: () => T1 });

  const second = await claimRuntimeRun(file, {
    eligibilityKey: key,
    owner: "worker-b",
    leaseDurationMs: 60_000,
  }, { clock: () => T2 });
  await ackStarted(file, {
    runId: second.runId,
    attemptNo: second.attemptNo,
    owner: "worker-b",
    evidence: platformEvidence("exec-review-b", T2),
  }, { clock: () => T2 });
  await releaseRuntimeEffectPreparation(file, {
    ...runContext(key, second, "worker-b"),
    effectType: "task.selfScheduleReview",
    target,
    intentDigest: INTENT_A,
    retireEffect: true,
    reconciliationEvidence: {
      kind: "authoritative-negative-readback",
      sourceRevision: "sha256:review-omitted",
      digest: INTENT_C,
    },
  }, { clock: () => T2 });
  const mainEffectId = stableEffectId("task.writeback", target);
  await runIdempotentRuntimeEffect(file, {
    ...runContext(key, second, "worker-b"),
    effectType: "task.writeback",
    target,
    intentDigest: INTENT_B,
  }, async () => successfulEffectOutcomes(), { clock: () => T3 });
  const settled = await settleRuntimeRun(file, {
    runId: second.runId,
    attemptNo: second.attemptNo,
    owner: "worker-b",
    processOutcome: { status: "succeeded", exitCode: 0 },
    writebackOutcome: { status: "succeeded", effectIds: [mainEffectId] },
    readbackOutcome: { status: "succeeded", effectIds: [mainEffectId] },
  }, { clock: () => T4 });
  assert.equal(settled.trustedCompletion, true);
  const state = await readRuntimeLedger(file, { clock: () => T4 });
  const review = state.runs[first.runId].effects[stableEffectId("task.selfScheduleReview", target)];
  assert.ok(review.retiredAt);
  assert.equal(review.intentDigest, undefined);
  assert.equal(review.receipts[0].intentDigest, INTENT_A);
});

test("effect identity rejects unknown types, path escapes, sensitive paths and query-bearing targets", () => {
  for (const [type, target] of [
    ["arbitrary-effect", "project/task.md#task-a"],
    ["task.writeback", "/absolute/task.md#task-a"],
    ["task.writeback", "../outside/task.md#task-a"],
    ["task.writeback", ".git/config#task-a"],
    ["task.writeback", "project/task.md?token=secret#task-a"],
    ["task.writeback", "00_本地工作台/本人草稿/private.md#task-a"],
  ]) {
    assert.throws(() => stableEffectId(type, target), RuntimeLedgerError);
  }
});
