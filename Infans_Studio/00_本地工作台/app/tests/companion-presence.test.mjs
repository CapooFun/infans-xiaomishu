import assert from "node:assert/strict";
import test from "node:test";

import { latestDueCompanionPresence, postCompanionPresenceToNative } from "../src/companion-presence.ts";

test("只挑当前秘书最新一条到点且未过期的非语言在场", () => {
  const now = Date.parse("2026-08-29T07:05:00Z");
  const base = {
    roleId: "yinyue",
    plannedAt: "2026-08-29T07:00:00Z",
    expiresAt: "2026-08-29T11:00:00Z",
    state: "queued",
  };
  const selected = latestDueCompanionPresence([
    { ...base, interactionId: "old", plannedAt: "2026-08-29T06:00:00Z" },
    { ...base, interactionId: "latest" },
    { ...base, interactionId: "other-role", roleId: "meining" },
    { ...base, interactionId: "future", plannedAt: "2026-08-29T08:00:00Z" },
    { ...base, interactionId: "expired", expiresAt: "2026-08-29T07:01:00Z" },
  ], "yinyue", now);
  assert.equal(selected?.interactionId, "latest");
});

test("原生桥只收到稳定互动身份与角色，不复制私密正文", () => {
  const calls = [];
  const host = { webkit: { messageHandlers: { secretaryPet: { postMessage: (payload) => calls.push(payload) } } } };
  assert.equal(postCompanionPresenceToNative(host, {
    interactionId: "interaction-1",
    roleId: "yinyue",
    plannedAt: "2026-08-29T07:00:00Z",
    expiresAt: "2026-08-29T11:00:00Z",
    state: "queued",
  }), true);
  assert.deepEqual(calls, [{ type: "companion-presence", interactionId: "interaction-1", roleId: "yinyue" }]);
  assert.equal(postCompanionPresenceToNative({}, {
    interactionId: "interaction-2",
    roleId: "yinyue",
    plannedAt: "2026-08-29T08:00:00Z",
    expiresAt: "2026-08-29T12:00:00Z",
    state: "queued",
  }), false);
});
