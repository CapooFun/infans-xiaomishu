import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  appendExternalAgentUsage,
  buildUsageAnomalies,
  importCursorAccountCsv,
  importCursorAccountEvents,
  cursorAccountCsvFromEvents,
  cursorAccountOverlapFingerprint,
  cursorAccountSourcePriority,
  dedupeCursorAccountRows,
  deriveCursorWindowTitle,
  isWeakCursorWindowTitle,
  normalizeExternalUsage,
  personalLifeFeatureId,
  parseCursorUsageCsv,
  readAgentObservability,
  readAgentObservabilityCached,
  reconcileExternalAccount,
  resolveCursorConversationTitles,
  writeAgentObservabilityLink,
} from "../src/server/workbench-agent-observability.mjs";

test("异常脉冲只和同项目阶段的更早任务比较，并识别子任务链膨胀", () => {
  const task = (index, totalTokens, childTokens = 0) => ({
    id: `task-${index}`,
    reference: `TASK${index}`,
    title: `测试任务 ${index}`,
    kind: "codex",
    updatedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00+09:00`,
    projectPhase: "iteration",
    projectMatches: [{ projectId: "project-a", projectName: "测试项目", relevance: 100 }],
    featureMatches: [],
    totalUsage: { inputTokens: totalTokens, cachedInputTokens: totalTokens * .8, outputTokens: 0, reasoningTokens: 0, totalTokens },
    selfUsage: { inputTokens: totalTokens - childTokens, cachedInputTokens: (totalTokens - childTokens) * .8, outputTokens: 0, reasoningTokens: 0, totalTokens: totalTokens - childTokens },
    childUsage: { inputTokens: childTokens, cachedInputTokens: childTokens * .8, outputTokens: 0, reasoningTokens: 0, totalTokens: childTokens },
    childCount: childTokens ? 4 : 0,
  });
  const anomalies = buildUsageAnomalies([
    task(0, 9_000_000), task(1, 10_000_000), task(2, 11_000_000), task(3, 10_000_000), task(4, 10_000_000), task(5, 50_000_000, 40_000_000),
  ]);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].baselineTokens, 10_000_000);
  assert.equal(anomalies[0].multiple, 5);
  assert.equal(anomalies[0].cause, "child-chain");
  assert.equal(anomalies[0].baselineSampleCount, 5);
});

const NOW = Date.parse("2026-09-01T04:00:00+09:00");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-agent-observability-"));
  const codexHome = path.join(root, ".codex");
  const sessions = path.join(codexHome, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const parentRollout = path.join(sessions, "parent.jsonl");
  const childRollout = path.join(sessions, "child.jsonl");
  const tokenRow = (timestamp, last, total = last) => JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: 200_000 } },
  });
  await fs.writeFile(parentRollout, `${tokenRow("2026-08-31T18:00:00.000Z", { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 130 })}\n`);
  await fs.writeFile(childRollout, [
    tokenRow("2026-08-31T18:10:00.000Z", { input_tokens: 50, cached_input_tokens: 20, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 70 }),
    JSON.stringify({ timestamp: "2026-08-31T18:11:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: null, last_token_usage: null } } }),
  ].join("\n"));

  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, model TEXT, reasoning_effort TEXT, created_at INTEGER, updated_at INTEGER, rollout_path TEXT, archived INTEGER, cwd TEXT, project_id TEXT, first_user_message TEXT, preview TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
  `);
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("parent-1", "旧的状态库首句", "gpt-test", "high", Math.floor((NOW - 3_600_000) / 1000), Math.floor((NOW - 1_800_000) / 1000), parentRollout, 0, root, "infans-ai-system", "", "");
  insert.run("child-1", "子任务", "gpt-test", "high", Math.floor((NOW - 3_000_000) / 1000), Math.floor((NOW - 1_200_000) / 1000), childRollout, 0, root, "infans-ai-system", "", "");
  db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run("parent-1", "child-1", "completed");
  db.close();
  await fs.writeFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "小秘书密码管理功能整理" })}\n`);

  const featureDir = path.join(root, "00_本地工作台/10_设计/20_模块");
  await fs.mkdir(featureDir, { recursive: true });
  await fs.writeFile(path.join(root, "00_本地工作台/10_设计/小秘书_产品功能树.md"), `# 小秘书功能树\n\n| 模块 | ID | 说明 | 原件 |\n|---|---|---|---|\n| 实用工具 | tools | 工具 | [[00_本地工作台/10_设计/实用工具/小秘书模块_实用工具]] |\n| 定时与自动化 | automation | 自动任务 | [[00_本地工作台/10_设计/定时与自动化/小秘书模块_定时与自动化]] |\n`);
  await fs.writeFile(path.join(featureDir, "小秘书模块_实用工具.md"), `# 实用工具\n\n## 实用工具｜ID：tools\n\n| 小模块 | 状态 | 说明 | 功能点 | 当前进度 | 原件 | ID |\n|---|---|---|---|---|---|---|\n| 智能体观测 | 开发中 | 任务账册 | 任务链 | 当前：开发 | 本模块 | tools-agent-observability |\n| 产品功能 Wiki 树 | 稳定 | 按模块查看功能 Wiki | 自动归属 | 完成：可用 | 本模块 | projects-feature-tree |\n| NAS 相册 | 稳定 | 查看和预览照片 | 下载与全屏 | 完成：可用 | 本模块 | tools-photo |\n`);
  await fs.writeFile(path.join(featureDir, "小秘书模块_定时与自动化.md"), `# 定时与自动化\n\n## 定时与自动化｜ID：automation\n\n| 小模块 | 状态 | 说明 | 功能点 | 当前进度 | 原件 | ID |\n|---|---|---|---|---|---|---|\n| 小秘书每日版本收口 | 稳定 | Cursor 每日收口 | 任务角色 | 完成：可用 | 本模块 | automation-daily-release |\n`);

  const runDir = path.join(root, "00_本地工作台/30_证据/AI定时任务运行包/daily");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "run.md"), `---\nrunId: "daily-1"\nroleId: "workbench-daily-release"\nadapter: "cursor-cli"\nmodel: "cursor-test"\nstartedAt: "2026-09-01T02:00:00+09:00"\nprocessState: exited\nfinishedAt: "2026-09-01T02:03:00+09:00"\nexitCode: 0\nusageSource: "cursor-headless-json"\ninputTokens: 80\ncacheReadTokens: 30\ncacheWriteTokens: 5\noutputTokens: 20\ntotalTokens: 100\n---\n`);
  const oldRunDir = path.join(root, "00_本地工作台/30_证据/AI定时任务运行包/market-brief");
  await fs.mkdir(oldRunDir, { recursive: true });
  await fs.writeFile(path.join(oldRunDir, "old.md"), `---\nrunId: "brief-old"\nroleId: "market-brief"\nadapter: "cursor-cli"\nmodel: "cursor-test"\nstartedAt: "2026-09-01T01:00:00+09:00"\nprocessState: exited\nfinishedAt: "2026-09-01T01:10:00+09:00"\nexitCode: 0\n---\n`);
  return { root, codexHome };
}

test("任务链按会话累计快照汇总，自身与子任务不重复", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const chain = snapshot.tasks.find((item) => item.id === "parent-1");
  assert.equal(chain.selfUsage.totalTokens, 130);
  assert.equal(chain.childUsage.totalTokens, 70);
  assert.equal(chain.totalUsage.totalTokens, 200);
  assert.equal(chain.totalUsage.cachedInputTokens, 60);
  assert.equal(chain.childCount, 1);
  assert.equal(chain.title, "小秘书密码管理功能整理");
  assert.deepEqual(chain.projectMatches.map((item) => item.projectName), ["小秘书"]);
  assert.deepEqual(chain.featureMatches, []);
  assert.equal(snapshot.summary.totalTokens, 300);
  assert.equal(snapshot.summary.cursorRunCount, 2);
  assert.equal(snapshot.summary.cursorMeasuredRunCount, 1);
  assert.equal(snapshot.scheduledRuns.runCount, 2);
  assert.equal(snapshot.scheduledRuns.measuredRunCount, 1);
  assert.equal(snapshot.scheduledRuns.usage.totalTokens, 100);
  assert.deepEqual(snapshot.scheduledRuns.runs.map((item) => item.roleName), ["版本收口", "金融简报"]);
  assert.equal(snapshot.scheduledRuns.runs[1].measured, false);
  assert.equal(snapshot.agents.find((item) => item.id === "cursor").usage.totalTokens, 100);
  assert.equal(snapshot.tasks.find((item) => item.id === "cursor:brief-old").totalUsage, null);
  assert.equal(snapshot.agentTrends.codex.reduce((sum, day) => sum + day.totalTokens, 0), 200);
  assert.equal(snapshot.agentTrends.cursor.reduce((sum, day) => sum + day.totalTokens, 0), 100);
  assert.equal(snapshot.agentTrends.all.reduce((sum, day) => sum + day.totalTokens, 0), 300);
  assert.deepEqual(snapshot.recentTasks.map((item) => item.id), ["parent-1", "cursor:daily-1"]);
  assert.deepEqual(snapshot.recentTasksByAgent.codex.map((item) => item.id), ["parent-1"]);
  assert.deepEqual(snapshot.recentTasksByAgent.cursor.map((item) => item.id), ["cursor:daily-1"]);
  assert.ok(snapshot.recentTasks.every((item) => item.totalUsage && item.countsTowardSourceTotal !== false));
});

async function addCodexIdentityFixtures(root, codexHome, rows) {
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.exec("ALTER TABLE threads ADD COLUMN source TEXT; ALTER TABLE threads ADD COLUMN thread_source TEXT;");
  for (const row of rows) {
    const rollout = path.join(codexHome, "sessions", `${row.id}.jsonl`);
    const payload = { id: row.id, source: row.metaSource || "vscode", ...(row.parent ? { parent_thread_id: row.parent } : {}) };
    await fs.writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload }),
      JSON.stringify({ type: "event_msg", timestamp: new Date(NOW - 1000).toISOString(), payload: { type: "token_count", info: { total_token_usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } } } }),
    ].join("\n"));
    db.prepare("INSERT INTO threads (id,title,model,created_at,updated_at,rollout_path,cwd,project_id,first_user_message,source,thread_source) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      row.id, row.title || "内部处理", "test", NOW / 1000 - 10, NOW / 1000 - 1, rollout, root, "infans-ai-system",
      row.text || "", row.source ? JSON.stringify(row.source) : "vscode", row.threadSource || null,
    );
    if (row.edge) db.prepare("INSERT INTO thread_spawn_edges VALUES (?,?,?)").run(row.edge, row.id, "completed");
  }
  db.close();
}

test("审批和普通子任务由结构化父关系合并，正文不污染项目归属，正常英文根任务保留", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const guardian = { subagent: { other: "guardian" } };
  await addCodexIdentityFixtures(root, codexHome, [
    { id: "guardian-current", threadSource: "guardian_review", parent: "parent-1", text: "NAS 相册 tools-photo 不得进入归属正文" },
    { id: "guardian-old", source: guardian, parent: "parent-1" },
    { id: "guardian-header-only", metaSource: guardian, parent: "parent-1" },
    { id: "nested-worker", threadSource: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: "guardian-current" } } } },
    { id: "duplicate-edge", threadSource: "subagent", parent: "parent-1", edge: "parent-1" },
    { id: "english-root", title: "Fix English task title\n正文不应作为标题", threadSource: "user" },
  ]);
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const chain = snapshot.tasks.find((task) => task.id === "parent-1");
  assert.equal(chain.totalUsage.totalTokens, 250);
  assert.equal(chain.selfUsage.totalTokens, 130);
  assert.equal(chain.childUsage.totalTokens, 120);
  assert.equal(chain.childCount, 6);
  assert.deepEqual(chain.featureMatches, []);
  assert.equal(snapshot.tasks.find((task) => task.id === "english-root").title, "Fix English task title");
  assert.deepEqual(snapshot.recentTasksByAgent.codex.map((task) => task.id).sort(), ["english-root", "parent-1"]);
  assert.equal(snapshot.agents.find((agent) => agent.id === "codex").usage.totalTokens, 260);
  assert.equal(snapshot.summary.totalTokens, 360);
  assert.equal(snapshot.agentTrends.codex.reduce((sum, day) => sum + day.totalTokens, 0), 260);
  assert.equal(JSON.stringify(snapshot).includes("不得进入归属正文"), false);
  assert.equal(JSON.stringify(snapshot).includes("正文不应作为标题"), false);
});

test("无父、失联、循环和未来内部来源只留来源用量，过期缓存及索引不得复活内部记录", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rows = [
    { id: "orphan", threadSource: "guardian_review" },
    { id: "missing-parent", threadSource: "subagent", parent: "missing" },
    { id: "cycle-a", threadSource: "subagent", parent: "cycle-b" },
    { id: "cycle-b", threadSource: "subagent", parent: "cycle-a" },
    { id: "future", threadSource: "future_internal_service" },
    { id: "conflicting-parent", threadSource: "subagent", parent: "other-parent", edge: "parent-1" },
    { id: "legacy-prompt", title: "The following is the Codex agent history whose request action you are assessing\n敏感审批正文" },
  ];
  await addCodexIdentityFixtures(root, codexHome, rows);
  const derived = path.join(root, "00_本地工作台/派生数据");
  await fs.mkdir(derived, { recursive: true });
  await fs.writeFile(path.join(derived, "agent-observability-cache.json"), JSON.stringify({ schemaVersion: 15, snapshots: { 7: { updatedAt: new Date().toISOString(), recentTasks: [{ id: "orphan" }] } } }));
  await fs.writeFile(path.join(derived, "agent-observability-index.json"), JSON.stringify({ schemaVersion: 1, tasks: Object.fromEntries([
    ...rows.map((row) => [row.id, { kind: "codex", title: row.title || "旧内部任务" }]),
    ["historic-user", { kind: "codex", title: "历史用户任务\n历史正文" }],
  ]) }));
  const snapshot = await readAgentObservabilityCached(root, { days: 7, nowMs: NOW, codexHome, skipCursorSync: true });
  assert.deepEqual(snapshot.recentTasksByAgent.codex.map((task) => task.id), ["parent-1"]);
  assert.equal(snapshot.codex.unattributedInternalUsage.totalTokens, 70);
  assert.equal(snapshot.codex.unattributedInternalCount, 7);
  assert.equal(snapshot.agents.find((agent) => agent.id === "codex").usage.totalTokens, 270);
  assert.equal(snapshot.summary.totalTokens, 370);
  assert.equal(snapshot.agentTrends.codex.reduce((sum, day) => sum + day.totalTokens, 0), 270);
  const index = JSON.parse(await fs.readFile(path.join(derived, "agent-observability-index.json"), "utf8"));
  for (const { id } of rows) assert.equal(index.tasks[id], undefined);
  assert.equal(index.tasks["historic-user"].title, "历史用户任务");
  const cache = await fs.readFile(path.join(derived, "agent-observability-cache.json"), "utf8");
  assert.equal(cache.includes("敏感审批正文"), false);
  assert.equal(JSON.parse(cache).schemaVersion, 18);
});

test("外部模型 v2 只落稳定 ID 与数值，展示按供应商和模型汇总并去重", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(normalizeExternalUsage({ prompt_tokens: 80, completion_tokens: 20, total_tokens: 100, prompt_tokens_details: { cached_tokens: 30 }, cost: 0.012 }), {
    inputTokens: 80,
    cachedInputTokens: 30,
    outputTokens: 20,
    reasoningTokens: 0,
    totalTokens: 100,
    costUsd: 0.012,
    fieldStatus: {
      inputTokens: "known",
      cachedInputTokens: "known",
      outputTokens: "known",
      reasoningTokens: "unknown",
      totalTokens: "known",
    },
  });
  assert.equal(normalizeExternalUsage({ completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 7 } }).reasoningTokens, 7);
  assert.equal(normalizeExternalUsage({ prompt_tokens: 80, completion_tokens: 20 }).fieldStatus.totalTokens, "known");
  assert.equal(normalizeExternalUsage({ prompt_tokens: 80 }).fieldStatus.totalTokens, "partial");
  assert.equal(normalizeExternalUsage({ completion_tokens: 0 }).fieldStatus.totalTokens, "partial");
  assert.equal(normalizeExternalUsage({ total_tokens: 100 }).fieldStatus.inputTokens, "unknown");
  const event = { at: new Date(NOW).toISOString(), provider: "openrouter", model: "aion-test", surface: "secretary-chat", phase: "ordinary", taskWindowId: "chat-1", generationId: "gen-1", prompt: "不得落盘的正文", usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100, cost: 0.012 } };
  await appendExternalAgentUsage(root, event);
  await appendExternalAgentUsage(root, event);
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  assert.equal(snapshot.summary.totalTokens, 400);
  assert.equal(snapshot.summary.actualExternalCostUsd, 0.012);
  assert.equal(snapshot.agents.find((item) => item.id === "external").usage.totalTokens, 100);
  assert.equal(snapshot.externalDetails.length, 1);
  assert.equal(snapshot.externalDetails[0].taskWindowId, "summary:openrouter:aion-test");
  assert.equal(snapshot.externalDetails[0].requestCount, 1);
  assert.equal(snapshot.agentTrends.external.reduce((sum, day) => sum + day.totalTokens, 0), 100);
  assert.equal(snapshot.tasks.some((item) => item.kind === "external"), false);
  assert.doesNotMatch(await fs.readFile(path.join(root, "00_本地工作台/派生数据/agent-observability-external.jsonl"), "utf8"), /不得落盘的正文/u);
});

test("OpenRouter 当前密钥累计与本地分请求账分开对账", () => {
  const snapshot = {
    externalAccount: { attributedCostUsd: 0.215584, requestCount: 7 },
    agents: [{ id: "external", note: "旧说明" }, { id: "codex", note: "保持" }],
  };
  const reconciled = reconcileExternalAccount(snapshot, { usageUsd: 2.215584, checkedAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(reconciled.externalAccount.usageUsd, 2.215584);
  assert.equal(reconciled.externalAccount.attributedCostUsd, 0.215584);
  assert.equal(reconciled.externalAccount.unattributedCostUsd, 2);
  assert.equal(reconciled.externalAccount.requestCount, 7);
  assert.match(reconciled.externalAccount.note, /接入前.*汇总金额/u);
  assert.match(reconciled.agents[0].note, /\$2\.215584/u);
  assert.equal(reconciled.agents[1].note, "保持");
});

test("功能归属只接受功能树里的稳定 ID", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeAgentObservabilityLink(root, { taskId: "parent-1", featureIds: ["tools-agent-observability"] });
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const feature = snapshot.features.find((item) => item.id === "tools-agent-observability");
  assert.equal(snapshot.tasks.find((item) => item.id === "parent-1").title, "小秘书密码管理功能整理");
  assert.equal(feature.taskCount, 1);
  assert.equal(feature.usage.totalTokens, 200);
  await assert.rejects(() => writeAgentObservabilityLink(root, { taskId: "parent-1", featureIds: ["invented-feature"] }), /TASK_LINK_FEATURE_INVALID/u);
});

test("任务链可自动归到多个 Wiki，并按证据给出合计 100% 的比例", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "智能体观测与产品功能 Wiki 树" })}\n`);
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const task = snapshot.tasks.find((item) => item.id === "parent-1");
  assert.equal(task.title, "智能体观测与产品功能 Wiki 树");
  assert.deepEqual(task.featureMatches.map((item) => item.id).sort(), ["projects-feature-tree", "tools-agent-observability"]);
  assert.equal(task.featureMatches.reduce((sum, item) => sum + item.relevance, 0), 100);
});

test("首条需求与任务摘要只用于归属，不把原文带进账册", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.prepare("UPDATE threads SET first_user_message = ?, preview = ? WHERE id = ?").run("完善智能体观测的任务分类", "任务摘要：补上 tools-agent-observability 的归属索引", "parent-1");
  db.close();
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const task = snapshot.tasks.find((item) => item.id === "parent-1");
  assert.deepEqual(task.featureMatches.map((item) => item.id), ["tools-agent-observability"]);
  assert.equal(task.featureMatches[0].basis, "semantic");
  assert.ok(task.attributionEvidence.includes("first-user-message"));
  assert.ok(task.attributionEvidence.includes("preview"));
  assert.doesNotMatch(JSON.stringify(snapshot), /完善智能体观测的任务分类|补上 tools-agent-observability 的归属索引/u);
});

test("可读窗口标题用稳定别名归到现有功能，而不是堆进未归属", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "相册下载与全屏预览修复" })}\n`);
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const task = snapshot.tasks.find((item) => item.id === "parent-1");
  assert.equal(task.title, "相册下载与全屏预览修复");
  assert.deepEqual(task.featureMatches.map((item) => item.id), ["tools-photo"]);
  assert.equal(snapshot.features.find((item) => item.id === "tools-photo").usage.totalTokens, 200);
});

test("跨模块小秘书任务只确认到项目时进入持续迭代收纳项", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.prepare("UPDATE threads SET cwd = ?, project_id = NULL, first_user_message = ?, preview = ? WHERE id = ?").run("/tmp/unregistered", "建立事项治理与人工审核队列", "小秘书跨模块事项治理", "parent-1");
  db.close();
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "小秘书事项治理与审核队列" })}\n`);
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const task = snapshot.tasks.find((item) => item.id === "parent-1");
  assert.deepEqual(task.projectMatches.map((item) => item.projectId), ["infans-ai-system"]);
  assert.equal(task.featureMatches.length, 0);
  assert.equal(snapshot.features.find((item) => item.id === "project-unresolved:infans-ai-system:iteration").usage.totalTokens, 200);
});

test("未归属、项目探索与系统测试统一收进其他", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.prepare("UPDATE threads SET cwd = ?, project_id = NULL").run("/tmp/unregistered");
  db.prepare("UPDATE threads SET first_user_message = ?, preview = ? WHERE id = ?").run("制作炉石修仙网页版 Demo", "评估核心循环", "parent-1");
  db.close();
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "制作炉石修仙网页版 Demo" })}\n`);
  const exploration = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const explorationBucket = exploration.features.find((item) => item.id === "other:project-exploration");
  assert.ok(explorationBucket, JSON.stringify({ tasks: exploration.tasks, features: exploration.features }, null, 2));
  assert.equal(explorationBucket.usage.totalTokens, 200);
  assert.deepEqual(exploration.tasks.find((item) => item.id === "parent-1").projectMatches.map((item) => item.projectName), ["其他"]);
  assert.equal(explorationBucket.projectId, "other");

  const secondDb = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  secondDb.prepare("UPDATE threads SET first_user_message = ?, preview = ? WHERE id = ?").run("只回复 INITIALIZED", "隔离烟雾测试", "parent-1");
  secondDb.close();
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "隔离烟雾测试" })}\n`);
  const systemTest = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const systemTestBucket = systemTest.features.find((item) => item.id === "other:system-test");
  assert.ok(systemTestBucket, JSON.stringify({ tasks: systemTest.tasks, features: systemTest.features }, null, 2));
  assert.equal(systemTestBucket.usage.totalTokens, 200);
  assert.equal(systemTestBucket.projectId, "other");

  const thirdDb = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  thirdDb.prepare("UPDATE threads SET first_user_message = ?, preview = ? WHERE id = ?").run("整理一批零散内容", "暂无项目线索", "parent-1");
  thirdDb.close();
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "整理零散内容" })}\n`);
  const unlinked = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const unlinkedBucket = unlinked.features.find((item) => item.id === "other:unlinked");
  assert.equal(unlinkedBucket.usage.totalTokens, 200);
  assert.equal(unlinkedBucket.projectName, "其他");
});

test("源任务窗口名用于识别，项目层消耗拆成首次搭建与持续迭代", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.prepare("UPDATE threads SET first_user_message = ?, preview = ? WHERE id = ?").run("从零搭建项目", "跑通第一版 Demo", "parent-1");
  db.close();
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "小秘书首次搭建 Demo" })}\n`);
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const task = snapshot.tasks.find((item) => item.id === "parent-1");
  assert.equal(task.title, "小秘书首次搭建 Demo");
  assert.equal(task.reference, "ARENT1");
  assert.equal(task.projectPhase, "setup");
  assert.equal(task.featureMatches.length, 0);
  const setup = snapshot.features.find((item) => item.id === "project-unresolved:infans-ai-system:setup");
  assert.equal(setup.name, "项目首次搭建");
  assert.equal(setup.usage.totalTokens, 200);
});

test("已确认的项目阶段覆盖关键词判断并能独立保存", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.prepare("UPDATE threads SET first_user_message = ?, preview = ? WHERE id = ?").run("持续迭代一批体验", "优化现有项目", "parent-1");
  db.close();
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "小秘书全面升级" })}\n`);
  const link = await writeAgentObservabilityLink(root, { taskId: "parent-1", featureIds: [], projectPhase: "setup" });
  assert.equal(link.projectPhase, "setup");
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const task = snapshot.tasks.find((item) => item.id === "parent-1");
  assert.equal(task.projectPhase, "setup");
  assert.equal(snapshot.features.find((item) => item.id === "project-unresolved:infans-ai-system:setup").usage.totalTokens, 200);
  await assert.rejects(() => writeAgentObservabilityLink(root, { taskId: "parent-1", projectPhase: "launch" }), /TASK_LINK_PHASE_INVALID/u);
});

test("Cursor 定时任务按稳定角色直接归属功能", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome });
  const task = snapshot.tasks.find((item) => item.kind === "cursor");
  assert.equal(task.title, "版本收口");
  assert.equal(task.usageMode, "this-run");
  assert.equal(task.hasChildren, false);
  assert.deepEqual(task.featureIds, ["automation-daily-release"]);
  assert.equal(task.featureMatches[0].basis, "role");
});

test("整张账册写入派生缓存，二次进入无需重新扫描", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fresh = await readAgentObservabilityCached(root, { days: 7, force: true, codexHome, skipCursorSync: true });
  const cacheFile = JSON.parse(await fs.readFile(path.join(root, "00_本地工作台/派生数据/agent-observability-cache.json"), "utf8"));
  assert.equal(cacheFile.schemaVersion, 18);
  const index = JSON.parse(await fs.readFile(path.join(root, "00_本地工作台/派生数据/agent-observability-index.json"), "utf8"));
  assert.equal(index.tasks["parent-1"].title, fresh.tasks.find((item) => item.id === "parent-1").title);
  assert.equal(index.tasks["parent-1"].reference, "ARENT1");
  await fs.rm(path.join(codexHome, "state_5.sqlite"));
  const cached = await readAgentObservabilityCached(root, { days: 7, codexHome, skipCursorSync: true });
  assert.equal(cached.updatedAt, fresh.updatedAt);
  assert.equal(cached.summary.totalTokens, 300);
});

test("已核实的功能关联立即更新 Wiki 索引并使账册缓存失效", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await readAgentObservabilityCached(root, { days: 7, force: true, codexHome, skipCursorSync: true });
  await writeAgentObservabilityLink(root, { taskId: "parent-1", featureIds: ["tools-agent-observability", "projects-feature-tree"] });
  const index = JSON.parse(await fs.readFile(path.join(root, "00_本地工作台/派生数据/agent-observability-index.json"), "utf8"));
  const cache = JSON.parse(await fs.readFile(path.join(root, "00_本地工作台/派生数据/agent-observability-cache.json"), "utf8"));
  assert.deepEqual(index.tasks["parent-1"].featureMatches.map((item) => item.id), ["tools-agent-observability", "projects-feature-tree"]);
  assert.ok(index.tasks["parent-1"].featureMatches.every((item) => item.basis === "verified"));
  assert.ok(index.tasks["parent-1"].featureMatches.every((item) => item.relevance === 50));
  assert.ok(Date.parse(cache.invalidatedAt) >= Date.parse(index.updatedAt));
});

test("过期缓存立即返回，慢对账只在后台做，重复刷新合并且旧外部数字不因失败消失", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = await readAgentObservability(root, { days: 7, codexHome, skipCursorSync: true });
  old.updatedAt = "2020-01-01T00:00:00.000Z";
  const cachePath = path.join(root, "00_本地工作台/派生数据/agent-observability-cache.json");
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify({ schemaVersion: 18, snapshots: { 7: old } }));
  let release;
  let probes = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const readExternalStatus = async () => { probes += 1; await gate; return { usageUsd: 2, checkedAt: new Date().toISOString() }; };
  const options = { days: 7, codexHome, skipCursorSync: true, readExternalStatus };
  const cached = await readAgentObservabilityCached(root, options);
  assert.equal(cached.updatedAt, old.updatedAt);
  assert.equal(cached.cacheStatus, "refreshing");
  const second = await readAgentObservabilityCached(root, options);
  assert.equal(second.summary.totalTokens, old.summary.totalTokens);
  const joined = readAgentObservabilityCached(root, { ...options, force: true });
  release();
  const fresh = await joined;
  assert.equal(probes, 1);
  assert.equal(fresh.cacheStatus, "fresh");
  assert.equal(fresh.externalAccount.usageUsd, 2);
  const failedProbe = await readAgentObservabilityCached(root, { ...options, force: true, readExternalStatus: async () => { throw new Error("offline"); } });
  assert.equal(failedProbe.externalAccount.usageUsd, 2);
  assert.equal(failedProbe.externalAccount.checkedAt, fresh.externalAccount.checkedAt);
});

test("新增用量只标记缓存过期，并发周期缓存不互相覆盖", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { codexHome, skipCursorSync: true, force: true };
  const [seven, three] = await Promise.all([
    readAgentObservabilityCached(root, { ...options, days: 7 }),
    readAgentObservabilityCached(root, { ...options, days: 3 }),
  ]);
  await appendExternalAgentUsage(root, { at: new Date().toISOString(), provider: "openrouter", model: "fixture", generationId: "cache-new-event", usage: { total_tokens: 10 } });
  const cache = JSON.parse(await fs.readFile(path.join(root, "00_本地工作台/派生数据/agent-observability-cache.json"), "utf8"));
  assert.equal(cache.snapshots[7].updatedAt, seven.updatedAt);
  assert.equal(cache.snapshots[3].updatedAt, three.updatedAt);
  assert.ok(cache.invalidatedAt);
  const cached = await readAgentObservabilityCached(root, { days: 7, codexHome, skipCursorSync: true });
  assert.equal(cached.summary.totalTokens, seven.summary.totalTokens);
  const refreshed = await readAgentObservabilityCached(root, { ...options, days: 7 });
  assert.equal(refreshed.summary.totalTokens, seven.summary.totalTokens + 10);
});

test("Cursor 调度账本按 runId 去重，账户 CSV 不混进总 Token", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const derived = path.join(root, "00_本地工作台/派生数据");
  await fs.mkdir(derived, { recursive: true });
  await fs.writeFile(path.join(derived, "agent-observability-cursor-batches.jsonl"), `${JSON.stringify({
    schemaVersion: 1,
    bucket: "scheduled-batch",
    source: "cursor-headless-json",
    runId: "daily-1",
    roleId: "workbench-daily-release",
    model: "cursor-test",
    startedAt: "2026-09-01T02:00:00+09:00",
    finishedAt: "2026-09-01T02:03:00+09:00",
    usage: { inputTokens: 80, freshInputTokens: 45, cacheReadTokens: 30, cacheWriteTokens: 5, outputTokens: 20, totalTokens: 100 },
  })}\n${JSON.stringify({
    schemaVersion: 1,
    bucket: "scheduled-batch",
    source: "cursor-headless-json",
    runId: "probe-only",
    roleId: "cursor-usage-probe",
    model: "cursor-grok-4.6-high",
    startedAt: "2026-09-01T03:00:00+09:00",
    finishedAt: "2026-09-01T03:00:20+09:00",
    usage: { inputTokens: 40, freshInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 10, outputTokens: 5, totalTokens: 45 },
  })}\n`);
  const parsed = parseCursorUsageCsv(`Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost,User
2026-08-31T12:00:00+09:00,Included,grok-4.6,100,50,20,10,180,Included,someone@example.com
`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].usage.totalTokens, 180);
  assert.equal(parsed[0].usage.inputTokens, 170);
  assert.doesNotMatch(JSON.stringify(parsed), /someone@example.com/u);
  await importCursorAccountCsv(root, `Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens
2026-08-31T12:00:00+09:00,Included,grok-4.6,100,50,20,10,180
`);
  await importCursorAccountCsv(root, `Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens
2026-08-31T12:00:00+09:00,Included,grok-4.6,100,50,20,10,180
`);
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome, skipCursorSync: true });
  assert.equal(snapshot.tasks.filter((item) => item.id === "cursor:daily-1").length, 1);
  assert.equal(snapshot.tasks.find((item) => item.id === "cursor:probe-only")?.totalUsage.totalTokens, 45);
  // Cursor 权威来源取账户 180，不再把调度 CLI 100+45 加进总量：200(Codex)+180(账户)=380
  assert.equal(snapshot.summary.totalTokens, 380);
  assert.equal(snapshot.agents.find((item) => item.id === "cursor").usage.totalTokens, 180);
  assert.equal(snapshot.agents.find((item) => item.id === "cursor").sourceQuality, "account-history");
  assert.equal(snapshot.agents.find((item) => item.id === "cursor").eventCount, 1);
  // fixture 自带 daily-1 与 brief-old，本例再写入 probe-only；daily-1 去重后共 3 个调度运行
  assert.equal(snapshot.agents.find((item) => item.id === "cursor").runCount, 3);
  assert.match(snapshot.agents.find((item) => item.id === "cursor").note, /账户 Usage|归属覆盖率/u);
  assert.equal(snapshot.cursorAccount.eventCount, 1);
  assert.equal(snapshot.cursorAccount.usage.totalTokens, 180);
  assert.equal(snapshot.tasks.filter((item) => String(item.id).startsWith("cursor-account:")).length, 0);
  assert.equal(snapshot.summary.taskChainCount, snapshot.tasks.filter((item) => item.kind !== "external").length);
  assert.equal(snapshot.summary.cursorEventCount, 1);
  assert.equal(snapshot.agentTrends.all.reduce((sum, day) => sum + day.totalTokens, 0), 380);
  assert.equal(
    snapshot.agents.reduce((sum, agent) => sum + (agent.usage?.totalTokens || 0), 0),
    snapshot.summary.totalTokens,
  );
  assert.ok(snapshot.features.every((item) => !String(item.id).startsWith("cursor-account:")));
  assert.match(snapshot.cursorAccount.note, /来源总账|模型／日明细|不把日／模型聚合伪装成任务/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /someone@example.com/u);
});

test("Cursor 账户日／模型聚合不进战报，缺失字段保持未提供", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await importCursorAccountCsv(root, `Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens
2026-08-31T12:00:00+09:00,Included,grok-4.6,100,50,20,10,180
`);
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome, skipCursorSync: true });
  assert.equal(snapshot.tasks.filter((item) => /cursor-account:|cursor-grok|用量 /.test(String(item.title || "") + String(item.id || ""))).length, 0);
  assert.equal(snapshot.cursorAccount.details.length, 1);
  assert.equal(snapshot.cursorAccount.details[0].eventCount, 1);
  assert.equal(snapshot.cursorAccount.chargedCents, null);
  assert.equal(snapshot.summary.cursorChargedCents, null);
  assert.equal(snapshot.summary.cursorAttributionCoverage, 0);
  const cursorRun = snapshot.tasks.find((item) => item.id.startsWith("cursor:"));
  assert.equal(cursorRun.usageMode, "this-run");
  assert.equal(cursorRun.childCount, 0);
  assert.equal(cursorRun.hasChildren, false);
  assert.equal(cursorRun.countsTowardSourceTotal, false);
});

test("Cursor Usage 事件转成账户 CSV 时只保留数值、模型和时间", () => {
  const converted = cursorAccountCsvFromEvents([
    {
      timestamp: Date.parse("2026-08-15T12:00:00+09:00"),
      model: "grok-4.6-high",
      kind: "Included",
      tokenUsage: { inputTokens: 50, cacheReadTokens: 20, outputTokens: 10 },
    },
    { timestamp: Date.parse("2026-08-16T12:00:00+09:00"), model: "empty", tokenUsage: {} },
  ]);
  assert.equal(converted.eventCount, 1);
  assert.equal(converted.skipped, 1);
  const parsed = parseCursorUsageCsv(converted.csv);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].usage.totalTokens, 80);
  assert.equal(parsed[0].usage.inputTokens, 70);
  assert.equal(parsed[0].usage.cachedInputTokens, 20);
  assert.doesNotMatch(converted.csv, /@/u);
});

test("能从对话摘要抽出中文窗口名，并补进账户会话战报", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(deriveCursorWindowTitle("<user_query>让anki今天的打卡记录施加翻五倍吧</user_query>"), "让anki今天的打卡记录施加翻五");
  assert.equal(deriveCursorWindowTitle("<user_query>补齐 Cursor 对话标题</user_query>"), "补齐Cursor对话标题");
  assert.equal(isWeakCursorWindowTitle("JLPT N2 quality inspection"), true);
  assert.equal(isWeakCursorWindowTitle("Anki时长放大6倍"), false);

  const conversationId = "11111111-2222-4333-8444-555555555555";
  const home = path.join(root, "fake-home");
  const transcriptDir = path.join(home, ".cursor", "projects", "demo", "agent-transcripts", conversationId);
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(path.join(transcriptDir, `${conversationId}.jsonl`), `${JSON.stringify({
    role: "user",
    message: { content: [{ type: "text", text: "<user_query>帮我把智能体观测的 Cursor 标题补齐</user_query>" }] },
  })}\n`);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const derived = path.join(root, "00_本地工作台/派生数据");
  await fs.mkdir(derived, { recursive: true });
  await fs.writeFile(path.join(derived, "agent-observability-cursor-account.jsonl"), `${JSON.stringify({
    schemaVersion: 2,
    at: "2026-08-31T12:00:00+09:00",
    conversationId,
    model: "grok-4.6",
    kind: "Included",
    usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 0, totalTokens: 130 },
  })}\n`);

  const titles = await resolveCursorConversationTitles(root, [conversationId]);
  assert.match(titles.get(conversationId), /智能体观测|Cursor 标题|标题补齐/u);
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome, skipCursorSync: true });
  const task = snapshot.tasks.find((item) => item.id === `cursor-conversation:${conversationId}`);
  assert.ok(task);
  assert.match(task.title, /智能体观测|Cursor 标题|标题补齐/u);
  assert.ok(snapshot.summary.cursorAttributionCoverage > 0);
});

test("旧 CSV 与本机会话账按指纹去重，本机会话优先", () => {
  assert.ok(cursorAccountSourcePriority("cursor-local-session") > cursorAccountSourcePriority("cursor-dashboard-csv"));
  const csv = {
    source: "cursor-dashboard-csv",
    at: "2026-08-31T12:00:00.100Z",
    model: "cursor-grok-4.6-high",
    usage: { inputTokens: 170, outputTokens: 10, totalTokens: 180 },
  };
  const local = {
    source: "cursor-local-session",
    at: "2026-08-31T12:00:00.900Z",
    model: "cursor-grok-4.6-high",
    conversationId: "conv-1",
    chargedCents: 12.5,
    usage: { inputTokens: 170, outputTokens: 10, totalTokens: 180, reasoningTokens: null },
  };
  assert.equal(cursorAccountOverlapFingerprint(csv), cursorAccountOverlapFingerprint(local));
  const deduped = dedupeCursorAccountRows([csv, local, {
    source: "cursor-dashboard-csv",
    at: "2026-08-30T08:00:00.000Z",
    model: "cursor-grok-4.6-high",
    usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
  }]);
  assert.equal(deduped.suppressedDuplicateCount, 1);
  assert.equal(deduped.eventCountAfter, 2);
  assert.equal(deduped.rows.filter((row) => row.source === "cursor-local-session").length, 1);
  assert.equal(deduped.rows.reduce((sum, row) => sum + row.usage.totalTokens, 0), 235);
});

test("同一采集器同秒同模型同用量的两次真实调用不被折叠", () => {
  const rows = ["event-a", "event-b"].map((eventId) => ({
    eventId,
    source: "cursor-local-session",
    conversationId: "conversation-a",
    at: "2026-08-30T08:00:00.000Z",
    model: "cursor-test",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  }));
  const result = dedupeCursorAccountRows(rows);
  assert.equal(result.eventCountAfter, 2);
  assert.equal(result.suppressedDuplicateCount, 0);
});

test("个人生活运营只接生活事务，开发语境和既有项目词不误收", () => {
  assert.equal(personalLifeFeatureId("帮我购买只狼电影票"), "personal-life-travel");
  assert.equal(personalLifeFeatureId("比较商品后帮我买东西"), "personal-life-shopping");
  assert.equal(personalLifeFeatureId("修复购买按钮的 React 组件"), null);
  assert.equal(personalLifeFeatureId("检查小秘书页面的预约功能"), null);
});

test("历史生活任务回填不改变总量，明确产品开发证据优先", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "购买电影票" })}\n`);
  const before = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome, skipCursorSync: true });
  assert.equal(before.tasks.find((item) => item.id === "parent-1").projectMatches[0].projectId, "personal-life-operations");
  assert.equal(before.features.find((item) => item.id === "personal-life-travel").usage.totalTokens, 200);
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.prepare("UPDATE threads SET first_user_message = ? WHERE id = ?").run("看看这份建议，先讨论再施工", "parent-1");
  db.close();
  await fs.appendFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "parent-1", thread_name: "Token账本／个人生活运营与值班统计" })}\n`);
  const after = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome, skipCursorSync: true });
  assert.equal(after.summary.totalTokens, before.summary.totalTokens);
  assert.equal(after.tasks.find((item) => item.id === "parent-1").projectMatches.some((item) => item.projectId === "personal-life-operations"), false);
});

test("Codex 心跳按真实回合分组，手动回合不混入，累计快照重复不双算", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const automationDir = path.join(codexHome, "automations/fixture-heartbeat");
  await fs.mkdir(automationDir, { recursive: true });
  await fs.writeFile(path.join(automationDir, "automation.toml"), 'id = "fixture-heartbeat"\nkind = "heartbeat"\nname = "测试值班"\nstatus = "ACTIVE"\ntarget_thread_id = "parent-1"\n');
  const row = (type, payload, second) => JSON.stringify({ timestamp: `2026-08-31T18:20:${String(second).padStart(2, "0")}.000Z`, type, payload });
  const tokens = (total, last, second) => row("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: last - 2, output_tokens: 2, total_tokens: last } } }, second);
  await fs.appendFile(path.join(codexHome, "sessions/parent.jsonl"), [
    row("event_msg", { type: "task_started", turn_id: "turn-heartbeat" }, 0),
    row("turn_context", { turn_id: "turn-heartbeat", model: "actual-model" }, 1),
    row("response_item", { type: "function_call_output", name: "automation_update", output: "<heartbeat><automation_id>fixture-heartbeat</automation_id><instructions>不可落盘的私密指令</instructions></heartbeat>" }, 2),
    tokens(150, 20, 3), tokens(150, 20, 4), tokens(170, 20, 5),
    row("event_msg", { type: "task_complete", turn_id: "turn-heartbeat" }, 6),
    row("event_msg", { type: "task_started", turn_id: "turn-manual" }, 7),
    tokens(175, 5, 8),
    row("event_msg", { type: "task_complete", turn_id: "turn-manual" }, 9),
  ].join("\n") + "\n");
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome, skipCursorSync: true });
  const codexRuns = snapshot.scheduledRuns.runs.filter((run) => run.agent === "Codex");
  assert.equal(codexRuns.length, 1);
  assert.equal(codexRuns[0].usage.totalTokens, 40);
  assert.equal(codexRuns[0].model, "actual-model");
  assert.equal(codexRuns[0].trigger, "codex-heartbeat");
  assert.equal(snapshot.summary.totalTokens, 345);
  assert.equal(JSON.stringify(snapshot).includes("不可落盘的私密指令"), false);
});

test("CSV 与本机会话重复导入后总量不双算，计价不作实付，推理按来源加总", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await importCursorAccountCsv(root, `Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens
2026-08-31T12:00:00.000Z,Included,cursor-grok-4.6-high,100,50,20,10,180
`);
  await importCursorAccountEvents(root, [{
    timestamp: Date.parse("2026-08-31T12:00:00.000Z"),
    model: "cursor-grok-4.6-high",
    kind: "USAGE_EVENT_KIND_INCLUDED_IN_ULTRA",
    conversationId: "dup-conversation",
    chargedCents: 88,
    tokenUsage: { inputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 100, outputTokens: 10, totalTokens: 180 },
  }], { source: "cursor-local-session" });
  const snapshot = await readAgentObservability(root, { days: 7, nowMs: NOW, codexHome, skipCursorSync: true });
  assert.equal(snapshot.cursorAccount.eventCount, 1);
  assert.equal(snapshot.cursorAccount.rawEventCount, 2);
  assert.equal(snapshot.cursorAccount.suppressedDuplicateCount, 1);
  assert.equal(snapshot.agents.find((item) => item.id === "cursor").usage.totalTokens, 180);
  // Codex fixture 200 + Cursor 180，没有把 CSV 再加一遍
  assert.equal(snapshot.summary.totalTokens, 380);
  assert.equal(snapshot.summary.cursorChargedCentsMeaning, "vendor-pricing-unverified");
  assert.equal(snapshot.agents.find((item) => item.id === "cursor").chargedCentsMeaning, "vendor-pricing-unverified");
  assert.equal(snapshot.summary.reasoningTokensStatus, "partial");
  assert.match(JSON.stringify(snapshot.notes), /未核实|不得写成实付|账户计价|按来源加总/u);
  assert.doesNotMatch(JSON.stringify(snapshot.notes), /Cursor 实付只采用/u);
});

test("24 小时按滚动窗口收录调度，3 天按东京日历日", async (t) => {
  const { root, codexHome } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldDir = path.join(root, "00_本地工作台/30_证据/AI定时任务运行包/world-brief");
  await fs.mkdir(oldDir, { recursive: true });
  await fs.writeFile(path.join(oldDir, "old.md"), `---
runId: "world-old"
roleId: "world-brief"
adapter: "cursor-cli"
model: "cursor-test"
startedAt: "2026-08-30T20:00:00+09:00"
processState: exited
finishedAt: "2026-08-30T20:10:00+09:00"
exitCode: 0
usageSource: "cursor-headless-json"
inputTokens: 40
cacheReadTokens: 10
outputTokens: 10
totalTokens: 50
---
`);
  const rolling = await readAgentObservability(root, { hours: 24, nowMs: NOW, codexHome });
  assert.equal(rolling.periodHours, 24);
  assert.equal(rolling.trend.length, 2);
  assert.equal(rolling.scheduledRuns.runCount, 2);
  assert.equal(rolling.scheduledRuns.runs.some((item) => item.roleId === "world-brief"), false);
  const threeDays = await readAgentObservability(root, { days: 3, nowMs: NOW, codexHome });
  assert.equal(threeDays.periodDays, 3);
  assert.equal(threeDays.periodHours, null);
  assert.equal(threeDays.scheduledRuns.runCount, 3);
  assert.equal(threeDays.scheduledRuns.runs.some((item) => item.roleId === "world-brief"), true);
});
