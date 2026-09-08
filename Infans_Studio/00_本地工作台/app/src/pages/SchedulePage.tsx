import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, CalendarDays, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleDashed, Eye, Flag, ListChecks, LoaderCircle, MapPinned, PackageOpen, Route } from "lucide-react";
import {
  barStyle,
  buildGanttModel,
  buildRoadmapMonths,
  milestoneStyle,
  parseTaskDates,
  parseTaskKind,
  roadmapBarStyle,
  roadmapDateLeft,
  roadmapDependencyStyle,
  roadmapDateCenterLeft,
  roadmapPointStyle,
  routinePointStyle,
  stripTaskDecorators,
  type GanttRoutineSeries,
  type GanttTask,
  type RoadmapMonth,
  type TaskKind,
} from "../gantt-model";
import { buildAiExecutionRows, buildCurrentExecutionRows, effectiveTaskQuadrant, groupWeekTodosByQuadrant, isTodoInNextTwoTokyoDays, parseQuadrant, type QuadrantId, type WeekTodoRow } from "../schedule-todo-model";
import { buildAllProjectTodoGroups, isUmbrellaProject, retainRecentlyCompletedProjectTodos, resolveUmbrellaProject, type ProjectTaskFollowState, type RecentlyCompletedProjectTodo } from "../project-task-follow-model";
import { resolveProjectTaskFeatureDestination } from "../project-workbench-model";
import {
  Card,
  Empty,
  jsonFetch,
  navigate,
  tokyoDateKey,
} from "../page-shared";
import { currentWorkbenchLocation, rememberTodoReturnLocation, readScheduleTodosOpen, writeScheduleTodosOpen } from "../workbench-position-memory.ts";
import type { CalendarEvent, CalendarSnapshot, ProjectManagementSnapshot, ProjectManagementTask, WorkbenchSummary, WriteAction } from "../types";
import JapanActivitiesView from "./tools/JapanActivitiesView";
import ReleaseWatchView from "./schedule/ReleaseWatchView";
import { focusBattleGanttItems, focusBattleIdSet } from "../focus-battle-model";
import { calendarEventsByLane, calendarMarkerStackOffsets, calendarRange, companyTravelEventLabel, eventAxisPointStyle, eventDays, eventKey, eventTimeLabel, groupCompanyTravel, groupLifeEvents, lifeCategoryDefaultOpen, lifeEvents, type CompanyTravelGroup, type LifeEventGroup } from "./schedule/calendar-model";
import { useLifeCalendar } from "./schedule/use-life-calendar";
import "./schedule/calendar.css";

type GanttHiddenState = { texts: string[] };
type TimelineMode = "roadmap" | "weeks";
type ScheduleSectionId = "today" | "roadmap" | "japan" | "releases";
const TODO_PRIORITIES = ["S", "A", "B", "C"] as const;
const AI_EXECUTION_LABEL = {
  "not-run": "等待自动运行",
  "ran-failed": "未通过 · 已有下一步",
  "ran-passed": "已通过 · 待收口",
  blocked: "需要你授权",
} as const;

const SCHEDULE_SECTIONS = [
  { id: "roadmap", label: "主线进度", hint: "长期在推", icon: Route },
  { id: "today", label: "今日事项", hint: "现在要做", icon: ListChecks },
  { id: "japan", label: "日本活动", hint: "近期可去", icon: MapPinned },
  { id: "releases", label: "新品发售", hint: "正在期待", icon: PackageOpen },
] as const;

function scheduleSectionFromLocation(): ScheduleSectionId {
  const candidate = new URLSearchParams(window.location.search).get("view");
  return SCHEDULE_SECTIONS.some((section) => section.id === candidate) ? candidate as ScheduleSectionId : "today";
}

type FeatureNode = { id?: string; children?: FeatureNode[] };
type ScheduleTaskDestination = { path: string; fallback?: boolean };

function projectPath(projectId: string, extras: Record<string, string | null | undefined> = {}) {
  const params = new URLSearchParams({ project: projectId });
  Object.entries(extras).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return `/projects?${params.toString()}`;
}

function projectHomeDestination(project: NonNullable<ProjectManagementSnapshot["projects"]>[number]): ScheduleTaskDestination | null {
  return project.projectId ? { path: projectPath(project.projectId), fallback: true } : null;
}

function featureNodeContainsId(nodes: FeatureNode[] | undefined, id: string): boolean {
  return Boolean(nodes?.some((node) => node.id === id || featureNodeContainsId(node.children, id)));
}

function legacyFeatureDestination(project: NonNullable<ProjectManagementSnapshot["projects"]>[number], task: ProjectManagementTask): ScheduleTaskDestination | null {
  if (!project.projectId || !project.featureTree) return null;
  const destination = resolveProjectTaskFeatureDestination(project.featureTree, task);
  return destination ? { path: projectPath(project.projectId, { module: destination.moduleId, feature: destination.featureId }) } : null;
}

function worklineDestination(project: NonNullable<ProjectManagementSnapshot["projects"]>[number], task: ProjectManagementTask): ScheduleTaskDestination | null {
  if (!project.projectId || !project.projectHub) return null;
  const worklineIds = task.worklineIds?.length ? task.worklineIds : task.worklineId ? [task.worklineId] : [];
  const workline = worklineIds.map((id) => project.projectHub?.worklines.find((item) => item.id === id)).find(Boolean);
  return workline ? { path: projectPath(project.projectId, { workline: workline.id }) } : null;
}

function hubMetadataFeatureDestination(project: NonNullable<ProjectManagementSnapshot["projects"]>[number], task: ProjectManagementTask): ScheduleTaskDestination | null {
  const hub = project.projectHub;
  if (!project.projectId || !hub) return null;
  const featureIds = task.featureIds?.length ? task.featureIds : task.featureId ? [task.featureId] : [];
  for (const workline of hub.worklines) {
    if (workline.view.kind !== "featureTree") continue;
    const treeId = workline.view.treeId;
    const tree = hub.featureTrees.find((item) => item.id === treeId);
    if (!tree) continue;
    for (const featureId of featureIds) {
      const module = tree.modules.find((item) => item.id === featureId || item.features.some((feature) => feature.id === featureId || featureNodeContainsId(feature.children, featureId)));
      if (!module) continue;
      const feature = module.features.find((item) => item.id === featureId) ? featureId : null;
      return { path: projectPath(project.projectId, { workline: workline.id, tree: tree.id, module: module.id, feature }) };
    }
  }
  return null;
}

function localModuleDestination(task: ProjectManagementTask): ScheduleTaskDestination | null {
  const featureIds = task.featureIds?.length ? task.featureIds : task.featureId ? [task.featureId] : [];
  if (featureIds.includes("health-mind")) return { path: "/health?band=mind" };
  if (featureIds.includes("health-life")) return { path: "/health?band=life" };
  return null;
}

function hubFeatureDestination(project: NonNullable<ProjectManagementSnapshot["projects"]>[number], task: ProjectManagementTask): ScheduleTaskDestination | null {
  const hub = project.projectHub;
  if (!project.projectId || !hub) return null;
  const link = hub.taskLinks.find((item) => item.taskId === task.id);
  if (!link) return null;
  const workline = hub.worklines.find((item) => item.id === link.worklineId);
  if (!workline) return null;
  const view = workline.view;
  if (view.kind !== "featureTree") return { path: projectPath(project.projectId, { workline: workline.id }) };
  const tree = hub.featureTrees.find((item) => item.id === view.treeId);
  if (!tree) return null;
  const module = tree.modules.find((item) => item.id === link.moduleId)
    || (link.featureId ? tree.modules.find((item) => item.features.some((feature) => feature.id === link.featureId || featureNodeContainsId(feature.children, link.featureId!))) : null);
  if (!module) return { path: projectPath(project.projectId, { workline: workline.id, tree: tree.id }) };
  const feature = link.featureId && module.features.some((item) => item.id === link.featureId)
    ? link.featureId
    : null;
  return { path: projectPath(project.projectId, { workline: workline.id, tree: tree.id, module: module.id, feature }) };
}

export function taskDestination(project: NonNullable<ProjectManagementSnapshot["projects"]>[number], task: ProjectManagementTask) {
  const specificDestination = project.projectHub
    ? hubFeatureDestination(project, task) || hubMetadataFeatureDestination(project, task) || worklineDestination(project, task) || legacyFeatureDestination(project, task)
    : legacyFeatureDestination(project, task) || localModuleDestination(task);
  return specificDestination || localModuleDestination(task) || projectHomeDestination(project);
}

function projectTaskKey(task: Pick<ProjectManagementTask, "sourcePath" | "id">) {
  return `${task.sourcePath}:${task.id}`;
}

function scheduleDateLabel(date: ProjectManagementTask["date"] | undefined, todayKey: string) {
  if (!date) return null;
  const currentYear = todayKey.slice(0, 4);
  const format = (value: string) => {
    const [year, month, day] = value.split("-");
    return year === currentYear ? `${Number(month)}月${Number(day)}日` : `${year}年${Number(month)}月${Number(day)}日`;
  };
  return date.start === date.end ? format(date.start) : `${format(date.start)}–${format(date.end)}`;
}

function aiProgressTimeLabel(value: string | undefined, todayKey: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  const dateKey = `${read("year")}-${read("month")}-${read("day")}`;
  const dayLabel = dateKey === todayKey ? "今天" : `${Number(read("month"))}月${Number(read("day"))}日`;
  return `${dayLabel} ${read("hour")}:${read("minute")} 更新`;
}

function normalizeTodoKey(text: string) {
  return text.replace(/\s+/g, "").toLowerCase();
}

function formatSpanLabel(task: GanttTask) {
  if (!task.span) return "长期在做 · 不占时间条";
  const start = task.span.start.slice(5).replace("-", "/");
  if (task.marker === "flag") return `${start} ▼ 截止`;
  if (task.marker === "star") {
    const tag = task.kind === "event" ? "事件" : "节点";
    return `${start} ★ ${tag}`;
  }
  if (task.marker === "diamond") return `${start} ◆ 决策门`;
  if (task.marker === "dot") return `${start} · 细节`;
  return `${start}–${task.span.end.slice(5).replace("-", "/")}`;
}

function kindBadge(kind: TaskKind | null | undefined) {
  if (kind === "cadence") return "常驻";
  if (kind === "deadline") return "截止";
  if (kind === "event") return "事件";
  if (kind === "milestone") return "节点";
  if (kind === "span") return "区间";
  if (kind === "phase") return "阶段";
  if (kind === "gate") return "决策";
  if (kind === "detail") return "细节";
  if (kind === "routine") return "例行";
  return "";
}

/** 上层待办列表：节点/截止都当普通待办，只保留常驻角标。 */
function todoListBadge(item: WeekTodoRow) {
  if (item.kind === "cadence") return "常驻";
  return "";
}

function HideEyeButton({ label, onHide }: { label: string; onHide: () => void }) {
  return (
    <button
      type="button"
      className="gantt-hide-btn"
      title="从日程里藏起来（不改待办完成状态）"
      aria-label={`隐藏：${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onHide();
      }}
    >
      <Eye size={12} strokeWidth={1.75} />
    </button>
  );
}

function AxisGlyph({
  task,
  weekCount,
  mode,
  months,
  dependency,
  focusBattle = false,
}: {
  task: GanttTask;
  weekCount: number;
  mode: TimelineMode;
  months: RoadmapMonth[];
  dependency?: GanttTask;
  focusBattle?: boolean;
}) {
  if (!task.onAxis || !task.span) {
    return <div className={`gantt-bar-row cadence${focusBattle ? " is-focus-battle" : ""}`} title={`${task.text}\n长期在做 · 不占时间条`} />;
  }

  const title = `${task.displayText}\n${formatSpanLabel(task)} · 长期在推`;
  const familyClass = `family-${task.family}`;

  const pointStyle = mode === "roadmap" ? roadmapPointStyle(task, months) : milestoneStyle(task, weekCount);
  const dependencyStyle = mode === "roadmap" && dependency ? roadmapDependencyStyle(task, dependency, months) : null;

  if (task.marker === "star" || task.marker === "flag" || task.marker === "diamond" || task.marker === "dot") {
    return (
      <div className={`gantt-bar-row${focusBattle ? " is-focus-battle" : ""}`}>
        {dependencyStyle ? <i className="gantt-dependency-line" style={dependencyStyle} aria-hidden="true" /> : null}
        <div
          className={`gantt-milestone ${familyClass} visual-${task.visual} marker-${task.marker}`}
          style={pointStyle}
          title={title}
        >
          <i aria-hidden="true">{task.marker === "flag" ? "▼" : task.marker === "diamond" ? "◆" : task.marker === "dot" ? "•" : "★"}</i>
        </div>
      </div>
    );
  }

  const style = mode === "roadmap" ? roadmapBarStyle(task, months) : barStyle(task, weekCount);
  const widthPct = Number.parseFloat(style.width);
  // 太短的条不塞标题，避免挤爆；完整文案在左侧列表与 title。
  const unitCount = mode === "roadmap" ? months.length : weekCount;
  const showLabel = Number.isFinite(widthPct) && widthPct >= 100 / Math.max(unitCount, 1) * 0.55;

  return (
    <div className={`gantt-bar-row${focusBattle ? " is-focus-battle" : ""}`}>
      {dependencyStyle ? <i className="gantt-dependency-line" style={dependencyStyle} aria-hidden="true" /> : null}
      <div
        className={`gantt-bar ${familyClass} visual-${task.visual}${task.kind === "phase" ? " is-phase" : ""}${focusBattle ? " is-focus-battle" : ""}${showLabel ? "" : " unlabeled"}`}
        style={style}
        title={title}
      >
        {showLabel ? <span>{task.displayText}</span> : null}
      </div>
    </div>
  );
}

function RoutineAxisRow({ series, weekCount, mode, months }: { series: GanttRoutineSeries; weekCount: number; mode: TimelineMode; months: RoadmapMonth[] }) {
  return (
    <div className="gantt-bar-row routine">
      <div className={`gantt-routine-track family-${series.family}`}>
        {series.points.map((point) => (
          <div
            key={`${series.id}:${point.date}`}
            className={`gantt-milestone family-${series.family} visual-${point.visual} marker-star routine-star`}
            style={mode === "roadmap" ? { left: `${roadmapDateCenterLeft(point.date, months)}%` } : routinePointStyle(point, weekCount)}
            title={`${series.displayText}\n${point.date.slice(5).replace("-", "/")} · 例行`}
          >
            <i aria-hidden="true">★</i>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoadmapHead({ months, todayLeft }: { months: RoadmapMonth[]; todayLeft: number }) {
  return (
    <div className="gantt-month-head" style={{ "--gantt-months": months.length } as React.CSSProperties}>
      <div className="gantt-today-line gantt-today-line-head" style={{ left: `${todayLeft}%` }} aria-hidden="true"><i /></div>
      {months.map((month) => (
        <div className="gantt-month-col" key={month.key}>
          {month.yearLabel ? <small>{month.yearLabel}</small> : null}
          <strong>{month.label}</strong>
        </div>
      ))}
    </div>
  );
}

const LIFE_CATEGORY_HEIGHT = 36;
const LIFE_EVENT_HEIGHT = 36;

function lifeCategoryHeight(group: LifeEventGroup, open: boolean) {
  return LIFE_CATEGORY_HEIGHT + (open ? group.events.length * LIFE_EVENT_HEIGHT : 0);
}

function CalendarEventSidebarRow({ event }: { event: CalendarEvent }) {
  return <div className="gantt-task-row calendar-event-readonly" title={`${event.title}\n${eventTimeLabel(event)}`}>
    <span aria-hidden="true" />
    <span><em className="gantt-kind-badge">事件</em>{event.title}</span>
  </div>;
}

function calendarEventVisual(event: CalendarEvent, todayKey: string) {
  const { start, end } = eventDays(event);
  if (end < todayKey) return "done";
  if (start > todayKey) return "future";
  return "active";
}

function CalendarEventAxisRow({ event, family, todayKey, months, firstWeek, weekCount, mode }: {
  event: CalendarEvent;
  family: "work" | "cultivate" | "life" | "mist";
  todayKey: string;
  months: RoadmapMonth[];
  firstWeek: string;
  weekCount: number;
  mode: TimelineMode;
}) {
  return <div className="gantt-bar-row">
    <div
      className={`gantt-milestone family-${family} visual-${calendarEventVisual(event, todayKey)} marker-star`}
      style={eventAxisPointStyle(event, months, firstWeek, weekCount, mode)}
      title={`${event.title}\n${eventTimeLabel(event)} · 苹果日历`}
    ><i aria-hidden="true">★</i></div>
  </div>;
}

function CompanyTravelSidebar({ group, open, onToggle, onHide }: {
  group: CompanyTravelGroup;
  open: boolean;
  onToggle: () => void;
  onHide: () => void;
}) {
  return <div className={`calendar-company-travel${open ? " is-open" : ""}`} style={{ height: LIFE_CATEGORY_HEIGHT + (open ? group.events.length * LIFE_EVENT_HEIGHT : 0) }}>
    <div className="gantt-task-row calendar-company-travel-head">
      <button type="button" className={`gantt-stage-toggle${open ? " is-open" : ""}`} aria-expanded={open} onClick={onToggle} title={open ? "收起差旅行程" : `展开 ${group.events.length} 个差旅行程`}>
        <ChevronRight size={12} aria-hidden />
      </button>
      <HideEyeButton label={group.task.displayText} onHide={onHide} />
      <span title={`${group.task.displayText}\n${formatSpanLabel(group.task)}`}>
        <em className="gantt-kind-badge">差旅</em>{group.task.displayText}
        <small className="calendar-company-travel-span">{formatSpanLabel(group.task)}</small>
      </span>
    </div>
    <div className="calendar-company-travel-events" aria-hidden={!open}>
      {group.events.map((event, index) => {
        const displayLabel = companyTravelEventLabel(event);
        return <div
          className="gantt-task-row calendar-life-row"
          style={{ transitionDelay: `${index * 18}ms` }}
          key={eventKey(event)}
          title={`${displayLabel}\n${eventTimeLabel(event)}`}
        >
          <span aria-hidden="true" />
          <span><em className="gantt-kind-badge">事件</em>{displayLabel}</span>
        </div>;
      })}
    </div>
  </div>;
}

function CompanyTravelAxis({ group, open, months, firstWeek, weekCount, mode, todayKey }: {
  group: CompanyTravelGroup;
  open: boolean;
  months: RoadmapMonth[];
  firstWeek: string;
  weekCount: number;
  mode: TimelineMode;
  todayKey: string;
}) {
  const offsets = calendarMarkerStackOffsets(group.events, mode);
  return <div className={`calendar-company-travel-axis${open ? " is-open" : ""}`} style={{ height: LIFE_CATEGORY_HEIGHT + (open ? group.events.length * LIFE_EVENT_HEIGHT : 0) }}>
    <AxisGlyph task={group.task} weekCount={weekCount} mode={mode} months={months} />
    {group.events.map((event, index) => <div className="gantt-bar-row calendar-company-travel-event-axis-row" style={{ top: LIFE_CATEGORY_HEIGHT + index * LIFE_EVENT_HEIGHT }} key={`row:${eventKey(event)}`} />)}
    {group.events.map((event, index) => {
      const offset = offsets[index] || { x: 0, y: 0 };
      const displayLabel = companyTravelEventLabel(event);
      return <span
        className="calendar-event-marker-slot calendar-company-travel-marker"
        style={{
          ...eventAxisPointStyle(event, months, firstWeek, weekCount, mode),
          top: open ? LIFE_CATEGORY_HEIGHT + index * LIFE_EVENT_HEIGHT : 0,
          marginLeft: open ? 0 : offset.x,
          transform: open ? undefined : `translateY(${offset.y}px)`,
        }}
        key={eventKey(event)}
        title={`${displayLabel}\n${eventTimeLabel(event)}`}
      ><span className={`gantt-milestone family-work visual-${calendarEventVisual(event, todayKey)} marker-star routine-star`}><i aria-hidden="true">★</i></span></span>;
    })}
  </div>;
}

function LifeCalendarSidebar({ groups, expanded, loading, available, stale, onToggle }: {
  groups: LifeEventGroup[];
  expanded: Record<string, boolean>;
  loading: boolean;
  available: boolean;
  stale?: boolean;
  onToggle: (id: string, open: boolean) => void;
}) {
  if (!groups.length) {
    return <div className="calendar-life-empty">{loading ? "正在读取行程…" : !available || stale ? "日历暂未同步" : "近期没有生活行程"}</div>;
  }
  return <>{groups.map((group) => {
    const open = expanded[group.id] ?? lifeCategoryDefaultOpen(group);
    return <div className={`calendar-life-category${open ? " is-open" : ""}`} style={{ height: lifeCategoryHeight(group, open) }} key={group.id}>
      <div className="gantt-task-row calendar-life-category-head">
        <button type="button" className={`gantt-stage-toggle${open ? " is-open" : ""}`} aria-expanded={open} onClick={() => onToggle(group.id, open)} title={open ? `收起${group.label}` : `展开${group.label}`}>
          <ChevronRight size={12} aria-hidden />
        </button>
        <button type="button" className="calendar-life-category-label" aria-expanded={open} onClick={() => onToggle(group.id, open)}>
          {group.label}<small>{group.events.length}</small>
        </button>
      </div>
      <div className="calendar-life-events" aria-hidden={!open}>
        {group.events.map((event, index) => <div
          className="gantt-task-row calendar-life-row"
          style={{ transitionDelay: `${index * 18}ms` }}
          key={eventKey(event)}
          title={`${event.title}\n${eventTimeLabel(event)}`}
        >
          <span aria-hidden="true" />
          <span><em className="gantt-kind-badge">事件</em>{event.title}</span>
        </div>)}
      </div>
    </div>;
  })}</>;
}

function LifeCalendarAxis({ groups, expanded, months, firstWeek, weekCount, mode, todayKey }: {
  groups: LifeEventGroup[];
  expanded: Record<string, boolean>;
  months: RoadmapMonth[];
  firstWeek: string;
  weekCount: number;
  mode: TimelineMode;
  todayKey: string;
}) {
  if (!groups.length) return <div className="calendar-life-axis-empty" />;
  return <>{groups.map((group) => {
    const open = expanded[group.id] ?? lifeCategoryDefaultOpen(group);
    return <div className={`calendar-life-category-axis${open ? " is-open" : ""}`} style={{ height: lifeCategoryHeight(group, open) }} key={group.id}>
      <div className="gantt-bar-row calendar-life-axis-row" />
      {group.events.map((event, index) => <div className="gantt-bar-row calendar-life-axis-row calendar-life-event-axis-row" style={{ top: LIFE_CATEGORY_HEIGHT + index * LIFE_EVENT_HEIGHT }} key={`row:${eventKey(event)}`} />)}
      {group.events.map((event, index) => <span
        className="calendar-event-marker-slot"
        style={{
          ...eventAxisPointStyle(event, months, firstWeek, weekCount, mode),
          top: open ? LIFE_CATEGORY_HEIGHT + index * LIFE_EVENT_HEIGHT : 0,
        }}
        key={eventKey(event)}
        title={`${event.title}\n${eventTimeLabel(event)}`}
      ><span className={`gantt-milestone family-life visual-${calendarEventVisual(event, todayKey)} marker-star routine-star`}><i aria-hidden="true">★</i></span></span>)}
    </div>;
  })}</>;
}

export default function SchedulePage({ data, onWritePreview, calendarSignal, active = true }: { data: WorkbenchSummary; onWritePreview: (action: WriteAction) => Promise<void>; calendarSignal?: CalendarSnapshot; onCalendarChanged?: () => void; active?: boolean }) {
  const todayKey = tokyoDateKey(new Date());
  const [activeSection, setActiveSection] = useState<ScheduleSectionId>(() => scheduleSectionFromLocation());
  const range = useMemo(() => calendarRange(todayKey.slice(0, 7)), [todayKey]);
  const { snapshot: lifeCalendar } = useLifeCalendar(range.from, range.to, active && activeSection === "roadmap", `${calendarSignal?.revision || ""}:${calendarSignal?.refreshedAt || ""}:${calendarSignal?.permission || ""}`);
  const appointments = useMemo(() => lifeEvents(lifeCalendar.events, range.from, range.to), [lifeCalendar.events, range.from, range.to]);
  const appointmentLanes = useMemo(() => calendarEventsByLane(appointments), [appointments]);
  const lifeGroups = useMemo(() => groupLifeEvents(appointmentLanes.life), [appointmentLanes.life]);
  const [expandedLifeCategories, setExpandedLifeCategories] = useState<Record<string, boolean>>({});
  const [expandedCompanyTravel, setExpandedCompanyTravel] = useState<Record<string, boolean>>({});
  const [japanHomeRequest, setJapanHomeRequest] = useState(0);
  const [hiddenTexts, setHiddenTexts] = useState<string[]>([]);
  const [hiddenSaving, setHiddenSaving] = useState(false);
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("weeks");
  const [writingTodoId, setWritingTodoId] = useState<string | null>(null);
  const [allTodosOpen, setAllTodosOpen] = useState(() => readScheduleTodosOpen());
  const [followedTaskKeys, setFollowedTaskKeys] = useState<string[]>([]);
  const [savingFollowKey, setSavingFollowKey] = useState<string | null>(null);
  const [followError, setFollowError] = useState("");
  const [fullProjectManagement, setFullProjectManagement] = useState<ProjectManagementSnapshot | null>(null);
  const [recentlyCompletedProjectTodos, setRecentlyCompletedProjectTodos] = useState<RecentlyCompletedProjectTodo[]>([]);

  useEffect(() => {
    const sync = () => setActiveSection(scheduleSectionFromLocation());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    jsonFetch<GanttHiddenState>("/api/gantt-hidden")
      .then((payload) => setHiddenTexts(payload.texts || []))
      .catch(() => setHiddenTexts([]));
  }, []);

  useEffect(() => {
    jsonFetch<ProjectTaskFollowState>("/api/project-task-follows")
      .then((payload) => setFollowedTaskKeys(payload.taskKeys || []))
      .catch(() => setFollowedTaskKeys([]));
  }, []);

  useEffect(() => {
    let disposed = false;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const snapshot = await jsonFetch<ProjectManagementSnapshot>("/api/project-management", { cache: "no-store" });
        if (!disposed) setFullProjectManagement(snapshot);
      } catch {
        // 短暂刷新失败时保留上一份可信快照，下一轮继续读取原件。
      } finally {
        loading = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    void load();
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [data.generatedAt]);

  const hiddenKeys = useMemo(
    () => new Set(hiddenTexts.map((text) => normalizeTodoKey(text)).filter(Boolean)),
    [hiddenTexts],
  );

  const persistHidden = async (texts: string[]) => {
    setHiddenTexts(texts);
    setHiddenSaving(true);
    try {
      const next = await jsonFetch<GanttHiddenState>("/api/gantt-hidden", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
      });
      setHiddenTexts(next.texts || []);
    } catch {
      const fresh = await jsonFetch<GanttHiddenState>("/api/gantt-hidden").catch(() => ({ texts: [] as string[] }));
      setHiddenTexts(fresh.texts || []);
    } finally {
      setHiddenSaving(false);
    }
  };

  const hideText = (text: string) => {
    const key = normalizeTodoKey(text);
    if (!key || hiddenKeys.has(key)) return;
    void persistHidden([...hiddenTexts, text]);
  };

  const projectDestinationByTaskKey = useMemo(() => {
    const destinations = new Map<string, ScheduleTaskDestination>();
    for (const project of fullProjectManagement?.projects || []) {
      for (const task of [...(project.management?.doing || []), ...(project.management?.next || [])]) {
        const destination = taskDestination(project, task);
        if (destination) destinations.set(projectTaskKey(task), destination);
      }
    }
    return destinations;
  }, [fullProjectManagement]);

  const weekTodos = useMemo(() => {
    if (fullProjectManagement || data.projectManagement) {
      const sourceTasks = fullProjectManagement?.currentTodos || data.projectManagement?.currentTodos || [];
      return buildCurrentExecutionRows(sourceTasks, todayKey);
    }
    // 旧服务过渡回退：同样保留逾期与今明任务，普通待办缺省按 C。
    return data.todo.today.flatMap((item, index): WeekTodoRow[] => {
      if (item.done || !isTodoInNextTwoTokyoDays(item.text, todayKey)) return [];
      const priority = parseQuadrant(item.text)?.id || "C";
      const span = parseTaskDates(item.text, todayKey);
      const date = span ? { start: span.start, end: span.end, label: span.start === span.end ? span.start : `${span.start}–${span.end}` } : undefined;
      const taskLike = { done: false, priority, date: date || null };
      return [{
        id: `central:${index}:${item.text}`,
        source: "central",
        text: item.text,
        displayText: stripTaskDecorators(item.text),
        kind: parseTaskKind(item.text).kind,
        baselineQuadrant: priority,
        quadrant: effectiveTaskQuadrant(taskLike, todayKey),
        done: false,
        date,
      }];
    });
  }, [data.projectManagement, data.todo.today, fullProjectManagement, projectDestinationByTaskKey, todayKey]);
  const aiTodos = useMemo(() => {
    const sourceTasks = fullProjectManagement?.currentTodos || data.projectManagement?.currentTodos || [];
    return buildAiExecutionRows(sourceTasks);
  }, [data.projectManagement, fullProjectManagement]);
  const currentTodoWarnings = data.projectManagement?.warnings.filter((warning) => warning.code === "DUPLICATE_TASK_ID") ?? [];
  const quadrantGroups = useMemo(() => groupWeekTodosByQuadrant(weekTodos), [weekTodos]);
  const weekOpenCount = weekTodos.filter((item) => !item.done).length + aiTodos.length;
  const currentProjectTodoGroups = useMemo(
    () => fullProjectManagement ? buildAllProjectTodoGroups(fullProjectManagement) : [],
    [fullProjectManagement],
  );
  const allProjectTodoGroups = useMemo(
    () => retainRecentlyCompletedProjectTodos(
      currentProjectTodoGroups,
      recentlyCompletedProjectTodos,
      resolveUmbrellaProject(fullProjectManagement),
    ),
    [currentProjectTodoGroups, fullProjectManagement, recentlyCompletedProjectTodos],
  );
  const unresolvedProjectTodoCount = useMemo(() => {
    if (!fullProjectManagement) return 0;
    const allTasks = buildAllProjectTodoGroups(fullProjectManagement).flatMap((group) => group.tasks);
    return allTasks.filter((task) => !projectDestinationByTaskKey.has(projectTaskKey(task))).length;
  }, [fullProjectManagement, projectDestinationByTaskKey]);
  const fallbackProjectTodoCount = useMemo(() => {
    if (!fullProjectManagement) return 0;
    const allTasks = buildAllProjectTodoGroups(fullProjectManagement).flatMap((group) => group.tasks);
    return allTasks.filter((task) => projectDestinationByTaskKey.get(projectTaskKey(task))?.fallback).length;
  }, [fullProjectManagement, projectDestinationByTaskKey]);
  const allProjectTodoCount = useMemo(
    () => allProjectTodoGroups.reduce((sum, group) => sum + group.tasks.length, 0),
    [allProjectTodoGroups],
  );
  const currentFollowableKeys = useMemo(
    () => new Set(allProjectTodoGroups.flatMap((group) => group.tasks.flatMap((task) => task.followKey ? [task.followKey] : []))),
    [allProjectTodoGroups],
  );
  const followedKeySet = useMemo(() => new Set(followedTaskKeys), [followedTaskKeys]);
  const followedCurrentCount = useMemo(
    () => followedTaskKeys.filter((key) => currentFollowableKeys.has(key)).length,
    [currentFollowableKeys, followedTaskKeys],
  );

  const toggleTaskFollow = async (taskKey: string, followed: boolean) => {
    if (savingFollowKey) return;
    setSavingFollowKey(taskKey);
    setFollowError("");
    try {
      const next = await jsonFetch<ProjectTaskFollowState>("/api/project-task-follows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskKey, followed: !followed }),
      });
      setFollowedTaskKeys(next.taskKeys || []);
    } catch {
      const fresh = await jsonFetch<ProjectTaskFollowState>("/api/project-task-follows").catch(() => ({ taskKeys: [] as string[] }));
      setFollowedTaskKeys(fresh.taskKeys || []);
      setFollowError("关注状态没有保存，请稍后再试。");
    } finally {
      setSavingFollowKey(null);
    }
  };

  const writeTodo = async (item: WeekTodoRow, action: WriteAction) => {
    if (!item.writeTarget || writingTodoId) return;
    setWritingTodoId(item.id);
    try {
      await onWritePreview(action);
    } finally {
      setWritingTodoId(null);
    }
  };

  const writeProjectTodo = async (task: ProjectManagementTask, action: WriteAction, project?: { projectId: string; projectName: string }) => {
    if (!task.writable || writingTodoId) return;
    const actionId = `${task.sourcePath}:${task.id}`;
    setWritingTodoId(actionId);
    try {
      await onWritePreview(action);
      if (action.kind === "toggleTodo" && project) {
        setRecentlyCompletedProjectTodos((current) => action.expectedDone
          ? current.filter((item) => `${item.projectId}:${item.task.id}` !== `${project.projectId}:${task.id}`)
          : [...current.filter((item) => `${item.projectId}:${item.task.id}` !== `${project.projectId}:${task.id}`), {
              projectId: project.projectId,
              projectName: project.projectName,
              task,
            }]);
      }
    } finally {
      setWritingTodoId(null);
    }
  };

  const focusBattleProjects = fullProjectManagement?.projects || data.projectManagement?.projects || [];
  const focusBattleItems = useMemo(() => focusBattleGanttItems(focusBattleProjects), [focusBattleProjects]);
  const focusBattleIds = useMemo(() => focusBattleIdSet(focusBattleProjects), [focusBattleProjects]);

  // 主线甘特读取中央「长期在推」与项目大作战的同一稳定 ID；最近两天待办仍单独在上层。
  const model = useMemo(
    () => buildGanttModel({
      today: [],
      longTerm: [...focusBattleItems, ...data.todo.longTerm],
      mainlines: data.todo.mainlines,
      windowStartKey: range.firstDay,
      windowEndKey: range.lastDay,
    }),
    [data.todo.longTerm, data.todo.mainlines, focusBattleItems, range.firstDay, range.lastDay],
  );
  const headXRef = useRef<HTMLDivElement | null>(null);
  const bodyXRef = useRef<HTMLDivElement | null>(null);
  const syncingX = useRef(false);
  const [todoCollapsed, setTodoCollapsed] = useState(false);
  const [focusedQuadrant, setFocusedQuadrant] = useState<QuadrantId | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>({});

  const openProjectDestination = (destination: string) => {
    rememberTodoReturnLocation(currentWorkbenchLocation());
    const url = new URL(destination, window.location.origin);
    url.searchParams.set("from", "todo");
    navigate(`${url.pathname}${url.search}`);
  };

  const toggleAllTodos = () => {
    const next = !allTodosOpen;
    if (!next) setRecentlyCompletedProjectTodos([]);
    setAllTodosOpen(next);
    writeScheduleTodosOpen(next);
  };

  const openScheduleSection = (section: ScheduleSectionId) => {
    if (section === "japan" && activeSection === "japan") {
      setJapanHomeRequest((request) => request + 1);
    }
    setActiveSection(section);
    const params = new URLSearchParams(window.location.search);
    if (section === "today") params.delete("view");
    else params.set("view", section);
    const query = params.toString();
    navigate(`/schedule${query ? `?${query}` : ""}`);
  };

  const syncAxisX = (source: "head" | "body") => {
    if (syncingX.current) return;
    const head = headXRef.current;
    const body = bodyXRef.current;
    if (!head || !body) return;
    const left = source === "head" ? head.scrollLeft : body.scrollLeft;
    syncingX.current = true;
    if (source === "head") body.scrollLeft = left;
    else head.scrollLeft = left;
    requestAnimationFrame(() => {
      syncingX.current = false;
    });
  };

  const scrollToToday = () => {
    const marker = bodyXRef.current?.querySelector<HTMLElement>(".gantt-today-line");
    marker?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  };

  const weekCount = model.weeks.length;
  const roadmapMonths = useMemo(() => buildRoadmapMonths(model.tasks, range.firstDay, 6, range.lastDay), [model.tasks, range.firstDay, range.lastDay]);
  const todayInWindow = todayKey >= range.firstDay && todayKey <= range.lastDay;
  const weeklyTodayLeft = ((model.todayWeekIndex + model.todayOffset + 0.5 / 7) / Math.max(weekCount, 1)) * 100;
  const roadmapTodayLeft = roadmapDateLeft(model.todayKey, roadmapMonths);
  const todayLeft = timelineMode === "roadmap" ? roadmapTodayLeft : weeklyTodayLeft;
  const taskByPlanId = useMemo(() => {
    const index = new Map<string, GanttTask>();
    for (const task of model.tasks) if (task.planId) index.set(task.planId, task);
    return index;
  }, [model.tasks]);
  useEffect(() => {
    const battleId = new URLSearchParams(window.location.search).get("battle");
    if (activeSection !== "roadmap" || !battleId || !focusBattleIds.has(battleId)) return;
    setExpandedStages((current) => current[battleId] ? current : { ...current, [battleId]: true });
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-battle-id="${battleId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, focusBattleIds, model.tasks.length]);
  const laneRows = useMemo(() => {
    const tasksByLane = new Map<string, GanttTask[]>();
    const routinesByLane = new Map<string, GanttRoutineSeries[]>();
    for (const task of model.tasks) {
      if (task.done || hiddenKeys.has(normalizeTodoKey(task.text))) continue;
      const rows = tasksByLane.get(task.laneId) ?? [];
      rows.push(task);
      tasksByLane.set(task.laneId, rows);
    }
    for (const routine of model.routines) {
      if (routine.done || hiddenKeys.has(normalizeTodoKey(routine.text))) continue;
      const rows = routinesByLane.get(routine.laneId) ?? [];
      rows.push(routine);
      routinesByLane.set(routine.laneId, rows);
    }
    const lifeLane = model.lanes.find((lane) => lane.id === "life") || { id: "life", label: "生活事务", tone: "life" as const, priority: "" };
    return [lifeLane, ...model.lanes.filter((lane) => lane.id !== "life")]
      .map((lane) => {
        const routines = routinesByLane.get(lane.id) ?? [];
        const laneAppointments = lane.id === "company" || lane.id === "life" ? appointmentLanes[lane.id] : [];
        const deduplicatedCalendarEvents = lane.id === "company"
          ? laneAppointments.filter((event) => !routines.some((series) => {
            const eventTitle = normalizeTodoKey(event.title);
            const routineTitle = normalizeTodoKey(series.displayText);
            return eventTitle.includes(routineTitle) || routineTitle.includes(eventTitle);
          }))
          : lane.id === "life" ? [] : laneAppointments;
        const allTasks = [...(tasksByLane.get(lane.id) ?? [])].sort((left, right) => {
          const leftRank = left.planId && focusBattleIds.has(left.planId) ? 0 : left.parentId && focusBattleIds.has(left.parentId) ? 1 : 2;
          const rightRank = right.planId && focusBattleIds.has(right.planId) ? 0 : right.parentId && focusBattleIds.has(right.parentId) ? 1 : 2;
          return leftRank - rightRank || left.sourceOrder - right.sourceOrder;
        });
        const companyTravel = lane.id === "company"
          ? groupCompanyTravel(allTasks, deduplicatedCalendarEvents)
          : { groups: [] as CompanyTravelGroup[], tasks: allTasks, events: deduplicatedCalendarEvents };
        const tasks = timelineMode === "roadmap"
          ? companyTravel.tasks.filter((task) => task.depth === 0 || (task.parentId ? expandedStages[task.parentId] : false))
          : companyTravel.tasks;
        const lifeEventCount = lane.id === "life" ? appointmentLanes.life.length : 0;
        return { lane, routines, tasks, travelGroups: companyTravel.groups, calendarEvents: companyTravel.events, count: routines.length + allTasks.length + deduplicatedCalendarEvents.length + lifeEventCount };
      })
      .filter((row) => row.count > 0 || row.lane.id === "life");
  }, [model.lanes, model.routines, model.tasks, hiddenKeys, timelineMode, expandedStages, focusBattleIds, appointmentLanes]);
  const unfinished = laneRows.reduce((sum, row) => sum + row.count, 0);
  const allCollapsed = laneRows.length > 0 && laneRows.every((row) => collapsed[row.lane.id]);
  const toggleAllLanes = () => {
    if (allCollapsed) {
      setCollapsed({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const row of laneRows) next[row.lane.id] = true;
    setCollapsed(next);
  };

  const weekHead = (
    <div className="gantt-week-head" style={{ "--gantt-weeks": weekCount } as React.CSSProperties}>
      <div className="gantt-today-line gantt-today-line-head" style={{ left: `${todayLeft}%`, display: todayInWindow ? undefined : "none" }} aria-hidden="true">
        <i />
      </div>
      <div className="gantt-week-cols">
        {model.weeks.map((week) => (
          <div className={`gantt-week-col ${week.monthLabel ? "month-start" : ""}`} key={week.start}>
            <div className="gantt-week-meta">
              {week.monthLabel ? <span className="gantt-month">{week.monthLabel}</span> : null}
              <small>{week.label}</small>
            </div>
            <div className="gantt-day-ticks" aria-hidden="true">
              {week.days.map((tick) => (
                <span
                  key={tick.key}
                  className={tick.weekday === 0 || tick.weekday === 6 ? "weekend" : ""}
                >
                  {tick.day}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  const axisStyle = timelineMode === "roadmap"
    ? ({ "--gantt-months": roadmapMonths.length } as React.CSSProperties)
    : ({ "--gantt-weeks": weekCount } as React.CSSProperties);
  const timelineHead = timelineMode === "roadmap"
    ? <RoadmapHead months={roadmapMonths} todayLeft={todayInWindow ? todayLeft : -100} />
    : weekHead;

  return (
    <div className={`schedule-gantt-page${todoCollapsed ? " todo-folded" : ""}`}>
      <nav className="schedule-section-tabs" aria-label="日程安排分栏">
        {SCHEDULE_SECTIONS.map((section) => {
          const Icon = section.icon;
          const count = section.id === "today" ? weekOpenCount : section.id === "roadmap" ? unfinished : null;
          return (
            <button
              type="button"
              key={section.id}
              className={activeSection === section.id ? "is-active" : ""}
              aria-pressed={activeSection === section.id}
              onClick={() => openScheduleSection(section.id)}
            >
              <Icon size={17} aria-hidden="true" />
              <span><strong>{section.label}</strong><small>{section.hint}</small></span>
              {count != null ? <em>{count}</em> : null}
            </button>
          );
        })}
      </nav>

      {activeSection === "today" ? (
      <Card className={`schedule-todo-board${todoCollapsed ? " is-collapsed" : ""}`}>
        <header className="schedule-todo-head">
          <h2>今日事项</h2>
          <details className="schedule-todo-help"><summary>事项怎样归类</summary><p>只有具备有效自动契约的 AI 任务才单列；其余 AI 票仍按人工派发处理，需要你确认的验收会一直保留。</p></details>
          <div className="schedule-todo-meta">
            <small>{weekOpenCount} 项未完成</small>
            <button
              type="button"
              className="gantt-fold-all schedule-todo-fold"
              onClick={() => setTodoCollapsed((old) => !old)}
              aria-label={todoCollapsed ? "展开今日事项" : "折叠今日事项"}
              title={todoCollapsed ? "展开今日事项" : "折叠今日事项"}
            >
              {todoCollapsed ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
            </button>
          </div>
        </header>

        {currentTodoWarnings.length ? (
          <div className="schedule-todo-warning" role="alert">
            <AlertTriangle size={14} />
            <span>{currentTodoWarnings[0]?.message || "发现重复任务编号，请回原文件处理。"}</span>
          </div>
        ) : null}

        {!todoCollapsed ? (
          <>
            {aiTodos.length ? (
              <section className="schedule-ai-queue" aria-label="AI 自动任务">
                <header>
                  <div><Bot size={15} /><strong>AI 自动任务</strong></div>
                  <small>到期直接启动；每次运行同步当前状态与下一步，需要你时明确标出</small>
                  <span>{aiTodos.length}</span>
                </header>
                <div>
                  {aiTodos.map((item) => {
                    const destinationInfo = projectDestinationByTaskKey.get(projectTaskKey({ sourcePath: item.sourcePath, id: item.taskId }));
                    const dateLabel = scheduleDateLabel(item.date, todayKey);
                    const progressTimeLabel = aiProgressTimeLabel(item.progressUpdatedAt, todayKey);
                    const taskLabel = item.displayText.replace(/^AI·\s*/u, "");
                    const content = <>
                      <div className="ai-task-time">
                        <time>{progressTimeLabel || dateLabel || "待定"}</time>
                        {progressTimeLabel && dateLabel ? <small>原定 {dateLabel}</small> : null}
                      </div>
                      <div className="ai-task-copy">
                        <span><b>AI·</b> {taskLabel}</span>
                        {item.currentState ? <small className="ai-task-progress"><em>当前</em>{item.currentState}</small> : null}
                        {item.nextAction ? <small className="ai-task-next"><em>下一步</em>{item.nextAction}</small> : null}
                      </div>
                      <small className={`ai-execution-status is-${item.executionStatus}`}>{item.executionStatus === "ran-failed" && !item.nextAction ? "未通过 · 待补计划" : AI_EXECUTION_LABEL[item.executionStatus]}</small>
                      {item.projectName ? <small className="ai-task-project">{item.projectName}</small> : null}
                    </>;
                    return destinationInfo?.path ? (
                      <button type="button" key={item.id} onClick={() => openProjectDestination(destinationInfo.path)}>{content}</button>
                    ) : <div key={item.id}>{content}</div>;
                  })}
                </div>
              </section>
            ) : null}
            {weekTodos.length ? (
              <div className="schedule-quadrant-grid" aria-label="四象限待办">
              {quadrantGroups.map((group) => {
                const focused = focusedQuadrant === group.id;
                return (
                  <section
                    className={`schedule-quadrant tone-${group.id.toLowerCase()}${focused ? " is-focused" : ""}${!group.items.length ? " is-empty" : ""}`}
                    key={group.id}
                    aria-label={group.label}
                    aria-current={focused ? "true" : undefined}
                    aria-expanded={focused}
                    tabIndex={0}
                    onClick={() => setFocusedQuadrant((old) => (old === group.id ? null : group.id))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setFocusedQuadrant((old) => (old === group.id ? null : group.id));
                      }
                    }}
                  >
                    <header className="schedule-quadrant-head">
                      <strong>{group.label}</strong>
                      <small>{group.hint}</small>
                      <span>{group.items.length}</span>
                    </header>
                    {group.items.length ? (
                      <div className="schedule-todo-rows">
                        {group.items.map((item) => {
                          const badge = todoListBadge(item);
                          const writing = writingTodoId === item.id;
                          const destinationInfo = item.writeTarget
                            ? projectDestinationByTaskKey.get(projectTaskKey({ sourcePath: item.writeTarget.sourcePath, id: item.writeTarget.taskId }))
                            : null;
                          const destination = destinationInfo?.path || null;
                          const dateLabel = scheduleDateLabel(item.date, todayKey) || item.whenLabel;
                          const todoMain = (
                            <>
                              {badge ? <em className="gantt-kind-badge">{badge}</em> : null}
                              {dateLabel ? <time className="schedule-todo-when">{dateLabel}</time> : null}
                              <span className="schedule-todo-title">{item.displayText}</span>
                              {item.projectName ? <small className="schedule-todo-origin">{item.projectName}</small> : null}
                              {item.source === "project" && destinationInfo?.fallback ? <small className="schedule-todo-origin schedule-todo-origin-unlinked">事业主页</small> : null}
                            </>
                          );
                          return (
                            <div className={`schedule-todo-row${item.done ? " is-completed" : ""}`} key={item.id}>
                              {item.writeTarget ? (
                                <button
                                  type="button"
                                  className={`schedule-todo-check ${item.done ? "is-confirmed" : "is-pending"}`}
                                  aria-label={item.done ? `恢复：${item.displayText}` : `完成：${item.displayText}`}
                                  title={item.done ? "恢复为未完成" : "标记完成"}
                                  disabled={Boolean(writingTodoId)}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void writeTodo(item, {
                                      kind: "toggleTodo",
                                      sourcePath: item.writeTarget!.sourcePath,
                                      id: item.writeTarget!.taskId,
                                      expectedDone: item.done,
                                    });
                                  }}
                                >
                                  {writing ? <LoaderCircle className="is-spinning" size={14} /> : item.done ? <Check size={14} /> : <CircleDashed size={14} />}
                                </button>
                              ) : null}
                              {destination ? (
                                <button
                                  type="button"
                                  className="schedule-todo-main schedule-todo-main-link"
                                  title={`打开${item.projectName}事业项目`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openProjectDestination(destination);
                                  }}
                                >
                                  {todoMain}
                                </button>
                              ) : (
                                <span className="schedule-todo-main schedule-todo-main-unlinked" title="此待办暂未关联具体项目功能">
                                  {todoMain}
                                </span>
                              )}
                              {focused && item.writeTarget && !item.done ? (
                                <span className="schedule-priority-picker" role="group" aria-label={`调整“${item.displayText}”的等级`}>
                                  {TODO_PRIORITIES.map((priority) => (
                                    <button
                                      type="button"
                                      key={priority}
                                      className={`tone-${priority.toLowerCase()}${item.quadrant === priority ? " is-active" : ""}`}
                                      aria-pressed={item.quadrant === priority}
                                      disabled={Boolean(writingTodoId)}
                                      title={item.quadrant === priority ? `当前 ${priority} 级` : `改为 ${priority} 级`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        if (item.quadrant === priority) return;
                                        void writeTodo(item, {
                                          kind: "setTodoPriority",
                                          sourcePath: item.writeTarget!.sourcePath,
                                          id: item.writeTarget!.taskId,
                                          expectedDone: item.done,
                                          expectedPriority: item.writeTarget!.expectedPriority,
                                          priority,
                                        });
                                      }}
                                    >{priority}</button>
                                  ))}
                                </span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="schedule-quadrant-empty">暂时没有</p>
                    )}
                  </section>
                );
              })}
              </div>
            ) : (
              <Empty>{aiTodos.length ? "现在没有需要你确认的事项。" : "近 2 日没有需要提醒的任务。远期事项到时会自动出现。"}</Empty>
            )}

            <section className={`schedule-all-todos-shell${allTodosOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className={`schedule-all-todos-trigger${allTodosOpen ? " is-open" : ""}`}
                aria-expanded={allTodosOpen}
                aria-controls="schedule-all-project-todos"
                onClick={toggleAllTodos}
              >
                <span className="schedule-all-todos-trigger-mark" aria-hidden="true">全</span>
                <strong>全部待办</strong>
                <small>{allProjectTodoCount} 项</small>
                {followedCurrentCount ? <em>★ {followedCurrentCount} 项关注</em> : <em>按项目展开</em>}
                <ChevronDown size={16} aria-hidden="true" />
              </button>

              {allTodosOpen ? (
              <div className="schedule-all-todos" id="schedule-all-project-todos" aria-label="全部项目待办">
                <header>
                  <div>
                    <strong>按项目分组</strong>
                    <small>
                      {unresolvedProjectTodoCount
                        ? `${unresolvedProjectTodoCount} 项没有可用事业入口，仍保留在待办中`
                        : fallbackProjectTodoCount
                          ? `${fallbackProjectTodoCount} 项暂未登记具体功能或工作线，点击进入事业主页`
                          : recentlyCompletedProjectTodos.length
                            ? "刚完成的事项保留到折叠，可随时恢复"
                            : "对不上项目的，归入小秘书"}
                    </small>
                  </div>
                  {followError ? <span role="alert">{followError}</span> : null}
                </header>
                {allProjectTodoGroups.length ? (
                  <div className="schedule-all-todos-list">
                    {allProjectTodoGroups.map((group) => (
                      <section
                        className={`schedule-all-todo-group${isUmbrellaProject(group) ? " is-umbrella" : ""}`}
                        key={group.projectId}
                        aria-label={`${group.projectName}待办`}
                      >
                        <header>
                          <strong>{group.projectName}</strong>
                          <small>{group.tasks.length} 项</small>
                        </header>
                        {group.tasks.map((task) => {
                        const followed = Boolean(task.followKey && followedKeySet.has(task.followKey));
                        const saving = task.followKey === savingFollowKey;
                        const writing = writingTodoId === `${task.sourcePath}:${task.id}`;
                        const destinationInfo = projectDestinationByTaskKey.get(projectTaskKey(task));
                        const destination = destinationInfo?.path;
                        const followTitle = task.followKey
                          ? followed ? "取消关注" : "添加关注"
                          : "此待办暂未分配编号，暂时不能关注";
                        const isBoundAiTask = task.automationMode === "automatic" && task.automationContractStatus === "valid";
                        const effectivePriority = effectiveTaskQuadrant(task, todayKey);
                        const when = scheduleDateLabel(task.date, todayKey);
                        return (
                          <article className={`schedule-all-todo-row${task.recentlyCompleted ? " is-recently-completed" : ""}`} key={`${group.projectId}:${task.id}:${task.section}`}>
                            <button
                              type="button"
                              className={`schedule-follow-star${followed ? " is-followed" : ""}`}
                              aria-label={`${followTitle}：${task.displayText}`}
                              aria-pressed={followed}
                              title={followTitle}
                              disabled={!task.followKey || Boolean(savingFollowKey)}
                              onClick={() => task.followKey && void toggleTaskFollow(task.followKey, followed)}
                            >
                              {saving ? <LoaderCircle className="is-spinning" size={15} /> : followed ? "★" : "☆"}
                            </button>
                            {task.writable ? (
                              <button
                                type="button"
                                className={`schedule-todo-check schedule-all-todo-check ${task.done ? "is-confirmed" : "is-pending"}`}
                                aria-label={`${task.done ? "恢复未完成" : "完成"}：${task.displayText}`}
                                title={task.done ? "恢复未完成" : "标记完成"}
                                disabled={Boolean(writingTodoId)}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void writeProjectTodo(task, {
                                    kind: "toggleTodo",
                                    sourcePath: task.sourcePath,
                                    id: task.id,
                                    expectedDone: task.done,
                                  }, { projectId: group.projectId, projectName: group.projectName });
                                }}
                              >
                                {writing ? <LoaderCircle className="is-spinning" size={14} /> : task.done ? <><Check size={14} /><span>恢复未完成</span></> : <CircleDashed size={14} />}
                              </button>
                            ) : null}
                            <div className="schedule-all-todo-copy">
                              {destination ? (
                                <button
                                  type="button"
                                  className="schedule-all-todo-text-link"
                                  title={destinationInfo?.fallback ? "暂未登记具体功能或工作线，打开事业主页" : "打开对应的功能或工作线"}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openProjectDestination(destination);
                                  }}
                                >
                                  <p>{task.displayText}</p>
                                </button>
                              ) : (
                                <div>
                                  <p className="schedule-all-todo-text-unlinked">{task.displayText}</p>
                                  <small><span>没有可用事业入口</span></small>
                                </div>
                              )}
                              <small>
                                <time className={when ? undefined : "is-unscheduled"}>
                                  {when || (/^AI·\s*/u.test(task.displayText) ? "AI 储备 · 待排期" : "待排期")}
                                </time>
                              </small>
                            </div>
                            {task.writable && !task.done && !isBoundAiTask ? (
                              <span className="schedule-priority-picker schedule-all-todo-priority-picker" role="group" aria-label={`调整“${task.displayText}”的等级`}>
                                {TODO_PRIORITIES.map((priority) => (
                                  <button
                                    type="button"
                                    key={priority}
                                    className={`tone-${priority.toLowerCase()}${effectivePriority === priority ? " is-active" : ""}`}
                                    aria-pressed={effectivePriority === priority}
                                    disabled={Boolean(writingTodoId)}
                                    title={effectivePriority === priority ? `当前 ${priority} 级` : `改为 ${priority} 级`}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (effectivePriority === priority) return;
                                      void writeProjectTodo(task, {
                                        kind: "setTodoPriority",
                                        sourcePath: task.sourcePath,
                                        id: task.id,
                                        expectedDone: task.done,
                                        expectedPriority: task.priority,
                                        priority,
                                      });
                                    }}
                                  >{priority}</button>
                                ))}
                              </span>
                            ) : null}
                          </article>
                        );
                        })}
                      </section>
                    ))}
                  </div>
                ) : <Empty>当前没有未完成的项目待办。</Empty>}
              </div>
              ) : null}
            </section>
          </>
        ) : null}

        <footer className="schedule-todo-foot">
          <span>{todoCollapsed ? "今日事项已折叠" : "完成勾选与优先级调整会自动保存同步"}</span>
        </footer>
      </Card>
      ) : null}

      {activeSection === "roadmap" ? (
      <Card className="gantt-board">
        <header className="gantt-board-head">
          <div>
            <h2>主线进度</h2>
            <p>{timelineMode === "roadmap" ? "生活安排与长期主线共用这条时间轴。" : "按日查看近期行程与排期。"}</p>
          </div>
          <div className="gantt-board-meta">
            <small>{unfinished} 项在看</small>
            <div className="gantt-view-switch" role="group" aria-label="时间轴尺度">
              <button type="button" aria-pressed={timelineMode === "weeks"} onClick={() => setTimelineMode("weeks")}><CalendarDays size={13} />周排期</button>
              <button type="button" aria-pressed={timelineMode === "roadmap"} onClick={() => setTimelineMode("roadmap")}><Route size={13} />路线图</button>
            </div>
          </div>
        </header>

        <div className="gantt-frame">
          <div className="gantt-head-pair">
            <div className="gantt-corner">
              <div className="gantt-corner-actions">
                <button
                  type="button"
                  className="gantt-fold-all"
                  onClick={() => {
                    if (!hiddenTexts.length) return;
                    void persistHidden([]);
                  }}
                  disabled={!hiddenTexts.length || hiddenSaving}
                  aria-label="显示隐藏的事项"
                  title={hiddenTexts.length ? `把已藏起的 ${hiddenTexts.length} 项全部重新显示` : "当前没有藏起的事项"}
                >
                  <Eye size={12} />
                  <span>显示隐藏</span>
                </button>
                <button
                  type="button"
                  className="gantt-fold-all"
                  onClick={toggleAllLanes}
                  disabled={!laneRows.length}
                  aria-label={allCollapsed ? "展开全部项目" : "折叠全部项目"}
                  title={allCollapsed ? "展开全部项目" : "折叠全部项目"}
                >
                  {allCollapsed ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
                  <span>{allCollapsed ? "展开" : "折叠"}</span>
                </button>
                <button type="button" className="gantt-today-jump" onClick={scrollToToday} aria-label="回到今天" title="回到今天">
                  <i />
                  <span>今天</span>
                </button>
              </div>
              <div className="gantt-corner-labels">
                <span>项目 / 事项</span>
                <small>{timelineMode === "roadmap" ? "月度" : "按日"}</small>
              </div>
            </div>
            <div className="gantt-head-x" ref={headXRef} onScroll={() => syncAxisX("head")}>
              <div className={`gantt-axis gantt-axis-head is-${timelineMode}`} style={axisStyle}>
                {timelineHead}
              </div>
            </div>
          </div>

          <div className="gantt-body-y">
            <div className="gantt-body-pair">
              <div className="gantt-sidebar">
                {laneRows.map(({ lane, routines, tasks, travelGroups, calendarEvents, count }) => {
                  const open = !collapsed[lane.id];
                  const eventRows = calendarEvents.map((event) => <CalendarEventSidebarRow event={event} key={`calendar:${eventKey(event)}`} />);
                  const routineRows = routines.map((series) => (
                    <div className="gantt-task-row" key={series.id}>
                      <HideEyeButton label={series.displayText} onHide={() => hideText(series.text)} />
                      <span title={series.text}>
                        <em className="gantt-kind-badge">例行</em>
                        {series.displayText}
                      </span>
                    </div>
                  ));
                  const taskRows = tasks.map((task) => {
                    const isFocusBattle = Boolean(task.planId && focusBattleIds.has(task.planId));
                    return (
                    <div className={`gantt-task-row ${task.visual}${task.depth ? " is-child" : ""}${task.kind === "phase" ? " is-phase" : ""}${task.childCount ? " has-children" : ""}${isFocusBattle ? " is-focus-battle" : ""}`} key={task.id} data-battle-id={isFocusBattle ? task.planId || undefined : undefined}>
                      {isFocusBattle ? <span className="gantt-battle-flag" aria-hidden><Flag size={12} /></span> : <HideEyeButton label={task.displayText} onHide={() => hideText(task.text)} />}
                      {task.childCount && task.planId && timelineMode === "roadmap" ? (
                        <button
                          type="button"
                          className={`gantt-stage-toggle${expandedStages[task.planId] ? " is-open" : ""}`}
                          onClick={() => setExpandedStages((old) => ({ ...old, [task.planId as string]: !old[task.planId as string] }))}
                          title={expandedStages[task.planId] ? "收起阶段细节" : `展开 ${task.childCount} 个阶段细节`}
                          aria-label={expandedStages[task.planId] ? "收起阶段细节" : "展开阶段细节"}
                        >
                          <ChevronRight size={12} />
                        </button>
                      ) : null}
                      <span title={task.displayText}>
                        <em className="gantt-kind-badge">{isFocusBattle ? "限时大作战" : kindBadge(task.kind)}</em>
                        {task.displayText}
                        {task.dependencyIds.length ? (
                          <small className="gantt-dependency-note">承接·{task.dependencyIds.map((id) => taskByPlanId.get(id)?.displayText ?? "待核对节点").join("、")}</small>
                        ) : null}
                      </span>
                    </div>
                    );
                  });
                  const travelRows = travelGroups.map((group) => <CompanyTravelSidebar
                    group={group}
                    open={Boolean(expandedCompanyTravel[group.id])}
                    onToggle={() => setExpandedCompanyTravel((old) => ({ ...old, [group.id]: !old[group.id] }))}
                    onHide={() => hideText(group.task.text)}
                    key={group.id}
                  />);
                  return (
                    <div className={`gantt-lane-block tone-${lane.tone}`} key={lane.id}>
                      <button
                        type="button"
                        className="gantt-lane-head"
                        onClick={() => setCollapsed((old) => ({ ...old, [lane.id]: open }))}
                      >
                        <i className="gantt-lane-dot" />
                        <strong>{lane.label}</strong>
                        <span>{count}</span>
                        <em className={open ? "open" : ""} />
                      </button>
                      {open
                        ? (
                          <>
                            {lane.id === "life" ? <LifeCalendarSidebar groups={lifeGroups} expanded={expandedLifeCategories} loading={Boolean(lifeCalendar.loading)} available={lifeCalendar.available} stale={lifeCalendar.stale} onToggle={(id, open) => setExpandedLifeCategories((old) => ({ ...old, [id]: !open }))} /> : null}
                            {lane.id === "company" ? <>{travelRows}{taskRows}{eventRows}{routineRows}</> : <>{eventRows}{routineRows}{taskRows}</>}
                          </>
                        )
                        : null}
                    </div>
                  );
                })}
              </div>

              <div className="gantt-body-x" ref={bodyXRef} onScroll={() => syncAxisX("body")}>
                <div className={`gantt-axis is-${timelineMode}`} style={axisStyle}>
                  <div className="gantt-today-line" style={{ left: `${todayLeft}%`, display: todayInWindow ? undefined : "none" }} aria-hidden="true">
                    <i />
                    <span>今天</span>
                  </div>

                  {laneRows.map(({ lane, routines, tasks, travelGroups, calendarEvents }) => {
                    const open = !collapsed[lane.id];
                    const eventRows = calendarEvents.map((event) => <CalendarEventAxisRow event={event} family={lane.tone} todayKey={todayKey} months={roadmapMonths} firstWeek={model.weeks[0].start} weekCount={weekCount} mode={timelineMode} key={`calendar-axis:${eventKey(event)}`} />);
                    const routineRows = routines.map((series) => <RoutineAxisRow key={`bar-${series.id}`} series={series} weekCount={weekCount} mode={timelineMode} months={roadmapMonths} />);
                    const taskRows = tasks.map((task) => (
                      <AxisGlyph
                        key={`bar-${task.id}`}
                        task={task}
                        weekCount={weekCount}
                        mode={timelineMode}
                        months={roadmapMonths}
                        dependency={task.dependencyIds.map((id) => taskByPlanId.get(id)).find((item): item is GanttTask => Boolean(item))}
                        focusBattle={Boolean(task.planId && focusBattleIds.has(task.planId))}
                      />
                    ));
                    const travelRows = travelGroups.map((group) => <CompanyTravelAxis
                      group={group}
                      open={Boolean(expandedCompanyTravel[group.id])}
                      months={roadmapMonths}
                      firstWeek={model.weeks[0].start}
                      weekCount={weekCount}
                      mode={timelineMode}
                      todayKey={todayKey}
                      key={`axis:${group.id}`}
                    />);
                    return (
                      <div className={`gantt-lane-axis${lane.id === "life" ? " is-life" : ""}`} key={`axis-${lane.id}`}>
                        <div className="gantt-lane-spacer" />
                        {open
                          ? (
                            <>
                              {lane.id === "life" ? <LifeCalendarAxis groups={lifeGroups} expanded={expandedLifeCategories} months={roadmapMonths} firstWeek={model.weeks[0].start} weekCount={weekCount} mode={timelineMode} todayKey={todayKey} /> : null}
                              {lane.id === "company" ? <>{travelRows}{taskRows}{eventRows}{routineRows}</> : <>{eventRows}{routineRows}{taskRows}</>}
                            </>
                          )
                          : null}
                      </div>
                    );
                  })}

                  {!laneRows.length ? (
                    <div className="gantt-empty-overlay" title="写法示例：公司：事件：8/9 · AIDDもくもく会">
                      <Empty>暂无排期的长期主线事项。可随时在待办中添加或吩咐小秘书。</Empty>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="gantt-board-foot">
          <span>生活行程来自苹果日历 · <b className="gantt-battle-source">主线与大作战来自待办原件</b></span>
        </footer>
      </Card>
      ) : null}

      {activeSection === "japan" ? <JapanActivitiesView active homeRequest={japanHomeRequest} /> : null}
      {activeSection === "releases" ? <ReleaseWatchView active /> : null}
    </div>
  );
}
