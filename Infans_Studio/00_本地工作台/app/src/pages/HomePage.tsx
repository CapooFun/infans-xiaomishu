import { useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { LoaderCircle, LockKeyhole, Target } from "lucide-react";
import { formatHomeTodoSummary, stripTodoMetaPrefixes } from "../gantt-model";
import { projectWindowSwipeStep, projectWindowWheelStep } from "../project-workbench-model";
import { buildAiExecutionRows, buildCurrentExecutionRows, isTodoInNextTwoTokyoDays } from "../schedule-todo-model";
import { CardLink, Empty, Kicker, ProgressRing, fmtTime, formatNearTermEventWhen, isNearTermTokyoInstant, jsonFetch, softNavigate, tokyoDateKey } from "../page-shared";
import { invalidateSection } from "../workbench-data-cache";
import type { CalendarEvent, CalendarSnapshot, HomePins, MarketLiveSnapshot, WorkbenchSummary, WorldNewsHomeLane } from "../types";
import { ANKIWEB_DECKS_URL } from "./languages/shared";
import { isResearchDomainId, researchDomainHomeMeta } from "./topics/domain-research-home";

/** 与服务端 `MARKET_REFRESH_MS` 对齐：首页在前台时拉最新缓存。 */
const MARKET_LIVE_POLL_MS = 300_000;
const BRIEF_STALE_CHECK_MS = 60 * 60_000;
const WORLD_BROADCAST_MIN_MS = 15_000;
const STOCK_BROADCAST_MIN_MS = 20_000;
const BROADCAST_TEXT_DELAY_MS = 3_000;
const BROADCAST_TEXT_SPEED_PX_S = 30;
const BROADCAST_TEXT_GAP_PX = 32;

function clipText(text: string, max = 22) {
  const next = text.replace(/\s+/g, " ").trim();
  return next.length <= max ? next : `${next.slice(0, max)}…`;
}

function formatStudyDuration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "未同步";
  const minutes = Math.max(0, Math.round(value));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}小时 ${remainder}分` : `${hours} 小时`;
}

function formatMarketPercent(value: number | null) {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatMarketPriceParts(value: number | null, currency: string) {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: currency === "CNY" ? 3 : 2,
  });
  const parts = formatter.formatToParts(value ?? 0);
  const currencyLabel = parts.find((part) => part.type === "currency")?.value || currency;
  return {
    currency: currencyLabel,
    amount: value == null ? "—" : parts.filter((part) => part.type !== "currency").map((part) => part.value).join("").trim(),
    label: value == null ? `${currencyLabel} —` : formatter.format(value),
  };
}

function StudyDuration({ value, compact = false }: { value: number | null | undefined; compact?: boolean }) {
  if (value == null || !Number.isFinite(value)) return <span className={`jp-duration ${compact ? "is-compact" : ""}`}>未同步</span>;
  const minutes = Math.max(0, Math.round(value));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return <span className={`jp-duration ${compact ? "is-compact" : ""}`} aria-label={formatStudyDuration(value)}>
    {hours ? <><b>{hours}</b><i>小时</i></> : null}
    {remainder || !hours ? <><b>{remainder}</b><i>分钟</i></> : null}
  </span>;
}

function HomeCardHeading({
  eyebrow,
  title,
  meta,
  lead = false,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  lead?: boolean;
}) {
  return <div className={`home-card-heading${lead ? " is-lead" : ""}`}>
    <div>
      {eyebrow ? <Kicker>{eyebrow}</Kicker> : null}
      <h2>{title}</h2>
    </div>
    {meta ? <div className="home-card-meta">{meta}</div> : null}
  </div>;
}

function DayTimeline({ calendar, compact = false, onSelect }: { calendar: CalendarSnapshot; compact?: boolean; onSelect?: (event: CalendarEvent) => void }) {
  const todayKey = tokyoDateKey(new Date());
  const events = calendar.events
    .filter((event) => isNearTermTokyoInstant(event.start))
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, compact ? 4 : 12);
  if (!calendar.available) {
    const denied = calendar.permission === "denied";
    return <div className={`calendar-unavailable ${calendar.loading ? "loading" : ""}`} onClick={(event) => event.stopPropagation()}>{calendar.loading ? <LoaderCircle className="spin" size={18} /> : <LockKeyhole size={18} />}<div><strong>{calendar.loading ? "正在读取苹果日历" : denied ? "日历权限未开启" : "苹果日历读取失败"}</strong><p>{calendar.message || (calendar.loading ? "本机尚无缓存时需要稍等片刻；之后会先显示缓存再后台更新。" : "下拉刷新或回到前台后会再试。")}</p></div></div>;
  }
  if (!events.length) {
    return <Empty>因过竹院逢僧话<br />偷得浮生半日闲</Empty>;
  }
  return <div className="day-timeline">{events.map((event) => {
    const body = <><time>{formatNearTermEventWhen(event.start, event.allDay, todayKey)}</time><i /><div><strong>{event.title}</strong><small>{event.calendar}{event.recurring ? " · 重复" : ""}</small></div></>;
    return onSelect
      ? <button key={event.id} type="button" onClick={(e) => { e.stopPropagation(); onSelect(event); }}>{body}</button>
      : <div className="day-timeline-item" key={event.id}>{body}</div>;
  })}</div>;
}

const HOME_PROJECT_NAMES = ["小秘书", "阳台种植计划", "周末摄影集"] as const;

function HomeProjectWindow({ data }: { data: WorkbenchSummary }) {
  const projects = useMemo(() => HOME_PROJECT_NAMES.flatMap((name) => {
    const project = data.projectManagement?.projects.find((item) => item.name === name
      || (name === "小秘书" && (item.projectId === "demo-secretary" || item.projectId === "infans-ai-system")));
    if (!project) return [];
    const current = [...(project.management?.doing || []), ...(project.management?.next || [])]
      .filter((task) => !task.done)
      .slice(0, 3)
      .map((task) => stripTodoMetaPrefixes(task.displayText || task.text));
    return [{
      id: project.projectId || name,
      name,
      status: project.status,
      version: null,
      current: current.length ? current : [project.management?.currentStatus || "当前没有列出正在推进的任务。"],
      href: `/projects?project=${encodeURIComponent(project.projectId || name)}`,
    }];
  }), [data.projectManagement?.projects]);
  const [activeIndex, setActiveIndex] = useState(0);
  const gestureRef = useRef({ x: 0, y: 0, swiped: false });
  const lastWheelAtRef = useRef(0);
  const activeProject = projects[activeIndex] || projects[0];
  const move = (step: number) => {
    if (projects.length < 2) return;
    setActiveIndex((current) => (current + step + projects.length) % projects.length);
  };
  if (!activeProject) return null;

  return (
    <section
      className="museum-card interactive-card project-hero home-quiet home-project-window"
      role="region"
      aria-roledescription="项目切换区"
      aria-label={`重点项目，当前第 ${activeIndex + 1} 项，共 ${projects.length} 项`}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        move(event.key === "ArrowRight" ? 1 : -1);
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return;
        gestureRef.current = { x: event.clientX, y: event.clientY, swiped: false };
      }}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch") return;
        const dx = event.clientX - gestureRef.current.x;
        const dy = event.clientY - gestureRef.current.y;
        if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.35) gestureRef.current.swiped = true;
      }}
      onPointerUp={(event) => {
        if (event.pointerType !== "touch") return;
        const dx = event.clientX - gestureRef.current.x;
        const dy = event.clientY - gestureRef.current.y;
        const step = projectWindowSwipeStep(dx, dy);
        if (step) move(step);
      }}
      onWheel={(event) => {
        const step = projectWindowWheelStep(event.deltaX, event.deltaY);
        if (!step) return;
        event.preventDefault();
        const now = Date.now();
        if (now - lastWheelAtRef.current < 360) return;
        lastWheelAtRef.current = now;
        move(step);
      }}
    >
      <div className="project-orbit" />
      <a
        className="home-project-link"
        href={activeProject.href}
        aria-label={`打开${activeProject.name}`}
        onClick={(event) => {
          if (gestureRef.current.swiped) {
            event.preventDefault();
            gestureRef.current.swiped = false;
            return;
          }
          softNavigate(event, activeProject.href);
        }}
      />
      <div className="home-project-copy" key={activeProject.id}>
        <HomeCardHeading
          eyebrow={<>重点项目{activeProject.version ? ` · ${activeProject.version}` : ""}</>}
          title={activeProject.name}
        />
        <p className="project-hero-status">{activeProject.status}</p>
        <div className="home-pending">
          <span>当前推进</span>
          {activeProject.current.map((item) => <p key={item}><Target size={12} /><em>{clipText(item, 34)}</em></p>)}
        </div>
      </div>
      <div className="home-project-position" aria-label={`第 ${activeIndex + 1} 项，共 ${projects.length} 项`}>
        <div aria-hidden>{projects.map((project, index) => <i className={index === activeIndex ? "is-active" : ""} key={project.id} />)}</div>
      </div>
    </section>
  );
}

function useHomeBroadcast({
  active,
  count,
  contentKey,
  minimumDuration,
  onAdvance,
}: {
  active: boolean;
  count: number;
  contentKey: string;
  minimumDuration: number;
  onAdvance: () => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const advanceRef = useRef(onAdvance);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [duration, setDuration] = useState(minimumDuration);
  advanceRef.current = onAdvance;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncEnvironment = () => {
      setDocumentVisible(document.visibilityState === "visible");
      setReducedMotion(media.matches);
    };
    syncEnvironment();
    media.addEventListener("change", syncEnvironment);
    document.addEventListener("visibilitychange", syncEnvironment);
    return () => {
      media.removeEventListener("change", syncEnvironment);
      document.removeEventListener("visibilitychange", syncEnvironment);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        let firstReadDuration = minimumDuration;
        root.querySelectorAll<HTMLElement>('[data-broadcast-active="true"] [data-broadcast-viewport]').forEach((viewport) => {
          const copy = viewport.querySelector<HTMLElement>("[data-broadcast-copy]");
          if (!copy || copy.scrollWidth <= viewport.clientWidth + 1) return;
          const loopDuration = (copy.scrollWidth + BROADCAST_TEXT_GAP_PX) / BROADCAST_TEXT_SPEED_PX_S * 1000;
          firstReadDuration = Math.max(firstReadDuration, BROADCAST_TEXT_DELAY_MS + loopDuration + 1_200);
        });
        setDuration(Math.ceil(firstReadDuration));
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root.querySelectorAll<HTMLElement>('[data-broadcast-active="true"] [data-broadcast-viewport], [data-broadcast-active="true"] [data-broadcast-copy]').forEach((element) => observer.observe(element));
    measure();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [contentKey, minimumDuration]);

  const playing = active && count > 1 && !hovered && !focused && documentVisible && !reducedMotion;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => advanceRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [duration, playing, contentKey]);

  return {
    rootRef,
    playing,
    reducedMotion,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocusCapture: () => setFocused(true),
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    },
  };
}

function HomeBroadcastControls({
  labels,
  activeIndex,
  onSelect,
}: {
  labels: string[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  return <div className="home-broadcast-controls">
    <div className="home-broadcast-pickers" role="group" aria-label="选择轮播内容">
      {labels.map((label, index) => <button
        type="button"
        className={index === activeIndex ? "is-active" : ""}
        aria-label={`显示${label}`}
        aria-current={index === activeIndex ? "true" : undefined}
        key={`${label}-${index}`}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(index);
        }}
      ><i aria-hidden /></button>)}
    </div>
  </div>;
}

function HomeWorldNewsWindow({ data, active = true }: { data: WorkbenchSummary; active?: boolean }) {
  const pages = useMemo<WorldNewsHomeLane[]>(() => {
    if (data.market.worldLanes?.length) return data.market.worldLanes;
    return [{
      id: "finance",
      label: "金融",
      href: "/markets?lane=finance",
      status: data.market.status,
      headline: data.market.headline,
      date: data.market.date ?? null,
      items: [
        ...(data.market.aiHotspots || []).map((event) => ({ id: event.id, title: event.title, tags: [event.category] })),
        ...(data.market.topEvents || []).map((event) => ({ id: event.id, title: event.title, tags: event.signalTags })),
      ],
    }];
  }, [data.market]);
  const [activeIndex, setActiveIndex] = useState(0);
  const gestureRef = useRef({ x: 0, y: 0, swiped: false });
  const lastWheelAtRef = useRef(0);
  const activePage = pages[activeIndex] || pages[0];
  const contentKey = activePage ? [activePage.headline, ...activePage.items.map((item) => item.title)].join("\n") : "";
  const broadcast = useHomeBroadcast({
    active,
    count: pages.length,
    contentKey,
    minimumDuration: WORLD_BROADCAST_MIN_MS,
    onAdvance: () => setActiveIndex((current) => (current + 1) % pages.length),
  });
  const move = (step: number) => {
    if (pages.length < 2) return;
    setActiveIndex((current) => (current + step + pages.length) % pages.length);
  };
  useEffect(() => {
    if (activeIndex < pages.length) return;
    setActiveIndex(0);
  }, [activeIndex, pages.length]);
  if (!activePage) return null;

  return (
    <section
      className="museum-card interactive-card market-pulse home-quiet home-aux home-world-window"
      ref={broadcast.rootRef}
      role="region"
      aria-roledescription="轮播"
      aria-label={`世界资讯，当前${activePage.label}，第 ${activeIndex + 1} 栏，共 ${pages.length} 栏`}
      tabIndex={0}
      onMouseEnter={broadcast.onMouseEnter}
      onMouseLeave={broadcast.onMouseLeave}
      onFocusCapture={broadcast.onFocusCapture}
      onBlurCapture={broadcast.onBlurCapture}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        move(event.key === "ArrowRight" ? 1 : -1);
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return;
        gestureRef.current = { x: event.clientX, y: event.clientY, swiped: false };
      }}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch") return;
        const dx = event.clientX - gestureRef.current.x;
        const dy = event.clientY - gestureRef.current.y;
        if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.35) gestureRef.current.swiped = true;
      }}
      onPointerUp={(event) => {
        if (event.pointerType !== "touch") return;
        const dx = event.clientX - gestureRef.current.x;
        const dy = event.clientY - gestureRef.current.y;
        const step = projectWindowSwipeStep(dx, dy);
        if (step) move(step);
      }}
      onWheel={(event) => {
        const step = projectWindowWheelStep(event.deltaX, event.deltaY);
        if (!step) return;
        event.preventDefault();
        const now = Date.now();
        if (now - lastWheelAtRef.current < 360) return;
        lastWheelAtRef.current = now;
        move(step);
      }}
    >
      <HomeBroadcastControls
        labels={pages.map((page) => page.label)}
        activeIndex={activeIndex}
        onSelect={setActiveIndex}
      />
      <a
        className="home-world-link"
        href={activePage.href}
        aria-label={`打开世界资讯 · ${activePage.label}`}
        onClick={(event) => {
          if (gestureRef.current.swiped) {
            event.preventDefault();
            gestureRef.current.swiped = false;
            return;
          }
          softNavigate(event, activePage.href);
        }}
      />
      <div className="home-broadcast-pages">
        {pages.map((page, index) => {
          const pageIsActive = index === activeIndex;
          const pageIsFinance = page.id === "finance";
          const pageEmptyCopy = page.status === "quiet" ? "今天没有够格的大事。" : "没有达到大事门槛的新消息。";
          const pageHotspotItems = pageIsFinance
            ? page.items.filter((item) => item.tags?.includes("AI热点"))
            : [];
          const pageEventItems = pageIsFinance
            ? page.items.filter((item) => !item.tags?.includes("AI热点"))
            : page.items;
          return <div
            className={`home-world-copy${pageIsActive ? " is-active" : ""}`}
            data-lane={page.id}
            data-broadcast-active={pageIsActive ? "true" : undefined}
            key={page.id}
            aria-hidden={pageIsActive ? undefined : true}
            aria-live={pageIsActive && !broadcast.playing ? "polite" : "off"}
          >
            <HomeCardHeading
              eyebrow={pageIsFinance ? "市场简报" : "世界资讯"}
              title={pageIsFinance ? "金融资讯" : page.label}
              meta={page.date ? `简报 ${page.date}` : "每日早间汇总"}
            />
            <p><HomeScrollingText text={page.status === "quiet" && !page.items.length ? pageEmptyCopy : page.headline} active={active && pageIsActive} playing={pageIsActive && broadcast.playing} /></p>
            {pageHotspotItems.length ? <ul className="market-ai-hotspots">{pageHotspotItems.map((item) => <li key={item.id}><span className="market-hotspot-tag">AI热点</span><HomeScrollingText text={item.title} active={active && pageIsActive} playing={pageIsActive && broadcast.playing} /></li>)}</ul> : null}
            {pageEventItems.length
              ? <ul className="market-top-events">{pageEventItems.map((item) => <li key={item.id}>{(item.tags || []).map((tag) => <em key={tag} className="market-signal-tag" data-tag={tag}>{tag}</em>)}<HomeScrollingText text={item.title} active={active && pageIsActive} playing={pageIsActive && broadcast.playing} /></li>)}</ul>
              : pageHotspotItems.length ? null : <Empty>{pageEmptyCopy}</Empty>}
          </div>;
        })}
      </div>
    </section>
  );
}

function HomeScrollingText({ text: content, active, playing }: { text: string; active: boolean; playing: boolean }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const copyRef = useRef<HTMLSpanElement>(null);
  const animationRef = useRef<Animation | undefined>(undefined);
  const playingRef = useRef(playing);
  const [overflowing, setOverflowing] = useState(false);
  playingRef.current = playing;

  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const copy = copyRef.current;
    if (!active || !viewport || !track || !copy) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const measure = () => {
      animationRef.current?.cancel();
      animationRef.current = undefined;
      const shouldScroll = !reducedMotion.matches && viewport.clientWidth > 0 && copy.scrollWidth > viewport.clientWidth + 1;
      setOverflowing(shouldScroll);
      if (!shouldScroll) return;
      const distance = copy.scrollWidth + BROADCAST_TEXT_GAP_PX;
      animationRef.current = track.animate([
        { transform: "translateX(0)" },
        { transform: `translateX(-${distance}px)` },
      ], {
        delay: BROADCAST_TEXT_DELAY_MS,
        duration: distance / BROADCAST_TEXT_SPEED_PX_S * 1000,
        iterations: Infinity,
        easing: "linear",
        fill: "both",
      });
      if (!playingRef.current || document.hidden) animationRef.current.pause();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(copy);
    reducedMotion.addEventListener("change", measure);
    measure();
    return () => {
      observer.disconnect();
      animationRef.current?.cancel();
      animationRef.current = undefined;
      reducedMotion.removeEventListener("change", measure);
    };
  }, [content, active]);

  useEffect(() => {
    if (playing && !document.hidden) animationRef.current?.play();
    else animationRef.current?.pause();
  }, [playing]);

  return <span ref={viewportRef} className="home-scrolling-text" title={content} data-broadcast-viewport>
    <span ref={trackRef} className="home-scrolling-track">
      <span ref={copyRef} className="home-scrolling-copy" data-broadcast-copy>{content}</span>
      {overflowing ? <span className="home-scrolling-copy" aria-hidden>{content}</span> : null}
    </span>
  </span>;
}

function HomeStockWindow({ live, liveStamp, active = true }: { live: MarketLiveSnapshot | null; liveStamp: string; active?: boolean }) {
  const pages = [
    { id: "watchlist", title: "美股看板", rows: live?.stocks || [] },
    { id: "everbright", title: "A股看板", rows: live?.holdingStocks || [] },
  ];
  const [activeIndex, setActiveIndex] = useState(0);
  const gestureRef = useRef({ x: 0, y: 0, swiped: false });
  const lastWheelAtRef = useRef(0);
  const activePage = pages[activeIndex];
  const contentKey = activePage.rows.map((stock) => stock.label || stock.symbol).join("\n");
  const broadcast = useHomeBroadcast({
    active,
    count: pages.length,
    contentKey,
    minimumDuration: STOCK_BROADCAST_MIN_MS,
    onAdvance: () => setActiveIndex((current) => (current + 1) % pages.length),
  });
  const move = (step: number) => {
    setActiveIndex((current) => (current + step + pages.length) % pages.length);
  };

  return <section
    className="museum-card interactive-card card-link stocks-pulse home-quiet home-aux home-stock-window"
    ref={broadcast.rootRef}
    role="region"
    aria-roledescription="轮播"
    aria-label={`${activePage.title}，股市行情，当前第 ${activeIndex + 1} 页，共 ${pages.length} 页`}
    tabIndex={0}
    onMouseEnter={broadcast.onMouseEnter}
    onMouseLeave={broadcast.onMouseLeave}
    onFocusCapture={broadcast.onFocusCapture}
    onBlurCapture={broadcast.onBlurCapture}
    onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      move(event.key === "ArrowRight" ? 1 : -1);
    }}
    onPointerDown={(event) => {
      if (event.pointerType !== "touch") return;
      gestureRef.current = { x: event.clientX, y: event.clientY, swiped: false };
    }}
    onPointerMove={(event) => {
      if (event.pointerType !== "touch") return;
      const dx = event.clientX - gestureRef.current.x;
      const dy = event.clientY - gestureRef.current.y;
      if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.35) gestureRef.current.swiped = true;
    }}
    onPointerUp={(event) => {
      if (event.pointerType !== "touch") return;
      const dx = event.clientX - gestureRef.current.x;
      const dy = event.clientY - gestureRef.current.y;
      const step = projectWindowSwipeStep(dx, dy);
      if (step) move(step);
    }}
    onWheel={(event) => {
      const step = projectWindowWheelStep(event.deltaX, event.deltaY);
      if (!step) return;
      event.preventDefault();
      const now = Date.now();
      if (now - lastWheelAtRef.current < 360) return;
      lastWheelAtRef.current = now;
      move(step);
    }}
  >
    <HomeBroadcastControls
      labels={pages.map((page) => page.title)}
      activeIndex={activeIndex}
      onSelect={setActiveIndex}
    />
    <a
      className="card-stretch-link"
      href="/markets/assets"
      aria-label="打开资产管理"
      onClick={(event) => {
        if (gestureRef.current.swiped) {
          event.preventDefault();
          gestureRef.current.swiped = false;
          return;
        }
        softNavigate(event, "/markets/assets");
      }}
    />
    <div className="home-broadcast-pages">
      {pages.map((page, index) => {
        const pageIsActive = index === activeIndex;
        return <div
          className={`home-stock-copy${pageIsActive ? " is-active" : ""}`}
          data-broadcast-active={pageIsActive ? "true" : undefined}
          key={page.id}
          aria-hidden={pageIsActive ? undefined : true}
          aria-live={pageIsActive && !broadcast.playing ? "polite" : "off"}
        >
          <HomeCardHeading eyebrow="股市行情" title={page.title} meta={<span className="live-meta"><em>{liveStamp}</em></span>} />
          {/* 涨跌色：红跌绿涨（本人习惯；不是 A 股常见的红涨绿跌），勿改反 */}
          <div className="live-quotes">{page.rows.length ? page.rows.map((stock) => {
            const price = formatMarketPriceParts(stock.price, stock.currency);
            return <div
              key={stock.symbol}
              className={stock.changePercent == null ? "flat" : stock.changePercent >= 0 ? "up" : "down"}
              aria-label={`${stock.name}，${price.label}，${formatMarketPercent(stock.changePercent)}`}
            ><strong title={stock.name}><HomeScrollingText text={stock.label || stock.symbol} active={active && pageIsActive} playing={pageIsActive && broadcast.playing} /></strong><span className="live-quote-currency" aria-hidden>{price.currency}</span><span className="live-quote-amount">{price.amount}</span><small>{formatMarketPercent(stock.changePercent)}</small></div>;
          }) : <Empty>{live?.message || "正在读行情…"}</Empty>}</div>
        </div>;
      })}
    </div>
  </section>;
}

function formatFxDate(date: string) {
  return date.slice(5).replace("-", "/");
}

function fxTrendDateRange(rows: MarketLiveSnapshot["fx"]) {
  const dates = rows.flatMap((row) => row.trend ?? []).map((point) => point.date).filter(Boolean).sort();
  if (dates.length < 2) return null;
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last || first === last) return null;
  return { first, last };
}

function smoothSparkPath(points: Array<{ x: number; y: number }>) {
  if (points.length < 2) return "";
  const fmt = (value: number) => value.toFixed(2);
  const clampY = (value: number) => Math.min(27, Math.max(1, value));
  if (points.length === 2) return `M${fmt(points[0].x)} ${fmt(points[0].y)} L${fmt(points[1].x)} ${fmt(points[1].y)}`;
  let path = `M${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] ?? next;
    const control1x = current.x + (next.x - previous.x) / 6;
    const control1y = clampY(current.y + (next.y - previous.y) / 6);
    const control2x = next.x - (after.x - current.x) / 6;
    const control2y = clampY(next.y - (after.y - current.y) / 6);
    path += ` C${fmt(control1x)} ${fmt(control1y)} ${fmt(control2x)} ${fmt(control2y)} ${fmt(next.x)} ${fmt(next.y)}`;
  }
  return path;
}

function FxSparkline({ label, points }: { label: string; points: Array<{ date: string; value: number }> }) {
  const series = points.filter((point) => Number.isFinite(point.value));
  if (series.length < 2) return <svg className="fx-spark" viewBox="0 0 88 28" aria-hidden="true" />;
  const values = series.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max) * 0.002, 0.00001);
  const coordinates = series.map((point, index) => ({
    x: 1 + index / (series.length - 1) * 86,
    y: 3 + (max - point.value) / span * 22,
  }));
  const first = series[0];
  const last = series[series.length - 1];
  return <svg className="fx-spark" viewBox="0 0 88 28" preserveAspectRatio="none" role="img" aria-label={`${label}近两周从 ${first.value} 变为 ${last.value}`}>
    <path className="fx-spark-line" d={smoothSparkPath(coordinates)} />
  </svg>;
}

export default function HomePage({ data, calendar, secretaryName, active = true, refreshSummary, onAskSecretary }: { data: WorkbenchSummary; calendar: CalendarSnapshot; secretaryName: string; active?: boolean; refreshSummary?: () => void; onAskSecretary?: (seedUser: string) => void }) {
  const jp = data.japanese.progress?.total
    ? data.japanese.progress.learned / data.japanese.progress.total * 100
    : null;
  const japaneseStudy = data.japanese.studySummary;
  const hasDailyAnkiActivity = (japaneseStudy.anki.reviewCount || 0) > 0 || (japaneseStudy.anki.durationMinutes || 0) > 0;
  const todayKey = tokyoDateKey(new Date());
  const activeTodos = data.projectManagement
    ? [...buildCurrentExecutionRows(data.projectManagement.currentTodos, todayKey), ...buildAiExecutionRows(data.projectManagement.currentTodos)].slice(0, 4)
    : data.todo.today.filter((item) => !item.done && isTodoInNextTwoTokyoDays(item.text, todayKey)).slice(0, 4);
  const nearEventCount = calendar.events.filter((event) => isNearTermTokyoInstant(event.start)).length;
  const [pins, setPins] = useState<HomePins>({ topicIds: [], likedCourseIds: [], researchDomainId: "zztj" });
  const [live, setLive] = useState<MarketLiveSnapshot | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    jsonFetch<HomePins>("/api/home-pins")
      .then((next) => { if (!cancelled) setPins(next); })
      .catch(() => { if (!cancelled) setPins({ topicIds: [], likedCourseIds: [], researchDomainId: "zztj" }); });
    return () => { cancelled = true; };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = () => jsonFetch<MarketLiveSnapshot>("/api/market-live").then((next) => { if (!cancelled) setLive(next); }).catch(() => { if (!cancelled) setLive({ available: false, stocks: [], holdingStocks: [], fx: [], refreshedAt: null, message: "行情暂不可用" }); });
    load();
    const timer = window.setInterval(load, MARKET_LIVE_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active]);
  useEffect(() => {
    if (!active || !refreshSummary) return;
    const maybeRefreshBrief = () => {
      const today = tokyoDateKey(new Date());
      if (data.market.date && data.market.date === today) return;
      invalidateSection("markets");
      refreshSummary();
    };
    const onVis = () => { if (document.visibilityState === "visible") maybeRefreshBrief(); };
    document.addEventListener("visibilitychange", onVis);
    const timer = window.setInterval(maybeRefreshBrief, BRIEF_STALE_CHECK_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(timer);
    };
  }, [active, data.market.date, refreshSummary]);
  const plan = data.health.todayPlan;
  const stale = data.health.staleMuscles ?? [];
  const staleShown = stale.slice(0, 4);
  const liveStamp = live?.refreshedAt ? `${fmtTime(live.refreshedAt)} 更新` : "读取中";
  const fxRows = live?.available ? live.fx : [];
  const fxRange = fxTrendDateRange(fxRows);
  const pinnedDomain = isResearchDomainId(pins.researchDomainId)
    ? researchDomainHomeMeta(pins.researchDomainId, data.library.topics)
    : null;
  return <div className="home-dashboard">
    <section className="home-priority-grid">
      <CardLink className="agenda-todo-card home-lead" href="/schedule" label="打开日程安排">
        <HomeCardHeading
          eyebrow="今日"
          title="日程安排"
          meta={<>近 2 日 {nearEventCount} 项日程 · {activeTodos.length} 项待办</>}
          lead
        />
        <div className="agenda-todo-split">
          <div className="agenda-pane"><Kicker>日程</Kicker><DayTimeline calendar={calendar} compact /></div>
          <div className="todo-pane">
            <Kicker>待办</Kicker>
            {activeTodos.length
              ? <div className={`focus-list todo-count-${Math.min(activeTodos.length, 3)}`}>{activeTodos.slice(0, 3).map((task, i) => {
                  const summary = "displayText" in task && task.displayText
                    ? task.displayText
                    : formatHomeTodoSummary(task.text);
                  return <div key={task.text}><span>0{i + 1}</span><p>{summary}</p></div>;
                })}</div>
              : <Empty>今日事已了<br />闲看庭前花</Empty>}
          </div>
        </div>
      </CardLink>
      {pinnedDomain ? (
        <CardLink className={`topics-pin-card home-quiet home-knowledge-map-card home-domain-${pinnedDomain.id}`} href={`/topics?domain=${pinnedDomain.id}&branch=${pinnedDomain.defaultBranch}`} label={`打开置顶知识地图：${pinnedDomain.title}`}>
          <HomeCardHeading eyebrow="置顶知识地图" title={pinnedDomain.title} meta={pinnedDomain.mark} />
          <div className="home-map-current">
            <span>{pinnedDomain.focusLabel}</span>
            <strong>{pinnedDomain.focusTitle}</strong>
            {pinnedDomain.focusText ? <p>{pinnedDomain.focusText}</p> : null}
          </div>
          <div className="home-map-bookmarks" aria-label={`${pinnedDomain.title}知识地图索引`}>
            {pinnedDomain.highlights.map((highlight) => <span key={highlight}>{highlight}</span>)}
          </div>
          <small className="home-map-next">{pinnedDomain.nextLabel}</small>
        </CardLink>
      ) : (
        <CardLink className="topics-pin-card home-quiet home-knowledge-map-card is-empty" href="/topics" label="选择要置顶到首页的知识地图">
          <HomeCardHeading eyebrow="置顶知识地图" title="还没有置顶" />
          <Empty>还没有置顶的知识地图。去专题研究里点亮星星，随时从这里继续。</Empty>
        </CardLink>
      )}
    </section>
    <section className="home-signal-grid">
      <HomeProjectWindow data={data} />
      <CardLink className="jp-pulse home-quiet" href="/languages" label="打开语言学习">
        <HomeCardHeading eyebrow="语言学习" title="日语 · N2备考" />
        <div className="jp-pulse-top">
          <ProgressRing value={jp} />
          <div className="jp-today-total">
            <span>今日练习总时长</span>
            <strong><StudyDuration value={japaneseStudy.totalDurationMinutes} /></strong>
            <small>其中口语 <StudyDuration value={japaneseStudy.oral.durationMinutes} compact /></small>
          </div>
        </div>
        <div className="jp-source-ledger">
          <a className="jp-source-anki" href={ANKIWEB_DECKS_URL} target="_blank" rel="noopener noreferrer" aria-label="打开 AnkiWeb 背词">
            <span>Anki</span>
            <strong>{!hasDailyAnkiActivity
              ? (data.japanese.progress ? <span className="home-data">{data.japanese.progress.learned} / {data.japanese.progress.total}</span> : "未同步")
              : <StudyDuration value={japaneseStudy.anki.durationMinutes} compact />}</strong>
          </a>
          <div>
            <span>专项</span>
            <strong>{japaneseStudy.special?.durationMinutes == null
              ? "未记录"
              : <StudyDuration value={japaneseStudy.special.durationMinutes} compact />}</strong>
          </div>
          <div>
            <span>阅读</span>
            <strong>{japaneseStudy.reading?.durationMinutes == null
              ? "未记录"
              : <StudyDuration value={japaneseStudy.reading.durationMinutes} compact />}</strong>
          </div>
          <div>
            <span>考试</span>
            <strong>{japaneseStudy.exam?.durationMinutes == null
              ? "未记录"
              : <StudyDuration value={japaneseStudy.exam.durationMinutes} compact />}</strong>
          </div>
        </div>
      </CardLink>
      <CardLink className="health-pulse home-quiet" href="/health" label="打开身心健康">
        <HomeCardHeading eyebrow="身心 · 今日" title={plan?.title || "今日训练"} />
        <p className="health-weekday">{plan?.weekday || "—"}</p>
        <div className="health-latest"><span>最近训练</span><strong>{data.health.latestTraining || "还没记过"}</strong></div>
        {staleShown.length ? (
          <>
            <div className="stale-grid-label">太久没练</div>
            <div className="stale-grid">
              {staleShown.map((item) => (
                <div key={item.id} className={item.status}>
                  <strong>{item.label}</strong>
                  <span><b className="home-data">{item.daysSince}</b> 天</span>
                </div>
              ))}
            </div>
            {stale.length > staleShown.length ? <small className="health-fresh">还有 {stale.length - staleShown.length} 块</small> : null}
          </>
        ) : <small className="health-fresh">各部位节奏正常 · {data.health.weight}</small>}
        {data.health.life?.overdueWeeks != null && data.health.life.overdueWeeks >= 4 ? (
          <small className="health-fresh">平衡 · 已超过 {data.health.life.overdueWeeks} 周未校准自评</small>
        ) : null}
      </CardLink>
    </section>
    <section className="home-finance-grid">
      <HomeWorldNewsWindow data={data} active={active} />
      <HomeStockWindow live={live} liveStamp={liveStamp} active={active} />
      <CardLink className="fx-pulse home-quiet home-aux" href="/markets/assets" label="打开资产管理">
        <HomeCardHeading eyebrow="外汇行情" title="汇率看板" meta={<span className="live-meta"><em>{liveStamp}</em></span>} />
        <div className="fx-board">
          {fxRows.length
            ? fxRows.map((row) => <div className="fx-rate-row" key={row.pair}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
              <small>{row.pair}</small>
              <FxSparkline label={row.label} points={row.trend ?? []} />
            </div>)
            : <Empty>{live?.message || "正在读汇率…"}</Empty>}
          {fxRange ? <p className="fx-range"><time dateTime={fxRange.first}>{formatFxDate(fxRange.first)}</time><span>至</span><time dateTime={fxRange.last}>{formatFxDate(fxRange.last)}</time></p> : null}
        </div>
      </CardLink>
    </section>
  </div>;
}
