import { useEffect, useState } from "react";
import { PageTrail } from "../../shell/PageNavigation";
import { BookMarked, BookOpen, Compass, ExternalLink, GraduationCap, Map as MapIcon, MessagesSquare } from "lucide-react";
import type {
  JapaneseExamKind,
  JapaneseExamPaper,
  JapaneseExamResult,
  JapaneseLevelProgress,
  LanguagesSectionData,
} from "../../types";
import { Card, Empty, jsonFetch } from "../../page-shared";
import { ExamStage } from "./ExamStage";
import { ExplorationMatrix } from "./ExplorationMatrix";
import { GrammarBoard } from "./GrammarBoard";
import { LanguageReactorLibrary } from "./LanguageReactorLibrary";
import { ReadingBoard } from "./ReadingBoard";
import { CourseBoard } from "./CourseBoard";
import type { CourseSelection, CourseStCard } from "./course-board-model";
import { readLanguageViewPosition, writeLanguageViewPosition } from "./language-view-memory";
import {
  ANKIWEB_DECKS_URL,
  type ExamScope,
  type HubSection,
  type JapaneseExamBootstrap,
  modeLabel,
  modeSeed,
} from "./shared";

export type { JapaneseExamBootstrap } from "./shared";

const HUB_SECTIONS: HubSection[] = ["exploration", "course", "vocabulary", "grammar", "reading", "collection"];
const ANKI_DECK_ROOT = "JLPT::示例词汇";
const ANKI_LEVELS = ["N5", "N4", "N3", "N2", "N1"] as const;
type AnkiLevel = typeof ANKI_LEVELS[number];

function ankiDeckLevel(name: string): AnkiLevel {
  return (name.match(/N[1-5]/)?.[0] as AnkiLevel | undefined) || "N2";
}

function legacyAnkiDeckLabel(name: string) {
  const labels: Record<string, string> = {
    N5: "1-N5",
    N4: "2-N4",
    "N3 高频": "3-N3::1-高频",
    "N3 中频": "3-N3::2-中频",
    "N3 低频": "3-N3::3-低频",
    "N2 高频": "4-N2::1-高频",
    "N2 中频": "4-N2::2-中频",
    "N2 低频": "4-N2::3-低频",
    "N1 全部": "5-N1",
    N1: "5-N1",
  };
  return labels[name] || name;
}

type AnkiDeckSegment = JapaneseLevelProgress & { label: string; deck: string };
type AnkiDeckGroup = {
  root: string;
  label: string;
  levels: Array<{ level: AnkiLevel; segments: AnkiDeckSegment[] }>;
};

function ankiDeckDescriptor(item: JapaneseLevelProgress) {
  const deck = item.deck || `${ANKI_DECK_ROOT}::${legacyAnkiDeckLabel(item.name)}`;
  const parts = deck.split("::").filter(Boolean);
  const levelIndex = parts.findIndex((part) => /^(?:\d+-)?N[1-5]$/.test(part));
  const level = ankiDeckLevel(levelIndex >= 0 ? parts[levelIndex] : item.name);
  const rootParts = levelIndex > 0 ? parts.slice(0, levelIndex) : ANKI_DECK_ROOT.split("::");
  const segmentParts = levelIndex >= 0 ? parts.slice(levelIndex + 1) : [];
  return {
    deck,
    level,
    root: rootParts.join("::") || ANKI_DECK_ROOT,
    segmentLabel: segmentParts.map((part) => part.replace(/^\d+-/, "")).join(" / ") || "全部",
  };
}

function buildAnkiDeckGroups(levels: JapaneseLevelProgress[]): AnkiDeckGroup[] {
  const roots = new Map<string, Map<AnkiLevel, AnkiDeckSegment[]>>();
  for (const item of levels) {
    const descriptor = ankiDeckDescriptor(item);
    const byLevel = roots.get(descriptor.root) || new Map<AnkiLevel, AnkiDeckSegment[]>();
    const segments = byLevel.get(descriptor.level) || [];
    segments.push({ ...item, label: descriptor.segmentLabel, deck: descriptor.deck });
    byLevel.set(descriptor.level, segments);
    roots.set(descriptor.root, byLevel);
  }
  return [...roots.entries()].map(([root, byLevel]) => ({
    root,
    label: root.split("::").at(-1) || root,
    levels: ANKI_LEVELS.map((level) => ({ level, segments: byLevel.get(level) || [] })),
  }));
}

async function loadCourseStCard(selection: CourseSelection) {
  const params = new URLSearchParams({
    book: selection.book,
    lesson: String(selection.lesson),
    st: String(selection.st),
  });
  const body = await jsonFetch<{ data: CourseStCard | null }>(`/api/languages/course-card?${params}`);
  return body.data ?? undefined;
}

function readSectionQuery(): HubSection {
  const value = new URLSearchParams(window.location.search).get("section");
  if (value === "conjugation") return "grammar";
  return HUB_SECTIONS.includes(value as HubSection) ? (value as HubSection) : "course";
}

function writeSectionQuery(section: HubSection) {
  const url = new URL(window.location.href);
  if (section === "course") url.searchParams.delete("section");
  else url.searchParams.set("section", section);
  if (section !== "grammar") url.searchParams.delete("branch");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function LanguagesPage({
  data,
  onLanguageReactorImport,
  onOpenExamAi,
  onSectionRefresh,
}: {
  data: LanguagesSectionData;
  onLanguageReactorImport: (file: File) => void;
  onOpenExamAi?: (bootstrap: JapaneseExamBootstrap) => void;
  onSectionRefresh?: () => void;
}) {
  const [section, setSectionState] = useState<HubSection>(readSectionQuery);
  const setSection = (next: HubSection) => {
    setSectionState(next);
    writeSectionQuery(next);
  };
  const [coursePosition, setCoursePosition] = useState(() => readLanguageViewPosition("course"));
  const [anki, setAnki] = useState<{ available: boolean; live: boolean; reviewedToday?: number; message: string } | null>(null);
  const [examOpen, setExamOpen] = useState(false);
  const [suggested, setSuggested] = useState<ExamScope>({
    kind: "special",
    level: "N2",
    track: "grammar",
    label: "N2 专项练习",
    mode: "special",
  });
  const [paper, setPaper] = useState<JapaneseExamPaper | null>(null);
  const [result, setResult] = useState<JapaneseExamResult | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [examLoading, setExamLoading] = useState(false);
  const [examError, setExamError] = useState("");
  const [questionIndex, setQuestionIndex] = useState(0);
  const exploration = data.exploration;

  useEffect(() => { jsonFetch<typeof anki>("/api/anki").then(setAnki).catch(() => setAnki({ available: false, live: false, message: "连不上 Anki（背单词软件）。" })); }, []);

  useEffect(() => {
    const onPop = () => setSectionState(readSectionQuery());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("exam-session", examOpen);
    return () => document.documentElement.classList.remove("exam-session");
  }, [examOpen]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("section") !== "conjugation") return;
    url.searchParams.set("section", "grammar");
    url.searchParams.set("branch", "conjugation");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const resetExamSurface = () => {
    setPaper(null);
    setResult(null);
    setAnswers({});
    setQuestionIndex(0);
    setExamError("");
  };

  const startExamDirect = async (payload: Record<string, unknown>, seedAssistant?: string) => {
    setExamLoading(true);
    setExamError("");
    try {
      const body = await jsonFetch<{ data: JapaneseExamPaper }>("/api/languages/exam/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setExamOpen(true);
      resetExamSurface();
      setSuggested({
        kind: (body.data.kind || "special") as JapaneseExamKind,
        level: body.data.level,
        track: body.data.track,
        label: body.data.label,
        mode: body.data.kind || "special",
        pointIds: (payload.pointIds as string[]) || undefined,
      });
      setPaper(body.data);
      setAnswers({});
      setQuestionIndex(0);
      onOpenExamAi?.({
        mode: "japaneseExam",
        suggestedScope: { level: body.data.level, track: body.data.track, label: body.data.label },
        examSessionId: body.data.sessionId,
        seedAssistant: seedAssistant || `已出题：${body.data.label}。卡住可以问我。`,
      });
    } catch (error) {
      setExamError(error instanceof Error ? error.message : "出题失败");
    } finally {
      setExamLoading(false);
    }
  };

  const openExamMode = (kind: JapaneseExamKind, level = "N2", pointIds?: string[]) => {
    if (kind === "special" && pointIds?.length) {
      setSection("grammar");
      void startExamDirect(
        { kind: "special", level, pointIds, context: { kind: "special", level } },
        `专项待练清单已出题（${pointIds.length} 卡）。`,
      );
      return;
    }
    const label = `${level} ${modeLabel(kind)}`;
    setSection("exploration");
    setExamOpen(true);
    resetExamSurface();
    setSuggested({
      kind,
      level,
      track: kind === "special" ? "grammar" : kind,
      label,
      mode: kind,
      pointIds,
    });
    onOpenExamAi?.({
      mode: "japaneseExam",
      suggestedScope: { level, track: kind, label },
      seedAssistant: modeSeed(kind, level),
    });
  };

  const confirmAndStart = async () => {
    setExamLoading(true);
    setExamError("");
    try {
      const body = await jsonFetch<{ data: JapaneseExamPaper }>("/api/languages/exam/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: suggested.kind,
          level: suggested.level,
          track: suggested.track,
          pointIds: suggested.pointIds,
          passageId: suggested.passageId,
          context: { level: suggested.level, kind: suggested.kind },
        }),
      });
      setPaper(body.data);
      setAnswers({});
      setQuestionIndex(0);
      onOpenExamAi?.({
        mode: "japaneseExam",
        suggestedScope: { level: body.data.level, track: body.data.track, label: body.data.label },
        examSessionId: body.data.sessionId,
        seedAssistant: `范围已确认：${body.data.label}。中间试卷台已出题，卡住可以问我；交卷后我帮你看评语。${body.data.notes?.length ? `（${body.data.notes.join("；")}）` : ""}`,
      });
    } catch (error) {
      setExamError(error instanceof Error ? error.message : "出题失败");
    } finally {
      setExamLoading(false);
    }
  };

  const submitExam = async () => {
    if (!paper?.sessionId) return;
    setExamLoading(true);
    setExamError("");
    try {
      const body = await jsonFetch<{ data: JapaneseExamResult }>("/api/languages/exam/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: paper.sessionId, answers, write: true }),
      });
      setResult(body.data);
      onSectionRefresh?.();
      onOpenExamAi?.({
        mode: "japaneseExam",
        suggestedScope: { level: body.data.level, track: body.data.track, label: body.data.label },
        examSessionId: body.data.sessionId,
        seedUser: `我交卷了：${body.data.correct}/${body.data.total}。请简短评一下弱项，并问我要不要再来一份。`,
      });
    } catch (error) {
      setExamError(error instanceof Error ? error.message : "交卷失败");
    } finally {
      setExamLoading(false);
    }
  };

  const sections = [
    { id: "exploration" as const, label: "探索成就", icon: Compass },
    { id: "course" as const, label: "课程", icon: MessagesSquare },
    { id: "vocabulary" as const, label: "单词", icon: GraduationCap },
    { id: "grammar" as const, label: "文法", icon: BookOpen },
    { id: "reading" as const, label: "阅读", icon: MapIcon },
    { id: "collection" as const, label: "收藏", icon: BookMarked },
  ];

  return <div className={`language-hub${examOpen ? " exam-mode" : ""}`}>
    <PageTrail items={[{ label: sections.find((item) => item.id === section)!.label, siblings: sections.filter((item) => item.id !== section).map((item) => ({ label: item.label, href: `/languages?section=${item.id}`, history: "replace" as const, onSelect: () => setSection(item.id) })) }]} />
    <nav className="language-primary-tabs language-primary-tabs-6" aria-label="语言学习板块">{sections.map((item) => { const Icon = item.icon; return <button type="button" aria-pressed={section === item.id} className={section === item.id ? "active" : ""} key={item.id} onClick={() => setSection(item.id)}><Icon size={18}/><div><strong>{item.label}</strong></div></button>; })}</nav>

    {examOpen ? (
      <ExamStage
        suggested={suggested}
        paper={paper}
        result={result}
        answers={answers}
        loading={examLoading}
        error={examError}
        index={questionIndex}
        setIndex={setQuestionIndex}
        onClose={() => setExamOpen(false)}
        onConfirm={() => { void confirmAndStart(); }}
        onPickKind={(kind) => {
          setSuggested((current) => ({
            ...current,
            kind,
            mode: kind,
            label: `${current.level} ${modeLabel(kind)}`,
            pointIds: kind === "special" ? current.pointIds : undefined,
          }));
        }}
        onPickLevel={(level) => {
          setSuggested((current) => ({
            ...current,
            level,
            label: `${level} ${modeLabel(current.kind)}`,
          }));
        }}
        onAnswer={(id, value) => setAnswers((current) => ({ ...current, [id]: value }))}
        onSubmit={() => { void submitExam(); }}
      />
    ) : null}

    {!examOpen && section === "course" ? (
      <CourseBoard
        suggestedSt={1}
        progress={exploration?.courseProgress}
        loadStCard={loadCourseStCard}
        currentPosition={coursePosition?.selection}
        initialExpandedBookId={coursePosition?.expandedBookId}
        onSelectionChange={(selection) => {
          const next = {
            selection: { book: selection.book, lesson: selection.lesson, st: selection.st },
            expandedBookId: coursePosition?.expandedBookId ?? selection.book,
          };
          setCoursePosition(next);
          writeLanguageViewPosition("course", next);
        }}
        onExpandedBookChange={(expandedBookId) => {
          const next = { ...coursePosition, expandedBookId };
          setCoursePosition(next);
          writeLanguageViewPosition("course", next);
        }}
      />
    ) : null}

    {!examOpen && section === "exploration" && exploration ? (
      <ExplorationMatrix exploration={exploration} />
    ) : null}
    {!examOpen && section === "exploration" && !exploration ? <Empty>探索成就数据还没准备好。</Empty> : null}

    {!examOpen && section === "vocabulary" ? (() => {
      const hasProgress = Boolean(data.progress?.total);
      const learned = data.progress?.learned ?? null;
      const total = data.progress?.total ?? null;
      const percent = hasProgress && learned != null && total != null ? Math.round((learned / total) * 1000) / 10 : null;
      const deckGroups = buildAnkiDeckGroups(data.levels);
      return <div className="language-layout vocabulary-view">
        <Card className="language-hero language-hero-fade vocabulary-hero">
          <div className="language-hero-copy">
            <span className="language-section-kicker">ANKI 词汇</span>
            <h2>Anki 词汇进度</h2>
            <p className="vocabulary-stage">{data.stage}</p>
            <div className="language-hero-grid">
              <div className="language-hero-main">
                <strong>{percent == null ? "未同步" : `${percent}%`}</strong>
                <span>{learned == null || total == null ? "计划进度还没有可用数据" : `计划进度 · ${learned} / ${total}`}</span>
              </div>
              <div className="language-hero-side language-hero-side-4">
                <div><strong>{data.streak ?? "—"}</strong><span>连续学习</span></div>
                <div><strong>{data.pace7 ?? "—"}</strong><span>7 日日均新卡</span></div>
                <div><strong>{data.pace14 ?? "—"}</strong><span>14 日日均新卡</span></div>
                <div><strong>{data.queue ?? "—"}</strong><span>今天要复习</span></div>
              </div>
            </div>
            <div className="progress-rail" aria-label="词汇计划进度">
              <div className="progress-rail-meta"><span>Anki 计划</span><em>{percent == null ? "未同步" : `${percent}%`}</em></div>
              <div className="progress-rail-track"><i style={{ width: `${Math.min(100, percent ?? 0)}%` }}/></div>
            </div>
            <div className="language-hero-actions">
              <div className={`live-badge ${anki?.live ? "online" : ""}`}><i />{anki ? anki.live ? `Anki 已连上 · 今日已答 ${anki.reviewedToday ?? 0}` : "显示上次同步的数据" : "检测 Anki…"}</div>
              {anki?.message ? <span className="language-hero-aside">{anki.message}</span> : null}
              <a className="exam-chip primary" href={ANKIWEB_DECKS_URL} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14}/>免费打开 AnkiWeb 背词
              </a>
            </div>
          </div>
        </Card>
        <Card className="level-ladder anki-deck-board">
          <div className="card-title"><div><h2>Anki 牌组</h2><p>每个主牌组独立成组，N 级卡片内显示实际子牌组进度。</p></div></div>
          <div className="anki-deck-groups">{deckGroups.map((group) => <section className="anki-deck-group" key={group.root}>
            <header className="anki-deck-group-heading">
              <div><span>主牌组</span><h3>{group.label}</h3></div>
              <code title={group.root}>{group.root}</code>
            </header>
            <div className="anki-level-card-grid">{group.levels.map(({ level, segments }) => {
              const learned = segments.reduce((sum, item) => sum + item.learned, 0);
              const total = segments.reduce((sum, item) => sum + item.total, 0);
              const levelPercent = total ? learned / total * 100 : 0;
              return <article className={`anki-level-card ${levelPercent === 100 && total ? "complete" : levelPercent > 0 ? "active" : ""}`} key={level}>
                <header><div><span>JLPT</span><strong>{level}</strong></div><small>{segments.length ? `${learned} / ${total}` : "尚未接入"}</small></header>
                <div className="anki-segment-list">{segments.length ? segments.map((segment) => {
                  const segmentPercent = segment.total ? segment.learned / segment.total * 100 : 0;
                  return <div className={`anki-segment ${segmentPercent >= 100 ? "complete" : segmentPercent > 0 ? "active" : ""}`} key={segment.deck} title={segment.deck}>
                    <div className="anki-segment-meta"><strong>{segment.label}</strong><span>{segment.learned} / {segment.total}</span></div>
                    <div className="level-track"><i style={{ width: `${Math.min(100, segmentPercent)}%` }}/></div>
                    <footer><span>{segmentPercent.toFixed(1)}%</span><small>{segment.status}</small></footer>
                  </div>;
                }) : <p className="anki-level-empty">这个牌组暂时没有同步到 {level} 子牌组。</p>}</div>
              </article>;
            })}</div>
          </section>)}</div>
        </Card>
      </div>;
    })() : null}
    {!examOpen && section === "grammar" ? (
      <GrammarBoard
        levels={data.grammar}
        exploration={exploration}
        onStartSpecial={(level, pointIds) => openExamMode("special", level, pointIds)}
      />
    ) : null}
    {!examOpen && section === "reading" ? (
      <ReadingBoard exploration={exploration} />
    ) : null}
    {!examOpen && section === "collection" ? <LanguageReactorLibrary meta={data.languageReactor} onImport={onLanguageReactorImport}/> : null}
  </div>;
}
