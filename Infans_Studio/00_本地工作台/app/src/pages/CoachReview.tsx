import { ChevronRight, MessageSquareText } from "lucide-react";
import type { HealthSectionData, WriteAction } from "../types";
import { Card, Kicker } from "../page-shared";
import { buildCoachReview, buildCoachReviewSeed } from "./coach-review";

function compactCoachText(text: string) {
  const deload = text.match(/^(.+?) 连续.*?建议减到约 ([\d.]+ kg)/);
  if (deload) return `${deload[1]} → ${deload[2]}`;
  const increase = text.match(/^(.+?) 四组.*?加到约 ([\d.]+ kg)/);
  if (increase) return `${increase[1]} → ${increase[2]}`;
  const makeup = text.match(/^(.+?) 已 (\d+) 天未练/);
  if (makeup) return `${makeup[1]} ${makeup[2]} 天`;
  return text.replace("，或者先查睡眠和吃饭", "");
}

export default function CoachReview({
  data,
  onAskCoach,
  compact = false,
  onOpenDetails,
  id,
}: {
  data: Pick<
    HealthSectionData,
    "trainingVolume" | "progressionAdvice" | "muscleBalance" | "recoveryLoad" | "mesocycle" | "staleMuscles" | "coachHints" | "measurements"
  >;
  onAskCoach: (seedUser: string) => void;
  onWritePreview?: (action: WriteAction) => void;
  sleepMinutes?: number | null;
  compact?: boolean;
  onOpenDetails?: () => void;
  id?: string;
}) {
  const model = buildCoachReview(data);
  const conclusion = model.conclusion;
  const items = model.items;
  const compactGroups = items.reduce<Array<{ kind: string; label: string; texts: string[]; fullTexts: string[] }>>((groups, item) => {
    const current = groups.at(-1);
    if (current?.kind === item.kind) {
      current.texts.push(compactCoachText(item.text));
      current.fullTexts.push(item.text);
    } else {
      groups.push({ kind: item.kind, label: item.label, texts: [compactCoachText(item.text)], fullTexts: [item.text] });
    }
    return groups;
  }, []);

  return (
    <Card className={`coach-review${compact ? " is-compact" : ""}`} id={id}>
      <div className="coach-review-head">
        <div>
          <Kicker>教练复盘</Kicker>
          <h2>最近这一周期</h2>
        </div>
        <div className="coach-review-actions">
          <button
            type="button"
            className="coach-review-ask"
            onClick={compact && onOpenDetails ? onOpenDetails : () => onAskCoach(buildCoachReviewSeed(model))}
          >
            {compact && onOpenDetails ? <ChevronRight size={13} /> : <MessageSquareText size={13} />}
            {compact && onOpenDetails ? "查看详情" : "让小秘书讲讲"}
          </button>
        </div>
      </div>

      {!compact ? (
        <p className="coach-review-auto-hint" title="每两周定时写入训练复盘；不用手点保存">
          复盘会定时自动写入 · 不用手存
        </p>
      ) : null}

      <div className="coach-review-conclusion">
        {conclusion.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>

      {items.length && compact ? (
        <div className="coach-review-groups">
          {compactGroups.map((group) => (
            <section className={`kind-${group.kind}`} key={group.kind}>
              <span className="coach-review-tag">{group.label}</span>
              <p>
                <span className="coach-review-group-brief">{group.texts.join("；")}</span>
                <span className="coach-review-group-expanded">{group.fullTexts.join("；")}</span>
              </p>
            </section>
          ))}
        </div>
      ) : items.length ? (
        <ul className="coach-review-items">
          {items.map((item) => (
            <li className={`kind-${item.kind}`} key={`${item.kind}-${item.text}`} title={item.basis}>
              <span className="coach-review-tag">{item.label}</span>
              <span className="coach-review-text">{item.text}</span>
              <small className="coach-review-basis">{item.basis}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="coach-review-empty">暂时没有要处理的。</p>
      )}
    </Card>
  );
}
