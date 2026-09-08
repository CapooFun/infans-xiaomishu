import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, ArrowUpRight, Bookmark, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, CircleDashed, Copy, FileText, Flag, Folder, FolderOpen, HelpCircle, LayoutDashboard, ListTree, Route, Search, Target } from "lucide-react";
import { CardButton, Empty, Kicker, navigateWithPositionRestore } from "../page-shared";
import {
  filterDisplayModeProductModules,
  isDisplayModeHiddenProjectTask,
  isDisplayModeSensitiveProjectText,
} from "../display-mode";
import {
  COMPLETED_TASK_BOARD_TTL_MS,
  moduleProgressSignal,
  isProjectTaskVisibleOnBoard,
  nextTaskPriority,
  productTreeFromProjectHub,
  projectIdFromName,
  projectHubStatusLabel,
  projectPortfolioRank,
  projectPortfolioTier,
  mergeProjectContextAssociations,
  projectHubAssociationMatchesWorkline,
  projectRecentHasFeature,
  projectRecentModuleIds,
  projectTaskFeatureIds,
  readProjectQuery,
  selectCurrentProjectStep,
  writeProjectQuery,
  type ProjectCard,
} from "../project-workbench-model";
import type {
  ProjectManagementTask,
  ProjectManagementContextItem,
  ProjectTaskPriority,
  ProductFeature,
  ProductFeatureModule,
  ProductFeaturePoint,
  ProductFeatureStatus,
  ProductFeatureTree,
  ProjectHub,
  ProjectFocusBattle,
  ProjectManagementSnapshot,
  RegisteredProjectManagement,
  WorkbenchSummary,
  WriteAction,
} from "../types";
import {
  notifyWorkbenchPositionReady,
  projectFeaturePointMemoryId,
  projectWikiScope,
  readTodoReturnLocation,
  readProjectWikiMemory,
  readProjectWorkbenchQuery,
  writeProjectWikiMemory,
  writeProjectWorkbenchQuery,
} from "../workbench-position-memory.ts";
import { visibleFocusBattles } from "../focus-battle-model";
import { PageTrail, type TrailItem } from "../shell/PageNavigation";
import { navigationHref } from "../shell/page-navigation-model";
import { withFeaturePresentation } from "../product-feature-presentation";
import { FeatureWikiSections } from "./FeatureWikiSections";
import { GovernanceMapView } from "./GovernanceMapView";

function projectTrailItem(project: RegisteredProjectManagement, onSelect?: () => void): TrailItem {
  return { label: managedProjectDisplayName(project), href: navigationHref("/projects", { project: project.projectId || projectIdFromName(project.name), view: "home" }), onSelect, history: "replace" };
}

const TAILSCALE_WORKBENCH_HOST = "mailbox.example.invalid";
const PRIORITIES = ["S", "A", "B", "C"] as const;
const EMPTY_MANAGEMENT_PROJECTS: RegisteredProjectManagement[] = [];
const FEATURE_STATUS_SUMMARY: ReadonlyArray<{ status: ProductFeatureStatus; label: string; tone: string }> = [
  { status: "稳定", label: "稳定", tone: "stable" },
  { status: "准备开发", label: "待开发", tone: "planned" },
  { status: "设计中", label: "设计中", tone: "designing" },
  { status: "开发中", label: "开发中", tone: "building" },
  { status: "测试中", label: "测试中", tone: "testing" },
  { status: "等待验收", label: "待验收", tone: "acceptance" },
  { status: "已暂停", label: "已暂停", tone: "paused" },
];

type NestedFeatureNode = { id?: string; children?: NestedFeatureNode[] };

type FeatureWorkWindow = {
  id: string;
  title: string;
  agent: "Codex" | "Cursor" | string;
  kind: "codex" | "cursor" | string;
  reference: string;
  updatedAt: string | null;
  relevance: number | null;
  url: string | null;
};

function nestedFeatureNodeContainsId(nodes: NestedFeatureNode[] | undefined, id: string): boolean {
  return Boolean(nodes?.some((node) => node.id === id || nestedFeatureNodeContainsId(node.children, id)));
}

async function copyWindowTitle(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function FeatureWorkContext({ displayMode, projectId, featureId }: { displayMode: boolean; projectId: string; featureId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  const [tasks, setTasks] = useState<FeatureWorkWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setExpanded(false);
    setCopiedId("");
    setLoading(true);
    setError("");
    const search = new URLSearchParams({ projectId, featureId, limit: "3" });
    void fetch(`/api/codex-feature-tasks?${search}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error || "读取关联任务窗口失败");
        setTasks(Array.isArray(payload?.tasks) ? payload.tasks : []);
      })
      .catch((reason) => {
        if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "读取关联任务窗口失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [featureId, projectId]);

  if (displayMode) return null;

  const countLabel = loading ? "读取中" : error ? "暂不可用" : `${tasks.length} 个`;
  return (
    <section className="project-feature-codex" aria-label="关联任务窗口">
      <button type="button" className="project-feature-codex-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        <span><Kicker>工作上下文</Kicker><span className="project-feature-codex-title">关联任务窗口</span></span>
        <span className="project-feature-codex-count">{countLabel}{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
      </button>
      {expanded ? (
        <div className="project-feature-codex-body">
          {error ? <Empty>{error}</Empty> : loading ? <Empty>正在读取本机任务索引…</Empty> : tasks.length ? (
            <ul>
              {tasks.map((task) => (
                <li key={task.id}>
                  <span>
                    <span className="project-feature-codex-name">{task.title}</span>
                    <small>{task.agent}{task.reference ? ` · ${task.reference}` : ""}{task.updatedAt ? ` · ${new Date(task.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}` : ""}</small>
                  </span>
                  {task.url ? (
                    <a href={task.url} aria-label={`在 Codex 打开${task.title}`}>打开 Codex<ArrowUpRight size={14} /></a>
                  ) : (
                    <button
                      type="button"
                      aria-label={`复制任务窗口名 ${task.title}`}
                      onClick={() => {
                        void copyWindowTitle(task.title).then(() => {
                          setCopiedId(task.id);
                          window.setTimeout(() => setCopiedId((current) => current === task.id ? "" : current), 1600);
                        });
                      }}
                    >
                      {copiedId === task.id ? "已复制" : "复制任务窗口名"}
                      {copiedId === task.id ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : <Empty>还没有关联任务窗口。</Empty>}
        </div>
      ) : null}
    </section>
  );
}

function ReturnToTodoButton() {
  if (readProjectWorkbenchQuery().from !== "todo") return null;
  return (
    <button
      type="button"
      className="project-wb-return"
      onClick={() => {
        const target = readTodoReturnLocation() || "/schedule";
        navigateWithPositionRestore(target);
      }}
      title="回到刚才的待办位置"
    >
      <ArrowLeft size={15} />返回待办
    </button>
  );
}

function normalizedProjectContextItems(items: Array<Partial<ProjectManagementContextItem> & { text: string } | string>) {
  return items.map((item) => {
    if (typeof item !== "string") return {
      id: item.id || null,
      text: item.text,
      taskIds: Array.isArray(item.taskIds) ? item.taskIds : [],
      worklineIds: Array.isArray(item.worklineIds) ? item.worklineIds : [],
      moduleIds: Array.isArray(item.moduleIds) ? item.moduleIds : [],
      featureIds: Array.isArray(item.featureIds) ? item.featureIds : [],
    };
    const match = item.match(/[｜|]\s*模块\s*[：:]\s*([^｜|]+)\s*$/u);
    return {
      id: null,
      text: match ? item.slice(0, match.index).trim() : item,
      taskIds: [],
      worklineIds: [],
      moduleIds: match ? match[1].split(/[,，、]/u).map((id) => id.trim().toLowerCase()).filter(Boolean) : [],
      featureIds: [],
    };
  });
}

const normalizedRecentCompleted = normalizedProjectContextItems;

export function coachWorkbenchUrl(localUrl: string) {
  return window.location.protocol === "https:" && window.location.hostname === TAILSCALE_WORKBENCH_HOST
    ? `https://${TAILSCALE_WORKBENCH_HOST}:8443/`
    : localUrl;
}

async function openCoachWorkbench(localUrl: string) {
  const url = coachWorkbenchUrl(localUrl);
  const onLoopback = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
  if (onLoopback && window.location.protocol === "http:") {
    try {
      const response = await fetch("/api/tools/launch-coach", { method: "POST" });
      if (response.ok) return;
    } catch {
      /* fall through */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function PortfolioCard({
  card,
  featured,
  coachUrl,
  coachClientUrl,
  onOpen,
  summary,
  children,
}: {
  card: ProjectCard;
  featured?: boolean;
  coachUrl?: string;
  coachClientUrl?: string;
  onOpen: (id: string) => void;
  summary?: ReactNode;
  children?: ReactNode;
}) {
  const tier = projectPortfolioTier(card.name);
  const tierLabel = card.archived ? "已归档" : tier === "primary" ? "主项目" : tier === "focus" ? "重点推进" : tier === "game" ? "游戏产品" : tier === "media" ? "内容事业" : "持续推进";
  const kicker = card.status.includes(tierLabel) ? card.status : `${tierLabel} · ${card.status}`;
  return (
    <CardButton
      className={`project-deck-card ${featured ? "is-featured" : ""} project-deck-${card.kind}`}
      onClick={() => onOpen(card.id)}
      label={`打开${card.displayName}`}
    >
      <header className={`project-deck-head${summary ? " has-summary" : ""}`}>
        <div className="project-deck-eyebrow">
          <Kicker>{kicker}</Kicker>
          <span className="project-deck-open" aria-hidden>
            进工作台 <ChevronRight size={14} />
          </span>
        </div>
        <h2>{card.displayName}</h2>
        <p>{card.peek}</p>
        {summary ? <div className="project-deck-summary">{summary}</div> : null}
      </header>
      {children ? <div className="project-deck-body">{children}</div> : null}
      {card.experience ? <ProjectExperienceAction experience={card.experience} compact /> : null}
      {card.id === "life-coach" && coachUrl && coachClientUrl ? <CoachPortfolioActions coachUrl={coachUrl} coachClientUrl={coachClientUrl} /> : null}
    </CardButton>
  );
}

function FeatureTreeStatusSummary({ tree, displayMode }: { tree: ProductFeatureTree; displayMode: boolean }) {
  const modules = displayMode ? filterDisplayModeProductModules(tree.modules) : tree.modules;
  const counts = new Map<ProductFeatureStatus, number>();
  let total = 0;
  for (const module of modules) {
    for (const feature of module.features) {
      total += 1;
      const status = feature.status as ProductFeatureStatus;
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
  }
  return (
    <section className="project-wiki-summary" aria-label={`功能 Wiki 共 ${total} 项`}>
      <header>
        <span>功能 Wiki</span>
        <strong>共 {total} 项</strong>
      </header>
      <div className="project-wiki-statuses">
        {FEATURE_STATUS_SUMMARY.map(({ status, label, tone }) => (
          <div className={`is-${tone}`} key={status}>
            <strong>{counts.get(status) ?? 0}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function CoachPortfolioActions({ coachUrl, coachClientUrl }: { coachUrl: string; coachClientUrl: string }) {
  const [opening, setOpening] = useState(false);
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <div className="project-experience-row is-compact">
      <button
        type="button"
        disabled={opening}
        onClick={(event) => {
          event.stopPropagation();
          if (opening) return;
          setOpening(true);
          void openCoachWorkbench(coachUrl).finally(() => setOpening(false));
        }}
        onKeyDown={stop}
      >
        {opening ? "正在打开…" : "进入控制端"} <ArrowUpRight size={13} />
      </button>
      <a
        href={coachClientUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={stop}
      >
        进入用户端 <ArrowUpRight size={13} />
      </a>
    </div>
  );
}

function ProjectExperienceAction({
  experience,
  compact = false,
}: {
  experience: NonNullable<ProjectCard["experience"]>;
  compact?: boolean;
}) {
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [launchFailed, setLaunchFailed] = useState(false);
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  if (experience.kind === "external" && experience.url) {
    return (
      <div className={`project-experience-row ${compact ? "is-compact" : ""}`}>
        <a href={experience.url} target="_blank" rel="noopener noreferrer" onClick={stop} onKeyDown={stop}>
          {experience.label} <ArrowUpRight size={13} />
        </a>
      </div>
    );
  }

  if (experience.kind !== "launcher" || !experience.launcherId) return null;
  const onLoopback = typeof window !== "undefined" && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");
  return (
    <div className={`project-experience-row ${compact ? "is-compact" : ""}`}>
      <button
        type="button"
        disabled={!onLoopback || launching}
        onClick={(event) => {
          event.stopPropagation();
          if (!onLoopback || launching) return;
          setLaunching(true);
          setLaunchFailed(false);
          void fetch("/api/tools/launch-project-experience", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: experience.launcherId }),
          })
            .then(async (response) => {
              if (!response.ok) throw new Error("launch-failed");
              const result = await response.json() as { url?: string };
              if (result.url) window.open(result.url, "_blank", "noopener,noreferrer");
              setLaunched(true);
            })
            .catch(() => setLaunchFailed(true))
            .finally(() => setLaunching(false));
        }}
        onKeyDown={stop}
      >
        {!onLoopback ? "请在本机打开" : launching ? "正在启动…" : launchFailed ? "启动失败，重试" : launched ? "已启动，再开一次" : experience.label}
        <ArrowUpRight size={13} />
      </button>
    </div>
  );
}

function WorkbenchBlock({
  kicker,
  title,
  quiet = false,
  scrollable = false,
  children,
}: {
  kicker: string;
  title: string;
  quiet?: boolean;
  scrollable?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`project-wb-block${quiet ? " is-empty" : ""}${scrollable ? " is-scrollable" : ""}`}
      aria-label={scrollable ? `${kicker}：${title}` : undefined}
      tabIndex={scrollable ? 0 : undefined}
    >
      <header>
        <Kicker>{kicker}</Kicker>
        <h3>{title}</h3>
      </header>
      {children}
    </section>
  );
}

function managedProjectKind(project: RegisteredProjectManagement): ProjectCard["kind"] {
  if (project.projectId === "infans-ai-system" || project.projectId === "demo-secretary" || project.name === "小秘书") return "flagship";
  if (project.projectId === "life-coach") return "coach";
  return "venture";
}

function managedProjectDisplayName(project: Pick<RegisteredProjectManagement, "projectId" | "name">): string {
  if (project.projectId === "infans-ai-system" || project.projectId === "demo-secretary" || project.name === "小秘书") return "小秘书";
  return project.name.replace(/^《|》$/gu, "");
}

function managedProjectCard(project: RegisteredProjectManagement, displayMode = false): ProjectCard {
  const currentStatus = project.management?.dashboardSummary || project.management?.currentStatus || "";
  const cardSummary = project.cardSummary || currentStatus;
  return {
    id: project.projectId || projectIdFromName(project.name),
    kind: managedProjectKind(project),
    name: project.name,
    displayName: managedProjectDisplayName(project),
    status: project.status,
    peek: displayMode && isDisplayModeSensitiveProjectText(cardSummary)
      ? "部分内容已在展示模式下隐藏"
      : cardSummary || (project.migrated ? "还没写当前状态" : "尚未迁入项目管理文件"),
    entryPath: project.entryPath,
    archived: project.archived,
    experience: project.experience,
  };
}

function PriorityPicker({
  task,
  disabled,
  onChange,
}: {
  task: ProjectManagementTask;
  disabled: boolean;
  onChange: (priority: ProjectTaskPriority) => void;
}) {
  if (task.done || (task.automationMode === "automatic" && task.automationContractStatus === "valid")) return null;
  return (
    <div className="project-priority-picker" role="group" aria-label={`挑选任务等级：${task.displayText}`}>
      {PRIORITIES.map((priority) => {
        const selected = (task.priority || "C") === priority;
        return (
          <button
            type="button"
            className={`tone-${priority.toLowerCase()}`}
            key={priority}
            aria-pressed={selected}
            aria-label={selected ? `当前 ${priority} 级` : `设为 ${priority} 级`}
            disabled={disabled}
            onClick={() => { if (!selected) onChange(nextTaskPriority(task.priority, priority)); }}
          >
            {priority}
          </button>
        );
      })}
    </div>
  );
}

function ManagedTaskRow({
  task,
  pending,
  onWritePreview,
}: {
  task: ProjectManagementTask;
  pending: boolean;
  onWritePreview: (action: WriteAction) => Promise<void>;
}) {
  const locked = task.writable === false;
  const previewPriority = (priority: ProjectTaskPriority) => onWritePreview({
    kind: "setTodoPriority",
    sourcePath: task.sourcePath,
    id: task.id,
    expectedDone: task.done,
    expectedPriority: task.priority,
    priority,
  });
  return (
    <li className={`project-task-row${task.done ? " is-done" : ""}`}>
      <button
        type="button"
        className={`project-task-check ${task.done ? "is-confirmed" : "is-pending"}`}
        aria-label={task.done ? `恢复未完成：${task.displayText}` : `标记完成：${task.displayText}`}
        aria-pressed={task.done}
        disabled={pending || locked}
        title={locked ? "此任务暂未分配编号，可在项目原档中补充" : undefined}
        onClick={() => void onWritePreview({ kind: "toggleTodo", sourcePath: task.sourcePath, id: task.id, expectedDone: task.done })}
      >
        {task.done ? <Check size={13} /> : <CircleDashed size={13} />}
      </button>
      <div className="project-task-copy">
        <span>{task.displayText}</span>
        <small>
          {task.date?.label ? <time>{task.date.label}</time> : "未定日期"}
          {task.done && task.priority ? ` · 保留 ${task.priority} 级` : ""}
          {locked ? " · 补齐稳定 ID 后可操作" : ""}
        </small>
      </div>
      <PriorityPicker task={task} disabled={pending || locked} onChange={(priority) => void previewPriority(priority)} />
    </li>
  );
}

function ManagedTaskList({
  tasks,
  pendingId,
  onPreview,
  empty,
}: {
  tasks: ProjectManagementTask[];
  pendingId: string | null;
  onPreview: (taskId: string, action: WriteAction) => Promise<void>;
  empty: string;
}) {
  if (!tasks.length) return <Empty>{empty}</Empty>;
  const orderedTasks = tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => Number(left.task.done) - Number(right.task.done) || left.index - right.index)
    .map(({ task }) => task);
  return (
    <ul className="project-task-list">
      {orderedTasks.map((task, index) => (
        <ManagedTaskRow
          key={`${task.sourcePath}:${task.id}:${index}`}
          task={task}
          pending={pendingId === task.id}
          onWritePreview={(action) => onPreview(task.id, action)}
        />
      ))}
    </ul>
  );
}

function CurrentProjectStep({
  displayMode,
  management,
  pendingId,
  onPreview,
  embedded = false,
}: {
  displayMode: boolean;
  management: NonNullable<RegisteredProjectManagement["management"]>;
  pendingId: string | null;
  onPreview: (taskId: string, action: WriteAction) => Promise<void>;
  embedded?: boolean;
}) {
  const current = selectCurrentProjectStep({
    doing: management.doing.filter((task) => !displayMode || !isDisplayModeHiddenProjectTask(task)),
    next: management.next.filter((task) => !displayMode || !isDisplayModeHiddenProjectTask(task)),
  });
  if (!current) {
    return (
      <section className={`project-current-step is-empty${embedded ? " is-embedded" : ""}`} aria-labelledby="project-current-step-title">
        <span className="project-current-step-marker" aria-hidden><Bookmark size={16} /></span>
        <div className="project-current-step-copy">
          <Kicker>当前第一步</Kicker>
          <h2 id="project-current-step-title">尚未指定当前第一步</h2>
          <p>当前没有需要你介入的未完成任务；自动化任务正在后台按计划推进。</p>
        </div>
      </section>
    );
  }

  const { task, source } = current;
  const pending = pendingId === task.id;
  const locked = task.writable === false;
  const sourceLabel = source === "doing" ? "正在做" : "下一步";
  return (
    <section className={`project-current-step${embedded ? " is-embedded" : ""}`} aria-labelledby="project-current-step-title">
      <span className="project-current-step-marker" aria-hidden><Bookmark size={16} /></span>
      <div className="project-current-step-copy">
        <Kicker>当前第一步</Kicker>
        <h2 id="project-current-step-title">{task.displayText}</h2>
        <p className="project-current-step-meta">
          {task.priority ? <span className={`is-priority-${task.priority.toLowerCase()}`}>{task.priority} 级</span> : null}
          <span>{sourceLabel}</span>
          {task.date?.label ? <time>{task.date.label}</time> : <span>未定日期</span>}
          {locked ? <span>补齐稳定 ID 后可操作</span> : null}
        </p>
      </div>
      <div className="project-current-step-actions">
        <button
          type="button"
          className="project-current-step-complete"
          disabled={pending || locked}
          title={locked ? "此任务暂未分配编号，可在项目原档中补充" : undefined}
          onClick={() => void onPreview(task.id, { kind: "toggleTodo", sourcePath: task.sourcePath, id: task.id, expectedDone: task.done })}
        >
          <Check size={13} />标记完成
        </button>
        <PriorityPicker
          task={task}
          disabled={pending || locked}
          onChange={(priority) => void onPreview(task.id, {
            kind: "setTodoPriority",
            sourcePath: task.sourcePath,
            id: task.id,
            expectedDone: task.done,
            expectedPriority: task.priority,
            priority,
          })}
        />
      </div>
    </section>
  );
}

function FeatureStatus({ status }: { status: string }) {
  if (status === "稳定") return null;
  const tone = status === "等待验收" ? "acceptance" : status === "测试中" ? "testing" : status === "已暂停" ? "paused" : "building";
  return <span className={`project-feature-status is-${tone}`}>{status}</span>;
}

function FeatureAcceptanceButton({ pending, onAccept, featureName }: { pending: boolean; onAccept: () => void; featureName: string }) {
  return (
    <button
      type="button"
      className="project-feature-accept"
      disabled={pending}
      aria-label={`验收${featureName}`}
      title={pending ? "正在验收" : "确认验收通过"}
      onClick={onAccept}
    >
      {pending ? <CircleDashed size={12} aria-hidden /> : <Check size={12} aria-hidden />}
      <span>{pending ? "验收中" : "验收"}</span>
    </button>
  );
}

function featurePointSearchText(points: ProductFeaturePoint[]): string {
  return points.map((point) => `${point.text} ${point.status || ""} ${point.summary || ""} ${point.source?.label || ""} ${point.source?.path || ""} ${featurePointSearchText(point.children || [])}`).join(" ");
}

function featurePointLeafCount(point: ProductFeaturePoint): number {
  const children = point.children || [];
  return children.length ? children.reduce((total, child) => total + featurePointLeafCount(child), 0) : 1;
}

const FEATURE_POINT_FOLD_LEAF_THRESHOLD = 4;

function featurePointShouldFold(point: ProductFeaturePoint) {
  const children = point.children || [];
  if (!children.length) return false;
  return children.some((child) => Boolean(child.children?.length))
    || featurePointLeafCount(point) >= FEATURE_POINT_FOLD_LEAF_THRESHOLD;
}

function featurePointsHaveDetails(points: ProductFeaturePoint[]) {
  return points.some((point) => Boolean(point.children?.length || point.summary || point.status || point.source));
}

type FeaturePointMemoryNode = {
  id: string;
  featureId: string;
  moduleId: string;
  ancestors: string[];
};

function collectFeaturePointMemoryNodes(modules: ProductFeatureModule[]) {
  const nodes = new Map<string, FeaturePointMemoryNode>();
  const visit = (moduleId: string, featureId: string, point: ProductFeaturePoint, textPath: string[], ancestors: string[]) => {
    const path = [...textPath, point.text];
    const id = projectFeaturePointMemoryId(featureId, point.id, path);
    nodes.set(id, { id, featureId, moduleId, ancestors });
    for (const child of point.children || []) visit(moduleId, featureId, child, path, [...ancestors, id]);
  };
  for (const module of modules) {
    for (const feature of module.features) {
      for (const point of feature.points || []) visit(module.id, feature.id, point, [], []);
    }
  }
  return nodes;
}

function FeaturePointFact({ point }: { point: ProductFeaturePoint }) {
  if (!point.summary && !point.status && !point.source) return null;
  return (
    <div className="project-feature-point-fact">
      {point.summary ? <Kicker>{point.children?.length ? "机制总览" : "规则说明"}</Kicker> : null}
      {point.summary ? <p>{point.summary}</p> : null}
      <footer>
        {point.status ? <span className="project-feature-point-state">状态 · {point.status}</span> : null}
        {point.source ? <span className="project-feature-point-source"><FolderOpen size={12} /><span>{point.source.label}</span><code>{point.source.path}</code></span> : null}
      </footer>
    </div>
  );
}

function FeaturePointBranch({
  point,
  featureId,
  textPath = [],
  expandedNodes,
  onToggle,
}: {
  point: ProductFeaturePoint;
  featureId: string;
  textPath?: string[];
  expandedNodes: Set<string>;
  onToggle: (nodeId: string, open: boolean) => void;
}) {
  const children = point.children || [];
  const path = [...textPath, point.text];
  const nodeId = projectFeaturePointMemoryId(featureId, point.id, path);
  const open = expandedNodes.has(nodeId);
  const toggle = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    onToggle(nodeId, !open);
  };
  const toggleFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onToggle(nodeId, !open);
  };
  if (!children.length) {
    const hasFact = Boolean(point.summary || point.status || point.source);
    if (!hasFact) return <li className="project-feature-point-leaf"><span>{point.text}</span></li>;
    return (
      <li className="project-feature-point-leaf has-detail is-static" data-position-anchor={nodeId}>
        <div className="project-feature-point-static-heading"><span>{point.text}</span>{point.status ? <small>{point.status}</small> : null}</div>
        <FeaturePointFact point={point} />
      </li>
    );
  }
  if (!featurePointShouldFold(point)) {
    return (
      <li className="project-feature-point-group is-static" data-position-anchor={nodeId}>
        <div className="project-feature-point-static-heading"><span>{point.text}</span><small>{featurePointLeafCount(point)} 项</small></div>
        <FeaturePointFact point={point} />
        <ul>{children.map((child, index) => <FeaturePointBranch point={child} featureId={featureId} textPath={path} expandedNodes={expandedNodes} onToggle={onToggle} key={`${child.text}:${index}`} />)}</ul>
      </li>
    );
  }
  return (
    <li className="project-feature-point-group is-foldable" data-position-anchor={nodeId}>
      <details open={open}>
        <summary onClick={toggle} onKeyDown={toggleFromKeyboard}><span>{point.text}</span><small>{featurePointLeafCount(point)} 项</small></summary>
        <FeaturePointFact point={point} />
        <ul>{children.map((child, index) => <FeaturePointBranch point={child} featureId={featureId} textPath={path} expandedNodes={expandedNodes} onToggle={onToggle} key={`${child.text}:${index}`} />)}</ul>
      </details>
    </li>
  );
}

function focusBattleDateLabel(value: string) {
  const [, month, day] = value.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function focusBattleCountdown(startDate: string) {
  const [year, month, day] = startDate.split("-").map(Number);
  const today = new Date();
  const tokyoToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(today);
  const [todayYear, todayMonth, todayDay] = tokyoToday.split("-").map(Number);
  return Math.max(0, Math.round((Date.UTC(year, month - 1, day) - Date.UTC(todayYear, todayMonth - 1, todayDay)) / 86_400_000));
}

function FocusBattleBoard({
  project,
  onOpenFeature,
  onCollapse,
}: {
  project: RegisteredProjectManagement;
  onOpenFeature?: (featureId: string) => void;
  onCollapse?: () => void;
}) {
  const battles = visibleFocusBattles(project);
  const primary = battles[0] || null;
  const [selectedStageId, setSelectedStageId] = useState<string | null>(() => primary?.todayStageId || primary?.stages[0]?.id || null);
  useEffect(() => {
    if (!primary) return;
    if (!primary.stages.some((stage) => stage.id === selectedStageId)) setSelectedStageId(primary.todayStageId || primary.stages[0]?.id || null);
  }, [primary, selectedStageId]);
  if (!primary || !project.management) return null;

  const management = project.management;
  const tasks = [...management.doing, ...management.next, ...management.blocked];
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const completedIds = new Set(management.recentCompleted.flatMap((item) => item.id ? [item.id] : []));
  const selectedStage = primary.stages.find((stage) => stage.id === selectedStageId) || primary.stages[0] || null;
  const passedCount = primary.stages.filter((stage) => stage.gateStatus === "passed").length;
  const progress = primary.stages.length ? Math.round(passedCount / primary.stages.length * 100) : 0;
  const uniqueTaskIds = [...new Set(primary.stages.flatMap((stage) => stage.taskIds))];
  const completedTaskCount = uniqueTaskIds.filter((id) => taskById.get(id)?.done || completedIds.has(id)).length;
  const stageIndex = selectedStage ? primary.stages.findIndex((stage) => stage.id === selectedStage.id) : -1;
  const countdown = primary.phase === "upcoming" ? focusBattleCountdown(primary.startDate) : 0;
  const phaseLabel = primary.phase === "active"
    ? `第 ${primary.currentDay} / ${primary.totalDays} 天`
    : primary.phase === "paused"
      ? "暂停中"
      : countdown === 1
        ? "明日开战"
        : `${countdown} 天后开战`;

  return (
    <section className={`focus-battle-board is-${primary.phase}`} data-position-anchor={`battle:${primary.id}`} aria-label={`${primary.name}限时大作战看板`}>
      <header className="focus-battle-head">
        <div className="focus-battle-sigil" aria-hidden><Flag size={19} /></div>
        <div className="focus-battle-heading">
          <Kicker>大作战进行中</Kicker>
          <h2>{primary.name}</h2>
          <p>{primary.totalGoal}</p>
        </div>
        <div className="focus-battle-clock">
          <strong>{phaseLabel}</strong>
          <span><CalendarDays size={13} />{focusBattleDateLabel(primary.startDate)}—{focusBattleDateLabel(primary.endDate)}</span>
        </div>
      </header>

      <div className="focus-battle-metrics" aria-label="大作战总体进度">
        <div className="focus-battle-progress-copy"><span>总体完成门</span><strong>{passedCount} / {primary.stages.length}</strong></div>
        <div className="focus-battle-progress-track"><i style={{ width: `${progress}%` }} /></div>
        <span>{progress}%</span>
        <small>真实任务 {completedTaskCount} / {uniqueTaskIds.length}{primary.riskIds.length ? ` · 风险 ${primary.riskIds.length}` : " · 暂无登记风险"}</small>
      </div>

      <div className="focus-battle-route" role="list" aria-label="大作战路线">
        {primary.stages.map((stage, index) => {
          const current = stage.id === primary.todayStageId;
          const passed = stage.gateStatus === "passed";
          const blocked = stage.gateStatus === "blocked";
          return (
            <button
              type="button"
              role="listitem"
              className={`focus-battle-node${selectedStage?.id === stage.id ? " is-selected" : ""}${current ? " is-current" : ""}${passed ? " is-passed" : ""}${blocked ? " is-blocked" : ""}`}
              key={stage.id}
              onClick={() => setSelectedStageId(stage.id)}
              aria-current={current ? "step" : undefined}
            >
              <span className="focus-battle-node-dot">{passed ? <Check size={14} /> : index + 1}</span>
              <strong>{stage.name}</strong>
              <small>{focusBattleDateLabel(stage.dueDate)}前</small>
            </button>
          );
        })}
      </div>

      {selectedStage ? (
        <div className="focus-battle-stage-detail">
          <div className="focus-battle-stage-copy">
            <Kicker>{stageIndex + 1 === primary.currentDay && primary.phase === "active" ? "今天的重点" : `第 ${stageIndex + 1} 节点`}</Kicker>
            <h3>{selectedStage.focus || selectedStage.name}</h3>
            <p><strong>完成门：</strong>{selectedStage.gate || "未设定特定门槛"}</p>
            <p><strong>交付物：</strong>{selectedStage.deliverables.join("、") || "暂未列出"}</p>
          </div>
          <div className="focus-battle-relations">
            <div>
              <span>真实任务</span>
              {selectedStage.taskIds.length ? selectedStage.taskIds.map((taskId) => {
                const task = taskById.get(taskId);
                const done = task?.done || completedIds.has(taskId);
                return <p className={done ? "is-done" : ""} key={taskId}>{done ? <CheckCircle2 size={13} /> : <CircleDashed size={13} />}<span>{task?.displayText || task?.text || taskId}</span></p>;
              }) : <small>未关联</small>}
            </div>
            <div>
              <span>功能节点</span>
              <div className="focus-battle-feature-links">
                {selectedStage.featureIds.length ? selectedStage.featureIds.map((featureId) => onOpenFeature ? (
                  <button type="button" key={featureId} onClick={() => onOpenFeature(featureId)}>{featureId}<ChevronRight size={12} /></button>
                ) : <code key={featureId}>{featureId}</code>) : <small>未关联</small>}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="focus-battle-foot">
        <span><Route size={14} />同一任务会同步显示在甘特图 · 由 Agent 维护项目资料</span>
        <div className="focus-battle-foot-actions">
          {onCollapse ? <button type="button" onClick={onCollapse}>收起全貌<ChevronUp size={13} /></button> : null}
          <button type="button" onClick={() => navigateWithPositionRestore(`/schedule?view=roadmap&battle=${encodeURIComponent(primary.id)}`)}>在甘特图中定位<ArrowUpRight size={13} /></button>
        </div>
      </footer>
      {battles[1] ? <div className="focus-battle-secondary"><Flag size={13} /><span>另有一场：{battles[1].name}</span><small>{battles[1].phase === "paused" ? "已暂停" : `${focusBattleDateLabel(battles[1].startDate)}开始`}</small></div> : null}
    </section>
  );
}

function focusBattleProgress(battle: ProjectFocusBattle) {
  const passed = battle.stages.filter((stage) => stage.gateStatus === "passed").length;
  return {
    passed,
    percent: battle.stages.length ? Math.round(passed / battle.stages.length * 100) : 0,
  };
}

function focusBattlePhaseLabel(battle: ProjectFocusBattle) {
  if (battle.phase === "active") return `第 ${battle.currentDay} / ${battle.totalDays} 天`;
  const countdown = focusBattleCountdown(battle.startDate);
  return countdown === 1 ? "明日开战" : countdown === 0 ? "今日开战" : `${countdown} 天后开战`;
}

function FocusBattleMiniRoute({ battle }: { battle: ProjectFocusBattle }) {
  return (
    <div className="focus-battle-mini-route" aria-label={`${battle.name}进度`}>
      {battle.stages.map((stage, index) => (
        <span
          className={`${stage.gateStatus === "passed" ? "is-passed" : ""}${stage.id === battle.todayStageId ? " is-current" : ""}`}
          key={stage.id}
          title={`第 ${index + 1} 天 · ${stage.name}`}
        >
          <i>{stage.gateStatus === "passed" ? <Check size={10} /> : index + 1}</i>
        </span>
      ))}
    </div>
  );
}

function CompactFocusBattleStrip({
  project,
  onOpen,
}: {
  project: RegisteredProjectManagement;
  onOpen: () => void;
}) {
  const battles = visibleFocusBattles(project);
  const battle = battles[0] || null;
  if (!battle) return null;
  const progress = focusBattleProgress(battle);
  const currentStage = battle.stages.find((stage) => stage.id === battle.todayStageId)
    || battle.stages[Math.max(0, battle.currentDay - 1)]
    || battle.stages[0];
  return (
    <section className={`focus-battle-strip is-${battle.phase}`} aria-label={`${battle.name}大作战摘要`}>
      <span className="focus-battle-strip-sigil" aria-hidden><Flag size={16} /></span>
      <div className="focus-battle-strip-copy">
        <Kicker>{battle.phase === "active" ? "大作战进行中" : focusBattlePhaseLabel(battle)}</Kicker>
        <strong>{battle.name}</strong>
        <small>{currentStage ? `本节点 · ${currentStage.focus || currentStage.name}` : battle.totalGoal}</small>
      </div>
      <FocusBattleMiniRoute battle={battle} />
      <div className="focus-battle-strip-progress"><strong>{progress.percent}%</strong><small>{focusBattlePhaseLabel(battle)}</small></div>
      <button type="button" onClick={onOpen}>查看全貌<ChevronRight size={13} /></button>
    </section>
  );
}

function ExpandableFocusBattle({
  project,
  onOpenFeature,
}: {
  project: RegisteredProjectManagement;
  onOpenFeature?: (featureId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return expanded ? (
    <FocusBattleBoard project={project} onOpenFeature={onOpenFeature} onCollapse={() => setExpanded(false)} />
  ) : (
    <CompactFocusBattleStrip project={project} onOpen={() => setExpanded(true)} />
  );
}

function PortfolioBattleRail({
  projects,
  onOpenProject,
}: {
  projects: RegisteredProjectManagement[];
  onOpenProject: (projectId: string) => void;
}) {
  const entries = useMemo(() => projects.flatMap((project) => (
    visibleFocusBattles(project, Number.POSITIVE_INFINITY).map((battle) => ({ project, battle }))
  )), [projects]);
  if (!entries.length) return null;
  return (
    <section className="portfolio-battle-rail" aria-labelledby="portfolio-battle-title">
      <header><Kicker><span id="portfolio-battle-title">当前大作战</span></Kicker><small>{entries.length} 场正在集中火力</small></header>
      <div className="portfolio-battle-row">
        {entries.map(({ project, battle }) => {
          const progress = focusBattleProgress(battle);
          const projectId = project.projectId || projectIdFromName(project.name);
          return (
            <button
              type="button"
              className={`portfolio-battle-card is-${battle.phase}`}
              key={battle.id}
              onClick={() => onOpenProject(projectId)}
              aria-label={`${managedProjectDisplayName(project)} · ${battle.name} · ${progress.percent}%`}
            >
              <span className="portfolio-battle-card-project">{managedProjectDisplayName(project)}</span>
              <strong className="portfolio-battle-card-name">{battle.name}</strong>
              <span className="portfolio-battle-card-percent">{progress.percent}%</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ProductFeatureBoard({
  displayMode,
  project,
  featureTree,
  treeId = null,
  taskLinks = [],
  recentLinks = [],
  backLabel = "全部事业",
  pendingId,
  onBack,
  onPreview,
}: {
  displayMode: boolean;
  project: RegisteredProjectManagement;
  featureTree?: ProductFeatureTree | null;
  treeId?: string | null;
  taskLinks?: ProjectHub["taskLinks"];
  recentLinks?: ProjectHub["recentLinks"];
  backLabel?: string;
  pendingId: string | null;
  onBack: () => void;
  onPreview: (taskId: string, action: WriteAction) => Promise<void>;
}) {
  const tree = featureTree ?? project.featureTree;
  const management = project.management;
  const displayModules = useMemo(
    () => {
      const presentation = withFeaturePresentation(tree?.modules || []);
      return displayMode ? filterDisplayModeProductModules(presentation) : presentation;
    },
    [displayMode, tree],
  );
  const queryState = readProjectWorkbenchQuery();
  const stableProjectId = project.projectId || projectIdFromName(project.name);
  const projectDisplayName = managedProjectDisplayName(project);
  const wikiScope = projectWikiScope(stableProjectId, treeId);
  const pointNodes = useMemo(() => collectFeaturePointMemoryNodes(displayModules), [displayModules]);
  const firstChanged = displayModules.flatMap((module) => module.features).find((feature) => feature.status !== "稳定");
  const requestedNode = queryState.node ? pointNodes.get(queryState.node) : null;
  const requestedFeature = displayModules.flatMap((module) => module.features).find((feature) => feature.id === queryState.feature);
  const requestedModule = displayModules.find((module) => module.id === queryState.module);
  const initialSelectedId = requestedNode?.featureId || requestedFeature?.id || requestedModule?.id || firstChanged?.id || "root";
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const [query, setQuery] = useState("");
  const [expandedModules, setExpandedModules] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    const selectedModule = displayModules.find((module) => module.id === requestedNode?.moduleId || module.id === requestedModule?.id || module.features.some((feature) => feature.id === requestedFeature?.id));
    if (selectedModule) initial.add(selectedModule.id);
    return initial;
  });
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const memory = readProjectWikiMemory(wikiScope, displayModules.map((module) => module.id), pointNodes.keys());
    const initial = new Set(memory.expandedNodes);
    if (!memory.exists) {
      const initialFeature = displayModules.flatMap((module) => module.features).find((feature) => feature.id === initialSelectedId);
      for (const point of initialFeature?.points || []) initial.add(projectFeaturePointMemoryId(initialFeature!.id, point.id, [point.text]));
    }
    if (requestedNode) {
      requestedNode.ancestors.forEach((id) => initial.add(id));
      initial.add(requestedNode.id);
    }
    return initial;
  });
  useEffect(() => {
    if (selectedId === "root") return;
    const stillVisible = displayModules.some((module) => module.id === selectedId || module.features.some((feature) => feature.id === selectedId));
    if (!stillVisible) setSelectedId("root");
  }, [displayModules, selectedId]);
  useEffect(() => {
    const validModules = new Set(displayModules.map((module) => module.id));
    const validNodes = new Set(pointNodes.keys());
    setExpandedModules((current) => {
      const next = new Set([...current].filter((id) => validModules.has(id)));
      if (next.size === current.size) return current;
      return next;
    });
    setExpandedNodes((current) => {
      const next = new Set([...current].filter((id) => validNodes.has(id)));
      if (next.size === current.size) return current;
      return next;
    });
  }, [displayModules, pointNodes, wikiScope]);
  useEffect(() => {
    writeProjectWikiMemory(wikiScope, expandedModules, expandedNodes);
  }, [expandedModules, expandedNodes, wikiScope]);
  useEffect(() => {
    const current = readProjectWorkbenchQuery();
    const node = current.node ? pointNodes.get(current.node) : null;
    const featureOwner = node
      ? displayModules.find((module) => module.id === node.moduleId)
      : displayModules.find((module) => module.features.some((feature) => feature.id === current.feature));
    const validFeature = node?.featureId || featureOwner?.features.find((feature) => feature.id === current.feature)?.id || null;
    const validModule = node?.moduleId || featureOwner?.id || displayModules.find((module) => module.id === current.module)?.id || null;
    if ((current.node && !node) || current.feature !== validFeature || current.module !== validModule) {
      writeProjectWorkbenchQuery({ tree: treeId, module: validModule, feature: validFeature, node: node?.id || null });
    }
  }, [displayModules, pointNodes, treeId]);
  useEffect(() => { notifyWorkbenchPositionReady(); }, [selectedId, wikiScope]);
  useEffect(() => {
    const current = readProjectWorkbenchQuery();
    if (current.module || current.feature || current.node || selectedId === "root") return;
    const owner = displayModules.find((module) => module.id === selectedId || module.features.some((feature) => feature.id === selectedId));
    if (owner) writeProjectWorkbenchQuery({ tree: treeId, module: owner.id, feature: owner.id === selectedId ? null : selectedId });
  }, [displayModules, selectedId, treeId]);
  useEffect(() => {
    const sync = () => {
      if (window.location.pathname !== "/projects") return;
      const next = readProjectWorkbenchQuery();
      setSelectedId(next.node ? pointNodes.get(next.node)?.featureId || next.feature || next.module || "root" : next.feature || next.module || "root");
      if (next.module) setExpandedModules((current) => new Set([...current, next.module!]));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [pointNodes]);
  if (!tree || !management) return null;

  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleModules = normalizedQuery
    ? displayModules.flatMap((module) => {
        const moduleMatch = `${module.name} ${module.description}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
        const features = moduleMatch ? module.features : module.features.filter((feature) => `${feature.name} ${feature.description} ${feature.status} ${featurePointSearchText(feature.points || [])}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
        return features.length ? [{ ...module, features }] : [];
      })
    : displayModules;
  const allModulesExpanded = displayModules.length > 0 && displayModules.every((module) => expandedModules.has(module.id));
  const selectedModule = displayModules.find((module) => module.id === selectedId || module.features.some((feature) => feature.id === selectedId)) || null;
  const selectedFeature = selectedModule?.features.find((feature) => feature.id === selectedId) || null;
  const selectedRelatedFeatureId = selectedFeature?.relatedFeatureId || selectedFeature?.id || "";
  const relatedFeatureName = tree.modules.flatMap((module) => module.features).find((feature) => feature.id === selectedRelatedFeatureId)?.name;
  const taskLinksById = new Map<string, ProjectHub["taskLinks"]>();
  for (const link of taskLinks) taskLinksById.set(link.taskId.toLowerCase(), [...(taskLinksById.get(link.taskId.toLowerCase()) || []), link]);
  const linkedManagedTasks = [...management.doing, ...management.next, ...management.blocked]
    .map((task) => {
      const links = taskLinksById.get(task.id.toLowerCase()) || [];
      return mergeProjectContextAssociations({ ...task, taskIds: [], moduleIds: [] }, [], links);
    });
  const linkedTasks = linkedManagedTasks.filter((task) => task.section !== "blocked");
  const allTasks = linkedTasks
    .filter((task) => isProjectTaskVisibleOnBoard(task))
    .filter((task) => !displayMode || !isDisplayModeHiddenProjectTask(task));
  const tasksById = new Map(linkedManagedTasks.map((task) => [task.id.toLowerCase(), task]));
  const mergeContextAssociations = (item: ReturnType<typeof normalizedProjectContextItems>[number], extraLinks: ProjectHub["recentLinks"] = []) => {
    const taskIds = [...new Set([...(item.id ? [item.id.toLowerCase()] : []), ...item.taskIds.map((id) => id.toLowerCase())])];
    const tasks = taskIds.flatMap((taskId) => {
      const task = tasksById.get(taskId);
      return task ? [task] : [];
    });
    const taskLinksForItem = taskIds.flatMap((taskId) => taskLinksById.get(taskId) || []);
    return mergeProjectContextAssociations(item, tasks, [...taskLinksForItem, ...extraLinks]);
  };
  const mergedBlockers = normalizedProjectContextItems(management.blockers).map((item) => mergeContextAssociations(item));
  const recentLinksById = new Map<string, ProjectHub["recentLinks"]>();
  for (const link of recentLinks) recentLinksById.set(link.recentId, [...(recentLinksById.get(link.recentId) || []), link]);
  const visibleRecentCompleted = normalizedRecentCompleted(management.recentCompleted)
    .map((item) => {
      const links = item.id ? recentLinksById.get(item.id) || [] : [];
      return mergeContextAssociations(item, links);
    })
    .filter((item) => !displayMode || !isDisplayModeSensitiveProjectText(item.text));
  const moduleFeatureIds = new Set(selectedModule?.features.map((feature) => feature.relatedFeatureId || feature.id) || []);
  const relatedTasks = selectedFeature
    ? allTasks.filter((task) => projectRecentHasFeature(tree, task, selectedRelatedFeatureId))
    : selectedModule
      ? allTasks.filter((task) => {
          return projectTaskFeatureIds(task).some((featureId) => moduleFeatureIds.has(featureId))
            || projectRecentModuleIds(tree, task).includes(selectedModule.id);
        })
      : allTasks;
  const visibleBlockers = mergedBlockers
    .filter((item) => !displayMode || !isDisplayModeSensitiveProjectText(item.text))
    .filter((item) => selectedFeature
      ? projectRecentHasFeature(tree, item, selectedRelatedFeatureId)
      : selectedModule
        ? projectRecentModuleIds(tree, item).includes(selectedModule.id)
        : true);
  const recentGroups = selectedFeature
    ? [{ id: selectedFeature.id, name: selectedFeature.name, items: visibleRecentCompleted.filter((item) => projectRecentHasFeature(tree, item, selectedRelatedFeatureId)) }]
    : selectedModule
      ? [{ id: selectedModule.id, name: selectedModule.name, items: visibleRecentCompleted.filter((item) => projectRecentModuleIds(tree, item).includes(selectedModule.id)) }]
    : [
        ...displayModules.map((module) => ({
          id: module.id,
          name: module.name,
          items: visibleRecentCompleted.filter((item) => projectRecentModuleIds(tree, item).includes(module.id)),
        })).filter((group) => group.items.length),
        ...(() => {
          const ungrouped = visibleRecentCompleted.filter((item) => !projectRecentModuleIds(tree, item).length);
          return ungrouped.length ? [{ id: "project", name: "项目整体", items: ungrouped }] : [];
        })(),
      ];
  const toggleModule = (module: ProductFeatureModule) => {
    setExpandedModules((current) => {
      const next = new Set(current);
      if (next.has(module.id)) next.delete(module.id);
      else next.add(module.id);
      return next;
    });
    setSelectedId(module.id);
    writeProjectWorkbenchQuery({ tree: treeId, module: module.id, feature: null, node: null });
  };
  const toggleAllModules = () => {
    setExpandedModules((current) => {
      const shouldCollapse = Boolean(normalizedQuery) || displayModules.every((module) => current.has(module.id));
      return shouldCollapse ? new Set<string>() : new Set(displayModules.map((module) => module.id));
    });
    if (normalizedQuery) setQuery("");
  };
  const chooseFeature = (module: ProductFeatureModule, feature: ProductFeature) => {
    setExpandedModules((current) => {
      const next = new Set(current).add(module.id);
      return next;
    });
    setSelectedId(feature.id);
    writeProjectWorkbenchQuery({ tree: treeId, module: module.id, feature: feature.id, node: null });
  };
  const openBattleFeature = (featureId: string) => {
    const module = displayModules.find((item) => item.features.some((feature) => feature.id === featureId || nestedFeatureNodeContainsId(feature.points, featureId)));
    const feature = module?.features.find((item) => item.id === featureId) || module?.features.find((item) => nestedFeatureNodeContainsId(item.points, featureId));
    if (!module || !feature) return;
    chooseFeature(module, feature);
  };
  const toggleFeaturePoint = (nodeId: string, open: boolean) => {
    setExpandedNodes((current) => {
      const next = new Set(current);
      if (open) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
    const current = readProjectWorkbenchQuery();
    writeProjectWorkbenchQuery({ tree: treeId, module: selectedModule?.id || null, feature: selectedFeature?.id || null, node: open ? nodeId : current.node === nodeId ? null : current.node });
  };
  const detailTitle = selectedFeature?.name || selectedModule?.name || projectDisplayName;
  const detailKicker = selectedFeature?.relatedFeatureId ? "原生界面功能" : selectedFeature ? "小模块" : selectedModule ? "大模块" : "产品全貌";
  const rootSummary = management.dashboardSummary || tree.description;
  const rootDescription = displayMode && isDisplayModeSensitiveProjectText(rootSummary)
    ? tree.description
    : rootSummary;
  const selectedFeaturePresentationPoints = selectedFeature?.summaryPoints?.length
    ? selectedFeature.summaryPoints
    : selectedFeature?.points || [];
  const hasDesignControlCard = Boolean(selectedFeaturePresentationPoints.some((point) => point.children?.length));
  const designControlCardLabel = projectPortfolioTier(project.name) === "game" ? "游戏设计控制卡" : "功能设计控制卡";
  const acceptancePendingId = selectedFeature ? `accept:${stableProjectId}:${selectedFeature.id}` : null;
  const canAcceptSelectedFeature = selectedFeature?.status === "等待验收" && !selectedFeature.relatedFeatureId && Boolean(selectedModule?.sourcePath);

  return (
    <div className="project-workbench is-feature-tree">
      <PageTrail items={[
        projectTrailItem(project, onBack),
        { label: "功能 Wiki", href: navigationHref("/projects", { project: stableProjectId, view: "wiki", tree: treeId }), history: "replace", onSelect: () => { setSelectedId("root"); writeProjectWorkbenchQuery({ view: "wiki", tree: treeId, module: null, feature: null, node: null }); } },
        ...(selectedModule ? [{ label: selectedModule.name, href: navigationHref("/projects", { project: stableProjectId, view: "wiki", tree: treeId, module: selectedModule.id }), history: "replace" as const, onSelect: () => { setSelectedId(selectedModule.id); writeProjectWorkbenchQuery({ tree: treeId, module: selectedModule.id, feature: null, node: null }); } }] : []),
        ...(selectedFeature ? [{ label: selectedFeature.name }] : []),
      ]} />
      <ReturnToTodoButton />

      {management.warnings.length ? (
        <div className="project-management-warning" role="alert"><AlertTriangle size={14} /><span>{management.warnings[0]?.message}</span></div>
      ) : null}

      <ExpandableFocusBattle project={project} onOpenFeature={openBattleFeature} />

      {stableProjectId !== "infans-ai-system" ? (
        <CurrentProjectStep
          displayMode={displayMode}
          management={management}
          pendingId={pendingId}
          onPreview={onPreview}
        />
      ) : null}

      <div className="project-feature-layout">
        <aside className="project-feature-browser" aria-label={`${projectDisplayName}产品功能树`}>
          <div className="project-feature-search">
            <Search size={15} aria-hidden />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索大模块或小模块" aria-label="搜索大模块或小模块" />
          </div>
          <nav className="project-feature-tree" aria-label="模块与功能">
            <div className="project-feature-root-row">
              <button type="button" className={`project-feature-root${selectedId === "root" ? " is-selected" : ""}`} onClick={() => { setSelectedId("root"); writeProjectWorkbenchQuery({ tree: treeId, module: null, feature: null, node: null }); }}>
                <ListTree size={16} /><span>{projectDisplayName}</span>
              </button>
              <button
                type="button"
                className="project-feature-root-toggle"
                aria-expanded={Boolean(normalizedQuery) || allModulesExpanded}
                aria-label={Boolean(normalizedQuery) || allModulesExpanded ? `全部折叠${projectDisplayName}功能目录` : `全部展开${projectDisplayName}功能目录`}
                title={Boolean(normalizedQuery) || allModulesExpanded ? "全部折叠" : "全部展开"}
                onClick={toggleAllModules}
              >
                {Boolean(normalizedQuery) || allModulesExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>
            <div className="project-feature-branches">
              <FeatureWikiSections items={visibleModules} groups={tree.presentationGroups}>{(module) => {
                const expanded = Boolean(normalizedQuery) || expandedModules.has(module.id);
                const fullModule = displayModules.find((item) => item.id === module.id) || module;
                const progressSignal = moduleProgressSignal(fullModule.features);
                return (
                  <div className="project-feature-branch" key={module.id}>
                    <button type="button" className={`project-feature-module${selectedId === module.id ? " is-selected" : ""}`} onClick={() => toggleModule(module)} aria-expanded={expanded}>
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <Folder size={15} />
                      <span>{module.name}</span>
                      {!expanded && progressSignal?.kind === "status" ? <FeatureStatus status={progressSignal.label} /> : null}
                      {!expanded && progressSignal?.kind === "count" ? (
                        <span className="project-feature-status is-count" aria-label={`里面有 ${progressSignal.count} 项待推进`} title={`里面有 ${progressSignal.count} 项待推进`}>{progressSignal.label}</span>
                      ) : null}
                    </button>
                    {expanded ? (
                      <div className="project-feature-leaves">
                        <FeatureWikiSections items={module.features} groups={module.featureGroups} devices selectedId={selectedId} forceOpen={Boolean(normalizedQuery) || allModulesExpanded}>{(feature) => (
                          <button type="button" className={`project-feature-leaf${selectedId === feature.id ? " is-selected" : ""}`} key={feature.id} onClick={() => chooseFeature(module, feature)}>
                            <FileText size={14} />
                            <span>{feature.name}</span>
                            <FeatureStatus status={feature.status} />
                          </button>
                        )}</FeatureWikiSections>
                      </div>
                    ) : null}
                  </div>
                );
              }}</FeatureWikiSections>
              {!visibleModules.length ? <Empty>没有匹配的模块或功能。</Empty> : null}
            </div>
          </nav>
        </aside>

        <article className="project-feature-detail">
          <header className="project-feature-detail-head" data-position-anchor={selectedFeature ? `feature:${selectedFeature.id}` : selectedModule ? `module:${selectedModule.id}` : `project:${stableProjectId}`}>
            <div><Kicker>{detailKicker}</Kicker><h2>{detailTitle}</h2></div>
            {selectedFeature ? (
              <div className="project-feature-detail-actions">
                <FeatureStatus status={selectedFeature.status} />
                {canAcceptSelectedFeature && selectedModule?.sourcePath ? (
                  <FeatureAcceptanceButton
                    pending={pendingId === acceptancePendingId}
                    featureName={selectedFeature.name}
                    onAccept={() => void onPreview(acceptancePendingId!, {
                      kind: "acceptProductFeature",
                      projectId: stableProjectId,
                      moduleId: selectedModule.id,
                      featureId: selectedFeature.id,
                      sourcePath: selectedModule.sourcePath!,
                      expectedStatus: "等待验收",
                    })}
                  />
                ) : null}
              </div>
            ) : null}
          </header>
          <div className="project-feature-detail-body">

          <p className="project-feature-intro">
            {selectedFeature?.description || selectedModule?.description || rootDescription}
          </p>
          {selectedFeature?.relatedFeatureId ? <p className="project-feature-attribution-note">此处是界面细项。相关任务与历史用量仍沿用「{relatedFeatureName || selectedRelatedFeatureId}」，不新增计账、不代表总任务已完成。</p> : null}

          {selectedFeature && selectedFeaturePresentationPoints.length ? (
            <section className={`project-feature-points${featurePointsHaveDetails(selectedFeaturePresentationPoints) ? " is-tree" : ""}`} aria-label="具体功能">
              <Kicker>{hasDesignControlCard ? designControlCardLabel : featurePointsHaveDetails(selectedFeaturePresentationPoints) ? "导航摘要" : "具体功能"}</Kicker>
              {stableProjectId === "quit-to-cultivate" && hasDesignControlCard ? (
                <p className="project-feature-mirror-note">改进镜像 · 待本人验收。旧设计稿仍是正式稿；这里仅按原稿重组机制、规则与来源，不在此切换权威。</p>
              ) : null}
              {featurePointsHaveDetails(selectedFeaturePresentationPoints) ? (
                <ul className="project-feature-point-tree">
                  {selectedFeaturePresentationPoints.map((point, index) => <FeaturePointBranch point={point} featureId={selectedFeature.id} expandedNodes={expandedNodes} onToggle={toggleFeaturePoint} key={`${point.text}:${index}`} />)}
                </ul>
              ) : <ul>{selectedFeaturePresentationPoints.map((point) => <li key={point.text}>{point.text}</li>)}</ul>}
            </section>
          ) : null}

          {selectedModule && !selectedFeature ? (
            <section className="project-feature-module-list">
              <Kicker>包含小模块</Kicker>
              <div><FeatureWikiSections items={selectedModule.features} groups={selectedModule.featureGroups}>{(feature) => <button type="button" key={feature.id} onClick={() => chooseFeature(selectedModule, feature)}><span>{feature.name}</span><FeatureStatus status={feature.status} /></button>}</FeatureWikiSections></div>
            </section>
          ) : null}

          <section className={`project-feature-tasks${relatedTasks.length ? "" : " is-empty"}`}>
            <div className="project-feature-section-head">
              <div><Kicker>相关任务</Kicker><h3>从这里选择 S / A / B / C</h3></div>
              <small>进入今明两天后，会自动出现在日程安排的今日事项。</small>
            </div>
            <ManagedTaskList tasks={relatedTasks} pendingId={pendingId} onPreview={onPreview} empty={selectedFeature ? "这个功能当前没有未结任务。" : "当前没有关联任务。"} />
          </section>

          {selectedFeature ? <FeatureWorkContext displayMode={displayMode} projectId={stableProjectId} featureId={selectedRelatedFeatureId} /> : null}

          <div className="project-feature-context">
            <WorkbenchBlock kicker="项目阻塞" title="卡在哪里" quiet={!visibleBlockers.length} scrollable>
              {visibleBlockers.length ? <ul className="project-simple-list is-blockers">{visibleBlockers.map((item) => <li key={item.id || item.text}><HelpCircle size={13} /><span>{item.text}</span></li>)}</ul> : <Empty>{selectedFeature ? "这个功能当前没有关联阻塞。" : selectedModule ? "这个模块当前没有关联阻塞。" : "当前没有记录阻塞。"}</Empty>}
            </WorkbenchBlock>
            <WorkbenchBlock kicker="最近完成" title={selectedFeature ? selectedFeature.name : selectedModule ? selectedModule.name : "按模块查看"} quiet={!recentGroups.some((group) => group.items.length)} scrollable>
              {recentGroups.some((group) => group.items.length) ? (
                <div className="project-recent-groups">
                  {recentGroups.filter((group) => group.items.length).map((group) => (
                    <section key={group.id}>
                      {!selectedModule ? <h4>{group.name}</h4> : null}
                      <ul className="project-simple-list is-completed">
                        {group.items.map((item) => <li key={`${group.id}:${item.text}`}><CheckCircle2 size={13} /><span>{item.text}</span></li>)}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : <Empty>{selectedFeature ? "这个功能近期暂无已完成记录。" : "这个模块近期暂无已完成记录。"}</Empty>}
            </WorkbenchBlock>
          </div>
          </div>

        </article>
      </div>
    </div>
  );
}

type ProjectHomeTaskLane = {
  id: string;
  name: string;
  summary: string;
  tasks: ProjectManagementTask[];
  statusLabel: string;
  statusTone: "active" | "waiting_acceptance";
};

function ProjectHomeTaskLaneLayout({
  projectName,
  scopeEntries,
  lanes,
  selectedId,
  recent,
  pendingId,
  onSelect,
  onPreview,
}: {
  projectName: string;
  scopeEntries?: Array<{ id: "wiki" | "governance"; name: string; summary: string; countLabel: string; meta: string; onOpen: () => void }>;
  lanes: ProjectHomeTaskLane[];
  selectedId: string;
  recent: ReturnType<typeof normalizedRecentCompleted>;
  pendingId: string | null;
  onSelect: (id: string) => void;
  onPreview: (taskId: string, action: WriteAction) => Promise<void>;
}) {
  const selected = lanes.find((lane) => lane.id === selectedId) || lanes[0];
  return (
    <div className="project-hub-layout project-home-task-lanes">
      <section className="project-hub-worklines" aria-label={`${projectName}工作线`}>
        <div className="project-hub-section-head"><Kicker>工作线</Kicker><small>{lanes.length + (scopeEntries?.length || 0)} 条入口</small></div>
        <div className="project-hub-workline-grid">
          {scopeEntries?.map((scopeEntry) => (
            <button type="button" className="project-hub-workline is-scope-entry" onClick={scopeEntry.onOpen} key={scopeEntry.id}>
              <span className="project-hub-workline-icon" aria-hidden>{scopeEntry.id === "governance" ? <Route size={17} /> : <ListTree size={17} />}</span>
              <span className="project-hub-workline-copy"><strong>{scopeEntry.name}</strong><small>{scopeEntry.summary}</small></span>
              <span className="project-hub-scope-count">{scopeEntry.countLabel}</span>
              <span className="project-hub-workline-meta">{scopeEntry.meta}<ChevronRight size={13} /></span>
            </button>
          ))}
          {lanes.map((lane) => (
            <button
              type="button"
              className={`project-hub-workline${selected?.id === lane.id ? " is-selected" : ""}`}
              aria-pressed={selected?.id === lane.id}
              key={lane.id}
              onClick={() => onSelect(lane.id)}
            >
              <span className="project-hub-workline-icon" aria-hidden><LayoutDashboard size={17} /></span>
              <span className="project-hub-workline-copy"><strong>{lane.name}</strong><small>{lane.summary}</small></span>
              <span className={`project-hub-status is-${lane.statusTone}`}>{lane.statusLabel}</span>
              <span className="project-hub-workline-meta">{lane.tasks.length ? `${lane.tasks.length} 个任务` : "暂无任务"}<ChevronRight size={13} /></span>
            </button>
          ))}
        </div>
      </section>

      <aside className="project-hub-detail" aria-live="polite">
        <header>
          <div><Kicker>当前工作线</Kicker><h3>{selected?.name || projectName}</h3></div>
          {selected ? <span className={`project-hub-status is-${selected.statusTone}`}>{selected.statusLabel}</span> : null}
        </header>
        <p>{selected?.summary || "选择左侧工作线查看任务。"}</p>
        <div className={`project-hub-detail-block${selected?.tasks.length ? "" : " is-empty"}`}>
          <Kicker>相关任务</Kicker>
          <ManagedTaskList tasks={selected?.tasks || []} pendingId={pendingId} onPreview={onPreview} empty="这条工作线当前没有任务。" />
        </div>
        <div className={`project-hub-detail-block${recent.length ? "" : " is-empty"}`}>
          <Kicker>最近完成</Kicker>
          {recent.length ? <ul className="project-simple-list is-completed">{recent.slice(0, 6).map((item) => <li key={item.id || item.text}><CheckCircle2 size={13} /><span>{item.text}</span></li>)}</ul> : <Empty>近期暂无已归档的完成记录。</Empty>}
        </div>
      </aside>
    </div>
  );
}

function ManagedProjectHome({
  displayMode,
  project,
  pendingId,
  onBack,
  onOpenWiki,
  onOpenGovernance,
  onPreview,
}: {
  displayMode: boolean;
  project: RegisteredProjectManagement;
  pendingId: string | null;
  onBack: () => void;
  onOpenWiki: (moduleId?: string, featureId?: string) => void;
  onOpenGovernance: () => void;
  onPreview: (taskId: string, action: WriteAction) => Promise<void>;
}) {
  const management = project.management;
  const tree = project.featureTree;
  const [selectedLaneId, setSelectedLaneId] = useState("doing");
  if (!management || !tree) return null;
  const visibleDoing = management.doing
    .filter((task) => isProjectTaskVisibleOnBoard(task))
    .filter((task) => !displayMode || !isDisplayModeHiddenProjectTask(task));
  const visibleNext = management.next
    .filter((task) => isProjectTaskVisibleOnBoard(task))
    .filter((task) => !displayMode || !isDisplayModeHiddenProjectTask(task));
  const visibleRecent = normalizedRecentCompleted(management.recentCompleted)
    .filter((item) => !displayMode || !isDisplayModeSensitiveProjectText(item.text));
  const visibleModules = displayMode ? filterDisplayModeProductModules(tree.modules) : tree.modules;
  const visibleFeatureCount = visibleModules.reduce((total, module) => total + module.features.length, 0);
  const lanes: ProjectHomeTaskLane[] = [
    { id: "doing", name: "当前推进", summary: "正在处理、仍可继续动手的项目任务。", tasks: visibleDoing, statusLabel: "推进中", statusTone: "active" },
    { id: "next", name: "后续任务", summary: "当前工作完成后，按项目计划继续推进。", tasks: visibleNext, statusLabel: "待推进", statusTone: "waiting_acceptance" },
  ];
  const openBattleFeature = (featureId: string) => {
    const module = tree.modules.find((item) => item.features.some((feature) => feature.id === featureId || nestedFeatureNodeContainsId(feature.points, featureId)));
    const feature = module?.features.find((item) => item.id === featureId) || module?.features.find((item) => nestedFeatureNodeContainsId(item.points, featureId));
    onOpenWiki(module?.id, feature?.id);
  };

  return (
    <div className="project-workbench is-project-hub is-managed-project-home">
      <PageTrail items={[projectTrailItem(project)]} />
      <ReturnToTodoButton />

      {management.warnings.length ? (
        <div className="project-management-warning" role="status"><AlertTriangle size={14} /><span>{management.warnings[0]?.message}</span></div>
      ) : null}

      <ExpandableFocusBattle project={project} onOpenFeature={openBattleFeature} />

      <section className="project-hub-intro project-home-intro" aria-label="项目总看板与当前第一步">
        <div className="project-hub-intro-summary">
          <div className="project-hub-intro-label"><Kicker>项目总看板</Kicker><span className="project-hub-status is-active">持续运转</span></div>
          <h2>{managedProjectDisplayName(project)}</h2>
          <p>{management.dashboardSummary || project.cardSummary || tree.description}</p>
        </div>
        <CurrentProjectStep displayMode={displayMode} management={management} pendingId={pendingId} onPreview={onPreview} embedded />
      </section>

      <ProjectHomeTaskLaneLayout
        projectName={managedProjectDisplayName(project)}
        scopeEntries={[
          {
            id: "wiki",
            name: "功能 Wiki 图",
            summary: "从功能 Wiki 图管理小秘书的功能范围、模块状态与任务关联。",
            countLabel: `${visibleModules.length} 模块 · ${visibleFeatureCount} 功能`,
            meta: "进入功能 Wiki 图",
            onOpen: () => onOpenWiki(),
          },
          {
            id: "governance" as const,
            name: "规则总览",
            summary: "看清规则层级、负责边界、维护者，以及规则怎样落到实现和证据。",
            countLabel: "权威文件，仅供只读",
            meta: "查看规则总览",
            onOpen: onOpenGovernance,
          },
        ]}
        lanes={lanes}
        selectedId={selectedLaneId}
        recent={visibleRecent}
        pendingId={pendingId}
        onSelect={(id) => { setSelectedLaneId(id); writeProjectWorkbenchQuery({ workline: id, tree: null, module: null, feature: null, node: null }); }}
        onPreview={onPreview}
      />
    </div>
  );
}

function ExternalSourceNote({ label }: { label: string }) {
  return <p className="project-wb-note"><FolderOpen size={13} /><span>{label} · 项目目录内资料</span></p>;
}

function ProjectHubHome({
  displayMode,
  project,
  pendingId,
  onBack,
  onOpenFeatureTree,
  onPreview,
}: {
  displayMode: boolean;
  project: RegisteredProjectManagement;
  pendingId: string | null;
  onBack: () => void;
  onOpenFeatureTree: (treeId: string, worklineId: string, moduleId?: string, featureId?: string) => void;
  onPreview: (taskId: string, action: WriteAction) => Promise<void>;
}) {
  const hub = project.projectHub as ProjectHub;
  const management = project.management;
  const worklines = useMemo(
    () => hub.worklines
      .filter((workline) => !displayMode || !workline.hiddenInDisplayMode)
      .map((workline, index) => ({ workline, index }))
      .sort((left, right) => Number(right.workline.view.kind === "featureTree") - Number(left.workline.view.kind === "featureTree") || left.index - right.index)
      .map(({ workline }) => workline),
    [displayMode, hub.worklines],
  );
  const defaultWorklineId = worklines.find((workline) => workline.view.kind !== "featureTree")?.id || "";
  const [selectedId, setSelectedId] = useState(() => {
    const requested = readProjectWorkbenchQuery().workline;
    return worklines.some((workline) => workline.id === requested && workline.view.kind !== "featureTree") ? requested! : defaultWorklineId;
  });
  useEffect(() => {
    if (!worklines.some((workline) => workline.id === selectedId && workline.view.kind !== "featureTree")) setSelectedId(defaultWorklineId);
  }, [defaultWorklineId, selectedId, worklines]);
  if (!management) return null;
  const selected = worklines.find((workline) => workline.id === selectedId) || null;
  const taskLinksById = new Map<string, ProjectHub["taskLinks"]>();
  for (const link of hub.taskLinks) taskLinksById.set(link.taskId.toLowerCase(), [...(taskLinksById.get(link.taskId.toLowerCase()) || []), link]);
  const linkedTasks = [...management.doing, ...management.next, ...management.blocked].map((task) => (
    mergeProjectContextAssociations({ ...task, taskIds: [], moduleIds: [] }, [], taskLinksById.get(task.id.toLowerCase()) || [])
  ));
  const tasksById = new Map(linkedTasks.map((task) => [task.id.toLowerCase(), task]));
  const selectedTasks = linkedTasks
    .filter((task) => task.section !== "blocked")
    .filter((task) => !selected || projectHubAssociationMatchesWorkline(hub, task, selected.id))
    .filter((task) => isProjectTaskVisibleOnBoard(task))
    .filter((task) => !displayMode || !isDisplayModeHiddenProjectTask(task));
  const recentLinks = selected ? hub.recentLinks.filter((link) => link.worklineId === selected.id) : [];
  const recentIds = new Set(recentLinks.map((link) => link.recentId));
  const mergeContextAssociations = (item: ReturnType<typeof normalizedProjectContextItems>[number], links: ProjectHub["recentLinks"] = []) => {
    const taskIds = [...new Set([...(item.id ? [item.id.toLowerCase()] : []), ...item.taskIds.map((id) => id.toLowerCase())])];
    const tasks = taskIds.flatMap((taskId) => {
      const task = tasksById.get(taskId);
      return task ? [task] : [];
    });
    const taskLinks = taskIds.flatMap((taskId) => taskLinksById.get(taskId) || []);
    return mergeProjectContextAssociations(item, tasks, [...taskLinks, ...links]);
  };
  const selectedRecent = normalizedRecentCompleted(management.recentCompleted)
    .map((item) => mergeContextAssociations(item, item.id ? hub.recentLinks.filter((link) => link.recentId === item.id) : []))
    .filter((item) => !selected || projectHubAssociationMatchesWorkline(hub, item, selected.id) || Boolean(item.id && recentIds.has(item.id)))
    .filter((item) => !displayMode || !isDisplayModeSensitiveProjectText(item.text));
  const openBattleFeature = (featureId: string) => {
    for (const tree of hub.featureTrees) {
      const module = tree.modules.find((item) => item.features.some((feature) => feature.id === featureId || nestedFeatureNodeContainsId(feature.children, featureId)));
      if (!module) continue;
      const feature = module.features.find((item) => item.id === featureId) || module.features.find((item) => nestedFeatureNodeContainsId(item.children, featureId));
      const workline = hub.worklines.find((item) => item.view.kind === "featureTree" && item.view.treeId === tree.id);
      if (workline) onOpenFeatureTree(tree.id, workline.id, module.id, feature?.id);
      return;
    }
  };

  return (
    <div className="project-workbench is-project-hub">
      <PageTrail items={[projectTrailItem(project)]} />
      <ReturnToTodoButton />

      {management.warnings.length ? (
        <div className="project-management-warning" role="status"><AlertTriangle size={14} /><span>{management.warnings[0]?.message}</span></div>
      ) : null}

      <ExpandableFocusBattle project={project} onOpenFeature={openBattleFeature} />

      <section className="project-hub-intro">
        <div className="project-hub-intro-summary">
          <div className="project-hub-intro-label">
            <Kicker>项目总看板</Kicker>
            <span className={`project-hub-status is-${hub.project.status}`}>{projectHubStatusLabel(hub.project.status)}</span>
          </div>
          <h2>{hub.project.name}</h2>
          <p>{hub.project.summary || management.dashboardSummary || "项目资料已接入；各工作线由项目自己的清单维护。"}</p>
        </div>
        <CurrentProjectStep
          displayMode={displayMode}
          management={management}
          pendingId={pendingId}
          onPreview={onPreview}
          embedded
        />
      </section>

      <div className="project-hub-layout">
        <section className="project-hub-worklines" aria-label={`${project.name}工作线`}>
          <div className="project-hub-section-head"><Kicker>工作线</Kicker><small>{worklines.length} 条受控入口</small></div>
          <div className="project-hub-workline-grid">
            {worklines.map((workline) => {
              const relatedTaskCount = linkedTasks.filter((task) => task.section !== "blocked" && projectHubAssociationMatchesWorkline(hub, task, workline.id)).length;
              const opensTree = workline.view.kind === "featureTree";
              return (
                <button
                  type="button"
                  className={`project-hub-workline${selected?.id === workline.id ? " is-selected" : ""}`}
                  aria-pressed={opensTree ? undefined : selected?.id === workline.id}
                  key={workline.id}
                  onClick={() => {
                    if (workline.view.kind === "featureTree") onOpenFeatureTree(workline.view.treeId, workline.id);
                    else {
                      setSelectedId(workline.id);
                      writeProjectWorkbenchQuery({ workline: workline.id, tree: null, module: null, feature: null, node: null });
                    }
                  }}
                >
                  <span className="project-hub-workline-icon" aria-hidden>{opensTree ? <ListTree size={17} /> : <LayoutDashboard size={17} />}</span>
                  <span className="project-hub-workline-copy">
                    <strong>{workline.name}</strong>
                    <small>{workline.summary || "这条工作线已登记，详细内容请查看项目资料。"}</small>
                  </span>
                  <span className={`project-hub-status is-${workline.status}`}>{projectHubStatusLabel(workline.status)}</span>
                  <span className="project-hub-workline-meta">{opensTree ? "进入功能树" : relatedTaskCount ? `${relatedTaskCount} 个任务关联` : "查看工作线"}<ChevronRight size={13} /></span>
                </button>
              );
            })}
          </div>
        </section>

        <aside className="project-hub-detail" aria-live="polite">
          <header>
            <div><Kicker>{selected ? "当前工作线" : "项目整体"}</Kicker><h3>{selected?.name || hub.project.name}</h3></div>
            <span className={`project-hub-status is-${selected?.status || hub.project.status}`}>{projectHubStatusLabel(selected?.status || hub.project.status)}</span>
          </header>
          <p>{selected?.summary || management.currentStatus || hub.project.summary || "详细内容仍在项目自己的资料中维护。"}</p>
          <div className={`project-hub-detail-block${selectedTasks.length ? "" : " is-empty"}`}>
            <Kicker>相关任务</Kicker>
            <ManagedTaskList tasks={selectedTasks} pendingId={pendingId} onPreview={onPreview} empty={selected ? "这条工作线当前没有明确关联的任务。" : "项目当前没有未完成任务。"} />
          </div>
          <div className={`project-hub-detail-block${selectedRecent.length ? "" : " is-empty"}`}>
            <Kicker>最近完成</Kicker>
            {selectedRecent.length ? <ul className="project-simple-list is-completed">{selectedRecent.map((item) => <li key={item.id || item.text}><CheckCircle2 size={13} /><span>{item.text}</span></li>)}</ul> : <Empty>{selected ? "这条工作线近期暂无关联的完成记录。" : "近期暂无已归档的完成记录。"}</Empty>}
          </div>
          {!displayMode && selected?.source ? <ExternalSourceNote label={selected.source.label} /> : null}
        </aside>
      </div>
    </div>
  );
}

function ManagedProjectWorkbenchView({
  displayMode,
  project,
  coachUrl,
  onBack,
  onWritePreview,
}: {
  displayMode: boolean;
  project: RegisteredProjectManagement;
  coachUrl?: string;
  onBack: () => void;
  onWritePreview: (action: WriteAction) => Promise<void>;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openingCoach, setOpeningCoach] = useState(false);
  const [selectedSimpleLaneId, setSelectedSimpleLaneId] = useState("doing");
  const hub = project.projectHub || null;
  const initialQuery = readProjectWorkbenchQuery();
  const initialInternalView = initialQuery.view === "governance"
    ? "governance"
    : initialQuery.view === "wiki" || Boolean(initialQuery.module || initialQuery.feature || initialQuery.node) ? "wiki" : "home";
  const [internalView, setInternalView] = useState<"home" | "wiki" | "governance">(initialInternalView);
  const defaultTreeId = hub?.project.defaultView === "featureTree" ? hub.featureTrees[0]?.id || null : null;
  const requestedTreeId = readProjectWorkbenchQuery().tree;
  const [activeTreeId, setActiveTreeId] = useState<string | null>(() => hub?.featureTrees.some((tree) => tree.id === requestedTreeId) ? requestedTreeId : defaultTreeId);
  useEffect(() => {
    const requested = readProjectWorkbenchQuery().tree;
    if (requested && !hub?.featureTrees.some((tree) => tree.id === requested)) {
      writeProjectWorkbenchQuery({ tree: null, module: null, feature: null, node: null });
    }
    setActiveTreeId((current) => hub?.featureTrees.some((tree) => tree.id === current)
      ? current
      : hub?.featureTrees.some((tree) => tree.id === readProjectWorkbenchQuery().tree)
        ? readProjectWorkbenchQuery().tree
        : defaultTreeId);
  }, [defaultTreeId, hub, project.projectId]);
  useEffect(() => { notifyWorkbenchPositionReady(); }, [activeTreeId, project.projectId]);
  useEffect(() => {
    const sync = () => {
      if (window.location.pathname !== "/projects") return;
      const query = readProjectWorkbenchQuery();
      setInternalView(query.view === "governance" ? "governance" : query.view === "wiki" || Boolean(query.module || query.feature || query.node) ? "wiki" : "home");
      setActiveTreeId(hub?.featureTrees.some((tree) => tree.id === query.tree) ? query.tree : query.view === "home" ? null : defaultTreeId);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [defaultTreeId, displayMode, hub, project.projectId]);
  const management = project.management;
  if (!management) return null;
  const preview = async (taskId: string, action: WriteAction) => {
    if (pendingId) return;
    setPendingId(taskId);
    try {
      await onWritePreview(action);
    } finally {
      setPendingId(null);
    }
  };
  if (project.featureTree && internalView === "governance") {
    return <GovernanceMapView
      projectId={project.projectId || projectIdFromName(project.name)}
      projectName={managedProjectDisplayName(project)}
      displayMode={displayMode}
      onBack={() => {
        setInternalView("home");
        writeProjectWorkbenchQuery({ view: "home", workline: null, tree: null, module: null, feature: null, node: null });
      }}
    />;
  }
  if (hub && activeTreeId) {
    const tree = hub.featureTrees.find((item) => item.id === activeTreeId);
    if (tree) {
      return (
        <ProductFeatureBoard
          key={tree.id}
          displayMode={displayMode}
          project={project}
          featureTree={productTreeFromProjectHub(tree, displayMode)}
          treeId={tree.id}
          taskLinks={hub.taskLinks}
          recentLinks={hub.recentLinks}
          backLabel="项目主页"
          pendingId={pendingId}
          onBack={() => { setActiveTreeId(null); writeProjectWorkbenchQuery({ view: "home", workline: null, tree: null, module: null, feature: null, node: null }); }}
          onPreview={preview}
        />
      );
    }
  }
  if (hub) {
    return (
      <ProjectHubHome
        displayMode={displayMode}
        project={project}
        pendingId={pendingId}
        onBack={onBack}
        onOpenFeatureTree={(treeId, worklineId, moduleId, featureId) => { setActiveTreeId(treeId); writeProjectWorkbenchQuery({ workline: worklineId, tree: treeId, module: moduleId || null, feature: featureId || null, node: null }); }}
        onPreview={preview}
      />
    );
  }
  if (project.featureTree && internalView === "wiki") {
    return (
      <ProductFeatureBoard
        displayMode={displayMode}
        project={project}
        backLabel="项目主页"
        pendingId={pendingId}
        onBack={() => {
          setInternalView("home");
          writeProjectWorkbenchQuery({ view: "home", workline: null, tree: null, module: null, feature: null, node: null });
        }}
        onPreview={preview}
      />
    );
  }
  if (project.featureTree) {
    return (
      <ManagedProjectHome
        displayMode={displayMode}
        project={project}
        pendingId={pendingId}
        onBack={onBack}
        onOpenWiki={(moduleId, featureId) => {
          setInternalView("wiki");
          writeProjectWorkbenchQuery({ view: "wiki", module: moduleId || null, feature: featureId || null, node: null });
        }}
        onOpenGovernance={() => {
          setInternalView("governance");
          writeProjectWorkbenchQuery({ view: "governance", workline: null, tree: null, module: null, feature: null, node: null });
        }}
        onPreview={preview}
      />
    );
  }
  const visibleDoing = management.doing
    .filter((task) => isProjectTaskVisibleOnBoard(task))
    .filter((task) => !displayMode || !isDisplayModeHiddenProjectTask(task));
  const visibleNext = management.next
    .filter((task) => isProjectTaskVisibleOnBoard(task))
    .filter((task) => !displayMode || !isDisplayModeHiddenProjectTask(task));
  const visibleRecent = normalizedRecentCompleted(management.recentCompleted)
    .filter((item) => !displayMode || !isDisplayModeSensitiveProjectText(item.text));
  const simpleLanes: ProjectHomeTaskLane[] = [
    { id: "doing", name: "当前推进", summary: "正在处理、仍可继续动手的项目任务。", tasks: visibleDoing, statusLabel: "推进中", statusTone: "active" },
    { id: "next", name: "后续任务", summary: "当前工作完成后，按项目计划继续推进。", tasks: visibleNext, statusLabel: "待推进", statusTone: "waiting_acceptance" },
  ];
  return (
    <div className="project-workbench is-project-hub is-task-picker">
      <PageTrail items={[projectTrailItem(project)]} />
      <ReturnToTodoButton />

      {management.warnings.length ? (
        <div className="project-management-warning" role="alert"><AlertTriangle size={14} /><span>{management.warnings[0]?.message}</span></div>
      ) : null}

      <ExpandableFocusBattle project={project} />

      <section className="project-hub-intro project-home-intro" aria-label="项目总看板与当前第一步">
        <div className="project-hub-intro-summary">
          <div className="project-hub-intro-label"><Kicker>项目总看板</Kicker><span className="project-hub-status is-active">持续运转</span></div>
          <h2>{managedProjectDisplayName(project)}</h2>
          <p>{management.dashboardSummary || management.currentStatus || project.cardSummary || "项目已接入任务管理。"}</p>
          <div className="project-home-intro-actions">
            {project.experience ? <ProjectExperienceAction experience={project.experience} /> : null}
            {project.projectId === "life-coach" && coachUrl ? (
              <button
                className="gold-button link"
                type="button"
                disabled={openingCoach}
                onClick={() => {
                  if (openingCoach) return;
                  setOpeningCoach(true);
                  void openCoachWorkbench(coachUrl).finally(() => setOpeningCoach(false));
                }}
              >
                {openingCoach ? "正在打开…" : "打开执行台"} <ArrowUpRight size={14} />
              </button>
            ) : null}
          </div>
        </div>
        <CurrentProjectStep displayMode={displayMode} management={management} pendingId={pendingId} onPreview={preview} embedded />
      </section>

      <ProjectHomeTaskLaneLayout
        projectName={managedProjectDisplayName(project)}
        lanes={simpleLanes}
        selectedId={selectedSimpleLaneId}
        recent={visibleRecent}
        pendingId={pendingId}
        onSelect={(id) => { setSelectedSimpleLaneId(id); writeProjectWorkbenchQuery({ workline: id, tree: null, module: null, feature: null, node: null }); }}
        onPreview={preview}
      />
    </div>
  );
}

export default function ProjectsPage({
  data,
  displayMode = false,
  onWritePreview,
}: {
  data: WorkbenchSummary;
  displayMode?: boolean;
  onWritePreview: (action: WriteAction) => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(() => readProjectQuery());
  const [fullProjectManagement, setFullProjectManagement] = useState<ProjectManagementSnapshot | null>(null);
  const [projectManagementLoaded, setProjectManagementLoaded] = useState(false);
  const [completionExpiryTick, setCompletionExpiryTick] = useState(0);
  const managementProjects = fullProjectManagement?.projects ?? data.projectManagement?.projects ?? EMPTY_MANAGEMENT_PROJECTS;

  useEffect(() => {
    const now = Date.now();
    const nextExpiry = managementProjects
      .flatMap((project) => [...(project.management?.doing ?? []), ...(project.management?.next ?? [])])
      .flatMap((task) => task.done && task.completedAt ? [Date.parse(task.completedAt) + COMPLETED_TASK_BOARD_TTL_MS] : [])
      .filter((expiry) => Number.isFinite(expiry) && expiry > now)
      .sort((a, b) => a - b)[0];
    if (!nextExpiry) return undefined;
    const timer = window.setTimeout(() => setCompletionExpiryTick((tick) => tick + 1), Math.min(nextExpiry - now + 25, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [completionExpiryTick, managementProjects]);

  useEffect(() => {
    const controller = new AbortController();
    setProjectManagementLoaded(false);
    void fetch("/api/project-management", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("project-management-load-failed");
        return response.json() as Promise<ProjectManagementSnapshot>;
      })
      .then((snapshot) => setFullProjectManagement(snapshot))
      .catch((error) => { if (error?.name !== "AbortError") setFullProjectManagement(null); })
      .finally(() => { if (!controller.signal.aborted) setProjectManagementLoaded(true); });
    return () => controller.abort();
  }, [data.generatedAt]);

  const cards = useMemo(
    () => managementProjects.map((project) => managedProjectCard(project, displayMode)),
    [displayMode, managementProjects],
  );

  const managedProject = useMemo(() => {
    if (!openId) return null;
    return managementProjects.find((project) => (project.projectId || projectIdFromName(project.name)) === openId)
      ?? null;
  }, [managementProjects, openId]);

  useEffect(() => {
    const waitingForFullTree = Boolean((managedProject?.hasFeatureTree && !managedProject.featureTree) || (managedProject?.hasProjectHub && !managedProject.projectHub));
    if (!waitingForFullTree || projectManagementLoaded) notifyWorkbenchPositionReady();
  }, [managedProject, openId, projectManagementLoaded]);

  useEffect(() => {
    if (openId && data.projectManagement && !managedProject) setOpenId(null);
  }, [data.projectManagement, openId, managedProject]);

  useEffect(() => {
    writeProjectQuery(openId);
  }, [openId]);

  useEffect(() => {
    const onPop = () => setOpenId(readProjectQuery());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (!data.projectManagement) {
    return (
      <div className="project-workbench">
        <div className="project-management-warning" role="alert">
          <AlertTriangle size={14} />
          <span>事业项目管理数据还没加载。请刷新或重启工作台；当前不会用项目名猜测待办归属。</span>
        </div>
      </div>
    );
  }

  if (((managedProject?.hasFeatureTree && !managedProject.featureTree) || (managedProject?.hasProjectHub && !managedProject.projectHub)) && !projectManagementLoaded) {
    return (
      <div className="project-workbench">
        <PageTrail items={[projectTrailItem(managedProject)]} />
        <Empty>正在读取项目资料…</Empty>
      </div>
    );
  }

  if (managedProject?.management) {
    return (
      <ManagedProjectWorkbenchView
        displayMode={displayMode}
        project={managedProject}
        coachUrl={data.projects.coachUrl}
        onBack={() => setOpenId(null)}
        onWritePreview={onWritePreview}
      />
    );
  }

  if (managedProject) {
    return (
      <div className="project-workbench">
      <PageTrail items={[projectTrailItem(managedProject)]} />
      <ReturnToTodoButton />
        <div className="project-management-warning" role="status"><AlertTriangle size={14} /><span>该项目已归档，没有参与当前聚合的项目管理文件。</span></div>
        {managedProject.experience ? <ProjectExperienceAction experience={managedProject.experience} /> : null}
      </div>
    );
  }

  const activeCards = cards
    .filter((card) => !card.archived)
    .sort((a, b) => projectPortfolioRank(a.name) - projectPortfolioRank(b.name));
  const primary = activeCards.find((card) => projectPortfolioTier(card.name) === "primary");
  const primaryProject = managementProjects.find((project) => project.projectId === primary?.id);
  const primaryManagement = primaryProject?.management;
  const primaryRecentCompleted = normalizedRecentCompleted(primaryManagement?.recentCompleted ?? [])
    .filter((item) => !displayMode || !isDisplayModeSensitiveProjectText(item.text))
    .slice(0, 2);
  const primaryDoing = (primaryManagement?.doing ?? [])
    .filter((task) => isProjectTaskVisibleOnBoard(task))
    .filter((task) => !displayMode || !isDisplayModeHiddenProjectTask(task))
    .slice(0, 2);
  const focusProjects = activeCards.filter((card) => projectPortfolioTier(card.name) === "focus");
  const gameProjects = activeCards.filter((card) => projectPortfolioTier(card.name) === "game");
  const mediaProjects = activeCards.filter((card) => projectPortfolioTier(card.name) === "media");
  const otherActive = activeCards.filter((card) => projectPortfolioTier(card.name) === "other");
  const archivedVentures = cards.filter((c) => c.kind === "venture" && c.archived);
  const openProjectRoot = (projectId: string) => {
    writeProjectWorkbenchQuery({ view: null, workline: null, tree: null, module: null, feature: null, node: null });
    setOpenId(projectId);
  };

  return (
    <div className="projects-portfolio">
      <PortfolioBattleRail projects={managementProjects} onOpenProject={openProjectRoot} />
      {primary || focusProjects.length ? (
        <section className="project-portfolio-tier is-core" aria-label="核心事业">
          <div className="project-core-grid">
            {primary ? (
              <PortfolioCard
                card={primary}
                featured
                onOpen={openProjectRoot}
                summary={primaryProject?.featureTree ? <FeatureTreeStatusSummary tree={primaryProject.featureTree} displayMode={displayMode} /> : undefined}
              >
                <div className="project-columns is-deck">
                  <div>
                    <span>最近做成</span>
                    {primaryRecentCompleted.map((item) => (
                      <p key={item.text}>
                        <CheckCircle2 size={12} />
                        {item.text}
                      </p>
                    ))}
                  </div>
                  <div>
                    <span>在做</span>
                    {primaryDoing.map((task) => (
                      <p key={task.id}>
                        <Target size={12} />
                        {task.displayText}
                      </p>
                    ))}
                  </div>
                </div>
              </PortfolioCard>
            ) : null}
            {focusProjects.length ? (
              <div className="project-core-stack">
                {focusProjects.map((card) => <PortfolioCard key={card.id} card={card} coachUrl={data.projects.coachUrl} coachClientUrl={data.projects.coachClientUrl} onOpen={openProjectRoot} />)}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      {gameProjects.length ? (
        <section className="project-portfolio-tier" aria-labelledby="project-tier-games">
          <div className="project-tier-heading"><Kicker><span id="project-tier-games">游戏产品</span></Kicker></div>
          <div className="project-cards">
          {gameProjects.map((card) => (
            <PortfolioCard key={card.id} card={card} onOpen={openProjectRoot} />
          ))}
          </div>
        </section>
      ) : null}
      {otherActive.length ? (
        <section className="project-portfolio-tier" aria-labelledby="project-tier-other">
          <div className="project-tier-heading"><Kicker><span id="project-tier-other">其他在推</span></Kicker></div>
          <div className="project-cards">
            {otherActive.map((card) => <PortfolioCard key={card.id} card={card} onOpen={openProjectRoot} />)}
          </div>
        </section>
      ) : null}
      {mediaProjects.length ? (
        <section className="project-portfolio-tier is-media" aria-labelledby="project-tier-media">
          <div className="project-tier-heading"><Kicker><span id="project-tier-media">自媒体</span></Kicker></div>
          <div className="project-cards">
            {mediaProjects.map((card) => <PortfolioCard key={card.id} card={card} onOpen={openProjectRoot} />)}
          </div>
        </section>
      ) : null}
      {archivedVentures.length ? (
        <>
          <div className="project-archive-rule" role="separator" aria-label="归档">
            <span>归档</span>
          </div>
          <div className="project-cards is-archived">
            {archivedVentures.map((card) => (
              <PortfolioCard key={card.id} card={card} onOpen={openProjectRoot} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
