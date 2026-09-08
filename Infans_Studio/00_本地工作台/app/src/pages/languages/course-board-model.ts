export type CourseBookId = "beginner" | "intermediate";
export type CourseMasteryLevel = 0 | 1 | 2 | 3;

export type CourseScriptLine = {
  id: string;
  speaker: string;
  text: string;
};

export type CourseScriptTrack = {
  track: string;
  lines: CourseScriptLine[];
};

export type CourseSectionKind = "listen" | "challenge" | "say" | "try" | "integrated" | "other";
export type CourseSectionItemKind = "audio" | "question" | "activity" | "reading" | "writing";
export type CourseContentBlockKind = "script" | "prompt" | "answer" | "example" | "note";

export type CourseContentBlock = {
  id: string;
  kind: CourseContentBlockKind;
  title?: string;
  text?: string;
  lines?: CourseScriptLine[];
};

export type CourseSectionItem = {
  id: string;
  kind: CourseSectionItemKind;
  title: string;
  audioTrack?: string;
  sourceBookPage?: number;
  blocks: CourseContentBlock[];
};

export type CourseSection = {
  id: string;
  kind: CourseSectionKind;
  title: string;
  subtitle?: string;
  summary?: string;
  sourceBookPage?: number;
  items: CourseSectionItem[];
};

export type CourseGrammarExample = {
  japanese: string;
  chinese: string;
  source?: string;
};

export type CourseGrammarUsage = {
  label: string;
  explanation: string;
  examples: CourseGrammarExample[];
};

export type CourseGrammarFocusPoint = {
  id: string;
  kind: string;
  pattern: string;
  connection: string;
  summary: string;
  usages: CourseGrammarUsage[];
};

export type CourseStCard = {
  stId: string;
  title: string;
  goal: string;
  officialSummary: string;
  sourceBookPage: number;
  currentSectionId?: string;
  sections: CourseSection[];
  supports: string[];
  grammarFocus?: CourseGrammarFocusPoint[];
};

export type CoursePosition = {
  book: CourseBookId;
  lesson: number;
  st?: number;
};

export type CourseSelection = {
  book: CourseBookId;
  lesson: number;
  st: number;
  lessonId: string;
  stId: string;
};

export type CourseCatalogLesson = {
  id: string;
  book: CourseBookId;
  lesson: number;
  stCount: number;
  stIds: string[];
};

export const COURSE_BOOKS = [
  { id: "beginner" as const, label: "初級", lessons: 15, stPerLesson: 3 },
  { id: "intermediate" as const, label: "初中級", lessons: 15, stPerLesson: 2 },
] as const;

export const COURSE_MASTERY_LABELS: Record<CourseMasteryLevel, string> = {
  0: "门外汉",
  1: "入门",
  2: "可独立完成",
  3: "跨日稳定",
};

export const COURSE_SECTION_DEFINITIONS = [
  { kind: "challenge" as const, title: "チャレンジ", subtitle: "会話を聞いて表現を見つける" },
  { kind: "say" as const, title: "言ってみよう", subtitle: "ことばにして確かめる" },
  { kind: "try" as const, title: "やってみよう", subtitle: "自分の場面で使ってみる" },
  { kind: "integrated" as const, title: "話読聞書", subtitle: "4 技能をつなげる" },
] as const satisfies ReadonlyArray<{ kind: CourseSectionKind; title: string; subtitle: string }>;

function boundedInteger(value: number | undefined, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

export function courseBook(book: CourseBookId) {
  return COURSE_BOOKS.find((item) => item.id === book) || COURSE_BOOKS[0];
}

export function courseLessonId(book: CourseBookId, lesson: number) {
  const prefix = book === "beginner" ? "shokyu" : "chukyu";
  return `dekiru-${prefix}-${String(lesson).padStart(2, "0")}`;
}

export function buildCourseCatalog(): CourseCatalogLesson[] {
  return COURSE_BOOKS.flatMap((book) => Array.from({ length: book.lessons }, (_, index) => {
    const lesson = index + 1;
    const id = courseLessonId(book.id, lesson);
    return {
      id,
      book: book.id,
      lesson,
      stCount: book.stPerLesson,
      stIds: Array.from({ length: book.stPerLesson }, (__, stIndex) => `${id}-st${stIndex + 1}`),
    };
  }));
}

export function normalizeCoursePosition(position: CoursePosition): CourseSelection {
  const book = courseBook(position.book);
  const lesson = boundedInteger(position.lesson, 1, book.lessons);
  const st = boundedInteger(position.st, 1, book.stPerLesson);
  const lessonId = courseLessonId(book.id, lesson);
  return { book: book.id, lesson, st, lessonId, stId: `${lessonId}-st${st}` };
}

export function masteryLabel(level: CourseMasteryLevel | undefined) {
  return level === undefined ? "尚未记录" : `LV${level} ${COURSE_MASTERY_LABELS[level]}`;
}

export function courseStCard(
  stId: string,
  externalCards?: Readonly<Partial<Record<string, CourseStCard>>>,
) {
  return externalCards?.[stId];
}

export function courseSectionHasStudyContent(section: CourseSection) {
  return section.items.some((item) => item.blocks.some((block) => (
    Boolean(block.text?.trim()) || Boolean(block.lines?.some((line) => line.text.trim()))
  )));
}
