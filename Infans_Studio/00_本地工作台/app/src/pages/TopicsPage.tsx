import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Compass, Heart, History, LoaderCircle, Search, Star } from "lucide-react";
import type { LibraryItem, LibrarySectionData } from "../types";
import { Empty, jsonFetch } from "../page-shared";
import { type CourseShelfResponse } from "./topics/CourseShelf";
import {
  DomainResearchHome,
  DomainKnowledgeMap,
  domainReaderTargets,
  findResearchDomain,
  type DomainResearchProgress,
  type DomainResearchProgressUpdate,
  type DomainId,
  type ReaderTarget,
} from "./topics/DomainResearchView";
import { isResearchDomainId } from "./topics/domain-research-home";

const Reader = lazy(() => import("./Reader"));

function palette(seed: number) {
  const colors = [["#243e42", "#78c5bc"], ["#4a332d", "#d6a26f"], ["#30384d", "#8ea9d5"], ["#3e343f", "#c79bb8"], ["#39402d", "#abbc72"], ["#423d32", "#d4c49a"]];
  return colors[seed % colors.length];
}

type TopicView = "domains" | "materials" | "archive";

const DEFAULT_BRANCH: Record<DomainId, string> = {
  game: "culture",
  ai: "ai-history-math",
  language: "language-foundations",
  "thought-history": "thought-method",
  zztj: "zztj-season-1",
  "image-management": "image-self",
  fitness: "fitness-physiology",
  "economics-finance": "ef-method-history",
};

const EMPTY_DOMAIN_PROGRESS: DomainResearchProgress = {
  schemaVersion: 1,
  cards: {},
  choices: {},
  lastPosition: null,
  lastPositions: {},
  recentCardIds: [],
};

function readTopicsSearch() {
  const params = new URLSearchParams(window.location.search);
  const requestedDomain = params.get("domain");
  const domain = isResearchDomainId(requestedDomain) ? requestedDomain : null;
  const requestedCardIndex = Number(params.get("card") || "0");
  return {
    view: "domains" as TopicView,
    query: params.get("q") ?? "",
    open: params.get("open"),
    domain,
    branch: params.get("branch") || (domain ? DEFAULT_BRANCH[domain] : DEFAULT_BRANCH.game),
    node: params.get("node"),
    cardIndex: Number.isSafeInteger(requestedCardIndex) && requestedCardIndex >= 0 ? requestedCardIndex : 0,
  };
}

function writeTopicsView(view: TopicView) {
  const url = new URL(window.location.href);
  if (view === "archive") url.searchParams.set("tab", "archive");
  else if (view === "materials") url.searchParams.set("tab", "materials");
  else url.searchParams.delete("tab");
  url.searchParams.delete("domain");
  url.searchParams.delete("branch");
  url.searchParams.delete("node");
  url.searchParams.delete("card");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function writeTopicsDomain(domain: DomainId | null, branch: string = DEFAULT_BRANCH.game, target?: ReaderTarget | null) {
  const url = new URL(window.location.href);
  url.searchParams.delete("tab");
  if (domain) {
    url.searchParams.set("domain", domain);
    url.searchParams.set("branch", branch);
    if (target) {
      url.searchParams.set("node", target.nodeId);
      url.searchParams.set("card", String(target.cardIndex));
    } else {
      url.searchParams.delete("node");
      url.searchParams.delete("card");
    }
  } else {
    url.searchParams.delete("domain");
    url.searchParams.delete("branch");
    url.searchParams.delete("node");
    url.searchParams.delete("card");
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function writeTopicsOpen(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("open", id);
  else url.searchParams.delete("open");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function TopicCard({
  item,
  pinned,
  liked,
  onTogglePin,
  onToggleLike,
  onOpen,
  courseCount = 0,
}: {
  item: LibraryItem;
  pinned?: boolean;
  liked?: boolean;
  onTogglePin?: () => void;
  onToggleLike?: () => void;
  onOpen?: () => void;
  courseCount?: number;
}) {
  const [base, accent] = palette(item.coverSeed);
  const body = (
    <>
      <div className="collection-top"><span>{item.category}</span>{item.date ? <small>{item.date}</small> : null}</div>
      <div className="collection-copy"><h3>{item.title}</h3>{item.author ? <p>{item.author}</p> : <p>{item.description}</p>}</div>
      <footer><span>{item.status}</span>{courseCount ? <small>{courseCount} 门课</small> : item.readTime ? <small>{item.readTime} 分钟</small> : <small>{item.tags[0] || "专题"}</small>}</footer>
    </>
  );
  return (
    <div className={`collection-item kind-${item.kind} ${pinned || liked ? "pinned" : ""} ${item.openable ? "openable" : ""}`} style={{ "--cover": base, "--cover-accent": accent } as React.CSSProperties}>
      <div className="card-spine" aria-hidden="true" />
      {item.kind === "topic" && onTogglePin ? (
        <button className={`pin-star ${pinned ? "active" : ""}`} type="button" aria-label={pinned ? "取消置顶" : "置顶到首页"} onClick={(event) => { event.stopPropagation(); onTogglePin(); }}>
          <Star size={15} fill={pinned ? "currentColor" : "none"} />
        </button>
      ) : null}
      {item.kind === "course" && onToggleLike ? (
        <button className={`pin-star like-heart ${liked ? "active" : ""}`} type="button" aria-label={liked ? "取消喜欢" : "标为喜欢"} onClick={(event) => { event.stopPropagation(); onToggleLike(); }}>
          <Heart size={15} fill={liked ? "currentColor" : "none"} />
        </button>
      ) : null}
      {onOpen ? (
        <button className="collection-card-body" type="button" onClick={onOpen}>{body}</button>
      ) : (
        <div className="collection-card-body">{body}</div>
      )}
    </div>
  );
}

export default function TopicsPage({
  data,
  pinnedTopicIds = [],
  likedCourseIds = [],
  pinnedDomainId = "zztj",
  onTogglePin,
  onToggleLike,
  onToggleDomainPin,
  onAskSecretary,
}: {
  data: LibrarySectionData;
  pinnedTopicIds?: string[];
  likedCourseIds?: string[];
  pinnedDomainId?: string | null;
  onTogglePin?: (topicId: string) => void | Promise<void>;
  onToggleLike?: (courseId: string) => void | Promise<void>;
  onToggleDomainPin?: (domainId: DomainId) => void | Promise<void>;
  onAskSecretary: (seedUser: string) => void;
}) {
  const [initial] = useState(readTopicsSearch);
  const [view, setView] = useState<TopicView>(initial.view);
  const [query, setQuery] = useState(initial.query);
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(initial.open);
  const [domainId, setDomainId] = useState<DomainId | null>(initial.domain);
  const [focusedDomainId, setFocusedDomainId] = useState<DomainId | null>(initial.domain);
  const [activeBranchId, setActiveBranchId] = useState(initial.branch);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(initial.node);
  const [activeCardIndex, setActiveCardIndex] = useState(initial.cardIndex);
  const [domainProgress, setDomainProgress] = useState<DomainResearchProgress>(EMPTY_DOMAIN_PROGRESS);
  const [courseShelf, setCourseShelf] = useState<CourseShelfResponse>({ available: false, courses: [], warnings: [] });

  const loadCourseShelf = useCallback(() => {
    jsonFetch<CourseShelfResponse>("/api/course-shelf")
      .then(setCourseShelf)
      .catch(() => setCourseShelf({ available: false, courses: [], warnings: [] }));
  }, []);

  useEffect(() => {
    if (view !== "domains" || openId) loadCourseShelf();
  }, [loadCourseShelf, openId, view]);

  useEffect(() => {
    jsonFetch<DomainResearchProgress>("/api/domain-research-progress")
      .then(setDomainProgress)
      .catch(() => setDomainProgress(EMPTY_DOMAIN_PROGRESS));
  }, []);

  const saveDomainProgress = useCallback(async (update: DomainResearchProgressUpdate) => {
    const optimisticAt = new Date().toISOString();
    setDomainProgress((current) => ({
      ...current,
      cards: update.status ? { ...current.cards, [update.cardId]: { status: update.status, updatedAt: optimisticAt } } : current.cards,
      choices: update.choiceId ? { ...current.choices, [update.cardId]: { choiceId: update.choiceId, updatedAt: optimisticAt } } : current.choices,
      lastPosition: { ...update.position, updatedAt: optimisticAt },
      lastPositions: { ...current.lastPositions, [update.position.domainId]: { ...update.position, updatedAt: optimisticAt } },
      recentCardIds: [update.cardId, ...current.recentCardIds.filter((id) => id !== update.cardId)].slice(0, 30),
    }));
    const next = await jsonFetch<DomainResearchProgress>("/api/domain-research-progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    setDomainProgress(next);
  }, []);

  useEffect(() => {
    const onPop = () => {
      const next = readTopicsSearch();
      setView(next.view);
      setQuery(next.query);
      setOpenId(next.open);
      setDomainId(next.domain);
      setActiveBranchId(next.branch);
      setActiveNodeId(next.node);
      setActiveCardIndex(next.cardIndex);
      setShowAll(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openDoc = (id: string) => {
    setOpenId(id);
    writeTopicsOpen(id);
  };
  const closeDocumentReader = () => {
    setOpenId(null);
    writeTopicsOpen(null);
  };
  const moveDocumentReader = (id: string) => {
    setOpenId(id);
    writeTopicsOpen(id);
  };

  const learning = data.items.filter((item) => item.kind === "topic");
  const done = data.items.filter((item) => item.kind === "course");
  const base = view === "materials" ? learning : done;
  const filtered = base.filter((item) => `${item.title} ${item.author ?? ""} ${item.description} ${item.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()));

  const liked = view === "archive"
    ? filtered.filter((item) => likedCourseIds.includes(item.id))
    : [];
  const rest = view === "archive"
    ? filtered.filter((item) => !likedCourseIds.includes(item.id))
    : filtered;
  const restShown = showAll ? rest : rest.slice(0, view === "archive" ? Math.max(0, 36 - liked.length) : 36);

  const renderCard = (item: LibraryItem) => (
    <TopicCard
      key={item.id}
      item={item}
      pinned={pinnedTopicIds.includes(item.id)}
      liked={likedCourseIds.includes(item.id)}
      onTogglePin={item.kind === "topic" && onTogglePin ? () => void onTogglePin(item.id) : undefined}
      onToggleLike={item.kind === "course" && onToggleLike ? () => void onToggleLike(item.id) : undefined}
      onOpen={item.openable || item.kind === "topic" ? () => openDoc(item.id) : undefined}
      courseCount={item.topicId ? courseShelf.courses.filter((course) => course.topicId === item.topicId).length : 0}
    />
  );

  const openItem = openId ? data.items.find((item) => item.id === openId) ?? null : null;
  const relatedCourses = openItem?.topicId ? courseShelf.courses.filter((course) => course.topicId === openItem.topicId) : [];
  const reader = openId ? (
    <Suspense fallback={<div className="reader-loading"><LoaderCircle className="spin" />正在展开…</div>}>
      <Reader key={openId} id={openId} onClose={closeDocumentReader} onMove={moveDocumentReader} backLabel="返回专题研究" relatedCourses={relatedCourses}/>
    </Suspense>
  ) : null;

  const selectView = (next: TopicView) => {
    setView(next);
    setDomainId(null);
    setActiveBranchId(DEFAULT_BRANCH.game);
    setActiveNodeId(null);
    setActiveCardIndex(0);
    setShowAll(false);
    setOpenId(null);
    writeTopicsOpen(null);
    writeTopicsView(next);
  };

  const game = data.domainResearch.game;
  const knowledgeNodes = data.domainResearch.knowledgeNodes;

  const enterDomainAt = (nextDomainId: DomainId, target?: ReaderTarget | null) => {
    const domain = findResearchDomain(game, nextDomainId, knowledgeNodes);
    const branchId = target?.branchId ?? domain.branches[0]?.id ?? DEFAULT_BRANCH[nextDomainId];
    setView("domains");
    setDomainId(nextDomainId);
    setFocusedDomainId(nextDomainId);
    setActiveBranchId(branchId);
    setActiveNodeId(target?.nodeId ?? null);
    setActiveCardIndex(target?.cardIndex ?? 0);
    setOpenId(null);
    writeTopicsOpen(null);
    writeTopicsDomain(nextDomainId, branchId, target);
  };

  const openReader = (target: ReaderTarget) => enterDomainAt(target.domainId, target);

  const closeKnowledgeReader = () => {
    setActiveNodeId(null);
    setActiveCardIndex(0);
    writeTopicsDomain(domainId, activeBranchId, null);
  };

  const leaveDomain = () => {
    setDomainId(null);
    setActiveBranchId(DEFAULT_BRANCH.game);
    setActiveNodeId(null);
    setActiveCardIndex(0);
    writeTopicsDomain(null);
  };

  const selectBranch = (branch: string) => {
    setActiveBranchId(branch);
    setActiveNodeId(null);
    setActiveCardIndex(0);
    writeTopicsDomain(domainId, branch);
  };

  const continueDomain = (nextDomainId: DomainId) => {
    const domain = findResearchDomain(game, nextDomainId, knowledgeNodes);
    const targets = domainReaderTargets(domain);
    const last = domainProgress.lastPositions[nextDomainId] ?? (domainProgress.lastPosition?.domainId === nextDomainId ? domainProgress.lastPosition : null);
    if (last && targets.some((target) => target.branchId === last.branchId && target.nodeId === last.nodeId)) {
      enterDomainAt(nextDomainId, { domainId: nextDomainId, branchId: last.branchId, nodeId: last.nodeId, cardIndex: last.cardIndex });
      return;
    }
    enterDomainAt(nextDomainId, targets[0] ?? null);
  };

  const randomDomain = (nextDomainId: DomainId) => {
    const targets = domainReaderTargets(findResearchDomain(game, nextDomainId, knowledgeNodes));
    const index = Math.floor(Math.random() * targets.length);
    enterDomainAt(nextDomainId, targets[index] ?? targets[0]);
  };
  const activeDomain = domainId ? findResearchDomain(game, domainId, knowledgeNodes) : null;
  const activePinnedDomainId = isResearchDomainId(pinnedDomainId) ? pinnedDomainId : null;

  return (
    <>
      <div className="library-page topics-page">
        {activeDomain ? (
          <DomainKnowledgeMap
            domain={activeDomain}
            activeBranchId={activeBranchId}
            activeNodeId={activeNodeId}
            activeCardIndex={activeCardIndex}
            progress={domainProgress}
            onBranchChange={selectBranch}
            onOpenNode={openReader}
            onMoveReader={openReader}
            onCloseReader={closeKnowledgeReader}
            onSaveProgress={saveDomainProgress}
            onAskSecretary={onAskSecretary}
            onBack={leaveDomain}
            onOpenOverview={() => { if (game.overviewId) openDoc(game.overviewId); }}
          />
        ) : (
          <>
            {view === "domains" ? (
              <DomainResearchHome
                game={game}
                knowledgeNodes={knowledgeNodes}
                progress={domainProgress}
                focusedDomainId={focusedDomainId}
                pinnedDomainId={activePinnedDomainId}
                onFocus={setFocusedDomainId}
                onCollapse={() => setFocusedDomainId(null)}
                onTogglePin={(nextDomainId) => { if (onToggleDomainPin) void onToggleDomainPin(nextDomainId); }}
                onContinue={continueDomain}
                onStart={(nextDomainId) => enterDomainAt(nextDomainId, null)}
                onRandom={randomDomain}
              />
            ) : (
              <>
                <div className="library-toolbar">
                  <div className="library-search">
                    <Search size={15} />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={`搜索${view === "materials" ? "研究资料" : "学习经历"}`} placeholder={`搜索${view === "materials" ? "研究资料" : "学习经历"}…`} />
                  </div>
                  <span>显示 {view === "archive" ? liked.length + restShown.length : restShown.length} / {filtered.length}</span>
                </div>
                {view === "archive" ? <p className="library-boundary-note">已结业得到课名和日期。没有账号，也没有证书上的姓名。</p> : null}

                {view === "archive" && liked.length ? (
                  <section className="topics-liked-block">
                    <div className="topics-section-label"><Heart size={14} />喜欢</div>
                    <div className="collection-grid">{liked.map(renderCard)}</div>
                  </section>
                ) : null}

                {restShown.length ? (
                  <section className={view === "archive" && liked.length ? "topics-rest-block" : undefined}>
                    <div className="collection-grid">{restShown.map(renderCard)}</div>
                  </section>
                ) : null}

                {restShown.length < rest.length ? <button className="load-more" type="button" onClick={() => setShowAll(true)}>展开全部其余 {rest.length} 项</button> : null}
                {!filtered.length ? <Empty>{view === "materials" ? "暂无研究资料。" : "暂无学习经历档案。"}</Empty> : null}
              </>
            )}
          </>
        )}
      </div>
      {createPortal(reader, document.body)}
    </>
  );
}
