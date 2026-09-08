import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_INVESTMENT_DASHBOARD_PREFERENCES,
  INVESTMENT_DASHBOARD_DEMO_PREFERENCES_KEY,
  INVESTMENT_DASHBOARD_PREFERENCES_KEY,
  readInvestmentDashboardPreferences,
  writeInvestmentDashboardPreferences,
} from "../src/investment-dashboard-preferences.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test("investment dashboard remembers account, single-asset chart, and sorting", () => {
  const storage = memoryStorage();
  const preferences = {
    accountId: "cn-ebscn-self-3897",
    market: "US",
    instrumentId: "CN.SZ.159509",
    range: "year:2026",
    metric: "profit",
    sort: "date",
  };
  writeInvestmentDashboardPreferences(preferences, storage);
  assert.deepEqual(readInvestmentDashboardPreferences(storage), preferences);
});

test("investment dashboard ignores malformed or future preference payloads", () => {
  const storage = memoryStorage();
  storage.setItem(INVESTMENT_DASHBOARD_PREFERENCES_KEY, JSON.stringify({ version: 3, state: { accountId: "missing" } }));
  assert.deepEqual(readInvestmentDashboardPreferences(storage), DEFAULT_INVESTMENT_DASHBOARD_PREFERENCES);
  storage.setItem(INVESTMENT_DASHBOARD_PREFERENCES_KEY, "not json");
  assert.deepEqual(readInvestmentDashboardPreferences(storage), DEFAULT_INVESTMENT_DASHBOARD_PREFERENCES);
});

test("version 1 investment preferences migrate with safe current defaults", () => {
  const storage = memoryStorage();
  storage.setItem(INVESTMENT_DASHBOARD_PREFERENCES_KEY, JSON.stringify({ version: 1, state: { accountId: "all", market: "CN", instrumentId: "", range: "ytd", metric: "return", sort: "profit" } }));
  assert.deepEqual(readInvestmentDashboardPreferences(storage), {
    ...DEFAULT_INVESTMENT_DASHBOARD_PREFERENCES,
    market: "CN",
    range: "ytd",
  });
});

test("real and display-mode investment preferences stay separate", () => {
  const storage = memoryStorage();
  writeInvestmentDashboardPreferences({ ...DEFAULT_INVESTMENT_DASHBOARD_PREFERENCES, accountId: "real" }, storage, false);
  writeInvestmentDashboardPreferences({ ...DEFAULT_INVESTMENT_DASHBOARD_PREFERENCES, accountId: "demo" }, storage, true);
  assert.equal(readInvestmentDashboardPreferences(storage, false).accountId, "real");
  assert.equal(readInvestmentDashboardPreferences(storage, true).accountId, "demo");
  assert.equal(storage.values.has(INVESTMENT_DASHBOARD_PREFERENCES_KEY), true);
  assert.equal(storage.values.has(INVESTMENT_DASHBOARD_DEMO_PREFERENCES_KEY), true);
});
