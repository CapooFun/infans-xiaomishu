import { useEffect, useState, type CSSProperties, type RefObject } from "react";

/** 窄屏软键盘避让：用 visualViewport 把浮层钉在可见区内（微信式上浮）。 */
export function useIsNarrowViewport(maxWidth = 900) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width: ${maxWidth}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [maxWidth]);
  return narrow;
}

type ViewportBoxMode = "fullscreen" | "exam-sheet";

type VisualBox = { top: number; left: number; width: number; height: number };

function readVisualBox(): VisualBox {
  const vv = window.visualViewport;
  if (vv) {
    return {
      top: Math.round(vv.offsetTop),
      left: Math.round(vv.offsetLeft),
      width: Math.max(1, Math.round(vv.width)),
      height: Math.max(1, Math.round(vv.height)),
    };
  }
  return {
    top: 0,
    left: 0,
    width: Math.max(1, Math.round(window.innerWidth)),
    height: Math.max(1, Math.round(window.innerHeight)),
  };
}

function lockPageScroll() {
  if (window.scrollY || window.scrollX || document.documentElement.scrollTop || document.body.scrollTop) {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
}

function writeCssVars(box: VisualBox, mode: ViewportBoxMode) {
  const root = document.documentElement;
  if (mode === "exam-sheet") {
    const sheet = Math.min(Math.round(box.height * 0.46), 420, Math.max(220, box.height - 24));
    root.style.setProperty("--ai-vv-top", `${box.top + box.height - sheet}px`);
    root.style.setProperty("--ai-vv-height", `${sheet}px`);
  } else {
    root.style.setProperty("--ai-vv-top", `${box.top}px`);
    root.style.setProperty("--ai-vv-height", `${box.height}px`);
  }
  root.style.setProperty("--ai-vv-left", `${box.left}px`);
  root.style.setProperty("--ai-vv-width", `${box.width}px`);
}

function clearCssVars() {
  const root = document.documentElement;
  root.style.removeProperty("--ai-vv-top");
  root.style.removeProperty("--ai-vv-height");
  root.style.removeProperty("--ai-vv-left");
  root.style.removeProperty("--ai-vv-width");
}

/**
 * 窄屏梅凝：用 CSS 变量钉到 visualViewport。
 * 不用 inline top/height 去和 CSS inset 打架；键盘动画期间轮询几帧。
 */
export function useVisualViewportBox(
  elementRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  mode: ViewportBoxMode = "fullscreen",
) {
  useEffect(() => {
    if (!enabled) {
      clearCssVars();
      return;
    }

    let cancelled = false;
    let pollTimer = 0;
    let raf = 0;

    const apply = () => {
      if (cancelled) return;
      lockPageScroll();
      writeCssVars(readVisualBox(), mode);
    };

    const sync = () => {
      apply();
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        apply();
        raf = requestAnimationFrame(apply);
      });
    };

    /** 键盘弹出约 300–400ms，期间 VV 会连续变；只靠一次 resize 经常钉在半高 */
    const startKeyboardPoll = () => {
      window.clearInterval(pollTimer);
      let n = 0;
      pollTimer = window.setInterval(() => {
        apply();
        if (++n >= 40) window.clearInterval(pollTimer);
      }, 16);
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.tagName !== "TEXTAREA" && target.tagName !== "INPUT") return;
      sync();
      startKeyboardPoll();
    };

    const onFocusOut = () => {
      window.setTimeout(sync, 50);
      window.setTimeout(sync, 320);
    };

    sync();
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      window.clearInterval(pollTimer);
      window.visualViewport?.removeEventListener("resize", sync);
      window.visualViewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      clearCssVars();
      // elementRef 仅用于确保面板已挂载；几何全走 CSS 变量
      void elementRef;
    };
  }, [elementRef, enabled, mode]);
}

/** 给 modal-backdrop 一类全屏遮罩：尺寸跟上可视区。 */
export function useVisualViewportBackdropStyle(
  enabled: boolean,
  alignItems: CSSProperties["alignItems"] = "flex-end",
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    if (!enabled) {
      setStyle(undefined);
      return;
    }
    const sync = () => {
      const box = readVisualBox();
      lockPageScroll();
      setStyle({
        position: "fixed",
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        bottom: "auto",
        right: "auto",
        paddingTop: "max(12px, env(safe-area-inset-top, 0px))",
        paddingBottom: "max(12px, env(safe-area-inset-bottom, 0px))",
        alignItems,
        overflow: "auto",
        background: "var(--surface-2)",
      });
    };
    sync();
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      window.visualViewport?.removeEventListener("resize", sync);
      window.visualViewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [enabled, alignItems]);
  return style;
}
