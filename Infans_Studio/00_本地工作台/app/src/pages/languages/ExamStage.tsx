import { X } from "lucide-react";
import type { JapaneseExamKind, JapaneseExamPaper, JapaneseExamResult } from "../../types";
import { Card, Empty, Kicker } from "../../page-shared";
import { EXAM_MODE_META, type ExamScope, modeLabel } from "./shared";

export function ExamStage({
  suggested,
  paper,
  result,
  answers,
  loading,
  error,
  onClose,
  onConfirm,
  onPickKind,
  onPickLevel,
  onAnswer,
  onSubmit,
  index,
  setIndex,
}: {
  suggested: ExamScope;
  paper: JapaneseExamPaper | null;
  result: JapaneseExamResult | null;
  answers: Record<string, string>;
  loading: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
  onPickKind: (kind: JapaneseExamKind) => void;
  onPickLevel: (level: string) => void;
  onAnswer: (id: string, value: string) => void;
  onSubmit: () => void;
  index: number;
  setIndex: (value: number) => void;
}) {
  const mcqs = (paper?.questions || []).filter((item) => item.type === "mcq");
  const passages = (paper?.questions || []).filter((item) => item.type === "passage");
  const current = mcqs[index] || null;
  const answered = mcqs.filter((item) => answers[item.id]).length;
  const notes = paper?.notes?.length ? paper.notes : null;

  return <div className="exam-stage">
    <Card className="exam-paper">
      <header className="exam-paper-head">
        <div>
          <Kicker>小秘书开考</Kicker>
          <h2>{paper?.label || suggested.label}</h2>
          <p>中间作答 · 旁侧小秘书可问可评可续。确认模式前不会出题。</p>
        </div>
        <button type="button" className="exam-chip" onClick={onClose} aria-label="关闭练习"><X size={16}/>关闭</button>
      </header>

      {!paper ? (
        <div className="exam-confirm">
          <p>先选模式，再选级别。当前：<strong>{suggested.label}</strong>{suggested.pointIds?.length ? ` · 已选 ${suggested.pointIds.length} 卡` : ""}</p>
          <div className="exam-mode-picks">
            {EXAM_MODE_META.map((mode) => (
              <button
                type="button"
                key={mode.kind}
                className={suggested.kind === mode.kind ? "active" : ""}
                onClick={() => onPickKind(mode.kind)}
              >
                <strong>{mode.label}</strong>
                <span>{mode.blurb}</span>
              </button>
            ))}
          </div>
          <div className="exam-level-picks" aria-label="级别">
            {(["N5", "N4", "N3", "N2"] as const).map((level) => (
              <button key={level} className={suggested.level === level ? "active" : ""} onClick={() => onPickLevel(level)}>{level}</button>
            ))}
          </div>
          {suggested.kind === "special" && !suggested.pointIds?.length ? (
            <p className="exam-status">专项练习请先在「文法」Tab 或探索成就页把卡片加入待练清单。</p>
          ) : null}
          <div className="exam-confirm-actions">
            <button className="exam-chip primary" disabled={loading || (suggested.kind === "special" && !suggested.pointIds?.length)} onClick={onConfirm}>
              {loading ? "处理中…" : "确认开考"}
            </button>
          </div>
          {loading ? <p className="exam-status">正在出题…</p> : null}
          {error ? <Empty>{error}</Empty> : null}
        </div>
      ) : result ? (
        <div className="exam-result">
          <h3>{result.correct} / {result.total}</h3>
          <p>{result.label} 已交卷。进度和错题已经记好了；可以让右边的小秘书讲评或再来一份。</p>
          <p className="muted">已答对：{result.uniqueVerified.join(", ") || "—"}</p>
          <p className="muted">还错着：{result.uniqueMissed.join(", ") || "—"}</p>
          {result.clearedMistakes?.length ? <p className="muted">连续答对 2 次，以后不再出：{result.clearedMistakes.join(", ")}</p> : null}
          {result.written?.length ? <p className="muted">已写入 {result.written.join(" · ")}</p> : null}
        </div>
      ) : (
        <div className="exam-active">
          {notes ? <p className="exam-status">{notes.join(" · ")}</p> : null}
          {passages.map((passage) => <blockquote key={passage.id} className="exam-passage">{passage.prompt}</blockquote>)}
          {current ? (
            <article className="exam-question">
              <header><span>{index + 1} / {mcqs.length}</span><small>{current.nodeIds.join(", ")}</small></header>
              <pre>{current.prompt}</pre>
              <div className="exam-choices">
                {current.choices.map((choice) => (
                  <button key={choice} className={answers[current.id] === choice ? "active" : ""} onClick={() => onAnswer(current.id, choice)}>{choice}</button>
                ))}
              </div>
            </article>
          ) : <Empty>本份没有客观题。</Empty>}
          <footer className="exam-nav">
            <button disabled={index <= 0} onClick={() => setIndex(Math.max(0, index - 1))}>上一题</button>
            <span>已答 {answered}/{mcqs.length}</span>
            {index < mcqs.length - 1
              ? <button disabled={index >= mcqs.length - 1} onClick={() => setIndex(Math.min(mcqs.length - 1, index + 1))}>下一题</button>
              : <button className="exam-chip primary" disabled={loading || answered < mcqs.length} onClick={onSubmit}>{loading ? "判分中…" : "交卷"}</button>}
          </footer>
          {error ? <Empty>{error}</Empty> : null}
        </div>
      )}
    </Card>
  </div>;
}
