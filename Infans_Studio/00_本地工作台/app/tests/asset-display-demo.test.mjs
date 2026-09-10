import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSET_DISPLAY_DEMO,
  readAssetDisplayDemoPerformance,
  readAssetDisplayDemoSeries,
} from "../src/asset-display-demo.ts";
import {
  availableInvestmentMarkets,
  investmentPositionState,
  scopeInvestmentLedger,
  scopeInvestmentPeriodPerformance,
} from "../src/investment-dashboard-scope.ts";

test("asset display mode uses an internally consistent ten-million portfolio", () => {
  const latest = ASSET_DISPLAY_DEMO.snapshots.at(-1);
  assert.equal(latest?.netAssets, 10_000_000);
  assert.equal(latest?.totalAssets, 10_750_000);
  assert.equal(latest?.totalLiabilities, 750_000);

  const investments = ASSET_DISPLAY_DEMO.investments;
  assert.ok(investments?.available);
  assert.equal(investments?.portfolio.totalAssets, 6_400_000);
  assert.equal(investments?.portfolio.cash + investments?.portfolio.marketValue, investments?.portfolio.totalAssets);
  assert.equal(investments?.accountSnapshots.reduce((sum, row) => sum + row.totalAssets, 0), investments?.portfolio.totalAssets);
  assert.equal(investments?.positionSnapshots.reduce((sum, row) => sum + row.marketValue, 0), investments?.portfolio.marketValue);
  assert.equal(investments?.positionSnapshots.reduce((sum, row) => sum + row.reportedPnl, 0), 1_196_000);
  assert.equal(investments?.portfolio.positionCount, 10);
  const bridge = investments?.cashFlowSummaries[0];
  assert.equal((bridge?.initialAssets || 0) + (bridge?.netInflow || 0) + (bridge?.reportedPnl || 0), bridge?.endingAssets);
});

test("asset display mode uses demo tickers and a ten-million portfolio", () => {
  const serialized = JSON.stringify(ASSET_DISPLAY_DEMO);
  assert.match(serialized, /DEMO\.CN\.300/);
  assert.equal(ASSET_DISPLAY_DEMO.snapshots.at(-1)?.netAssets, 10_000_000);
});

test("asset display investment comparison supports series and period recalculation", () => {
  const series = readAssetDisplayDemoSeries("DEMO.CN.300");
  assert.ok(series.available);
  assert.ok((series.rows?.length || 0) > 12);
  assert.ok((series.actions?.length || 0) > 0);

  const period = readAssetDisplayDemoPerformance("2026-01-01", "2026-08-27");
  assert.ok(period.available);
  assert.equal(period.summary.totalCount, 10);
  assert.equal(period.rows.every((row) => row.returnRate !== null && row.marketReturn !== null && row.operationDifference !== null && row.operationProfit !== null && row.passiveValue !== null), true);
  assert.equal(period.rows.some((row) => (row.operationDifference || 0) > 0), true);
  assert.equal(period.rows.some((row) => (row.operationDifference || 0) < 0), true);
  assert.equal(period.rows.find((row) => row.instrumentId === "DEMO.GOLD")?.returnRate < 0, true);

});

test("investment dashboard scope treats account as primary and market as secondary", () => {
  const investments = ASSET_DISPLAY_DEMO.investments;
  assert.ok(investments);
  assert.deepEqual(availableInvestmentMarkets(investments, "demo-account-b"), ["all", "US", "JP"]);

  const account = scopeInvestmentLedger(investments, "demo-account-b", "all");
  assert.deepEqual(account.accounts.map((row) => row.id), ["demo-account-b"]);
  assert.equal(account.portfolio.totalAssets, 2_600_000);
  assert.equal(account.portfolio.cash, 150_000);
  assert.equal(account.portfolio.marketValue, 2_450_000);
  assert.equal(account.performance.rows.every((row) => row.accountId === "demo-account-b"), true);

  const us = scopeInvestmentLedger(investments, "demo-account-b", "US");
  assert.equal(us.portfolio.totalAssets, 2_600_000);
  assert.equal(us.portfolio.cash, 150_000);
  assert.equal(us.portfolio.marketValue, 1_100_000);
  assert.deepEqual(us.instruments.map((row) => row.id), ["DEMO.US.NDX"]);

  const period = scopeInvestmentPeriodPerformance(readAssetDisplayDemoPerformance("2026-01-01", "2026-08-27"), us);
  assert.equal(period?.summary.totalCount, 1);
  assert.equal(period?.rows[0]?.accountId, "demo-account-b");
  assert.equal(period?.rows[0]?.instrumentId, "DEMO.US.NDX");
  assert.equal(period?.to, us.performance.to);
});

test("investment dashboard marks observation positions", () => {
  assert.equal(investmentPositionState(1_999.99, true), "watch-light");
  assert.equal(investmentPositionState(2_000, true), "watch-heavy");
  assert.equal(investmentPositionState(4_999.99, true), "watch-heavy");
  assert.equal(investmentPositionState(5_000, true), "position");
  assert.equal(investmentPositionState(100_000, false), "cleared");
});

test("asset display mode includes legible buy-low sell-high examples and a realistic expense ledger", () => {
  const investments = ASSET_DISPLAY_DEMO.investments;
  assert.ok((investments?.transactions.length || 0) >= 35);
  assert.ok((investments?.summary.buyCount || 0) > (investments?.summary.sellCount || 0));

  const ndx = readAssetDisplayDemoSeries("DEMO.US.NDX");
  const ndxBuys = (ndx.actions || []).filter((row) => row.side === "buy").map((row) => row.price);
  const ndxSells = (ndx.actions || []).filter((row) => row.side === "sell").map((row) => row.price);
  assert.ok(Math.max(...ndxSells) > Math.min(...ndxBuys) * 1.5);

  const cashflow = ASSET_DISPLAY_DEMO.cashflow;
  assert.equal(cashflow?.ledgerByMonth["2026-08"]?.length, 15);
  assert.equal(cashflow?.ledgerByMonth["2026-08"]?.reduce((sum, row) => sum + row.amount, 0), -96_000);
  const augustCats = new Set(cashflow?.ledgerByMonth["2026-08"]?.map((row) => row.category));
  assert.ok(augustCats.size >= 8);
  assert.equal(augustCats.has("娱乐"), true);
  assert.equal(augustCats.has("人情"), true);
  assert.equal(augustCats.has("吃喝"), true);
  assert.equal(augustCats.has("餐饮"), false);
  assert.equal(augustCats.has("转账红包"), false);
});
