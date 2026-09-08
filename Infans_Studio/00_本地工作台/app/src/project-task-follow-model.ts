import type { ProjectManagementSnapshot, ProjectManagementTask } from "./types";
export type { ProjectTaskFollowState } from "./types";

export const UMBRELLA_PROJECT_NAME = "小秘书";
export const UMBRELLA_PROJECT_FALLBACK_ID = "secretary";

export type AllProjectTodoGroup = {
  projectId: string;
  projectName: string;
  tasks: Array<ProjectManagementTask & { followKey: string | null; recentlyCompleted?: boolean }>;
};

export type RecentlyCompletedProjectTodo = {
  projectId: string;
  projectName: string;
  task: ProjectManagementTask;
};

type FollowableProjectTodo = AllProjectTodoGroup["tasks"][number];

export function projectTaskFollowKey(projectId: string | null, taskId: string) {
  if (!projectId || !/^[a-z0-9][a-z0-9-]{0,79}$/u.test(projectId)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(taskId)) return null;
  return `${projectId}:${taskId}`;
}

export function isUmbrellaProject(project: { projectId?: string | null; name?: string | null; projectName?: string | null }) {
  return (project.projectName || project.name || "").trim() === UMBRELLA_PROJECT_NAME;
}

export function resolveUmbrellaProject(snapshot?: ProjectManagementSnapshot | null): { projectId: string; projectName: string } {
  const registered = snapshot?.projects.find((project) => !project.archived && isUmbrellaProject(project) && project.projectId);
  if (registered?.projectId) return { projectId: registered.projectId, projectName: registered.name };
  return { projectId: UMBRELLA_PROJECT_FALLBACK_ID, projectName: UMBRELLA_PROJECT_NAME };
}

function followableTask(task: ProjectManagementTask, projectId: string | null): FollowableProjectTodo {
  return {
    ...task,
    followKey: task.idKind === "explicit" && task.writable
      ? projectTaskFollowKey(projectId, task.id)
      : null,
  };
}

function collectOpenProjectTasks(project: ProjectManagementSnapshot["projects"][number]): FollowableProjectTodo[] {
  if (project.archived || !project.management) return [];
  return [...project.management.doing, ...project.management.next]
    .filter((task) => !task.done && task.sourceKind === "project")
    .map((task) => followableTask(task, project.projectId));
}

function findUmbrellaGroup(groups: AllProjectTodoGroup[], umbrella: { projectId: string; projectName: string }) {
  return groups.find((group) => group.projectId === umbrella.projectId || isUmbrellaProject(group));
}

function prependUmbrella(groups: AllProjectTodoGroup[], umbrella: { projectId: string; projectName: string }) {
  const umbrellaIndex = groups.findIndex((group) => group.projectId === umbrella.projectId || isUmbrellaProject(group));
  if (umbrellaIndex <= 0) return groups;
  const next = [...groups];
  const [umbrellaGroup] = next.splice(umbrellaIndex, 1);
  next.unshift(umbrellaGroup);
  return next;
}

function mergeIntoUmbrella(
  groups: AllProjectTodoGroup[],
  tasks: FollowableProjectTodo[],
  umbrella: { projectId: string; projectName: string },
) {
  if (!tasks.length) return prependUmbrella(groups, umbrella);
  const next = groups.map((group) => ({ ...group, tasks: [...group.tasks] }));
  const existing = findUmbrellaGroup(next, umbrella);
  if (existing) existing.tasks.push(...tasks);
  else next.unshift({ projectId: umbrella.projectId, projectName: umbrella.projectName, tasks: [...tasks] });
  return prependUmbrella(next, umbrella);
}

/** 按事业注册表项目分组；小秘书始终在前。没有项目 ID 或找不到项目的任务归入小秘书。 */
export function buildAllProjectTodoGroups(snapshot?: ProjectManagementSnapshot | null): AllProjectTodoGroup[] {
  if (!snapshot) return [];
  const umbrella = resolveUmbrellaProject(snapshot);
  const groups: AllProjectTodoGroup[] = [];
  const orphans: FollowableProjectTodo[] = [];
  for (const project of snapshot.projects) {
    const tasks = collectOpenProjectTasks(project);
    if (!tasks.length) continue;
    if (!project.projectId) {
      orphans.push(...tasks.map((task) => ({ ...task, followKey: null })));
      continue;
    }
    groups.push({ projectId: project.projectId, projectName: project.name, tasks });
  }
  return mergeIntoUmbrella(groups, orphans, umbrella);
}

/** 只在当前“全部待办”展开会话中，把刚完成而从原列表消失的任务留在原项目位置；原项目找不到时归入小秘书。 */
export function retainRecentlyCompletedProjectTodos(
  groups: AllProjectTodoGroup[],
  retained: RecentlyCompletedProjectTodo[],
  umbrella: { projectId: string; projectName: string } = { projectId: UMBRELLA_PROJECT_FALLBACK_ID, projectName: UMBRELLA_PROJECT_NAME },
): AllProjectTodoGroup[] {
  if (!retained.length) return prependUmbrella(groups, umbrella);
  const visibleKeys = new Set(groups.flatMap((group) => group.tasks.map((task) => `${group.projectId}:${task.id}`)));
  const next = groups.map((group) => ({ ...group, tasks: [...group.tasks] }));
  const orphans: FollowableProjectTodo[] = [];
  for (const item of retained) {
    const key = `${item.projectId}:${item.task.id}`;
    if (visibleKeys.has(key)) continue;
    const task = { ...item.task, done: true, followKey: null, recentlyCompleted: true };
    const group = next.find((candidate) => candidate.projectId === item.projectId);
    if (group) group.tasks.push(task);
    else if (item.projectId) next.push({ projectId: item.projectId, projectName: item.projectName || umbrella.projectName, tasks: [task] });
    else orphans.push(task);
    visibleKeys.add(key);
  }
  return mergeIntoUmbrella(next, orphans, umbrella);
}
