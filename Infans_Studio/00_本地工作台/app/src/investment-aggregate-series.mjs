function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function rowContributed(row) {
  const explicit = Number(row?.contributed);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return Math.max(0, (Number(row?.value) || 0) - (Number(row?.profit) || 0));
}

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 比较实际操作与“同日同额买入并持有”。
 * 收益率使用已按外部资金流份额化的净值序列，避免大额加仓把曲线机械压回 100。
 * 盈亏金额仍按期初差额计算；这不是缺账户出入金时无法还原的账户级 TWR/XIRR。
 * @param {Array<Record<string, any>>} rows
 * @param {Record<string, any> | null} [baseline=null]
 * @returns {Array<Record<string, any>>}
 */
export function calculateInvestmentPeriodComparison(rows, baseline = null) {
  const baselineProfit = Number(baseline?.profit) || 0;
  const baselineContributed = rowContributed(baseline);
  const openingValue = baseline ? baselineContributed + baselineProfit : 0;
  const baselinePassiveValue = Number(baseline?.passiveValue);
  const baselinePassiveProfit = Number.isFinite(baselinePassiveValue)
    ? baselinePassiveValue - baselineContributed
    : 0;
  const baselineStrategyIndex = finitePositive(baseline?.strategy) || 100;
  const baselinePassiveIndex = finitePositive(baseline?.passiveStrategy) || finitePositive(baseline?.market) || 100;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const contributed = rowContributed(row);
    const addedCapital = Math.max(0, contributed - baselineContributed);
    const capitalBase = openingValue + addedCapital;
    const profitView = round2((Number(row?.profit) || 0) - baselineProfit);
    const passiveValue = Number(row?.passiveValue);
    const passiveProfitView = Number.isFinite(passiveValue)
      ? round2((passiveValue - contributed) - baselinePassiveProfit)
      : null;
    const strategyIndex = finitePositive(row?.strategy);
    const passiveIndex = finitePositive(row?.passiveStrategy) || finitePositive(row?.market);
    const strategyReturn = strategyIndex !== null
      ? strategyIndex / baselineStrategyIndex - 1
      : capitalBase > 0 ? profitView / capitalBase : null;
    const marketReturn = passiveIndex !== null
      ? passiveIndex / baselinePassiveIndex - 1
      : capitalBase > 0 && passiveProfitView !== null ? passiveProfitView / capitalBase : null;
    const operationProfitView = passiveProfitView === null ? null : round2(profitView - passiveProfitView);
    const operationDifference = strategyReturn !== null && marketReturn !== null ? strategyReturn - marketReturn : null;
    return {
      ...row,
      capitalBase: round2(capitalBase),
      strategyReturn,
      marketReturn,
      operationDifference,
      strategyView: strategyReturn === null ? null : round2((1 + strategyReturn) * 100),
      marketView: marketReturn === null ? null : round2((1 + marketReturn) * 100),
      profitView,
      passiveProfitView,
      operationProfitView,
      valueView: row.value,
    };
  });
}
