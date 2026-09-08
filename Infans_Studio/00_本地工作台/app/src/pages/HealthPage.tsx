import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { ChevronRight } from "lucide-react";
import { PageTrail } from "../shell/PageNavigation";
import type { HealthSectionData, HealthStatusReport, WriteAction } from "../types";
import { Kicker, tokyoDateKey } from "../page-shared";
import BodyPanel, { AppleHealthImportCard, planMovesLine, type BodyDerived } from "./BodyPanel";
import MindPanel, { mindBandSummary } from "./MindPanel";
import LifePanel, { lifeBandSummary } from "./LifePanel";
import MuscleMapPanel from "./MuscleMapPanel";
import CoachReview from "./CoachReview";

type CellId = "body" | "mind" | "life";
type ReportId = "daily" | "weekly" | "monthly";

type HealthHistoryState = { healthBand?: CellId | null; healthReport?: ReportId | null };

function readBandQuery(): CellId | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("band");
  return value === "body" || value === "mind" || value === "life" ? value : null;
}

function readReportQuery(): ReportId | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("report");
  return value === "daily" || value === "weekly" || value === "monthly" ? value : null;
}

function healthViewUrl({ band = null, report = null, hash = "" }: { band?: CellId | null; report?: ReportId | null; hash?: string }) {
  const url = new URL(window.location.href);
  url.searchParams.delete("band");
  url.searchParams.delete("report");
  if (band) url.searchParams.set("band", band);
  if (report) url.searchParams.set("report", report);
  url.hash = hash;
  return `${url.pathname}${url.search}${url.hash}`;
}

function writeHealthView(
  view: { band?: CellId | null; report?: ReportId | null; hash?: string },
  mode: "push" | "replace",
) {
  if (typeof window === "undefined") return;
  const next = healthViewUrl(view);
  const state: HealthHistoryState = { healthBand: view.band ?? null, healthReport: view.report ?? null };
  if (mode === "push") window.history.pushState(state, "", next);
  else window.history.replaceState(state, "", next);
}

function higherOverlayOpen() {
  if (typeof document === "undefined") return false;
  if (document.querySelector(".modal-backdrop")) return true;
  if (document.querySelector(".app-shell.ai-open")) return true;
  return false;
}

const CELL_META: Record<CellId, { title: string }> = {
  body: { title: "体魄" },
  mind: { title: "心理" },
  life: { title: "平衡" },
};

const REPORT_META = [
  { key: "daily" as const, label: "每日状态", hint: "看昨天发生了什么" },
  { key: "weekly" as const, label: "每周报告", hint: "看近七天有什么变化" },
  { key: "monthly" as const, label: "每月报告", hint: "看长期趋势与校准" },
];

function reportPeriod(report: HealthStatusReport | null) {
  if (!report) return "等待首份报告";
  if (report.periodStart === report.periodEnd) return report.periodEnd;
  return `${report.periodStart.slice(5)} — ${report.periodEnd.slice(5)}`;
}

function hasUsefulReportText(value: string | null | undefined) {
  if (!value) return false;
  return !/^(?:无|暂无|未知|不设|—)[。.]?$/.test(value.trim());
}

function CompactReportFacts({ report, limit = 2 }: { report: HealthStatusReport; limit?: number }) {
  return (
    <div className="health-report-compact-facts">
      {report.achievements.length ? (
        <p><b>做成</b><span>{report.achievements.slice(0, limit).map((item) => item.text).join("；")}</span></p>
      ) : null}
      {report.interruptions?.judgment ? <p><b>节奏</b><span>{report.interruptions.judgment}</span></p> : null}
      {report.recovery.length ? (
        <p><b>恢复</b><span>{report.recovery.slice(0, limit).map((item) => `${item.dimension}：${item.judgment}`).join("；")}</span></p>
      ) : null}
      {report.goodTimes.length ? (
        <p><b>回能</b><span>{report.goodTimes.slice(0, limit).map((item) => `${item.text}（${item.effect}）`).join("；")}</span></p>
      ) : null}
    </div>
  );
}

function ReportDetail({ report }: { report: HealthStatusReport }) {
  return (
    <div className="health-report-detail">
      {report.workload ? (
        <section><Kicker>负荷</Kicker><p>{report.workload.note || report.workload.comparison28d || `${report.workload.score ?? "—"}/10`}</p></section>
      ) : null}
      {report.achievements.length ? (
        <section><Kicker>做成了什么</Kicker><ul>{report.achievements.slice(0, 4).map((item, index) => <li key={`${item.text}-${index}`}>{item.text}</li>)}</ul></section>
      ) : null}
      {report.interruptions ? <section><Kicker>打断与节奏</Kicker><p>{report.interruptions.judgment}</p></section> : null}
      {report.recovery.length ? (
        <section><Kicker>恢复</Kicker><ul>{report.recovery.map((item) => <li key={item.dimension}><strong>{item.dimension}</strong><span>{item.judgment}</span></li>)}</ul></section>
      ) : null}
      {report.allocation.length ? (
        <section><Kicker>时间与精力</Kicker><ul>{report.allocation.map((item) => <li key={item.area}><strong>{item.area}</strong><span>{item.change || (item.value == null ? "未知" : `${item.value}`)}</span></li>)}</ul></section>
      ) : null}
      {report.goodTimes.length ? (
        <section><Kicker>好时光</Kicker><ul>{report.goodTimes.map((item, index) => <li key={`${item.text}-${index}`}><strong>{item.effect}</strong><span>{item.text}</span></li>)}</ul></section>
      ) : null}
      {report.subjective ? <section><Kicker>你的感受</Kicker><p>{report.subjective.summary}</p></section> : null}
      {report.notableChange ? <section><Kicker>值得注意</Kicker><p>{report.notableChange}</p></section> : null}
      {report.oneExperiment ? <section className="is-experiment"><Kicker>接下来只试一件事</Kicker><p>{report.oneExperiment}</p></section> : null}
      {report.unknowns.length ? <section className="is-unknown"><Kicker>还不知道</Kicker><p>{report.unknowns.join("；")}</p></section> : null}
      {report.sources.length ? <p className="health-report-sources">依据：{report.sources.join(" · ")}</p> : null}
    </div>
  );
}

function ReportPreview({
  reportId,
  report,
  onOpen,
}: {
  reportId: ReportId;
  report: HealthStatusReport | null;
  onOpen: (id: ReportId) => void;
}) {
  const meta = REPORT_META.find((item) => item.key === reportId)!;
  return (
    <button type="button" className={`health-report-card is-period${report ? " has-report" : ""}`} onClick={() => onOpen(reportId)}>
      <span className="health-report-card-top"><Kicker>{meta.label}</Kicker><time>{reportPeriod(report)}</time></span>
      <strong>{report?.title || meta.hint}</strong>
      <p>{report?.summary || "首份报告生成后会出现在这里。"}</p>
      <div className="health-report-preview-details">
        {report ? <CompactReportFacts report={report} /> : null}
        {report?.notableChange ? <small className="health-report-highlight">{report.notableChange}</small> : null}
        {report?.subjective?.summary && report.subjective.summary !== "未知" ? (
          <small className="health-report-subjective"><b>体感</b>{report.subjective.summary}</small>
        ) : null}
        {hasUsefulReportText(report?.oneExperiment) ? <small className="health-report-experiment"><b>接下来</b>{report!.oneExperiment}</small> : null}
      </div>
      <span className="health-report-card-foot">
        <em>{report ? (report.status === "partial" ? "部分来源" : report.confidence || "已生成") : "等待生成"}</em>
        <span>查看详情 <ChevronRight size={13} aria-hidden="true" /></span>
      </span>
    </button>
  );
}

function DailyReportCard({ report }: { report: HealthStatusReport | null }) {
  const meta = REPORT_META[0];
  return (
    <article className={`health-report-card is-daily${report ? " has-report" : ""}`}>
      <span className="health-report-card-top"><Kicker>{meta.label}</Kicker><time>{reportPeriod(report)}</time></span>
      <strong>{report?.title || meta.hint}</strong>
      <p>{report?.summary || "首份报告生成后会出现在这里。"}</p>
      <div className="health-report-preview-details is-daily-details">
        {report ? <CompactReportFacts report={report} limit={3} /> : null}
        {report?.subjective?.summary && report.subjective.summary !== "未知" ? (
          <small className="health-report-subjective"><b>感受</b>{report.subjective.summary}</small>
        ) : null}
        {report?.notableChange ? <small className="health-report-highlight">{report.notableChange}</small> : null}
        {hasUsefulReportText(report?.oneExperiment) ? <small className="health-report-experiment"><b>接下来</b>{report!.oneExperiment}</small> : null}
      </div>
    </article>
  );
}

function CellHead({ title, summary }: { title: string; summary: ReactNode }) {
  return (
    <header className="health-cell-head">
      <div className="health-cell-title">
        <strong>{title}</strong>
      </div>
      <div className="health-cell-summary">{summary}</div>
    </header>
  );
}

function DeckCard({
  id,
  title,
  summary,
  onOpen,
  openButtonRef,
  children,
}: {
  id: CellId;
  title: string;
  summary: ReactNode;
  onOpen: (id: CellId) => void;
  openButtonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <section className={`health-deck-card health-cell-${id}`} id={`health-cell-${id}`}>
      <header className="health-deck-card-head">
        <button type="button" className="health-deck-card-open-zone" onClick={() => onOpen(id)} aria-label={`打开${title}`}>
          <strong>{title}</strong>
          <p>{summary}</p>
        </button>
        <button
          type="button"
          className="health-deck-open"
          ref={openButtonRef}
          onClick={() => onOpen(id)}
          aria-label={`打开${title}详情`}
        >
          打开
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="health-deck-card-body">{children}</div>
    </section>
  );
}

function useHealthDerived(data: HealthSectionData, today: string): BodyDerived {
  return useMemo(() => {
    type BodyPoint = { date: string; weightKg?: number; waist?: number; bodyFatPercent?: number; chest?: number; arm?: number };
    const apple = data.appleHealth;
    const completeDaily = (apple?.daily ?? []).filter((item) => item.date < today && item.steps !== undefined);
    const latestComplete = completeDaily.at(-1) ?? null;
    const recent7 = completeDaily.slice(-7);
    const recent14 = completeDaily.slice(-14).map((item) => ({ ...item, short: item.date.slice(5) }));
    const average = (values: Array<number | undefined>) => {
      const valid = values.filter((value): value is number => Number.isFinite(value));
      return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
    };
    const sum = (values: Array<number | undefined>) => values.reduce<number>((total, value) => total + (Number.isFinite(value) ? Number(value) : 0), 0);
    const averageSteps = average(recent7.map((item) => item.steps));
    const averageEnergy = average(recent7.map((item) => item.activeEnergy));
    const averageHeart = average(recent7.map((item) => item.restingHeartRate));
    const exerciseTotal = sum(recent7.map((item) => item.exerciseMinutes));

    const merged = new Map<string, BodyPoint>(data.measurements.map((item) => [item.date, { ...item }]));
    for (const item of apple?.body ?? []) {
      const row = merged.get(item.day) ?? { date: item.day };
      if (item.metric === "weightKg" && row.weightKg === undefined) row.weightKg = item.value;
      if (item.metric === "waistCm" && row.waist === undefined) row.waist = item.value;
      if (item.metric === "bodyFatPercent" && row.bodyFatPercent === undefined) row.bodyFatPercent = item.value;
      merged.set(item.day, row);
    }
    const referenceDay = latestComplete?.date ? new Date(`${latestComplete.date}T00:00:00+09:00`) : new Date();
    const cutoff = new Date(referenceDay); cutoff.setDate(cutoff.getDate() - 29);
    const cutoffDay = tokyoDateKey(cutoff);
    const allBodyPoints = [...merged.values()].filter((item) => item.weightKg || item.bodyFatPercent || item.waist).sort((a, b) => a.date.localeCompare(b.date));
    const monthPoints = allBodyPoints.filter((item) => item.date >= cutoffDay);
    const smoothKey = (points: typeof monthPoints, key: "weightKg" | "bodyFatPercent", window = 3) => {
      const values = points.map((item) => item[key]);
      return values.map((value, index) => {
        if (value === undefined) return undefined;
        const nearby: number[] = [];
        for (let cursor = index; cursor >= 0 && nearby.length < window; cursor -= 1) {
          const candidate = values[cursor];
          if (candidate !== undefined) nearby.push(candidate);
        }
        return nearby.length ? Number((nearby.reduce((acc, item) => acc + item, 0) / nearby.length).toFixed(2)) : value;
      });
    };
    const smoothedWeight = smoothKey(monthPoints, "weightKg");
    const smoothedBodyFat = smoothKey(monthPoints, "bodyFatPercent");
    const chart = monthPoints.map((item, index) => ({
      ...item,
      weightKg: smoothedWeight[index],
      bodyFatPercent: smoothedBodyFat[index],
      short: item.date.slice(5),
    }));
    const weightValues = chart.map((item) => item.weightKg).filter((value): value is number => Number.isFinite(value));
    const bodyFatValues = chart.map((item) => item.bodyFatPercent).filter((value): value is number => Number.isFinite(value));
    const weightDomain: [number, number] = weightValues.length
      ? [Math.floor(Math.min(...weightValues) - 1), Math.ceil(Math.max(...weightValues) + 1)]
      : [70, 82];
    const bodyFatDomain: [number, number] = bodyFatValues.length
      ? [Math.floor(Math.min(...bodyFatValues) - 1), Math.ceil(Math.max(...bodyFatValues) + 1)]
      : [15, 25];
    const latestManualWeight = [...data.measurements].reverse().find((item) => item.weightKg !== undefined);
    const latestManualWaist = [...data.measurements].reverse().find((item) => item.waist !== undefined);
    const appleWeight = apple?.latestBody.weightKg;
    const useAppleWeight = Boolean(appleWeight && (!latestManualWeight || appleWeight.day > latestManualWeight.date));
    const currentWeight = useAppleWeight ? appleWeight!.value : latestManualWeight?.weightKg;
    const weightDate = useAppleWeight ? appleWeight!.day : latestManualWeight?.date ?? data.baselineDate;
    const monthWeights = allBodyPoints.filter((item) => item.date >= cutoffDay && item.weightKg !== undefined);
    const weightDelta = monthWeights.length >= 2 ? Number(monthWeights.at(-1)!.weightKg!) - Number(monthWeights[0].weightKg!) : null;
    const latestWaist = latestManualWaist ?? [...allBodyPoints].reverse().find((item) => item.waist !== undefined);
    const workouts30 = (apple?.workouts ?? []).filter((item) => item.day >= cutoffDay);
    const strengthSessions = workouts30.filter((item) => item.type.includes("力量")).length;
    const walkingMinutes = sum(workouts30.filter((item) => item.type === "步行").map((item) => item.durationMinutes ?? undefined));
    const workoutTypes = [...new Set(workouts30.map((item) => item.type))];
    return {
      apple, latestComplete, recent14, averageSteps, averageEnergy, averageHeart, exerciseTotal,
      chart, weightDomain, bodyFatDomain, currentWeight, weightDate, weightDelta, latestWaist,
      strengthSessions, walkingMinutes, workoutTypes, workouts30,
    };
  }, [data, today]);
}

export default function HealthPage({
  data,
  onImport,
  onImportFromDownloads,
  importing,
  onAskCoach,
  onWritePreview,
}: {
  data: HealthSectionData;
  onImport: (file: File) => void;
  onImportFromDownloads: () => void;
  importing: boolean;
  onAskCoach: (seedUser: string) => void;
  onWritePreview?: (action: WriteAction) => void;
}) {
  const today = tokyoDateKey(new Date());
  const derived = useHealthDerived(data, today);
  const [open, setOpen] = useState<CellId | null>(() => readBandQuery());
  const [openReport, setOpenReport] = useState<ReportId | null>(() => readReportQuery());
  const openButtonRefs = useRef<Partial<Record<CellId, HTMLButtonElement | null>>>({});
  const lastOpenedRef = useRef<CellId | null>(readBandQuery());
  const skipFocusOnceRef = useRef(Boolean(readBandQuery()));

  const appleSleep = (() => {
    const daily = data.appleHealth?.daily ?? [];
    for (let i = daily.length - 1; i >= 0; i -= 1) {
      const row = daily[i] as { sleepMinutes?: number; asleepMinutes?: number };
      const value = row.sleepMinutes ?? row.asleepMinutes;
      if (Number.isFinite(value)) return Number(value);
    }
    return null;
  })();

  const bodyPeek = data.todayPlan?.title
    ? `${derived.currentWeight?.toFixed(1) ?? "—"} kg · ${data.todayPlan.weekday} · ${data.todayPlan.title}`
    : `${derived.currentWeight?.toFixed(1) ?? "—"} kg · ${data.latestTraining || "暂无训练"}`;
  const todayMoves = planMovesLine(data.todayPlan);

  const openCell = (id: CellId) => {
    if (open === id) return;
    writeHealthView({ band: id }, "push");
    lastOpenedRef.current = id;
    setOpenReport(null);
    setOpen(id);
  };

  const openReportView = (id: ReportId) => {
    writeHealthView({ report: id }, "push");
    setOpen(null);
    setOpenReport(id);
  };

  const openCoachReview = () => {
    writeHealthView({ band: "body", hash: "health-coach-review-detail" }, "push");
    lastOpenedRef.current = "body";
    setOpenReport(null);
    setOpen("body");
  };

  const closeView = () => {
    const state = window.history.state as HealthHistoryState | null;
    if (state?.healthBand || state?.healthReport) {
      window.history.back();
      return;
    }
    writeHealthView({}, "replace");
    setOpen(null);
    setOpenReport(null);
  };

  useEffect(() => {
    const onPop = () => {
      setOpen(readBandQuery());
      setOpenReport(readReportQuery());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!open && !openReport) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (higherOverlayOpen()) return;
      event.preventDefault();
      closeView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openReport]);

  useEffect(() => {
    if (skipFocusOnceRef.current) {
      skipFocusOnceRef.current = false;
      if (open) queueMicrotask(() => [...document.querySelectorAll<HTMLAnchorElement>(".page-navigation a")].find((link) => link.getClientRects().length)?.focus());
      return;
    }
    if (open) {
      lastOpenedRef.current = open;
      queueMicrotask(() => [...document.querySelectorAll<HTMLAnchorElement>(".page-navigation a")].find((link) => link.getClientRects().length)?.focus());
      return;
    }
    const id = lastOpenedRef.current;
    if (id) queueMicrotask(() => openButtonRefs.current[id]?.focus());
  }, [open]);

  useEffect(() => {
    if (open !== "body" || window.location.hash !== "#health-coach-review-detail") return;
    requestAnimationFrame(() => document.getElementById("health-coach-review-detail")?.scrollIntoView({ block: "start" }));
  }, [open]);

  if (openReport) {
    const meta = REPORT_META.find((item) => item.key === openReport)!;
    const report = data.reports?.[openReport] ?? null;
    return (
      <div className="health-dashboard-v2 health-expanded health-report-page">
        <PageTrail items={[{ label: meta.label }]} />
        <section className="health-cell">
          <div className="health-expanded-bar">
            <CellHead title={meta.label} summary={reportPeriod(report)} />
          </div>
          {report ? <ReportDetail report={report} /> : <p className="health-report-empty">首份新格式报告生成后会出现在这里。</p>}
        </section>
      </div>
    );
  }

  if (open) {
    const meta = CELL_META[open];
    const summary =
      open === "body" ? bodyPeek : open === "mind" ? mindBandSummary(data.mind) : lifeBandSummary(data.life);
    return (
      <div className="health-dashboard-v2 health-expanded">
        <PageTrail items={[{ label: meta.title }]} />
        <section className={`health-cell health-cell-${open}`} id={`health-cell-${open}`}>
          <div className="health-expanded-bar">
            <CellHead title={meta.title} summary={summary} />
            {open === "body" ? (
              <AppleHealthImportCard
                apple={derived.apple}
                compact
              />
            ) : null}
          </div>

          {open === "body" ? (
            <BodyPanel
              data={data}
              today={today}
              derived={derived}
              onAskCoach={onAskCoach}
              onWritePreview={onWritePreview}
              sleepMinutes={appleSleep}
            />
          ) : null}

          {open === "mind" ? (
            <MindPanel
              mind={data.mind}
            />
          ) : null}

          {open === "life" ? <LifePanel life={data.life} /> : null}
        </section>
      </div>
    );
  }

  return (
    <div className="health-dashboard-v2 health-deck">
      <div className="health-deck-grid">
        <DeckCard
          id="body"
          title={CELL_META.body.title}
          summary={bodyPeek}
          onOpen={openCell}
          openButtonRef={(node) => { openButtonRefs.current.body = node; }}
        >
          <div className="health-body-panel is-card">
            <p className="today-plan-banner is-card" title={data.todayPlan?.detail || undefined}>
              <Kicker>今日</Kicker>
              <span className="today-plan-main">
                <strong>{data.todayPlan?.title || "今天没排训练"}</strong>
                {todayMoves ? <span className="today-plan-moves">{todayMoves}</span> : null}
              </span>
            </p>
            <MuscleMapPanel sessions={data.sessions} strength={data.strength} today={today} compact />
            <CoachReview
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
              sleepMinutes={appleSleep}
              compact
              onOpenDetails={openCoachReview}
            />
          </div>
        </DeckCard>

        <DeckCard
          id="mind"
          title={CELL_META.mind.title}
          summary={mindBandSummary(data.mind)}
          onOpen={openCell}
          openButtonRef={(node) => { openButtonRefs.current.mind = node; }}
        >
          <MindPanel
            mind={data.mind}
            variant="card"
          />
          <div className="health-card-report-slot is-daily">
            <DailyReportCard report={data.reports?.daily ?? null} />
          </div>
        </DeckCard>

        <DeckCard
          id="life"
          title={CELL_META.life.title}
          summary={lifeBandSummary(data.life)}
          onOpen={openCell}
          openButtonRef={(node) => { openButtonRefs.current.life = node; }}
        >
          <LifePanel life={data.life} variant="card" />
          <div className="health-card-report-slot health-period-reports">
            <ReportPreview reportId="weekly" report={data.reports?.weekly ?? null} onOpen={openReportView} />
            <ReportPreview reportId="monthly" report={data.reports?.monthly ?? null} onOpen={openReportView} />
          </div>
        </DeckCard>
      </div>
    </div>
  );
}
