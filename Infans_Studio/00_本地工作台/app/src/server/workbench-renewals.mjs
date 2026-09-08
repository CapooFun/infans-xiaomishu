import fs from "node:fs/promises";
import path from "node:path";

import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { FIXED_EXPENSES_FILE, RENEWAL_EXPIRY_SOURCE } from "./vault-paths.mjs";

const START = "<!-- INFANS_RENEWAL_EXPIRY_JSON_START -->";
const END = "<!-- INFANS_RENEWAL_EXPIRY_JSON_END -->";
const DAY_MS = 86_400_000;
const FUNDING_FRESH_DAYS = 31;
const INTENTS = new Set(["continue", "cancel", "review"]);
const AUTHORITIES = new Set(["remind", "confirm", "automatic"]);

function tokyoDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function parseDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return null;
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date);
}

function formatDay(epoch) {
  const value = new Date(epoch);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function addDays(day, amount) {
  const epoch = parseDay(day);
  return epoch == null ? null : formatDay(epoch + amount * DAY_MS);
}

function daysBetween(from, to) {
  const a = parseDay(from);
  const b = parseDay(to);
  return a == null || b == null ? null : Math.round((b - a) / DAY_MS);
}

export function parseRenewalMarkdown(markdown) {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start < 0 || end <= start) throw new WorkbenchWriteError("续费到期原件缺少数据区", 500, "RENEWAL_DATA_INVALID");
  const fenced = markdown.slice(start + START.length, end).match(/```json\s*([\s\S]*?)\s*```/i);
  if (!fenced) throw new WorkbenchWriteError("续费到期数据区不完整", 500, "RENEWAL_DATA_INVALID");
  try { return JSON.parse(fenced[1]); } catch { throw new WorkbenchWriteError("续费到期数据区不是有效 JSON", 500, "RENEWAL_DATA_INVALID"); }
}

function replaceRenewalJson(markdown, data) {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start < 0 || end <= start) throw new WorkbenchWriteError("续费到期原件缺少数据区", 500, "RENEWAL_DATA_INVALID");
  const replacement = `${START}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
  return `${markdown.slice(0, start)}${replacement}${markdown.slice(end)}`;
}

function safeMetadataText(value, fallback = "") {
  return String(value || fallback).replace(/\b\d{8,}\b/g, "已隐藏").replace(/\b(?:PIN|CVV)\b\s*[:：-]?\s*\S+/gi, "已隐藏");
}

function nextMonthlyDate(today, dueDay) {
  const [year, month, day] = today.split("-").map(Number);
  const candidateFor = (y, m) => {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(Math.max(1, dueDay), last)).padStart(2, "0")}`;
  };
  let y = year;
  let m = month;
  let candidate = candidateFor(y, m);
  if (day > Number(candidate.slice(-2))) {
    m += 1;
    if (m > 12) { y += 1; m = 1; }
    candidate = candidateFor(y, m);
  }
  return candidate;
}

function modeFromFixedExpense(item) {
  return /自动(?:续费|扣费|扣款)|连续扣款|直接扣/.test(String(item?.note || "")) ? "automatic" : "manual";
}

function categoryFromFixedExpense(item) {
  if (item?.subgroup === "subscription") return "订阅与服务";
  if (item?.subgroup === "deduction") return "还款与扣费";
  return "生活合同";
}

function normalizeDecision(raw, fallback = {}) {
  return {
    intent: INTENTS.has(raw?.intent) ? raw.intent : (fallback.intent || "review"),
    authority: AUTHORITIES.has(raw?.authority) ? raw.authority : (fallback.authority || "remind"),
    paymentAccountId: typeof raw?.paymentAccountId === "string" && raw.paymentAccountId.length <= 120 ? raw.paymentAccountId : null,
    explicit: Boolean(raw),
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : "",
  };
}

function decisionMap(managed) {
  return new Map((Array.isArray(managed.decisions) ? managed.decisions : []).filter((item) => item?.id).map((item) => [String(item.id), item]));
}

function actionFields(item, today) {
  const actionDate = item.date ? addDays(item.date, -item.leadDays) : null;
  return { ...item, actionDate, daysUntil: item.date ? daysBetween(today, item.date) : null, daysUntilAction: actionDate ? daysBetween(today, actionDate) : null };
}

function normalizeManagedItem(raw, today, decisions) {
  if (!raw?.id || !raw?.name) return null;
  const id = String(raw.id);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || "")) ? raw.date : null;
  const item = {
    id, name: safeMetadataText(raw.name), category: safeMetadataText(raw.category, "其他"), date,
    mode: raw.mode === "automatic" || raw.mode === "auto" ? "automatic" : "manual",
    leadDays: Math.max(0, Number(raw.leadDays) || 0), source: safeMetadataText(raw.source, "支付与续约确认原件"),
    note: safeMetadataText(raw.note), recurring: false, amount: null, currency: null,
    decision: normalizeDecision(decisions.get(id)),
  };
  return actionFields(item, today);
}

function normalizeFixedExpense(raw, today, decisions) {
  const dueDay = Number(raw?.dueDay);
  if (!raw?.id || !raw?.name || raw?.kind !== "monthly") return null;
  const hasDueDay = Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31;
  const id = `fixed-${raw.id}`;
  const mode = modeFromFixedExpense(raw);
  const decision = normalizeDecision(decisions.get(id), { intent: "continue", authority: "remind" });
  const item = {
    id, name: safeMetadataText(raw.name), category: categoryFromFixedExpense(raw), date: hasDueDay ? nextMonthlyDate(today, dueDay) : null, mode,
    leadDays: mode === "automatic" ? (decision.authority === "confirm" ? 3 : 0) : 3, source: "生活账单·固定开销（只读派生）", note: safeMetadataText(raw.note), recurring: true,
    amount: raw.amount != null && raw.amount !== "" && Number.isFinite(Number(raw.amount)) ? Number(raw.amount) : null,
    currency: typeof raw.currency === "string" ? raw.currency : null,
    decision,
  };
  return actionFields(item, today);
}

function accountId(name) {
  return `asset-${Buffer.from(String(name), "utf8").toString("base64url").slice(0, 80)}`;
}

function paymentAccounts(assetData) {
  const latest = assetData?.snapshots?.at(-1);
  const accounts = (latest?.items || []).filter((item) => /银行存款|现金\/第三方|信用卡负债|贷款负债/.test(item.category)).map((item) => ({
    id: accountId(item.name), label: safeMetadataText(item.name), currency: item.currency, amount: Number(item.amount) || 0,
    kind: /负债/.test(item.category) ? "credit" : "liquid",
  }));
  return { snapshotDate: latest?.date || null, accounts };
}

function inferredAccount(_item, _accounts) {
  return null;
}

function fundingFor(item, accountState, today) {
  if (!item.recurring || item.amount == null || !item.currency) return { status: "not-applicable", accountId: null, accountLabel: null, snapshotDate: accountState.snapshotDate, snapshotAgeDays: null };
  const selected = accountState.accounts.find((account) => account.id === item.decision.paymentAccountId) || inferredAccount(item, accountState.accounts);
  const snapshotAgeDays = accountState.snapshotDate ? daysBetween(accountState.snapshotDate, today) : null;
  if (!selected) return { status: "missing", accountId: null, accountLabel: null, snapshotDate: accountState.snapshotDate, snapshotAgeDays };
  const base = { accountId: selected.id, accountLabel: selected.label, snapshotDate: accountState.snapshotDate, snapshotAgeDays };
  if (snapshotAgeDays == null || snapshotAgeDays > FUNDING_FRESH_DAYS) return { ...base, status: "stale" };
  if (selected.kind !== "liquid" || selected.currency !== item.currency) return { ...base, status: "unverified" };
  return { ...base, status: selected.amount >= item.amount ? "enough" : "insufficient" };
}

function executionFor(item) {
  if (item.decision.intent === "review") return { status: "needs-decision", label: "去留尚未确认" };
  if (item.decision.intent === "cancel") return { status: "awaiting-confirmation", label: "需要你完成取消" };
  if (item.mode === "automatic") return { status: "merchant-scheduled", label: "商户自动扣款" };
  return { status: "reminder-only", label: "需要你手动处理" };
}

function groupFor(item) {
  if (!item.date) return "pending";
  if (item.decision.intent === "cancel" && item.daysUntilAction != null && item.daysUntilAction > 0) return "authorized";
  if (item.execution.status === "connector-missing" && (item.daysUntilAction ?? Infinity) <= 30) return "attention";
  if (["awaiting-confirmation", "reminder-only"].includes(item.execution.status) && (item.daysUntilAction ?? Infinity) <= 0) return "attention";
  if (item.decision.authority === "confirm" && (item.daysUntilAction ?? Infinity) <= 0 && (item.daysUntil ?? -1) >= 0) return "attention";
  if (item.decision.intent === "review" && (item.daysUntilAction ?? Infinity) <= 7) return "attention";
  if (item.funding.status === "insufficient" && item.decision.intent === "continue" && (item.daysUntilAction ?? Infinity) <= 7) return "attention";
  if (item.decision.explicit) return "authorized";
  if (item.mode === "automatic" && item.recurring) return "watching";
  return "upcoming";
}

function stripSensitive(item) {
  const { amount: _amount, currency: _currency, funding, ...safe } = item;
  return { ...safe, funding: { status: funding.status, snapshotDate: funding.snapshotDate, snapshotAgeDays: funding.snapshotAgeDays, accountId: null, accountLabel: null } };
}

function importantGuard(items) {
  const candidates = items.filter((item) => {
    const near = (item.daysUntilAction ?? Infinity) <= 7;
    if (item.execution.status === "connector-missing" && (item.daysUntilAction ?? Infinity) <= 30) return true;
    if (["awaiting-confirmation", "reminder-only"].includes(item.execution.status) && (item.daysUntilAction ?? Infinity) <= 0) return true;
    if (item.decision.authority === "confirm" && (item.daysUntilAction ?? Infinity) <= 0 && (item.daysUntil ?? -1) >= 0) return true;
    if (item.decision.intent === "review" && near) return true;
    return item.decision.intent === "continue" && near && item.funding.status === "insufficient";
  });
  const critical = candidates.filter((item) => item.funding.status === "insufficient" || item.execution.status === "connector-missing");
  const earliest = candidates.map((item) => item.actionDate).filter(Boolean).sort()[0] || null;
  let summary = "";
  if (critical.some((item) => item.funding.status === "insufficient")) summary = "有付款资金不足";
  else if (critical.length) summary = "有已授权操作尚未接通执行器";
  else if (candidates.some((item) => ["awaiting-confirmation", "reminder-only"].includes(item.execution.status))) summary = "有付款或取消事项需要你处理";
  else if (candidates.some((item) => item.decision.authority === "confirm")) summary = "有支付或续约事项临近";
  else if (candidates.length) summary = "有近期续约等待你确认";
  return { level: critical.length ? "critical" : candidates.length ? "warning" : "none", count: candidates.length, earliestActionDate: earliest, title: candidates.length ? "重要提醒" : "", summary, href: "/tools/renewals" };
}

async function readInternal(vaultRoot, options = {}) {
  const today = options.today || tokyoDay();
  const [managedMarkdown, fixedText] = await Promise.all([
    fs.readFile(path.join(vaultRoot, RENEWAL_EXPIRY_SOURCE), "utf8"),
    fs.readFile(path.join(vaultRoot, FIXED_EXPENSES_FILE), "utf8").catch(() => "{\"items\":[]}"),
  ]);
  const managed = parseRenewalMarkdown(managedMarkdown);
  const fixed = JSON.parse(fixedText);
  const decisions = decisionMap(managed);
  const accounts = paymentAccounts(null);
  const items = [
    ...(Array.isArray(managed.items) ? managed.items.map((item) => normalizeManagedItem(item, today, decisions)) : []),
    ...(Array.isArray(fixed.items) ? fixed.items.map((item) => normalizeFixedExpense(item, today, decisions)) : []),
  ].filter(Boolean).map((item) => {
    const funding = fundingFor(item, accounts, today);
    const execution = executionFor(item);
    const withState = { ...item, funding, execution };
    return { ...withState, group: groupFor(withState) };
  }).sort((a, b) => {
    if (a.actionDate == null) return 1;
    if (b.actionDate == null) return -1;
    return a.actionDate.localeCompare(b.actionDate) || a.name.localeCompare(b.name, "zh-CN");
  });
  const counts = items.reduce((acc, item) => { acc[item.group] = (acc[item.group] || 0) + 1; return acc; }, {});
  return {
    observedAt: new Date().toISOString(), today, updatedAt: String(managed.updatedAt || ""), counts, items,
    accounts: accounts.accounts.map(({ amount: _amount, ...account }) => account), paymentGuard: importantGuard(items), sourcePath: RENEWAL_EXPIRY_SOURCE,
  };
}

export async function readRenewalExpiry(vaultRoot, options = {}) {
  const snapshot = await readInternal(vaultRoot, options);
  return { ...snapshot, items: snapshot.items.map(stripSensitive), accounts: [] };
}

export async function readPaymentAuthorization(vaultRoot, options = {}) { return readInternal(vaultRoot, options); }

export async function readPaymentGuardSummary(vaultRoot, options = {}) {
  try { return (await readInternal(vaultRoot, options)).paymentGuard; }
  catch { return { level: "none", count: 0, earliestActionDate: null, title: "", summary: "", href: "/tools/renewals" }; }
}

export function prepareRenewalDecisionUpdate(markdown, action, now = new Date()) {
  const data = parseRenewalMarkdown(markdown);
  if (action.expectedUpdatedAt !== String(data.updatedAt || "")) throw new WorkbenchWriteError("确认单已经变化，请刷新后重试", 409, "RENEWAL_DECISION_CHANGED");
  const id = String(action.id || "").trim();
  if (!id || id.length > 160) throw new WorkbenchWriteError("续约项目 ID 不正确", 400, "RENEWAL_ITEM_INVALID");
  if (!INTENTS.has(action.intent)) throw new WorkbenchWriteError("续约意向不受支持", 400, "RENEWAL_INTENT_INVALID");
  if (!AUTHORITIES.has(action.authority)) throw new WorkbenchWriteError("AI 跟进方式不受支持", 400, "RENEWAL_AUTHORITY_INVALID");
  const paymentAccountId = action.paymentAccountId == null || action.paymentAccountId === "" ? null : String(action.paymentAccountId);
  if (paymentAccountId && (!/^asset-[A-Za-z0-9_-]+$/.test(paymentAccountId) || paymentAccountId.length > 120)) throw new WorkbenchWriteError("付款账户代称不正确", 400, "RENEWAL_ACCOUNT_INVALID");
  const decisions = Array.isArray(data.decisions) ? [...data.decisions] : [];
  const index = decisions.findIndex((item) => String(item?.id || "") === id);
  const updatedAt = now.toISOString();
  const nextDecision = { id, intent: action.intent, authority: action.authority, paymentAccountId, updatedAt };
  const previous = index >= 0 ? decisions[index] : null;
  if (index >= 0) decisions[index] = nextDecision;
  else decisions.push(nextDecision);
  const next = { ...data, schemaVersion: 2, updatedAt, decisions };
  return {
    content: replaceRenewalJson(markdown, next), before: previous ? JSON.stringify(previous, null, 2) : "（尚未留下明确授权）",
    after: JSON.stringify(nextDecision, null, 2), summary: `更新支付与续约授权：${id}`,
  };
}
