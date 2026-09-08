import { addCalendarDays, parseTaskDates, parseTaskKind, stripTaskDecorators, type TaskKind } from "./gantt-model.ts";
import type { ProjectManagementTask, ProjectTaskPriority } from "./types.ts";

/** 四象限分级：S / A / B / C（S 最高 = 重要且紧急）。 */
export type QuadrantId = "S" | "A" | "B" | "C";

export type WeekTodoRow = {
  id: string;
  source: "central" | "project" | "vault" | "reminder";
  text: string;
  displayText: string;
  kind: TaskKind | null;
  projectName?: string;
  whenLabel?: string;
  date?: ProjectManagementTask["date"];
  /** 有钟点提醒时用于组内按时间排序（ISO）。 */
  sortAt?: string;
  /** 原件等级；未显式填写的普通待办按 C 解释。 */
  baselineQuadrant: QuadrantId;
  quadrant: QuadrantId;
  overduePromotion?: `${"A" | "C"}→${"S" | "B"}`;
  done: boolean;
  writeTarget?: {
    sourcePath: string;
    taskId: string;
    expectedDone: boolean;
    expectedPriority: ProjectTaskPriority;
  };
};

export type AiExecutionRow = {
  id: string;
  taskId: string;
  sourcePath: string;
  text: string;
  displayText: string;
  projectName?: string;
  date?: ProjectManagementTask["date"];
  executorId: string;
  executionStatus: "not-run" | "ran-failed" | "ran-passed" | "blocked";
  progressUpdatedAt?: string;
  currentState?: string;
  nextAction?: string;
  reviewAt?: string;
};

function isAutomaticExecutionTask(task: ProjectManagementTask): boolean {
  return task.automationMode === "automatic" && task.automationContractStatus === "valid";
}

export type QuadrantMeta = {
  id: QuadrantId;
  label: string;
  hint: string;
};

/** 展示顺序：上左 S、上右 A、下左 B、下右 C。 */
export const QUADRANT_ORDER: QuadrantMeta[] = [
  { id: "S", label: "重要且紧急", hint: "马上做" },
  { id: "A", label: "重要不紧急", hint: "计划做" },
  { id: "B", label: "紧急不重要", hint: "能推则推" },
  { id: "C", label: "不重要且不紧急", hint: "少做或不做" },
];

const QUADRANT_NAME_TO_ID: Record<string, QuadrantId> = {
  重要且紧急: "S",
  重要不紧急: "A",
  紧急不重要: "B",
  不重要且不紧急: "C",
  S: "S",
  A: "A",
  B: "B",
  C: "C",
  s: "S",
  a: "A",
  b: "B",
  c: "C",
};

/** `象限：重要且紧急` / `象限：S` */
const QUADRANT_NAMED_RE = /象限\s*[：:]\s*(重要且紧急|重要不紧急|紧急不重要|不重要且不紧急|[SABCsabc])\s*[：:]?\s*/u;
/** 分隔后的字母标记：`S：` / `A：` */
const QUADRANT_LETTER_RE = /(^|[\s：:·•])([SABCsabc])\s*[：:]\s*/gu;

export function parseQuadrant(text: string): { id: QuadrantId; explicit: boolean } | null {
  const named = text.match(QUADRANT_NAMED_RE);
  if (named) {
    const id = QUADRANT_NAME_TO_ID[named[1]];
    if (id) return { id, explicit: true };
  }
  QUADRANT_LETTER_RE.lastIndex = 0;
  const letter = QUADRANT_LETTER_RE.exec(text);
  if (letter) {
    const id = QUADRANT_NAME_TO_ID[letter[2]];
    if (id) return { id, explicit: true };
  }
  return null;
}

/** 从文案里剥掉象限标记（展示用）。 */
export function stripQuadrantMarkers(text: string) {
  return text
    .replace(QUADRANT_NAMED_RE, " ")
    .replace(QUADRANT_LETTER_RE, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 旧服务过渡回退：保留所有已到期任务，以及东京明天前将到期的任务。 */
export function isTodoInNextTwoTokyoDays(text: string, todayKey: string) {
  const span = parseTaskDates(text, todayKey);
  if (!span) return false;
  const endKey = addCalendarDays(todayKey, 1);
  return span.start <= endKey;
}

/** 普通待办默认 C；逾期只派生当前紧急性，不覆盖原件里的基础重要性。 */
export function effectiveTaskQuadrant(task: Pick<ProjectManagementTask, "done" | "priority" | "date">, todayKey: string): QuadrantId {
  const baseline = task.priority || "C";
  if (task.done || !task.date || task.date.end >= todayKey) return baseline;
  if (baseline === "A") return "S";
  if (baseline === "C") return "B";
  return baseline;
}

export function overduePromotionLabel(task: Pick<ProjectManagementTask, "done" | "priority" | "date">, todayKey: string): WeekTodoRow["overduePromotion"] {
  const baseline = task.priority || "C";
  const effective = effectiveTaskQuadrant(task, todayKey);
  if (baseline === "A" && effective === "S") return "A→S";
  if (baseline === "C" && effective === "B") return "C→B";
  return undefined;
}

function isCadence(row: WeekTodoRow) {
  return row.kind === "cadence";
}

function rowStartAt(row: WeekTodoRow) {
  if (row.sortAt) {
    const timestamp = Date.parse(row.sortAt);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  if (!row.date?.start) return null;
  const timestamp = Date.parse(`${row.date.start}T00:00:00+09:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function rowEndAt(row: WeekTodoRow) {
  if (!row.date?.end) return rowStartAt(row);
  const timestamp = Date.parse(`${row.date.end}T23:59:59+09:00`);
  return Number.isFinite(timestamp) ? timestamp : rowStartAt(row);
}

/** 组内：按开始时间升序，同起点再按结束时间；无日期与常驻项垫底。 */
function sortWithinQuadrant(a: WeekTodoRow, b: WeekTodoRow) {
  const aCadence = isCadence(a);
  const bCadence = isCadence(b);
  if (aCadence !== bCadence) return aCadence ? 1 : -1;

  const aStartAt = rowStartAt(a);
  const bStartAt = rowStartAt(b);
  if (aStartAt == null || bStartAt == null) {
    if (aStartAt == null && bStartAt == null) return 0;
    return aStartAt == null ? 1 : -1;
  }
  if (aStartAt !== bStartAt) return aStartAt - bStartAt;

  const aEndAt = rowEndAt(a);
  const bEndAt = rowEndAt(b);
  if (aEndAt != null && bEndAt != null && aEndAt !== bEndAt) return aEndAt - bEndAt;
  return 0;
}

export type QuadrantGroup = QuadrantMeta & { items: WeekTodoRow[] };

/** 日程上半区展示服务端已筛好的近 2 日执行任务。 */
export function buildCurrentExecutionRows(tasks: ProjectManagementTask[], todayKey: string): WeekTodoRow[] {
  return tasks.flatMap((task, index) => {
    if (task.done || isAutomaticExecutionTask(task)) return [];
    const baselineQuadrant = task.priority || "C";
    return [{
      id: `${task.id}:${task.sourcePath}:${index}`,
      source: task.sourceKind,
      text: task.text,
      displayText: task.displayText || stripTaskDecorators(task.text),
      kind: parseTaskKind(task.text).kind,
      whenLabel: task.date?.label || undefined,
      date: task.date,
      baselineQuadrant,
      quadrant: effectiveTaskQuadrant(task, todayKey),
      overduePromotion: overduePromotionLabel(task, todayKey),
      done: task.done,
      projectName: task.projectName || undefined,
      writeTarget: task.writable ? {
        sourcePath: task.sourcePath,
        taskId: task.id,
        expectedDone: task.done,
        expectedPriority: task.priority,
      } : undefined,
    } satisfies WeekTodoRow];
  });
}

/** 无需 Capoo 操作的近期待执行任务；完成状态由实际运行结果写回。 */
export function buildAiExecutionRows(tasks: ProjectManagementTask[]): AiExecutionRow[] {
  return tasks.flatMap((task, index) => {
    if (task.done || task.priority || !task.executorId || !isAutomaticExecutionTask(task)) return [];
    return [{
      id: `${task.id}:${task.sourcePath}:ai:${index}`,
      taskId: task.id,
      sourcePath: task.sourcePath,
      text: task.text,
      displayText: task.displayText.trim().replace(/^AI·\s*/u, "AI· "),
      projectName: task.projectName || undefined,
      date: task.date || undefined,
      executorId: task.executorId,
      executionStatus: task.aiExecutionStatus || "not-run",
      progressUpdatedAt: task.aiProgressUpdatedAt || undefined,
      currentState: task.aiCurrentState || undefined,
      nextAction: task.aiNextAction || undefined,
      reviewAt: task.reviewAt || undefined,
    } satisfies AiExecutionRow];
  });
}

export function groupWeekTodosByQuadrant(rows: WeekTodoRow[]): QuadrantGroup[] {
  const buckets: Record<QuadrantId, WeekTodoRow[]> = { S: [], A: [], B: [], C: [] };
  for (const row of rows) {
    buckets[row.quadrant].push(row);
  }
  for (const id of ["S", "A", "B", "C"] as QuadrantId[]) {
    buckets[id].sort(sortWithinQuadrant);
  }
  return QUADRANT_ORDER.map((meta) => ({ ...meta, items: buckets[meta.id] }));
}
