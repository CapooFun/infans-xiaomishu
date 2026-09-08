import { lazy, Suspense, useMemo, useState } from "react";
import { Database, ShieldCheck } from "lucide-react";
import type { HealthSectionData, WriteAction } from "../types";
import { Card, Kicker, fmtDateTime } from "../page-shared";
import MuscleMapPanel, { ExercisePreviewCard } from "./MuscleMapPanel";
import CoachReview from "./CoachReview";
import type { ExerciseRecommendation } from "../muscle-map";

const HealthTrendCharts = lazy(() => import("./HealthTrendCharts"));

/** 从周表文案里抽出括号里的短说明，如「胸主导·上斜 + 背」。 */
export function planBlurb(plan?: { title?: string; detail?: string } | null) {
  if (!plan) return "";
  const raw = `${plan.detail || ""} ${plan.title || ""}`;
  const paren = raw.match(/（([^）]+)）/)?.[1]?.trim();
  if (paren) return paren;
  if (plan.detail && plan.title && plan.detail !== plan.title && !plan.detail.startsWith(plan.title)) {
    return plan.detail.replace(/^照周表：/, "").trim();
  }
  return "";
}

/** 今日横幅右侧文案：优先动作清单，没有再退回括号短说明。 */
export function planMovesLine(plan?: { title?: string; detail?: string; exercises?: string[] } | null) {
  if (!plan) return "";
  const moves = (plan.exercises || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (moves.length) return moves.join(" · ");
  return planBlurb(plan);
}

function HealthMetric({ label, value, unit, note, tone = "teal" }: { label: string; value: string; unit?: string; note: string; tone?: "teal" | "gold" }) {
  return <div className={`health-metric ${tone}`}><span>{label}</span><div><strong>{value}</strong>{unit ? <em>{unit}</em> : null}</div><small>{note}</small></div>;
}

const MILESTONE_CATEGORY_ORDER = ["推举", "拉力", "下肢", "核心", "其他", "激活与其他"] as const;

function StrengthMilestones({ rows }: { rows: HealthSectionData["strengthBaseline"] }) {
  const groups = useMemo(() => {
    const map = new Map<string, HealthSectionData["strengthBaseline"]>();
    for (const row of rows) {
      const category = row.category || "其他";
      const list = map.get(category) || [];
      list.push(row);
      map.set(category, list);
    }
    const ordered: Array<{ category: string; rows: HealthSectionData["strengthBaseline"] }> = [];
    for (const category of MILESTONE_CATEGORY_ORDER) {
      const list = map.get(category);
      if (list?.length) ordered.push({ category, rows: list });
      map.delete(category);
    }
    for (const [category, list] of map) {
      if (list.length) ordered.push({ category, rows: list });
    }
    return ordered;
  }, [rows]);

  const mainGroups = groups.filter((group) => group.category !== "激活与其他");
  const otherGroup = groups.find((group) => group.category === "激活与其他");

  return (
    <Card className="strength-milestones">
      <div className="card-title">
        <div>
          <Kicker>力量里程碑</Kicker>
          <h2>各动作个人最佳</h2>
        </div>
        <span>{mainGroups.reduce((sum, group) => sum + group.rows.length, 0)} 项</span>
      </div>
      <p className="strength-baseline-note">按动作大类列出历史最佳成绩，数据自动汇总自训练日志。</p>
      <div className="strength-milestone-groups">
        {mainGroups.map((group) => (
          <section className="strength-milestone-group" key={group.category} aria-label={group.category}>
            <header>
              <strong>{group.category}</strong>
              <span>{group.rows.length}</span>
            </header>
            <ul>
              {group.rows.map((row) => (
                <li key={row.name} title={row.basis}>
                  <span className="strength-milestone-name">{row.name}</span>
                  <strong className="strength-milestone-pr">{row.topSet}</strong>
                  <time dateTime={row.date}>{row.date}</time>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {otherGroup?.rows.length ? (
        <details className="strength-milestone-misc">
          <summary>激活与其他 {otherGroup.rows.length} 项（热身 / 纠正等）</summary>
          <ul>
            {otherGroup.rows.map((row) => (
              <li key={row.name} title={row.basis}>
                <span>{row.name}</span>
                <strong>{row.topSet}</strong>
                <time>{row.date}</time>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}

/** 体魄顶栏：iPhone 自动同步状态；手工导入只作故障恢复。 */
export function AppleHealthImportCard({
  apple,
  compact = false,
}: {
  apple: HealthSectionData["appleHealth"];
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="apple-health-inline" title={apple ? `${apple.recordCount.toLocaleString()} 条 · ${apple.daily.length} 天` : "尚无健康数据"}>
        <div className="apple-health-inline-copy">
          <Kicker>iPhone 自动同步</Kicker>
          <strong>{apple?.sync?.source === "iphone-healthkit" ? "已连上" : apple ? "已有旧数据" : "等待首次同步"}</strong>
          {apple ? <span>上次 {fmtDateTime(apple.sync?.lastSyncedAt || apple.importedAt)}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <Card className="apple-health-card compact-import">
      <div className="card-title">
        <div>
          <Kicker>苹果健康</Kicker>
          <h2>{apple?.sync?.source === "iphone-healthkit" ? "iPhone 自动同步已连上" : apple ? "已有 Apple Health 数据" : "等待 iPhone 首次同步"}</h2>
        </div>
        <Database size={18} />
      </div>
      {apple ? (
        <p>{apple.recordCount.toLocaleString()} 条 · {apple.daily.length} 天 · {apple.workouts.length} 次运动 · 上次同步 {fmtDateTime(apple.sync?.lastSyncedAt || apple.importedAt)}</p>
      ) : (
        <p>日常由私人 iPhone App 自动送达，不需要手动导出。</p>
      )}
      <p className="evidence-note"><ShieldCheck size={13} />每天 12:00 后由 iPhone 择机同步；日常无需操作，恢复工具以后只在运维模式开放。</p>
    </Card>
  );
}

function WeekPlanCalendar({
  days,
  apple,
  today: todayKey,
}: {
  days: HealthSectionData["weekPlan"];
  apple: HealthSectionData["appleHealth"];
  today: string;
}) {
  const today = days.find((day) => day.isToday) ?? days[0] ?? null;
  const [selectedLabel, setSelectedLabel] = useState(today?.label ?? "");
  const selected = days.find((day) => day.label === selectedLabel) ?? today;
  const recordedStretch = new Map((apple?.stretch?.days ?? []).map((item) => [item.date, item]));
  const anchor = new Date(`${todayKey}T12:00:00+09:00`);
  const weekday = anchor.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const stretchWeek = days.map((_, index) => {
    const date = new Date(anchor);
    date.setUTCDate(date.getUTCDate() + mondayOffset + index);
    const key = date.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    return { key, item: recordedStretch.get(key), future: key > todayKey };
  });
  if (!days?.length) return null;
  return (
    <div className="week-plan-cal" aria-label="本周训练安排">
      <div className="week-plan-cal-head">
        <Kicker>本周安排</Kicker>
        <span>点某一天看安排</span>
      </div>
      <div className="week-plan-cal-grid">
        {days.map((day, index) => {
          const stretch = stretchWeek[index];
          const stretchStatus = stretch?.item?.status ?? "unknown";
          const stretchDetail = stretch?.item ? `${stretch.item.durationMinutes} 分钟` : "无记录（未知）";
          return (
            <div className="week-plan-cal-stack" key={day.label}>
              <button
                type="button"
                className={`week-plan-cal-day is-${day.kind}${day.isToday ? " is-today" : ""}${selected?.label === day.label ? " is-selected" : ""}`}
                aria-pressed={selected?.label === day.label}
                onClick={() => setSelectedLabel(day.label)}
              >
                <span>{day.weekday.replace("周", "")}</span>
                <strong>{day.short}</strong>
              </button>
              <div
                className={`week-plan-stretch is-${stretchStatus}${stretch?.future ? " is-future" : ""}`}
                title={stretchDetail}
                aria-label={`${day.weekday}拉伸：${stretchDetail}`}
              >
                拉伸
              </div>
            </div>
          );
        })}
      </div>
      {selected ? (
        <p className="week-plan-cal-detail">
          <strong>{selected.weekday}</strong>
          <span>
            {selected.exercises?.length
              ? `${selected.title}：${selected.exercises.join(" · ")}`
              : selected.detail || selected.title}
          </span>
        </p>
      ) : null}
    </div>
  );
}

function TodayPlanBanner({ plan }: { plan: HealthSectionData["todayPlan"] }) {
  if (!plan) return null;
  const moves = planMovesLine(plan);
  return (
    <div className="today-plan-banner" title={plan.detail || undefined}>
      <Kicker>今日</Kicker>
      <span className="today-plan-main">
        <strong>{plan.title || "今天没排训练"}</strong>
        {moves ? <span className="today-plan-moves">{moves}</span> : null}
      </span>
    </div>
  );
}

export type BodyDerived = {
  apple: HealthSectionData["appleHealth"];
  latestComplete: { date: string } | null;
  recent14: Array<{ date: string; short: string; steps?: number }>;
  averageSteps: number | null;
  averageEnergy: number | null;
  averageHeart: number | null;
  exerciseTotal: number;
  chart: Array<{ short: string; weightKg?: number; bodyFatPercent?: number }>;
  weightDomain: [number, number];
  bodyFatDomain: [number, number];
  currentWeight?: number;
  weightDate: string;
  weightDelta: number | null;
  latestWaist?: { waist?: number; date: string };
  strengthSessions: number;
  walkingMinutes: number;
  workoutTypes: string[];
  workouts30: NonNullable<HealthSectionData["appleHealth"]>["workouts"];
};

/** 体魄完整页：左恢复图 · 右教练复盘（示范图画在复盘下）。 */
export default function BodyPanel({
  data,
  today,
  derived,
  onAskCoach,
  onWritePreview,
  sleepMinutes = null,
}: {
  data: HealthSectionData;
  today: string;
  derived: BodyDerived;
  onAskCoach: (seedUser: string) => void;
  onWritePreview?: (action: WriteAction) => void;
  sleepMinutes?: number | null;
}) {
  const [preview, setPreview] = useState<ExerciseRecommendation | null>(null);
  const {
    apple, latestComplete, averageSteps, averageEnergy, averageHeart, exerciseTotal,
    chart, weightDomain, bodyFatDomain, currentWeight, weightDate, weightDelta, latestWaist,
    strengthSessions,
  } = derived;

  return (
    <div className="health-body-panel">
      <WeekPlanCalendar days={data.weekPlan ?? []} apple={apple} today={today} />

      <div className="health-overview-v2 is-strip">
        <div className="weight-hero">
          <div><strong>{currentWeight?.toFixed(1) ?? "—"}</strong><span>kg</span></div>
          <p>{weightDate}{weightDelta === null ? "" : ` · 近 30 日 ${weightDelta > 0 ? "+" : ""}${weightDelta.toFixed(1)} kg`}</p>
        </div>
        <div className="health-metric-grid">
          <HealthMetric label="腰围" value={latestWaist?.waist?.toFixed(1) ?? "—"} unit="cm" note={latestWaist ? latestWaist.date : "还没测"} tone="gold" />
          <HealthMetric label="静息心率" value={averageHeart?.toFixed(0) ?? "—"} unit="bpm" note="7 日均值" />
          <HealthMetric label="日均步数" value={averageSteps ? Math.round(averageSteps).toLocaleString() : "—"} note="7 日" />
          <HealthMetric label="锻炼" value={exerciseTotal ? Math.round(exerciseTotal).toString() : "—"} unit="min" note="7 日合计" tone="gold" />
          <HealthMetric label="活动能量" value={averageEnergy?.toFixed(0) ?? "—"} unit="kcal" note="7 日均值" />
          <HealthMetric label="力量" value={strengthSessions.toString()} unit="次" note="近 30 日" tone="gold" />
        </div>
        <span className="trust-badge">{apple ? `更新至 ${latestComplete?.date ?? apple.importedAt.slice(0, 10)}` : "手工记的"}</span>
      </div>

      <div className="health-body-main">
        <div className="health-body-map-col">
          <TodayPlanBanner plan={data.todayPlan} />
          <MuscleMapPanel
            sessions={data.sessions}
            strength={data.strength}
            today={today}
            externalPreview
            preview={preview}
            onPreviewChange={setPreview}
          />
        </div>
        <div className="health-body-side">
          {preview ? (
            <ExercisePreviewCard preview={preview} onClose={() => setPreview(null)} />
          ) : (
            <p className="health-body-side-hint">点「建议练这些」里的动作，示范会出现在这里。</p>
          )}
          <CoachReview
            id="health-coach-review-detail"
            data={{
              trainingVolume: data.trainingVolume,
              progressionAdvice: data.progressionAdvice,
              muscleBalance: data.muscleBalance,
              recoveryLoad: data.recoveryLoad,
              mesocycle: data.mesocycle,
              staleMuscles: data.staleMuscles,
              coachHints: data.coachHints,
              measurements: data.measurements,
            }}
            onAskCoach={onAskCoach}
            onWritePreview={onWritePreview}
            sleepMinutes={sleepMinutes}
          />
        </div>
      </div>

      {(data.strengthBaseline?.length ?? 0) > 0 ? (
        <StrengthMilestones rows={data.strengthBaseline} />
      ) : null}

      <Suspense fallback={<p className="chart-note">正在载入趋势…</p>}>
        <HealthTrendCharts chart={chart} weightDomain={weightDomain} bodyFatDomain={bodyFatDomain} />
      </Suspense>
    </div>
  );
}
