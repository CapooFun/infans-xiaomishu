import assert from "node:assert/strict";
import test from "node:test";
import {
  isHoldToTalkSpace,
  mergeVoiceTranscript,
  waitForVoiceTranscripts,
} from "../src/secretary-voice-shortcut.ts";

function keyboard(overrides = {}) {
  return {
    code: "Space",
    key: " ",
    repeat: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: { tagName: "BODY", isContentEditable: false },
    ...overrides,
  };
}

test("plain Space starts hold-to-talk from the chat surface", () => {
  assert.equal(isHoldToTalkSpace(keyboard()), true);
});

test("hold-to-talk ignores repeats, modifiers and IME composition", () => {
  assert.equal(isHoldToTalkSpace(keyboard({ repeat: true })), false);
  assert.equal(isHoldToTalkSpace(keyboard({ metaKey: true })), false);
  assert.equal(isHoldToTalkSpace(keyboard({ isComposing: true })), false);
});

test("hold-to-talk never steals spaces from editable controls", () => {
  assert.equal(isHoldToTalkSpace(keyboard({ target: { tagName: "TEXTAREA" } })), false);
  assert.equal(isHoldToTalkSpace(keyboard({ target: { tagName: "INPUT" } })), false);
  assert.equal(isHoldToTalkSpace(keyboard({ target: { tagName: "BUTTON" } })), false);
  assert.equal(isHoldToTalkSpace(keyboard({ target: { tagName: "DIV", isContentEditable: true } })), false);
});

test("voice transcript keeps the most complete recognition result", () => {
  assert.equal(mergeVoiceTranscript("梅凝", "梅凝在吗"), "梅凝在吗");
  assert.equal(mergeVoiceTranscript("梅凝在吗", "梅凝"), "梅凝在吗");
  assert.equal(mergeVoiceTranscript("", "  哥哥我在  "), "哥哥我在");
});

test("voice send waits for recognition finalizers but has a timeout", async () => {
  let finished = false;
  const delayed = new Promise((resolve) => setTimeout(() => { finished = true; resolve(); }, 12));
  await waitForVoiceTranscripts([delayed], 100);
  assert.equal(finished, true);

  const startedAt = Date.now();
  await waitForVoiceTranscripts([new Promise(() => undefined)], 8);
  assert.ok(Date.now() - startedAt >= 6);
});
