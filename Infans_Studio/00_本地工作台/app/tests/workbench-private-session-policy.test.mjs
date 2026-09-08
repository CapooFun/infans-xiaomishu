import test from "node:test";
import assert from "node:assert/strict";
import {
  canLoadPrivateOverlay,
  mayPromotePrivateStateToOrdinaryMemory,
  mayUsePrivateStateForProactiveInteraction,
} from "../src/private-session-policy.mjs";

test("开源不会加载私密覆盖层", () => {
  assert.equal(canLoadPrivateOverlay(), false);
  assert.equal(canLoadPrivateOverlay({ privateCapability: true }), false);
  assert.equal(canLoadPrivateOverlay({ privateSessionActive: true }), false);
  assert.equal(canLoadPrivateOverlay({ privateCapability: true, privateSessionActive: true }), false);
});

test("覆盖层和场景记忆不晋升到普通关系记忆或主动互动", () => {
  assert.equal(mayPromotePrivateStateToOrdinaryMemory(), false);
  assert.equal(mayUsePrivateStateForProactiveInteraction(), false);
});
