import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Star } from "lucide-react";
import type { MarketBrief, MarketBriefHistoryEntry, WorldLaneSection, WorldNewsLaneId, WorldReading } from "../types";
import { Card, Empty, ExternalSourceDisclosure, Kicker, fmtDate, jsonFetch, tokyoDateKey } from "../page-shared";
import { usePageNavigationActive } from "../shell/PageNavigation";
import { WorldNewsReactionButtons } from "../world-news-favorites";
import { revealWorldNewsTarget } from "../world-news-target";

export const DEFAULT_WORLD_NEWS_LANE = "japan" as const;

export const WORLD_NEWS_TABS: Array<{ id: "finance" | WorldNewsLaneId; label: string }> = [
  { id: "japan", label: "日本" },
  { id: "finance", label: "金融" },
  { id: "ai", label: "AI" },
  { id: "games", label: "游戏" },
];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

const LANE_COPY: Record<WorldNewsLaneId, {
  eventsTitle: string;
  eventsHint: string;
  calendarTitle: string;
  empty: string;
  nowTitle: string;
  nowHint: string;
  aheadTitle: string;
  aheadHint: string;
  impactLabel: string;
}> = {
  ai: {
    eventsTitle: "真正值得知道的事",
    eventsHint: "先看会改你干活的，再看这周额度与接口",
    calendarTitle: "AI 日历",
    empty: "今天没有够格改你做事方式的官方消息。",
    nowTitle: "眼下能改你干活的",
    nowHint: "ChatGPT、Cursor、本机接口和默认模型",
    aheadTitle: "这周要盯的",
    aheadHint: "开放范围、额度和接口",
    impactLabel: "可能影响你怎么干活",
  },
  games: {
    eventsTitle: "真正值得知道的事",
    eventsHint: "先看能改发行或参展的，再看这周要做什么",
    calendarTitle: "游戏日历",
    empty: "今天没有够格的平台规则或发行消息。",
    nowTitle: "眼下能改发行或参展的",
    nowHint: "平台规则、Steam 和独立圈动作",
    aheadTitle: "所以这周要做什么",
    aheadHint: "从已确认节点推出来的本周动作",
    impactLabel: "所以这周要做什么",
  },
  japan: {
    eventsTitle: "今天的新闻",
    eventsHint: "先看出门，再看这周签证、交通和灾害",
    calendarTitle: "日本日历",
    empty: "今天没有够格改你在日安排的官方消息。",
    nowTitle: "今天出门用得上的",
    nowHint: "天气、JR、当天手续",
    aheadTitle: "这周要盯的",
    aheadHint: "签证、交通和灾害",
    impactLabel: "可能影响出门或手续",
  },
};

type CalendarEvent = MarketBrief["calendar"][number];

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

function monthKey(y: number, m: number) {
  return y * 12 + m;
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

function isConfirmedMajorEvent(event: CalendarEvent) {
  return event.dateConfirmed === true && /^20\d{2}-\d{2}-\d{2}$/.test(event.date) && event.importance === 5;
}

function isFeaturedMajorEvent(event: CalendarEvent) {
  return isConfirmedMajorEvent(event) && event.featured === true;
}

function sourceTypeLabel(type: string) {
  if (type === "一手") return "官方";
  if (type === "二手") return "转述";
  return type;
}

function WorldEventCard({ event, index, impactLabel, lane, asOf }: { event: WorldLaneSection["events"][number]; index: number; impactLabel: string; lane: WorldNewsLaneId; asOf: string }) {
  return <Card className="market-event" id={`world-event-${event.id}`}>
    <header>
      <div><span>{event.category || "大事"}</span></div>
      <div className="market-event-head-actions">
        <strong>0{index + 1}</strong>
        <WorldNewsReactionButtons lane={lane} asOf={asOf} eventId={event.id} title={event.title} category={event.category} />
      </div>
    </header>
    <h3>{event.title}</h3>
    <div className="market-fact"><span>已发生事实</span><p>{event.fact}</p></div>
    <div className="market-analysis is-world">
      <div><span>为什么重要</span><p>{event.whyItMatters}</p></div>
      <div><span>{impactLabel}</span><p>{event.impact || "按已发生事实继续观察。"}</p></div>
    </div>
    <footer>
      <div><span>下一观察点</span>{event.watchNext.map((item) => <small key={item}>{item}</small>)}</div>
      <ExternalSourceDisclosure sources={event.sources.map((source) => ({ label: `${sourceTypeLabel(source.type)} · ${source.title}`, url: source.url }))} />
    </footer>
  </Card>;
}

function WorldEventLane({
  title,
  hint,
  events,
  startIndex,
  impactLabel,
  lane,
  asOf,
}: {
  title: string;
  hint: string;
  events: WorldLaneSection["events"];
  startIndex: number;
  impactLabel: string;
  lane: WorldNewsLaneId;
  asOf: string;
}) {
  if (!events.length) return null;
  return <div className="market-event-lane">
    <div className="market-event-lane-head"><Kicker>{title}</Kicker><span>{hint}</span></div>
    {events.map((event, index) => <WorldEventCard key={event.id} event={event} index={startIndex + index} impactLabel={impactLabel} lane={lane} asOf={asOf} />)}
  </div>;
}

function WorldReadingCard({ reading, lane, date }: { reading: WorldReading; lane: WorldNewsLaneId; date: string }) {
  const audioSrc = reading.audioAvailable && date
    ? `/api/markets/world/reading-audio?lane=${encodeURIComponent(lane)}&date=${encodeURIComponent(date)}&id=${encodeURIComponent(reading.id)}`
    : "";
  return <details className="museum-card world-reading-fold">
    <summary>
      <span>今日 {reading.level} 阅读</span>
      <strong>{reading.title}</strong>
      <ChevronRight size={16} aria-hidden />
    </summary>
    <div className="world-reading">
      <header>
        <div>
          <Kicker>{reading.level}</Kicker>
          <h3>{reading.title}</h3>
        </div>
        <ExternalSourceDisclosure label="阅读来源" sources={[{ label: reading.sourceName, url: reading.sourceUrl }]} />
      </header>
      {reading.date ? <time>{fmtDate(reading.date)}</time> : null}
      {reading.whyRead ? <p className="world-reading-why">{reading.whyRead}</p> : null}
      {audioSrc ? <div className="world-reading-audio">
        <span>真人配音</span>
        <audio controls preload="none" src={audioSrc}>这篇课文的配音</audio>
      </div> : null}
      {reading.rubyHtml ? <>
        <p className="world-reading-furigana">{reading.furiganaSource === "original" ? "注音来自原文" : "注音是后加的"}</p>
        <div className="world-reading-body" dangerouslySetInnerHTML={{ __html: reading.rubyHtml }} />
      </> : <Empty>暂未获取到该篇日文官方正文，仅提供标题与原文链接。</Empty>}
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

export function WorldLaneView({ lane, data }: { lane: WorldNewsLaneId; data: WorldLaneSection }) {
  const pageActive = usePageNavigationActive();
  const copy = LANE_COPY[lane];
  const latestDate = data.date ?? data.history.find((item) => item.latest)?.date ?? data.history.at(-1)?.date ?? "";
  const [selectedDate, setSelectedDate] = useState(latestDate);
  const [brief, setBrief] = useState(data);
  const [loadingDate, setLoadingDate] = useState<string | null>(null);
  const history = data.history.length
    ? data.history
    : [{ date: latestDate || "latest", asOf: data.asOf, eventsCount: data.events.length, status: data.status, latest: true } satisfies MarketBriefHistoryEntry];
  const historyByDate = useMemo(() => new Map(history.map((entry) => [entry.date, entry])), [history]);
  const confirmedCalendarByDate = useMemo(() => {
    const next = new Map<string, CalendarEvent[]>();
    brief.calendar.forEach((event) => {
      if (!isConfirmedMajorEvent(event)) return;
      next.set(event.date, [...(next.get(event.date) ?? []), event]);
    });
    return next;
  }, [brief.calendar]);
  const tokyoToday = tokyoDateKey(new Date());
  const bounds = useMemo(() => {
    const dates = [
      ...history.map((entry) => entry.date),
      ...confirmedCalendarByDate.keys(),
      tokyoToday,
    ].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
    return { earliest: dates[0] ?? latestDate, latest: dates.at(-1) ?? latestDate };
  }, [confirmedCalendarByDate, history, latestDate, tokyoToday]);
  const initialMonth = parseYmd(latestDate) ?? { y: 2026, m: 9 };
  const [viewMonth, setViewMonth] = useState(initialMonth);
  const cells = useMemo(() => monthCells(viewMonth.y, viewMonth.m), [viewMonth]);
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

  useEffect(() => {
    setBrief(data);
    const nextDate = data.date ?? data.history.find((item) => item.latest)?.date ?? data.history.at(-1)?.date ?? "";
    setSelectedDate(nextDate);
    const nextMonth = parseYmd(nextDate);
    if (nextMonth) setViewMonth(nextMonth);
  }, [data]);

  useLayoutEffect(() => {
    if (!pageActive) return;
    revealWorldNewsTarget();
    const run = () => { revealWorldNewsTarget(); };
    window.addEventListener("popstate", run);
    window.addEventListener("hashchange", run);
    return () => {
      window.removeEventListener("popstate", run);
      window.removeEventListener("hashchange", run);
    };
  }, [brief.events, lane, pageActive]);

  const selectDate = async (date: string) => {
    if (!date || date === selectedDate || !historyByDate.has(date)) return;
    setSelectedDate(date);
    if (date === latestDate || date === "latest") {
      setBrief(data);
      return;
    }
    setLoadingDate(date);
    try {
      const next = await jsonFetch<WorldLaneSection>(`/api/markets/world?lane=${encodeURIComponent(lane)}&date=${encodeURIComponent(date)}`);
      setBrief({ ...next, history: data.history ?? next.history });
    } catch {
      setSelectedDate(latestDate);
      setBrief(data);
    } finally {
      setLoadingDate(null);
    }
  };

  const monthTitle = viewMonth.y === parseYmd(latestDate)?.y ? `${viewMonth.m}月` : `${viewMonth.y}年${viewMonth.m}月`;
  const readings = lane === "japan" ? brief.readings : [];
  const nowEvents = brief.events.filter((event) => event.lane !== "ahead");
  const aheadEvents = brief.events.filter((event) => event.lane === "ahead");

  return <div className="market-layout">
    <div className="market-main">
      <Card className="market-hero">
        <div className="market-hero-copy">
          <Kicker>简报</Kicker>
          <h2>{brief.headline}</h2>
          <p>{brief.note}</p>
        </div>
      </Card>
      {lane === "japan" ? <section className="world-readings">
        <div className="section-heading"><div><h2>今天四篇</h2></div><span>点开一条再读</span></div>
        {readings.length
          ? readings.map((reading) => <WorldReadingCard key={reading.id} reading={reading} lane={lane} date={selectedDate} />)
          : <Card><Empty>暂未获取到该篇日文官方正文，仅提供标题与原文链接。</Empty></Card>}
      </section> : null}
      <section className="market-events" id="market-events">
        <div className="section-heading"><div><h2>{copy.eventsTitle}</h2></div><span>{selectedDate && selectedDate !== latestDate ? `${shortDate(selectedDate)} 的简报` : copy.eventsHint}</span></div>
        {brief.events.length
          ? <>
            <WorldEventLane title={copy.nowTitle} hint={copy.nowHint} events={nowEvents} startIndex={0} impactLabel={copy.impactLabel} lane={lane} asOf={selectedDate} />
            <WorldEventLane title={copy.aheadTitle} hint={copy.aheadHint} events={aheadEvents} startIndex={nowEvents.length} impactLabel={copy.impactLabel} lane={lane} asOf={selectedDate} />
          </>
          : <Card><Empty>{brief.status === "quiet" ? copy.empty : "暂无达到简报门槛的新消息。"}</Empty></Card>}
      </section>
    </div>
    <aside className="market-side">
      <Card className="market-brief-log">
        <div className="card-title">
          <div><Kicker>已确认日期</Kicker><h2>{copy.calendarTitle}</h2></div>
          <span>{loadingDate ? "读取中…" : "点日期看当天"}</span>
        </div>
        <div className="market-brief-cal" aria-label={copy.calendarTitle}>
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
                    aria-label={`${isToday ? "今天，" : ""}${cell.date}，有当日简报，点选查看`}
                    aria-current={isToday ? "date" : undefined}
                    disabled={loadingDate === cell.date}
                    onClick={() => void selectDate(cell.date!)}
                  >{dateContents}</button> : <span className={classes} aria-hidden={!isToday}>{dateContents}</span>}
                </span>
              );
            })}
          </div>
          <div className="market-calendar-legend" aria-label={`${copy.calendarTitle}标记图例`}>
            <span><i className="market-calendar-legend-mark is-today" aria-hidden />今天</span>
            <span><i className="market-calendar-legend-mark is-major" aria-hidden />重大事件</span>
            <span><i className="market-calendar-legend-mark is-featured" aria-hidden><Star size={8} fill="currentColor" /></i>特别核心</span>
          </div>
        </div>
      </Card>
      {brief.calendar.length ? <Card className="market-calendar"><div className="card-title"><div><Kicker>后续关注</Kicker><h2>接下来盯什么</h2></div><CalendarDays size={18}/></div><div>{brief.calendar.map((event) => <article className="world-calendar-entry" key={`${event.date}-${event.title}`}><div><time>{fmtDate(event.date)}</time><span><strong>{event.title}</strong><small>{event.region} · {event.whyWatch}</small></span><i aria-label={`重要度 ${event.importance}`}>{event.importance}</i></div><ExternalSourceDisclosure sources={[{ label: "官方来源", url: event.sourceUrl }]} /></article>)}</div></Card> : null}
    </aside>
  </div>;
}
