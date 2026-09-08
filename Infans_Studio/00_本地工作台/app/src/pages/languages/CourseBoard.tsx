import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, Circle, Clock3 } from "lucide-react";
import type { JapaneseCourseProgress, JapaneseCourseProgressStatus } from "../../types";
import { CourseProgressBooks, type CourseProgressBook, type CourseProgressLesson } from "./CourseProgressBooks";
import {
  COURSE_BOOKS,
  COURSE_MASTERY_LABELS,
  buildCourseCatalog,
  courseBook,
  masteryLabel,
  normalizeCoursePosition,
  type CourseMasteryLevel,
  type CoursePosition,
  type CourseSelection,
  type CourseStCard,
} from "./course-board-model";
import "./course-board.css";

export type CourseLessonRecord = {
  lessonId: string;
  title?: string;
  canDo?: string;
  level?: CourseMasteryLevel;
};

export type CourseBoardProps = {
  currentPosition?: CoursePosition;
  suggestedSt?: number;
  records?: CourseLessonRecord[];
  progress?: JapaneseCourseProgress;
  stCards?: Readonly<Partial<Record<string, CourseStCard>>>;
  loadStCard?: (selection: CourseSelection) => Promise<CourseStCard | undefined>;
  onSelectionChange?: (selection: CourseSelection) => void;
  initialExpandedBookId?: string | null;
  onExpandedBookChange?: (bookId: string | null) => void;
  className?: string;
};

function stMasteryLabel(level: number | null, practiced = false) {
  if (level === null || level < 0 || level > 3) return practiced ? "已练习" : "暂无记录";
  return masteryLabel(level as CourseMasteryLevel);
}

function lessonMasterySummary(lesson: CourseProgressLesson | undefined) {
  if (!lesson) return "尚未评价";
  const levels = lesson.stItems.flatMap((item) => item.level === null ? [] : [item.level]);
  const practiced = lesson.stItems.filter((item) => item.practiced || item.level !== null).length;
  if (practiced > levels.length) return `已练 ${practiced}/${lesson.stItems.length} 小节 · ${levels.length} 个有等级`;
  if (!levels.length) return "尚未评价";
  if (levels.length < lesson.stItems.length) return `${levels.length}/${lesson.stItems.length} 个小节已评价`;
  const floor = Math.min(...levels) as CourseMasteryLevel;
  return `整课 LV${floor} ${COURSE_MASTERY_LABELS[floor]}`;
}

function grammarFocusParts(focus: string) {
  const [kind = "重点", pattern = focus, usage = "", ...rest] = focus.split("｜").map((part) => part.trim()).filter(Boolean);
  return { kind, pattern, usage: [usage, ...rest].filter(Boolean).join("；") };
}

function StatusIcon({ status }: { status: JapaneseCourseProgressStatus }) {
  if (status === "mastered") return <CheckCircle2 size={15}/>;
  if (status === "in-progress") return <Clock3 size={15}/>;
  return <Circle size={14}/>;
}

function fallbackProgressBooks(
  records: CourseLessonRecord[],
): CourseProgressBook[] {
  const catalog = buildCourseCatalog();
  const recordsByLessonId = new Map(records.map((record) => [record.lessonId, record]));
  return COURSE_BOOKS.map((book) => {
    const lessons: CourseProgressLesson[] = catalog.filter((lesson) => lesson.book === book.id).map((lesson) => {
      const record = recordsByLessonId.get(lesson.id);
      const status: JapaneseCourseProgressStatus = record?.level === undefined
        ? "not-started"
        : record.level >= 3 ? "mastered" : "in-progress";
      return {
        lesson: lesson.lesson,
        lessonId: lesson.id,
        title: record?.title || `第${lesson.lesson}课`,
        status,
        isCurrentSelection: false,
        stItems: lesson.stIds.map((stId, index) => ({
          st: index + 1,
          stId,
          status,
          level: record?.level ?? null,
          recordIds: [],
          modalities: { speaking: false, listening: false, output: false },
        })),
      };
    });
    const allSt = lessons.flatMap((lesson) => lesson.stItems);
    return {
      id: book.id,
      label: book.label,
      lessonTotal: lessons.length,
      stTotal: allSt.length,
      stWithEvidence: allSt.filter((item) => item.status === "in-progress" || item.status === "mastered").length,
      masteredSt: allSt.filter((item) => item.status === "mastered").length,
      lessons,
    };
  });
}

function modalityLabels(modalities: CourseProgressLesson["stItems"][number]["modalities"]) {
  const labels = [
    modalities.speaking ? "开口" : "",
    modalities.listening ? "听辨" : "",
    modalities.output ? "自主表达" : "",
  ].filter(Boolean);
  return labels.length ? labels.join(" · ") : "还没有可展示的练习证据";
}

function modalitySummary(item: CourseProgressLesson["stItems"][number]) {
  return modalityLabels(item.modalities);
}

export function CourseBoard({
  currentPosition,
  suggestedSt = 1,
  records = [],
  progress,
  stCards,
  loadStCard,
  onSelectionChange,
  initialExpandedBookId,
  onExpandedBookChange,
  className = "",
}: CourseBoardProps) {
  const startingSelection = currentPosition
    ? normalizeCoursePosition({ ...currentPosition, st: currentPosition.st ?? suggestedSt })
    : null;
  const [selected, setSelected] = useState<CourseSelection | null>(startingSelection);
  const [loadedCards, setLoadedCards] = useState<Record<string, CourseStCard>>({});
  const [focusStatus, setFocusStatus] = useState<"idle" | "loading" | "missing" | "error">("idle");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [openGrammarPointIds, setOpenGrammarPointIds] = useState<Set<string>>(() => new Set());
  const books = useMemo(
    () => progress?.books ?? fallbackProgressBooks(records),
    [progress, records],
  );

  useEffect(() => {
    setSelected(startingSelection);
  }, [startingSelection?.book, startingSelection?.lesson, startingSelection?.st]);

  useEffect(() => {
    setOpenGrammarPointIds(new Set());
  }, [selected?.lessonId]);

  const selectedBook = selected ? courseBook(selected.book) : null;
  const selectedLesson = selected ? books
    .flatMap((book) => book.lessons)
    .find((lesson) => lesson.lessonId === selected.lessonId) : undefined;
  const lessonTitle = selected ? selectedLesson?.title
    || records.find((record) => record.lessonId === selected.lessonId)?.title
    || `第${selected.lesson}课` : "";
  const selectedRecord = selected ? records.find((record) => record.lessonId === selected.lessonId) : undefined;
  const lessonSelections = useMemo(
    () => selected && selectedBook ? Array.from({ length: selectedBook.stPerLesson }, (_, index) => (
      normalizeCoursePosition({ book: selected.book, lesson: selected.lesson, st: index + 1 })
    )) : [],
    [selected?.book, selected?.lesson, selectedBook?.stPerLesson],
  );

  useEffect(() => {
    if (!loadStCard) {
      setFocusStatus("idle");
      return;
    }
    let cancelled = false;
    const selectionsToLoad = lessonSelections.filter((selection) => !stCards?.[selection.stId] && !loadedCards[selection.stId]);
    if (!selectionsToLoad.length) {
      setFocusStatus("idle");
      return;
    }
    setFocusStatus("loading");
    void Promise.allSettled(selectionsToLoad.map((selection) => loadStCard(selection))).then((results) => {
      if (cancelled) return;
      const cards = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
      if (cards.length) {
        setLoadedCards((currentCards) => {
          const nextCards = { ...currentCards };
          for (const card of cards) nextCards[card.stId] = card;
          return nextCards;
        });
      }
      const failed = results.some((result) => result.status === "rejected");
      setFocusStatus(failed ? "error" : cards.length ? "idle" : "missing");
    });
    return () => { cancelled = true; };
  }, [lessonSelections, loadStCard, stCards, loadAttempt]);

  const lessonCards = lessonSelections.flatMap((selection) => {
    const card = stCards?.[selection.stId] ?? loadedCards[selection.stId];
    return card ? [card] : [];
  });
  const richGrammarCards = lessonCards.filter((card) => card.grammarFocus?.length);
  const grammarFocus = Array.from(new Set(lessonCards.flatMap((card) => card.supports).filter(Boolean)));
  const recentLessonEvidence = selected
    ? (progress?.recentEvidence ?? []).filter((item) => item.lessonId === selected.lessonId)
    : [];

  const selectLesson = (lesson: CourseProgressLesson) => {
    const book = lesson.lessonId.includes("-chukyu-") ? "intermediate" : "beginner";
    const next = normalizeCoursePosition({ book, lesson: lesson.lesson, st: 1 });
    setSelected(next);
    onSelectionChange?.(next);
  };

  const setGrammarPointOpen = (pointId: string, open: boolean) => {
    setOpenGrammarPointIds((current) => {
      const next = new Set(current);
      if (open) next.add(pointId);
      else next.delete(pointId);
      return next;
    });
  };

  const setGrammarGroupOpen = (pointIds: string[], open: boolean) => {
    setOpenGrammarPointIds((current) => {
      const next = new Set(current);
      for (const pointId of pointIds) {
        if (open) next.add(pointId);
        else next.delete(pointId);
      }
      return next;
    });
  };

  return <section className={`course-board ${className}`.trim()} aria-labelledby="course-board-title">
    <header className="course-board__toolbar">
      <h2 id="course-board-title">《できる日本語》课程进度</h2>
    </header>

    <section className="course-board__overview" aria-label="课程分册与课次进度">
      <CourseProgressBooks
        books={books}
        selectedLessonId={selected?.lessonId}
        onSelectLesson={selectLesson}
        initialExpandedBookId={initialExpandedBookId}
        onExpandedBookChange={onExpandedBookChange}
      />
    </section>

    {selected && selectedBook ? <article className="course-board__detail" aria-labelledby="course-board-detail-title">
      <header className="course-board__detail-head">
        <div>
          <span>{selectedBook.label} · 第 {selected.lesson} 课</span>
          <h3 id="course-board-detail-title" lang="ja">{lessonTitle}</h3>
          {selectedRecord?.canDo ? <p>{selectedRecord.canDo}</p> : null}
        </div>
        <strong className={`is-${selectedLesson?.status || "not-started"}`}>
          {lessonMasterySummary(selectedLesson)}
        </strong>
      </header>

      <section className="course-board__st-map" aria-labelledby="course-board-st-map-title">
        <header>
          <div><span>第三级 · 小节学习卡</span><h4 id="course-board-st-map-title">本课小节与学习记录</h4></div>
          <p>教材环节与学习记录集中在每个小节里；展开卡片查看已核验的课业明细。</p>
        </header>
        <div>
          {lessonSelections.map((selection) => {
            const item = selectedLesson?.stItems.find((candidate) => candidate.stId === selection.stId);
            const card = stCards?.[selection.stId] ?? loadedCards[selection.stId];
            const stEvidence = recentLessonEvidence.filter((evidence) => evidence.stId === selection.stId);
            const recordCount = item?.recordIds.length ?? 0;
            return <details className={item?.level === null || item?.level === undefined ? "is-unrated" : `is-lv-${item.level}`} key={selection.stId}>
              <summary>
                <header>
                  <div><span>第 {selected.lesson}-{selection.st} 课</span><strong lang="ja">{card?.title || `第 ${selected.lesson}-${selection.st} 课`}</strong></div>
                  <div className="course-board__st-state"><em>{stMasteryLabel(item?.level ?? null, item?.practiced)}</em><ChevronDown size={16}/></div>
                </header>
                <p>{card ? `教材本册第 ${card.sourceBookPage} 页起` : focusStatus === "loading" ? "正在读取教材结构……" : "教材目录待收录"}</p>
                {card?.sections.length ? <div className="course-board__section-chips">
                  {card.sections.map((section) => <span key={section.id}>{section.title}{section.sourceBookPage ? ` · P${section.sourceBookPage}` : ""}</span>)}
                </div> : null}
                <small>{item?.practiced && !recordCount ? "已练习" : item ? `${modalitySummary(item)} · ${recordCount} 条核验记录` : "还没有学习证据"}</small>
              </summary>
              <div className="course-board__st-records">
                <header><strong>我的课业记录</strong><span>{recordCount} 条已核验</span></header>
                {stEvidence.length ? <div>
                  {stEvidence.map((evidence) => <article className={`is-${evidence.status}`} key={evidence.recordId}>
                    <StatusIcon status={evidence.status}/>
                    <div><strong>{evidence.date || evidence.verifiedAt}</strong><span>{modalityLabels(evidence.modalities)}</span></div>
                    <em>{stMasteryLabel(evidence.level)}</em>
                  </article>)}
                </div> : <p>{recordCount ? `已有 ${recordCount} 条学习记录，近期摘要暂未显示在这里。` : item?.practiced ? "本节练习记录尚未关联到这里。" : "暂无本节学习记录；练习对话经核验入库后会显示在这里。"}</p>}
              </div>
            </details>;
          })}
        </div>
      </section>

      <div className="course-board__detail-grid">
        <section className="course-board__focus" aria-labelledby="course-board-focus-title">
          <header>
            <div>
              <span>教材明确标注</span>
              <h4 id="course-board-focus-title">本课重点语法</h4>
            </div>
            <small>{richGrammarCards.length ? "按小节整理 · 课文例句配中文精译" : "按教材小节系统收录"}</small>
          </header>
          {focusStatus === "error" ? <div className="course-board__pending" role="status">
            <strong>{lessonCards.length ? "部分教材内容读取失败" : "教材重点读取失败"}</strong>
            <p>暂时无法读取教材，请确认与小秘书的连接后重试。</p>
            <button type="button" className="course-board__retry" onClick={() => {
              setFocusStatus("loading");
              setLoadAttempt((attempt) => attempt + 1);
            }}>重新读取</button>
          </div> : null}
          {richGrammarCards.length ? <div className="course-board__grammar-sections">
            {richGrammarCards.map((card) => {
              const st = lessonSelections.findIndex((selection) => selection.stId === card.stId) + 1;
              const grammarPointIds = card.grammarFocus?.map((point) => `${card.stId}:${point.id}`) ?? [];
              const allGrammarPointsOpen = grammarPointIds.length > 0 && grammarPointIds.every((pointId) => openGrammarPointIds.has(pointId));
              return <section key={card.stId} aria-labelledby={`${card.stId}-grammar-title`}>
                <header>
                  <div><span>第 {selected.lesson}-{st} 课 · 语法分组</span><h5 id={`${card.stId}-grammar-title`} lang="ja">{card.title}</h5></div>
                  <div className="course-board__grammar-group-actions">
                    <small>{card.grammarFocus?.length ?? 0} 个语法点</small>
                    <button
                      type="button"
                      aria-controls={`${card.stId}-grammar-points`}
                      aria-expanded={allGrammarPointsOpen}
                      onClick={() => setGrammarGroupOpen(grammarPointIds, !allGrammarPointsOpen)}
                    >{allGrammarPointsOpen ? "全部收起" : "全部展开"}</button>
                  </div>
                </header>
                <div className="course-board__grammar-points" id={`${card.stId}-grammar-points`}>
                  {card.grammarFocus?.map((point) => {
                    const pointId = `${card.stId}:${point.id}`;
                    const pointOpen = openGrammarPointIds.has(pointId);
                    return <details key={point.id} open={pointOpen} onToggle={(event) => setGrammarPointOpen(pointId, event.currentTarget.open)}>
                      <summary>
                        <header>
                          <div><span>{selected.lesson}-{st} · {point.kind}</span><strong lang="ja">{point.pattern}</strong></div>
                          <ChevronDown size={16}/>
                        </header>
                        <p className="course-board__grammar-connection"><b>接续</b><span lang="ja">{point.connection}</span></p>
                        <p className="course-board__grammar-summary">{point.summary}</p>
                        <div className="course-board__grammar-card-state"><span>{point.usages.length} 种用法</span><strong>{pointOpen ? "点击收起" : "点击展开"}</strong></div>
                      </summary>
                      <div className="course-board__grammar-usages">
                        {point.usages.map((usage, usageIndex) => <section key={`${point.id}-${usage.label}`}>
                          <header><span>用法 {usageIndex + 1}</span><strong>{usage.label}</strong></header>
                          <p>{usage.explanation}</p>
                          <div className="course-board__grammar-examples">
                            {usage.examples.map((example, exampleIndex) => <article key={`${point.id}-${usageIndex}-${exampleIndex}`}>
                              <span>{example.source || "例句"}</span>
                              <p lang="ja">{example.japanese}</p>
                              <p>{example.chinese}</p>
                            </article>)}
                          </div>
                        </section>)}
                      </div>
                    </details>;
                  })}
                </div>
              </section>;
            })}
          </div> : grammarFocus.length ? <ul>
            {grammarFocus.map((focus) => {
              const parts = grammarFocusParts(focus);
              return <li key={focus}>
                <span>{parts.kind}</span>
                <strong lang="ja">{parts.pattern}</strong>
                {parts.usage ? <p>{parts.usage}</p> : null}
              </li>;
            })}
          </ul> : focusStatus !== "error" ? <div className="course-board__pending" aria-live="polite">
            <strong>{focusStatus === "loading" ? "正在核对教材重点……" : "教材重点映射待整理"}</strong>
            <p>在教材后附学习重点完成核对前，这里不会扫描正文或自行补写。</p>
          </div> : null}
        </section>
      </div>

    </article> : null}
  </section>;
}
