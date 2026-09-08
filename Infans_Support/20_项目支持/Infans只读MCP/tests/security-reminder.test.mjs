import assert from "node:assert/strict";
import test from "node:test";
import { reminderMessage } from "../src/security-reminder.mjs";
import { buildPlist } from "../scripts/install-security-reminder.mjs";

test("does not notify before the 90-day review is due", () => {
  assert.equal(reminderMessage({ overdue: false, nextDueDateTokyo: "2026-11-19" }), null);
});

test("creates a bounded overdue reminder", () => {
  const message = reminderMessage({ overdue: true, nextDueDateTokyo: "2026-11-19" });
  assert.match(message, /90 天安全复查已到期/);
  assert.match(message, /2026-11-19/);
});

test("launchd schedule uses fixed paths and daily 09:00 check", () => {
  const plist = buildPlist({ nodePath: "/safe/node", reminderScript: "/safe/reminder.mjs" });
  assert.match(plist, /<integer>9<\/integer>/);
  assert.match(plist, /<integer>0<\/integer>/);
  assert.match(plist, /\/safe\/node/);
  assert.match(plist, /\/safe\/reminder\.mjs/);
});
