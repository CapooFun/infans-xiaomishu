import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseRenewalMarkdown, prepareRenewalDecisionUpdate, readPaymentAuthorization, readRenewalExpiry } from "../src/server/workbench-renewals.mjs";
import { createWriteService } from "../src/server/workbench-write.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-renewals-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const renewalDir = path.join(root, "80_生活事务", "日常杂务");
  const billsDir = path.join(root, "80_生活事务", "生活账单");
  await Promise.all([fs.mkdir(renewalDir, { recursive: true }), fs.mkdir(billsDir, { recursive: true })]);
  const markdown = `---\ndate: 2026-08-22\n---\n<!-- INFANS_RENEWAL_EXPIRY_JSON_START -->\n\`\`\`json\n${JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-08-22T09:00:00+09:00",
    items: [
      { id: "expired", name: "手动证件", category: "证件", date: "2026-08-01", mode: "manual", leadDays: 30, source: "卡面" },
      { id: "auto-alias", name: "旧自动值", category: "订阅", date: "2026-09-01", mode: "auto", leadDays: 2, source: "旧原件" },
      { id: "pending", name: "待补日期", category: "资格", date: null, mode: "manual", source: "待提供 1234567890123456", note: "CVV: 123" },
    ],
  })}\n\`\`\`\n<!-- INFANS_RENEWAL_EXPIRY_JSON_END -->\n`;
  await fs.writeFile(path.join(renewalDir, "续费到期.md"), markdown, "utf8");
  await fs.writeFile(path.join(billsDir, "固定开销.json"), JSON.stringify({
    items: [
      { id: "subscription", name: "示例订阅", kind: "monthly", subgroup: "subscription", dueDay: 25, amount: 999999, currency: "JPY", note: "示例自动扣款" },
      { id: "card-subscription", name: "示例换卡订阅", kind: "monthly", subgroup: "subscription", dueDay: 26, amount: 100, currency: "JPY", note: "示例卡片扣款" },
      { id: "unknown-price", name: "价格待确认的订阅", kind: "monthly", subgroup: "subscription", dueDay: null, amount: null, currency: "JPY", note: "示例自动续费，金额和日期待确认" },
    ],
  }), "utf8");
  return { root, markdown };
}

test("Payment authorization uses action dates, accepts old auto values, and keeps normal renewal reads amount-free", async (t) => {
  const { root } = await fixture(t);
  const snapshot = await readRenewalExpiry(root, { today: "2026-08-22" });
  assert.equal(snapshot.counts.pending, 2);
  assert.equal(snapshot.items.find((item) => item.id === "auto-alias")?.mode, "automatic");
  assert.equal(snapshot.items.find((item) => item.id === "auto-alias")?.actionDate, "2026-08-30");
  assert.equal(snapshot.items.some((item) => Object.hasOwn(item, "amount")), false);
  assert.equal(JSON.stringify(snapshot).includes("999999"), false);
  assert.equal(JSON.stringify(snapshot).includes("1234567890123456"), false);
  assert.equal(JSON.stringify(snapshot).includes("CVV"), false);
});

test("Protected payment authorization does not infer private accounts", async (t) => {
  const { root } = await fixture(t);
  const snapshot = await readPaymentAuthorization(root, { today: "2026-08-22" });
  const subscription = snapshot.items.find((item) => item.id === "fixed-subscription");
  assert.equal(subscription.amount, 999999);
  assert.equal(subscription.funding.status, "missing");
  assert.equal(subscription.funding.accountLabel, null);
  assert.equal(snapshot.items.find((item) => item.id === "fixed-card-subscription")?.funding.accountLabel, null);
  const unknownPrice = snapshot.items.find((item) => item.id === "fixed-unknown-price");
  assert.equal(unknownPrice.amount, null);
  assert.equal(unknownPrice.mode, "automatic");
  assert.equal(unknownPrice.actionDate, null);
  assert.equal(unknownPrice.group, "pending");
  assert.equal(unknownPrice.funding.status, "not-applicable");
  assert.equal(snapshot.paymentGuard.count, 1);
  assert.equal(snapshot.paymentGuard.summary, "有近期续约等待你确认");
  assert.equal(JSON.stringify(snapshot.paymentGuard).includes("PayPay"), false);
  assert.equal(JSON.stringify(snapshot.paymentGuard).includes("999999"), false);
});

test("Renewal decision updates one stable item through schema v2 and rejects stale previews", async (t) => {
  const { markdown } = await fixture(t);
  const mutation = prepareRenewalDecisionUpdate(markdown, {
    id: "expired",
    expectedUpdatedAt: "2026-08-22T09:00:00+09:00",
    intent: "continue",
    authority: "automatic",
    paymentAccountId: null,
  }, new Date("2026-08-22T01:00:00.000Z"));
  const next = parseRenewalMarkdown(mutation.content);
  assert.equal(next.schemaVersion, 2);
  assert.deepEqual(next.decisions[0], {
    id: "expired", intent: "continue", authority: "automatic", paymentAccountId: null, updatedAt: "2026-08-22T01:00:00.000Z",
  });
  assert.throws(() => prepareRenewalDecisionUpdate(mutation.content, {
    id: "expired", expectedUpdatedAt: "2026-08-22T09:00:00+09:00", intent: "cancel", authority: "confirm",
  }), /已经变化/);
});

test("Workbench writer previews and atomically commits a scoped renewal decision", async (t) => {
  const { root } = await fixture(t);
  const writes = createWriteService(root, { now: () => new Date("2026-08-22T01:00:00.000Z") });
  const preview = await writes.preview({
    kind: "updateRenewalDecision", id: "fixed-subscription", expectedUpdatedAt: "2026-08-22T09:00:00+09:00",
    intent: "cancel", authority: "confirm", paymentAccountId: null,
  });
  assert.equal(preview.targetPath, "80_生活事务/日常杂务/续费到期.md");
  assert.match(preview.after, /"intent": "cancel"/);
  await writes.commit(preview.token);
  const written = await fs.readFile(path.join(root, preview.targetPath), "utf8");
  assert.equal(parseRenewalMarkdown(written).decisions[0].id, "fixed-subscription");
});

test("Confirmation UI is a compact two-choice card and lets untouched defaults be saved", async () => {
  const ui = await fs.readFile(new URL("../src/pages/tools/RenewalExpiryView.tsx", import.meta.url), "utf8");
  assert.ok(ui.includes("是否继续"));
  assert.ok(ui.includes("怎么提醒"));
  assert.ok(ui.includes("只报异常"));
  assert.ok(ui.includes("到期前提醒"));
  assert.ok(ui.includes("renewal-saved-button"));
  assert.ok(ui.includes("扣款账户："));
  assert.ok(ui.includes("changed || !item.decision.explicit"));
  assert.equal(ui.includes("稍后决定"), false);
  assert.equal(ui.includes("资金守卫"), false);
  assert.equal(ui.includes("执行状态"), false);
  assert.equal(ui.includes("持续监督"), false);
});
