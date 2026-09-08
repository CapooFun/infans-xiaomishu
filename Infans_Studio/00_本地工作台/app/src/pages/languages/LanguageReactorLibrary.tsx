import { useEffect, useState } from "react";
import { PageTrail } from "../../shell/PageNavigation";
import {
  BookOpen,
  BookOpenText,
  Brain,
  ChevronRight,
  FileText,
  Gamepad2,
  Library,
  MessageCircle,
  Music2,
  NotebookTabs,
  Quote,
  Search,
  ShieldCheck,
  Shuffle,
  Tags,
  type LucideIcon,
} from "lucide-react";
import type {
  JapaneseCollectionDocument,
  JapaneseCollectionDocumentCard,
  JapaneseCollectionItem,
  JapaneseCollectionResponse,
  JapaneseCorpusCollectionItem,
  JapaneseKnowledgeCard,
  LanguageReactorCollection,
} from "../../types";
import { Card, Empty, ExternalSourceDisclosure, Kicker, fmtDate, jsonFetch } from "../../page-shared";
import { mediaOffset, usableReactorTranslation } from "./shared";
import { readLanguageViewPosition, writeLanguageViewPosition } from "./language-view-memory";
import { JapaneseCollectionDocumentBody } from "./JapaneseCollectionDocumentBody";

type CollectionScope = "all" | "cards" | "corpus";
type CorpusType = "all" | "phrase" | "word";
type CollectionView = "root" | "language" | "works" | "learning" | "corpus" | "knowledge" | "expression" | "song" | "anime" | "industry" | "method" | "phrase" | "word" | "all";

const EMPTY_RESPONSE: JapaneseCollectionResponse = {
  items: [],
  total: 0,
  offset: 0,
  limit: 60,
  review: false,
  stats: { total: 0, cards: 0, documents: 0, knowledge: 0, songs: 0, industry: 0, anime: 0, methods: 0, expressions: 0, phrases: 0, words: 0 },
  cardTypes: ["全部类型"],
  categories: ["全部分类"],
  verifications: ["全部状态", "已核验", "个人记法", "待核验"],
  sources: ["全部作品"],
};

function isKnowledge(item: JapaneseCollectionItem): item is JapaneseKnowledgeCard {
  return item.kind === "knowledge";
}

function isDocument(item: JapaneseCollectionItem): item is JapaneseCollectionDocumentCard {
  return item.kind === "document";
}

function KnowledgeDetail({ card }: { card: JapaneseKnowledgeCard }) {
  return <div className="knowledge-card-detail">
    {card.explanation ? <section><h4>展开说明</h4>{card.explanation.split("\n\n").map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</section> : null}
    {card.memoryHook ? <section className="knowledge-memory-hook"><h4>我的记法</h4><p>{card.memoryHook}</p></section> : null}
    {card.rules.length ? <section><h4>正确规则</h4><ul>{card.rules.map((item) => <li key={item}>{item}</li>)}</ul></section> : null}
    {card.boundaries.length ? <section><h4>适用边界</h4><ul>{card.boundaries.map((item) => <li key={item}>{item}</li>)}</ul></section> : null}
    {card.examples.length ? <section><h4>例子</h4><ul>{card.examples.map((item) => <li key={item}>{item}</li>)}</ul></section> : null}
    {card.sources.length ? <section className="knowledge-sources"><ExternalSourceDisclosure sources={card.sources.flatMap((source) => source.url ? [{ label: source.label, url: source.url }] : [])} /><div>{card.sources.filter((source) => !source.url).map((source) => <span key={`${source.label}-${source.path || "local"}`}>{source.label}</span>)}</div></section> : null}
  </div>;
}

function KnowledgeCard({ card }: { card: JapaneseKnowledgeCard }) {
  return <article className="lr-item knowledge-card">
    <header><div><span className="lr-type knowledge">{card.category}</span><span className={`knowledge-verification ${card.verification}`}>{card.verification}</span></div><time>{fmtDate(card.updatedAt)}</time></header>
    <h3>{card.title}</h3>
    <p className="knowledge-summary">{card.summary}</p>
    {card.memoryHook ? <p className="knowledge-hook"><Brain size={13}/>{card.memoryHook}</p> : null}
    <details><summary>展开知识卡 <ChevronRight size={12}/></summary><KnowledgeDetail card={card}/></details>
    <footer><span>{card.tags.slice(0, 3).join(" · ")}</span></footer>
  </article>;
}

function documentTone(cardType: JapaneseCollectionDocumentCard["cardType"]) {
  return ({ 歌曲精读: "song", 行业用语: "industry", 动漫用语: "anime", 学习经验: "method", 实用表达: "expression" } as const)[cardType];
}

function DocumentCard({ card }: { card: JapaneseCollectionDocumentCard }) {
  const [document, setDocument] = useState<JapaneseCollectionDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const openDocument = (open: boolean) => {
    if (!open || document || loading) return;
    setLoading(true);
    jsonFetch<{ data: JapaneseCollectionDocument }>(`/api/languages/collection?detailId=${encodeURIComponent(card.id)}`)
      .then((body) => { setDocument(body.data); setError(""); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "没读到这份资料"))
      .finally(() => setLoading(false));
  };
  return <article className={`lr-item document-card document-${documentTone(card.cardType)}`}>
    <header><div><span className="lr-type document">{card.cardType}</span><span className="document-category">{card.category}</span></div><time>{fmtDate(card.updatedAt)}</time></header>
    <h3>{card.title}</h3>
    <p className="knowledge-summary">{card.summary}</p>
    <details onToggle={(event) => openDocument(event.currentTarget.open)}><summary><BookOpenText size={13}/>阅读全文 <ChevronRight size={12}/></summary>{loading ? <div className="collection-document-loading">正在读取资料…</div> : error ? <div className="collection-document-loading error">{error}</div> : document ? <JapaneseCollectionDocumentBody markdown={document.markdown} sourcePath={document.sourcePath}/> : null}</details>
    <footer><span>{card.readTime} 分钟 · {card.tags.slice(0, 2).join(" · ")}</span></footer>
  </article>;
}

function CorpusCard({ item }: { item: JapaneseCorpusCollectionItem }) {
  const sourceName = (title: string) => title.split(" · ")[0] || title;
  return <article className="lr-item corpus-card">
    <header><div><span className={`lr-type ${item.type}`}>{item.type === "phrase" ? "句子" : "单词"}</span>{item.word ? <strong>{item.word}<small>{item.wordTransliteration}</small></strong> : null}</div><time>{fmtDate(item.createdAt)}</time></header>
    <h3>{item.sentence}</h3>
    {item.transliteration ? <p className="lr-reading">{item.transliteration}</p> : null}
    <p className="lr-translation">{usableReactorTranslation(item)}</p>
    <footer><span>{sourceName(item.sourceTitle)}</span><small>{mediaOffset(item.startTimeMs)}</small></footer>
    {item.previous || item.next ? <details><summary>查看前后语境 <ChevronRight size={12}/></summary><div className="corpus-context">{item.previous ? <p><i>前</i><span>{item.previous}<small>{item.previousTranslation}</small></span></p> : null}<p className="current"><i>本句</i><span>{item.sentence}<small>{item.translation}</small></span></p>{item.next ? <p><i>后</i><span>{item.next}<small>{item.nextTranslation}</small></span></p> : null}</div></details> : null}
  </article>;
}

function DirectoryCard({ icon: Icon, title, count, description, detail, tone, compact = false, onClick }: {
  icon: LucideIcon;
  title: string;
  count: number;
  description: string;
  detail: string;
  tone: "knowledge" | "works" | "learning" | "neutral";
  compact?: boolean;
  onClick: () => void;
}) {
  return <button type="button" className={`collection-directory-card tone-${tone}${compact ? " compact" : ""}`} onClick={onClick}>
    <span className="collection-directory-spine" aria-hidden="true"/>
    <span className="collection-directory-icon"><Icon size={compact ? 18 : 22}/></span>
    <span className="collection-directory-count">{count}<small>项</small></span>
    <strong>{title}</strong>
    <span className="collection-directory-description">{description}</span>
    <span className="collection-directory-detail">{detail}<ChevronRight size={14}/></span>
  </button>;
}

const VIEW_LABELS: Record<CollectionView, string> = {
  root: "收藏总目录",
  language: "语言知识",
  works: "作品与行业",
  learning: "学习积累",
  corpus: "沉浸语料",
  knowledge: "知识点",
  expression: "实用表达",
  song: "歌词精读",
  anime: "动漫用语",
  industry: "行业用语",
  method: "学习经验",
  phrase: "完整句子",
  word: "带语境单词",
  all: "全部收藏",
};

const VIEW_PARENT: Partial<Record<CollectionView, CollectionView>> = {
  language: "root",
  works: "root",
  learning: "root",
  corpus: "learning",
  knowledge: "language",
  expression: "language",
  song: "works",
  anime: "works",
  industry: "works",
  method: "learning",
  phrase: "corpus",
  word: "corpus",
  all: "root",
};

function viewRequest(view: CollectionView): { scope: CollectionScope; cardType: string; corpusType: CorpusType } {
  if (view === "knowledge") return { scope: "cards", cardType: "知识点", corpusType: "all" };
  if (view === "expression") return { scope: "cards", cardType: "实用表达", corpusType: "all" };
  if (view === "song") return { scope: "cards", cardType: "歌曲精读", corpusType: "all" };
  if (view === "anime") return { scope: "cards", cardType: "动漫用语", corpusType: "all" };
  if (view === "industry") return { scope: "cards", cardType: "行业用语", corpusType: "all" };
  if (view === "method") return { scope: "cards", cardType: "学习经验", corpusType: "all" };
  if (view === "phrase") return { scope: "corpus", cardType: "全部类型", corpusType: "phrase" };
  if (view === "word") return { scope: "corpus", cardType: "全部类型", corpusType: "word" };
  return { scope: "all", cardType: "全部类型", corpusType: "all" };
}

function viewTrail(view: CollectionView) {
  const trail: CollectionView[] = [];
  let current: CollectionView | undefined = view;
  while (current) {
    trail.unshift(current);
    current = VIEW_PARENT[current];
  }
  return trail;
}

export function JapaneseCollectionLibrary({ meta, onImport }: { meta: LanguageReactorCollection | null; onImport: (file: File) => void }) {
  const pageSize = 60;
  const remembered = readLanguageViewPosition("collection");
  const [view, setView] = useState<CollectionView>("root");
  const [verification, setVerification] = useState("全部状态");
  const [source, setSource] = useState(remembered?.source || "全部作品");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [review, setReview] = useState(false);
  const [response, setResponse] = useState<JapaneseCollectionResponse>(EMPTY_RESPONSE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const searching = Boolean(query.trim());
  const itemView = ["knowledge", "expression", "song", "anime", "industry", "method", "phrase", "word", "all"].includes(view);
  const showItems = review || searching || itemView;
  const configuredRequest = viewRequest(view);
  const request = review
    ? { scope: "cards" as const, cardType: "全部类型", corpusType: "all" as const }
    : searching ? { scope: "all" as const, cardType: "全部类型", corpusType: "all" as const } : configuredRequest;
  const showImport = !searching && ["corpus", "phrase", "word"].includes(view);
  const trail = viewTrail(view);

  useEffect(() => {
    setOffset(0);
    setResponse((current) => ({ ...current, items: [] }));
  }, [meta, view, verification, source, query, review]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({
        scope: request.scope,
        cardType: request.cardType,
        corpusType: request.corpusType,
        category: "全部分类",
        verification,
        source,
        q: query.trim(),
        offset: String(offset),
        limit: String(showItems ? pageSize : 1),
        review: review ? "5" : "0",
      });
      jsonFetch<{ data: JapaneseCollectionResponse }>(`/api/languages/collection?${params}`)
        .then((body) => {
          if (cancelled) return;
          setResponse((current) => ({ ...body.data, items: offset === 0 ? body.data.items : [...current.items, ...body.data.items] }));
          setError("");
        })
        .catch((reason) => {
          if (cancelled) return;
          setError(reason instanceof Error ? reason.message : "没读到收藏内容");
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [meta, view, verification, source, query, offset, review, request.scope, request.cardType, request.corpusType, showItems]);

  const openView = (next: CollectionView) => {
    setView(next);
    setQuery("");
    setReview(false);
    setVerification("全部状态");
    const kind = next === "phrase" || next === "word" ? next : ["knowledge", "expression", "song", "anime", "industry", "method"].includes(next) ? "cards" : next === "corpus" ? "corpus" : "all";
    writeLanguageViewPosition("collection", { kind, source });
  };
  const chooseSource = (next: string) => {
    setSource(next);
    setReview(false);
    writeLanguageViewPosition("collection", { kind: request.scope, source: next });
  };
  const openReview = () => {
    if (review) {
      setReview(false);
      setView("knowledge");
      return;
    }
    setView("knowledge");
    setQuery("");
    setVerification("全部状态");
    setReview(true);
  };

  const languageCount = response.stats.knowledge + response.stats.expressions;
  const worksCount = response.stats.songs + response.stats.anime + response.stats.industry;
  const learningCount = response.stats.methods + response.stats.phrases + response.stats.words;

  const directoryContent = view === "root" ? <>
    <div className="collection-directory-heading"><div><span>三大书架</span><h3>今天想翻哪一类？</h3></div><small>先选目录，再看内容</small></div>
    <div className="collection-directory-grid root-grid">
      <DirectoryCard icon={BookOpen} title="语言知识" count={languageCount} description="读音、词义、语法记法和常用表达" detail={`知识点 ${response.stats.knowledge} · 实用表达 ${response.stats.expressions}`} tone="knowledge" onClick={() => openView("language")}/>
      <DirectoryCard icon={Music2} title="作品与行业" count={worksCount} description="从喜欢的作品和实际领域进入日语" detail={`歌词 ${response.stats.songs} · 动漫 ${response.stats.anime} · 行业 ${response.stats.industry}`} tone="works" onClick={() => openView("works")}/>
      <DirectoryCard icon={NotebookTabs} title="学习积累" count={learningCount} description="方法、完整句子和带语境的单词" detail={`经验 ${response.stats.methods} · 语料 ${response.stats.phrases + response.stats.words}`} tone="learning" onClick={() => openView("learning")}/>
    </div>
    <button type="button" className="collection-all-link" onClick={() => openView("all")}><Library size={15}/>查看全部 {response.stats.total} 项<ChevronRight size={14}/></button>
  </> : view === "language" ? <>
    <div className="collection-directory-heading"><div><span>语言知识</span><h3>先理解，再记住</h3></div><small>{languageCount} 项</small></div>
    <div className="collection-directory-grid">
      <DirectoryCard compact icon={Tags} title="知识点" count={response.stats.knowledge} description="读音、标点、词源和个人语法记法" detail="适合快速复习" tone="knowledge" onClick={() => openView("knowledge")}/>
      <DirectoryCard compact icon={MessageCircle} title="实用表达" count={response.stats.expressions} description="连接表达、授受关系和日常组织语言" detail="适合随时查阅" tone="knowledge" onClick={() => openView("expression")}/>
    </div>
  </> : view === "works" ? <>
    <div className="collection-directory-heading"><div><span>作品与行业</span><h3>从兴趣和真实场景进入</h3></div><small>{worksCount} 项</small></div>
    <div className="collection-directory-grid">
      <DirectoryCard compact icon={Music2} title="歌词精读" count={response.stats.songs} description="歌词、注音、大意和逐段文法" detail="完整长文" tone="works" onClick={() => openView("song")}/>
      <DirectoryCard compact icon={BookOpenText} title="动漫用语" count={response.stats.anime} description="看番讨论、作品理解与现实语境" detail="主题词汇" tone="works" onClick={() => openView("anime")}/>
      <DirectoryCard compact icon={Gamepad2} title="行业用语" count={response.stats.industry} description="游戏开发、商务沟通和敬语" detail="专业场景" tone="works" onClick={() => openView("industry")}/>
    </div>
  </> : view === "learning" ? <>
    <div className="collection-directory-heading"><div><span>学习积累</span><h3>方法和遇见过的日语</h3></div><small>{learningCount} 项</small></div>
    <div className="collection-directory-grid">
      <DirectoryCard compact icon={NotebookTabs} title="学习经验" count={response.stats.methods} description="零基础路线和 Anki＋AI 工作流" detail="方法卡片" tone="learning" onClick={() => openView("method")}/>
      <DirectoryCard compact icon={Quote} title="沉浸语料" count={response.stats.phrases + response.stats.words} description="从真实作品收藏的句子和语境单词" detail="句子与单词" tone="learning" onClick={() => openView("corpus")}/>
    </div>
  </> : view === "corpus" ? <>
    <div className="collection-directory-heading"><div><span>沉浸语料</span><h3>按记忆单位继续分</h3></div><small>{response.stats.phrases + response.stats.words} 项</small></div>
    <div className="collection-directory-grid">
      <DirectoryCard compact icon={Quote} title="完整句子" count={response.stats.phrases} description="保留原文、读音、翻译和作品位置" detail="可以展开前后语境" tone="learning" onClick={() => openView("phrase")}/>
      <DirectoryCard compact icon={Tags} title="带语境单词" count={response.stats.words} description="从完整台词里记住词义和使用场景" detail="单词仍连着原句" tone="learning" onClick={() => openView("word")}/>
    </div>
  </> : null;

  const contentTitle = review ? "今天的快速复习" : searching ? `搜索“${query.trim()}”` : VIEW_LABELS[view];
  const contentDescription = review ? "只抽短知识点，不把歌词和大型词表塞进复习。" : searching ? "搜索会跨越所有目录，但不会改变原件归属。" : view === "all" ? "按更新时间浏览全部收藏；平时更建议从目录进入。" : "已经进入最小目录，只显示这一类内容。";

  return <Card className="lr-library japanese-collection-library">
    <PageTrail items={[
      ...trail.map((item) => ({ label: item === "root" ? "收藏" : VIEW_LABELS[item], onSelect: () => openView(item) })),
      ...(searching ? [{ label: "搜索结果" }] : review ? [{ label: "快速复习" }] : []),
    ]} />
    <div className="lr-header"><div><Kicker>日语收藏</Kicker><h2>我的日语收藏书柜</h2><p>先找到目录，再打开想看的那一张。</p></div><div className="collection-header-actions"><button type="button" className={`lr-review-button${review ? " active" : ""}`} aria-pressed={review} onClick={openReview}><Shuffle size={14}/>{review ? "退出快速复习" : "快速复习 5 张"}</button>{showImport ? <label className="lr-file-button"><FileText size={14}/>{meta ? "重新导入语料" : "导入语料 JSON"}<input type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.currentTarget.value = ""; }}/></label> : null}</div></div>
    <div className="collection-compact-stats" aria-label="收藏统计"><span>共 <strong>{response.stats.total}</strong> 项</span><i/><span>资料卡 {response.stats.cards}</span><i/><span>沉浸语料 {response.stats.phrases + response.stats.words}</span></div>
    <div className="collection-global-search"><Search size={15}/><input value={query} onChange={(event) => { setQuery(event.target.value); setReview(false); setVerification("全部状态"); setSource("全部作品"); }} aria-label="搜索日语收藏" placeholder="搜索全部目录里的知识、歌词、用语或作品…"/>{query ? <button type="button" onClick={() => setQuery("")}>清除</button> : null}</div>
    {!showItems ? <section className="collection-directory-stage">{directoryContent}</section> : <>
      <div className="collection-content-heading"><div><span>{review ? "快速复习" : searching ? "全库搜索" : "当前目录"}</span><h3>{contentTitle}</h3><p>{contentDescription}</p></div><strong>{loading ? "…" : response.total}<small>项</small></strong></div>
      {(view === "knowledge" || review || view === "phrase" || view === "word") && !searching ? <div className="collection-content-tools">
        {(view === "knowledge" || review) ? <select aria-label="知识点状态" value={verification} onChange={(event) => { setVerification(event.target.value); setReview(false); }}>{response.verifications.map((item) => <option key={item}>{item}</option>)}</select> : null}
        {(view === "phrase" || view === "word") ? <select aria-label="作品来源" value={source} onChange={(event) => chooseSource(event.target.value)}>{response.sources.map((item) => <option key={item}>{item}</option>)}</select> : null}
        <span>{loading ? "读取中…" : `显示 ${response.items.length} / ${response.total}`}</span>
      </div> : null}
      {review ? <div className="collection-review-note"><Shuffle size={14}/><span>今天固定抽取 5 张短知识点；整篇歌词和大型词表不会塞进快速复习。它只帮助快速回想，不替代 Anki。</span></div> : null}
    </>}
    {error ? <Empty>{error}</Empty> : null}
    {showItems ? <div className="lr-grid">{response.items.map((item) => isKnowledge(item) ? <KnowledgeCard key={`knowledge-${item.id}`} card={item}/> : isDocument(item) ? <DocumentCard key={`document-${item.id}`} card={item}/> : <CorpusCard key={`corpus-${item.id}`} item={item}/>)}</div> : null}
    {showItems && !error && !review && response.items.length < response.total ? <button className="load-more" disabled={loading} onClick={() => setOffset(response.items.length)}>{loading ? "正在加载…" : `继续加载（剩余 ${response.total - response.items.length} 条）`}</button> : null}
    {showItems && !loading && !error && !response.items.length ? <Empty>这个目录里暂时没有符合条件的收藏。</Empty> : null}
    <div className="lr-boundary"><ShieldCheck size={14}/><span>资料卡来自同一份本地知识库；知识点继续区分“已核验／待核验／个人记法”。{meta ? ` 语料最近导入 ${fmtDate(meta.importedAt, true)}。` : ""}</span></div>
  </Card>;
}

export const LanguageReactorLibrary = JapaneseCollectionLibrary;
