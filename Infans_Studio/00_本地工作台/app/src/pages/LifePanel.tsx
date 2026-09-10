import { useId } from "react";
import type { HealthSectionData, RecentWellbeingAssessment } from "../types";
import { Empty, Kicker } from "../page-shared";

type WeeklyGoodTime = NonNullable<HealthSectionData["life"]["weeklyGoodTimes"]>[number];

const GAUGE_LABELS = [
  { key: "health" as const, label: "健康" },
  { key: "work" as const, label: "工作" },
  { key: "play" as const, label: "游戏" },
  { key: "love" as const, label: "情感" },
];

type GaugeKey = (typeof GAUGE_LABELS)[number]["key"];

function buildGaugeRows(life: HealthSectionData["life"]) {
  const gauges = life?.gauges ?? [];
  const latest = gauges[0] ?? null;
  const weekly = life?.weeklyGauges ?? [];
  const current = weekly[0] ?? latest;
  const previous = weekly[1] ?? null;
  const shortWeek = (date: string) => date.slice(5).replace("-", "/");
  if (!current) {
    return {
      latest: null,
      values: [] as Array<{
        key: GaugeKey;
        label: string;
        value: number | null;
        previousValue: number | null;
        trend: "up" | "down" | "steady" | null;
        change: number | null;
        historyTitle: string;
      }>,
      lowestKey: null as GaugeKey | null,
    };
  }

  const values = GAUGE_LABELS.map((item) => {
    const value = current[item.key];
    const previousValue = previous?.[item.key] ?? null;
    const change = value != null && previousValue != null ? value - previousValue : null;
    const trend = change == null ? null : change === 0 ? "steady" : change > 0 ? "up" : "down";
    return {
      ...item,
      value,
      previousValue,
      trend,
      change,
      historyTitle: change == null
        ? `${item.label} ${value == null ? "—" : `${value}%`} · 暂无上周对照`
        : `${item.label} ${value}% · ${weekly[0] && previous ? `${shortWeek(weekly[0].weekEnding)} 较 ${shortWeek(previous.weekEnding)}` : "较前一周"}${trend === "steady" ? "基本持平" : `${change > 0 ? "增加" : "减少"} ${Math.abs(change)} 点`}`,
    };
  });
  const lowest = values.filter((item) => item.value != null).sort((a, b) => Number(a.value) - Number(b.value))[0];
  return { latest, values, lowestKey: lowest?.key ?? null };
}

function LifeGauges({
  values,
  lowestKey,
  animated = false,
}: {
  values: ReturnType<typeof buildGaugeRows>["values"];
  lowestKey: GaugeKey | null;
  animated?: boolean;
}) {
  return (
    <div className={`life-gauges${animated ? " is-animated" : ""}`} aria-label="健康、工作、游戏、情感四项投入">
      {values.map((item, index) => (
        <div
          className={`life-gauge${lowestKey === item.key ? " is-lowest" : ""}`}
          key={item.key}
          title={item.historyTitle}
          style={animated ? { animationDelay: `${index * 70}ms` } : undefined}
        >
          <span>{item.label}</span>
          <div className="life-gauge-track" aria-label={item.historyTitle}>
            <i style={{ height: `${Math.max(0, Math.min(100, Number(item.value) || 0))}%` }} />
          </div>
          <div className="life-gauge-reading">
            <strong>{item.value == null ? "—" : `${item.value}`}</strong>
            {item.change != null ? (
              <small className={`life-gauge-delta${item.trend ? ` is-${item.trend}` : ""}`}>
                {item.trend === "up" ? `↑${Math.abs(item.change)}` : item.trend === "down" ? `↓${Math.abs(item.change)}` : "—"}
              </small>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function TwoQuestions({ surprise, refuel, lead = false }: { surprise: string; refuel: string; lead?: boolean }) {
  if (!surprise && !refuel) return null;
  return (
    <div className={`life-two-questions${lead ? " is-lead life-atelier-lead is-split" : " health-deck-inset"}`}>
      {surprise ? <p><span className="life-q-label">最近发现</span><span className="life-q-body">{surprise}</span></p> : null}
      {refuel ? <p><span className="life-q-label">值得留意</span><span className="life-q-body">{refuel}</span></p> : null}
    </div>
  );
}

function recentRecoverySummary(balance: NonNullable<RecentWellbeingAssessment["entries"][number]["balance"]>) {
  if (balance.judgment === "时间结构强烈偏工作，恢复证据不足" && balance.unknown === "是否主动享受、进入心流或已经耗竭") {
    return "最近时间明显偏向工作，但现在还不能分清这是投入得开心，还是已经有些透支。";
  }
  return `${balance.judgment}${balance.unknown ? `。还不知道：${balance.unknown}` : ""}`;
}

function formatGoodTimeDates(dates: string[], evidence: string) {
  if (dates.length) return dates.join(" · ");
  return evidence || "还没日期";
}

/** 好时光：只显示当前已有的回能／耗能判断，不替本人制造结论。 */
function LineLeanDial({
  line,
  lean,
  dates,
  note,
  evidence,
}: {
  line: string;
  lean: "回能" | "耗能" | "中性" | null;
  dates: string[];
  note: string;
  evidence: string;
}) {
  const value = lean === "回能" ? 0.82 : lean === "耗能" ? 0.18 : 0.5;
  const uid = `lean${useId().replace(/:/g, "")}`;
  const r = 34;
  const cx = 44;
  const cy = 40;
  const d = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const tip = lean === "回能" ? "var(--teal)" : lean === "耗能" ? "var(--red)" : "var(--gold)";
  const fillStops = lean === "回能"
    ? [{ offset: "0%", color: "color-mix(in srgb, var(--teal) 75%, var(--surface-2))" }, { offset: "100%", color: "var(--teal)" }]
    : lean === "耗能"
      ? [{ offset: "0%", color: "var(--red)" }, { offset: "100%", color: "color-mix(in srgb, var(--red) 85%, var(--surface-2))" }]
      : [{ offset: "0%", color: "color-mix(in srgb, var(--gold) 70%, var(--surface-2))" }, { offset: "100%", color: "var(--gold)" }];
  return (
    <article className={`life-lean-tile is-${lean || "中性"}`}>
      <div className="life-lean-dial" aria-hidden="true">
        <svg viewBox="0 0 88 56" width="120" height="76">
          <defs><linearGradient id={`${uid}-g`} gradientUnits="userSpaceOnUse" x1={cx - r} y1={cy} x2={cx + r} y2={cy}>{fillStops.map((stop) => <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />)}</linearGradient></defs>
          <path d={d} fill="none" stroke="var(--progress-track)" strokeWidth="7" strokeLinecap="round" pathLength={100} />
          <path d={d} fill="none" stroke={`url(#${uid}-g)`} strokeWidth="7" strokeLinecap="round" pathLength={100} strokeDasharray={`${value * 100} 100`} />
        </svg>
        <div className="life-lean-scale"><span>耗</span><span>回</span></div>
        <strong style={{ color: tip }}>{lean || "—"}</strong>
      </div>
      <h3>{line}</h3>
      <span>{formatGoodTimeDates(dates, evidence)}</span>
      {note ? <p>{note}</p> : null}
    </article>
  );
}

function goodTimesSummary(rows: WeeklyGoodTime[]) {
  const recharge = rows.find((row) => row.lean === "回能");
  const drain = rows.find((row) => row.lean === "耗能");
  if (!recharge && !drain) return "";
  return [recharge ? `回能 · ${recharge.text}` : null, drain ? `耗能 · ${drain.text}` : null].filter(Boolean).join(" / ");
}

export default function LifePanel({
  life,
  variant = "full",
}: {
  life: HealthSectionData["life"];
  /** card = 三舱总览预览；full = 展开完整页。 */
  variant?: "card" | "full";
}) {
  const mode = variant;
  const { latest, values, lowestKey } = buildGaugeRows(life);
  const surprise = latest?.surprise && !/^[…\.．\s]+$/.test(latest.surprise) ? latest.surprise : "";
  const refuel = latest?.refuel && !/^[…\.．\s]+$/.test(latest.refuel) ? latest.refuel : "";
  const weeklyGoodTimes = life?.weeklyGoodTimes ?? [];
  const lowestLabel = lowestKey ? GAUGE_LABELS.find((item) => item.key === lowestKey)?.label : null;
  const lowestValue = lowestKey ? values.find((item) => item.key === lowestKey)?.value : null;
  const cardGoodTimes = goodTimesSummary(weeklyGoodTimes);
  const recentEntries = life?.recentAssessment?.entries ?? [];
  const recentBalance = recentEntries[0]?.balance ?? null;
  const recentKnownGoodTime = recentEntries
    .flatMap((entry) => entry.goodTimes.map((row) => ({ entry, row })))
    .find(({ row }) => !/暂不判断|未知/.test(row.judgment));
  const currentSurprise = recentKnownGoodTime
    ? `${recentKnownGoodTime.entry.sourceDate.slice(5).replace("-", "/")} · ${recentKnownGoodTime.row.judgment}`
    : surprise;
  const currentRefuel = recentBalance ? recentRecoverySummary(recentBalance) : refuel;

  const gaugeBlock = (
    <div className="health-deck-inset life-gauges-block">
      <div className="life-section-head">
        <div><Kicker>时间与精力投入</Kicker></div>
        <div className="life-gauge-head-meta">
          {lowestLabel && lowestValue != null ? <span className="life-card-lowest">最低 · {lowestLabel} {lowestValue}%</span> : null}
        </div>
      </div>
      {values.length ? <LifeGauges values={values} lowestKey={lowestKey} animated /> : <Empty>本周还没记录。</Empty>}
    </div>
  );

  if (mode === "card") {
    return (
      <div className="health-life-panel is-card">
        <TwoQuestions surprise={currentSurprise} refuel={currentRefuel} lead />
        {gaugeBlock}
        {cardGoodTimes ? (
          <div className="health-deck-inset life-goodtimes-compact">
            <Kicker>好时光</Kicker>
            <p className="life-card-goodtimes" title="点进完整页看依据">{cardGoodTimes}</p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="health-life-panel is-full">
      <TwoQuestions surprise={currentSurprise} refuel={currentRefuel} lead />
      {gaugeBlock}
      <section className="life-atelier-section">
        <div className="life-section-head">
          <div><Kicker>好时光</Kicker><h2>哪些事情回能，哪些事情耗能</h2></div>
        </div>
        {weeklyGoodTimes.length ? (
          <div className="life-lean-grid">
            {weeklyGoodTimes.map((row, index) => (
              <LineLeanDial
                key={`${row.text}-${index}`}
                line={row.text}
                lean={row.lean}
                dates={row.dates}
                note={row.note}
                evidence={row.evidence}
              />
            ))}
          </div>
        ) : <p className="life-muted">这周还没有记下哪些事情回能或耗能</p>}
      </section>
    </div>
  );
}

export function lifeBandSummary(_life: HealthSectionData["life"]): string {
  return "投入 · 好时光";
}
