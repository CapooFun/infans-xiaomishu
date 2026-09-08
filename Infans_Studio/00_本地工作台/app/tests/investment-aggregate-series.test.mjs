import assert from "node:assert/strict";
import test from "node:test";

import { calculateInvestmentPeriodComparison } from "../src/investment-aggregate-series.mjs";

test("single-asset period comparison still evaluates its own sale decision", () => {
  const rows = [
    { date: "2026-01-01", value: 100, profit: 0, passiveValue: 100, contributed: 100 },
    { date: "2026-01-02", value: 110, profit: 10, passiveValue: 105, contributed: 100 },
    { date: "2026-01-03", value: 120, profit: 20, passiveValue: 115, contributed: 100 },
  ];
  const periodRows = calculateInvestmentPeriodComparison(rows.slice(1), rows[0]);
  const last = periodRows.at(-1);
  assert.equal(last.profitView, 20);
  assert.equal(last.passiveProfitView, 15);
  assert.equal(last.operationProfitView, 5);
  assert.equal(Math.sign(last.operationDifference), Math.sign(last.operationProfitView));
  assert.equal(last.operationDifference, last.strategyReturn - last.marketReturn);
});

test("a large contribution does not create an artificial return cliff", () => {
  const baseline = {
    date: "2026-02-26",
    strategy: 144.53,
    passiveStrategy: 144.53,
    value: 2994.6,
    profit: 922.6,
    passiveValue: 2994.6,
    contributed: 2072,
  };
  const periodRows = calculateInvestmentPeriodComparison([
    {
      date: "2026-05-13",
      strategy: 175.41,
      passiveStrategy: 175.41,
      value: 3634.4,
      profit: 1562.4,
      passiveValue: 3634.4,
      contributed: 2072,
    },
    {
      date: "2026-05-14",
      strategy: 174.33,
      passiveStrategy: 174.33,
      value: 203181,
      profit: 1164.4,
      passiveValue: 203181,
      contributed: 202016.6,
    },
  ], baseline);
  const beforeContribution = periodRows[0];
  const afterContribution = periodRows[1];
  assert.equal(beforeContribution.strategyView, 121.37);
  assert.equal(afterContribution.strategyView, 120.62);
  assert.ok(beforeContribution.strategyView - afterContribution.strategyView < 1);
  assert.notEqual(afterContribution.strategyView, 100.12);
});
