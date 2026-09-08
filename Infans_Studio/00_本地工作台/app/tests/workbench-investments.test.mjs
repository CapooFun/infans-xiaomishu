import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  buildFullCycleSeries,
  buildMarketOnlySeries,
  calculateInvestmentPeriodMetrics,
  parseInvestmentLedgerMarkdown,
  readInvestmentLedger,
  readInvestmentInstrumentSeries,
  readInvestmentPeriodPerformance,
  resolveInvestmentSeriesEnd,
} from "../src/server/workbench-investments.mjs";
import { sortInvestmentPerformanceRows } from "../src/investment-performance-sort.ts";

const sourceUrl = new URL("../../../20_个人档案/个人资产/A股投资账本.md", import.meta.url);

test("China investment ledger reconciles current accounts and keeps account-return gaps visible", async () => {
  const markdown = await fs.readFile(sourceUrl, "utf8");
  const data = parseInvestmentLedgerMarkdown(markdown);
  assert.equal(data.available, true);
  assert.equal(data.coverage.status, "partial");
  assert.equal(data.coverage.holdingsStatus, "reconciled");
  assert.equal(data.coverage.transactionsStatus, "screenshot-complete");
  assert.equal(data.coverage.cashFlowsStatus, "aggregate-only");
  assert.equal(data.coverage.futureCapture.length, 4);
  assert.equal(data.accounts.length, 2);
  assert.equal(data.instruments.length, 26);
  assert.equal(data.summary.tradeCount, 78);
  assert.equal(data.positionSnapshots.length, 8);
  assert.equal(data.accountReconciliations.length, 2);
  assert.ok(data.accountReconciliations.every((row) => row.status === "matched"));
  assert.equal(data.portfolio.totalAssets, 487622.6);
  assert.equal(data.portfolio.cash, 385143.81);
  assert.equal(data.portfolio.marketValue, 102478.79);
  assert.equal(data.portfolio.positionCount, 8);
  assert.equal(data.portfolio.reconciledAccountCount, 2);
  assert.equal(data.portfolio.largestPositionId, "CN.FUND.006479");
  assert.equal(data.portfolio.exposures[0].name, "美国股票");
  assert.equal(data.portfolio.exposures[0].weight, 1);
  assert.equal(data.performance.from, "2023-07-31");
  assert.equal(data.performance.to, "2026-08-27");
  assert.equal(data.performance.availableCount, 27);
  assert.equal(data.performance.accountReturns.find((row) => row.accountId === "cn-ebscn-self-3897").rate, 0.1056);
  assert.equal(data.performance.accountReturns.find((row) => row.accountId === "cn-ebscn-self-3897").basis, "platform-all-period");
  assert.equal(data.performance.accountReturns.find((row) => row.accountId === "cn-ths-fund-self-8458").rate, 0.2985);
  assert.equal(data.cashFlowSummaries.length, 1);
  assert.deepEqual(data.cashFlowSummaries[0], {
    id: "cn-ebscn-3897-all-20260827",
    accountId: "cn-ebscn-self-3897",
    range: "all",
    asOf: "2026-08-27",
    initialAssets: 3.87,
    transferIn: 810200,
    transferOut: 542091.11,
    netInflow: 268108.89,
    reportedPnl: 122379.09,
    endingAssets: 390911.71,
    reconciliationDifference: 419.86,
    sourceQuality: "screenshot-aggregate",
    note: "同花顺资产分析全部周期口径，收益率 10.56%；全部盈亏包含已清仓归档收益。只有累计转入转出总额，没有逐笔日期，因此该收益率保留为平台口径，不视为 XIRR／TWR。",
  });
  const brokerageSnapshot = data.accountSnapshots.find((row) => row.accountId === "cn-ebscn-self-3897");
  assert.equal(brokerageSnapshot.reportedPnl, 122379.09);
  assert.equal(brokerageSnapshot.holdingPnl, 89932.49);
  const jingShunFullCycle = data.performance.rows.find((row) => row.instrumentId === "CN.SZ.159509" && row.basis === "transaction-gross");
  assert.equal(jingShunFullCycle.from, "2024-05-23");
  assert.equal(jingShunFullCycle.returnRate, 0.0887);
  assert.equal(jingShunFullCycle.currentMarketValue, 279);
  assert.equal(jingShunFullCycle.lastTradedAt, "2026-08-11T10:35:00+08:00");
  const closedHuabao = data.performance.rows.find((row) => row.id.includes("20230731-20241126"));
  assert.equal(closedHuabao.profit, 15252.19);
  assert.equal(closedHuabao.returnRate, 0.1774);
  const jingShunPosition = data.positionSnapshots.find((row) => row.instrumentId === "CN.SZ.159509");
  assert.equal(jingShunPosition.quantity, 100);
  assert.equal(jingShunPosition.marketValue, 279);
  assert.equal(data.reconciliations.find((row) => row.instrumentId === "CN.SZ.159509").status, "matched");
  assert.equal(data.reconciliations.find((row) => row.instrumentId === "CN.SZ.159659").status, "matched");
  assert.equal(data.reconciliations.find((row) => row.instrumentId === "CN.SZ.159660").status, "matched");
  assert.equal(data.transactions.filter((row) => row.instrumentId === "CN.SZ.159660").length, 5);
  assert.equal(data.returns.available, false);
  assert.match(data.returns.reasons.join("；"), /手续费未齐/);
  assert.match(data.returns.reasons.join("；"), /银证转账只有累计总额，缺逐笔日期/);
  assert.equal(data.analysis.available, true);
  assert.equal(data.analysis.officialBenchmarks[0].symbol, "NDXTMC");
  assert.equal(data.analysis.officialBenchmarks[0].seriesAvailable, false);
  const blocked = data.analysis.episodes.find((item) => item.status === "blocked");
  assert.match(blocked.reason, /跨 2024—2026/);
  const scored = data.analysis.episodes.find((item) => item.status === "scorable");
  assert.equal(scored.asOf, "2026-08-25");
  assert.equal(scored.initialCost, 350290.5);
  assert.equal(scored.exitQuantity, 137100);
  assert.equal(scored.remainingQuantity, 0);
  assert.equal(scored.strategyValue, 384817.4);
  assert.equal(scored.strategyProfit, 34526.9);
  assert.equal(scored.strategyReturn, 0.0986);
  assert.equal(scored.passiveReturn, 0.0865);
  assert.equal(scored.behaviorReturn, 0.0121);
  assert.equal(scored.instrumentCloseReturn, 0.0823);
  assert.equal(scored.marketReferenceReturn, 0.0384);
  assert.equal(scored.sellTimingValue, 4252);
  assert.equal(scored.comparisonSeries.length, 23);
  assert.equal(scored.comparisonSeries.find((row) => row.date === "2026-08-11").strategy, 109.86);
  assert.equal(scored.comparisonSeries.at(-1).passive, 108.65);
  assert.match(data.warnings.join("；"), /20260811/);
});

test("unified investment ledger adds the custody account while keeping receivables outside investments", async () => {
  const root = new URL("../../..", import.meta.url).pathname;
  const data = await readInvestmentLedger(root);
  assert.equal(data.accounts.length, 3);
  assert.equal(data.accounts.some((row) => row.id === "jp-sbi-custody-sunxiang"), true);
  assert.equal(data.instruments.some((row) => row.id === "US.NASDAQ.TSLA"), true);
  assert.equal(data.instruments.some((row) => row.id === "JP.CUSTODY.NIKKEI"), true);
  assert.equal(data.instruments.some((row) => row.name.includes("应收")), false);
  assert.equal(data.transactions.filter((row) => row.accountId === "jp-sbi-custody-sunxiang").length, 4);
  assert.equal(data.transactions.filter((row) => row.instrumentId === "US.NASDAQ.NVDA" && row.side === "buy").length, 2);
  assert.equal(data.positionSnapshots.some((row) => row.instrumentId === "US.NASDAQ.GOOGL"), false);
  assert.equal(data.positionSnapshots.find((row) => row.instrumentId === "US.NASDAQ.NVDA")?.quantity, 10);
  assert.equal(data.accountReconciliations.find((row) => row.accountId === "jp-sbi-custody-sunxiang")?.status, "matched");
  assert.equal(data.portfolio.exposures.some((row) => row.name === "日本股票"), true);
  assert.match(data.coverage.missing.join("；"), /代持账户早期成交日期/);
  assert.equal(data.marketEvidence.sources.some((row) => row.id === "google-sheet-sunxiang-custody"), true);
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
  const markdown = `<!-- INFANS_INVESTMENT_LEDGER_JSON_START -->\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n<!-- INFANS_INVESTMENT_LEDGER_JSON_END -->`;
  const data = parseInvestmentLedgerMarkdown(markdown);
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
  const markdown = `<!-- INFANS_INVESTMENT_LEDGER_JSON_START -->\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n<!-- INFANS_INVESTMENT_LEDGER_JSON_END -->`;
  const row = parseInvestmentLedgerMarkdown(markdown).performance.rows.find((item) => item.instrumentId === "US.TEST");
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

test("incomplete US trades fall back to public price trend with confirmed action markers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/GOOGL/u);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          error: null,
          result: [{
            timestamp: [Date.parse("2025-08-06T00:00:00Z") / 1000, Date.parse("2026-08-06T00:00:00Z") / 1000],
            indicators: { quote: [{ close: [180, 360] }] },
          }],
        },
      }),
    };
  };
  try {
    const root = new URL("../../..", import.meta.url).pathname;
    const series = await readInvestmentInstrumentSeries(root, "US.NASDAQ.GOOGL");
    assert.equal(series.available, true);
    assert.equal(series.mode, "market-only");
    assert.equal(series.rows.at(-1).market, 200);
    assert.equal(series.actions.length, 1);
    assert.equal(series.actions[0].side, "sell");
    assert.match(series.note, /不是本人收益率/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("investment series ends on the closing trade unless a current position remains", async () => {
  const markdown = await fs.readFile(sourceUrl, "utf8");
  const data = parseInvestmentLedgerMarkdown(markdown);
  const hengyinTransactions = data.transactions.filter((row) => row.instrumentId === "CN.SH.603106");
  const jingShunTransactions = data.transactions.filter((row) => row.instrumentId === "CN.SZ.159509");
  assert.equal(resolveInvestmentSeriesEnd(hengyinTransactions, 0, data.portfolio.asOf), "2024-10-25");
  assert.equal(resolveInvestmentSeriesEnd(jingShunTransactions, 100, data.portfolio.asOf), "2026-08-27");
});

test("a quantity-matched cleared position remains chartable and period-recomputable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [{ hq: [["2024-10-24", "20", "20", "20", "20"], ["2024-10-25", "21", "21", "21", "21"]] }],
  });
  try {
    const root = new URL("../../..", import.meta.url).pathname;
    const series = await readInvestmentInstrumentSeries(root, "CN.SH.603106");
    assert.equal(series.available, true);
    assert.equal(series.to, "2024-10-25");
    assert.equal(series.rows.at(-1).quantity, 0);
    const period = await readInvestmentPeriodPerformance(root, { from: "2024-10-24", to: "2024-10-25" });
    const cleared = period.rows.find((row) => row.instrumentId === "CN.SH.603106" && row.transactionCount > 0);
    assert.equal(cleared.status, "available");
    assert.equal(cleared.to, "2024-10-25");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("investment performance sorting uses current holdings and actual trade timestamps", async () => {
  const markdown = await fs.readFile(sourceUrl, "utf8");
  const data = parseInvestmentLedgerMarkdown(markdown);
  const byCurrentValue = sortInvestmentPerformanceRows(data.performance.rows, "value");
  const byRecentTrade = sortInvestmentPerformanceRows(data.performance.rows, "date");
  assert.equal(byCurrentValue[0].instrumentId, "CN.FUND.006479");
  assert.equal(byCurrentValue.find((row) => row.instrumentId === "CN.SH.603106").currentMarketValue, 0);
  assert.equal(byRecentTrade[0].instrumentId, "CN.SZ.159509");
  assert.equal(byRecentTrade[0].lastTradedAt, "2026-08-11T10:35:00+08:00");
});

test("investment ledger rejects duplicate transaction ids", async () => {
  const markdown = await fs.readFile(sourceUrl, "utf8");
  const duplicated = markdown.replace(
    "cn-ebscn-3897-159509-20260514-104852-buy",
    "cn-ebscn-3897-159509-20260514-103005-buy",
  );
  assert.throws(() => parseInvestmentLedgerMarkdown(duplicated), /重复 ID/);
});

test("investment ledger rejects unknown account references", async () => {
  const markdown = await fs.readFile(sourceUrl, "utf8");
  const unknown = markdown.replace('"accountId":"cn-ebscn-self-3897"', '"accountId":"missing-account"');
  assert.throws(() => parseInvestmentLedgerMarkdown(unknown), /不存在的账户/);
});

test("investment analysis rejects market series with an unknown source", async () => {
  const markdown = await fs.readFile(sourceUrl, "utf8");
  const unknown = markdown.replace('"sourceId":"eastmoney-159509-daily"', '"sourceId":"missing-market-source"');
  assert.throws(() => parseInvestmentLedgerMarkdown(unknown), /行情引用了不存在的来源/);
});
