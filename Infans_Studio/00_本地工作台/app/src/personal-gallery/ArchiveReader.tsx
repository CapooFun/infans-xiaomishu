import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Moon, Type } from "lucide-react";
import "./archive-reader.css";

/** Native dialog supplies focus containment, inert background and focus restoration. */
export function ArchiveReader({ title, eyebrow, children, onClose, letter = false, closeLabel }: { closeLabel?: string; title: string; eyebrow?: string; children: ReactNode; onClose: () => void; letter?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  const [plain, setPlain] = useState(false);
  const [large, setLarge] = useState(false);
  const [night, setNight] = useState(false);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => { clearTimeout(timer.current); dialog.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const close = () => {
    if (closing) return;
    setClosing(true);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) onClose();
    else timer.current = setTimeout(onClose, 180);
  };
  return <dialog ref={ref} className={`archive-reader${letter ? " archive-reader--letter" : ""}${closing ? " is-closing" : ""}${plain ? " is-plain" : ""}${large ? " is-large" : ""}${night ? " is-night" : ""}`} aria-labelledby="archive-reader-title" onCancel={(e) => { e.preventDefault(); e.stopPropagation(); close(); }} onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation(); }}>
    <header className="archive-reader__tools">
      <button type="button" onClick={close}><ArrowLeft size={17} /><span>{closeLabel || (letter ? "收好信笺" : "回到长廊")}</span></button>
      <div>
        {letter ? <button type="button" aria-pressed={night} onClick={() => setNight(!night)} aria-label={night ? "切换浅色信纸" : "切换夜读信纸"}><Moon size={17}/></button> : null}
        {letter ? <button type="button" aria-pressed={plain} onClick={() => setPlain(!plain)}><Type size={17}/><span>{plain ? "文楷" : "普通字体"}</span></button> : null}
        <button type="button" aria-pressed={large} onClick={() => setLarge(!large)} aria-label={large ? "恢复字号" : "放大字号"}>A{large ? "−" : "+"}</button>
      </div>
    </header>
    <div className="archive-reader__scroll">
      {letter ? <div className="archive-reader__opening-envelope" aria-hidden="true"><span/></div> : null}
      <article className="archive-reader__paper">
        <div className="archive-reader__fold" aria-hidden="true" />
        <p className="archive-reader__eyebrow">{eyebrow}</p>
        <h2 id="archive-reader-title">{title}</h2>
        <div className="archive-reader__body">{children}</div>
        <span className="archive-reader__end" aria-hidden="true">·</span>
      </article>
    </div>
  </dialog>;
}
