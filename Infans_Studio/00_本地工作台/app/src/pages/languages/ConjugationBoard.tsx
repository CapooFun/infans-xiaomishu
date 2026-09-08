import { useMemo, useState } from "react";
import { BookOpen, CircleAlert, Layers3, Route } from "lucide-react";
import type { JapaneseExploration } from "../../types";
import {
  cardsForPhase,
  type ConjugationCard,
  type ConjugationCardPhase,
} from "./conjugation-board-model";
import { ALL_LEVELS, lvLabel } from "./shared";
import "./conjugation-board.css";

const SOURCE_LABELS: Record<string, string> = {
  "日语变形Wiki.md": "日语变形 Wiki",
  "五段动词变形矩阵.md": "五段变形矩阵",
  "动词て形变形表.md": "て形课堂笔记",
  "动词变形.md": "语态与尾缀速查",
};

const PHASES: ReadonlyArray<{
  id: ConjugationCardPhase;
  label: string;
  note: string;
}> = [
  { id: "foundation", label: "基础变形", note: "组别与核心形" },
  { id: "functional", label: "条件与语态", note: "意向、条件、可能、被动与使役" },
  { id: "combination", label: "组合拆解", note: "长变形与接续家族" },
];

function sourceLabel(path: string) {
  const filename = path.split("/").at(-1) || path;
  return SOURCE_LABELS[filename] || filename.replace(/\.md$/, "");
}

type ConjugationMastery = {
  level: number;
  correctAverage: number;
  pointCount: number;
  progress: number;
};

export type GrammarOralProgress = {
  status?: "not-practiced" | "prompted" | "independent" | "stable";
  label?: string;
  note?: string;
  at?: string;
  recordIds?: string[];
};

function masteryLevel(correctTotal: number) {
  if (correctTotal >= 35) return 3;
  if (correctTotal >= 15) return 2;
  if (correctTotal >= 5) return 1;
  return 0;
}

function displayCorrectAverage(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function oralStatusLabel(progress: GrammarOralProgress | undefined) {
  if (!progress) return "未练习";
  if (progress.label?.trim()) return progress.label.trim();
  if (progress.status === "prompted") return "提示后可用";
  if (progress.status === "independent") return "可独立使用";
  if (progress.status === "stable") return "可稳定使用";
  return "未练习";
}

export function buildConjugationMasteryMap(exploration: JapaneseExploration | null | undefined) {
  const grammarProgress = new Map<string, number>();
  for (const level of ALL_LEVELS) {
    for (const group of exploration?.grammarDetail?.[level]?.groups || []) {
      for (const point of group.points) grammarProgress.set(point.id, point.correctTotal || 0);
    }
  }

  return (card: ConjugationCard): ConjugationMastery => {
    const correctAverage = card.masteryPointIds.length
      ? Math.round((card.masteryPointIds.reduce((sum, id) => sum + (grammarProgress.get(id) || 0), 0) / card.masteryPointIds.length) * 10) / 10
      : 0;
    const level = masteryLevel(correctAverage);
    return {
      level,
      correctAverage,
      pointCount: card.masteryPointIds.length,
      progress: Math.min(100, Math.round((correctAverage / 35) * 1000) / 10),
    };
  };
}

function MasteryBadge({ mastery, compact = false }: { mastery: ConjugationMastery; compact?: boolean }) {
  return <span className={`conjugation-mastery-badge lv-${mastery.level}${compact ? " is-compact" : ""}`}>
    {compact ? `Lv ${mastery.level}` : `等级 ${mastery.level} · ${lvLabel(mastery.level)}`}
  </span>;
}

function ConjugationDetail({
  card,
  mastery,
  oralProgress,
}: {
  card: ConjugationCard;
  mastery: ConjugationMastery;
  oralProgress?: GrammarOralProgress;
}) {
  return <article className="conjugation-detail" aria-labelledby="conjugation-detail-title">
    <header className="conjugation-detail__head">
      <div>
        <p>{card.japaneseTitle}</p>
        <h3 id="conjugation-detail-title">{card.title}</h3>
        <strong>{card.purpose}</strong>
      </div>
      <div className="conjugation-detail__route" aria-label={`${card.route[0]} 变成 ${card.route[1]}`}>
        <code>{card.route[0]}</code>
        <Route size={18}/>
        <code>{card.route[1]}</code>
      </div>
      <aside
        className="conjugation-detail__mastery"
        style={{ ["--mastery-progress" as string]: `${mastery.progress}%` }}
        aria-label={`${card.title}掌握度：等级 ${mastery.level}，${lvLabel(mastery.level)}`}
      >
        <MasteryBadge mastery={mastery}/>
        <strong>{displayCorrectAverage(mastery.correctAverage)}<small> / 35</small></strong>
        <p><b>题目表现</b>{mastery.pointCount === 1 ? "关联文法点累计答对" : `${mastery.pointCount} 个关联文法点平均答对`}</p>
        <i aria-hidden="true"><span/></i>
        <p><b>口语使用</b>{oralStatusLabel(oralProgress)}</p>
        {oralProgress?.note ? <small>{oralProgress.note}</small> : null}
      </aside>
    </header>

    <section className="conjugation-detail__use">
      <h4>什么时候用</h4>
      <p>{card.whenToUse}</p>
    </section>

    <div className="conjugation-detail__columns">
      <section>
        <h4>变形步骤</h4>
        <ol>{card.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      </section>
      <section>
        <h4><Layers3 size={14}/>组别与例外</h4>
        <ul>{card.groupRules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
      </section>
    </div>

    <div className="conjugation-detail__columns">
      <section>
        <h4>例句</h4>
        <div className="conjugation-detail__examples">
          {card.examples.map((example) => <p key={example.japanese}>
            <b lang="ja">{example.japanese}</b>
            <small>{example.chinese}</small>
          </p>)}
        </div>
      </section>
      <section className="conjugation-detail__warning">
        <h4><CircleAlert size={14}/>容易错</h4>
        <ul>{card.pitfalls.map((pitfall) => <li key={pitfall}>{pitfall}</li>)}</ul>
      </section>
    </div>

    <footer className="conjugation-detail__sources">
      <span>内容来源</span>
      <nav aria-label={`${card.title}内容来源`}>
        {card.sources.map((path) => <span key={path}>{sourceLabel(path)}</span>) }
      </nav>
    </footer>
  </article>;
}

export function ConjugationBoard({
  exploration,
  oralProgress = {},
}: {
  exploration: JapaneseExploration | null | undefined;
  oralProgress?: Record<string, GrammarOralProgress>;
}) {
  const [phase, setPhase] = useState<ConjugationCardPhase>("foundation");
  const [selectedCardId, setSelectedCardId] = useState("dictionary");
  const masteryForCard = useMemo(() => buildConjugationMasteryMap(exploration), [exploration]);
  const cards = cardsForPhase(phase);
  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? cards[0];
  const selectedMastery = masteryForCard(selectedCard);
  const selectedPhase = PHASES.find((item) => item.id === phase) ?? PHASES[0];

  const selectPhase = (nextPhase: ConjugationCardPhase) => {
    const nextCards = cardsForPhase(nextPhase);
    setPhase(nextPhase);
    setSelectedCardId(nextCards[0]?.id || "");
  };

  return <section className="conjugation-board" aria-labelledby="conjugation-board-title">
    <header className="conjugation-board__toolbar">
      <div>
        <p><BookOpen size={15}/> 变形辞典</p>
        <h2 id="conjugation-board-title">变形知识与掌握情况</h2>
        <small>{selectedPhase.note} · 共 {cards.length} 项</small>
      </div>
      <div className="conjugation-board__phase-tabs" role="tablist" aria-label="变形分类">
        {PHASES.map((item) => <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={phase === item.id}
          className={phase === item.id ? "is-active" : ""}
          onClick={() => selectPhase(item.id)}
        >
          <strong>{item.label}</strong>
          <small>{cardsForPhase(item.id).length}</small>
        </button>)}
      </div>
    </header>

    <div className="conjugation-board__workspace">
      <aside className="conjugation-board__index" aria-label={`${selectedPhase.label}目录`}>
        <header>
          <span>{selectedPhase.label}</span>
          <small>{selectedPhase.note}</small>
        </header>
        <nav>
          {cards.map((card, index) => <button
            key={card.id}
            type="button"
            aria-pressed={selectedCard.id === card.id}
            className={selectedCard.id === card.id ? "is-selected" : ""}
            onClick={() => setSelectedCardId(card.id)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{card.title}</strong>
              <small>{card.japaneseTitle}</small>
            </div>
            <MasteryBadge mastery={masteryForCard(card)} compact/>
          </button>)}
        </nav>
      </aside>

      <ConjugationDetail card={selectedCard} mastery={selectedMastery} oralProgress={oralProgress[selectedCard.id]}/>
    </div>
  </section>;
}
