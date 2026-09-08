import assert from "node:assert/strict";
import test from "node:test";
import {
  FRONTEND_HANDOFF_FEEDBACK_KEY,
  clearFrontendHandoffMarker,
  consumeFrontendHandoffFeedback,
  frontendBuildNeedsHandoff,
  frontendHandoffUrl,
  loadedFrontendBuildId,
  markFrontendHandoffFeedback,
} from "../src/workbench-frontend-handoff.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("frontend rebuild leaves the old document through a distinct handoff navigation", () => {
  const result = frontendHandoffUrl({
    origin: "https://private.example",
    pathname: "/projects",
    search: "?project=infans",
    hash: "#feature",
  }, "build-42");
  const url = new URL(result, "https://private.example");
  assert.equal(url.pathname, "/__frontend-handoff");
  assert.equal(url.searchParams.get("to"), "/projects?project=infans#feature");
  assert.equal(url.searchParams.get("v"), "build-42");
});

test("an already-built server still replaces an older suspended iOS document", () => {
  const documentWithBuild = (buildId) => ({
    querySelector: () => buildId === null ? null : { getAttribute: () => buildId },
  });
  assert.equal(loadedFrontendBuildId(documentWithBuild("build-old")), "build-old");
  assert.equal(frontendBuildNeedsHandoff({ rebuilt: false, serverBuildId: "build-new", loadedBuildId: "build-old" }), true);
  assert.equal(frontendBuildNeedsHandoff({ rebuilt: false, serverBuildId: "build-new", loadedBuildId: "build-new" }), false);
  assert.equal(frontendBuildNeedsHandoff({ rebuilt: false, serverBuildId: "build-new", loadedBuildId: null }), true);
  assert.equal(frontendBuildNeedsHandoff({ rebuilt: true, serverBuildId: null, loadedBuildId: null }), true);
});

test("the new page removes its one-shot build marker without losing route state", () => {
  let replaced = "";
  const changed = clearFrontendHandoffMarker({
    origin: "https://private.example",
    pathname: "/projects",
    search: "?project=infans&__infans_frontend=build-42&view=wiki",
    hash: "#feature",
  }, {
    state: { kept: true },
    replaceState: (_state, _title, next) => { replaced = String(next); },
  });
  assert.equal(changed, true);
  assert.equal(replaced, "/projects?project=infans&view=wiki#feature");
});

test("refresh feedback survives only the immediate handoff", () => {
  const storage = memoryStorage();
  markFrontendHandoffFeedback(storage, 1_000);
  assert.equal(storage.getItem(FRONTEND_HANDOFF_FEEDBACK_KEY), "1000");
  assert.equal(consumeFrontendHandoffFeedback(storage, 2_000), true);
  assert.equal(consumeFrontendHandoffFeedback(storage, 2_000), false);
  markFrontendHandoffFeedback(storage, 1_000);
  assert.equal(consumeFrontendHandoffFeedback(storage, 200_000), false);
});
