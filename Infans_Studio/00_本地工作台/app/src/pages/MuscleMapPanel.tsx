import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, RotateCcw, X } from "lucide-react";
import { MuscleMap } from "@musclemap/react";
import type { MuscleGroup } from "@musclemap/core";
import { MUSCLE_GROUP_PARTS } from "@musclemap/assets";
import maleFront from "@musclemap/assets/bodies/male-front.webp";
import maleBack from "@musclemap/assets/bodies/male-back.webp";
import { Card, Kicker } from "../page-shared";
import {
  buildMuscleStates,
  buildPartGroupIndex,
  exerciseMediaUrls,
  muscleIdFromGroup,
  MUSCLEMAP_LABELS,
  paintColorForMuscleLabel,
  statusMeta,
  toMuscleMapValues,
  zoneById,
  type ExerciseRecommendation,
  type MuscleId,
  type MuscleView,
  type RecoveryStatus,
} from "../muscle-map";
import type { HealthSectionData } from "../types";

const STATUS_ORDER: RecoveryStatus[] = ["overdue", "due", "ready", "recovering", "unknown"];
const PART_GROUP_INDEX = buildPartGroupIndex(MUSCLE_GROUP_PARTS);

function selectMuscle(id: MuscleId, setSelected: (id: MuscleId) => void, setView: (view: MuscleView) => void, currentView: MuscleView) {
  setSelected(id);
  const zone = zoneById(id);
  if (!zone.views.includes(currentView)) setView(zone.views[0]!);
}

function applyDiscreteMuscleColors(root: HTMLElement, states: ReturnType<typeof buildMuscleStates>) {
  for (const path of root.querySelectorAll("path[aria-label]")) {
    const label = path.getAttribute("aria-label");
    if (!label) continue;
    const color = paintColorForMuscleLabel(label, states, PART_GROUP_INDEX);
    if (color) path.setAttribute("fill", color);
  }
}

/** 动作示范卡：挂在侧栏；竖屏在教练复盘上方，宽屏由 CSS 贴到底。 */
export function ExercisePreviewCard({
  preview,
  onClose,
}: {
  preview: ExerciseRecommendation;
  onClose: () => void;
}) {
  const media = preview.mediaId ? exerciseMediaUrls(preview.mediaId) : null;
  if (!media) return null;
  return (
    <div className="muscle-exercise-preview is-docked">
      <header>
        <div>
          <Kicker>训练示范</Kicker>
          <h4>{preview.name}</h4>
        </div>
        <button type="button" aria-label="关闭示范" onClick={onClose}><X size={14} /></button>
      </header>
      <div className="muscle-exercise-media">
        <img
          src={media.gif}
          alt={`${preview.name} 动作示范`}
          loading="lazy"
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = media.image;
          }}
        />
      </div>
      <p>{preview.datasetName ? `数据集：${preview.datasetName}` : "本地动作库"} · 动图仅供个人参考</p>
    </div>
  );
}

export default function MuscleMapPanel({
  sessions,
  strength,
  today,
  compact = false,
  /** 示范图画到外部侧栏时设 true */
  externalPreview = false,
  preview = null,
  onPreviewChange,
}: {
  sessions: HealthSectionData["sessions"];
  strength: HealthSectionData["strength"];
  today: string;
  compact?: boolean;
  externalPreview?: boolean;
  preview?: ExerciseRecommendation | null;
  onPreviewChange?: (next: ExerciseRecommendation | null) => void;
}) {
  const states = buildMuscleStates(sessions, today);
  const values = toMuscleMapValues(states);
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<MuscleView>("front");
  const [selected, setSelected] = useState<MuscleId>("chest");
  const [innerPreview, setInnerPreview] = useState<ExerciseRecommendation | null>(null);
  const activePreview = externalPreview ? preview : innerPreview;
  const setActivePreview = (next: ExerciseRecommendation | null) => {
    if (externalPreview) onPreviewChange?.(next);
    else setInnerPreview(next);
  };
  const active = states.find((item) => item.id === selected) ?? states[0]!;
  const zone = zoneById(active.id);
  const relatedStrength = strength.filter((item) => zone.strengthLabels.includes(item.label));
  const summary = STATUS_ORDER.map((status) => ({
    status,
    count: states.filter((item) => item.status === status).length,
    ...statusMeta(status),
  })).filter((item) => item.count > 0);
  const media = !externalPreview && activePreview?.mediaId ? exerciseMediaUrls(activePreview.mediaId) : null;

  useLayoutEffect(() => {
    const root = hostRef.current;
    if (!root) return;
    applyDiscreteMuscleColors(root, states);
    const frame = window.requestAnimationFrame(() => applyDiscreteMuscleColors(root, states));
    return () => window.cancelAnimationFrame(frame);
  }, [states, view, selected]);

  return (
    <div data-stop-deck>
    <Card className={`muscle-map-card${compact ? " is-compact" : ""}`}>
      <div className="card-title">
        <div>
          <h2>{compact ? "恢复图" : "肌群恢复图"}</h2>
        </div>
        <div className="muscle-view-toggle">
          <button type="button" className={view === "front" ? "active" : ""} aria-pressed={view === "front"} aria-label="正面视图" onClick={() => setView("front")}>正</button>
          <button type="button" className={view === "back" ? "active" : ""} aria-pressed={view === "back"} aria-label="背面视图" onClick={() => setView("back")}>背</button>
        </div>
      </div>
      {compact ? null : (
        <p className="muscle-map-lead">
          红＝还在恢复，绿＝可以练，黄＝该练了，白＝太久没练。点动作看示范。
        </p>
      )}

      <div className="muscle-map-layout">
        <div className="muscle-map-stage">
          <div className="muscle-map-host" ref={hostRef}>
            <MuscleMap
              values={values}
              sex="MALE"
              view={view === "front" ? "FRONT" : "BACK"}
              region="FULL_BODY"
              colorModel="RECOVERY_RISK"
              glow={false}
              showLegend={false}
              figureWidth={compact ? 148 : 210}
              labels={MUSCLEMAP_LABELS}
              tooltipFields={["group"]}
              backgroundImageFront={maleFront}
              backgroundImageBack={maleBack}
              backgroundGrayscale
              backgroundOpacity={0.42}
              backgroundBrightness={1.15}
              onSelectMuscle={({ group }: { group: MuscleGroup }) => {
                const id = muscleIdFromGroup(group);
                if (id) {
                  selectMuscle(id, setSelected, setView, view);
                  setActivePreview(null);
                }
              }}
              className="muscle-map-lib"
            />
          </div>
          <div className="muscle-legend">
            {summary.map((item) => (
              <span key={item.status} className={`muscle-legend-chip ${item.tone}`}>
                <i style={{ background: item.color }} />
                {item.headline} {item.count}
              </span>
            ))}
          </div>

          {!compact && active.hits.length > 1 ? (
            <div className="muscle-history-block under-map">
              <h4><RotateCcw size={12} /> 最近练到</h4>
              {active.hits.slice(0, 4).map((hit) => (
                <div className="muscle-history-row" key={`${hit.date}-${hit.exercise}`}>
                  <time>{hit.date}</time>
                  <span>{hit.exercise}</span>
                  <strong>{hit.topSet}</strong>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {compact ? null : (
          <div className="muscle-detail">
            <header>
              <div>
                <Kicker>{active.label}</Kicker>
                <h3>{active.label}</h3>
              </div>
              <strong className={`muscle-status ${statusMeta(active.status).tone}`}>{active.headline}</strong>
            </header>
            <p>{active.detail}</p>
            {active.lastDate ? <small className="muscle-last">最近练到 {active.lastDate} · {active.hits[0]?.exercise} · {active.hits[0]?.topSet}</small> : null}

            {relatedStrength.length ? (
              <div className="muscle-strength-block">
                <h4>当前最重记录</h4>
                {relatedStrength.map((item) => (
                  <div className="muscle-strength-row" key={item.label}>
                    <div><span>{item.label}</span><small>{item.note}</small></div>
                    <strong>{item.value}</strong>
                    <time>{item.date}</time>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="muscle-recommend-block">
              <h4>建议练这些 · 点开看示范</h4>
              {zone.recommendations.map((item) => (
                <Fragment key={item.name}>
                  <button
                    type="button"
                    className={`muscle-recommend-row${activePreview?.name === item.name ? " active" : ""}`}
                    onClick={() => setActivePreview(activePreview?.name === item.name ? null : item)}
                    disabled={!item.mediaId}
                  >
                    <ChevronRight size={14} />
                    <div>
                      <strong>{item.name}</strong>
                      <small>{item.note}{item.mediaId ? "" : " · 没有示范图"}</small>
                    </div>
                  </button>
                  {!externalPreview && activePreview?.name === item.name && media ? (
                    <div className="muscle-exercise-preview">
                      <header>
                        <div>
                          <Kicker>动作示范</Kicker>
                          <h4>{activePreview.name}</h4>
                        </div>
                        <button type="button" aria-label="关闭示范" onClick={() => setActivePreview(null)}><X size={14} /></button>
                      </header>
                      <div className="muscle-exercise-media">
                        <img src={media.gif} alt={`${activePreview.name} 动作示范`} loading="lazy" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = media.image; }} />
                      </div>
                      <p>{activePreview.datasetName ? `数据集：${activePreview.datasetName}` : "本地动作库"} · 动图仅供个人参考</p>
                    </div>
                  ) : null}
                </Fragment>
              ))}
            </div>
          </div>
        )}
      </div>

      {compact ? null : (
        <div className="muscle-chip-rail">
          {states.map((item) => (
            <button type="button" key={item.id} className={`muscle-chip ${statusMeta(item.status).tone}${selected === item.id ? " active" : ""}`} onClick={() => { selectMuscle(item.id, setSelected, setView, view); setActivePreview(null); }}>
              <span>{item.label}</span>
              <small>{item.daysSince === null ? "—" : `${item.daysSince}d`}</small>
            </button>
          ))}
        </div>
      )}
    </Card>
    </div>
  );
}
