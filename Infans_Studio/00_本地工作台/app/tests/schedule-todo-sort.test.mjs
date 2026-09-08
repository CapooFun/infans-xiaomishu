import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildCurrentExecutionRows,
  buildAiExecutionRows,
  effectiveTaskQuadrant,
  groupWeekTodosByQuadrant,
  isTodoInNextTwoTokyoDays,
  parseQuadrant,
  stripQuadrantMarkers,
} from "../src/schedule-todo-model.ts";
import { stripTaskDecorators } from "../src/gantt-model.ts";

test("parseQuadrant reads Chinese names and SABC letter tags", () => {
  assert.equal(parseQuadrant("象限：重要且紧急 · 买票")?.id, "S");
  assert.equal(parseQuadrant("象限：A 计划做")?.id, "A");
  assert.equal(parseQuadrant("公司：截止：S：8/6 · 买票")?.id, "S");
  assert.equal(parseQuadrant("专题：节点：B：杂事")?.id, "B");
  assert.equal(parseQuadrant("生活：节点：C：回消息")?.id, "C");
  assert.equal(parseQuadrant("没有象限")?.id, undefined);
});

test("stripQuadrantMarkers and stripTaskDecorators hide SABC tags", () => {
  assert.equal(stripQuadrantMarkers("公司：截止：S：8/6 · 买票"), "公司：截止：8/6 · 买票");
  assert.equal(stripTaskDecorators("公司：截止：S：8/6 · 买东京游戏地牢13门票"), "买东京游戏地牢13门票");
  assert.equal(stripTaskDecorators("日语：常驻：A：每天盯 JLPT 真题逐场精校"), "每天盯 JLPT 真题逐场精校");
});

test("near-term todo fallback keeps overdue items and tomorrow, but not later work", () => {
  assert.equal(isTodoInNextTwoTokyoDays("公司：截止：8/20 · 今天完成", "2026-08-20"), true);
  assert.equal(isTodoInNextTwoTokyoDays("公司：截止：8/21 · 明天完成", "2026-08-20"), true);
  assert.equal(isTodoInNextTwoTokyoDays("公司：区间：8/19–8/21 持续任务", "2026-08-20"), true);
  assert.equal(isTodoInNextTwoTokyoDays("公司：截止：8/22 · 后天再做", "2026-08-20"), false);
  assert.equal(isTodoInNextTwoTokyoDays("公司：截止：8/19 · 已过期", "2026-08-20"), true);
  assert.equal(isTodoInNextTwoTokyoDays("治理：节点：B：待排 · 无日期", "2026-08-20"), false);
});

test("groupWeekTodosByQuadrant lays out S A / B C and sorts each level by date; cadence sinks", () => {
  const groups = groupWeekTodosByQuadrant([
    {
      id: "a-later",
      source: "vault",
      text: "专题：节点：A：陪学",
      displayText: "陪学",
      kind: "milestone",
      date: { start: "2026-08-07", end: "2026-08-07", label: "8/7" },
      quadrant: "A",
    },
    {
      id: "a-same-time-keeps-source-order",
      source: "vault",
      text: "专题：节点：A：同时间保持原序",
      displayText: "同时间保持原序",
      kind: "milestone",
      date: { start: "2026-08-07", end: "2026-08-07", label: "8/7" },
      quadrant: "A",
    },
    {
      id: "a-overdue",
      source: "vault",
      text: "专题：节点：A：先处理逾期事项",
      displayText: "先处理逾期事项",
      kind: "milestone",
      date: { start: "2026-08-05", end: "2026-08-05", label: "8/5" },
      quadrant: "A",
    },
    {
      id: "a-long-range",
      source: "vault",
      text: "专题：区间：A：持续任务",
      displayText: "持续任务",
      kind: "range",
      date: { start: "2026-08-06", end: "2026-08-08", label: "8/6–8/8" },
      quadrant: "A",
    },
    {
      id: "a-short-range",
      source: "vault",
      text: "专题：区间：A：先结束的任务",
      displayText: "先结束的任务",
      kind: "range",
      date: { start: "2026-08-06", end: "2026-08-07", label: "8/6–8/7" },
      quadrant: "A",
    },
    {
      id: "a-undated",
      source: "vault",
      text: "专题：节点：A：未排期事项",
      displayText: "未排期事项",
      kind: "milestone",
      quadrant: "A",
    },
    {
      id: "cadence",
      source: "vault",
      text: "日语：常驻：A：每天盯",
      displayText: "每天盯",
      kind: "cadence",
      quadrant: "A",
    },
    {
      id: "r2",
      source: "reminder",
      text: "卖掉纳指",
      displayText: "卖掉纳指",
      kind: null,
      sortAt: "2026-08-06T10:25:00+09:00",
      quadrant: "S",
    },
    {
      id: "r1",
      source: "reminder",
      text: "买票提醒",
      displayText: "买票提醒",
      kind: null,
      sortAt: "2026-08-06T10:00:00+09:00",
      quadrant: "S",
    },
    {
      id: "b1",
      source: "vault",
      text: "生活：节点：B：回个不急的消息",
      displayText: "回个不急的消息",
      kind: "milestone",
      quadrant: "B",
    },
  ]);
  assert.deepEqual(groups.map((group) => group.id), ["S", "A", "B", "C"]);
  assert.deepEqual(groups.map((group) => group.label), ["重要且紧急", "重要不紧急", "紧急不重要", "不重要且不紧急"]);
  assert.deepEqual(groups[0].items.map((item) => item.id), ["r1", "r2"]);
  assert.deepEqual(groups[1].items.map((item) => item.id), ["a-overdue", "a-short-range", "a-long-range", "a-later", "a-same-time-keeps-source-order", "a-undated", "cadence"]);
  assert.equal(groups[2].items[0]?.id, "b1");
  assert.deepEqual(groups[3].items, []);
});

test("current execution rows default ordinary tasks to C and promote overdue A/C", () => {
  const base = {
    section: "doing",
    date: { start: "2026-08-20", end: "2026-08-20", label: "8/20" },
    parentId: null,
    dependencyIds: [],
    sourcePath: "30_事业顺利/示例卡牌游戏/项目进度与待办.md",
    sourceKind: "project",
    projectId: "nointerest",
    projectName: "示例卡牌游戏",
  };
  const rows = buildCurrentExecutionRows([
    { ...base, id: "picked-today", done: false, priority: "S", text: "游戏：细节：S：8/20 · 今天执行｜ID：picked-today", displayText: "今天执行" },
    { ...base, date: { start: "2026-08-01", end: "2026-08-01", label: "8/1" }, id: "overdue-unpicked", done: false, priority: null, text: "游戏：细节：8/1 · 已过期但未挑选｜ID：overdue-unpicked", displayText: "已过期但未挑选" },
    { ...base, id: "unbound-ai-label", done: false, priority: null, executorId: null, text: "游戏：细节：8/20 · AI· 还没有执行器｜ID：unbound-ai-label", displayText: "AI· 还没有执行器" },
    { ...base, id: "executor-only-ai", done: false, priority: null, executorId: "codex-ai-acceptance", automationMode: "manual", automationContractStatus: "none", text: "游戏：细节：8/20 · AI· 仍需人工派发｜ID：executor-only-ai｜执行器：codex-ai-acceptance", displayText: "AI· 仍需人工派发" },
    { ...base, id: "automatic-ai", done: false, priority: null, executorId: "codex-ai-acceptance", automationMode: "automatic", automationContractStatus: "valid", text: "游戏：细节：8/20 · AI· 自动执行｜ID：automatic-ai｜执行器：codex-ai-acceptance", displayText: "AI· 自动执行" },
    { ...base, id: "done-picked", done: true, priority: "A", text: "游戏：细节：A：已完成｜ID：done-picked", displayText: "已完成" },
  ], "2026-08-20");
  assert.deepEqual(rows.map((row) => row.id), [`picked-today:${base.sourcePath}:0`, `overdue-unpicked:${base.sourcePath}:1`, `unbound-ai-label:${base.sourcePath}:2`, `executor-only-ai:${base.sourcePath}:3`]);
  assert.equal(rows[0]?.quadrant, "S");
  assert.equal(rows[1]?.baselineQuadrant, "C");
  assert.equal(rows[1]?.quadrant, "B");
  assert.equal(rows[1]?.overduePromotion, "C→B");
  assert.equal(rows[0]?.projectName, "示例卡牌游戏");
  assert.equal(rows[0]?.displayText.includes("ID"), false);
  assert.equal(rows[2]?.quadrant, "C");
  assert.equal(effectiveTaskQuadrant({ done: false, priority: "A", date: { start: "2026-08-01", end: "2026-08-01", label: "8/1" } }, "2026-08-20"), "S");
});

test("AI execution rows stay outside SABC and remain read-only for the user", () => {
  const base = {
    section: "next",
    date: { start: "2026-08-21", end: "2026-08-21", label: "8/21" },
    parentId: null,
    dependencyIds: [],
    sourcePath: "30_事业顺利/小秘书/项目进度与待办.md",
    sourceKind: "project",
    projectId: "infans-ai-system",
    projectName: "小秘书",
  };
  const rows = buildAiExecutionRows([
    { ...base, id: "ai-check", done: false, priority: null, executorId: "codex-ai-acceptance", automationMode: "automatic", automationContractStatus: "valid", text: "公司：验收：8/21 · AI· 核对同步｜ID：ai-check｜执行器：codex-ai-acceptance", displayText: "AI· 核对同步", aiProgressUpdatedAt: "2026-08-20T14:30:00.000Z", aiCurrentState: "已经完成前置施工。", aiNextAction: "明早自动核对。", reviewAt: "2026-08-20T21:00:00.000Z" },
    { ...base, id: "human-check", done: false, priority: "A", text: "公司：验收：A：8/21 · 人工验收｜ID：human-check", displayText: "人工验收" },
  ]);
  assert.deepEqual(rows.map((row) => row.taskId), ["ai-check"]);
  assert.equal(rows[0]?.displayText, "AI· 核对同步");
  assert.equal(rows[0]?.executionStatus, "not-run");
  assert.equal(rows[0]?.progressUpdatedAt, "2026-08-20T14:30:00.000Z");
  assert.equal(rows[0]?.currentState, "已经完成前置施工。");
  assert.equal(rows[0]?.nextAction, "明早自动核对。");
  assert.equal(rows[0]?.reviewAt, "2026-08-20T21:00:00.000Z");
});

test("AI 执行行保留原件派生的失败与阻塞状态", () => {
  const base = {
    section: "next",
    date: { start: "2026-08-21", end: "2026-08-21", label: "8/21" },
    parentId: null,
    dependencyIds: [],
    sourcePath: "30_事业顺利/小秘书/项目进度与待办.md",
    sourceKind: "project",
    projectId: "infans-ai-system",
    projectName: "小秘书",
    done: false,
    priority: null,
    executorId: "codex-ai-acceptance",
    automationMode: "automatic",
    automationContractStatus: "valid",
  };
  const rows = buildAiExecutionRows([
    { ...base, id: "failed", text: "8/21 · AI· 失败", displayText: "AI· 失败", aiExecutionStatus: "ran-failed" },
    { ...base, id: "blocked", text: "8/21 · AI· 阻塞", displayText: "AI· 阻塞", aiExecutionStatus: "blocked" },
    { ...base, id: "passed-open", text: "8/21 · AI· 已通过待收口", displayText: "AI· 已通过待收口", aiExecutionStatus: "ran-passed" },
    { ...base, id: "failed-closed", done: true, text: "8/21 · AI· 历史失败已收口", displayText: "AI· 历史失败已收口", aiExecutionStatus: "ran-failed" },
  ]);
  assert.deepEqual(rows.map((row) => row.executionStatus), ["ran-failed", "blocked", "ran-passed"]);
});

test("日程页保留逾期提档逻辑但不显示 A→S / C→B 提示", () => {
  const source = readFileSync(new URL("../src/pages/SchedulePage.tsx", import.meta.url), "utf8");
  assert.equal(source.includes("overduePromotion"), false);
  assert.equal(source.includes("逾期 {promotion}"), false);
});
