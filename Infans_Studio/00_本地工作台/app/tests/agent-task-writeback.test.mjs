import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_TASK_EFFECTS,
  createResultProposal,
  recordProcessExit,
  selfScheduleReviewEffectId,
  sourceContentHash,
  taskSnapshotFingerprint,
  taskWritebackEffectId,
  writeBackAgentTaskResult,
} from "../scripts/agent-task-writeback.mjs";
import { parseProjectManagementDocument } from "../src/server/workbench-project-management.mjs";

const SOURCE_PATH = "30_事业顺利/测试项目/项目进度与待办.md";
const TASK_ID = "agent-writeback-fixture-20260904";
const EXECUTOR_ID = "codex-ai-acceptance";
const NOW = new Date("2026-09-04T08:30:00+09:00");

function fixtureMarkdown(taskLine = `- [ ] 公司：验收：2026-09-04 · AI· 核对公共写回｜ID：${TASK_ID}｜执行器：${EXECUTOR_ID}`) {
  return `---
description: 自动任务写回临时夹具
tags: [测试]
---

# 临时项目

## 当前状态

只用于临时测试。

## 正在做

${taskLine}
  - 完成门：隔离测试通过并留下证据。
  - 自动推进：{"version":1,"mode":"automatic","authorization":["vault:read","task:complete","task:writeback"],"lifecycle":1,"selfScheduleReview":true,"triggers":[{"id":"due","type":"time","at":"2026-09-04T00:00:00.000Z"}]}
  - 保留字段：不要改我。

- [ ] 公司：开发：2026-09-05 · AI· 保留相邻任务｜ID：sibling-task-20260904｜执行器：${EXECUTOR_ID}
  - 相邻证据：必须原样保留。

## 下一步

- 无

## 阻塞

- 无

## 最近完成

- 无

## 权威入口

- [[临时入口]]
`;
}

async function makeFixture(t, markdown = fixtureMarkdown()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-writeback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, ...SOURCE_PATH.split("/"));
  const proposalPath = path.join(root, "runtime", "result-proposal.json");
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  await fs.writeFile(sourceFile, markdown, { mode: 0o600 });
  return { root, sourceFile, proposalPath };
}

function taskFromMarkdown(markdown) {
  const management = parseProjectManagementDocument(markdown, {
    sourcePath: SOURCE_PATH,
    projectId: "fixture-project",
    projectName: "测试项目",
    todayKey: "2026-09-04",
  });
  return [...management.doing, ...management.next, ...management.blocked].find((task) => task.id === TASK_ID);
}

function contextFor(markdown, authorizedEffects, overrides = {}) {
  const task = taskFromMarkdown(markdown);
  assert.ok(task, "fixture task must parse");
  const base = {
    runId: "local:run-0001",
    attemptNo: 1,
    taskId: TASK_ID,
    sourcePath: SOURCE_PATH,
    executorId: EXECUTOR_ID,
    eligibilityRevision: "eligibility-0001",
    effectId: taskWritebackEffectId({ taskId: TASK_ID, sourcePath: SOURCE_PATH }),
    taskFingerprint: taskSnapshotFingerprint(task),
    expectedSourceHash: sourceContentHash(markdown),
    authorizedEffects,
    verifiedEvidence: [],
  };
  return { ...base, ...overrides };
}

async function fillProposal(proposalPath, outcome, additions = {}) {
  const proposal = JSON.parse(await fs.readFile(proposalPath, "utf8"));
  proposal.outcome = outcome;
  Object.assign(proposal, additions);
  await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600 });
}

class FakeLedger {
  constructor(context) {
    this.context = structuredClone(context);
    this.effects = new Map();
    this.effectCalls = 0;
    this.schedules = new Map();
    this.scheduleCalls = 0;
    this.schedulePrepareCalls = 0;
    this.exits = [];
  }

  async assertRunContext(context) {
    assert.deepEqual(context, this.context);
    return structuredClone(this.context);
  }

  async runIdempotentEffect(meta, apply) {
    const key = `${meta.runId}\0${meta.effectId}`;
    const previous = this.effects.get(key);
    if (previous) return { duplicate: true, receipt: structuredClone(previous.receipt) };
    this.effectCalls += 1;
    const receipt = await apply();
    this.effects.set(key, { meta: structuredClone(meta), receipt: structuredClone(receipt) });
    return { duplicate: false, receipt };
  }

  async withSourceMutation(apply) {
    return apply();
  }

  async scheduleReview(meta) {
    const key = `${meta.runId}\0${meta.effectId}`;
    const previous = this.schedules.get(key);
    if (previous) return { duplicate: true, schedule: structuredClone(previous) };
    this.scheduleCalls += 1;
    this.schedules.set(key, structuredClone(meta));
    return { duplicate: false, schedule: meta };
  }

  async prepareReview() {
    this.schedulePrepareCalls += 1;
    return { prepared: true, shouldApply: true, duplicate: false, reconciliationRequired: false };
  }

  async releaseOmittedReview() {
    return { released: false, reason: "no-stale-review" };
  }

  async hasCommittedEffect({ runId, effectId }) {
    return this.effects.has(`${runId}\0${effectId}`);
  }

  async recordProcessExit(event) {
    this.exits.push(structuredClone(event));
    return event;
  }
}

async function prepareResult(t, outcome, authorizedEffects, options = {}) {
  const fixture = await makeFixture(t, options.markdown || fixtureMarkdown());
  const markdown = await fs.readFile(fixture.sourceFile, "utf8");
  const verifiedEvidence = [];
  if (options.verifiedEvidence === undefined) {
    for (const reference of [...new Set(outcome.evidenceRefs || [])]) {
      if (typeof reference !== "string" || reference.includes(":")) continue;
      const absolute = path.join(fixture.root, ...reference.split("/"));
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      const content = Buffer.from(`verified evidence for ${reference}\n`);
      await fs.writeFile(absolute, content);
      verifiedEvidence.push({ path: reference, sha256: sourceContentHash(content) });
    }
  }
  const context = contextFor(markdown, authorizedEffects, {
    verifiedEvidence: options.verifiedEvidence ?? verifiedEvidence,
    ...options.contextOverrides,
  });
  const ledger = new FakeLedger(context);
  await createResultProposal({ proposalPath: fixture.proposalPath, effectId: context.effectId });
  await fillProposal(fixture.proposalPath, outcome, options.proposalAdditions);
  return { ...fixture, markdown, context, ledger };
}

test("completed 只有在 summary 与 evidenceRefs 齐全时勾选，并只改同一任务块", async (t) => {
  const setup = await prepareResult(t, {
    status: "completed",
    summary: "专项测试 12/12 通过，完成门已满足。",
    evidenceRefs: ["tests/agent-task-writeback.test.mjs"],
    nextStep: "",
  }, [AGENT_TASK_EFFECTS.completed]);

  const beforeSibling = setup.markdown.slice(setup.markdown.indexOf("- [ ] 公司：开发"));
  const result = await writeBackAgentTaskResult({
    vaultRoot: setup.root,
    proposalPath: setup.proposalPath,
    coordinatorContext: setup.context,
    ledger: setup.ledger,
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.receipt.outcome, "completed");
  assert.deepEqual(result.receipt.evidence, setup.context.verifiedEvidence);
  const written = await fs.readFile(setup.sourceFile, "utf8");
  assert.match(written, new RegExp(`^- \\[x\\].*ID：${TASK_ID}.*完成时间：2026-09-03T23:30:00.000Z$`, "mu"));
  assert.match(written, /当前状态：已完成：专项测试 12\/12 通过，完成门已满足。/u);
  assert.match(written, /证据：tests\/agent-task-writeback\.test\.mjs/u);
  assert.match(written, /自动回执：`\{"schemaVersion":1,"runId":"local:run-0001"/u);
  assert.equal(written.slice(written.indexOf("- [ ] 公司：开发")), beforeSibling);
  assert.equal((written.match(/自动回执/g) || []).length, 1);
});

test("completed 缺少证据时拒绝，任务保持开放", async (t) => {
  const setup = await prepareResult(t, {
    status: "completed",
    summary: "只有结论，没有证据。",
    evidenceRefs: [],
    nextStep: "",
  }, [AGENT_TASK_EFFECTS.completed]);

  await assert.rejects(
    writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
    (error) => error?.code === "COMPLETION_EVIDENCE_REQUIRED",
  );
  assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
  assert.equal(setup.ledger.effects.size, 0);
});

test("模型证据引用与协调器密封快照不一致时拒绝写回", async (t) => {
  const setup = await prepareResult(t, {
    status: "completed",
    summary: "模型试图替换证据定位。",
    evidenceRefs: ["evidence/model.md"],
    nextStep: "",
  }, [AGENT_TASK_EFFECTS.completed], {
    verifiedEvidence: [{ path: "evidence/coordinator.md", sha256: "a".repeat(64) }],
  });

  await assert.rejects(
    writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
    (error) => error?.code === "EVIDENCE_SNAPSHOT_MISMATCH",
  );
  assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
});

test("自动结果不能代签本人验收", async (t) => {
  const setup = await prepareResult(t, {
    status: "completed",
    summary: "Capoo 已验收，任务可以结束。",
    evidenceRefs: ["evidence/technical-check.txt"],
    nextStep: "",
  }, [AGENT_TASK_EFFECTS.completed]);

  await assert.rejects(
    writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
    (error) => error?.code === "PERSONAL_ACCEPTANCE_FORBIDDEN",
  );
  assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
});

test("模型结果中的 Markdown、HTML 与外链载荷不能进入任务原件", async (t) => {
  for (const summary of [
    "查看 [结果](https://example.invalid/leak)",
    "加载 ![证据](https://example.invalid/pixel)",
    "插入 <img src=https://example.invalid/leak>",
    "引用 [[不可信嵌入]]",
    "执行 `伪命令`",
  ]) {
    await t.test(summary.slice(0, 12), async (st) => {
      const setup = await prepareResult(st, {
        status: "progress",
        summary,
        evidenceRefs: [],
        nextStep: "保持任务开放。",
      }, [AGENT_TASK_EFFECTS.progress]);
      await assert.rejects(
        writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
        (error) => error?.code === "RESULT_MARKUP_FORBIDDEN",
      );
      assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
    });
  }
});

test("summary 与 nextStep 中的典型凭据外形都拒绝写回", async (t) => {
  const secretLikeValues = [
    "sk-this-is-a-fake-secret-token-0001",
    "Bearer fakeBearerTokenValue0001",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.fakeSignature0001",
  ];
  for (const field of ["summary", "nextStep"]) {
    for (const secretLikeValue of secretLikeValues) {
      await t.test(`${field}: ${secretLikeValue.slice(0, 12)}`, async (st) => {
        const outcome = {
          status: "progress",
          summary: "已完成安全边界检查。",
          evidenceRefs: [],
          nextStep: "继续核对公共写回。",
          [field]: secretLikeValue,
        };
        const setup = await prepareResult(st, outcome, [AGENT_TASK_EFFECTS.progress]);

        await assert.rejects(
          writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
          (error) => error?.code === "RESULT_SENSITIVE_CONTENT_FORBIDDEN",
        );
        assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
        assert.equal(setup.ledger.effects.size, 0);
      });
    }
  }
});

for (const [status, effect, state] of [
  ["blocked", AGENT_TASK_EFFECTS.blocked, "阻塞：缺少设备授权，当前无法继续。"],
  ["failed", AGENT_TASK_EFFECTS.failed, "本轮失败：专项测试仍有一项失败。"],
  ["progress", AGENT_TASK_EFFECTS.progress, "进行中：已完成解析，仍在核对回读。"],
]) {
  test(`${status} 保持任务开放并维护滚动进展与最小回执`, async (t) => {
    const summary = state.slice(state.indexOf("：") + 1);
    const setup = await prepareResult(t, {
      status,
      summary,
      evidenceRefs: status === "progress" ? [] : [`evidence/${status}.txt`],
      nextStep: "下一轮只执行剩余的一项核对。",
    }, [effect]);
    await writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW });
    const written = await fs.readFile(setup.sourceFile, "utf8");
    assert.match(written, new RegExp(`^- \\[ \\].*ID：${TASK_ID}`, "mu"));
    assert.match(written, /进展时间：2026-09-04 08:30/u);
    assert.ok(written.includes(`当前状态：${state}`));
    assert.match(written, /下一步：下一轮只执行剩余的一项核对。/u);
    assert.match(written, new RegExp(`"outcome":"${status}"`, "u"));
  });
}

test("无尾换行且任务位于文件末尾时，首条写回详情仍另起一行", async (t) => {
  const markdown = `# 临时项目\n\n## 正在做\n\n- [ ] 公司：验收：AI· 末行任务｜ID：${TASK_ID}｜执行器：${EXECUTOR_ID}`;
  const setup = await prepareResult(t, {
    status: "progress",
    summary: "末行任务已安全记录进展。",
    evidenceRefs: [],
    nextStep: "继续下一项检查。",
  }, [AGENT_TASK_EFFECTS.progress], { markdown });
  await writeBackAgentTaskResult({
    vaultRoot: setup.root,
    proposalPath: setup.proposalPath,
    coordinatorContext: setup.context,
    ledger: setup.ledger,
    now: NOW,
  });
  const written = await fs.readFile(setup.sourceFile, "utf8");
  assert.match(written, new RegExp(`执行器：${EXECUTOR_ID}\\n  - 进展时间：`, "u"));
  assert.doesNotMatch(written, new RegExp(`执行器：${EXECUTOR_ID}  - 进展时间：`, "u"));
});

test("来源哈希冲突时停止，不以最后写入覆盖并行变化", async (t) => {
  const setup = await prepareResult(t, {
    status: "progress",
    summary: "准备写回。",
    evidenceRefs: [],
    nextStep: "重读并重新认领。",
  }, [AGENT_TASK_EFFECTS.progress]);
  await fs.appendFile(setup.sourceFile, "\n并行编辑必须保留。\n");

  await assert.rejects(
    writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
    (error) => error?.code === "SOURCE_CONFLICT",
  );
  const current = await fs.readFile(setup.sourceFile, "utf8");
  assert.match(current, /并行编辑必须保留。/u);
  assert.doesNotMatch(current, /自动回执/u);
  assert.equal(setup.ledger.effects.size, 0);
});

test("同一 runId + effectId 重放只产生一次正式效果", async (t) => {
  const setup = await prepareResult(t, {
    status: "progress",
    summary: "第一阶段已经完成。",
    evidenceRefs: ["evidence/phase-one.txt"],
    nextStep: "继续第二阶段。",
  }, [AGENT_TASK_EFFECTS.progress]);
  const input = { vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW };
  const first = await writeBackAgentTaskResult(input);
  const afterFirst = await fs.readFile(setup.sourceFile, "utf8");
  const second = await writeBackAgentTaskResult(input);
  const afterSecond = await fs.readFile(setup.sourceFile, "utf8");

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(afterSecond, afterFirst);
  assert.equal(setup.ledger.effectCalls, 1);
  assert.equal((afterSecond.match(/自动回执/g) || []).length, 1);
});

test("来源已写而效果账未收口时按原件回执恢复，不重复追加", async (t) => {
  const setup = await prepareResult(t, {
    status: "progress",
    summary: "结果已经落入原件。",
    evidenceRefs: ["evidence/recovery.txt"],
    nextStep: "由账本补齐效果收口。",
  }, [AGENT_TASK_EFFECTS.progress]);
  const input = { vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW };
  await writeBackAgentTaskResult(input);
  const once = await fs.readFile(setup.sourceFile, "utf8");
  setup.ledger.effects.clear();
  const recovered = await writeBackAgentTaskResult(input);
  const twice = await fs.readFile(setup.sourceFile, "utf8");

  assert.equal(recovered.duplicate, false);
  assert.equal(recovered.receipt.recovered, true);
  assert.equal(twice, once);
  assert.equal((twice.match(/自动回执/g) || []).length, 1);
});

test("未授权的完成效果与模型夹带的 runId 都被拒绝", async (t) => {
  await t.test("完成效果越权", async (st) => {
    const setup = await prepareResult(st, {
      status: "completed",
      summary: "试图越权完成。",
      evidenceRefs: ["evidence.txt"],
      nextStep: "",
    }, [AGENT_TASK_EFFECTS.progress]);
    await assert.rejects(
      writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
      (error) => error?.code === "EFFECT_NOT_AUTHORIZED",
    );
    assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
  });

  await t.test("proposal 夹带自造 runId", async (st) => {
    const setup = await prepareResult(st, {
      status: "progress",
      summary: "结果本身有效。",
      evidenceRefs: [],
      nextStep: "等待公共入口。",
    }, [AGENT_TASK_EFFECTS.progress], { proposalAdditions: { runId: "model:forged-run" } });
    await assert.rejects(
      writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
      (error) => error?.code === "RESULT_SCHEMA_INVALID",
    );
    assert.equal(setup.ledger.effects.size, 0);
  });
});

test("执行岗位与任务原件不一致时拒绝写回", async (t) => {
  const setup = await prepareResult(t, {
    status: "progress",
    summary: "不应写入。",
    evidenceRefs: [],
    nextStep: "交还正确岗位。",
  }, [AGENT_TASK_EFFECTS.progress], { contextOverrides: { executorId: "different-executor" } });
  await assert.rejects(
    writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
    (error) => error?.code === "TASK_EXECUTOR_MISMATCH",
  );
  assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
});

test("nextReviewAt 只有 selfScheduleReview 授权时才写入并登记稳定效果", async (t) => {
  await t.test("没有授权", async (st) => {
    const setup = await prepareResult(st, {
      status: "progress",
      summary: "等待下一观察窗。",
      evidenceRefs: [],
      nextStep: "下一观察窗重新核对。",
      nextReviewAt: "2026-09-05T10:00:00+09:00",
    }, [AGENT_TASK_EFFECTS.progress]);
    await assert.rejects(
      writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW }),
      (error) => error?.code === "SELF_SCHEDULE_REVIEW_FORBIDDEN",
    );
    assert.equal(await fs.readFile(setup.sourceFile, "utf8"), setup.markdown);
    assert.equal(setup.ledger.schedules.size, 0);
  });

  await t.test("已有授权", async (st) => {
    const setup = await prepareResult(st, {
      status: "progress",
      summary: "等待下一观察窗。",
      evidenceRefs: [],
      nextStep: "下一观察窗重新核对。",
      nextReviewAt: "2026-09-05T10:00:00+09:00",
    }, [AGENT_TASK_EFFECTS.progress, AGENT_TASK_EFFECTS.selfScheduleReview]);
    const input = { vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW };
    await writeBackAgentTaskResult(input);
    await writeBackAgentTaskResult(input);
    assert.equal(setup.ledger.schedulePrepareCalls, 2);
    assert.equal(setup.ledger.scheduleCalls, 1);
    const schedule = [...setup.ledger.schedules.values()][0];
    assert.equal(schedule.effectId, selfScheduleReviewEffectId(setup.context));
    assert.equal(schedule.nextReviewAt, "2026-09-05T01:00:00.000Z");
  });
});

test("进程零退出但没有可信写回时收口为 incomplete", async (t) => {
  const markdown = fixtureMarkdown();
  const context = contextFor(markdown, [AGENT_TASK_EFFECTS.progress]);
  const ledger = new FakeLedger(context);
  const event = await recordProcessExit({ coordinatorContext: context, ledger, exitCode: 0, now: NOW });

  assert.equal(event.phase, "incomplete");
  assert.equal(event.trustedWriteback, false);
  assert.equal(ledger.exits.length, 1);
  assert.equal(ledger.exits[0].phase, "incomplete");
});

test("进程零退出但结果校验失败时仍按执行失败收口", async () => {
  const markdown = fixtureMarkdown();
  const context = contextFor(markdown, [AGENT_TASK_EFFECTS.progress]);
  const ledger = new FakeLedger(context);
  const event = await recordProcessExit({
    coordinatorContext: context,
    ledger,
    exitCode: 0,
    errorCode: "RESULT_SCHEMA_INVALID",
    now: NOW,
  });

  assert.equal(event.phase, "process-failed");
  assert.equal(event.trustedWriteback, false);
  assert.equal(ledger.exits[0].phase, "process-failed");
});

test("非零退出但已有可信写回时保留业务效果并记录执行故障", async (t) => {
  const setup = await prepareResult(t, {
    status: "progress",
    summary: "业务事实已先写回。",
    evidenceRefs: ["evidence/before-crash.txt"],
    nextStep: "下一尝试继续收口。",
  }, [AGENT_TASK_EFFECTS.progress]);
  await writeBackAgentTaskResult({ vaultRoot: setup.root, proposalPath: setup.proposalPath, coordinatorContext: setup.context, ledger: setup.ledger, now: NOW });
  const beforeExit = await fs.readFile(setup.sourceFile, "utf8");
  const event = await recordProcessExit({ coordinatorContext: setup.context, ledger: setup.ledger, exitCode: 1, errorCode: "PROCESS_CRASH", now: NOW });

  assert.equal(event.phase, "process-failed-after-writeback");
  assert.equal(event.trustedWriteback, true);
  assert.equal(await fs.readFile(setup.sourceFile, "utf8"), beforeExit);
});
