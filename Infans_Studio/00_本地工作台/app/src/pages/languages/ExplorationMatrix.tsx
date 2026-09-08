import type { JapaneseExploration } from "../../types";
import { Card } from "../../page-shared";
import { CourseProgressBooks } from "./CourseProgressBooks";
import { ProgressRail } from "./ProgressRail";
import { pct } from "./shared";

type CourseEvidence = JapaneseExploration["courseProgress"]["recentEvidence"][number];

function courseEvidenceLabel(item: CourseEvidence) {
  const book = item.lessonId.includes("-chukyu-") ? "初中級" : "初級";
  const lesson = Number(item.lessonId.match(/-(\d+)$/)?.[1] || 0);
  return `${book} · 第 ${lesson}-${item.st} 课`;
}

function modalityLabel(item: CourseEvidence) {
  return [
    item.modalities.speaking ? "开口练过" : "",
    item.modalities.listening ? "做过听辨" : "",
    item.modalities.output ? "自己表达过" : "",
  ].filter(Boolean).join(" · ");
}

export function ExplorationMatrix({ exploration }: { exploration: JapaneseExploration }) {
  const scores = exploration.scores;
  const course = exploration.courseProgress;
  const summary = course.summary;
  return <div className="exploration-board">
    <Card className="exploration-hero exploration-course-hero">
      <div className="exploration-hero-copy">
        <span className="exploration-eyebrow">日语练习积累</span>
        <h2>探索成就</h2>
        <div className="exploration-course-summary">
          <div className="exploration-course-total">
            <strong>{summary.recordedSessionCount}<small> 次</small></strong>
            <span>已归档练习 · 含自由口语</span>
          </div>
          <div className="exploration-ability-grid" aria-label="教材学习概况">
            <div><strong>{summary.practicedSt}/{summary.stTotal}</strong><span>已练小节</span></div>
            <div><strong>{summary.stWithEvidence}</strong><span>小节已有等级</span></div>
            <div><strong>{summary.masteredSt}</strong><span>小节跨日稳定</span></div>
            <div><strong>{summary.lastPracticedOn?.slice(5).replace("-", "/") || "—"}</strong><span>最近练习记录</span></div>
          </div>
        </div>
        <p className="exploration-evidence-rule">口语复习 · 当前到期 {course.oralReview.dueCount} 项 · 每次最多带入 2 项</p>
      </div>
    </Card>

    <Card className="course-progress-card course-progress-card--compact">
      <div className="exploration-ladder-head">
        <div><h2>教材课次</h2></div>
        <details className="learning-evidence-help"><summary>怎样计算进度</summary><p>练过与掌握分开看；等级只来自核验记录。</p></details>
      </div>
      <CourseProgressBooks books={course.books}/>
    </Card>

    <Card className="exploration-ladder exploration-jlpt-reference">
      <div className="exploration-ladder-head">
        <div>
          <span className="exploration-eyebrow">次级参考</span>
          <h2>级别进度</h2>
        </div>
        <details className="learning-evidence-help"><summary>进度与教材的区别</summary><p>词汇和专项练习不会自动算成教材已经学过。</p></details>
      </div>

      <div className="exploration-jlpt-summary">
        <div><strong>{pct(scores?.vocab)}</strong><span>词汇</span></div>
        <div><strong>{pct(scores?.grammar)}</strong><span>文法</span></div>
        <div><strong>{exploration.readingMileage?.totalPassages ?? 0} <small>篇</small></strong><span>阅读</span></div>
        <div><strong>—</strong><span>听力 · 尚无正式记录</span></div>
      </div>
      <p className="exploration-jlpt-assessment">
        <span>综合参考 {pct(scores?.total)}</span>
      </p>

      {!scores?.mistakeAligned ? <p className="muted">⚠ 错题 md 与 json 未对齐（{scores?.mdActiveMistakes}/{scores?.stateActiveMistakes}）</p> : null}


      <div className="exploration-levels">
        {exploration.levels.map((row) => (
          <article className="exploration-level" key={row.level}>
            <header><strong>{row.level}</strong><span>{row.grammar.stageLabel || "门外汉"}</span></header>
            <ProgressRail value={row.vocab.progress ?? (row.vocab.total ? (row.vocab.learned || 0) / row.vocab.total : 0)} label="词汇" sub={row.vocab.label}/>
            <ProgressRail value={row.grammar.progress ?? 0} label="文法" sub={row.grammar.label}/>
            <div className="exploration-reading-note">{row.reading.label || "阅读练习栏 · 不计入探索成就"}</div>
          </article>
        ))}
      </div>

    </Card>

    {course.recentEvidence.length ? (
      <Card className="exploration-log">
        <div className="card-title"><div><h2>最近真正练过的内容</h2></div></div>
        <ul>{course.recentEvidence.map((item) => (
          <li key={item.recordId}>
            <strong>{item.date || item.verifiedAt}</strong>
            <span>{courseEvidenceLabel(item)} · {modalityLabel(item)}</span>
            <em>{item.level >= 3 ? "跨日稳定" : item.level >= 2 ? "可独立完成" : "正在练"}</em>
          </li>
        ))}</ul>
      </Card>
    ) : null}

    {exploration.recentSessions.length ? (
      <Card className="exploration-log exploration-jlpt-log">
        <div className="card-title"><div><h2>最近专项练习</h2></div></div>
        <ul>{exploration.recentSessions.slice(0, 6).map((item) => (
          <li key={`${item.at}-${item.level}-${item.track}`}>
            <strong>{item.at}</strong><span>{item.level} · {item.track}</span><em>{item.correct != null && item.total != null ? `${item.correct}/${item.total}` : "—"}</em>
          </li>
        ))}</ul>
      </Card>
    ) : null}
  </div>;
}
