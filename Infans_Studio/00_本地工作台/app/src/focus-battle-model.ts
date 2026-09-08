import type { TodoItem } from "./gantt-model";
import type { ProjectFocusBattle, RegisteredProjectManagement } from "./types";

const PHASE_ORDER: Record<ProjectFocusBattle["phase"], number> = {
  active: 0,
  upcoming: 1,
  paused: 2,
  expired: 3,
  completed: 4,
  cancelled: 5,
};

export function visibleFocusBattles(project: RegisteredProjectManagement, limit = 2) {
  return [...(project.management?.focusBattles || [])]
    .filter((battle) => battle.phase === "active" || battle.phase === "upcoming")
    .sort((left, right) => PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase] || left.startDate.localeCompare(right.startDate))
    .slice(0, limit);
}

/**
 * 甘特图只消费派生任务：大作战与阶段使用原件中的同一稳定 ID，
 * 任务事实仍然来自项目任务，完成门状态仍然来自大作战节点。
 */
export function focusBattleGanttItems(projects: RegisteredProjectManagement[]): TodoItem[] {
  return projects.flatMap((project) => visibleFocusBattles(project, Number.POSITIVE_INFINITY).flatMap((battle) => {
    // 甘特既有解析器用完整起始年 + 省略结束年表达区间，避免末日被单日规则抢先识别。
    const ganttDateRange = `${battle.startDate.replaceAll("-", "/")}–${battle.endDate.slice(5).replace("-", "/")}`;
    const parent: TodoItem = {
      done: false,
      scope: "longTerm",
      text: `公司：阶段：${ganttDateRange} · ${project.name} · 限时大作战｜${battle.name}｜ID：${battle.id}`,
    };
    const stages = battle.stages.map((stage): TodoItem => ({
      done: stage.gateStatus === "passed",
      scope: "longTerm",
      text: `公司：节点：${stage.dueDate} · ${project.name} · ${stage.name}｜ID：${stage.id}｜父级：${battle.id}${stage.dependencyIds.length ? `｜依赖：${stage.dependencyIds.join(",")}` : ""}`,
    }));
    return [parent, ...stages];
  }));
}

export function focusBattleIdSet(projects: RegisteredProjectManagement[]) {
  return new Set(projects.flatMap((project) => visibleFocusBattles(project, Number.POSITIVE_INFINITY).map((battle) => battle.id)));
}
