import type { InvestmentMarketScope } from "./investment-dashboard-scope";
import type { InvestmentPerformanceSort } from "./investment-performance-sort";

export type InvestmentDashboardRange = "all" | "mtd" | "3m" | "6m" | "ytd" | "1y" | `year:${string}`;
export type InvestmentChartMetric = "return" | "profit";

export type InvestmentDashboardPreferences = {
  accountId: string;
  market: InvestmentMarketScope;
  instrumentId: string;
  range: InvestmentDashboardRange;
  metric: InvestmentChartMetric;
  sort: InvestmentPerformanceSort;
};

export const INVESTMENT_DASHBOARD_PREFERENCES_KEY = "infans-investment-dashboard-preferences-v1";
export const INVESTMENT_DASHBOARD_DEMO_PREFERENCES_KEY = "infans-investment-dashboard-demo-preferences-v1";

export const DEFAULT_INVESTMENT_DASHBOARD_PREFERENCES: InvestmentDashboardPreferences = {
  accountId: "all",
  market: "all",
  instrumentId: "",
  range: "all",
  metric: "return",
  sort: "profit",
};

function storageKey(demoMode: boolean) {
  return demoMode ? INVESTMENT_DASHBOARD_DEMO_PREFERENCES_KEY : INVESTMENT_DASHBOARD_PREFERENCES_KEY;
}

function safeId(value: unknown, fallback: string) {
  return typeof value === "string" && value.length <= 180 ? value : fallback;
}

function safeMarket(value: unknown): InvestmentMarketScope {
  return value === "CN" || value === "US" || value === "JP" || value === "all" ? value : "all";
}

function safeRange(value: unknown): InvestmentDashboardRange {
  if (value === "all" || value === "mtd" || value === "3m" || value === "6m" || value === "ytd" || value === "1y") return value;
  return typeof value === "string" && /^year:\d{4}$/u.test(value) ? value as InvestmentDashboardRange : "all";
}

function safeMetric(value: unknown): InvestmentChartMetric {
  return value === "profit" ? value : "return";
}

function safeSort(value: unknown): InvestmentPerformanceSort {
  return value === "rate" || value === "value" || value === "date" || value === "profit" ? value : "profit";
}

export function readInvestmentDashboardPreferences(
  storage: Pick<Storage, "getItem"> = window.localStorage,
  demoMode = false,
): InvestmentDashboardPreferences {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(demoMode)) || "null") as { version?: unknown; state?: Record<string, unknown> } | null;
    if ((parsed?.version !== 1 && parsed?.version !== 2) || !parsed.state) return { ...DEFAULT_INVESTMENT_DASHBOARD_PREFERENCES };
    return {
      accountId: safeId(parsed.state.accountId, "all"),
      market: safeMarket(parsed.state.market),
      instrumentId: safeId(parsed.state.instrumentId, ""),
      range: safeRange(parsed.state.range),
      metric: safeMetric(parsed.state.metric),
      sort: safeSort(parsed.state.sort),
    };
  } catch {
    return { ...DEFAULT_INVESTMENT_DASHBOARD_PREFERENCES };
  }
}

export function writeInvestmentDashboardPreferences(
  preferences: InvestmentDashboardPreferences,
  storage: Pick<Storage, "setItem"> = window.localStorage,
  demoMode = false,
) {
  try {
    storage.setItem(storageKey(demoMode), JSON.stringify({ version: 2, state: preferences }));
  } catch {
    // 浏览器禁用本地存储时，本次打开期间仍由 React 状态保持。
  }
}
