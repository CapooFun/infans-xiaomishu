import fsp from "node:fs/promises";
import { ensureInside } from "./workbench-data.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { A_SHARE_INVESTMENT_LEDGER, PERSONAL_TRADE_MEMO } from "./vault-paths.mjs";
import {
  buildSunxiangInvestmentExtension,
  parseConfirmedTradeMemoMarkdown,
  readSunxiangCustody,
} from "./workbench-sunxiang-custody.mjs";
import { calculateInvestmentPeriodComparison } from "../investment-aggregate-series.mjs";

export const INVESTMENT_LEDGER_SOURCE = A_SHARE_INVESTMENT_LEDGER;

function mergeInvestmentLedgerExtension(base, extension) {
  if (!extension) return base;
  const uniqueStrings = (rows) => [...new Set(rows.filter(Boolean))];
  const dates = (...values) => values.flat().filter((value) => /^\d{4}-\d{2}-\d{2}$/u.test(String(value))).sort();
  const fromDates = dates(base.coverage?.from, extension.coverage?.from);
  const toDates = dates(base.coverage?.to, extension.coverage?.to, base.source?.asOf, extension.source?.asOf);
  return {
    ...base,
    source: {
      ...base.source,
      title: "个人投资账本（自营、基金与代持）",
      asOf: toDates.at(-1) || base.source?.asOf || "",
    },
    coverage: {
      ...base.coverage,
      status: "partial",
      from: fromDates[0] || base.coverage?.from || "",
      to: toDates.at(-1) || base.coverage?.to || "",
      holdingsStatus: `${base.coverage?.holdingsStatus || "partial"}+${extension.coverage?.holdingsStatus || "partial"}`,
      transactionsStatus: "partial",
      cashFlowsStatus: base.coverage?.cashFlowsStatus === "complete" && extension.coverage?.cashFlowsStatus === "complete" ? "complete" : "partial",
      note: [base.coverage?.note, extension.coverage?.note].filter(Boolean).join("；"),
      missing: uniqueStrings([...(base.coverage?.missing || []), ...(extension.coverage?.missing || [])]),
      futureCapture: uniqueStrings([...(base.coverage?.futureCapture || []), ...(extension.coverage?.futureCapture || [])]),
    },
    accounts: [...(base.accounts || []), ...(extension.accounts || [])],
    instruments: [...(base.instruments || []), ...(extension.instruments || [])],
    accountSnapshots: [...(base.accountSnapshots || []), ...(extension.accountSnapshots || [])],
    cashFlowSummaries: [...(base.cashFlowSummaries || []), ...(extension.cashFlowSummaries || [])],
    transactions: [...(base.transactions || []), ...(extension.transactions || [])],
    positionSnapshots: [...(base.positionSnapshots || []), ...(extension.positionSnapshots || [])],
    historicalInvestments: [...(base.historicalInvestments || []), ...(extension.historicalInvestments || [])],
    marketEvidence: {
      ...base.marketEvidence,
      asOf: toDates.at(-1) || base.marketEvidence?.asOf || extension.marketEvidence?.asOf || "",
      sources: [...(base.marketEvidence?.sources || []), ...(extension.marketEvidence?.sources || [])],
      series: [...(base.marketEvidence?.series || []), ...(extension.marketEvidence?.series || [])],
    },
  };
}

function text(value, fallback = "", max = 160) {
  return String(value ?? fallback).slice(0, max);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function uniqueById(rows, label) {
  const ids = new Set();
  for (const row of rows) {
    if (!row.id) throw new WorkbenchWriteError(`${label}缺少稳定 ID`, 500, "INVESTMENT_LEDGER_INVALID");
    if (ids.has(row.id)) throw new WorkbenchWriteError(`${label}存在重复 ID`, 500, "INVESTMENT_LEDGER_INVALID");
    ids.add(row.id);
  }
  return ids;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10_000) / 10_000;
}

function safeHttpsUrl(value) {
  const url = text(value, "", 500);
  return url.startsWith("https://") ? url : "";
}

function parseMarketSeries(input, sourceIds) {
  const series = (Array.isArray(input) ? input : []).map((row) => ({
    id: text(row?.id, "", 120),
    label: text(row?.label, "未命名行情", 100),
    currency: text(row?.currency, "", 8),
    sourceId: text(row?.sourceId, "", 120),
    points: (Array.isArray(row?.points) ? row.points : []).flatMap((point) => {
      const date = text(point?.[0], "", 16);
      const value = finiteNumber(point?.[1], Number.NaN);
      return /^\d{4}-\d{2}-\d{2}$/u.test(date) && Number.isFinite(value) && value > 0 ? [{ date, value }] : [];
    }).sort((a, b) => a.date.localeCompare(b.date)),
  }));
  uniqueById(series, "投资行情序列");
  for (const row of series) {
    if (!sourceIds.has(row.sourceId)) throw new WorkbenchWriteError("投资行情引用了不存在的来源", 500, "INVESTMENT_LEDGER_INVALID");
  }
  return series;
}

function maxDrawdown(values) {
  let peak = Number.NEGATIVE_INFINITY;
  let deepest = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    peak = Math.max(peak, value);
    if (peak > 0) deepest = Math.min(deepest, value / peak - 1);
  }
  return round4(deepest);
}

function buildInvestmentAnalysis({ parsed, accounts, instruments, transactions, marketEvidence }) {
  const transactionById = new Map(transactions.map((row) => [row.id, row]));
  const seriesById = new Map(marketEvidence.series.map((row) => [row.id, row]));
  const episodes = (Array.isArray(parsed.analysisEpisodes) ? parsed.analysisEpisodes : []).map((episode) => {
    const base = {
      id: text(episode?.id, "", 120),
      label: text(episode?.label, "未命名交易阶段", 120),
      accountId: text(episode?.accountId, "", 100),
      instrumentId: text(episode?.instrumentId, "", 100),
      from: text(episode?.from, "", 16),
      to: text(episode?.to, "", 16),
      thesis: text(episode?.thesis, "", 260),
    };
    if (episode?.status !== "scorable") {
      return { ...base, status: "blocked", reason: text(episode?.reason, "缺少完整成本或成交原件。", 260) };
    }

    const entries = (Array.isArray(episode.entryTransactionIds) ? episode.entryTransactionIds : []).map((id) => transactionById.get(text(id, "", 120))).filter(Boolean);
    const exits = (Array.isArray(episode.exitTransactionIds) ? episode.exitTransactionIds : []).map((id) => transactionById.get(text(id, "", 120))).filter(Boolean);
    const priceSeries = seriesById.get(text(episode.priceSeriesId, "", 120));
    const marketSeries = seriesById.get(text(episode.marketReferenceSeriesId, "", 120));
    const invalidReference = !accounts.some((row) => row.id === base.accountId) || !instruments.some((row) => row.id === base.instrumentId);
    if (invalidReference || !entries.length || !priceSeries?.points.length || entries.some((row) => row.side !== "buy") || exits.some((row) => row.side !== "sell")) {
      return { ...base, status: "blocked", reason: "交易阶段缺少可评分的买入、卖出或行情序列。" };
    }

    const initialQuantity = entries.reduce((sum, row) => sum + row.quantity, 0);
    const initialCost = round2(entries.reduce((sum, row) => sum + row.grossAmount, 0));
    const entryPrice = initialQuantity > 0 ? initialCost / initialQuantity : 0;
    const exitQuantity = exits.reduce((sum, row) => sum + row.quantity, 0);
    const exitProceeds = round2(exits.reduce((sum, row) => sum + row.grossAmount, 0));
    const remainingQuantity = initialQuantity - exitQuantity;
    const sortedExits = exits.toSorted((a, b) => a.tradedAt.localeCompare(b.tradedAt));
    const pricePoints = priceSeries.points.filter((point) => point.date >= base.from && point.date <= base.to);
    const firstPrice = pricePoints[0]?.value;
    const lastPoint = pricePoints.at(-1);
    if (!(initialCost > 0) || remainingQuantity < 0 || !firstPrice || !lastPoint) {
      return { ...base, status: "blocked", reason: "交易阶段数量或行情无法对平。" };
    }

    const marketPoints = new Map((marketSeries?.points || []).filter((point) => point.date >= base.from && point.date <= base.to).map((point) => [point.date, point.value]));
    const marketStart = marketPoints.get(pricePoints[0].date) || [...marketPoints.values()][0] || null;
    const comparisonSeries = pricePoints.map((point) => {
      const completedExits = sortedExits.filter((row) => row.tradedAt.slice(0, 10) <= point.date);
      const completedQuantity = completedExits.reduce((sum, row) => sum + row.quantity, 0);
      const completedProceeds = completedExits.reduce((sum, row) => sum + row.grossAmount, 0);
      const strategyValue = completedProceeds + (initialQuantity - completedQuantity) * point.value;
      const marketValue = marketPoints.get(point.date);
      return {
        date: point.date,
        strategy: round2((strategyValue / initialCost) * 100),
        passive: round2(((initialQuantity * point.value) / initialCost) * 100),
        instrument: round2((point.value / firstPrice) * 100),
        market: marketStart && marketValue ? round2((marketValue / marketStart) * 100) : null,
      };
    });
    const endPrice = lastPoint.value;
    const strategyValue = round2(exitProceeds + remainingQuantity * endPrice);
    const passiveValue = round2(initialQuantity * endPrice);
    const strategyProfit = round2(strategyValue - initialCost);
    const realizedProfit = round2(exitProceeds - exitQuantity * entryPrice);
    const unrealizedProfit = round2(remainingQuantity * (endPrice - entryPrice));
    const strategyReturn = round4(strategyValue / initialCost - 1);
    const passiveReturn = round4(passiveValue / initialCost - 1);
    const behaviorReturn = round4(strategyReturn - passiveReturn);
    const instrumentCloseReturn = round4(endPrice / firstPrice - 1);
    const marketEnd = marketPoints.get(lastPoint.date) || [...marketPoints.values()].at(-1) || null;
    const marketReferenceReturn = marketStart && marketEnd ? round4(marketEnd / marketStart - 1) : null;
    const entryExecution = round4(firstPrice / entryPrice - 1);
    const sellTimingValue = round2(sortedExits.reduce((sum, row) => sum + row.quantity * (row.price - endPrice), 0));
    const sellTimingReturn = round4(sellTimingValue / initialCost);
    const verdict = behaviorReturn > 0.002
      ? `截至 ${lastPoint.date}，操作超额收益为 +${round2(behaviorReturn * 100).toFixed(2)}%。`
      : behaviorReturn < -0.002
        ? `截至 ${lastPoint.date}，操作超额收益为 -${round2(Math.abs(behaviorReturn) * 100).toFixed(2)}%。`
        : `截至 ${lastPoint.date}，分批卖出与不操作持有的结果接近。`;

    return {
      ...base,
      status: "scorable",
      asOf: lastPoint.date,
      priceSeriesLabel: priceSeries.label,
      marketReferenceLabel: marketSeries?.label || "市场参考",
      initialQuantity,
      initialCost,
      entryPrice: round4(entryPrice),
      exitQuantity,
      exitProceeds,
      remainingQuantity,
      endPrice,
      strategyValue,
      passiveValue,
      remainingMarketValue: round2(remainingQuantity * endPrice),
      strategyProfit,
      realizedProfit,
      unrealizedProfit,
      strategyReturn,
      passiveReturn,
      behaviorReturn,
      instrumentCloseReturn,
      marketReferenceReturn,
      marketSpread: marketReferenceReturn === null ? null : round4(instrumentCloseReturn - marketReferenceReturn),
      entryExecution,
      sellTimingValue,
      sellTimingReturn,
      maxDrawdown: maxDrawdown(comparisonSeries.map((row) => row.strategy)),
      verdict,
      comparisonSeries,
      actions: [...entries, ...exits].sort((a, b) => a.tradedAt.localeCompare(b.tradedAt)).map((row) => ({
        id: row.id,
        date: row.tradedAt.slice(0, 10),
        side: row.side,
        quantity: row.quantity,
        price: row.price,
      })),
      caveats: ["未计手续费与税费", "只评价这段已对平交易，不代表完整账户", "纳斯达克100是市场参考，不是基金官方跟踪指数"],
    };
  });
  uniqueById(episodes, "投资分析阶段");
  return {
    asOf: marketEvidence.asOf,
    available: episodes.some((row) => row.status === "scorable"),
    episodes,
    officialBenchmarks: instruments.flatMap((instrument) => instrument.officialBenchmark ? [{ instrumentId: instrument.id, ...instrument.officialBenchmark, seriesAvailable: false, reason: "已确认官方基准定义；尚未接入可复算的 NDXTMC 历史序列。" }] : []),
  };
}

export function parseInvestmentLedgerMarkdown(markdown, extension = null) {
  const raw = String(markdown).match(
    /<!-- INFANS_INVESTMENT_LEDGER_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- INFANS_INVESTMENT_LEDGER_JSON_END -->/,
  )?.[1];
  if (!raw) throw new WorkbenchWriteError("投资账本里没有可读的数据块", 500, "INVESTMENT_LEDGER_INVALID");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkbenchWriteError("读不懂这份投资账本", 500, "INVESTMENT_LEDGER_INVALID");
  }
  parsed = mergeInvestmentLedgerExtension(parsed, extension);

  const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : []).map((row) => ({
    id: text(row?.id, "", 100),
    label: text(row?.label, "未命名账户", 100),
    broker: text(row?.broker, "", 80),
    country: text(row?.country, "", 8),
    ownerType: text(row?.ownerType, "self", 24),
    baseCurrency: text(row?.baseCurrency, parsed.baseCurrency ?? "CNY", 8),
    accountClass: text(row?.accountClass, "brokerage", 32),
  }));
  const accountIds = uniqueById(accounts, "投资账户");

  const instruments = (Array.isArray(parsed.instruments) ? parsed.instruments : []).map((row) => ({
    id: text(row?.id, "", 100),
    symbol: text(row?.symbol, "", 32),
    name: text(row?.name, "未命名证券", 100),
    exchange: text(row?.exchange, "", 24),
    assetClass: text(row?.assetClass, "未分类", 40),
    listingCurrency: text(row?.listingCurrency, parsed.baseCurrency ?? "CNY", 8),
    exposureTags: (Array.isArray(row?.exposureTags) ? row.exposureTags : []).slice(0, 12).map((tag) => text(tag, "", 40)).filter(Boolean),
    officialBenchmark: row?.officialBenchmark ? {
      symbol: text(row.officialBenchmark.symbol, "", 32),
      name: text(row.officialBenchmark.name, "", 120),
      returnBasis: text(row.officialBenchmark.returnBasis, "", 160),
      sourceUrl: safeHttpsUrl(row.officialBenchmark.sourceUrl),
      indexUrl: safeHttpsUrl(row.officialBenchmark.indexUrl),
    } : null,
  }));
  const instrumentIds = uniqueById(instruments, "投资证券");

  const accountSnapshots = (Array.isArray(parsed.accountSnapshots) ? parsed.accountSnapshots : []).map((row) => ({
    id: text(row?.id, "", 120),
    asOf: text(row?.asOf, "", 16),
    accountId: text(row?.accountId, "", 100),
    totalAssets: finiteNumber(row?.totalAssets),
    cash: finiteNumber(row?.cash),
    marketValue: finiteNumber(row?.marketValue),
    available: nullableNumber(row?.available),
    withdrawable: nullableNumber(row?.withdrawable),
    investedRatio: nullableNumber(row?.investedRatio),
    reportedPnl: nullableNumber(row?.reportedPnl),
    reportedPnlRate: nullableNumber(row?.reportedPnlRate),
    reportedPnlLabel: text(row?.reportedPnlLabel, "累计盈亏", 80),
    holdingPnl: nullableNumber(row?.holdingPnl),
    sourceQuality: text(row?.sourceQuality, "unknown", 40),
    note: text(row?.note, "", 260),
  })).sort((a, b) => a.asOf.localeCompare(b.asOf));
  uniqueById(accountSnapshots, "投资账户快照");
  for (const snapshot of accountSnapshots) {
    if (!accountIds.has(snapshot.accountId)) throw new WorkbenchWriteError("投资账户快照引用了不存在的账户", 500, "INVESTMENT_LEDGER_INVALID");
  }

  const warnings = [];
  const transactions = (Array.isArray(parsed.transactions) ? parsed.transactions : []).map((row) => {
    const side = row?.side === "sell" ? "sell" : row?.side === "buy" ? "buy" : "";
    const quantity = finiteNumber(row?.quantity);
    const price = finiteNumber(row?.price);
    if (!side || quantity <= 0 || price <= 0) {
      throw new WorkbenchWriteError("投资成交存在无效方向、数量或价格", 500, "INVESTMENT_LEDGER_INVALID");
    }
    const calculatedGross = round2(quantity * price);
    const suppliedGross = nullableNumber(row?.grossAmount);
    if (suppliedGross !== null && Math.abs(round2(suppliedGross) - calculatedGross) > 0.02) {
      warnings.push(`${text(row?.id, "未命名成交", 100)} 的成交额与数量×价格不一致`);
    }
    return {
      id: text(row?.id, "", 120),
      accountId: text(row?.accountId, "", 100),
      instrumentId: text(row?.instrumentId, "", 100),
      tradedAt: text(row?.tradedAt, "", 40),
      side,
      quantity,
      price,
      currency: text(row?.currency, parsed.baseCurrency ?? "CNY", 8),
      grossAmount: suppliedGross === null ? calculatedGross : round2(suppliedGross),
      performanceGrossAmountCny: nullableNumber(row?.performanceGrossAmountCny),
      fees: nullableNumber(row?.fees),
      taxes: nullableNumber(row?.taxes),
      sourceRef: text(row?.sourceRef, "", 180),
    };
  }).sort((a, b) => a.tradedAt.localeCompare(b.tradedAt));
  uniqueById(transactions, "投资成交");
  for (const transaction of transactions) {
    if (!accountIds.has(transaction.accountId) || !instrumentIds.has(transaction.instrumentId)) {
      throw new WorkbenchWriteError("投资成交引用了不存在的账户或证券", 500, "INVESTMENT_LEDGER_INVALID");
    }
  }

  const positionSnapshots = (Array.isArray(parsed.positionSnapshots) ? parsed.positionSnapshots : []).map((row) => ({
    id: text(row?.id, "", 120),
    asOf: text(row?.asOf, "", 16),
    accountId: text(row?.accountId, "", 100),
    instrumentId: text(row?.instrumentId, "", 100),
    quantity: finiteNumber(row?.quantity),
    quantityApproximate: row?.quantityApproximate === true,
    alternateReportedQuantity: nullableNumber(row?.alternateReportedQuantity),
    referencePrice: nullableNumber(row?.referencePrice),
    costPrice: nullableNumber(row?.costPrice),
    marketValue: nullableNumber(row?.marketValue),
    reportedPnl: nullableNumber(row?.reportedPnl),
    reportedPnlRate: nullableNumber(row?.reportedPnlRate),
    pnlBasis: text(row?.pnlBasis, "", 160),
    sourceQuality: text(row?.sourceQuality, "unknown", 40),
    note: text(row?.note, "", 260),
  }));
  uniqueById(positionSnapshots, "投资持仓快照");
  for (const position of positionSnapshots) {
    if (!accountIds.has(position.accountId) || !instrumentIds.has(position.instrumentId)) {
      throw new WorkbenchWriteError("投资持仓引用了不存在的账户或证券", 500, "INVESTMENT_LEDGER_INVALID");
    }
  }

  const historicalInvestments = (Array.isArray(parsed.historicalInvestments) ? parsed.historicalInvestments : []).map((row) => ({
    id: text(row?.id, "", 120),
    accountId: text(row?.accountId, "", 100),
    instrumentId: text(row?.instrumentId, "", 100),
    from: text(row?.from, "", 16),
    to: text(row?.to, "", 16),
    status: row?.status === "closed" ? "closed" : "recorded",
    investedAmount: nullableNumber(row?.investedAmount),
    endingValue: nullableNumber(row?.endingValue),
    profit: nullableNumber(row?.profit),
    returnRate: nullableNumber(row?.returnRate),
    holdingDays: nullableNumber(row?.holdingDays),
    sourceRef: text(row?.sourceRef, "", 180),
    note: text(row?.note, "", 260),
  }));
  uniqueById(historicalInvestments, "历史投资记录");
  for (const record of historicalInvestments) {
    if (!accountIds.has(record.accountId) || !instrumentIds.has(record.instrumentId)) {
      throw new WorkbenchWriteError("历史投资记录引用了不存在的账户或证券", 500, "INVESTMENT_LEDGER_INVALID");
    }
  }

  const buyRows = transactions.filter((row) => row.side === "buy");
  const sellRows = transactions.filter((row) => row.side === "sell");
  const summary = {
    tradeCount: transactions.length,
    buyCount: buyRows.length,
    sellCount: sellRows.length,
    buyQuantity: buyRows.reduce((sum, row) => sum + row.quantity, 0),
    sellQuantity: sellRows.reduce((sum, row) => sum + row.quantity, 0),
    netQuantity: buyRows.reduce((sum, row) => sum + row.quantity, 0) - sellRows.reduce((sum, row) => sum + row.quantity, 0),
    buyGross: round2(buyRows.reduce((sum, row) => sum + row.grossAmount, 0)),
    sellGross: round2(sellRows.reduce((sum, row) => sum + row.grossAmount, 0)),
    feesKnown: transactions.length > 0 && transactions.every((row) => row.fees !== null),
    taxesKnown: transactions.length > 0 && transactions.every((row) => row.taxes !== null),
  };

  const reconciliations = positionSnapshots.map((position) => {
    const coveredNetQuantity = transactions
      .filter((row) => row.accountId === position.accountId && row.instrumentId === position.instrumentId && row.tradedAt.slice(0, 10) <= position.asOf)
      .reduce((sum, row) => sum + (row.side === "buy" ? row.quantity : -row.quantity), 0);
    const openingOrMissingQuantity = position.quantity - coveredNetQuantity;
    return {
      accountId: position.accountId,
      instrumentId: position.instrumentId,
      asOf: position.asOf,
      coveredNetQuantity,
      reportedQuantity: position.quantity,
      openingOrMissingQuantity,
      status: Math.abs(openingOrMissingQuantity) < 0.000001 ? "matched" : "needs-opening-position",
    };
  });

  const accountReconciliations = accountSnapshots.map((snapshot) => {
    const positionMarketValue = round2(positionSnapshots
      .filter((row) => row.accountId === snapshot.accountId && row.asOf === snapshot.asOf)
      .reduce((sum, row) => sum + (row.marketValue ?? 0), 0));
    const positionReportedPnl = round2(positionSnapshots
      .filter((row) => row.accountId === snapshot.accountId && row.asOf === snapshot.asOf)
      .reduce((sum, row) => sum + (row.reportedPnl ?? 0), 0));
    return {
      accountId: snapshot.accountId,
      asOf: snapshot.asOf,
      reportedMarketValue: snapshot.marketValue,
      positionMarketValue,
      marketValueDifference: round2(snapshot.marketValue - positionMarketValue),
      reportedPnl: snapshot.reportedPnl,
      positionReportedPnl,
      pnlDifference: snapshot.reportedPnl === null ? null : round2(snapshot.reportedPnl - positionReportedPnl),
      status: Math.abs(snapshot.marketValue - positionMarketValue) <= 0.02 ? "matched" : "mismatch",
    };
  });

  const latestAccountSnapshots = [...accountSnapshots]
    .sort((a, b) => b.asOf.localeCompare(a.asOf))
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.accountId === row.accountId) === index);
  const portfolioMarketValue = round2(latestAccountSnapshots.reduce((sum, row) => sum + row.marketValue, 0));
  const portfolioTotalAssets = round2(latestAccountSnapshots.reduce((sum, row) => sum + row.totalAssets, 0));
  const portfolioCash = round2(latestAccountSnapshots.reduce((sum, row) => sum + row.cash, 0));
  const latestPositionSnapshots = positionSnapshots.filter((position) => latestAccountSnapshots.some((snapshot) => snapshot.accountId === position.accountId && snapshot.asOf === position.asOf));
  const largestPosition = latestPositionSnapshots.reduce((largest, row) => (row.marketValue ?? 0) > (largest?.marketValue ?? 0) ? row : largest, null);
  const exposureMap = new Map();
  for (const position of latestPositionSnapshots) {
    const instrument = instruments.find((row) => row.id === position.instrumentId);
    const exposure = instrument?.exposureTags?.[0] || "未分类";
    exposureMap.set(exposure, round2((exposureMap.get(exposure) ?? 0) + (position.marketValue ?? 0)));
  }
  const portfolio = {
    asOf: latestAccountSnapshots.map((row) => row.asOf).sort().at(-1) || "",
    totalAssets: portfolioTotalAssets,
    cash: portfolioCash,
    marketValue: portfolioMarketValue,
    investedRatio: portfolioTotalAssets > 0 ? round4(portfolioMarketValue / portfolioTotalAssets) : null,
    accountCount: latestAccountSnapshots.length,
    positionCount: latestPositionSnapshots.length,
    reconciledAccountCount: accountReconciliations.filter((row) => row.status === "matched").length,
    largestPositionId: largestPosition?.instrumentId || "",
    largestPositionWeight: largestPosition && portfolioMarketValue > 0 ? round4((largestPosition.marketValue ?? 0) / portfolioMarketValue) : null,
    exposures: [...exposureMap.entries()].map(([name, value]) => ({ name, value, weight: portfolioMarketValue > 0 ? round4(value / portfolioMarketValue) : 0 })).sort((a, b) => b.value - a.value),
  };

  const performanceKeys = new Set([
    ...transactions.map((row) => `${row.accountId}::${row.instrumentId}`),
    ...latestPositionSnapshots.map((row) => `${row.accountId}::${row.instrumentId}`),
  ]);
  const instrumentPerformance = [...performanceKeys].map((key) => {
    const [accountId, instrumentId] = key.split("::");
    const rows = transactions.filter((row) => row.accountId === accountId && row.instrumentId === instrumentId);
    const position = latestPositionSnapshots.find((row) => row.accountId === accountId && row.instrumentId === instrumentId) || null;
    const reconciliation = reconciliations.find((row) => row.accountId === accountId && row.instrumentId === instrumentId && row.asOf === position?.asOf) || null;
    const buys = rows.filter((row) => row.side === "buy");
    const sells = rows.filter((row) => row.side === "sell");
    // 期末持仓市值统一是 CNY；海外扩展成交须使用同量纲的绩效成交额。
    const performanceGross = (row) => row.performanceGrossAmountCny ?? (row.currency === parsed.baseCurrency ? row.grossAmount : null);
    const performanceGrossAvailable = rows.every((row) => performanceGross(row) !== null);
    const buyGross = round2(buys.reduce((sum, row) => sum + (performanceGross(row) ?? 0), 0));
    const sellGross = round2(sells.reduce((sum, row) => sum + (performanceGross(row) ?? 0), 0));
    const buyQuantity = buys.reduce((sum, row) => sum + row.quantity, 0);
    const sellQuantity = sells.reduce((sum, row) => sum + row.quantity, 0);
    const quantityMatched = position
      ? reconciliation?.status === "matched"
      : Math.abs(buyQuantity - sellQuantity) < 0.000001;
    const from = rows[0]?.tradedAt.slice(0, 10) || "";
    const to = position?.asOf || rows.at(-1)?.tradedAt.slice(0, 10) || "";
    const directRateAvailable = position?.reportedPnlRate !== null && position?.reportedPnlRate !== undefined;
    const calculatedAvailable = !directRateAvailable && performanceGrossAvailable && quantityMatched && buyGross > 0;
    const investedAmount = directRateAvailable
      ? round2((position?.marketValue ?? 0) - (position?.reportedPnl ?? 0))
      : calculatedAvailable ? buyGross : null;
    const endingValue = directRateAvailable
      ? position?.marketValue ?? null
      : calculatedAvailable ? round2(sellGross + (position?.marketValue ?? 0)) : null;
    const profit = directRateAvailable
      ? position?.reportedPnl ?? null
      : calculatedAvailable ? round2((endingValue ?? 0) - buyGross) : position?.reportedPnl ?? null;
    const returnRate = directRateAvailable
      ? position?.reportedPnlRate ?? null
      : calculatedAvailable && buyGross > 0 ? round4((profit ?? 0) / buyGross) : null;
    return {
      id: `${key}::observed`,
      accountId,
      instrumentId,
      from,
      to,
      transactionCount: rows.length,
      currentPosition: Boolean(position && position.quantity > 0),
      quantityMatched,
      status: returnRate === null ? "unavailable" : "available",
      basis: directRateAvailable ? "platform-holding" : calculatedAvailable ? "transaction-gross" : "platform-pnl-only",
      investedAmount,
      endingValue,
      profit,
      returnRate,
      currentMarketValue: position && position.quantity > 0 ? position.marketValue ?? 0 : 0,
      lastTradedAt: rows.at(-1)?.tradedAt || null,
      platformProfit: position?.reportedPnl ?? null,
      note: directRateAvailable
        ? position?.pnlBasis || "平台持有收益率"
        : calculatedAvailable
          ? "完整成交链的卖出回款加期末市值，未计齐手续费与税费"
          : position?.note || "缺期初仓或完整成交，暂不计算收益率",
    };
  });
  for (const record of historicalInvestments) {
    instrumentPerformance.push({
      id: `${record.id}::historical`,
      accountId: record.accountId,
      instrumentId: record.instrumentId,
      from: record.from,
      to: record.to,
      transactionCount: 0,
      currentPosition: false,
      quantityMatched: true,
      status: record.returnRate === null ? "unavailable" : "available",
      basis: "platform-closed-record",
      investedAmount: record.investedAmount,
      endingValue: record.endingValue,
      profit: record.profit,
      returnRate: record.returnRate,
      currentMarketValue: 0,
      lastTradedAt: null,
      platformProfit: record.profit,
      note: record.note || "平台已清仓历史记录",
    });
  }
  instrumentPerformance.sort((a, b) => (b.to || "").localeCompare(a.to || "") || (b.returnRate ?? -Infinity) - (a.returnRate ?? -Infinity));

  const accountReturnSnapshots = latestAccountSnapshots.map((snapshot) => {
    const account = accounts.find((row) => row.id === snapshot.accountId);
    if (account?.accountClass === "fund-platform" && snapshot.holdingPnl !== null) {
      const holdingCost = snapshot.marketValue - snapshot.holdingPnl;
      return {
        accountId: snapshot.accountId,
        asOf: snapshot.asOf,
        rate: holdingCost > 0 ? round4(snapshot.holdingPnl / holdingCost) : null,
        basis: "current-holdings",
        note: "按当前持有收益 ÷ 当前持有成本计算",
      };
    }
    if (snapshot.reportedPnlRate !== null) {
      return {
        accountId: snapshot.accountId,
        asOf: snapshot.asOf,
        rate: snapshot.reportedPnlRate,
        basis: "platform-all-period",
        note: "平台全部周期收益率，包含已清仓归档收益；不是 XIRR／TWR",
      };
    }
    const inferredCapital = snapshot.reportedPnl === null ? null : snapshot.totalAssets - snapshot.reportedPnl;
    return {
      accountId: snapshot.accountId,
      asOf: snapshot.asOf,
      rate: inferredCapital && inferredCapital > 0 ? round4((snapshot.reportedPnl ?? 0) / inferredCapital) : null,
      basis: "platform-inferred",
      note: "按平台总盈亏 ÷（当前总资产－平台总盈亏）反推；不是 XIRR／TWR",
    };
  });

  const coverageStatus = parsed.coverage?.status === "complete" ? "complete" : "partial";
  const holdingsStatus = text(parsed.coverage?.holdingsStatus, "partial", 40);
  const transactionsStatus = text(parsed.coverage?.transactionsStatus, "partial", 40);
  const cashFlowsStatus = text(parsed.coverage?.cashFlowsStatus, "missing", 40);
  const futureCapture = (Array.isArray(parsed.coverage?.futureCapture) ? parsed.coverage.futureCapture : [])
    .slice(0, 20)
    .map((item) => text(item, "", 140))
    .filter(Boolean);
  const cashFlows = Array.isArray(parsed.cashFlows) ? parsed.cashFlows : [];
  const cashFlowSummaries = (Array.isArray(parsed.cashFlowSummaries) ? parsed.cashFlowSummaries : []).map((row) => ({
    id: text(row?.id, "", 120),
    accountId: text(row?.accountId, "", 100),
    range: text(row?.range, "all", 24),
    asOf: text(row?.asOf, "", 16),
    initialAssets: nullableNumber(row?.initialAssets),
    transferIn: nullableNumber(row?.transferIn),
    transferOut: nullableNumber(row?.transferOut),
    netInflow: nullableNumber(row?.netInflow),
    reportedPnl: nullableNumber(row?.reportedPnl),
    endingAssets: nullableNumber(row?.endingAssets),
    reconciliationDifference: nullableNumber(row?.reconciliationDifference),
    sourceQuality: text(row?.sourceQuality, "aggregate", 60),
    note: text(row?.note, "", 320),
  }));
  uniqueById(cashFlowSummaries, "投资账户资金桥");
  for (const row of cashFlowSummaries) {
    if (!accountIds.has(row.accountId)) throw new WorkbenchWriteError("资金桥引用了不存在的账户", 500, "INVESTMENT_LEDGER_INVALID");
  }
  const returnReasons = [];
  if (!new Set(["complete", "screenshot-complete"]).has(transactionsStatus)) returnReasons.push("成交覆盖不是完整账户历史");
  if (!summary.feesKnown) returnReasons.push("手续费未齐");
  if (!summary.taxesKnown) returnReasons.push("税费未齐");
  if (!cashFlows.length || cashFlowsStatus !== "complete") {
    returnReasons.push(cashFlowSummaries.length ? "银证转账只有累计总额，缺逐笔日期" : "入金、出金与转仓未接入");
  }
  if (reconciliations.some((row) => row.status !== "matched")) returnReasons.push("期初仓或遗漏成交尚未对平");

  const marketSources = (Array.isArray(parsed.marketEvidence?.sources) ? parsed.marketEvidence.sources : []).map((row) => ({
    id: text(row?.id, "", 120),
    label: text(row?.label, "未命名来源", 120),
    kind: text(row?.kind, "unknown", 60),
    url: safeHttpsUrl(row?.url),
    retrievedAt: text(row?.retrievedAt, "", 16),
  }));
  const marketSourceIds = uniqueById(marketSources, "投资行情来源");
  const marketEvidence = {
    asOf: text(parsed.marketEvidence?.asOf, "", 16),
    sources: marketSources,
    series: parseMarketSeries(parsed.marketEvidence?.series, marketSourceIds),
  };
  const analysis = buildInvestmentAnalysis({ parsed, accounts, instruments, transactions, marketEvidence });

  return {
    schemaVersion: Number(parsed.schemaVersion) || 1,
    baseCurrency: text(parsed.baseCurrency, "CNY", 8),
    source: {
      title: text(parsed.source?.title, "投资账本", 100),
      asOf: text(parsed.source?.asOf, "", 16),
      path: INVESTMENT_LEDGER_SOURCE,
    },
    coverage: {
      status: coverageStatus,
      holdingsStatus,
      transactionsStatus,
      cashFlowsStatus,
      from: text(parsed.coverage?.from, "", 16),
      to: text(parsed.coverage?.to, "", 16),
      note: text(parsed.coverage?.note, "", 240),
      missing: (Array.isArray(parsed.coverage?.missing) ? parsed.coverage.missing : []).slice(0, 30).map((item) => text(item, "", 120)).filter(Boolean),
      futureCapture,
    },
    accounts,
    instruments,
    accountSnapshots,
    cashFlowSummaries,
    transactions,
    positionSnapshots,
    historicalInvestments,
    summary,
    reconciliations,
    accountReconciliations,
    portfolio,
    performance: {
      from: [
        ...instrumentPerformance.map((row) => row.from),
        ...historicalInvestments.map((row) => row.from),
      ].filter(Boolean).sort()[0] || "",
      to: portfolio.asOf,
      availableCount: instrumentPerformance.filter((row) => row.status === "available").length,
      rows: instrumentPerformance,
      accountReturns: accountReturnSnapshots,
    },
    returns: {
      available: returnReasons.length === 0,
      reasons: returnReasons,
    },
    marketEvidence,
    analysis,
    warnings,
    available: accounts.length > 0 && instruments.length > 0 && transactions.length > 0,
    message: transactions.length ? "" : "投资账本还没有成交。",
  };
}

export async function readInvestmentLedger(root, options = {}) {
  const [markdown, custody, tradeMemo] = await Promise.all([
    fsp.readFile(ensureInside(root, INVESTMENT_LEDGER_SOURCE), "utf8"),
    readSunxiangCustody(root),
    fsp.readFile(ensureInside(root, PERSONAL_TRADE_MEMO), "utf8").catch(() => ""),
  ]);
  const confirmedTrades = parseConfirmedTradeMemoMarkdown(tradeMemo);
  const extension = buildSunxiangInvestmentExtension(custody, confirmedTrades, options);
  return parseInvestmentLedgerMarkdown(markdown, extension);
}

/**
 * 只读取本人投资账本原件，不合并代持扩展。
 * 首页持仓观察页只需要本人券商的最新标的集合，避免把无关账户带入派生接口。
 */
export async function readBaseInvestmentLedger(root) {
  const markdown = await fsp.readFile(ensureInside(root, INVESTMENT_LEDGER_SOURCE), "utf8");
  return parseInvestmentLedgerMarkdown(markdown);
}

const investmentSeriesCache = new Map();
const INVESTMENT_SERIES_CACHE_MS = 30 * 60_000;

function compactDate(value) {
  return String(value || "").replaceAll("-", "").slice(0, 8);
}

async function fetchSohuDailySeries(symbol, from, to) {
  const key = `sohu:${symbol}:${from}:${to}`;
  const cached = investmentSeriesCache.get(key);
  if (cached && Date.now() - cached.at < INVESTMENT_SERIES_CACHE_MS) return cached.points;
  const url = new URL("https://q.stock.sohu.com/hisHq");
  url.searchParams.set("code", `cn_${symbol}`);
  url.searchParams.set("start", compactDate(from));
  url.searchParams.set("end", compactDate(to));
  url.searchParams.set("stat", "1");
  url.searchParams.set("order", "D");
  url.searchParams.set("period", "d");
  url.searchParams.set("rt", "json");
  let response = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 InfansWorkbench/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok || ![429, 502, 503, 504].includes(response.status) || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }
  if (!response?.ok) throw new Error(`公开行情源响应 ${response?.status || "失败"}`);
  const payload = await response.json();
  const hq = Array.isArray(payload?.[0]?.hq) ? payload[0].hq : [];
  const points = hq.flatMap((row) => {
    const date = text(row?.[0], "", 16);
    const close = finiteNumber(row?.[2], Number.NaN);
    return /^\d{4}-\d{2}-\d{2}$/u.test(date) && Number.isFinite(close) && close > 0 ? [{ date, close }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) throw new Error("这只证券暂时读不到历史日线");
  investmentSeriesCache.set(key, { at: Date.now(), points });
  return points;
}

function unixSeconds(value) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

async function fetchYahooDailySeries(symbol, from, to) {
  const key = `yahoo:${symbol}:${from}:${to}`;
  const cached = investmentSeriesCache.get(key);
  if (cached && Date.now() - cached.at < INVESTMENT_SERIES_CACHE_MS) return cached.points;
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("period1", String(unixSeconds(from)));
  url.searchParams.set("period2", String(unixSeconds(to) + 86_400));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");
  let response = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 InfansWorkbench/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok || ![429, 502, 503, 504].includes(response.status) || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }
  if (!response?.ok) throw new Error(`公开跨市场行情源响应 ${response?.status || "失败"}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result?.indicators?.quote?.[0]?.close) ? result.indicators.quote[0].close : [];
  const points = timestamps.flatMap((timestamp, index) => {
    const close = finiteNumber(closes[index], Number.NaN);
    const date = new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
    return Number.isFinite(close) && close > 0 ? [{ date, close: round4(close) }] : [];
  }).filter((row) => row.date >= from && row.date <= to);
  if (!points.length) throw new Error("这只证券暂时读不到跨市场历史日线");
  investmentSeriesCache.set(key, { at: Date.now(), points });
  return points;
}

function subtractOneYear(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return value;
  return `${String(Number(match[1]) - 1).padStart(4, "0")}-${match[2]}-${match[3]}`;
}

function marketSeriesConfig(instrument) {
  if (/^CN\.(SH|SZ)\./u.test(instrument.id)) {
    return { sourceLabel: "搜狐证券日线 · 仅价格走势", priceCurrency: instrument.listingCurrency || "CNY", fetch: fetchSohuDailySeries };
  }
  if (/^US\.(NASDAQ|NYSE|NYSEARCA)\./u.test(instrument.id)) {
    return { yahooSymbol: instrument.symbol, sourceLabel: "Yahoo Finance 日线 · 仅价格走势", priceCurrency: instrument.listingCurrency || "USD", fetch: fetchYahooDailySeries };
  }
  if (/^HK\./u.test(instrument.id) || instrument.exchange === "HKEX") {
    const numeric = String(instrument.symbol || "").replace(/\D/gu, "");
    if (!numeric) return null;
    return { yahooSymbol: `${numeric.padStart(4, "0")}.HK`, sourceLabel: "Yahoo Finance 港股日线 · 仅价格走势", priceCurrency: instrument.listingCurrency || "HKD", fetch: fetchYahooDailySeries };
  }
  if (instrument.id === "JP.CUSTODY.NIKKEI") {
    return {
      yahooSymbol: "^N225",
      sourceLabel: "Yahoo Finance 日经225指数日线 · 仅市场参考",
      priceCurrency: "JPY",
      note: "现有资料只有日经组合成本与现值，没有产品代码、份额和申赎日期；这里显示日经225指数参考，不代表该代持组合收益。",
      fetch: fetchYahooDailySeries,
    };
  }
  return null;
}

export function buildMarketOnlySeries(prices, currentQuantity = 0) {
  const firstClose = prices[0]?.close || 0;
  return prices.map((point) => ({
    date: point.date,
    strategy: null,
    market: firstClose > 0 ? round2((point.close / firstClose) * 100) : null,
    profit: 0,
    value: 0,
    passiveValue: null,
    passiveStrategy: null,
    contributed: 0,
    price: point.close,
    quantity: round4(currentQuantity),
    externalFlow: 0,
    passiveUnitsPurchased: 0,
  }));
}

export function buildFullCycleSeries(transactions, prices) {
  const tradesByDate = new Map();
  for (const trade of transactions) {
    const date = trade.tradedAt.slice(0, 10);
    if (!tradesByDate.has(date)) tradesByDate.set(date, []);
    tradesByDate.get(date).push(trade);
  }
  let quantity = 0;
  let cash = 0;
  let strategyUnits = 0;
  let contributed = 0;
  let passiveUnits = 0;
  let passiveStrategyUnits = 0;
  const firstClose = prices[0]?.close || 0;
  const rows = [];
  for (const point of prices) {
    const beforeFlowValue = cash + quantity * point.close;
    const navBeforeFlow = strategyUnits > 0 && beforeFlowValue > 0 ? beforeFlowValue / strategyUnits : 100;
    const passiveBeforeFlowValue = passiveUnits * point.close;
    const passiveNavBeforeFlow = passiveStrategyUnits > 0 && passiveBeforeFlowValue > 0
      ? passiveBeforeFlowValue / passiveStrategyUnits
      : 100;
    let externalFlow = 0;
    let passiveUnitsPurchased = 0;
    for (const trade of tradesByDate.get(point.date) || []) {
      const fees = (trade.fees || 0) + (trade.taxes || 0);
      if (trade.side === "buy") {
        const cost = trade.grossAmount + fees;
        const needed = Math.max(0, cost - cash);
        if (needed > 0) {
          strategyUnits += needed / navBeforeFlow;
          contributed += needed;
          cash += needed;
          externalFlow += needed;
          const comparisonPrice = trade.price > 0
            ? trade.price
            : trade.quantity > 0 && trade.grossAmount > 0
              ? trade.grossAmount / trade.quantity
              : point.close;
          if (comparisonPrice > 0) passiveUnitsPurchased += needed / comparisonPrice;
          passiveStrategyUnits += needed / passiveNavBeforeFlow;
        }
        cash -= cost;
        quantity += trade.quantity;
      } else {
        cash += Math.max(0, trade.grossAmount - fees);
        quantity -= trade.quantity;
      }
    }
    passiveUnits += passiveUnitsPurchased;
    const value = cash + quantity * point.close;
    const passiveValue = passiveUnits * point.close;
    rows.push({
      date: point.date,
      strategy: strategyUnits > 0 ? round2(value / strategyUnits) : null,
      market: firstClose > 0 ? round2((point.close / firstClose) * 100) : null,
      profit: round2(value - contributed),
      value: round2(value),
      passiveValue: round2(passiveValue),
      passiveStrategy: passiveStrategyUnits > 0 ? round2(passiveValue / passiveStrategyUnits) : null,
      contributed: round2(contributed),
      price: point.close,
      quantity: round4(quantity),
      externalFlow: round2(externalFlow),
      passiveUnitsPurchased,
    });
  }
  return rows;
}

export function calculateInvestmentPeriodMetrics(rows, from = "", to = "") {
  const ordered = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!ordered.length) return null;
  const firstIncludedIndex = ordered.findIndex((row) => !from || row.date >= from);
  if (firstIncludedIndex < 0) return null;
  const included = ordered.slice(firstIncludedIndex).filter((row) => !to || row.date <= to);
  if (!included.length) return null;
  const baseline = firstIncludedIndex > 0 ? ordered[firstIncludedIndex - 1] : null;
  const first = included[0];
  const last = included.at(-1);
  const comparison = calculateInvestmentPeriodComparison(included, baseline);
  const periodLast = comparison.at(-1);
  const returnRate = periodLast?.strategyReturn ?? null;
  const marketReturn = periodLast?.marketReturn ?? null;
  return {
    from: first.date,
    to: last.date,
    profit: periodLast?.profitView ?? null,
    returnRate: returnRate === null ? null : round4(returnRate),
    marketReturn: marketReturn === null ? null : round4(marketReturn),
    operationDifference: periodLast?.operationDifference === null || periodLast?.operationDifference === undefined ? null : round4(periodLast.operationDifference),
    operationProfit: periodLast?.operationProfitView ?? null,
    passiveValue: last.passiveValue ?? null,
    endingValue: last.value,
    capitalBase: periodLast?.capitalBase ?? null,
  };
}

export function resolveInvestmentSeriesEnd(transactions, currentQuantity, portfolioAsOf) {
  const lastTradeDate = transactions.at(-1)?.tradedAt.slice(0, 10) || portfolioAsOf;
  return currentQuantity > 0.000001 ? portfolioAsOf : lastTradeDate;
}

export async function readInvestmentInstrumentSeries(root, instrumentId) {
  const ledger = await readInvestmentLedger(root);
  const instrument = ledger.instruments.find((row) => row.id === instrumentId);
  if (!instrument) throw new WorkbenchWriteError("找不到这只投资标的", 404, "INVESTMENT_INSTRUMENT_NOT_FOUND");
  const transactions = ledger.transactions.filter((row) => row.instrumentId === instrumentId).toSorted((a, b) => a.tradedAt.localeCompare(b.tradedAt));
  const reconciliation = ledger.reconciliations.find((row) => row.instrumentId === instrumentId);
  const latestPositions = ledger.positionSnapshots
    .filter((row) => row.instrumentId === instrumentId)
    .toSorted((a, b) => b.asOf.localeCompare(a.asOf));
  const latestAsOf = latestPositions[0]?.asOf || "";
  const currentQuantity = latestPositions
    .filter((row) => row.asOf === latestAsOf)
    .reduce((sum, row) => sum + row.quantity, 0);
  const transactionQuantity = transactions.reduce((sum, row) => sum + (row.side === "buy" ? row.quantity : -row.quantity), 0);
  const quantityMatched = Math.abs(transactionQuantity - currentQuantity) <= 0.000001;
  const reconciliationMatched = !reconciliation || reconciliation.status === "matched";
  const completeOperationSeries = /^CN\.(SH|SZ)\./u.test(instrumentId)
    && transactions.length > 0
    && reconciliationMatched
    && quantityMatched;
  const actions = transactions.map((row) => ({ id: row.id, date: row.tradedAt.slice(0, 10), side: row.side, quantity: row.quantity, price: row.price }));
  if (completeOperationSeries) {
    const from = transactions[0].tradedAt.slice(0, 10);
    const to = resolveInvestmentSeriesEnd(transactions, currentQuantity, ledger.portfolio.asOf);
    try {
      const prices = await fetchSohuDailySeries(instrument.symbol, from, to);
      const rows = buildFullCycleSeries(transactions, prices.filter((row) => row.date >= from && row.date <= to));
      return {
        available: rows.length > 0,
        mode: "operation",
        instrumentId,
        symbol: instrument.symbol,
        name: instrument.name,
        from: rows[0]?.date || from,
        to: rows.at(-1)?.date || to,
        sourceLabel: "搜狐证券日线",
        priceCurrency: instrument.listingCurrency || "CNY",
        rows,
        actions,
        message: rows.length ? "" : "没有足够的历史行情。",
      };
    } catch (error) {
      return { available: false, instrumentId, message: error instanceof Error ? error.message : "历史行情暂时不可用。" };
    }
  }

  const config = marketSeriesConfig(instrument);
  if (!config) {
    const message = instrument.id === "JP.CUSTODY.NISA"
      ? "NISA 是缺产品代码的组合汇总，无法选择不误导的单一市场曲线。"
      : "这只资产缺少可识别的公开行情代码，暂时不画走势。";
    return { available: false, instrumentId, message };
  }
  const lastActionDate = transactions.at(-1)?.tradedAt.slice(0, 10) || "";
  const to = currentQuantity > 0.000001 ? ledger.portfolio.asOf : lastActionDate || ledger.portfolio.asOf;
  const firstActionDate = transactions[0]?.tradedAt.slice(0, 10) || "";
  const from = subtractOneYear(firstActionDate || to);
  const incompleteNote = !transactions.length
    ? "现有资料没有买卖日期，只显示公开价格走势；这不是本人收益率。"
    : !quantityMatched || !reconciliationMatched
      ? "现有成交与当前数量之间仍有期初仓或遗漏流水，只显示公开价格走势和已确认买卖点；这不是本人收益率。"
      : "当前只有可确认的成交点，先显示公开价格走势；这不是本人收益率。";
  try {
    const quoteSymbol = config.yahooSymbol || instrument.symbol;
    const prices = await config.fetch(quoteSymbol, from, to);
    const rows = buildMarketOnlySeries(prices.filter((row) => row.date >= from && row.date <= to), currentQuantity);
    return {
      available: rows.length > 0,
      mode: "market-only",
      instrumentId,
      symbol: instrument.symbol,
      name: instrument.name,
      from: rows[0]?.date || from,
      to: rows.at(-1)?.date || to,
      sourceLabel: config.sourceLabel,
      priceCurrency: config.priceCurrency,
      note: [incompleteNote, config.note].filter(Boolean).join(" "),
      rows,
      actions,
      message: rows.length ? "" : "没有足够的历史行情。",
    };
  } catch (error) {
    return { available: false, instrumentId, message: error instanceof Error ? error.message : "历史行情暂时不可用。" };
  }
}

async function mapWithConcurrency(rows, limit, mapper) {
  const output = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(rows[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, () => worker()));
  return output;
}

export async function readInvestmentPeriodPerformance(root, { from = "", to = "" } = {}) {
  const ledger = await readInvestmentLedger(root);
  const safeFrom = /^\d{4}-\d{2}-\d{2}$/u.test(String(from)) ? String(from) : "";
  const safeTo = /^\d{4}-\d{2}-\d{2}$/u.test(String(to)) ? String(to) : ledger.performance.to;
  const transactionRows = ledger.performance.rows.filter((row) => row.transactionCount > 0);
  const calculatedRows = await mapWithConcurrency(transactionRows, 2, async (performance) => {
    const instrument = ledger.instruments.find((row) => row.id === performance.instrumentId);
    const transactions = ledger.transactions
      .filter((row) => row.accountId === performance.accountId && row.instrumentId === performance.instrumentId)
      .toSorted((a, b) => a.tradedAt.localeCompare(b.tradedAt));
    const reconciliation = ledger.reconciliations.find((row) => row.accountId === performance.accountId && row.instrumentId === performance.instrumentId);
    const base = {
      id: `${performance.id}::period`,
      accountId: performance.accountId,
      instrumentId: performance.instrumentId,
      currentPosition: performance.currentPosition,
      currentMarketValue: performance.currentMarketValue,
      lastTradedAt: performance.lastTradedAt,
      transactionCount: performance.transactionCount,
    };
    if (!instrument || !/^CN\.(SH|SZ)\./u.test(instrument.id) || !transactions.length) {
      return { ...base, from: performance.from, to: performance.to, status: "unavailable", basis: "period-unavailable", profit: null, returnRate: null, marketReturn: null, operationDifference: null, operationProfit: null, passiveValue: null, endingValue: null, note: "缺少可复算的成交链或场内日线。" };
    }
    const firstTrade = transactions[0].tradedAt.slice(0, 10);
    const seriesEnd = resolveInvestmentSeriesEnd(transactions, performance.currentPosition ? 1 : 0, ledger.portfolio.asOf);
    if ((safeFrom && seriesEnd < safeFrom) || (safeTo && firstTrade > safeTo)) {
      return { ...base, from: firstTrade, to: seriesEnd, status: "outside", basis: "period-strategy", profit: null, returnRate: null, marketReturn: null, operationDifference: null, operationProfit: null, passiveValue: null, endingValue: null, note: "所选区间没有持有或成交。" };
    }
    if (!performance.quantityMatched || (reconciliation && reconciliation.status !== "matched")) {
      return { ...base, from: firstTrade, to: seriesEnd, status: "unavailable", basis: "period-unavailable", profit: null, returnRate: null, marketReturn: null, operationDifference: null, operationProfit: null, passiveValue: null, endingValue: null, note: "这段成交存在期初仓或遗漏流水，暂不计算可能误导的区间收益。" };
    }
    try {
      const prices = await fetchSohuDailySeries(instrument.symbol, firstTrade, seriesEnd);
      const series = buildFullCycleSeries(transactions, prices.filter((row) => row.date >= firstTrade && row.date <= seriesEnd));
      const metrics = calculateInvestmentPeriodMetrics(series, safeFrom, safeTo);
      if (!metrics) return { ...base, from: firstTrade, to: seriesEnd, status: "outside", basis: "period-strategy", profit: null, returnRate: null, marketReturn: null, operationDifference: null, operationProfit: null, passiveValue: null, endingValue: null, note: "所选区间没有可用行情。" };
      return { ...base, ...metrics, status: "available", basis: "period-strategy", note: "完整成交链与公开日线构造的区间毛收益；操作差额以同日投入、买入后持有至期末为参照，未计齐手续费、税费与分红。" };
    } catch (error) {
      return { ...base, from: firstTrade, to: seriesEnd, status: "unavailable", basis: "period-unavailable", profit: null, returnRate: null, marketReturn: null, operationDifference: null, operationProfit: null, passiveValue: null, endingValue: null, note: error instanceof Error ? error.message : "区间行情暂时不可用。" };
    }
  });

  const fallbackRows = ledger.performance.rows
    .filter((row) => row.transactionCount === 0)
    .flatMap((row) => {
      const overlaps = (!safeFrom || row.to >= safeFrom) && (!safeTo || row.from <= safeTo);
      if (!overlaps) return [];
      const allPeriod = !safeFrom && safeTo === ledger.performance.to;
      return [{
        id: `${row.id}::period`,
        accountId: row.accountId,
        instrumentId: row.instrumentId,
        from: row.from,
        to: row.to,
        currentPosition: row.currentPosition,
        currentMarketValue: row.currentMarketValue,
        lastTradedAt: row.lastTradedAt,
        transactionCount: row.transactionCount,
        status: allPeriod && row.returnRate !== null ? "available" : "unavailable",
        basis: allPeriod ? row.basis : "period-unavailable",
        profit: allPeriod ? row.profit : null,
        returnRate: allPeriod ? row.returnRate : null,
        marketReturn: null,
        operationDifference: null,
        operationProfit: null,
        passiveValue: null,
        endingValue: allPeriod ? row.endingValue : null,
        note: allPeriod ? row.note : "缺少申购、赎回或完整历史流水，不能把平台全周期收益复用到所选区间。",
      }];
    });
  const rows = [...calculatedRows.filter((row) => row.status !== "outside"), ...fallbackRows];
  const available = rows.filter((row) => row.status === "available" && row.profit !== null);
  const totalProfit = round2(available.reduce((sum, row) => sum + (row.profit ?? 0), 0));
  return {
    available: rows.length > 0,
    from: safeFrom || ledger.performance.from,
    to: safeTo,
    sourceLabel: "成交链与搜狐证券日线；场外基金仅保留平台口径",
    summary: {
      totalCount: rows.length,
      availableCount: available.length,
      positiveCount: available.filter((row) => (row.profit ?? 0) >= 0).length,
      negativeCount: available.filter((row) => (row.profit ?? 0) < 0).length,
      totalProfit,
    },
    rows: rows.map((row) => ({
      ...row,
      contributionRate: row.profit !== null && Math.abs(totalProfit) > 0.005 ? round4(row.profit / totalProfit) : null,
    })),
    message: rows.length ? "" : "所选区间没有投资记录。",
  };
}
