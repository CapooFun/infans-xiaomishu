import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { convertAmountToCny, resolveJpyToCny } from "../src/asset-fx.mjs";

test("fixed and live FX bases revalue the same JPY amount without changing the original amount", () => {
  const amountJpy = 100_000;
  assert.equal(resolveJpyToCny("stable", 0.047, 0.042), 0.047);
  assert.equal(resolveJpyToCny("live", 0.047, 0.042), 0.042);
  assert.equal(convertAmountToCny(amountJpy, "JPY", 0.047), 4_700);
  assert.equal(convertAmountToCny(amountJpy, "JPY", 0.042), 4_200);
  assert.equal(amountJpy, 100_000);
  assert.equal(convertAmountToCny(3_000, "CNY", 0.042), 3_000);
});

test("missing live FX fails back to the fixed 4.7 basis", () => {
  assert.equal(resolveJpyToCny("live", 0.047, null), 0.047);
  assert.equal(resolveJpyToCny("live", 0.047, Number.NaN), 0.047);
});

test("asset and cashflow views both consume the shared selected FX basis", () => {
  const assetsPage = readFileSync(new URL("../src/pages/AssetsPage.tsx", import.meta.url), "utf8");
  const cashflowPanel = readFileSync(new URL("../src/pages/AssetCashflowPanel.tsx", import.meta.url), "utf8");
  assert.match(assetsPage, /map\(\(item\) => revalueSnapshot\(item, activeRate\)\)/u);
  assert.match(assetsPage, /jpyToCny=\{activeRate\}/u);
  assert.match(cashflowPanel, /aggregateFromLedger\(ledger, jpyToCny\)/u);
  assert.match(cashflowPanel, /pickTrendCategories\(selected, mergedLedgerByMonth, mode, jpyToCny, 5\)/u);
  assert.match(cashflowPanel, /stackedTrend\(selected, mergedLedgerByMonth, mode, trendCats, jpyToCny\)/u);
});
