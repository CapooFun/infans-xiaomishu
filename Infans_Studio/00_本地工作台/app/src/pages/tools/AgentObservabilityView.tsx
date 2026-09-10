import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronDown, CircleDollarSign, RefreshCw } from "lucide-react";
import { Empty, jsonFetch } from "../../page-shared";
import type { AgentObservabilitySnapshot, AgentObservabilityTask, AgentUsage } from "../../types";
import "./agent-observability.css";

const PERIODS = [
  { id: "24h", label: "24 小时", query: "hours=24" },
  { id: "3", label: "3 天", query: "days=3" },
  { id: "7", label: "7 天", query: "days=7" },
  { id: "30", label: "30 天", query: "days=30" },
  { id: "90", label: "90 天", query: "days=90" },
] as const;
type PeriodOption = (typeof PERIODS)[number];
const DEFAULT_PERIOD = PERIODS.find((item) => item.id === "30") ?? PERIODS[3];
const PERIOD_STORAGE_KEY = "infans-agent-observability-period";
const clientSnapshotCache = new Map<string, AgentObservabilitySnapshot>();

function readStoredPeriod(): PeriodOption {
  if (typeof window === "undefined") return DEFAULT_PERIOD;
  try {
    const stored = window.localStorage.getItem(PERIOD_STORAGE_KEY);
    return PERIODS.find((item) => item.id === stored) ?? DEFAULT_PERIOD;
  } catch {
    return DEFAULT_PERIOD;
  }
}

function writeStoredPeriod(periodId: string) {
  try {
    window.localStorage.setItem(PERIOD_STORAGE_KEY, periodId);
  } catch {
    // 无痕或配额满时只影响本次会话，账册仍按当前选择读取。
  }
}
type TrendSource = "all" | "codex" | "cursor" | "external";

const TREND_SOURCE_LABELS: Record<TrendSource, string> = {
  all: "全部来源",
  codex: "Codex",
  cursor: "Cursor",
  external: "外部模型",
};

function compact(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
}

function fullNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("zh-CN").format(Number(value));
}

function usageField(usage: AgentUsage | undefined, key: "inputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens") {
  const status = usage?.fieldStatus?.[key];
  if (status === "unknown") return "未提供";
  return `${compact(usage?.[key])}${status === "partial" ? " · 已知部分" : ""}`;
}

function percent(value: number) {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(Number.isFinite(value) ? value : 0);
}

function shortDate(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function duration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return "时长未知";
  const minutes = Math.max(1, Math.round(Number(value) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;
}

function cacheRatio(usage: AgentUsage | null) {
  return usage?.inputTokens ? usage.cachedInputTokens / usage.inputTokens : 0;
}

function isSingleRunGauge(task: AgentObservabilityTask) {
  return task.usageMode === "this-run" || (task.kind === "cursor" && task.hasChildren === false);
}

function cacheReadKnown(usage: AgentUsage | null | undefined) {
  return usage?.fieldStatus?.cachedInputTokens !== "unknown" && Boolean(usage?.inputTokens);
}

function gaugeCaption(task: AgentObservabilityTask) {
  if (!task.totalUsage) return task.processState || "未提供";
  if (!isSingleRunGauge(task)) {
    return `${compact(task.selfUsage?.totalTokens)} + ${compact(task.childUsage?.totalTokens)}`;
  }
  const input = task.totalUsage.inputTokens || 0;
  const cached = Math.min(input, task.totalUsage.cachedInputTokens || 0);
  if (cacheReadKnown(task.totalUsage) && cached > 0) {
    return `${compact(input - cached)} + ${compact(cached)}`;
  }
  return `本次用量 ${compact(task.totalUsage.totalTokens)}`;
}

function qualityLabel(task: AgentObservabilityTask) {
  if (task.sourceQuality === "provider-reported") return "服务商回传";
  if (task.sourceQuality === "cli-reported") return "CLI 回传";
  if (task.sourceQuality === "account-history") return "账户 Usage";
  if (task.sourceQuality === "local-count") return "本地精确统计";
  return "仅有执行记录";
}

function taskKindLabel(task: AgentObservabilityTask) {
  if (task.sourceQuality === "account-history") return "用量";
  if (task.kind === "codex") return "窗口";
  return "批次";
}

function friendlyAccountKind(kind: string) {
  const raw = String(kind || "");
  if (/ULTRA/iu.test(raw)) return "Ultra 套餐";
  if (/INCLUDED/iu.test(raw)) return "套餐内";
  if (/ON_DEMAND|ERQUEST|REQUEST/iu.test(raw)) return "按量";
  return raw.replace(/^USAGE_EVENT_KIND_/u, "").replaceAll("_", " ") || "账户 Usage";
}

function attributionBasisLabel(basis: AgentObservabilityTask["featureMatches"][number]["basis"]) {
  if (basis === "verified") return "已核实";
  if (basis === "role") return "任务角色";
  return "对话摘要";
}

function TaskGauge({ task }: { task: AgentObservabilityTask }) {
  if (!task.totalUsage) return <div className="ao-task-unmeasured">Token 未提供</div>;
  if (isSingleRunGauge(task)) {
    const input = task.totalUsage.inputTokens || 0;
    const cached = Math.min(input, task.totalUsage.cachedInputTokens || 0);
    if (cacheReadKnown(task.totalUsage) && cached > 0) {
      const cacheShare = (cached / input) * 100;
      return (
        <div className="ao-task-gauge ao-task-gauge-single" aria-label={`新输入 ${fullNumber(input - cached)}，缓存 ${fullNumber(cached)}`}>
          <span className="ao-input-fresh" style={{ width: `${100 - cacheShare}%` }} />
          <span className="ao-input-cached" style={{ width: `${cacheShare}%` }} />
        </div>
      );
    }
    return (
      <div className="ao-task-gauge ao-task-gauge-single" aria-label={`本次用量 ${fullNumber(task.totalUsage.totalTokens)}`}>
        <span className="ao-task-gauge-self" style={{ width: "100%" }} />
      </div>
    );
  }
  const total = Math.max(1, task.totalUsage.totalTokens);
  const selfShare = Math.max(0, Math.min(100, (task.selfUsage?.totalTokens || 0) / total * 100));
  const childShare = Math.max(0, 100 - selfShare);
  return (
    <div className="ao-task-gauge" aria-label={`自身 ${fullNumber(task.selfUsage?.totalTokens)}，子任务 ${fullNumber(task.childUsage?.totalTokens)}，任务链 ${fullNumber(task.totalUsage.totalTokens)}`}>
      <span className="ao-task-gauge-self" style={{ width: `${selfShare}%` }} />
      <span className="ao-task-gauge-child" style={{ width: `${childShare}%` }} />
    </div>
  );
}

function ProjectAttribution({ task }: { task: AgentObservabilityTask }) {
  if (!task.projectMatches.length) return <span className="ao-unclassified">暂未判断项目</span>;
  return (
    <div className="ao-attribution">
      {task.projectMatches.map((project) => {
        const features = task.featureMatches.filter((match) => match.projectId === project.projectId);
        return (
          <section key={project.projectId}>
            <header><strong>{project.projectName}</strong><em>{project.relevance}%</em></header>
            {features.length ? (
              <div className="ao-feature-evidence">
                {features.map((match) => (
                  <div key={match.id} title={`${match.projectName} · ${match.moduleName} · ${match.name}`}>
                    <strong>{match.name}</strong>
                    <em>{attributionBasisLabel(match.basis)} · {match.relevance}%</em>
                  </div>
                ))}
              </div>
            ) : <p>目前只确认到项目</p>}
          </section>
        );
      })}
    </div>
  );
}

type FeatureProjectGroup = {
  projectId: string;
  projectName: string;
  usage: number;
  taskCount: number;
  features: AgentObservabilitySnapshot["features"];
};

function ScheduledTaskCard({
  ledger,
  expanded,
  onToggle,
}: {
  ledger: NonNullable<AgentObservabilitySnapshot["scheduledRuns"]>;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="ao-daily-card ao-duty-card">
      <button type="button" className="ao-project-toggle" onClick={onToggle} aria-expanded={expanded} aria-controls="ao-duty-body">
        <div><strong>定时值班</strong><span>{ledger.runCount} 次真实运行</span></div>
        <b>{ledger.measuredRunCount ? `${compact(ledger.usage.totalTokens)} Token` : ledger.runCount ? "Token 未知" : "暂无记录"}</b>
        <ChevronDown size={16} className={expanded ? "is-open" : ""} />
      </button>
      {expanded ? (
        <div id="ao-duty-body" className="ao-daily-body">
          <p className="ao-daily-caption">AI 按时来值班，每一趟单独记。</p>
          {ledger.runs.length ? (
            <div className="ao-duty-list" tabIndex={0} aria-label="定时任务每次调度消耗">
              {ledger.runs.map((run) => (
                <article key={run.id}>
                  <header>
                    <strong title={run.roleName}>{run.roleName}</strong>
                    <b>{run.measured ? compact(run.usage?.totalTokens) : "未记 Token"}</b>
                  </header>
                  <p><span>{run.agent}</span><span>{shortDate(run.startedAt || run.updatedAt)} · {duration(run.durationMs)}{run.processState === "failed" || (run.exitCode != null && run.exitCode !== 0) ? " · 失败" : ""}</span></p>
                  <small>{run.model} · {run.trigger === "codex-heartbeat" ? "Codex 心跳" : run.trigger === "launchd" ? "本机定时" : "触发来源未记录"}</small>
                </article>
              ))}
            </div>
          ) : <p className="ao-feature-empty">这段时间没有值班记录</p>}
        </div>
      ) : null}
    </section>
  );
}

function PersonalLifeCard({ group, tasks, expanded, onToggle }: { group: FeatureProjectGroup; tasks: AgentObservabilityTask[]; expanded: boolean; onToggle: () => void }) {
  const entries = group.features.filter((item) => item.taskCount > 0);
  const maximum = Math.max(1, ...entries.map((item) => item.usage.totalTokens));
  return (
    <section className="ao-daily-card ao-life-card">
      <button type="button" className="ao-project-toggle" onClick={onToggle} aria-expanded={expanded} aria-controls="ao-life-body">
        <div><strong>{group.projectName}</strong><span>{group.taskCount} 次归属</span></div>
        <b>{!group.taskCount ? "暂无记录" : entries.some((entry) => entry.measuredTaskCount > 0) ? `${compact(group.usage)} Token` : "Token 未知"}</b>
        <ChevronDown size={16} className={expanded ? "is-open" : ""} />
      </button>
      {expanded ? (
        <div id="ao-life-body" className="ao-daily-body">
          <p className="ao-daily-caption">订票、购物、出行，以及让 AI 帮忙办的事。</p>
          {entries.length ? (
            <div className="ao-life-categories" aria-label="个人生活运营事务分类">
              {entries.map((entry) => (
                <article key={entry.id}>
                  <div><strong>{entry.nodeKind === "project" ? "其他生活事务" : entry.name}</strong><span>{entry.taskCount} 次归属</span><b>{entry.measuredTaskCount ? compact(entry.usage.totalTokens) : "Token 未知"}</b></div>
                  <div className="ao-life-bar"><i style={{ width: `${entry.usage.totalTokens / maximum * 100}%` }} /></div>
                </article>
              ))}
            </div>
          ) : <p className="ao-feature-empty">这段时间还没有可归属的生活事务</p>}
          {tasks.length ? (
            <div className="ao-life-recent">
              <h4>近期生活事务</h4>
              <p className="ao-life-recent-note">所选周期内的整件事用量，含子任务</p>
              <ul>{tasks.map((task) => (
                <li key={task.id}>
                  <div className="ao-life-task-main">
                    <strong title={task.title}>{task.title}</strong>
                    <time dateTime={task.updatedAt || undefined}>{shortDate(task.updatedAt)}</time>
                  </div>
                  <b className="ao-life-task-usage">{!task.totalUsage || task.totalUsage.fieldStatus?.totalTokens === "unknown" ? "Token 未知" : `${usageField(task.totalUsage, "totalTokens")} Token`}</b>
                </li>
              ))}</ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function FeatureProjectCard({ group, expanded, onToggle }: { group: FeatureProjectGroup; expanded: boolean; onToggle: () => void }) {
  const projectEntries = group.features.filter((item) => item.nodeKind === "project");
  const featureEntries = group.features.filter((item) => item.nodeKind === "feature");
  const featureMaximum = Math.max(1, ...featureEntries.map((item) => item.usage.totalTokens));
  return (
    <section className={`ao-project-card${expanded ? " is-expanded" : ""}`}>
      <button type="button" className="ao-project-toggle" onClick={onToggle} aria-expanded={expanded}>
        <div><strong>{group.projectName}</strong><span>{group.taskCount} 次归属</span></div>
        <b>{compact(group.usage)} Token</b>
        <ChevronDown size={16} className={expanded ? "is-open" : ""} />
      </button>
      {expanded ? (
        <div className="ao-project-body">
          {projectEntries.length ? (
            <div className="ao-project-summary" aria-label={`${group.projectName}项目级消耗`}>
              {projectEntries.map((entry, index) => (
                <article key={entry.id}>
                  <span className="ao-project-letter">{String.fromCharCode(65 + index)}</span>
                  <div><small>项目级账项</small><strong>{entry.name}</strong></div>
                  <div className="ao-project-amount"><b>{entry.measuredTaskCount ? compact(entry.usage.totalTokens) : "Token 未知"}</b><em>{entry.taskCount} 条任务链</em></div>
                </article>
              ))}
            </div>
          ) : null}
          {featureEntries.length ? (
            <>
              <div className="ao-feature-divider"><strong>功能细项</strong><span>仅在细项之间比较</span></div>
              <div className="ao-feature-list" tabIndex={0} aria-label={`${group.projectName}功能细项累计`}>
                {featureEntries.map((feature, index) => (
                  <article key={feature.id}>
                    <span className="ao-feature-rank">{String(index + 1).padStart(2, "0")}</span>
                    <div><small>{feature.moduleName}</small><strong>{feature.name}</strong></div>
                    <div className="ao-feature-bar"><i style={{ width: `${feature.usage.totalTokens / featureMaximum * 100}%` }} /></div>
                    <b>{feature.measuredTaskCount ? compact(feature.usage.totalTokens) : "Token 未知"}</b>
                    <em>{feature.taskCount} 条</em>
                  </article>
                ))}
              </div>
            </>
          ) : <p className="ao-feature-empty">暂未关联到具体功能</p>}
        </div>
      ) : null}
    </section>
  );
}

function smoothLine(points: Array<{ x: number; y: number }>) {
  if (!points.length) return "";
  return points.slice(1).reduce((path, point, index) => {
    const previous = points[index];
    const middle = (previous.x + point.x) / 2;
    return `${path} C${middle.toFixed(1)},${previous.y.toFixed(1)} ${middle.toFixed(1)},${point.y.toFixed(1)} ${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }, `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`);
}

function selectTrendPeaks<T extends { row: AgentObservabilitySnapshot["trend"][number]; index: number }>(points: T[]) {
  const limit = points.length <= 7 ? 2 : points.length <= 30 ? 3 : 5;
  const minimumGap = Math.max(1, Math.floor(points.length / (limit * 2.5)));
  const local = points.filter((point, index) => point.row.totalTokens > 0
    && point.row.totalTokens >= (points[index - 1]?.row.totalTokens ?? -1)
    && point.row.totalTokens >= (points[index + 1]?.row.totalTokens ?? -1));
  const ranked = [...local, ...points.filter((point) => point.row.totalTokens > 0)]
    .sort((left, right) => right.row.totalTokens - left.row.totalTokens || left.index - right.index);
  const selected: T[] = [];
  const seen = new Set<number>();
  for (const candidate of ranked) {
    if (seen.has(candidate.index) || selected.some((peak) => Math.abs(peak.index - candidate.index) < minimumGap)) continue;
    selected.push(candidate);
    seen.add(candidate.index);
    if (selected.length >= limit) break;
  }
  return selected.sort((left, right) => left.index - right.index);
}

function TrendFigure({ data, source }: { data: AgentObservabilitySnapshot["trend"]; source: TrendSource }) {
  const geometry = useMemo(() => {
    const visible = data;
    const width = 720;
    const height = 174;
    const padX = 10;
    const padTop = 28;
    const padBottom = 10;
    const maximum = Math.max(1, ...visible.map((row) => row.totalTokens));
    const points = visible.map((row, index) => {
      const x = padX + (visible.length <= 1 ? 0 : index / (visible.length - 1) * (width - padX * 2));
      const y = height - padBottom - row.totalTokens / maximum * (height - padTop - padBottom);
      return { x, y, row, index };
    });
    const line = smoothLine(points);
    const area = points.length ? `${line} L${points.at(-1)?.x},${height - padBottom} L${points[0].x},${height - padBottom} Z` : "";
    return { width, height, line, area, maximum, visible, peaks: selectTrendPeaks(points) };
  }, [data]);
  return (
    <figure className="ao-trend">
      <figcaption>
        <div><span>每日用量 · {TREND_SOURCE_LABELS[source]}</span><strong>近 {geometry.visible.length} 天</strong></div>
        <div className="ao-trend-meta"><small>{source === "all" ? "点击来源卡片可切换" : "再次点击当前卡片返回汇总"}</small><span><i />平稳<i />偏高<i />高峰</span></div>
      </figcaption>
      <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="img" aria-label={`${TREND_SOURCE_LABELS[source]}每日 Token 用量趋势`}>
        <defs>
          <linearGradient id="ao-trend-stroke" x1="0" y1={geometry.height} x2="0" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" className="ao-trend-low" /><stop offset="52%" className="ao-trend-mid" /><stop offset="100%" className="ao-trend-high" />
          </linearGradient>
          <linearGradient id="ao-trend-fill" x1="0" y1="0" x2="0" y2={geometry.height} gradientUnits="userSpaceOnUse">
            <stop offset="0%" className="ao-trend-fill-top" /><stop offset="100%" className="ao-trend-fill-bottom" />
          </linearGradient>
        </defs>
        <line x1="10" y1="72" x2="710" y2="72" className="ao-trend-guide" />
        <line x1="10" y1="118" x2="710" y2="118" className="ao-trend-guide" />
        <line x1="10" y1="164" x2="710" y2="164" className="ao-trend-axis" />
        <path d={geometry.area} className="ao-trend-area" />
        <path d={geometry.line} className="ao-trend-line" />
        {geometry.peaks.map((peak) => (
          <g key={peak.row.day} className="ao-trend-peak-mark">
            <circle cx={peak.x} cy={peak.y} r="4" className="ao-trend-peak" />
            <text x={Math.max(30, Math.min(690, peak.x))} y={Math.max(13, peak.y - 10)} textAnchor="middle">{peak.row.day.slice(5)}</text>
          </g>
        ))}
      </svg>
      <div className="ao-trend-foot"><span>{geometry.visible[0]?.day.slice(5)}</span><span>{geometry.visible.at(-1)?.day.slice(5)}</span></div>
    </figure>
  );
}

function anomalyCauseLabel(cause: AgentObservabilitySnapshot["anomalies"][number]["cause"]) {
  if (cause === "child-chain") return "子任务链拉高";
  if (cause === "cache-drop") return "缓存命中下降";
  if (cause === "self-task") return "窗口自身拉高";
  return "自身与子任务共同拉高";
}

function AnomalyPulse({ items }: { items: AgentObservabilitySnapshot["anomalies"] }) {
  return (
    <section className="ao-section ao-anomaly-pulse">
      <header>
        <div>
          <span>异常脉冲</span>
          <h3>哪些任务突然变胖了</h3>
          <div className="ao-usage-legend" aria-label="任务用量颜色"><span><i />自身</span><span><i />子任务</span></div>
        </div>
        <p>青绿是窗口自身，琥珀黄是子任务。只和同功能或同阶段的历史任务比较；首次搭建不报警。</p>
      </header>
      {items.length ? (
        <div className="ao-anomaly-grid">
          {items.slice(0, 4).map((item) => {
            const total = Math.max(1, item.totalTokens);
            return (
              <article key={item.taskId} className={`is-${item.severity}`}>
                <div className="ao-anomaly-ratio"><Activity size={15} /><strong>{item.multiple.toFixed(1)}×</strong><span>{anomalyCauseLabel(item.cause)}</span></div>
                <h4 title={item.title}>{item.title}</h4>
                <p>{item.scopeName} · 窗口 {item.reference}</p>
                <div className="ao-anomaly-gauge" aria-label={`自身 ${fullNumber(item.selfTokens)}，子任务 ${fullNumber(item.childTokens)}`}>
                  <i style={{ width: `${item.selfTokens / total * 100}%` }} /><i style={{ width: `${item.childTokens / total * 100}%` }} />
                </div>
                <dl>
                  <div><dt>本次</dt><dd>{compact(item.totalTokens)}</dd></div>
                  <div><dt>历史中位</dt><dd>{compact(item.baselineTokens)}</dd></div>
                  <div><dt>多出</dt><dd>+{compact(item.deltaTokens)}</dd></div>
                </dl>
              </article>
            );
          })}
        </div>
      ) : <p className="ao-anomaly-empty">当前周期没有达到报警门槛的持续迭代任务。</p>}
    </section>
  );
}

type RecentTaskSource = "all" | "codex" | "cursor";

function RecentTaskUsage({ snapshot, updatedAt }: { snapshot: AgentObservabilitySnapshot; updatedAt: string }) {
  const [source, setSource] = useState<RecentTaskSource>("all");
  const items = source === "all" ? snapshot.recentTasks : snapshot.recentTasksByAgent?.[source] || [];
  const sourceLabel = source === "all" ? "全部智能体" : source === "codex" ? "Codex" : "Cursor";
  const maximum = Math.max(1, ...items.map((task) => task.totalUsage?.totalTokens || 0));
  const latestVisibleAt = items.reduce((latest, task) => Date.parse(task.updatedAt || "") > Date.parse(latest || "") ? task.updatedAt || latest : latest, updatedAt);
  return (
    <section className="ao-section ao-recent-tasks">
      <header>
        <div className="ao-recent-title">
          <span>近期任务流</span><h3>最近 10 个任务用了多少 Token</h3>
          <div className={`ao-usage-legend${source === "cursor" ? " is-cache" : ""}`} aria-label="任务用量颜色">{source === "cursor" ? <><span><i />新输入</span><span><i />缓存</span></> : <><span><i />自身</span><span><i />子任务</span></>}</div>
          <div className="ao-recent-filters" role="tablist" aria-label="筛选近期任务智能体">
            {(["all", "codex", "cursor"] as const).map((item) => (
              <button key={item} type="button" role="tab" aria-selected={source === item} className={source === item ? "is-active" : ""} onClick={() => setSource(item)}>
                {item === "all" ? "全部" : item === "codex" ? "Codex" : "Cursor"}
              </button>
            ))}
          </div>
        </div>
        <p>当前查看 {sourceLabel}，按窗口更新时间取最近 10 项；条长只在本组比较，框内约显示 5 项。更新至 {shortDate(latestVisibleAt)}。</p>
      </header>
      {items.length ? (
        <div className="ao-recent-list" tabIndex={0} aria-label="最近 10 个任务 Token 消耗，可在框内滚动">
          {items.map((task, index) => {
            const total = Math.max(1, task.totalUsage?.totalTokens || 0);
            const input = task.totalUsage?.inputTokens || 0;
            const cached = Math.min(input, task.totalUsage?.cachedInputTokens || 0);
            const showCache = isSingleRunGauge(task) && cacheReadKnown(task.totalUsage) && cached > 0;
            const primaryShare = showCache
              ? Math.max(0, Math.min(100, ((input - cached) / input) * 100))
              : Math.max(0, Math.min(100, (task.selfUsage?.totalTokens ?? total) / total * 100));
            const project = task.projectMatches[0]?.projectName || "其他";
            return (
              <article key={task.id}>
                <span className="ao-recent-rank">{String(index + 1).padStart(2, "0")}</span>
                <div className="ao-recent-name"><strong title={task.title}>{task.title}</strong><span>{task.agent} · {project} · {shortDate(task.updatedAt)}</span></div>
                <div className={showCache ? "ao-recent-track is-cache" : "ao-recent-track"} aria-label={showCache ? `${task.title}，新输入 ${fullNumber(input - cached)}，缓存 ${fullNumber(cached)}` : `${task.title}，${fullNumber(total)} Token`}>
                  <div style={{ width: `${total / maximum * 100}%` }}><i style={{ width: `${primaryShare}%` }} /><i style={{ width: `${100 - primaryShare}%` }} /></div>
                </div>
                <b>{compact(total)}</b>
              </article>
            );
          })}
        </div>
      ) : <p className="ao-anomaly-empty">当前周期还没有可测量的 {sourceLabel} 任务。</p>}
    </section>
  );
}

function ExternalUsageSummary({ items, account, period }: { items: AgentObservabilitySnapshot["externalDetails"]; account: AgentObservabilitySnapshot["externalAccount"]; period: string }) {
  return (
    <div className="ao-external-expansion" aria-label={`${period}外部模型汇总`}>
      <div className="ao-external-expansion-head"><strong>{period}模型汇总</strong><span>仅统计 Token、请求和实付，不追踪聊天窗口</span></div>
      {account ? (
        <div className="ao-external-reconcile" aria-label="OpenRouter 累计费用对账">
          <div><span>当前密钥累计</span><strong>{account.usageUsd == null ? "暂不可读" : `$${account.usageUsd.toFixed(6)}`}</strong></div>
          <div><span>接入后本地实账</span><strong>${account.attributedCostUsd.toFixed(6)}</strong><small>{account.requestCount} 次请求</small></div>
          <div className={account.unattributedCostUsd && account.unattributedCostUsd > 0 ? "has-gap" : ""}><span>接入前历史未归属</span><strong>{account.unattributedCostUsd == null ? "—" : `$${account.unattributedCostUsd.toFixed(6)}`}</strong><small>{account.note}</small></div>
        </div>
      ) : null}
      {items.length ? (
        <div className="ao-external-models">
          {items.map((item) => (
            <div className="ao-external-model" key={item.id}>
              <div><strong>{item.model}</strong><span>{item.upstreamProvider || item.provider} · 小秘书语音聊天 · 最近 {shortDate(item.lastAt)}</span></div>
              <dl>
                <div><dt>Token</dt><dd>{compact(item.usage.totalTokens)}</dd></div>
                <div><dt>请求</dt><dd>{item.requestCount}</dd></div>
                <div><dt>实付</dt><dd>${item.costUsd.toFixed(6)}</dd></div>
              </dl>
            </div>
          ))}
        </div>
      ) : <p className="ao-external-empty">{period === "24 小时" ? "近 24 小时" : `这 ${period}`}还没有接入后的外部模型实账；接入前费用只保留账户汇总。</p>}
    </div>
  );
}

export default function AgentObservabilityView({ active }: { active: boolean }) {
  const [period, setPeriod] = useState<PeriodOption>(readStoredPeriod);
  const [data, setData] = useState<AgentObservabilitySnapshot | null>(() => clientSnapshotCache.get(readStoredPeriod().id) || null);
  const [loading, setLoading] = useState(() => !clientSnapshotCache.has(readStoredPeriod().id));
  const [error, setError] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [trendSource, setTrendSource] = useState<TrendSource>("all");
  const [visibleTaskCount, setVisibleTaskCount] = useState(10);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const requestSequence = useRef(0);

  const load = useCallback(async (force = false) => {
    const requestId = ++requestSequence.current;
    const cached = clientSnapshotCache.get(period.id);
    if (!force && cached) setData(cached);
    setLoading(true);
    setError("");
    try {
      const snapshot = await jsonFetch<AgentObservabilitySnapshot>(`/api/tools/agent-observability?${period.query}${force ? "&refresh=1" : ""}`);
      clientSnapshotCache.set(period.id, snapshot);
      if (requestId === requestSequence.current) setData(snapshot);
    } catch (reason) {
      if (requestId === requestSequence.current) setError(reason instanceof Error ? reason.message : "读不到智能体消耗账册");
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    writeStoredPeriod(period.id);
  }, [period]);

  useEffect(() => {
    if (active) {
      setVisibleTaskCount(10);
      const cached = clientSnapshotCache.get(period.id) || null;
      setData(cached);
      setLoading(!cached);
      void load(false);
    }
    return () => { requestSequence.current += 1; };
  }, [active, load]);

  useEffect(() => {
    if (!active || loading || error || data?.cacheStatus !== "refreshing") return;
    const timer = window.setTimeout(() => void load(false), 2500);
    return () => window.clearTimeout(timer);
  }, [active, data, error, loading, load]);

  const toggleProject = useCallback((projectId: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const toggleTrendSource = useCallback((source: Exclude<TrendSource, "all">) => {
    setTrendSource((current) => current === source ? "all" : source);
  }, []);

  if (loading && !data) return <Empty>正在核对本地任务链和用量记录。</Empty>;

  const summary = data?.summary;
  const selectedTrend = data ? (data.agentTrends?.[trendSource] || (trendSource === "all" ? data.trend : [])) : [];
  const featureGroups = data ? [...data.features.reduce((groups, feature) => {
    const group = groups.get(feature.projectId) || { projectId: feature.projectId, projectName: feature.projectName, usage: 0, taskCount: 0, features: [] as typeof data.features };
    group.usage += feature.usage.totalTokens;
    group.taskCount += feature.taskCount;
    group.features.push(feature);
    groups.set(feature.projectId, group);
    return groups;
  }, new Map<string, { projectId: string; projectName: string; usage: number; taskCount: number; features: typeof data.features }>()).values()]
    .sort((left, right) => {
      if (left.projectId === "personal-life-operations") return right.projectId === "personal-life-operations" ? 0 : -1;
      if (right.projectId === "personal-life-operations") return 1;
      if (left.projectId === "other") return right.projectId === "other" ? 0 : 1;
      if (right.projectId === "other") return -1;
      return right.usage - left.usage || right.taskCount - left.taskCount;
    }) as FeatureProjectGroup[] : [];
  const personalLifeGroup = featureGroups.find((group) => group.projectId === "personal-life-operations");
  const recentLifeTasks = [...new Map([
    ...(data?.tasks || []), ...(data?.recentTasks || []),
    ...(data?.recentTasksByAgent?.codex || []), ...(data?.recentTasksByAgent?.cursor || []),
  ].map((task) => [task.id, task])).values()].filter((task) => task.projectMatches.some((project) => project.projectId === "personal-life-operations"))
    .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""))
    .slice(0, 3);
  return (
    <div className="agent-observability">
      <header className="ao-toolbar">
        <div>
          <span>LOCAL AGENT LEDGER</span>
          <h2>任务消耗账册</h2>
          <p>看清一次任务自己用了多少、子任务带走多少，以及主要属于哪个项目。</p>
        </div>
        <div className="ao-toolbar-actions">
          <div className="ao-period" aria-label="统计周期">
            {PERIODS.map((item) => <button type="button" key={item.id} className={period.id === item.id ? "is-active" : ""} onClick={() => setPeriod(item)}>{item.label}</button>)}
          </div>
          <button type="button" className="ao-refresh" onClick={() => void load(true)} disabled={loading} aria-label="重新扫描并刷新任务消耗账册">
            <RefreshCw size={15} className={loading ? "spin" : ""} />{loading ? "更新中" : "刷新"}
          </button>
        </div>
      </header>

      {data ? <p className="ao-cache-status" aria-live="polite">{data.cacheStatus === "refreshing" ? "先看上次结果，后台更新中" : `${data.cacheStatus === "fresh" ? "更新至" : "已显示上次结果"} · ${shortDate(data.updatedAt)}`}<span>手动刷新可重新核对最新用量</span></p> : null}
      {error ? <div className="ao-error" role="alert">{error}</div> : null}

      <section className="ao-ledger" aria-label="总消耗和智能体来源">
        <div className="ao-ledger-total">
          <span>{period.label}可测量总量</span>
          <strong>{compact(summary?.totalTokens || 0)}</strong>
          <em>Token</em>
          <div className="ao-usage-legend is-cache" aria-label="输入用量颜色"><span><i />新输入</span><span><i />缓存</span></div>
          <div className="ao-input-composition">
            <span className="ao-input-fresh" style={{ width: `${100 - (summary?.cacheRatio || 0) * 100}%` }} />
            <span className="ao-input-cached" style={{ width: `${(summary?.cacheRatio || 0) * 100}%` }} />
          </div>
          <p><b>{percent(summary?.cacheRatio || 0)}</b> 提示词已命中缓存（节省重复开销）</p>
        </div>
        <dl className="ao-ledger-facts">
          <div><dt>输入</dt><dd>{usageField(summary, "inputTokens")}</dd></div>
          <div><dt>输出</dt><dd>{usageField(summary, "outputTokens")}</dd></div>
          <div><dt>推理</dt><dd>{summary?.reasoningTokensStatus === "unknown" ? "未提供" : <>{compact(summary?.reasoningTokens)}{summary?.reasoningTokensStatus === "partial" ? <small> 已知部分</small> : null}</>}</dd></div>
          <div><dt>任务链</dt><dd>{fullNumber(summary?.taskChainCount)}</dd></div>
        </dl>
        <div className="ao-agent-ledger">
          {data?.agents.map((agent) => (
            <article key={agent.id} className={`is-${agent.id}${agent.usage ? " has-usage" : ""}${trendSource === agent.id ? " is-selected" : ""}`}>
              <button type="button" className="ao-agent-card" aria-pressed={trendSource === agent.id} onClick={() => toggleTrendSource(agent.id)}>
                <div><span>{agent.name}</span><small>{agent.note}</small></div>
                <strong>{agent.usage ? compact(agent.usage.totalTokens) : agent.id === "external" && data.externalAccount?.usageUsd != null ? `$${data.externalAccount.usageUsd.toFixed(6)}` : "未提供"}</strong>
                <em>{trendSource === agent.id ? "正在查看 · 再点返回汇总" : agent.id === "cursor" ? `${agent.eventCount || 0} 次事件 · ${agent.runCount || 0} 次调度` : agent.usage ? `${agent.taskCount} 条记录` : agent.id === "external" && data.externalAccount?.usageUsd != null ? "当前密钥累计" : `${agent.taskCount} 个批次`}</em>
              </button>
            </article>
          ))}
          {data && trendSource === "external" ? <ExternalUsageSummary items={data.externalDetails || []} account={data.externalAccount} period={period.label} /> : null}
        </div>
      </section>

      {data ? <TrendFigure data={selectedTrend} source={trendSource} /> : null}

      {data ? <RecentTaskUsage snapshot={data} updatedAt={data.updatedAt} /> : null}

      <section className="ao-section ao-daily-ledger" aria-labelledby="ao-daily-title">
        <header>
          <div><span>生活与值班</span><h3 id="ao-daily-title">日常使用</h3></div>
          <p>生活事务和自动值班放在这里看。值班用量已包含在所属项目中，不另加一次。</p>
        </header>
        <div className="ao-daily-grid">
          {personalLifeGroup ? <PersonalLifeCard group={personalLifeGroup} tasks={recentLifeTasks} expanded={!collapsedProjects.has(personalLifeGroup.projectId)} onToggle={() => toggleProject(personalLifeGroup.projectId)} /> : null}
          {data?.scheduledRuns ? <ScheduledTaskCard ledger={data.scheduledRuns} expanded={!collapsedProjects.has("scheduled-automation")} onToggle={() => toggleProject("scheduled-automation")} /> : null}
        </div>
      </section>

      {data ? <AnomalyPulse items={data.anomalies || []} /> : null}

      <section className="ao-section ao-task-report">
        <header>
          <div><span>任务战报</span><h3>每个任务窗口，连同它带出来的子任务</h3></div>
          <p>按真实窗口计；智能体列区分 Codex／Cursor。Codex 条分自身与子任务，Cursor 无子任务时条分新输入与缓存。</p>
        </header>
        <div className="ao-table-wrap">
          <table>
            <thead><tr><th>任务窗口 / 批次</th><th>智能体 / 证据</th><th>用量构成</th><th>任务链</th><th>缓存</th><th>项目 / 功能</th></tr></thead>
            <tbody>
              {data?.tasks.slice(0, visibleTaskCount).map((task) => (
                <tr key={task.id}>
                  <td>
                    <strong title={task.title}>{task.title}</strong>
                    <span>{taskKindLabel(task)}{task.sourceQuality === "account-history" ? "" : ` ${task.reference}`} · {task.model}{task.reasoningEffort ? ` · ${task.reasoningEffort}` : ""} · {shortDate(task.updatedAt)}</span>
                  </td>
                  <td><b>{task.agent}</b><span>{qualityLabel(task)}{task.kind === "cursor" && task.sourceQuality !== "account-history" ? ` · ${duration(task.durationMs)}` : task.sourceQuality === "account-history" && task.accountKind ? ` · ${friendlyAccountKind(task.accountKind)}` : ""}</span></td>
                  <td><TaskGauge task={task} /><span>{gaugeCaption(task)}</span></td>
                  <td className="ao-number"><strong>{task.totalUsage ? compact(task.totalUsage.totalTokens) : "未提供"}</strong>{task.hasChildren && task.childCount ? <span>{task.childCount} 个子任务</span> : null}</td>
                  <td className="ao-number"><strong>{task.totalUsage ? percent(cacheRatio(task.totalUsage)) : "未提供"}</strong></td>
                  <td><ProjectAttribution task={task} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && visibleTaskCount < data.tasks.length ? (
          <button type="button" className="ao-more-tasks" onClick={() => setVisibleTaskCount((count) => count + 20)}>
            再看 {Math.min(20, data.tasks.length - visibleTaskCount)} 条任务
          </button>
        ) : null}
      </section>

      <section className="ao-section ao-feature-ledger" aria-labelledby="ao-development-title">
        <header>
          <div><span>项目累计</span><h3 id="ao-development-title">项目开发</h3></div>
          <p>项目级账项与功能细项分开，进度条只比较功能细项；看不准归属的仍保留在“其他”。</p>
        </header>
        <div className="ao-project-ledger">
          {featureGroups.filter((group) => group.projectId !== "personal-life-operations").map((group) => <FeatureProjectCard key={group.projectId} group={group} expanded={!collapsedProjects.has(group.projectId)} onToggle={() => toggleProject(group.projectId)} />)}
        </div>
      </section>

      <footer className="ao-method">
        <button type="button" onClick={() => setNotesOpen((value) => !value)} aria-expanded={notesOpen}>
          <CircleDollarSign size={15} />口径与账单边界<ChevronDown size={14} className={notesOpen ? "is-open" : ""} />
        </button>
        {notesOpen ? <ul>{data?.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
      </footer>
    </div>
  );
}
