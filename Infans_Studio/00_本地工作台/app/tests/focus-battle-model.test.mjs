import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskDates } from "../src/gantt-model.ts";
import { focusBattleGanttItems, focusBattleIdSet, visibleFocusBattles } from "../src/focus-battle-model.ts";

function projectWithBattles(battles) {
  return {
    projectId: "infans-ai-system",
    name: "小秘书",
    status: "推进中",
    management: { focusBattles: battles },
  };
}

const activeBattle = {
  id: "battle-yinyue-birth-7d-20260830",
  projectId: "infans-ai-system",
  projectName: "小秘书",
  name: "变成有钱人七日大作战",
  status: "enabled",
  phase: "active",
  startDate: "2026-08-30",
  endDate: "2026-09-05",
  totalDays: 7,
  currentDay: 1,
  todayStageId: "battle-yinyue-birth-7d-20260830-d1",
  totalGoal: "接通养成能力",
  finalGate: "正常使用验收",
  riskIds: [],
  reviewStatus: "pending",
  sourcePath: "项目进度与待办.md",
  stages: [
    { id: "battle-yinyue-birth-7d-20260830-d1", name: "正式出生", dueDate: "2026-08-30", focus: "最小闭环", taskIds: ["task-d1"], featureIds: ["assistant-cyber-life"], dependencyIds: [], deliverables: ["出生闭环"], gate: "真实呼叫与回复", gateStatus: "pending", evidenceRefs: [] },
    { id: "battle-yinyue-birth-7d-20260830-d2", name: "项目事件", dueDate: "2026-08-31", focus: "事件闭环", taskIds: ["task-d2"], featureIds: ["projects-relation-graph"], dependencyIds: ["battle-yinyue-birth-7d-20260830-d1"], deliverables: ["事件响应"], gate: "只处理一次", gateStatus: "passed", evidenceRefs: ["evidence.md"] },
  ],
};

test("项目主页只展开进行中或将开始的大作战，并限制两场", () => {
  const project = projectWithBattles([
    { ...activeBattle, id: "completed", phase: "completed" },
    { ...activeBattle, id: "upcoming", phase: "upcoming", startDate: "2026-09-10" },
    activeBattle,
    { ...activeBattle, id: "paused", phase: "paused" },
  ]);
  assert.deepEqual(visibleFocusBattles(project).map((battle) => battle.id), [activeBattle.id, "upcoming"]);
  assert.deepEqual(visibleFocusBattles(projectWithBattles([{ ...activeBattle, id: "paused", phase: "paused" }])), []);
});

test("甘特图用同一大作战和阶段 ID 生成项目置顶父子行", () => {
  const project = projectWithBattles([activeBattle]);
  const items = focusBattleGanttItems([project]);
  assert.equal(items.length, 3);
  assert.match(items[0].text, /2026\/08\/30–09\/05/);
  assert.deepEqual(parseTaskDates(items[0].text, "2026-08-29"), { start: "2026-08-30", end: "2026-09-05", kind: "range", source: "explicit" });
  assert.match(items[0].text, new RegExp(`ID：${activeBattle.id}$`));
  assert.match(items[1].text, new RegExp(`父级：${activeBattle.id}`));
  assert.equal(items[2].done, true);
  assert.deepEqual([...focusBattleIdSet([project])], [activeBattle.id]);
});
