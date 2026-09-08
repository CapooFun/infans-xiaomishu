/** 事业顺利的项目卡、URL 查询与 SABC 选择纯函数。 */

import type {
  ProductFeaturePoint,
  ProductFeatureTree,
  ProjectManagementTask,
  ProjectHub,
  ProjectHubFeatureNode,
  ProjectHubFeatureTree,
  ProjectHubStatus,
} from "./types";
import { captureCurrentWorkbenchPosition, rememberCurrentWorkbenchLocation } from "./workbench-position-memory.ts";

export type ProjectKind = "flagship" | "coach" | "venture";
export type ProjectPortfolioTier = "primary" | "focus" | "game" | "media" | "other";
export type TaskPriority = "S" | "A" | "B" | "C" | null;

export function projectTaskFeatureIds(task: Pick<ProjectManagementTask, "featureId" | "featureIds">): string[] {
  if (task.featureIds?.length) return task.featureIds;
  return task.featureId ? [task.featureId] : [];
}

export function projectTaskHasFeature(task: Pick<ProjectManagementTask, "featureId" | "featureIds">, featureId: string): boolean {
  return projectTaskFeatureIds(task).includes(featureId);
}

type FeatureTreeNode = { id?: string; children?: FeatureTreeNode[] };

function featureTreeNodeContainsId(nodes: FeatureTreeNode[] | undefined, id: string): boolean {
  return Boolean(nodes?.some((node) => node.id === id || featureTreeNodeContainsId(node.children, id)));
}

type ProjectFeatureAssociation = { featureId?: string | null; featureIds?: string[] };

type ProjectContextAssociation = ProjectFeatureAssociation & {
  taskIds?: string[];
  worklineIds: string[];
  moduleIds: string[];
};

type ProjectScopeAssociation = ProjectFeatureAssociation & {
  worklineIds?: string[];
  moduleIds?: string[];
};

type ProjectRecentLink = {
  worklineId: string;
  moduleId?: string | null;
  featureId?: string | null;
};

export function projectFeatureAssociationIds(item: ProjectFeatureAssociation): string[] {
  if (item.featureIds?.length) return item.featureIds;
  return item.featureId ? [item.featureId] : [];
}

export function mergeProjectRecentAssociations<T extends ProjectContextAssociation>(
  item: T,
  inheritedFeatureIds: string[] = [],
  links: ProjectRecentLink[] = [],
) {
  return mergeProjectContextAssociations(item, inheritedFeatureIds.length ? [{ featureIds: inheritedFeatureIds }] : [], links);
}

/**
 * 任务、阻塞与完成事实共用同一个关系合并器。
 * 原件显式关系优先；关联任务与 Project Hub v1 链接只做派生补充。
 */
export function mergeProjectContextAssociations<T extends ProjectContextAssociation>(
  item: T,
  inherited: ProjectScopeAssociation[] = [],
  links: ProjectRecentLink[] = [],
) {
  return {
    ...item,
    worklineIds: [...new Set([
      ...item.worklineIds,
      ...inherited.flatMap((source) => source.worklineIds || []),
      ...links.map((link) => link.worklineId),
    ])],
    moduleIds: [...new Set([
      ...item.moduleIds,
      ...inherited.flatMap((source) => source.moduleIds || []),
      ...links.flatMap((link) => link.moduleId ? [link.moduleId] : []),
    ])],
    featureIds: [...new Set([
      ...projectFeatureAssociationIds(item),
      ...inherited.flatMap((source) => projectFeatureAssociationIds(source)),
      ...links.flatMap((link) => link.featureId ? [link.featureId] : []),
    ])],
  };
}

function projectHubFeatureNodeContainsId(node: ProjectHubFeatureNode, id: string): boolean {
  return node.id === id || node.children.some((child) => projectHubFeatureNodeContainsId(child, id));
}

/** 显式功能／模块关系可沿 Project Hub 结构向上归属工作线，不按文案猜测。 */
export function projectHubAssociationWorklineIds(
  hub: Pick<ProjectHub, "featureTrees">,
  item: ProjectScopeAssociation,
): string[] {
  const worklineIds = new Set(item.worklineIds || []);
  const moduleIds = new Set(item.moduleIds || []);
  const featureIds = projectFeatureAssociationIds(item);
  for (const tree of hub.featureTrees) {
    const matches = tree.modules.some((module) => moduleIds.has(module.id)
      || featureIds.includes(module.id)
      || module.features.some((feature) => featureIds.some((id) => projectHubFeatureNodeContainsId(feature, id))));
    if (matches) worklineIds.add(tree.worklineId);
  }
  return [...worklineIds];
}

export function projectHubAssociationMatchesWorkline(
  hub: Pick<ProjectHub, "featureTrees">,
  item: ProjectScopeAssociation,
  worklineId: string,
): boolean {
  return projectHubAssociationWorklineIds(hub, item).includes(worklineId);
}

/** 功能点 ID 也归到它所属的顶层小功能，不按文案猜测归属。 */
export function projectFeatureDestinations(tree: ProductFeatureTree, item: ProjectFeatureAssociation) {
  const destinations: Array<{ moduleId: string; featureId: string | null }> = [];
  const seen = new Set<string>();
  for (const id of projectFeatureAssociationIds(item)) {
    for (const module of tree.modules) {
      let destination: { moduleId: string; featureId: string | null } | null = null;
      if (module.id === id) destination = { moduleId: module.id, featureId: null };
      else {
        const feature = module.features.find((candidate) => candidate.id === id || featureTreeNodeContainsId(candidate.points, id));
        if (feature) destination = { moduleId: module.id, featureId: feature.id };
      }
      if (!destination) continue;
      const key = `${destination.moduleId}:${destination.featureId || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        destinations.push(destination);
      }
      break;
    }
  }
  return destinations;
}

export function projectRecentHasFeature(tree: ProductFeatureTree, item: ProjectFeatureAssociation, featureId: string): boolean {
  return projectFeatureDestinations(tree, item).some((destination) => destination.featureId === featureId);
}

export function projectRecentModuleIds(tree: ProductFeatureTree, item: ProjectFeatureAssociation & { moduleIds?: string[] }): string[] {
  return [...new Set([
    ...(item.moduleIds || []),
    ...projectFeatureDestinations(tree, item).map((destination) => destination.moduleId),
  ])];
}

export function resolveProjectTaskFeatureDestination(tree: ProductFeatureTree, task: Pick<ProjectManagementTask, "featureId" | "featureIds">) {
  return projectFeatureDestinations(tree, task)[0] || null;
}

const PROJECT_PORTFOLIO_ORDER = [
  "小秘书",
  "阳台种植计划",
  "周末摄影集",
  "手作小铺试营业",
  "个人作品网站",
  "社区读书会",
] as const;

/** 事业页层级是明确的经营决策，不由文字长度或最近更新时间推断。 */
export function projectPortfolioTier(name: string): ProjectPortfolioTier {
  if (name === "小秘书") return "primary";
  if (name === "阳台种植计划" || name === "周末摄影集") return "focus";
  if (name === "手作小铺试营业" || name === "个人作品网站") return "game";
  if (name === "社区读书会") return "media";
  return "other";
}

export function projectPortfolioRank(name: string): number {
  const normalizedName = name;
  const index = PROJECT_PORTFOLIO_ORDER.indexOf(normalizedName as (typeof PROJECT_PORTFOLIO_ORDER)[number]);
  return index < 0 ? PROJECT_PORTFOLIO_ORDER.length : index;
}

/** 首页项目窗只接受明确横向手势；轻微移动和纵向滚动都不切换。 */
export function projectWindowSwipeStep(deltaX: number, deltaY: number): -1 | 0 | 1 {
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.35) return 0;
  return deltaX < 0 ? 1 : -1;
}

/** 触控板横向滚动只在横向量明显占优时切换。 */
export function projectWindowWheelStep(deltaX: number, deltaY: number): -1 | 0 | 1 {
  if (Math.abs(deltaX) < 18 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return 0;
  return deltaX > 0 ? 1 : -1;
}

type ProgressBranch = {
  status?: string;
  points?: ProgressBranch[];
  children?: ProgressBranch[];
};

function topUnstableBranches(branches: ProgressBranch[]): Array<{ status: string }> {
  return branches.flatMap((branch) => {
    if (branch.status === "已暂停") return [];
    if (branch.status && branch.status !== "稳定") return [{ status: branch.status }];
    return topUnstableBranches(branch.points || branch.children || []);
  });
}

/**
 * 模块折叠后提示最靠上的待推进分支：父功能仍稳定时继续向下找；
 * 父功能已经非稳定时只计父功能一次，不让同一条分支的后代重复报数。
 * 已暂停是停滞态，不进入折叠徽章，也不再向下把暂停枝里的后代算进来。
 */
export function moduleProgressSignal(features: ProgressBranch[]) {
  const active = topUnstableBranches(features);
  if (!active.length) return null;
  if (active.length === 1) return { kind: "status" as const, label: active[0].status, count: 1 };
  return { kind: "count" as const, label: String(active.length), count: active.length };
}

/** 普通待办缺省为 C；等级只能切换，不再回到“未分级”。 */
export function nextTaskPriority(current: TaskPriority, clicked: Exclude<TaskPriority, null>): TaskPriority {
  return clicked;
}

export type CurrentProjectStep = {
  task: ProjectManagementTask;
  source: "doing" | "next";
};

function isAutomaticProjectTask(task: Pick<ProjectManagementTask, "automationMode" | "automationContractStatus">): boolean {
  return task.automationMode === "automatic" && task.automationContractStatus === "valid";
}

/** 当前第一步只排除已具备有效契约的自动任务；`AI·` 人工票仍需 Capoo 主动派发。 */
export function selectCurrentProjectStep(management: {
  doing: ProjectManagementTask[];
  next: ProjectManagementTask[];
}): CurrentProjectStep | null {
  const isUserAction = (task: ProjectManagementTask) => !task.done && !isAutomaticProjectTask(task);
  const doing = management.doing.find(isUserAction);
  if (doing) return { task: doing, source: "doing" };
  const next = management.next.find(isUserAction);
  return next ? { task: next, source: "next" } : null;
}

export const COMPLETED_TASK_BOARD_TTL_MS = 24 * 60 * 60 * 1000;

/** 看板只短暂保留有可信完成时刻的已完成任务；旧任务无时间时不猜测。 */
export function isProjectTaskVisibleOnBoard(task: Pick<ProjectManagementTask, "done" | "completedAt">, now: Date | number = Date.now()) {
  if (!task.done) return true;
  if (!task.completedAt) return false;
  const completedAt = Date.parse(task.completedAt);
  if (!Number.isFinite(completedAt)) return false;
  const elapsed = (now instanceof Date ? now.getTime() : now) - completedAt;
  return elapsed >= 0 && elapsed < COMPLETED_TASK_BOARD_TTL_MS;
}

const PROJECT_HUB_STATUS_LABEL: Record<ProjectHubStatus, string> = {
  planned: "准备中",
  active: "推进中",
  blocked: "有阻塞",
  testing: "测试中",
  waiting_acceptance: "等待验收",
  paused: "已暂停",
  stable: "稳定",
  done: "已完成",
};

export function projectHubStatusLabel(status: ProjectHubStatus) {
  return PROJECT_HUB_STATUS_LABEL[status] || "准备中";
}

function projectHubPoint(node: ProjectHubFeatureNode, displayMode: boolean): ProductFeaturePoint | null {
  if (displayMode && node.hiddenInDisplayMode) return null;
  return {
    id: node.id,
    text: node.name,
    status: projectHubStatusLabel(node.status),
    summary: node.description,
    source: node.source,
    hiddenInDisplayMode: node.hiddenInDisplayMode,
    children: node.children.flatMap((child) => {
      const point = projectHubPoint(child, displayMode);
      return point ? [point] : [];
    }),
  };
}

/** 把 Project Hub v1 已解析的机制详情无损适配到共享 Wiki；不读取或补造外部正文。 */
export function productTreeFromProjectHub(tree: ProjectHubFeatureTree, displayMode: boolean): ProductFeatureTree {
  return {
    title: tree.title,
    description: tree.description,
    sourcePath: "",
    warnings: tree.warnings,
    modules: tree.modules.flatMap((module) => {
      if (displayMode && module.hiddenInDisplayMode) return [];
      const features = module.features.flatMap((feature) => {
        if (displayMode && feature.hiddenInDisplayMode) return [];
        return [{
          id: feature.id,
          name: feature.name,
          status: projectHubStatusLabel(feature.status),
          description: feature.description,
          points: feature.children.flatMap((child) => {
            const point = projectHubPoint(child, displayMode);
            return point ? [point] : [];
          }),
          progress: [],
          source: null,
        }];
      });
      return features.length ? [{ id: module.id, name: module.name, description: module.description, features }] : [];
    }),
  };
}

export type ProjectCard = {
  id: string;
  kind: ProjectKind;
  name: string;
  /** 外层展示名（去掉书名号等装饰） */
  displayName: string;
  status: string;
  /** 外层扫一眼的一行状态 */
  peek: string;
  entryPath: string | null;
  archived: boolean;
  experience?: {
    kind: "external" | "launcher";
    label: string;
    url: string | null;
    launcherId: string | null;
  } | null;
};

type ProjectItem = { name: string; status: string; entry: string; entryPath: string | null; archived?: boolean };
type Flagship = { version: string; focus: string; ready: string[]; pending: string[] };
type Coaching = { focus: string; latest: string };

const FEATURED_NAMES = /^(小秘书)$/u;

/** 展示用：书名号改成和其它自媒体一样的直角引号。 */
export function displayProjectName(name: string) {
  return String(name || "")
    .replace(/《([^》]*)》/gu, "「$1」")
    .replace(/\s+/g, " ")
    .trim();
}

export function projectIdFromName(name: string): string {
  const demoIds: Record<string, string> = {
    小秘书: "demo-secretary",
    阳台种植计划: "demo-balcony-garden",
    周末摄影集: "demo-weekend-photo",
    手作小铺试营业: "demo-handmade-shop",
    个人作品网站: "demo-portfolio-site",
    社区读书会: "demo-reading-club",
  };
  return demoIds[name] || `venture:${encodeURIComponent(name)}`;
}

export function readProjectQuery(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("project");
  return value && value.trim() ? value.trim() : null;
}

export function writeProjectQuery(projectId: string | null) {
  if (typeof window === "undefined") return;
  captureCurrentWorkbenchPosition();
  const url = new URL(window.location.href);
  const changedProject = url.searchParams.get("project") !== projectId;
  if (projectId) url.searchParams.set("project", projectId);
  else url.searchParams.delete("project");
  if (changedProject) {
    for (const key of ["workline", "tree", "module", "feature", "node"]) url.searchParams.delete(key);
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  rememberCurrentWorkbenchLocation();
}

export function buildProjectCards(input: {
  items: ProjectItem[];
  flagship: Flagship;
  coaching: Coaching;
}): ProjectCard[] {
  const cards: ProjectCard[] = [];

  for (const item of input.items) {
    if (FEATURED_NAMES.test(item.name) && cards.some((card) => card.name === item.name)) continue;
    cards.push({
      id: item.name === "小秘书" ? "flagship" : projectIdFromName(item.name),
      kind: item.name === "小秘书" ? "flagship" : "venture",
      name: item.name,
      displayName: displayProjectName(item.name),
      status: item.name === "小秘书" ? (input.flagship.version || item.status) : item.status,
      peek: item.name === "小秘书" ? (input.flagship.focus || item.entry || item.status) : (item.entry || item.status),
      entryPath: item.entryPath,
      archived: Boolean(item.archived),
    });
  }
  return cards;
}
