import { useEffect, useState } from "react";
import { Check, Moon, Sparkles, Sun } from "lucide-react";
import { INTERACTION_MOTION_EVENT, type InteractionCue } from "../interaction-motion";
import "./interaction-feedback.css";

export function InteractionFeedback() {
  const [cue, setCue] = useState<(InteractionCue & { id: number }) | null>(null);
  useEffect(() => {
    let serial = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(timer); setCue(null); };
    const receive = (event: Event) => {
      const next = (event as CustomEvent<InteractionCue>).detail;
      if (!next || !["theme", "arrival", "complete"].includes(next.kind)) return;
      clearTimeout(timer);
      setCue({ ...next, id: ++serial });
      timer = setTimeout(clear, next.kind === "arrival" ? 1800 : 1300);
    };
    const visibility = () => { if (document.hidden) clear(); };
    window.addEventListener(INTERACTION_MOTION_EVENT, receive);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(INTERACTION_MOTION_EVENT, receive);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  if (!cue) return null;
  return <div key={cue.id} className={`interaction-feedback is-${cue.kind}`} aria-hidden="true">
    <div className="interaction-feedback-seal">
      <i className="interaction-feedback-orbit" />
      {cue.kind === "arrival" && cue.portrait
        ? <img src={cue.portrait} alt="" />
        : cue.kind === "arrival" ? <Sparkles size={25} strokeWidth={1.4} />
          : cue.kind === "complete" ? <Check size={28} strokeWidth={1.8} />
          : cue.label === "晴岚" ? <Sun size={25} strokeWidth={1.4} /> : <Moon size={25} strokeWidth={1.4} />}
    </div>
    <div className="interaction-feedback-copy"><span>{cue.kind === "arrival" ? "此刻相伴" : cue.kind === "complete" ? "又落定一件" : "山窗换景"}</span><strong>{cue.label}</strong></div>
    <i className="interaction-feedback-line" />
  </div>;
}
