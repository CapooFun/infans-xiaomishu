import { useEffect, useState } from "react";
import { BookOpenText, ChevronRight, Newspaper } from "lucide-react";
import type { JapaneseExploration, WorldLaneSection, WorldReading } from "../../types";
import { Card, Empty, ExternalSourceDisclosure, Kicker, jsonFetch } from "../../page-shared";
import { JapaneseCollectionDocumentBody } from "./JapaneseCollectionDocumentBody";
import { readLanguageViewPosition, writeLanguageViewPosition } from "./language-view-memory";

type ReadingCategory = "news" | "literature";

const READING_CATEGORIES: ReadonlyArray<{ id: ReadingCategory; label: string; note: string }> = [
  { id: "news", label: "新闻阅读", note: "日本新闻与时事材料" },
  { id: "literature", label: "赏析阅读", note: "从短童话和名作片段入门" },
];

type LiteratureCard = {
  id: string;
  title: string;
  author: string;
  level: string;
  note: string;
  sourceName: string;
  sourceUrl: string;
  sourcePath: string;
  updatedAt: string;
  readTime: number;
};

type LiteratureDocument = LiteratureCard & { markdown: string };

function shortDate(value: string | null | undefined) {
  const matched = String(value || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  return matched ? `${Number(matched[1])}月${Number(matched[2])}日` : "日期未标注";
}

function NewsReadingCard({ reading }: { reading: WorldReading }) {
  return <details className="museum-card world-reading-fold">
    <summary>
      <span>{reading.level} 本地阅读</span>
      <strong>{reading.title}</strong>
      <ChevronRight size={16} aria-hidden />
    </summary>
    <div className="world-reading">
      <header>
        <div>
          <Kicker>{reading.level}</Kicker>
          <h3>{reading.title}</h3>
        </div>
        <ExternalSourceDisclosure sources={[{ label: "新闻原文", url: reading.sourceUrl }]} />
      </header>
      {reading.date ? <time>{shortDate(reading.date)}</time> : null}
      {reading.rubyHtml ? <>
        <p className="world-reading-furigana">{reading.furiganaSource === "original" ? "注音来自原文" : "注音由本地稿补充"}</p>
        <div className="world-reading-body" dangerouslySetInnerHTML={{ __html: reading.rubyHtml }} />
      </> : <Empty>这篇本地稿暂时只有标题和来源。</Empty>}
      {reading.vocab.length ? <div className="world-reading-vocab">
        <span>重点词汇</span>
        <ul>{reading.vocab.map((item) => <li key={`${item.word}-${item.reading}`}>
          <strong>{item.word}</strong>
          <em>{item.reading}</em>
          <span>{item.meaning}{item.note ? ` · ${item.note}` : ""}</span>
        </li>)}</ul>
      </div> : null}
    </div>
  </details>;
}

export function ReadingBoard({
  exploration,
}: {
  exploration: JapaneseExploration | null | undefined;
}) {
  const mileage = exploration?.readingMileage;
  const rememberedPosition = readLanguageViewPosition("reading");
  const initialCategory = rememberedPosition?.category === "literature" ? "literature" : "news";
  const [category, setCategory] = useState<ReadingCategory>(initialCategory);
  const [news, setNews] = useState<WorldLaneSection | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState("");
  const [literature, setLiterature] = useState<LiteratureCard[]>([]);
  const [literatureLoading, setLiteratureLoading] = useState(false);
  const [literatureError, setLiteratureError] = useState("");
  const [selectedLiteratureId, setSelectedLiteratureId] = useState("");
  const [literatureDocument, setLiteratureDocument] = useState<LiteratureDocument | null>(null);
  const [literatureDocumentLoading, setLiteratureDocumentLoading] = useState(false);

  useEffect(() => {
    if (category !== "news" || news) return;
    let cancelled = false;
    setNewsLoading(true);
    jsonFetch<WorldLaneSection>("/api/markets/world?lane=japan")
      .then((body) => {
        if (cancelled) return;
        setNews(body);
        setNewsError("");
      })
      .catch((reason) => {
        if (cancelled) return;
        setNewsError(reason instanceof Error ? reason.message : "没读到日本新闻本地稿");
      })
      .finally(() => { if (!cancelled) setNewsLoading(false); });
    return () => { cancelled = true; };
  }, [category, news]);

  useEffect(() => {
    if (category !== "literature" || literature.length) return;
    let cancelled = false;
    setLiteratureLoading(true);
    jsonFetch<{ data: LiteratureCard[] }>("/api/languages/reading-literature")
      .then((body) => {
        if (cancelled) return;
        setLiterature(body.data);
        setLiteratureError("");
      })
      .catch((reason) => {
        if (cancelled) return;
        setLiteratureError(reason instanceof Error ? reason.message : "没读到本地赏析");
      })
      .finally(() => { if (!cancelled) setLiteratureLoading(false); });
    return () => { cancelled = true; };
  }, [category, literature.length]);

  const openLiterature = (id: string) => {
    if (!id || literatureDocumentLoading) return;
    setSelectedLiteratureId(id);
    if (literatureDocument?.id === id) return;
    setLiteratureDocument(null);
    setLiteratureDocumentLoading(true);
    jsonFetch<{ data: LiteratureDocument }>(`/api/languages/reading-literature?detailId=${encodeURIComponent(id)}`)
      .then((body) => {
        setLiteratureDocument(body.data);
        setLiteratureError("");
      })
      .catch((reason) => setLiteratureError(reason instanceof Error ? reason.message : "没打开这篇本地赏析"))
      .finally(() => setLiteratureDocumentLoading(false));
  };

  return <div className="language-layout reading-library">
    <Card className="language-hero language-hero-fade">
      <div className="language-hero-copy">
        <Kicker>阅读看板</Kicker>
        <h2>新闻与赏析阅读</h2>
        <div className="language-hero-grid">
          <div className="language-hero-main">
            <strong>{mileage?.totalQuestions ?? 0}</strong>
            <span>已练题数 · 不计入探索成就</span>
          </div>
          <div className="language-hero-side language-hero-side-4">
            <div><strong>{mileage?.totalPassages ?? 0}</strong><span>已练篇目</span></div>
            <div><strong>{mileage?.recent7Days?.length ?? 0}</strong><span>近 7 日有练</span></div>
          </div>
        </div>
        <div className="reading-category-tabs" role="tablist" aria-label="阅读类型">
          {READING_CATEGORIES.map((item) => <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            className={category === item.id ? "is-active" : ""}
            onClick={() => {
              setCategory(item.id);
              writeLanguageViewPosition("reading", { category: item.id, sitting: "全部" });
            }}
          >
            {item.id === "news" ? <Newspaper size={16}/> : <BookOpenText size={16}/>}
            <span><strong>{item.label}</strong><small>{item.note}</small></span>
          </button>)}
        </div>
      </div>
    </Card>

    {category === "news" ? <Card className="reading-library-board reading-news-board">
      <div className="grammar-browser-head reading-local-head">
        <div>
          <Kicker>新闻阅读</Kicker>
          <h2>日本新闻本地阅读</h2>
          <p>{newsLoading ? "正在读取最新本地稿…" : news?.date ? `最新本地稿 · ${shortDate(news.date)}；正文直接在这里阅读。` : "读取已有日本新闻与分级材料。"}</p>
        </div>
        {news?.source?.path ? <span className="reading-local-badge">本地原件</span> : null}
      </div>
      {newsError ? <Empty>{newsError}</Empty> : null}
      {!newsLoading && !newsError && news && !news.readings.length ? <Empty>最新本地稿还没有可读正文，稍后更新后会自动出现在这里。</Empty> : null}
      {news?.readings.length ? <div className="reading-news-list">
        {news.readings.map((reading) => <NewsReadingCard key={reading.id} reading={reading}/>) }
      </div> : null}
    </Card> : null}

    {category === "literature" ? <Card className="reading-library-board literature-board">
      <div className="grammar-browser-head">
        <div>
          <Kicker>赏析阅读</Kicker>
          <h2>本地赏析</h2>
          <p>文章保存在本地，直接点开阅读；原作链接只用于核对来源。</p>
        </div>
      </div>
      {literatureLoading ? <Empty>正在打开本地赏析目录…</Empty> : null}
      {literatureError ? <Empty>{literatureError}</Empty> : null}
      <div className="literature-grid">
        {literature.map((item) => <button
          type="button"
          className={selectedLiteratureId === item.id ? "is-active" : ""}
          key={item.id}
          aria-pressed={selectedLiteratureId === item.id}
          onClick={() => openLiterature(item.id)}
        >
          <header><span>{item.level}</span><small>{item.author}</small></header>
          <h3 lang="ja">{item.title}</h3>
          <p>{item.note}</p>
          <footer><span>{item.readTime} 分钟 · 在小秘书内阅读</span><BookOpenText size={14}/></footer>
        </button>)}
      </div>
      {literatureDocumentLoading ? <div className="literature-document"><Empty>正在打开文章…</Empty></div> : null}
      {literatureDocument ? <article className="literature-document" aria-live="polite">
        <div className="literature-document-meta">
          <span>{literatureDocument.author} · {literatureDocument.level}</span>
          <small>本地文章 · {literatureDocument.readTime} 分钟</small>
        </div>
        <JapaneseCollectionDocumentBody markdown={literatureDocument.markdown} sourcePath={literatureDocument.sourcePath}/>
      </article> : null}
    </Card> : null}
  </div>;
}
