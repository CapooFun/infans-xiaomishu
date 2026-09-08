import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../src/shell/WorkbenchOverlays.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("desktop secretary panel peeks to 5% instead of unmounting on outside click", () => {
  assert.match(component, /const AI_PEEK_REMAIN_RATIO = 0\.05/);
  assert.match(component, /const AI_PEEK_HIDDEN = `\$\{\(1 - AI_PEEK_REMAIN_RATIO\) \* 100}%`/);
  assert.match(component, /x: dockPeeked \? AI_PEEK_HIDDEN : 0/);
  assert.match(component, /className="ai-peek-hit"/);
  assert.match(component, /aria-label=\{`显示与\$\{activeSecretary\.name\}的聊天`\}/);

  const peekEffectStart = component.indexOf("if (!canDockPeek || peeked) return;");
  const peekEffectEnd = component.indexOf("document.addEventListener(\"pointerdown\", onPointerDown);", peekEffectStart);
  assert.ok(peekEffectStart >= 0 && peekEffectEnd > peekEffectStart);
  const peekHandler = component.slice(peekEffectStart, peekEffectEnd);
  assert.match(peekHandler, /onPeek\?\.\(\)/);
  assert.doesNotMatch(peekHandler, /onClose/);

  const close = component.slice(
    component.indexOf("const closePanel = async () => {"),
    component.indexOf("const onComposerKeyDown ="),
  );
  assert.match(close, /onClose\(\)/);
  assert.doesNotMatch(close, /onPeek/);
});

test("peeked secretary panel stays mounted and leaves a visible right-edge hit", () => {
  assert.match(shell, /const \[aiPeeked, setAiPeeked\] = useState\(false\)/);
  assert.match(shell, /ai && !aiPeeked \? " ai-open"/);
  assert.match(shell, /peeked=\{aiPeeked\}/);
  assert.match(shell, /onPeek=\{\(\) => setAiPeeked\(true\)\}/);
  assert.match(css, /\.ai-panel\.is-peeked/);
  assert.match(css, /\.ai-peek-hit/);
  assert.match(css, /min\(470px, 100vw\) \* 0\.05/);
});
