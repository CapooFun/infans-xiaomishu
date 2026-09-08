import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, Compass, X } from "lucide-react";
import { motion } from "motion/react";
import { jsonFetch, SourceLink } from "../page-shared";
import type { HealthSectionData, WorkbenchSummary } from "../types";
import { ArchiveReader } from "./ArchiveReader";
import "./personal-gallery.css";

type Exhibit = NonNullable<WorkbenchSummary["identity"]["gallery"]>[number];
type Reading = { kind: "exhibit"; exhibit: Exhibit } | { kind: "compass" };

export function PersonalGallery({ data, onClose }: { data: WorkbenchSummary; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [chapter, setChapter] = useState("opening");
  const [reading, setReading] = useState<Reading | null>(null);
  const [health, setHealth] = useState<HealthSectionData | null>(null);
  const [status, setStatus] = useState("loading");
  const [attempt, setAttempt] = useState(0);
  const gallery = data.identity.gallery || [];
  const life = health?.life;
  useEffect(() => {
    const el = dialog.current!; const previous = document.activeElement; el.showModal();
    return () => { el.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    jsonFetch<{ data: HealthSectionData }>("/api/sections/health", { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setHealth(result.data); setStatus("ready"); }
    }).catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const root = scroll.current!;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) setChapter(entry.target.id.replace("gallery-", ""));
    }, { root, rootMargin: "-15% 0px -65% 0px" });
    root.querySelectorAll("[data-chapter]").forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  const go = (id: string) => {
    const target = scroll.current?.querySelector<HTMLElement>(`#gallery-${id}`);
    target?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    target?.focus({ preventScroll: true });
  };
  const sourceByName = (name: string) => health?.sources.find(source => source.path.endsWith(name))?.path;
  const steps = life?.toolbox?.choiceSteps;
  const choiceSteps = steps ? [["大事", steps.topic],["生成",steps.generate],["收窄",steps.narrow],["选定",steps.choose],["放手",steps.letGo]].filter(([,value]) => value) : [];
  const state = status === "error" ? <div role="status" className="gallery-state">身份档案暂时没能读取。<button type="button" onClick={() => setAttempt(attempt + 1)}>重新读取</button></div> : status === "loading" ? <p role="status" className="gallery-state">正在读取身份档案…</p> : null;
  const exhibits = (era: "past" | "current") => gallery.filter(item => item.era === era).map(item => <motion.article className={`gallery-exhibit exhibit-${item.id}`} key={item.id} initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ root: scroll, once: true, amount: .15 }} transition={{ duration: .55 }}>
    <div className="gallery-exhibit__date"><span aria-hidden="true"/><time>{item.year}</time></div>
    <button type="button" className="gallery-exhibit__content" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setReading({ kind: "exhibit", exhibit: item }); }} aria-label={`展开：${item.title}`}>
      <span className="gallery-exhibit__folio" aria-hidden="true">{item.year.slice(0,4)}<i>{item.title.slice(0,1)}</i></span>
      <span className="gallery-exhibit__copy"><strong>{item.title}</strong><span>{item.summary}</span><small>展开这一页 <ArrowUpRight size={15}/></small></span>
    </button>
  </motion.article>);
  return <dialog ref={dialog} className="personal-gallery" aria-label="人生长廊" onCancel={e => { e.preventDefault(); e.stopPropagation(); if (!reading) onClose(); }} onKeyDown={e => { if (e.key === "Escape") e.stopPropagation(); }}>
    <header className="gallery-header"><button className="gallery-wordmark" type="button" onClick={() => go("opening")}>我</button><nav aria-label="长廊章节">{[["past","过去"],["current","现在"],["future","未来"]].map(([id,label]) => <button type="button" aria-current={chapter === id ? "location" : undefined} key={id} onClick={() => go(id)}>{label}</button>)}</nav><div><button type="button" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setReading({ kind: "compass" }); }} aria-label="打开方向说明"><Compass size={18}/><span>方向</span></button><button type="button" onClick={onClose} aria-label="关闭人生长廊"><X size={20}/></button></div></header>
    <div className="gallery-scroll" ref={scroll}>
      <section className="gallery-opening" id="gallery-opening" data-chapter tabIndex={-1}>
        <div className="gallery-opening__text"><p className="gallery-kicker">个人纪事 · 来处 / 此刻 / 去向</p><h1>一路走来，<br/><em>仍在成为。</em></h1><p className="gallery-opening__intro">{data.identity.current.intro}</p><button type="button" className="gallery-begin" onClick={() => go("past")}><ArrowDown size={18}/> 沿着时间，往前走</button></div>
        <div className="gallery-frontispiece" aria-hidden="true"><div className="gallery-frontispiece__orbit"/><span className="gallery-frontispiece__name">我</span><span className="gallery-frontispiece__seal">记录</span><span className="gallery-frontispiece__caption">INFANS</span><span className="gallery-frontispiece__date">至今</span></div>
      </section>
      <section className="gallery-chapter" id="gallery-past" data-chapter tabIndex={-1}><header className="gallery-chapter__title"><span>来处</span><div><p className="gallery-kicker">过去 · 留下的足迹</p><h2>走过的路，<br/>都在今天。</h2><p>{data.identity.past.intro}</p></div></header><div className="gallery-timeline">{exhibits("past")}</div>{!gallery.length ? <div className="gallery-roles">{data.identity.past.roles.map(role => <p key={role}>{role}</p>)}</div> : null}</section>
      <section className="gallery-chapter gallery-chapter--current" id="gallery-current" data-chapter tabIndex={-1}><header className="gallery-chapter__title"><span>此刻</span><div><p className="gallery-kicker">现在 · 正在投入的生活</p><h2>{data.identity.current.title}</h2></div></header><div className="gallery-timeline">{exhibits("current")}</div><div className="gallery-roles" aria-label="当前角色">{data.identity.current.roles.map(role => <p key={role}>{role}</p>)}</div></section>
      <section className="gallery-chapter gallery-chapter--future" id="gallery-future" data-chapter tabIndex={-1}><header className="gallery-chapter__title"><span>去向</span><div><p className="gallery-kicker">未来 · 可选路径</p><h2>路还在展开。</h2><p>把想走的路、可用的条件与代价，放在一起看看。</p></div></header>{state}<div className="gallery-paths">{life?.odyssey?.plans.map(plan => <details key={plan.id} className="gallery-path"><summary><span className="gallery-path__letter">{plan.id}</span><strong>{plan.title}</strong><span className="gallery-path__action">展开这条路 <ArrowUpRight size={16}/></span></summary><p>{plan.blurb}</p><div className="gallery-path__scores">{plan.scores.map(score => <div key={score.dim}><span>{score.dim}</span><strong>{score.score == null ? "—" : `${score.score}/10`}</strong>{score.note ? <p>{score.note}</p> : null}</div>)}</div></details>)}</div><button type="button" className="gallery-northstar" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setReading({ kind: "compass" }); }}><Compass size={26}/><span><strong>方向说明</strong><small>人生观、工作观与做选择时的指引</small></span><ArrowUpRight size={18}/></button></section>
      <footer className="gallery-footer"><span>我 · 人生长廊</span><SourceLink path={data.identity.source.path} label="策展与来源"/><button type="button" onClick={() => go("opening")}>回到开篇 ↑</button></footer>
    </div>
    {reading ? <ArchiveReader title={reading.kind === "exhibit" ? reading.exhibit.title : "方向说明"} eyebrow={reading.kind === "exhibit" ? `${reading.exhibit.year} · 人生长廊` : "身份档案（开源示例为空）"} onClose={() => setReading(null)}>
      {reading.kind === "exhibit" ? <><p>{reading.exhibit.detail}</p><SourceLink path={reading.exhibit.source} label="查看这段经历的来源"/></> : <>{state}{life ? <><section><h3>人生观</h3><blockquote>{life.compass.lifeview}</blockquote>{life.compass.lifeviewBody.map((paragraph,i) => <p key={i}>{paragraph}</p>)}{sourceByName("人生观.md") ? <SourceLink path={sourceByName("人生观.md")!} label="人生观原文"/> : null}</section><section><h3>工作观</h3><blockquote>{life.compass.workview}</blockquote>{life.compass.workviewBody.map((paragraph,i) => <p key={i}>{paragraph}</p>)}{sourceByName("工作观.md") ? <SourceLink path={sourceByName("工作观.md")!} label="工作观原文"/> : null}</section><section><h3>选择与卡住时</h3>{choiceSteps.map(([label,value]) => <p key={label}><strong>{label}</strong><br/>{value}</p>)}{life.toolbox?.stuckNote ? <blockquote>{life.toolbox.stuckNote}</blockquote> : null}{sourceByName("人生设计校准.md") ? <SourceLink path={sourceByName("人生设计校准.md")!} label="选择方法原文"/> : null}</section></> : null}</>}
    </ArchiveReader> : null}
  </dialog>;
}
