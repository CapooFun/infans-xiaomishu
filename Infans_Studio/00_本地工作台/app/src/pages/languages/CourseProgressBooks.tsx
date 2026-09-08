import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { JapaneseCourseProgress } from "../../types";
import { COURSE_MASTERY_LABELS, type CourseMasteryLevel } from "./course-board-model";
import "./course-progress-books.css";

export type CourseProgressBook = JapaneseCourseProgress["books"][number];
export type CourseProgressLesson = CourseProgressBook["lessons"][number];

const FUTURE_BOOKS = [
  { id: "dekiru-intermediate", label: "中級", series: "できる日本語", title: "《できる日本語 中級》", note: "教材尚未接入" },
  { id: "future-advanced", label: "上級", series: "预留阶段", title: "上級阶段", note: "尚未确定教材" },
] as const;

function levelLabel(level: number | null, practiced = false) {
  if (level === null || level < 0 || level > 3) return practiced ? "已练习" : "暂无记录";
  return `LV${level} ${COURSE_MASTERY_LABELS[level as CourseMasteryLevel]}`;
}

function bookForLessonId(books: CourseProgressBook[], lessonId?: string) {
  return books.find((book) => book.lessons.some((lesson) => lesson.lessonId === lessonId))?.id ?? null;
}

function evaluatedCount(book: CourseProgressBook) {
  return book.lessons.flatMap((lesson) => lesson.stItems).filter((item) => item.level !== null).length;
}

function lessonEvaluation(lesson: CourseProgressLesson) {
  const levels = lesson.stItems.flatMap((item) => item.level === null ? [] : [item.level]);
  const practiced = lesson.stItems.filter((item) => item.practiced || item.level !== null).length;
  if (practiced > levels.length) return `已练 ${practiced}/${lesson.stItems.length} 小节 · ${levels.length} 个有等级`;
  if (!levels.length) return "尚未评价";
  if (levels.length < lesson.stItems.length) return `${levels.length}/${lesson.stItems.length} 个小节已评价`;
  const floor = Math.min(...levels);
  return `整课 LV${floor} ${COURSE_MASTERY_LABELS[floor as CourseMasteryLevel]}`;
}

function LessonPicker({
  lesson,
  selected,
  onSelect,
}: {
  lesson: CourseProgressLesson;
  selected: boolean;
  onSelect?: (lesson: CourseProgressLesson) => void;
}) {
  const content = <>
    <span className="course-volume__lesson-number">{String(lesson.lesson).padStart(2, "0")}</span>
    <strong title={lesson.title}>{lesson.title}</strong>
    <small>{lessonEvaluation(lesson)}</small>
    <div className="course-volume__lesson-levels" aria-label={`${lesson.title}各小节掌握程度`}>
      {lesson.stItems.map((item) => <span className={item.level === null ? item.practiced ? "is-practiced" : "is-unrated" : `is-lv-${item.level}`} key={item.stId}>
        第{lesson.lesson}-{item.st}课 <b>{levelLabel(item.level, item.practiced)}</b>
      </span>)}
    </div>
  </>;
  const className = [
    "course-volume__lesson",
    selected ? "is-selected" : "",
  ].filter(Boolean).join(" ");
  const gradeSummary = lesson.stItems.map((item) => `第${lesson.lesson}-${item.st}课 ${levelLabel(item.level, item.practiced)}`).join("，");
  const label = `第 ${lesson.lesson} 课 ${lesson.title}，${gradeSummary}`;

  return onSelect ? <button
    type="button"
    className={className}
    aria-label={label}
    aria-pressed={selected}
    onClick={() => onSelect(lesson)}
  >{content}</button> : <div className={className} aria-label={label}>{content}</div>;
}

export function CourseProgressBooks({
  books,
  selectedLessonId,
  onSelectLesson,
  includeFuture = true,
  defaultExpanded = false,
  initialExpandedBookId,
  onExpandedBookChange,
  className = "",
}: {
  books: CourseProgressBook[];
  selectedLessonId?: string;
  onSelectLesson?: (lesson: CourseProgressLesson) => void;
  includeFuture?: boolean;
  defaultExpanded?: boolean;
  initialExpandedBookId?: string | null;
  onExpandedBookChange?: (bookId: string | null) => void;
  className?: string;
}) {
  const [expandedBookId, setExpandedBookId] = useState<string | null>(() => (
    initialExpandedBookId !== undefined
      ? initialExpandedBookId
      : defaultExpanded ? (bookForLessonId(books, selectedLessonId) || books[0]?.id || null) : null
  ));

  const expandedBook = books.find((book) => book.id === expandedBookId);
  const futureBook = FUTURE_BOOKS.find((book) => book.id === expandedBookId);

  const toggleBook = (bookId: string) => {
    setExpandedBookId((current) => {
      const next = current === bookId ? null : bookId;
      onExpandedBookChange?.(next);
      return next;
    });
  };

  return <div className={`course-volumes ${className}`.trim()}>
    <div className="course-volume-picker" aria-label="选择教材分册">
      {books.map((book) => {
        const evaluated = evaluatedCount(book);
        const practiced = book.lessons.flatMap((lesson) => lesson.stItems).filter((item) => item.practiced || item.level !== null).length;
        const expanded = expandedBookId === book.id;
        return <button
          type="button"
          className={expanded ? "is-active" : ""}
          aria-expanded={expanded}
          key={book.id}
          onClick={() => toggleBook(book.id)}
        >
          <span>できる日本語</span>
          <strong>{book.label}</strong>
          <small>{book.lessonTotal} 课 · 已练 {practiced}/{book.stTotal} 小节 · {evaluated} 个有等级</small>
          <ChevronDown size={15}/>
        </button>;
      })}
      {includeFuture ? FUTURE_BOOKS.map((book) => <button
        type="button"
        className={`is-future${expandedBookId === book.id ? " is-active" : ""}`}
        aria-expanded={expandedBookId === book.id}
        key={book.id}
        onClick={() => toggleBook(book.id)}
      >
        <span>{book.series}</span>
        <strong>{book.label}</strong>
        <small>后续阶段 · 尚未接入</small>
        <ChevronDown size={15}/>
      </button>) : null}
    </div>

    {expandedBook ? <section className="course-volume" aria-labelledby={`course-volume-${expandedBook.id}`}>
      <header>
        <div>
          <span>第二级 · 选择课次</span>
          <h3 id={`course-volume-${expandedBook.id}`}>《できる日本語 {expandedBook.label}》</h3>
        </div>
        <p>每个课内小节单独显示 LV0–LV3；有记录不等于已经掌握。</p>
      </header>
      <div className="course-volume__lessons" aria-label={`${expandedBook.label}课次与掌握程度`}>
        {expandedBook.lessons.map((lesson) => <LessonPicker
          key={lesson.lessonId}
          lesson={lesson}
          selected={lesson.lessonId === selectedLessonId}
          onSelect={onSelectLesson}
        />)}
      </div>
    </section> : null}

    {futureBook ? <section className="course-volume is-future">
      <header>
        <div><span>后续阶段</span><h3>{futureBook.title}</h3></div>
        <p>{futureBook.note}；等待结构和真实学习记录接入。</p>
      </header>
    </section> : null}
  </div>;
}
