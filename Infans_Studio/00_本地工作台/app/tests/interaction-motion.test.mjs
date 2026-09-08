import test from "node:test";
import assert from "node:assert/strict";
import { transitionAppearance, showInteractionCue, INTERACTION_MOTION_EVENT } from "../src/interaction-motion.ts";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function environment({ hidden = false, reduced = false, start } = {}) {
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  const window = new EventTarget();
  window.matchMedia = () => ({ matches: reduced });
  globalThis.window = window;
  globalThis.document = { hidden, startViewTransition: start, documentElement: { dataset: {} } };
  return () => { globalThis.document = oldDocument; globalThis.window = oldWindow; };
}

test("unsupported, hidden and reduced-motion sessions still update exactly once", async () => {
  for (const options of [{}, { hidden: true }, { reduced: true }]) {
    const restore = environment(options);
    try { let writes = 0; await transitionAppearance(() => writes++); assert.equal(writes, 1); }
    finally { restore(); }
  }
});

test("save presentation completes after state update without waiting for animation", async () => {
  const finished = deferred();
  const restore = environment({ start: (update) => {
    update();
    return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished: finished.promise };
  } });
  try {
    let writes = 0;
    await transitionAppearance(() => writes++);
    assert.equal(writes, 1);
    assert.equal(document.documentElement.dataset.visualTransition, "appearance");
    finished.resolve(); await Promise.resolve();
    assert.equal(document.documentElement.dataset.visualTransition, undefined);
  } finally { restore(); }
});

test("snapshot failure falls back while a skipped ready promise is harmless", async () => {
  let restore = environment({ start: () => { throw new Error("snapshot unavailable"); } });
  try { let writes = 0; await transitionAppearance(() => writes++); assert.equal(writes, 1); }
  finally { restore(); }
  restore = environment({ start: update => {
    update(); return { ready: Promise.reject(new Error("skipped")), updateCallbackDone: Promise.resolve(), finished: Promise.resolve() };
  } });
  try { let writes = 0; await transitionAppearance(() => writes++); assert.equal(writes, 1); }
  finally { restore(); }
});

test("replacement skips prior animation and old cleanup cannot clear current transition", async () => {
  const animations = [];
  let skipped = 0;
  const restore = environment({ start: update => {
    update(); const finished = deferred(); animations.push(finished);
    return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished: finished.promise, skipTransition: () => skipped++ };
  } });
  try {
    let writes = 0;
    await transitionAppearance(() => writes++); await transitionAppearance(() => writes++);
    assert.equal(writes, 2); assert.equal(skipped, 1);
    animations[0].resolve(); await Promise.resolve();
    assert.equal(document.documentElement.dataset.visualTransition, "appearance");
    animations[1].resolve(); await Promise.resolve();
    assert.equal(document.documentElement.dataset.visualTransition, undefined);
  } finally { restore(); }
});

test("hidden pages do not emit celebratory feedback", () => {
  const restore = environment();
  try {
    const received = [];
    window.addEventListener(INTERACTION_MOTION_EVENT, event => received.push(event.detail));
    showInteractionCue({ kind: "complete", label: "已完成" });
    document.hidden = true; showInteractionCue({ kind: "complete", label: "已完成" });
    assert.deepEqual(received, [{ kind: "complete", label: "已完成" }]);
  } finally { restore(); }
});

test("theme change uses a whole-frame dissolve without geometric clipping", async () => {
  const finished = deferred();
  const restore = environment({ start: update => {
    update(); return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished: finished.promise };
  } });
  try {
    let writes = 0;
    await transitionAppearance(() => writes++, { kind: "theme" });
    assert.equal(writes, 1);
    assert.equal(document.documentElement.dataset.visualTransition, "theme-dissolve");
    finished.resolve(); await Promise.resolve();
    assert.equal(document.documentElement.dataset.visualTransition, undefined);
  } finally { restore(); }
});
