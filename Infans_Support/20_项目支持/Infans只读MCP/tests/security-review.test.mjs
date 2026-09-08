import assert from "node:assert/strict";
import test from "node:test";
import { completeSecurityReview, readSecurityReview } from "../src/security-review.mjs";
import { makeFixture } from "./helpers.mjs";

test("records a 90-day security review without storing credentials", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const reviewedAt = "2026-08-21T00:00:00.000Z";
  const record = await completeSecurityReview(fixture.stateDirectory, { reviewedAt, actor: "user" });
  assert.equal(record.intervalDays, 90);
  assert.equal(record.nextDueAt, "2026-11-19T00:00:00.000Z");
  assert(!record.history[0].checks.includes("rotated_tunnel_runtime_key"));
  const status = await readSecurityReview(fixture.stateDirectory, new Date("2026-10-01T00:00:00.000Z"));
  assert.equal(status.overdue, false);
  assert.equal(status.lastReviewedDateTokyo, "2026-08-21");
  assert.equal(status.nextDueDateTokyo, "2026-11-19");
  assert(!JSON.stringify(record).match(/token|secret|password/i));
});

test("records tunnel key rotation only when explicitly confirmed", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const record = await completeSecurityReview(fixture.stateDirectory, {
    reviewedAt: "2026-11-19T00:00:00.000Z",
    actor: "user",
    rotatedTunnelRuntimeKey: true,
  });
  assert(record.history[0].checks.includes("rotated_tunnel_runtime_key"));
});
