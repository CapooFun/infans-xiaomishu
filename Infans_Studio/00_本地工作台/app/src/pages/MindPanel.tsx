import type { CSSProperties } from "react";
import type { HealthSectionData } from "../types";
import { Kicker } from "../page-shared";

const OBSERVATION_DIMS = [
  { key: "mastery" as const, label: "推进与成果", detail: "解决难题或形成了明确进展", tone: "work" },
  { key: "controlLoss" as const, label: "打断与节奏", detail: "工作安排没有被反复打散", tone: "work" },
  { key: "detachmentFail" as const, label: "收工脱离", detail: "工作结束后能够真正放下", tone: "recovery" },
  { key: "relaxation" as const, label: "真放松", detail: "出现了有明确依据的放松时刻", tone: "recovery" },
];

/** 工作强度柱：分越高越满（不是「越好」）；量纲 0–10。 */
function workIntensityBarStyle(intensity: number | null, maxHeight = 88) {
  if (intensity == null) return { height: 4 };
  const clamped = Math.max(0, Math.min(10, intensity));
  return { height: clamped === 0 ? 3 : Math.max(10, (clamped / 10) * maxHeight) };
}

export default function MindPanel({
  mind,
  variant = "full",
}: {
  mind: HealthSectionData["mind"];
  /** card = 三舱总览预览；full = 展开完整页。 */
  variant?: "card" | "full";
}) {
  const days = mind?.days ?? [];
  const signals = mind?.signals;
  const recoveryPercents = signals?.recoveryPercents?.percents;
  const recoveryScoredDays = signals?.recoveryPercents?.scoredDays ?? 0;
  const recoverySampleDays = signals?.recoveryPercents?.sampleDays;
  const sampleDays = signals?.sampleDays ?? 0;
  const hasObservationSample = recoveryScoredDays > 0 || sampleDays > 0 || Boolean(mind?.recoveryTempTest);
  const intensitySampled = days.filter((day) => day.workIntensity != null);
  const latestIntensityDate = intensitySampled.at(-1)?.date ?? null;
  const recent7 = intensitySampled.slice(-7);
  const avg7 = recent7.length
    ? recent7.reduce((sum, day) => sum + Number(day.workIntensity), 0) / recent7.length
    : null;

  const intensityBlock = (
    <div className={`mind-energy-coarse${variant === "full" ? " is-detail" : ""}`}>
      <div className="mind-energy-coarse-head">
        <span title="这是本人实际承担的工作负荷，不代表工作做得好或不好"><Kicker>近 14 日工作强度</Kicker></span>
        <span className="mind-energy-average">
          {avg7 != null ? <><strong>{avg7.toFixed(1)}</strong><small>7 日均 / 10</small></> : "还没分数"}
        </span>
      </div>
      <div className="mind-energy-plot">
        <div className="mind-energy-axis" aria-hidden="true"><span>10</span><span>5</span><span>0</span></div>
        <div className="mind-energy-chart" role="img" aria-label="最近两周工作强度；柱越高负荷越高，1 到 3 为青绿，4 到 7 为琥珀，8 以上转红；黄点表示训练日，绿点表示休息日">
          {(days.length ? days : Array.from({ length: 14 }, (_, index) => ({
            date: `pad-${index}`,
            workIntensity: null as number | null,
            sleep: null as string | null,
            trained: false,
            restDay: false,
            restReasons: [],
          }))).map((day) => {
            const style = workIntensityBarStyle(day.workIntensity, variant === "full" ? 118 : 72);
            const bucket = day.workIntensity == null ? null : Math.max(0, Math.min(10, day.workIntensity));
            const isLatest = day.date === latestIntensityDate;
            return (
              <div
                className={`mind-energy-col${isLatest ? " is-latest" : ""}`}
                key={day.date}
                title={day.date.startsWith("pad") ? "没记录" : `${day.date}${day.workIntensity != null ? ` · 工作强度 ${day.workIntensity}/10` : " · 没记录"}`}
              >
                <div className="mind-energy-bar-slot">
                  <span className="mind-energy-value" aria-hidden="true">{day.workIntensity ?? "—"}</span>
                  <div className={`mind-energy-bar${bucket == null ? " is-empty" : ` is-e${bucket}`}`} style={style} />
                </div>
                <span className="mind-energy-date">{day.date.startsWith("pad") ? "·" : day.date.slice(8)}</span>
                <span className="mind-energy-markers" aria-label={[day.trained ? "训练日" : "", day.restDay ? "休息日" : ""].filter(Boolean).join("、") || undefined}>
                  <i className={day.trained ? "is-trained" : ""} title={day.trained ? "这天练过" : undefined} />
                  <i className={day.restDay ? "is-rest" : ""} title={day.restDay ? "这天是休息日" : undefined} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mind-energy-legend" aria-label="图例">
        <span><i className="is-trained" />黄＝训练日</span>
        <span><i className="is-rest" />绿＝休息日</span>
      </div>
    </div>
  );

  const observationBlock = hasObservationSample ? (
    <div className="mind-recovery-wrap">
      <div className="mind-recovery-grid mind-work-observation-grid" aria-label="近两周工作与恢复观察">
        {OBSERVATION_DIMS.map((dimension) => {
          const pct = recoveryPercents?.[dimension.key];
          const level = pct == null ? null : Math.max(0, Math.min(100, pct));
          const settling = Math.max(0, ((level ?? 0) - 90) / 10);
          const calm = settling * settling * (3 - 2 * settling);
          const knownDays = recoverySampleDays?.[dimension.key] ?? (pct == null ? 0 : recoveryScoredDays);
          return (
            <div
              className={`mind-recovery-cell is-${dimension.tone}${level != null ? " has-tide" : ""}`}
              key={dimension.key}
              title={`${dimension.detail}；近 14 日只按有明确依据的日期平均，未知不会按 0 计算`}
              style={level == null ? undefined : ({
                "--recovery-level": `${level}%`,
                "--recovery-wave-scale": 1 - calm,
                "--recovery-wave-duration": `${5.5 + 14.5 * calm}s`,
              } as CSSProperties)}
            >
              {level != null ? (
                <span className="mind-recovery-tide" aria-hidden="true">
                  <span className="mind-recovery-tide-fill" />
                  {level > 0 && level < 100 ? <span className="mind-recovery-tide-wave" /> : null}
                </span>
              ) : null}
              <div className="mind-recovery-cell-content">
                <Kicker>{dimension.label}</Kicker>
                <div className="mind-recovery-value"><strong>{pct == null ? "—" : `${pct}%`}</strong></div>
                <small>{knownDays > 0 ? `${knownDays} 天有据` : "暂无可靠记录"}</small>
              </div>
            </div>
          );
        })}
      </div>
      {variant === "full" ? (
        <p className="mind-observation-footnote">
          前两项看这段时间做成了什么、节奏是否被打断；后两项看收工以后能不能真正恢复。百分比只描述有据日，不是心理诊断分。
        </p>
      ) : null}
    </div>
  ) : (
    <p className="mind-recovery-empty">近两周还没有足够记录来观察成果、打断和恢复。</p>
  );

  if (variant === "card") {
    return (
      <div className="health-mind-panel is-card">
        <div className="health-deck-inset">
          <div className="card-title mind-head-compact"><div><Kicker>负荷</Kicker><h2>最近有多辛苦</h2></div></div>
          {intensityBlock}
        </div>
        <div className="health-deck-inset mind-work-observation">
          <div className="mind-sleep-stack-head"><div><Kicker>工作与恢复</Kicker><h2>成果、打断、收工与放松</h2></div></div>
          {observationBlock}
        </div>
      </div>
    );
  }

  return (
    <div className="health-mind-panel">
      <div className="card-title mind-head-compact"><div><Kicker>近期观察</Kicker><h2>看见工作负荷，也看见做成什么和能不能收回来</h2></div></div>
      <div className="mind-pulse-board is-observation-only">
        <section className="mind-pulse-energy">{intensityBlock}</section>
        <section className="mind-pulse-signals mind-work-observation">
          <div className="mind-sleep-stack-head"><div><Kicker>工作与恢复观察</Kicker><h2>成果、打断、收工脱离与真放松</h2></div></div>
          {observationBlock}
        </section>
      </div>
    </div>
  );
}

export function mindBandSummary(_mind: HealthSectionData["mind"] | null | undefined) {
  return "负荷 · 成果 · 恢复";
}
