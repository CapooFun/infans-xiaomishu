/**
 * 语言学习子看板的位置记忆。
 * 只保存稳定导航状态，不保存搜索词、正文、答案或学习结论。
 */

export const LANGUAGE_VIEW_MEMORY_KEY = "infans-language-view-memory-v1";

export type LanguageViewMemory = {
  version: 1;
  course?: {
    selection?: {
      book: "beginner" | "intermediate";
      lesson: number;
      st: number;
    };
    expandedBookId: string | null;
  };
  vocabulary?: { level: "N5" | "N4" | "N3" | "N2" | "N1" };
  grammar?: {
    branch: "syntax" | "particle" | "conjugation" | "honorific" | "pragmatics";
    level: "N5" | "N4" | "N3" | "N2";
    filter: "all" | "weak" | "review";
  };
  reading?: { category: "news" | "literature"; sitting: string };
  collection?: { kind: "all" | "cards" | "knowledge" | "corpus" | "phrase" | "word"; source: string };
};

type MemorySection = Exclude<keyof LanguageViewMemory, "version">;

const BOOKS = new Set(["beginner", "intermediate"]);
const VOCAB_LEVELS = new Set(["N5", "N4", "N3", "N2", "N1"]);
const GRAMMAR_LEVELS = new Set(["N5", "N4", "N3", "N2"]);
const GRAMMAR_BRANCHES = new Set(["syntax", "particle", "conjugation", "honorific", "pragmatics"]);
const GRAMMAR_FILTERS = new Set(["all", "weak", "review"]);
const READING_CATEGORIES = new Set(["news", "literature"]);
const COLLECTION_KINDS = new Set(["all", "cards", "knowledge", "corpus", "phrase", "word"]);

function cleanShortText(value: unknown, fallback: string, max = 120) {
  if (typeof value !== "string") return fallback;
  const next = value.trim();
  return next && next.length <= max ? next : fallback;
}

function cleanInteger(value: unknown, min: number, max: number, fallback: number) {
  const next = Number(value);
  return Number.isInteger(next) ? Math.max(min, Math.min(max, next)) : fallback;
}

export function parseLanguageViewMemory(raw: string | null): LanguageViewMemory {
  const empty: LanguageViewMemory = { version: 1 };
  if (!raw || raw.length > 8_192) return empty;
  try {
    const source = JSON.parse(raw) as Partial<LanguageViewMemory>;
    if (source.version !== 1) return empty;
    const next: LanguageViewMemory = { version: 1 };
    if (source.course) {
      const selection = source.course.selection && BOOKS.has(source.course.selection.book)
        ? {
            book: source.course.selection.book,
            lesson: cleanInteger(source.course.selection.lesson, 1, 15, 1),
            st: cleanInteger(source.course.selection.st, 1, 3, 1),
          }
        : undefined;
      next.course = {
        ...(selection ? { selection } : {}),
        expandedBookId: source.course.expandedBookId === null
          ? null
          : cleanShortText(source.course.expandedBookId, selection?.book || "beginner"),
      };
    }
    if (source.vocabulary && VOCAB_LEVELS.has(source.vocabulary.level)) {
      next.vocabulary = { level: source.vocabulary.level };
    }
    if (source.grammar
      && GRAMMAR_BRANCHES.has(source.grammar.branch)
      && GRAMMAR_LEVELS.has(source.grammar.level)
      && GRAMMAR_FILTERS.has(source.grammar.filter)) {
      next.grammar = {
        branch: source.grammar.branch,
        level: source.grammar.level,
        filter: source.grammar.filter,
      };
    }
    if (source.reading && READING_CATEGORIES.has(source.reading.category)) {
      next.reading = {
        category: source.reading.category,
        sitting: cleanShortText(source.reading.sitting, "全部", 32),
      };
    }
    if (source.collection && COLLECTION_KINDS.has(source.collection.kind)) {
      next.collection = {
        kind: source.collection.kind,
        source: cleanShortText(source.collection.source, "全部作品"),
      };
    }
    return next;
  } catch {
    return empty;
  }
}

export function readLanguageViewMemory(): LanguageViewMemory {
  if (typeof window === "undefined") return { version: 1 };
  try {
    return parseLanguageViewMemory(window.localStorage.getItem(LANGUAGE_VIEW_MEMORY_KEY));
  } catch {
    return { version: 1 };
  }
}

export function readLanguageViewPosition<K extends MemorySection>(section: K): LanguageViewMemory[K] {
  return readLanguageViewMemory()[section];
}

export function writeLanguageViewPosition<K extends MemorySection>(section: K, value: LanguageViewMemory[K]) {
  if (typeof window === "undefined") return;
  try {
    const next = parseLanguageViewMemory(JSON.stringify({ ...readLanguageViewMemory(), [section]: value }));
    window.localStorage.setItem(LANGUAGE_VIEW_MEMORY_KEY, JSON.stringify(next));
  } catch {
    /* 浏览器禁用存储时安静退化，不影响看板使用。 */
  }
}
