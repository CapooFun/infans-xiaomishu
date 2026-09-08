import type {
  InvestmentInstrument,
  InvestmentLedgerData,
  InvestmentPeriodPerformance,
} from "./types";

export type InvestmentMarketScope = "all" | "CN" | "US" | "JP";

export const INVESTMENT_MARKET_LABELS: Record<InvestmentMarketScope, string> = {
  all: "全部市场",
  CN: "中国",
  US: "美国",
  JP: "日本",
};

export type InvestmentPositionState = "cleared" | "watch-light" | "watch-heavy" | "position";

export function investmentPositionState(currentMarketValue: number, currentPosition: boolean): InvestmentPositionState {
  if (!currentPosition) return "cleared";
  if (currentMarketValue < 2_000) return "watch-light";
  if (currentMarketValue < 5_000) return "watch-heavy";
  return "position";
}

export function investmentInstrumentMarket(instrument?: InvestmentInstrument): Exclude<InvestmentMarketScope, "all"> | null {
  if (!instrument) return null;
  if (instrument.exposureTags.some((tag) => /美国股票|纳斯达克|标普500|道琼斯/u.test(tag))) return "US";
  if (instrument.exposureTags.some((tag) => /日本股票|日经|NISA/u.test(tag))) return "JP";
  if (instrument.exposureTags.some((tag) => /中国股票|上证|深证|科创板/u.test(tag))) return "CN";
  return null;
}

function latestAccountSnapshots(ledger: InvestmentLedgerData) {
  return [...ledger.accountSnapshots]
    .sort((a, b) => b.asOf.localeCompare(a.asOf))
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.accountId === row.accountId) === index);
}

function investmentScopeKeys(ledger: InvestmentLedgerData, accountId: string) {
  const allowedAccounts = accountId === "all"
    ? new Set(ledger.accounts.map((account) => account.id))
    : new Set([accountId]);
  const pair = (row: { accountId: string; instrumentId: string }) => `${row.accountId}::${row.instrumentId}`;
  const pairs = new Set([
    ...ledger.performance.rows.filter((row) => allowedAccounts.has(row.accountId)).map(pair),
    ...ledger.positionSnapshots.filter((row) => allowedAccounts.has(row.accountId)).map(pair),
    ...ledger.transactions.filter((row) => allowedAccounts.has(row.accountId)).map(pair),
    ...ledger.historicalInvestments.filter((row) => allowedAccounts.has(row.accountId)).map(pair),
  ]);
  return { allowedAccounts, pairs };
}

export function availableInvestmentMarkets(ledger: InvestmentLedgerData, accountId: string): InvestmentMarketScope[] {
  const { pairs } = investmentScopeKeys(ledger, accountId);
  const instrumentById = new Map(ledger.instruments.map((instrument) => [instrument.id, instrument]));
  const markets = new Set<InvestmentMarketScope>();
  for (const key of pairs) {
    const instrumentId = key.slice(key.indexOf("::") + 2);
    const market = investmentInstrumentMarket(instrumentById.get(instrumentId));
    if (market) markets.add(market);
  }
  return ["all", ...(["CN", "US", "JP"] as const).filter((market) => markets.has(market))];
}

export function scopeInvestmentLedger(
  ledger: InvestmentLedgerData,
  accountId: string,
  market: InvestmentMarketScope,
): InvestmentLedgerData {
  const { allowedAccounts, pairs } = investmentScopeKeys(ledger, accountId);
  const instrumentById = new Map(ledger.instruments.map((instrument) => [instrument.id, instrument]));
  const pairAllowed = (row: { accountId: string; instrumentId: string }) => {
    if (!allowedAccounts.has(row.accountId) || !pairs.has(`${row.accountId}::${row.instrumentId}`)) return false;
    return market === "all" || investmentInstrumentMarket(instrumentById.get(row.instrumentId)) === market;
  };
  const scopedAccounts = ledger.accounts.filter((account) => allowedAccounts.has(account.id));
  const scopedPerformanceRows = ledger.performance.rows.filter(pairAllowed);
  const scopedPositions = ledger.positionSnapshots.filter(pairAllowed);
  const scopedTransactions = ledger.transactions.filter(pairAllowed);
  const scopedHistorical = ledger.historicalInvestments.filter(pairAllowed);
  const scopedInstrumentIds = new Set([
    ...scopedPerformanceRows.map((row) => row.instrumentId),
    ...scopedPositions.map((row) => row.instrumentId),
    ...scopedTransactions.map((row) => row.instrumentId),
    ...scopedHistorical.map((row) => row.instrumentId),
  ]);
  const scopedAccountSnapshots = latestAccountSnapshots(ledger).filter((snapshot) => allowedAccounts.has(snapshot.accountId));
  const scopedAccountReconciliations = ledger.accountReconciliations.filter((row) => allowedAccounts.has(row.accountId));
  const accountTotalAssets = scopedAccountSnapshots.reduce((sum, snapshot) => sum + snapshot.totalAssets, 0);
  const accountCash = scopedAccountSnapshots.reduce((sum, snapshot) => sum + snapshot.cash, 0);
  const fullAccountMarketValue = scopedAccountSnapshots.reduce((sum, snapshot) => sum + snapshot.marketValue, 0);
  const filteredPositionMarketValue = scopedPositions.reduce((sum, position) => sum + (position.marketValue || 0), 0);
  const marketValue = market === "all" ? fullAccountMarketValue : filteredPositionMarketValue;
  const currentPositions = scopedPositions.filter((position) => position.quantity > 0.000001 && (position.marketValue || 0) > 0);
  const largestPosition = currentPositions.toSorted((a, b) => (b.marketValue || 0) - (a.marketValue || 0))[0] || null;
  const exposureValues = new Map<string, number>();
  for (const position of currentPositions) {
    const positionMarket = investmentInstrumentMarket(instrumentById.get(position.instrumentId));
    const label = positionMarket ? INVESTMENT_MARKET_LABELS[positionMarket] + "股票" : "其他资产";
    exposureValues.set(label, (exposureValues.get(label) || 0) + (position.marketValue || 0));
  }
  const exposures = [...exposureValues.entries()]
    .map(([name, value]) => ({ name, value, weight: marketValue ? value / marketValue : 0 }))
    .toSorted((a, b) => b.value - a.value);
  const buyRows = scopedTransactions.filter((row) => row.side === "buy");
  const sellRows = scopedTransactions.filter((row) => row.side === "sell");
  const scopedAsOf = scopedAccountSnapshots.map((row) => row.asOf).sort().at(-1) || ledger.portfolio.asOf;
  return {
    ...ledger,
    accounts: scopedAccounts,
    instruments: ledger.instruments.filter((instrument) => scopedInstrumentIds.has(instrument.id)),
    accountSnapshots: scopedAccountSnapshots,
    cashFlowSummaries: ledger.cashFlowSummaries.filter((row) => allowedAccounts.has(row.accountId)),
    transactions: scopedTransactions,
    positionSnapshots: scopedPositions,
    historicalInvestments: scopedHistorical,
    summary: {
      tradeCount: scopedTransactions.length,
      buyCount: buyRows.length,
      sellCount: sellRows.length,
      buyQuantity: buyRows.reduce((sum, row) => sum + row.quantity, 0),
      sellQuantity: sellRows.reduce((sum, row) => sum + row.quantity, 0),
      netQuantity: scopedTransactions.reduce((sum, row) => sum + (row.side === "buy" ? row.quantity : -row.quantity), 0),
      buyGross: buyRows.reduce((sum, row) => sum + row.grossAmount, 0),
      sellGross: sellRows.reduce((sum, row) => sum + row.grossAmount, 0),
      feesKnown: scopedTransactions.every((row) => row.fees !== null),
      taxesKnown: scopedTransactions.every((row) => row.taxes !== null),
    },
    reconciliations: ledger.reconciliations.filter(pairAllowed),
    accountReconciliations: scopedAccountReconciliations,
    portfolio: {
      ...ledger.portfolio,
      asOf: scopedAsOf,
      totalAssets: accountTotalAssets,
      cash: accountCash,
      marketValue,
      investedRatio: accountTotalAssets ? marketValue / accountTotalAssets : null,
      accountCount: scopedAccounts.length,
      positionCount: currentPositions.length,
      reconciledAccountCount: scopedAccountReconciliations.filter((row) => row.status === "matched").length,
      largestPositionId: largestPosition?.instrumentId || "",
      largestPositionWeight: largestPosition && marketValue ? (largestPosition.marketValue || 0) / marketValue : null,
      exposures,
    },
    performance: {
      ...ledger.performance,
      to: scopedAsOf,
      availableCount: scopedPerformanceRows.filter((row) => row.status === "available").length,
      rows: scopedPerformanceRows,
      accountReturns: ledger.performance.accountReturns.filter((row) => allowedAccounts.has(row.accountId)),
    },
    analysis: {
      ...ledger.analysis,
      episodes: ledger.analysis.episodes.filter(pairAllowed),
      officialBenchmarks: ledger.analysis.officialBenchmarks.filter((row) => scopedInstrumentIds.has(row.instrumentId)),
    },
  };
}

export function scopeInvestmentPeriodPerformance(
  performance: InvestmentPeriodPerformance | null,
  ledger: InvestmentLedgerData,
): InvestmentPeriodPerformance | null {
  if (!performance) return null;
  const allowedPairs = new Set(ledger.performance.rows.map((row) => `${row.accountId}::${row.instrumentId}`));
  const rows = performance.rows.filter((row) => allowedPairs.has(`${row.accountId}::${row.instrumentId}`));
  const availableRows = rows.filter((row) => row.status === "available" && row.profit !== null);
  const totalProfit = availableRows.reduce((sum, row) => sum + (row.profit || 0), 0);
  return {
    ...performance,
    from: performance.from > ledger.performance.from ? performance.from : ledger.performance.from,
    to: performance.to < ledger.performance.to ? performance.to : ledger.performance.to,
    available: rows.length > 0,
    rows: rows.map((row) => ({
      ...row,
      contributionRate: row.profit === null || !totalProfit ? null : row.profit / totalProfit,
    })),
    summary: {
      totalCount: rows.length,
      availableCount: availableRows.length,
      positiveCount: availableRows.filter((row) => (row.profit || 0) > 0).length,
      negativeCount: availableRows.filter((row) => (row.profit || 0) < 0).length,
      totalProfit,
    },
    message: rows.length ? performance.message : "所选账户或市场在这个区间没有投资记录。",
  };
}
