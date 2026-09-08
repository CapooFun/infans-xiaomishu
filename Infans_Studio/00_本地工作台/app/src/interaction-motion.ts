import { flushSync } from "react-dom";

export const INTERACTION_MOTION_EVENT = "infans:interaction-motion";
export type InteractionCue =
  | { kind: "theme"; label: string }
  | { kind: "arrival"; label: string; portrait?: string }
  | { kind: "complete"; label: string };

let activeTransition: ViewTransition | undefined;

export function showInteractionCue(cue: InteractionCue) {
  if (document.hidden) return;
  window.dispatchEvent(new CustomEvent<InteractionCue>(INTERACTION_MOTION_EVENT, { detail: cue }));
}

/** Call only after persistence succeeds. The animation never owns the write. */
export async function transitionAppearance(update: () => void, options?: { kind: "theme" }) {
  if (document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !document.startViewTransition) {
    update();
    return;
  }
  activeTransition?.skipTransition();
  let applied = false;
  const apply = () => { if (!applied) { applied = true; flushSync(update); } };
  try {
    document.documentElement.dataset.visualTransition = options?.kind === "theme" ? "theme-dissolve" : "appearance";
    const transition = document.startViewTransition(apply);
    activeTransition = transition;
    const cleanup = () => {
      if (activeTransition === transition) {
        activeTransition = undefined;
        delete document.documentElement.dataset.visualTransition;
      }
    };
    // A skipped snapshot must not turn a successful save into an error.
    void transition.ready.catch(() => {});
    void transition.finished.then(cleanup, cleanup);
    await transition.updateCallbackDone;
  } catch (error) {
    if (!activeTransition) delete document.documentElement.dataset.visualTransition;
    if (applied) throw error;
    apply();
  }
}

export async function prepareAppearanceImage(source: string) {
  const image = new Image();
  image.src = source;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      image.decode(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("图片加载超时")), 5000); }),
    ]);
  } finally { clearTimeout(timeout); }
}
