import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Star } from "lucide-react";
import type { MarketBrief, MarketBriefHistoryEntry, MarketEventDecisionGrade, MarketEventTopic, MarketEventTopicPhase, MarketsSectionData, WorldLaneSection, WorldNewsLaneId } from "../types";
import { Card, Empty, ExternalSourceDisclosure, Kicker, fmtDate, jsonFetch, shouldSoftNavigate, tokyoDateKey } from "../page-shared";
import { DEFAULT_WORLD_NEWS_LANE, WORLD_NEWS_TABS, WorldLaneView } from "./world-news-lanes";
import { WorldNewsFavoritesProvider, WorldNewsReactionButtons } from "../world-news-favorites";

type MarketLaneId = "finance" | WorldNewsLaneId;

function readMarketTopicId() {
  return new URLSearchParams(window.location.search).get("topic") || "";
}

function writeMarketQuery(lane: MarketLaneId, topicId = "") {
  const url = new URL(window.location.href);
  if (lane && lane !== DEFAULT_WORLD_NEWS_LANE) url.searchParams.set("lane", lane);
  else url.searchParams.delete("lane");
  if (topicId) url.searchParams.set("topic", topicId);
  else url.searchParams.delete("topic");
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) return;
  window.history.pushState({}, "", next);
}

function readMarketLane(): MarketLaneId {
  if (readMarketTopicId()) return "finance";
  const value = new URLSearchParams(window.location.search).get("lane");
  if (value === "finance" || value === "ai" || value === "games" || value === "japan") return value;
  return DEFAULT_WORLD_NEWS_LANE;
}

function writeMarketTopicId(id: string) {
  writeMarketQuery("finance", id);
}

function revealMarketTopicWorkbench() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, left: 0, behavior: reducedMotion ? "auto" : "smooth" });
  document.querySelector<HTMLElement>(".page.is-active .market-topic-workbench")?.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "start",
  });
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function shortDate(value: string) {
  const match = value.match(/20\d{2}-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : value;
}

function parseYmd(value: string) {
  const match = value.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function ymd(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function shiftMonth(y: number, m: number, delta: number) {
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1 };
}

function sourceTypeLabel(type: string) {
  if (type === "一手") return "官方";
  if (type === "二手") return "转述";
  return type;
}

function MarketEventCard({ event, index, asOf }: { event: MarketBrief["events"][number]; index: number; asOf: string }) {
  return <Card className="market-event">
    <header>
      <div><span>{event.category}</span><small>重要度 {event.importance} 星</small></div>
      <div className="market-event-head-actions">
        <strong>0{index + 1}</strong>
        <WorldNewsReactionButtons lane="finance" asOf={asOf} eventId={event.id} title={event.title} category={event.category} />
      </div>
    </header>
    {event.category !== "AI热点" && event.signalTags?.length ? <div className="market-signal-row" aria-label="影响初筛">{event.signalTags.map((tag) => <em key={tag} className="market-signal-tag" data-tag={tag}>{tag}</em>)}</div> : null}
    <h3>{event.title}</h3>
    <div className="market-fact"><span>发生了什么</span><p>{event.fact}</p></div>
    <div className="market-analysis"><div><span>为什么重要</span><p>{event.whyItMatters}</p></div><div><span>市场反应</span><p>{event.marketReaction}</p></div><div><span>可能影响（把握：{event.confidence}）</span><p>{event.impact}</p></div></div>
    <footer><div><span>接着盯什么</span>{event.watchNext.map((item) => <small key={item}>{item}</small>)}</div><ExternalSourceDisclosure sources={event.sources.map((source) => ({ label: `${sourceTypeLabel(source.type)} · ${source.title}`, url: source.url }))} /></footer>
  </Card>;
}

function MarketEventLane({ title, hint, events, startIndex, asOf }: { title: string; hint: string; events: MarketBrief["events"]; startIndex: number; asOf: string }) {
  if (!events.length) return null;
  return <div className="market-event-lane">
    <div className="market-event-lane-head"><Kicker>{title}</Kicker><span>{hint}</span></div>
    {events.map((event, index) => <MarketEventCard key={event.id} event={event} index={startIndex + index} asOf={asOf} />)}
  </div>;
}

function monthCells(y: number, m: number) {
  const startWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: Array<{ key: string; day: number | null; date: string | null }> = [];
  for (let i = 0; i < startWeekday; i += 1) cells.push({ key: `pad-${i}`, day: null, date: null });
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ key: ymd(y, m, day), day, date: ymd(y, m, day) });
  }
  while (cells.length % 7 !== 0) cells.push({ key: `tail-${cells.length}`, day: null, date: null });
  return cells;
}

function monthKey(y: number, m: number) {
  return y * 12 + m;
}

type CalendarEvent = MarketBrief["calendar"][number];

function isConfirmedMajorEvent(event: CalendarEvent) {
  return event.dateConfirmed === true && /^20\d{2}-\d{2}-\d{2}$/.test(event.date) && event.importance === 5;
}

function isFeaturedMajorEvent(event: CalendarEvent) {
  return isConfirmedMajorEvent(event) && event.featured === true;
}

const TOPIC_STATUS_LABELS: Record<MarketEventTopic["status"], string> = {
  preview: "预告",
  published: "已公布",
  tracking: "跟踪中",
  closed: "已结案",
};

const TOPIC_PHASES: Array<{ phase: MarketEventTopicPhase; label: string; short: string }> = [
  { phase: "preview", label: "事前预览", short: "T-3" },
  { phase: "release", label: "公布快报", short: "T+0" },
  { phase: "d1", label: "次日观察", short: "D+1" },
  { phase: "tracking", label: "跟踪更新", short: "跟踪" },
  { phase: "d3", label: "三日确认", short: "D+3" },
  { phase: "d5", label: "五日补看", short: "D+5" },
  { phase: "closed", label: "结案复盘", short: "结案" },
];

function MarketDecisionRank({ grade, compact = false }: { grade: MarketEventDecisionGrade; compact?: boolean }) {
  return <div className={`market-decision-rank is-${grade.toLowerCase()}${compact ? " is-compact" : ""}`} aria-label={`决策评级 ${grade}`} title={`决策评级 ${grade}`}>
    <strong>{grade}</strong>
    <i aria-hidden />
  </div>;
}

function MarketTopicList({ title, variant, topics, selectedId, empty, onSelect }: {
  title: string;
  variant: "active" | "archive";
  topics: MarketEventTopic[];
  selectedId: string;
  empty: string;
  onSelect: (id: string) => void;
}) {
  return <section className={`market-topic-list is-${variant}`}>
    <header><h3>{title}</h3><span>{topics.length}</span></header>
    {topics.length ? <div>{topics.map((topic) => {
      const href = `/markets?topic=${encodeURIComponent(topic.id)}`;
      const active = selectedId === topic.id;
      return <a
        key={topic.id}
        className={`market-topic-item${active ? " active" : ""}${topic.decisionGrade ? " has-decision-rank" : ""}`}
        href={href}
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
          if (!shouldSoftNavigate(event)) return;
          event.preventDefault();
          onSelect(topic.id);
        }}
      >
        <span><time>{fmtDate(topic.eventDate)}</time><em className={`is-${topic.status}`}>{TOPIC_STATUS_LABELS[topic.status]}</em>{topic.sample ? <em className="is-sample">沙盘</em> : null}</span>
        <strong>{topic.title}</strong>
        <small>{topic.latestConclusion}</small>
        {topic.decisionGrade ? <MarketDecisionRank grade={topic.decisionGrade} compact /> : null}
      </a>;
    })}</div> : <p>{empty}</p>}
  </section>;
}

function MarketTopicWorkbench({ topic, onClose }: { topic: MarketEventTopic; onClose: () => void }) {
  const nodes = new Map(topic.nodes.map((node) => [node.phase, node]));
  return <section className="market-topic-workbench" aria-labelledby="market-topic-title" tabIndex={-1}>
    <Card className="market-topic-hero">
      <button type="button" className="market-topic-back" onClick={onClose}><ArrowLeft size={14} />返回金融大事记</button>
      <div className="market-topic-meta">
        <span className={`market-topic-status is-${topic.status}`}>{TOPIC_STATUS_LABELS[topic.status]}</span>
        {topic.sourceStatus ? <span className="market-topic-source-status">记录状态：{topic.sourceStatus}</span> : null}
        {topic.attributionOverall ? <span className="market-topic-attribution">{topic.attributionOverall}</span> : null}
        {topic.sample ? <span className="market-topic-sample">沙盘样例 · 非当前事实</span> : null}
        <time>{fmtDate(topic.eventDate)} · {topic.eventTime}</time>
      </div>
      <Kicker>{topic.region} · {topic.category}</Kicker>
      <h2 id="market-topic-title">{topic.title}</h2>
      <div className="market-topic-now">
        <div><span>最新一句结论</span><strong>{topic.latestConclusion}</strong></div>
        <div><span>还缺什么证据</span>{topic.missingEvidence.length ? <ul>{topic.missingEvidence.map((item) => <li key={item}>{item}</li>)}</ul> : <p>当前没有未补证据。</p>}</div>
      </div>
      {topic.decisionGrade ? <div className="market-topic-decision-review">
        <MarketDecisionRank grade={topic.decisionGrade} />
        <div>
          <span>决策评级 · {topic.decisionGrade}</span>
          <p>{topic.decisionReview || "本次只记录评级，详细评语待补。"}</p>
          {topic.decisionReviewedAt ? <time>评于 {fmtDate(topic.decisionReviewedAt)}</time> : null}
        </div>
      </div> : null}
    </Card>
    <div className="market-topic-timeline" aria-label="金融大事记观察时间线">
      {TOPIC_PHASES.map(({ phase, label, short }) => {
        const node = nodes.get(phase);
        const nodeStatus = node?.status ?? "pending";
        return <article key={phase} className={`market-topic-node is-${nodeStatus}`}>
          <div className="market-topic-rail" aria-hidden><span>{short}</span><i /></div>
          <Card>
            <header><div><Kicker>{short}</Kicker><h3>{label}</h3></div><span>{nodeStatus === "current" ? "当前节点" : nodeStatus === "recorded" ? "已有记录" : "等待更新"}</span></header>
            {node ? <>
              {node.observedAt ? <time>{node.observedAt}</time> : null}
              {node.attribution ? <p className="market-topic-node-attribution">归因：{node.attribution}</p> : null}
              {node.conclusion ? <p className="market-topic-node-conclusion">{node.conclusion}</p> : null}
              {node.evidenceBuckets?.map((bucket) => <div key={bucket.key} className={`market-topic-bucket is-${bucket.key}`}><strong>{bucket.label}</strong><p>{bucket.text}</p></div>)}
              {node.facts.length ? <div><strong>已记录事实</strong><ul>{node.facts.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
              {node.candidateJudgments.length ? <div><strong>候选判断</strong><ul>{node.candidateJudgments.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
              {node.missingEvidence.length ? <div><strong>仍缺证据</strong><ul>{node.missingEvidence.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
              <ExternalSourceDisclosure sources={node.sources.map((source) => ({ label: `${sourceTypeLabel(source.type)} · ${source.title}`, url: source.url }))} />
            </> : <p className="market-topic-pending">等待到达这个观察点；不会用空白补成结论。</p>}
          </Card>
        </article>;
      })}
    </div>
    <Card className="market-topic-rule"><div><Kicker>关闭规则</Kicker><p>{topic.closeRule}</p></div><p>专题只保存事实、市场反应与候选解释，不提供买卖指令、点位预测或仓位建议。</p>{topic.officialUrl ? <ExternalSourceDisclosure label="专题来源" sources={[{ label: "官方入口", url: topic.officialUrl }]} /> : null}</Card>
  </section>;
}

function MarketCalendarWorkbench({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  return <section className="market-topic-workbench market-calendar-workbench" aria-labelledby="market-calendar-event-title" tabIndex={-1}>
    <Card className="market-topic-hero market-calendar-hero">
      <button type="button" className="market-topic-back" onClick={onClose}><ArrowLeft size={14} />返回接下来盯什么</button>
      <div className="market-topic-meta">
        <span className="market-topic-status is-preview">已确认日期</span>
        <time>{fmtDate(event.date)}</time>
      </div>
      <Kicker>{event.region} · 重要度 {event.importance}</Kicker>
      <h2 id="market-calendar-event-title">{event.title}</h2>
      <div className="market-calendar-focus">
        <span>为什么值得关注</span>
        <p>{event.whyWatch}</p>
      </div>
      <a className="market-calendar-official" href={event.sourceUrl}>打开官方日程<ArrowUpRight size={12} /></a>
    </Card>
  </section>;
}

function emptyWorldLane(lane: WorldNewsLaneId): WorldLaneSection {
  return {
    schemaVersion: 1,
    lane,
    generatedAt: "",
    asOf: "尚未生成",
    headline: "今天没有够格的新闻。",
    status: "quiet",
    events: [],
    calendar: [],
    readings: [],
    note: "等待下一次更新。",
    date: null,
    latest: true,
    history: [],
    source: { path: "", updatedAt: null },
  };
}

export default function MarketsPage({ data }: { data: MarketsSectionData }) {
  const latestDate = data.date ?? data.history?.find((item) => item.latest)?.date ?? data.history?.at(-1)?.date ?? "";
  const [lane, setLane] = useState<MarketLaneId>(readMarketLane);
  const [selectedDate, setSelectedDate] = useState(latestDate);
  const [brief, setBrief] = useState<MarketBrief & { source?: MarketsSectionData["source"] }>(data);
  const [world, setWorld] = useState<Record<WorldNewsLaneId, WorldLaneSection>>(data.world ?? {
    ai: emptyWorldLane("ai"),
    games: emptyWorldLane("games"),
    japan: emptyWorldLane("japan"),
  });
  const [loadingDate, setLoadingDate] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState(readMarketTopicId);
  const [selectedCalendarEvent, setSelectedCalendarEvent] = useState<CalendarEvent | null>(null);
  const history = data.history?.length
    ? data.history
    : [{ date: latestDate || "latest", asOf: data.asOf, eventsCount: data.events.length, status: data.status, latest: true } satisfies MarketBriefHistoryEntry];

  const historyByDate = useMemo(() => new Map(history.map((entry) => [entry.date, entry])), [history]);
  const confirmedCalendarByDate = useMemo(() => {
    const next = new Map<string, CalendarEvent[]>();
    data.calendar.forEach((event) => {
      if (!isConfirmedMajorEvent(event)) return;
      next.set(event.date, [...(next.get(event.date) ?? []), event]);
    });
    return next;
  }, [data.calendar]);
  const tokyoToday = tokyoDateKey(new Date());
  const bounds = useMemo(() => {
    const dates = [
      ...history.map((entry) => entry.date),
      ...confirmedCalendarByDate.keys(),
      tokyoToday,
    ].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    return { earliest: dates[0] ?? latestDate, latest: dates.at(-1) ?? latestDate };
  }, [confirmedCalendarByDate, history, latestDate, tokyoToday]);

  const initialMonth = parseYmd(latestDate) ?? parseYmd(selectedDate) ?? { y: 2026, m: 8 };
  const [viewMonth, setViewMonth] = useState(initialMonth);

  useEffect(() => {
    setBrief(data);
    setWorld(data.world ?? {
      ai: emptyWorldLane("ai"),
      games: emptyWorldLane("games"),
      japan: emptyWorldLane("japan"),
    });
    setSelectedCalendarEvent(null);
    const nextDate = data.date ?? data.history?.find((item) => item.latest)?.date ?? data.history?.at(-1)?.date ?? "";
    setSelectedDate(nextDate);
    const nextMonth = parseYmd(nextDate);
    if (nextMonth) setViewMonth(nextMonth);
  }, [data]);

  useEffect(() => {
    const syncQuery = () => {
      setSelectedTopicId(readMarketTopicId());
      setLane(readMarketLane());
    };
    window.addEventListener("popstate", syncQuery);
    return () => window.removeEventListener("popstate", syncQuery);
  }, []);

  useEffect(() => {
    if (!selectedTopicId && !selectedCalendarEvent) return;
    const frame = requestAnimationFrame(() => revealMarketTopicWorkbench());
    return () => cancelAnimationFrame(frame);
  }, [selectedCalendarEvent, selectedTopicId]);

  const canPrev = useMemo(() => {
    const earliest = parseYmd(bounds.earliest);
    if (!earliest) return false;
    return monthKey(viewMonth.y, viewMonth.m) > monthKey(earliest.y, earliest.m);
  }, [bounds.earliest, viewMonth]);

  const canNext = useMemo(() => {
    const latest = parseYmd(bounds.latest);
    if (!latest) return false;
    return monthKey(viewMonth.y, viewMonth.m) < monthKey(latest.y, latest.m);
  }, [bounds.latest, viewMonth]);

  const cells = useMemo(() => monthCells(viewMonth.y, viewMonth.m), [viewMonth]);
  const activeTopics = useMemo(() => data.topics.filter((topic) => topic.status !== "closed"), [data.topics]);
  const closedTopics = useMemo(() => data.topics.filter((topic) => topic.status === "closed"), [data.topics]);
  const selectedTopic = useMemo(() => data.topics.find((topic) => topic.id === selectedTopicId) ?? null, [data.topics, selectedTopicId]);

  const selectLane = (next: MarketLaneId) => {
    setLane(next);
    if (next !== "finance") {
      setSelectedTopicId("");
      setSelectedCalendarEvent(null);
      writeMarketQuery(next);
      return;
    }
    writeMarketQuery("finance", selectedTopicId);
  };

  const selectTopic = (id: string) => {
    setLane("finance");
    setSelectedCalendarEvent(null);
    setSelectedTopicId(id);
    writeMarketTopicId(id);
  };

  const closeTopic = () => {
    setSelectedTopicId("");
    writeMarketTopicId("");
  };

  const selectCalendarEvent = (event: CalendarEvent) => {
    setSelectedTopicId("");
    writeMarketTopicId("");
    setSelectedCalendarEvent(event);
  };

  const selectDate = async (date: string) => {
    if (!date) return;
    setSelectedCalendarEvent(null);
    setSelectedTopicId("");
    writeMarketTopicId("");
    if (date === selectedDate || !historyByDate.has(date)) return;
    setSelectedDate(date);
    if (date === latestDate || date === "latest") {
      setBrief(data);
      return;
    }
    setLoadingDate(date);
    try {
      const next = await jsonFetch<MarketBrief & { source: MarketsSectionData["source"] }>(`/api/markets/brief?date=${encodeURIComponent(date)}`);
      setBrief({ ...next, history: data.history ?? next.history });
    } catch {
      setSelectedDate(latestDate);
      setBrief(data);
    } finally {
      setLoadingDate(null);
    }
  };

  const monthTitle = viewMonth.y === parseYmd(latestDate)?.y ? `${viewMonth.m}月` : `${viewMonth.y}年${viewMonth.m}月`;
  const focusEvents = brief.events.filter((event) => event.lane === "focus");
  const worldEvents = brief.events.filter((event) => event.lane !== "focus");
  const showFinance = lane === "finance";

  return <WorldNewsFavoritesProvider>
    <div className="world-news-page">
    <div className="asset-tabs" role="tablist" aria-label="世界资讯分区">
      {WORLD_NEWS_TABS.map((item) => {
        const selected = lane === item.id;
        return <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={selected}
          className={selected ? "active" : ""}
          onClick={() => selectLane(item.id)}
        >{item.label}</button>;
      })}
    </div>
    {!showFinance ? <WorldLaneView key={lane} lane={lane} data={world[lane]} /> : <div className="market-layout">
    <div className="market-main">
      {selectedTopic ? <MarketTopicWorkbench topic={selectedTopic} onClose={closeTopic} /> : selectedTopicId ? <Card><Empty>找不到这份事件册，可能已经换了编号。</Empty></Card> : selectedCalendarEvent ? <MarketCalendarWorkbench event={selectedCalendarEvent} onClose={() => setSelectedCalendarEvent(null)} /> : <>
      <Card className="market-hero">
        <div className="market-hero-copy">
          <Kicker>简报</Kicker>
          <h2>{brief.headline}</h2>
          <p>{brief.note}</p>
        </div>
      </Card>
      <section className="market-events">
        <div className="section-heading"><div><h2>真正值得知道的事</h2></div><span>{selectedDate && selectedDate !== latestDate ? `${shortDate(selectedDate)} 的简报` : "先看这条线，再看全世界"}</span></div>
        {brief.events.length ? <>
          <MarketEventLane title="眼下这条线" hint="现在跟得最紧的" events={focusEvents} startIndex={0} asOf={selectedDate} />
          <MarketEventLane title="世界这头" hint="大势和新机会" events={worldEvents} startIndex={focusEvents.length} asOf={selectedDate} />
        </> : <Card><Empty>{brief.status === "quiet" ? "当日简报范围内暂无重大事件。" : "暂无达到简报门槛的新消息。"}</Empty></Card>}
      </section>
      </>}
    </div>
    <aside className="market-side">
      <Card className="market-brief-log">
        <div className="card-title">
          <div><Kicker>已确认日期</Kicker><h2>金融日历</h2></div>
          <span>{loadingDate ? "读取中…" : "点日期看简报"}</span>
        </div>
        <div className="market-brief-cal" aria-label="金融日历">
          <div className="market-brief-cal-nav">
            <button type="button" aria-label="上个月" disabled={!canPrev} onClick={() => setViewMonth((current) => shiftMonth(current.y, current.m, -1))}>
              <ChevronLeft size={16} />
            </button>
            <strong>{monthTitle}</strong>
            <button type="button" aria-label="下个月" disabled={!canNext} onClick={() => setViewMonth((current) => shiftMonth(current.y, current.m, 1))}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="market-brief-cal-weekdays">
            {WEEKDAYS.map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className="market-brief-cal-grid">
            {cells.map((cell) => {
              if (!cell.date || cell.day == null) return <span key={cell.key} className="market-brief-cal-empty" />;
              const entry = historyByDate.get(cell.date);
              const available = Boolean(entry);
              const active = cell.date === selectedDate;
              const calendarEvents = confirmedCalendarByDate.get(cell.date) ?? [];
              const hasMajorEvent = calendarEvents.length > 0;
              const featured = calendarEvents.some(isFeaturedMajorEvent);
              const isToday = cell.date === tokyoToday;
              const eventNames = calendarEvents.map((event) => event.title).join("、");
              const eventLabel = [
                isToday ? "今天" : "",
                hasMajorEvent ? `${featured ? "特别核心的重大事件" : "重大事件"}：${eventNames}` : cell.date,
              ].filter(Boolean).join("，");
              const classes = [
                "market-calendar-date",
                available ? "has-brief" : "no-brief",
                entry?.status === "quiet" ? "quiet" : "",
                entry?.latest ? "is-latest" : "",
                active ? "active" : "",
                hasMajorEvent ? "is-major" : "",
                featured ? "is-featured" : "",
                isToday ? "is-today" : "",
              ].filter(Boolean).join(" ");
              const dateContents = <>
                <span>{cell.day}</span>
                {available ? <i aria-hidden /> : null}
                {featured ? <Star className="market-calendar-star" size={9} fill="currentColor" aria-hidden /> : null}
              </>;
              return (
                <span key={cell.key} className="market-brief-cal-day">
                  {available ? <button
                    type="button"
                    className={classes}
                    aria-label={`${eventLabel}，有当日简报，点选查看`}
                    aria-current={isToday ? "date" : undefined}
                    disabled={loadingDate === cell.date}
                    onClick={() => void selectDate(cell.date!)}
                  >{dateContents}</button> : hasMajorEvent ? <button
                    type="button"
                    className={classes}
                    aria-label={`${eventLabel}，查看事件详情`}
                    aria-current={isToday ? "date" : undefined}
                    onClick={() => selectCalendarEvent(calendarEvents[0])}
                  >{dateContents}</button> : <span className={classes} aria-hidden={!isToday}>{dateContents}</span>}
                </span>
              );
            })}
          </div>
          <div className="market-calendar-legend" aria-label="金融日历标记图例">
            <span><i className="market-calendar-legend-mark is-today" aria-hidden />今天</span>
            <span><i className="market-calendar-legend-mark is-major" aria-hidden />重大事件</span>
            <span><i className="market-calendar-legend-mark is-featured" aria-hidden><Star size={8} fill="currentColor" /></i>特别核心</span>
          </div>
        </div>
      </Card>
      <Card className="market-topics-card">
        <div className="card-title"><div><Kicker>事件档案</Kicker><h2>金融大事记</h2></div><span>一件事一册</span></div>
        <MarketTopicList title="活跃事件" variant="active" topics={activeTopics} selectedId={selectedTopicId} empty="暂时没有活跃事件。" onSelect={selectTopic} />
        <MarketTopicList title="已归档" variant="archive" topics={closedTopics} selectedId={selectedTopicId} empty="归档事件会保留在这里。" onSelect={selectTopic} />
      </Card>
      <Card className="market-calendar"><div className="card-title"><div><Kicker>后续关注</Kicker><h2>接下来盯什么</h2></div><CalendarDays size={18}/></div><div>{brief.calendar.length ? brief.calendar.map((event) => {
        const active = selectedCalendarEvent?.date === event.date && selectedCalendarEvent.title === event.title;
        return <button key={`${event.date}-${event.title}`} type="button" className={active ? "active" : ""} aria-pressed={active} onClick={() => selectCalendarEvent(event)}><time>{fmtDate(event.date)}</time><span><strong>{event.title}</strong><small>{event.region} · {event.whyWatch}</small></span><i aria-label={`重要度 ${event.importance}`}>{event.importance}</i></button>;
      }) : <Empty>近期暂无重要宏观与财经议程。</Empty>}</div></Card>
    </aside>
  </div>}
  </div>
  </WorldNewsFavoritesProvider>;
}
