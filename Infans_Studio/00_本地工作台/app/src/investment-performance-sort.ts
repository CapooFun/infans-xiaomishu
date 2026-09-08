import type { InvestmentInstrumentPerformance, InvestmentPeriodPerformanceRow } from "./types";

export type InvestmentPerformanceSort = "profit" | "rate" | "value" | "date";

function compareNullableNumbers(aValue: number | null | undefined, bValue: number | null | undefined) {
  if (aValue === null || aValue === undefined) return bValue === null || bValue === undefined ? 0 : 1;
  if (bValue === null || bValue === undefined) return -1;
  return bValue - aValue;
}

export function sortInvestmentPerformanceRows<T extends InvestmentInstrumentPerformance | InvestmentPeriodPerformanceRow>(
  rows: T[],
  sort: InvestmentPerformanceSort,
): T[] {
  return rows.toSorted((a, b) => {
    if (sort === "rate") return compareNullableNumbers(a.returnRate, b.returnRate);
    if (sort === "value") return compareNullableNumbers(a.currentMarketValue, b.currentMarketValue)
      || compareNullableNumbers(a.profit, b.profit);
    if (sort === "date") return (b.lastTradedAt || "").localeCompare(a.lastTradedAt || "")
      || compareNullableNumbers(a.profit, b.profit);
    return compareNullableNumbers(a.profit, b.profit);
  });
}
