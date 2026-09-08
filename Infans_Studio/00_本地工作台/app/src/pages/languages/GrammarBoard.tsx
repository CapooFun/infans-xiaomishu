import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { GrammarGroup, GrammarLevel, GrammarPoint, JapaneseExploration } from "../../types";
import { Card, Empty, Kicker, jsonFetch } from "../../page-shared";
import { ConjugationBoard, type GrammarOralProgress } from "./ConjugationBoard";
import { CONJUGATION_CARDS } from "./conjugation-board-model";
import { ALL_LEVELS, lvLabel } from "./shared";
import { readLanguageViewPosition, writeLanguageViewPosition } from "./language-view-memory";
import "./grammar-board.css";

type GrammarBranch = "syntax" | "particle" | "conjugation" | "honorific" | "pragmatics";
type GrammarFilter = "all" | "weak" | "review";

type GrammarBoardProps = {
  levels: GrammarLevel[];
  exploration: JapaneseExploration | null | undefined;
  oralProgress?: Record<string, GrammarOralProgress>;
  /** 旧页面仍可能传入这些参数；文法看板不再消费它们。 */
  cart?: string[];
  onToggleCart?: (id: string) => void;
  onSetCart?: (ids: string[]) => void;
  onStartSpecial?: (level: string, pointIds: string[]) => void;
};

const BRANCHES: ReadonlyArray<{ id: GrammarBranch; label: string }> = [
  { id: "syntax", label: "句型" },
  { id: "particle", label: "助词" },
  { id: "conjugation", label: "变形" },
  { id: "honorific", label: "敬语" },
  { id: "pragmatics", label: "表达" },
];

const FILTERS: ReadonlyArray<{ id: GrammarFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "weak", label: "薄弱" },
  { id: "review", label: "待复习" },
];

function initialGrammarBranch(): GrammarBranch {
  const params = new URLSearchParams(window.location.search);
  if (params.get("section") === "conjugation" || params.get("branch") === "conjugation") return "conjugation";
  if (params.get("branch") === "particle") return "particle";
  if (params.get("branch") === "honorific") return "honorific";
  if (params.get("branch") === "pragmatics") return "pragmatics";
  return readLanguageViewPosition("grammar")?.branch || "syntax";
}

const PURE_CONJUGATION_POINT_IDS = new Set([
  "N5-30", "N5-33", "N5-38", "N5-40", "N5-42",
  "N4-01", "N4-02", "N4-04", "N4-05", "N4-06",
  "N3-54", "N3-55", "N3-56",
]);

const GROUP_BRANCH_BY_TITLE: Readonly<Record<string, GrammarBranch>> = {
  "判断与基本句型（です）": "syntax",
  "助词（基础格助词）": "particle",
  "指示词・疑问词": "syntax",
  "形容词": "syntax",
  "动词：基础活用与句型": "syntax",
  "时间・顺序": "syntax",
  "希望・愿望": "pragmatics",
  "比较・程度・存在": "syntax",
  "其他基础句型": "syntax",
  "动词新活用形": "conjugation",
  "て形派生句型": "syntax",
  "授受表达": "pragmatics",
  "条件・假定": "syntax",
  "原因・目的・逆接": "syntax",
  "推量・伝闻・样态": "pragmatics",
  "变化・决定": "syntax",
  "能力・状态・难易": "syntax",
  "必要・义务・许可・建议": "pragmatics",
  "时间关系": "syntax",
  "引用・名词化": "syntax",
  "复合动词・接尾辞": "syntax",
  "让步・其他高频": "syntax",
  "敬语": "honorific",
  "助词辨析（中文母语者高频错点）": "particle",
  "原因・理由": "syntax",
  "逆接・対比": "syntax",
  "条件・仮定": "syntax",
  "目的": "syntax",
  "推量・判断": "pragmatics",
  "伝闻・样态・比况": "pragmatics",
  "变化・状态": "syntax",
  "授受・受身・使役": "pragmatics",
  "程度・比较・限定": "syntax",
  "评价・主张・心情": "pragmatics",
  "列举・添加": "syntax",
  "关连・对象・基准": "syntax",
  "补充高频接尾・句型": "syntax",
  "时间・先后・同时": "syntax",
  "原因・理由・前提": "syntax",
  "逆接・対比・让步": "syntax",
  "程度・比较・极限": "syntax",
  "范围・关连・対象・基准": "syntax",
  "并列・添加・列举": "syntax",
  "可能・难易・无法": "syntax",
  "义务・必然・取舍": "pragmatics",
  "感情・语气・主张": "pragmatics",
  "无关・除外": "syntax",
  "目的・原因・结果・前后关系": "syntax",
  "接尾辞・状态": "syntax",
  "惯用・连接文型": "syntax",
};

function groupsForBranch(level: GrammarLevel | undefined, branch: Exclude<GrammarBranch, "conjugation">): GrammarGroup[] {
  return (level?.groups ?? []).flatMap((group) => {
    if (GROUP_BRANCH_BY_TITLE[group.title] !== branch) return [];
    const points = group.points.filter((point) => !PURE_CONJUGATION_POINT_IDS.has(point.id));
    return points.length ? [{ ...group, points }] : [];
  });
}

function levelBranchStats(level: GrammarLevel, branch: Exclude<GrammarBranch, "conjugation">) {
  const groups = groupsForBranch(level, branch);
  return { total: groups.reduce((count, group) => count + group.points.length, 0), groupTotal: groups.length };
}

function tokyoToday() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isReviewDue(review: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(review) && review <= tokyoToday();
}

function oralStatusLabel(progress: GrammarOralProgress | undefined) {
  if (!progress) return "未练习";
  if (progress.label?.trim()) return progress.label.trim();
  if (progress.status === "prompted") return "提示后可用";
  if (progress.status === "independent") return "可独立使用";
  if (progress.status === "stable") return "可稳定使用";
  return "未练习";
}

function pointOralProgress(point: GrammarPoint): GrammarOralProgress | undefined {
  if (!point.oral || point.oral.status === "not-practiced") return undefined;
  return {
    status: point.oral.status,
    label: point.oral.label,
    note: [point.oral.note, point.oral.nextReview ? `下次复习：${point.oral.nextReview}` : ""].filter(Boolean).join("；"),
  };
}

function GrammarCard({
  point,
  lv,
  correctTotal = 0,
  oralProgress,
}: {
  point: GrammarPoint;
  lv?: number;
  correctTotal?: number;
  oralProgress?: GrammarOralProgress;
}) {
  const [open, setOpen] = useState(false);
  const stage = Math.max(0, Math.min(3, lv || 0));
  const progress = Math.min(100, Math.round((Math.max(0, correctTotal) / 35) * 1000) / 10);
  const questionLabel = correctTotal > 0
    ? `等级 ${stage} · ${lvLabel(stage)} · 累计答对 ${correctTotal}`
    : "未做题";
  return (
    <details
      className={`grammar-card lv-${stage}`}
      style={{ ["--lv-progress" as string]: `${progress}%` }}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <div>
          <span>{point.id}</span>
          <small className={`lv-badge lv-${stage}`}>等级 {stage} · {lvLabel(stage)}</small>
        </div>
        <strong>{point.title}</strong>
        <div className="grammar-card-guide">
          <p><span>接续</span><b>{point.connection || "资料待补"}</b></p>
          <p><span>含义</span><b>{point.meaning || "资料待补"}</b></p>
          <p><span>例句</span><b lang="ja">{point.examples[0] || "资料待补"}</b></p>
        </div>
        <div className="grammar-card-evidence" aria-label={`${point.title}学习进度`}>
          <p><span>题目表现</span><strong>{questionLabel}</strong></p>
          <p><span>口语使用</span><strong>{oralStatusLabel(oralProgress)}</strong></p>
        </div>
        <footer>
          <span>{point.review === "—" ? "未安排复习" : `${isReviewDue(point.review) ? "待复习" : "复习"} ${point.review}`}</span>
          <ChevronRight size={14}/>
        </footer>
      </summary>
      {open ? (
        <div className="grammar-card-body">
          {point.examples.slice(1).map((example) => <p key={example}><b>例句</b><span>{example}</span></p>)}
          {point.distinctions.map((distinction) => <p className="contrast" key={distinction}><b>辨析</b><span>{distinction}</span></p>)}
          {point.notes.map((note) => <p key={note}><b>备注</b><span>{note}</span></p>)}
          {oralProgress?.note ? <p className="grammar-card-oral-note"><b>口语记录</b><span>{oralProgress.note}</span></p> : null}
        </div>
      ) : null}
    </details>
  );
}

export function GrammarBoard({ levels, exploration, oralProgress = {} }: GrammarBoardProps) {
  const rememberedPosition = readLanguageViewPosition("grammar");
  const [branch, setBranch] = useState<GrammarBranch>(initialGrammarBranch);
  const [selected, setSelected] = useState<GrammarLevel["level"]>(rememberedPosition?.level || "N2");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<GrammarFilter>(rememberedPosition?.filter || "all");
  const [detail, setDetail] = useState<GrammarLevel | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const summary = levels.find((item) => item.level === selected) ?? levels[0];
  const active = detail?.level === selected ? detail : summary;
  const progressMap = useMemo(() => {
    const map = new Map<string, { lv: number; correctTotal: number }>();
    for (const level of ALL_LEVELS) {
      const groups = exploration?.grammarDetail?.[level]?.groups || [];
      for (const group of groups) {
        for (const point of group.points) {
          map.set(point.id, { lv: point.lv || 0, correctTotal: point.correctTotal || 0 });
        }
      }
    }
    return map;
  }, [exploration]);
  const resolvedOralProgress = useMemo(() => {
    const next: Record<string, GrammarOralProgress> = {};
    const oralLevels = detail
      ? [...levels.filter((level) => level.level !== detail.level), detail]
      : levels;
    for (const level of oralLevels) {
      for (const group of level.groups || []) {
        for (const point of group.points) {
          const progress = pointOralProgress(point);
          if (progress) next[point.id] = progress;
        }
      }
    }
    return { ...next, ...oralProgress };
  }, [detail, levels, oralProgress]);
  const conjugationOralProgress = useMemo(() => {
    const next: Record<string, GrammarOralProgress> = {};
    for (const card of CONJUGATION_CARDS) {
      const matched = card.masteryPointIds.map((id) => resolvedOralProgress[id]).find(Boolean);
      if (matched) next[card.id] = matched;
    }
    return next;
  }, [resolvedOralProgress]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoadingDetail(true);
    jsonFetch<{ data: GrammarLevel }>(`/api/languages/grammar?level=${selected}`)
      .then((body) => { if (!cancelled) setDetail(body.data); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [selected]);

  const selectBranch = (next: GrammarBranch) => {
    setBranch(next);
    const url = new URL(window.location.href);
    if (next === "syntax") url.searchParams.delete("branch");
    else url.searchParams.set("branch", next);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    setQuery("");
    setFilter("all");
    writeLanguageViewPosition("grammar", { branch: next, level: selected, filter: "all" });
  };

  const normalizedQuery = query.trim().toLocaleLowerCase("ja");
  const branchGroups = useMemo(
    () => branch === "conjugation" ? [] : groupsForBranch(active, branch),
    [active, branch],
  );
  const branchPointCount = branchGroups.reduce((count, group) => count + group.points.length, 0);
  const groups = useMemo(() => branchGroups.map((group) => ({
    ...group,
    points: group.points.filter((point) => {
      const progress = progressMap.get(point.id);
      const matchesQuery = `${point.id} ${point.title} ${point.connection} ${point.meaning} ${point.examples.join(" ")}`
        .toLocaleLowerCase("ja")
        .includes(normalizedQuery);
      if (!matchesQuery) return false;
      if (filter === "weak") return Boolean(progress?.correctTotal) && (progress?.lv || 0) <= 1;
      if (filter === "review") return isReviewDue(point.review);
      return true;
    }),
  })).filter((group) => group.points.length), [branchGroups, filter, normalizedQuery, progressMap]);
  const visibleCount = groups.reduce((count, group) => count + group.points.length, 0);

  if (!active) return <Empty>暂时读不到文法卡片。</Empty>;
  return <div className="grammar-dashboard">
    <Card className="grammar-dashboard-nav">
      <div className="grammar-branch-tabs" role="tablist" aria-label="文法分支">
        {BRANCHES.map((item) => <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={branch === item.id}
          className={branch === item.id ? "is-active" : ""}
          onClick={() => selectBranch(item.id)}
        >
          <strong>{item.label}</strong>
        </button>)}
      </div>
    </Card>

    {branch === "conjugation" ? <ConjugationBoard exploration={exploration} oralProgress={conjugationOralProgress}/> : <>
      <div className="grammar-levels">{levels.map((level) => {
        const stats = levelBranchStats(level, branch);
        return <button
          type="button"
          className={selected === level.level ? "active" : ""}
          key={level.level}
          onClick={() => {
            setSelected(level.level);
            setQuery("");
            setFilter("all");
            writeLanguageViewPosition("grammar", { branch, level: level.level, filter: "all" });
          }}
        >
          <span>{level.level}</span>
          <strong>{stats.total}</strong>
          <small>{stats.groupTotal} 组 · {exploration?.levels.find((row) => row.level === level.level)?.grammar.stageLabel || "暂无表现"}</small>
        </button>;
      })}</div>

      <Card className="grammar-browser grammar-dashboard-browser">
        <div className="grammar-browser-head">
          <div>
            <Kicker>{BRANCHES.find((item) => item.id === branch)?.label}</Kicker>
            <h2>{active.level} 卡片</h2>
            {loadingDetail ? <p>正在载入明细…</p> : null}
          </div>
          <div className="grammar-dashboard-tools">
            <div className="grammar-filter-tabs" aria-label="文法进度筛选">
              {FILTERS.map((item) => <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                className={filter === item.id ? "is-active" : ""}
                onClick={() => {
                  setFilter(item.id);
                  writeLanguageViewPosition("grammar", { branch, level: selected, filter: item.id });
                }}
              >{item.label}</button>)}
            </div>
            <div className="grammar-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索名称、接续、含义、例句" placeholder="搜索名称、接续、含义、例句…"/><span>{visibleCount} / {branchPointCount}</span></div>
          </div>
        </div>
        <div className="grammar-groups">{groups.map((group) => <section className="grammar-group" key={group.id}>
          <header><div><span>{active.level}</span><h3>{group.title}</h3><small>{group.points.length} 张</small></div>{group.note ? <p>{group.note}</p> : null}</header>
          <div className="grammar-row">{group.points.map((point) => {
            const progress = progressMap.get(point.id);
            return <GrammarCard
              key={point.id}
              point={point}
              lv={progress?.lv || 0}
              correctTotal={progress?.correctTotal || 0}
              oralProgress={resolvedOralProgress[point.id]}
            />;
          })}</div>
        </section>)}</div>
        {!groups.length ? <Empty>{filter === "weak" ? "目前暂无做错或标记薄弱的文法。" : filter === "review" ? "当前没有到期复习项。" : `${active.level} 的“${BRANCHES.find((item) => item.id === branch)?.label}”分组暂无已收录文法。`}</Empty> : null}
      </Card>
    </>}
  </div>;
}
