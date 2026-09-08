import { useEffect, useRef } from "react";
import "./visual-effects.css";

/** Stationary light only: no camera movement, pointer tracking or rendering loop. */
export function SceneAtmosphere({ room = false, active = true, theme = "night" }: { room?: boolean; active?: boolean; theme?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => { layer.dataset.motion = !active || document.hidden || reduced.matches ? "paused" : "running"; };
    document.addEventListener("visibilitychange", sync);
    reduced.addEventListener("change", sync);
    sync();
    return () => { document.removeEventListener("visibilitychange", sync); reduced.removeEventListener("change", sync); };
  }, [active]);
  return <div ref={ref} className={`scene-atmosphere${room ? " scene-atmosphere--room" : ""}`} data-theme={theme} data-motion="paused" aria-hidden="true" />;
}
