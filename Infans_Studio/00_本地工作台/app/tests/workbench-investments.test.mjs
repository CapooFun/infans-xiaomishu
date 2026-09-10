import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildFullCycleSeries,
  buildMarketOnlySeries,
  calculateInvestmentPeriodMetrics,
  parseInvestmentLedgerMarkdown,
  readInvestmentInstrumentSeries,
  resolveInvestmentSeriesEnd,
} from "../src/server/workbench-investments.mjs";
import { A_SHARE_INVESTMENT_LEDGER } from "../src/server/vault-paths.mjs";
import { sortInvestmentPerformanceRows } from "../src/investment-performance-sort.ts";

function wrapLedger(json) {
  return `<!-- INFANS_INVESTMENT_LEDGER_JSON_START -->\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n<!-- INFANS_INVESTMENT_LEDGER_JSON_END -->`;
}

function demoLedger(overrides = {}) {
  return {
    schemaVersion: 1,
    baseCurrency: "CNY",
    source: { title: "示意账本", asOf: "2026-08-27" },
    accounts: [{ id: "demo-broker", label: "示意券商", baseCurrency: "CNY" }],
    instruments: [
      {
        id: "CN.FUND.990001",
        symbol: "990001",
        name: "示意均衡基金",
        exchange: "OTC",
        assetClass: "MutualFund",
        listingCurrency: "CNY",
      },
      {
        id: "CN.SZ.159001",
        symbol: "159001",
        name: "示意宽基ETF",
        exchange: "SZSE",
        assetClass: "ETF",
        listingCurrency: "CNY",
      },
    ],
    transactions: [
      {
        id: "demo-159001-buy",
        accountId: "demo-broker",
        instrumentId: "CN.SZ.159001",
        tradedAt: "2026-01-02T10:00:00+08:00",
        side: "buy",
        quantity: 100,
        price: 1,
        currency: "CNY",
        grossAmount: 100,
      },
    ],
    positionSnapshots: [
      {
        id: "pos-990001",
        asOf: "2026-08-27",
        accountId: "demo-broker",
        instrumentId: "CN.FUND.990001",
        quantity: 1000,
        marketValue: 2282.8,
      },
      {
        id: "pos-159001",
        asOf: "2026-08-27",
        accountId: "demo-broker",
        instrumentId: "CN.SZ.159001",
        quantity: 100,
        marketValue: 110,
      },
    ],
    accountSnapshots: [{
      id: "acct",
      asOf: "2026-08-27",
      accountId: "demo-broker",
      totalAssets: 2392.8,
      cash: 0,
      marketValue: 2392.8,
    }],
    ...overrides,
  };
}

async function writeLedger(t, json) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-invest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, A_SHARE_INVESTMENT_LEDGER);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, wrapLedger(json));
  return root;
}

function eastmoneyNavScript(code, points) {
  const rows = points.map(([date, value]) => ({
    x: Date.parse(`${date}T00:00:00+08:00`),
    y: value,
    equityReturn: 0,
    unitMoney: "",
  }));
  return `/* ${code} */ var Data_netWorthTrend = ${JSON.stringify(rows)};`;
}

test("示意账本不把没有申赎流水的场外基金写成本人收益率", () => {
  const data = parseInvestmentLedgerMarkdown(wrapLedger(demoLedger()));
  assert.equal(data.instruments.find((row) => row.id === "CN.FUND.990001")?.name, "示意均衡基金");
  assert.equal(data.instruments.some((row) => /华宝|广发|017437|006479/.test(`${row.id}${row.symbol}${row.name}`)), false);
  const fundRow = data.performance.rows.find((row) => row.instrumentId === "CN.FUND.990001");
  assert.ok(fundRow);
  assert.notEqual(fundRow.basis, "transaction-gross");
});

test("transaction-gross uses CNY-normalized trades when the ending position is already CNY", () => {
  const json = {
    schemaVersion: 1,
    baseCurrency: "CNY",
    accounts: [{ id: "mixed", label: "混合币种", baseCurrency: "MIXED" }],
    instruments: [{ id: "US.TEST", symbol: "TEST", name: "Test", listingCurrency: "USD" }],
    transactions: [
      { id: "buy", accountId: "mixed", instrumentId: "US.TEST", tradedAt: "2026-01-01", side: "buy", quantity: 20, price: 100, currency: "USD", grossAmount: 2000, performanceGrossAmountCny: 13400 },
      { id: "sell", accountId: "mixed", instrumentId: "US.TEST", tradedAt: "2026-01-02", side: "sell", quantity: 10, price: 120, currency: "USD", grossAmount: 1200, performanceGrossAmountCny: 8040 },
    ],
    positionSnapshots: [{ id: "pos", asOf: "2026-01-02", accountId: "mixed", instrumentId: "US.TEST", quantity: 10, marketValue: 700, reportedPnl: null, reportedPnlRate: null }],
    accountSnapshots: [{ id: "account", asOf: "2026-01-02", accountId: "mixed", totalAssets: 700, cash: 0, marketValue: 700 }],
  };
  const data = parseInvestmentLedgerMarkdown(wrapLedger(json));
  const row = data.performance.rows.find((item) => item.instrumentId === "US.TEST");
  assert.equal(row.basis, "transaction-gross");
  assert.equal(row.investedAmount, 13400);
  assert.equal(row.endingValue, 8740);
  assert.equal(row.profit, -4660);
});

test("transaction-gross stays unavailable when a foreign trade has no CNY normalization", () => {
  const json = {
    schemaVersion: 1,
    baseCurrency: "CNY",
    accounts: [{ id: "mixed", label: "混合币种", baseCurrency: "MIXED" }],
    instruments: [{ id: "US.TEST", symbol: "TEST", name: "Test", listingCurrency: "USD" }],
    transactions: [{ id: "buy", accountId: "mixed", instrumentId: "US.TEST", tradedAt: "2026-01-01", side: "buy", quantity: 20, price: 100, currency: "USD", grossAmount: 2000 }],
    positionSnapshots: [{ id: "pos", asOf: "2026-01-02", accountId: "mixed", instrumentId: "US.TEST", quantity: 20, marketValue: 14000, reportedPnl: null, reportedPnlRate: null }],
    accountSnapshots: [{ id: "account", asOf: "2026-01-02", accountId: "mixed", totalAssets: 14000, cash: 0, marketValue: 14000 }],
  };
  const row = parseInvestmentLedgerMarkdown(wrapLedger(json)).performance.rows.find((item) => item.instrumentId === "US.TEST");
  assert.equal(row.status, "unavailable");
  assert.equal(row.basis, "platform-pnl-only");
  assert.equal(row.investedAmount, null);
});

test("period return metrics use unitized NAV while keeping the cash capital base", () => {
  const rows = buildFullCycleSeries(
    [
      { tradedAt: "2025-12-30T09:30:00+08:00", side: "buy", quantity: 10, grossAmount: 100, fees: null, taxes: null },
      { tradedAt: "2026-01-03T09:30:00+08:00", side: "buy", quantity: 10, grossAmount: 120, fees: null, taxes: null },
      { tradedAt: "2026-01-05T09:30:00+08:00", side: "sell", quantity: 10, grossAmount: 130, fees: null, taxes: null },
    ],
    [
      { date: "2025-12-30", close: 10 },
      { date: "2025-12-31", close: 11 },
      { date: "2026-01-03", close: 12 },
      { date: "2026-01-05", close: 13 },
    ],
  );
  const metrics = calculateInvestmentPeriodMetrics(rows, "2026-01-01", "2026-12-31");
  assert.equal(metrics.from, "2026-01-03");
  assert.equal(metrics.to, "2026-01-05");
  assert.equal(metrics.profit, 30);
  assert.equal(metrics.returnRate, 0.1818);
  assert.equal(metrics.marketReturn, 0.1818);
  assert.equal(metrics.operationDifference, 0);
  assert.equal(metrics.passiveValue, 260);
  assert.equal(metrics.operationProfit, 0);
  assert.equal(metrics.capitalBase, 230);
  assert.deepEqual(rows.map((row) => row.externalFlow), [100, 0, 120, 0]);
  assert.deepEqual(rows.map((row) => row.passiveStrategy), [100, 110, 120, 130]);
});

test("operation profit compares actual timing with same-day cash invested and held", () => {
  const rows = buildFullCycleSeries(
    [
      { tradedAt: "2026-01-01T09:30:00+08:00", side: "buy", quantity: 10, grossAmount: 100, fees: null, taxes: null },
      { tradedAt: "2026-01-02T09:30:00+08:00", side: "sell", quantity: 10, grossAmount: 120, fees: null, taxes: null },
    ],
    [
      { date: "2026-01-01", close: 10 },
      { date: "2026-01-02", close: 12 },
      { date: "2026-01-03", close: 9 },
    ],
  );
  const metrics = calculateInvestmentPeriodMetrics(rows, "", "2026-01-03");
  assert.equal(metrics.endingValue, 120);
  assert.equal(metrics.passiveValue, 90);
  assert.equal(metrics.operationProfit, 30);
});

test("a single buy held to the end has no artificial operation profit from daily close differences", () => {
  const rows = buildFullCycleSeries(
    [{ tradedAt: "2026-01-01T09:30:00+08:00", side: "buy", quantity: 10, price: 10, grossAmount: 100, fees: null, taxes: null }],
    [
      { date: "2026-01-01", close: 10.2 },
      { date: "2026-01-02", close: 12 },
    ],
  );
  const metrics = calculateInvestmentPeriodMetrics(rows, "", "2026-01-02");
  assert.equal(metrics.endingValue, 120);
  assert.equal(metrics.passiveValue, 120);
  assert.equal(metrics.operationProfit, 0);
});

test("market-only series normalizes public prices without inventing personal profit", () => {
  const rows = buildMarketOnlySeries([
    { date: "2026-01-01", close: 20 },
    { date: "2026-01-02", close: 22 },
  ], 10);
  assert.equal(rows[0].market, 100);
  assert.equal(rows[1].market, 110);
  assert.equal(rows[1].strategy, null);
  assert.equal(rows[1].profit, 0);
  assert.equal(rows[1].quantity, 10);
});

test("没有申赎流水的场外基金只画公开净值，不伪造收益率", async (t) => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, referer: init?.headers?.Referer || "" });
    assert.equal(url.includes("fund.eastmoney.com/pingzhongdata/990001.js"), true);
    assert.equal(String(init?.headers?.Referer || "").includes("fund.eastmoney.com/990001.html"), true);
    return {
      ok: true,
      status: 200,
      text: async () => eastmoneyNavScript("990001", [["2025-08-27", 1], ["2026-08-27", 2.2828]]),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const root = await writeLedger(t, demoLedger({
    transactions: [],
    positionSnapshots: [demoLedger().positionSnapshots[0]],
    accountSnapshots: [{
      id: "acct",
      asOf: "2026-08-27",
      accountId: "demo-broker",
      totalAssets: 2282.8,
      cash: 0,
      marketValue: 2282.8,
    }],
    instruments: [demoLedger().instruments[0]],
  }));
  const series = await readInvestmentInstrumentSeries(root, "CN.FUND.990001");
  assert.equal(series.available, true);
  assert.equal(series.mode, "market-only");
  assert.equal(series.sourceLabel, "东方财富基金单位净值 · 仅净值走势");
  assert.equal(series.rows.at(-1).price, 2.2828);
  assert.equal(series.rows.at(-1).market, 228.28);
  assert.equal(series.actions.length, 0);
  assert.match(series.note, /不是本人收益率/);
  assert.equal(seen.length, 1);
});

test("investment series ends on the closing trade unless a current position remains", () => {
  assert.equal(resolveInvestmentSeriesEnd([{ tradedAt: "2024-10-25T10:00:00+08:00" }], 0, "2026-08-27"), "2024-10-25");
  assert.equal(resolveInvestmentSeriesEnd([{ tradedAt: "2026-01-02T10:00:00+08:00" }], 100, "2026-08-27"), "2026-08-27");
});

test("investment performance sorting uses current holdings and actual trade timestamps", () => {
  const data = parseInvestmentLedgerMarkdown(wrapLedger(demoLedger()));
  const byCurrentValue = sortInvestmentPerformanceRows(data.performance.rows, "value");
  const byRecentTrade = sortInvestmentPerformanceRows(data.performance.rows, "date");
  assert.equal(byCurrentValue[0].instrumentId, "CN.FUND.990001");
  assert.equal(byRecentTrade[0].instrumentId, "CN.SZ.159001");
  assert.equal(byRecentTrade[0].lastTradedAt, "2026-01-02T10:00:00+08:00");
});

test("investment ledger rejects duplicate transaction ids", () => {
  const json = demoLedger({
    transactions: [
      demoLedger().transactions[0],
      { ...demoLedger().transactions[0], tradedAt: "2026-01-03T10:00:00+08:00" },
    ],
  });
  assert.throws(() => parseInvestmentLedgerMarkdown(wrapLedger(json)), /重复 ID/);
});

test("investment ledger rejects unknown account references", () => {
  const json = demoLedger({
    transactions: [{ ...demoLedger().transactions[0], accountId: "missing-account" }],
  });
  assert.throws(() => parseInvestmentLedgerMarkdown(wrapLedger(json)), /不存在的账户/);
});
