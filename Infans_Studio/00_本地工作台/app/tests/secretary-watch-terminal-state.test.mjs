import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const nativeRoot = path.resolve(import.meta.dirname, "../native/InfansHealthSync");

function resolveHomeState({ activeRecordingID, activeState, latestReplyID, otherPendingCount }) {
  if (activeRecordingID && activeRecordingID === latestReplyID) {
    return { branch: "reply_persisted", progress: null, otherPendingCount };
  }
  if (["queued_to_phone", "phone_persisted", "transcribing"].includes(activeState)) {
    return { branch: `raw_voice_${activeState}`, progress: activeState, otherPendingCount };
  }
  return { branch: latestReplyID ? "reply_persisted" : "idle", progress: null, otherPendingCount };
}

test("persisted reply is a terminal home state for the same stable recording ID", () => {
  const state = resolveHomeState({
    activeRecordingID: "db90990a-95f9-46ac-a697-617fc0c01d09",
    activeState: "transcribing",
    latestReplyID: "db90990a-95f9-46ac-a697-617fc0c01d09",
    otherPendingCount: 2,
  });
  assert.deepEqual(state, {
    branch: "reply_persisted",
    progress: null,
    otherPendingCount: 2,
  });
});

test("an explicitly opened older recording remains separate from the latest reply", () => {
  const state = resolveHomeState({
    activeRecordingID: "older-recording",
    activeState: "transcribing",
    latestReplyID: "newer-reply",
    otherPendingCount: 1,
  });
  assert.deepEqual(state, {
    branch: "raw_voice_transcribing",
    progress: "transcribing",
    otherPendingCount: 1,
  });
});

test("开源树不含 Watch 终端态源码", async () => {
  await assert.rejects(fs.stat(path.join(nativeRoot, "InfansHealthSyncWatch")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(nativeRoot, "InfansCodexComplication")), { code: "ENOENT" });
});
