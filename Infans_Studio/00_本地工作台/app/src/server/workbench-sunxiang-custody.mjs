import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureInside } from "./workbench-data.mjs";
import { SUNXIANG_HOLDINGS_DIR, SUNXIANG_HOLDINGS_FILE } from "./vault-paths.mjs";
import { OPENPYXL_BOOTSTRAP, runPythonScript } from "./workbench-python.mjs";
import { formatFileCreatedAt } from "./workbench-wechat-bills.mjs";

/** @type {{ key: string, data: object } | null} */
let cache = null;

const DOWNLOAD_NAME = /^代持账户表(?: \(\d+\))?\.xlsx$/i;
const GOOGLE_SHEET_URL = "";

const PYTHON_PARSE = `
import json, sys
from pathlib import Path
${OPENPYXL_BOOTSTRAP}
from openpyxl import load_workbook
from openpyxl.utils.datetime import from_excel

path = Path(sys.argv[1])
wb = load_workbook(path, data_only=True)
ws = wb["工作表2"] if "工作表2" in wb.sheetnames else wb.active
ws1 = wb["工作表1"] if "工作表1" in wb.sheetnames else wb.active

def num(r, c):
    v = ws.cell(r, c).value
    try:
        return float(v)
    except Exception:
        return 0.0

def text(r, c):
    v = ws.cell(r, c).value
    return "" if v is None else str(v).strip()

def date_text(r, c):
    v = ws.cell(r, c).value
    if v is None:
        return ""
    try:
        return v.strftime("%Y-%m-%d")
    except Exception:
        pass
    try:
        return from_excel(float(v), wb.epoch).strftime("%Y-%m-%d")
    except Exception:
        return ""

def num1(r, c):
    v = ws1.cell(r, c).value
    try:
        return float(v)
    except Exception:
        return 0.0

def text1(r, c):
    v = ws1.cell(r, c).value
    return "" if v is None else str(v).strip()

us_jpy = num(32, 2)
funds_jpy = num(32, 3)
total_jpy = num(32, 4)
total_cny = num(32, 5)
us_cost = num(33, 2)
funds_cost = num(33, 3)
total_cost = num(33, 4)
total_cost_cny = num(33, 5)
us_yield = num(34, 2)
funds_yield = num(34, 3)
total_yield = num(34, 4)
cny_yield = num(34, 5)
receivable = num(26, 4) or num(37, 2)
loan_cash = num(26, 2)
loan_us_cost_cny = num(26, 3)

nvda_lots = []
for r in range(2, 11):
    name = text(r, 1)
    qty = num(r, 8)
    px = num(r, 7)
    after_tax = num(r, 9)
    cny = num(r, 11)
    cost_usd = num(r, 3)
    if qty and (name == "英伟达" or (not name and r == 3 and qty)):
        nvda_lots.append({
            "name": name or "英伟达",
            "boughtAt": date_text(r, 2),
            "qty": qty,
            "costUsd": cost_usd,
            "priceUsd": px,
            "afterTaxUsd": after_tax,
            "cnyValue": cny,
            "costJpy": num(r, 4),
        })

us_holdings = []
for r in range(5, 10):
    name = text1(r, 20)
    qty = num1(r, 21)
    market_usd = num1(r, 22)
    cost_price_usd = num1(r, 23)
    price_usd = num1(r, 24)
    if name:
        us_holdings.append({
            "name": name,
            "qty": qty,
            "marketUsd": market_usd,
            "costPriceUsd": cost_price_usd,
            "priceUsd": price_usd,
            "reportedPnlRate": num1(r, 25),
        })

nikkei = {
    "name": text(13, 1) or "日经",
    "costJpy": num(13, 2),
    "marketJpy": num(13, 3),
    "afterTaxJpy": num(13, 5),
    "cnyValue": num(13, 6),
} if text(13, 1) or num(13, 2) else None

nisa = {
    "name": text(22, 1) or "NISA综合",
    "costJpy": num(22, 2),
    "growth": num(22, 3),
    "marketJpy": num(22, 4),
    "cnyValue": num(22, 5),
} if text(22, 1) or num(22, 2) else None

funds_line = {
    "grossJpy": num(23, 9),
    "sunxiangHoldJpy": num(23, 10),
    "cnyValue": num(23, 11),
}

us_gain = us_jpy - us_cost
funds_gain = funds_jpy - funds_cost
total_gain = total_jpy - total_cost
cny_gain = total_cny - total_cost_cny

# Prefer stable historical rate for vault overlay CNY (Capoo 2026-08-06).
STABLE_JPY_TO_CNY = 0.047
rate = STABLE_JPY_TO_CNY
us_cny = round(us_jpy * rate, 2)
funds_cny = round(funds_jpy * rate, 2)
# Keep sheet's own CNY totals for income display
sheet_total_cny = total_cny
sheet_cost_cny = total_cost_cny
sheet_gain_cny = total_cny - total_cost_cny

out = {
    "usStocks": {"amountJpy": us_jpy, "costJpy": us_cost, "gainJpy": us_gain, "yield": us_yield, "cnyValue": us_cny},
    "funds": {"amountJpy": funds_jpy, "costJpy": funds_cost, "gainJpy": funds_gain, "yield": funds_yield, "cnyValue": funds_cny, "detail": funds_line},
    "total": {"amountJpy": total_jpy, "costJpy": total_cost, "gainJpy": total_gain, "yield": total_yield, "cnyValue": total_cny, "costCny": total_cost_cny, "gainCny": cny_gain, "cnyYield": cny_yield},
    "receivableCny": receivable,
    "loanBreakdown": {"cashCny": loan_cash, "usCostCny": loan_us_cost_cny, "remainingCny": receivable},
    "holdings": {
        "us": us_holdings,
        "nvdaLots": nvda_lots,
        "nikkei": nikkei,
        "nisa": nisa,
        "usdJpy": num1(4, 19),
        "accountCashJpy": num1(39, 3) + num1(39, 6) + num1(39, 9),
    },
    "impliedJpyToCny": rate,
}
print(json.dumps(out, ensure_ascii=False))
`;

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function isSunxiangHoldingsFileName(name) {
  return DOWNLOAD_NAME.test(String(name ?? ""));
}

export function defaultDownloadsDir() {
  return path.join(os.homedir(), "Downloads");
}

async function fileStamp(absolute) {
  const stat = await fsp.stat(absolute);
  return { ...formatFileCreatedAt(stat), mtimeMs: stat.mtimeMs, size: stat.size };
}

export async function listSunxiangDownloadCandidates(downloadsDir = defaultDownloadsDir()) {
  let entries = [];
  try {
    entries = await fsp.readdir(downloadsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSunxiangHoldingsFileName(entry.name)) continue;
    const absolute = path.join(downloadsDir, entry.name);
    try {
      const stamp = await fileStamp(absolute);
      found.push({ name: entry.name, absolute, location: "downloads", ...stamp });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return found.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0) || (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
}

async function resolveHoldingsFile(root, options = {}) {
  const downloadsDir = options.downloadsDir || defaultDownloadsDir();
  const download = (await listSunxiangDownloadCandidates(downloadsDir))[0] ?? null;
  const vaultAbsolute = ensureInside(root, SUNXIANG_HOLDINGS_FILE);
  let vault = null;
  try {
    const stamp = await fileStamp(vaultAbsolute);
    vault = {
      name: path.basename(SUNXIANG_HOLDINGS_FILE),
      absolute: vaultAbsolute,
      location: "vault",
      ...stamp,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (download && vault) {
    return (download.createdAtMs ?? 0) >= (vault.createdAtMs ?? 0) ? download : vault;
  }
  return download || vault;
}

async function parseHoldingsXlsx(absolute) {
  return runPythonScript(PYTHON_PARSE, [absolute], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
    task: "读委托代持表",
  });
}

function emptyCustody(message, source = null) {
  return {
    available: false,
    message,
    googleSheetUrl: GOOGLE_SHEET_URL,
    source,
    overlayItems: [],
  };
}

export function custodyOverlayItems(parsed, options = {}) {
  if (!parsed?.usStocks) return [];
  const rate = Number(options.jpyToCny) > 0 ? Number(options.jpyToCny) : Number(parsed.impliedJpyToCny) || 0.047;
  return [
    {
      category: "委托资产",
      name: "美股投资（由委托代持）",
      currency: "JPY",
      amount: round2(parsed.usStocks.amountJpy),
      rateToCny: rate,
      cnyValue: round2(parsed.usStocks.amountJpy * rate),
      note: "来自《代持账户表》现市值",
    },
    {
      category: "委托资产",
      name: "基金产品（由委托代持）",
      currency: "JPY",
      amount: round2(parsed.funds.amountJpy),
      rateToCny: rate,
      cnyValue: round2(parsed.funds.amountJpy * rate),
      note: "来自《代持账户表》现市值",
    },
    {
      category: "债权资产",
      name: "代持欠款（应收账款）",
      currency: "CNY",
      amount: round2(parsed.receivableCny),
      rateToCny: 1,
      cnyValue: round2(parsed.receivableCny),
      note: "表内「剩余欠款」",
    },
  ];
}

const CUSTODY_INSTRUMENTS = {
  "谷歌": { id: "US.NASDAQ.GOOGL", symbol: "GOOGL", name: "Alphabet A", exchange: "NASDAQ", exposureTags: ["美国股票", "互联网", "代持"] },
  "特斯拉": { id: "US.NASDAQ.TSLA", symbol: "TSLA", name: "Tesla", exchange: "NASDAQ", exposureTags: ["美国股票", "汽车", "代持"] },
  "英伟达": { id: "US.NASDAQ.NVDA", symbol: "NVDA", name: "NVIDIA", exchange: "NASDAQ", exposureTags: ["美国股票", "半导体", "代持"] },
  "AMAT": { id: "US.NASDAQ.AMAT", symbol: "AMAT", name: "Applied Materials", exchange: "NASDAQ", exposureTags: ["美国股票", "半导体设备", "代持"] },
  "SPACX": { id: "US.NYSEARCA.SPCX", symbol: "SPCX", name: "SPAC and New Issue ETF", exchange: "NYSEARCA", exposureTags: ["美国股票", "主题ETF", "代持"] },
};

function stableCny(valueJpy, rate) {
  return round2((Number(valueJpy) || 0) * (Number(rate) || 0));
}

export function parseConfirmedTradeMemoMarkdown(markdown) {
  const raw = String(markdown).match(
    /<!-- INFANS_CONFIRMED_TRADE_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- INFANS_CONFIRMED_TRADE_JSON_END -->/,
  )?.[1];
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed?.transactions) ? parsed.transactions : []).map((row) => ({
    id: String(row?.id || ""),
    accountId: String(row?.accountId || ""),
    instrumentId: String(row?.instrumentId || ""),
    tradedAt: String(row?.tradedAt || ""),
    side: row?.side === "sell" ? "sell" : "buy",
    quantity: Number(row?.quantity) || 0,
    price: Number(row?.price) || 0,
    currency: String(row?.currency || "USD"),
    grossAmount: round2((Number(row?.quantity) || 0) * (Number(row?.price) || 0)),
    fees: row?.fees === null ? null : Number(row?.fees) || 0,
    taxes: row?.taxes === null ? null : Number(row?.taxes) || 0,
    sourceRef: String(row?.sourceRef || "个人交易备忘"),
  })).filter((row) => row.id && row.accountId && row.instrumentId && row.quantity > 0 && row.price > 0);
}

export function buildSunxiangInvestmentExtension(custody, confirmedTrades = [], options = {}) {
  if (!custody?.available || !custody?.holdings) return null;
  const accountId = "jp-sbi-custody-sunxiang";
  const rate = Number(options.jpyToCny) > 0 ? Number(options.jpyToCny) : Number(custody.impliedJpyToCny) || 0.047;
  const usdJpy = Number(custody.holdings.usdJpy) || 0;
  const current = new Map();
  for (const row of custody.holdings.us || []) {
    const meta = CUSTODY_INSTRUMENTS[row.name];
    if (!meta) continue;
    current.set(meta.id, {
      ...meta,
      quantity: Number(row.qty) || 0,
      priceUsd: Number(row.priceUsd) || 0,
      costJpy: (Number(row.qty) || 0) * (Number(row.costPriceUsd) || 0) * usdJpy,
      costKnown: true,
    });
  }
  const nvda = current.get("US.NASDAQ.NVDA");
  if (nvda) {
    for (const lot of custody.holdings.nvdaLots || []) {
      nvda.quantity += Number(lot.qty) || 0;
      nvda.costJpy += Number(lot.costJpy) || 0;
    }
  }

  const knownLotTrades = (custody.holdings.nvdaLots || []).flatMap((lot, index) => {
    const date = String(lot.boughtAt || "");
    const quantity = Number(lot.qty) || 0;
    const price = Number(lot.costUsd) || 0;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !(quantity > 0) || !(price > 0)) return [];
    return [{
      id: `${accountId}-nvda-${date.replaceAll("-", "")}-lot-${index + 1}-buy`,
      accountId,
      instrumentId: "US.NASDAQ.NVDA",
      tradedAt: `${date}T00:00:00+09:00`,
      side: "buy",
      quantity,
      price,
      currency: "USD",
      grossAmount: round2(quantity * price),
      fees: null,
      taxes: null,
      sourceRef: "代持账户表.xlsx 工作表2 NVDA 批次",
    }];
  });
  const transactionGrossInCny = (trade) => {
    if (trade.currency === "CNY") return round2(trade.grossAmount);
    if (trade.currency === "JPY") return stableCny(trade.grossAmount, rate);
    if (trade.currency === "USD" && usdJpy > 0) return stableCny(trade.grossAmount * usdJpy, rate);
    return null;
  };
  const transactions = [...knownLotTrades, ...confirmedTrades]
    .map((trade) => ({ ...trade, performanceGrossAmountCny: transactionGrossInCny(trade) }))
    .toSorted((a, b) => a.tradedAt.localeCompare(b.tradedAt));

  let saleProceedsJpy = 0;
  for (const trade of confirmedTrades.filter((row) => row.accountId === accountId)) {
    const holding = current.get(trade.instrumentId);
    if (!holding) continue;
    holding.quantity += trade.side === "buy" ? trade.quantity : -trade.quantity;
    if (trade.side === "sell") {
      saleProceedsJpy += trade.grossAmount * usdJpy;
      if (holding.quantity > 0) holding.costKnown = false;
    } else {
      holding.costJpy += trade.grossAmount * usdJpy;
    }
    holding.quantity = Math.max(0, holding.quantity);
  }

  const asOf = confirmedTrades.map((row) => row.tradedAt.slice(0, 10)).sort().at(-1)
    || String(custody.source?.createdAt || "").slice(0, 10);
  const positionSnapshots = [];
  const instruments = [];
  let usMarketJpy = 0;
  for (const holding of current.values()) {
    instruments.push({
      id: holding.id,
      symbol: holding.symbol,
      name: holding.name,
      exchange: holding.exchange,
      assetClass: holding.symbol === "SPCX" ? "ETF" : "Stock",
      listingCurrency: "USD",
      exposureTags: holding.exposureTags,
      officialBenchmark: null,
    });
    if (!(holding.quantity > 0) || !(holding.priceUsd > 0)) continue;
    const marketJpy = holding.quantity * holding.priceUsd * usdJpy;
    const marketValue = stableCny(marketJpy, rate);
    const costValue = holding.costKnown ? stableCny(holding.costJpy, rate) : null;
    usMarketJpy += marketJpy;
    positionSnapshots.push({
      id: `${accountId}-${holding.symbol.toLowerCase()}-${asOf.replaceAll("-", "")}`,
      asOf,
      accountId,
      instrumentId: holding.id,
      quantity: round2(holding.quantity),
      quantityApproximate: false,
      alternateReportedQuantity: null,
      referencePrice: holding.priceUsd,
      costPrice: costValue === null ? null : round2(costValue / holding.quantity),
      marketValue,
      reportedPnl: costValue === null ? null : round2(marketValue - costValue),
      reportedPnlRate: costValue && costValue > 0 ? (marketValue - costValue) / costValue : null,
      pnlBasis: costValue === null ? "卖出指定批次后的剩余成本无法从现有表还原" : "代持表美元成本与快照现价，按稳定日元汇率折算",
      sourceQuality: costValue === null ? "partial-cost-basis" : "xlsx-snapshot",
      note: costValue === null ? "数量已按确认卖出修正；剩余批次成本待今后券商明细。" : "旧表快照；行情日期以导出文件为准。",
    });
  }

  const aggregatePortfolios = [
    { id: "JP.CUSTODY.NIKKEI", symbol: "NIKKEI-CUSTODY", name: "日经组合（代持汇总）", row: custody.holdings.nikkei, tags: ["日本股票", "日经", "代持"] },
    { id: "JP.CUSTODY.NISA", symbol: "NISA-CUSTODY", name: "NISA 综合（代持汇总）", row: custody.holdings.nisa, tags: ["日本股票", "NISA", "代持"] },
  ];
  let japanMarketJpy = 0;
  for (const item of aggregatePortfolios) {
    if (!item.row) continue;
    instruments.push({ id: item.id, symbol: item.symbol, name: item.name, exchange: "JP-AGGREGATE", assetClass: "AggregatePortfolio", listingCurrency: "JPY", exposureTags: item.tags, officialBenchmark: null });
    const marketJpy = Number(item.row.marketJpy) || 0;
    const costJpy = Number(item.row.costJpy) || 0;
    const marketValue = stableCny(marketJpy, rate);
    const costValue = stableCny(costJpy, rate);
    japanMarketJpy += marketJpy;
    positionSnapshots.push({
      id: `${accountId}-${item.id.toLowerCase().replaceAll(".", "-")}-${asOf.replaceAll("-", "")}`,
      asOf,
      accountId,
      instrumentId: item.id,
      quantity: 1,
      quantityApproximate: true,
      alternateReportedQuantity: null,
      referencePrice: marketJpy,
      costPrice: costJpy,
      marketValue,
      reportedPnl: round2(marketValue - costValue),
      reportedPnlRate: costValue > 0 ? (marketValue - costValue) / costValue : null,
      pnlBasis: "代持表组合汇总的现值与初始金额；不是单只证券收益率",
      sourceQuality: "xlsx-aggregate",
      note: "缺产品代码、份额和申赎流水，暂按一个组合单位展示。",
    });
  }

  const cashJpy = (Number(custody.holdings.accountCashJpy) || 0) + saleProceedsJpy;
  const marketJpy = usMarketJpy + japanMarketJpy;
  const totalAssetsJpy = cashJpy + marketJpy;
  const totalCostJpy = Number(custody.total?.costJpy) || 0;
  const marketValue = stableCny(marketJpy, rate);
  const cash = stableCny(cashJpy, rate);
  const totalAssets = round2(marketValue + cash);
  return {
    source: { title: "委托代持投资账户", asOf },
    coverage: {
      status: "partial",
      from: transactions.map((row) => row.tradedAt.slice(0, 10)).sort()[0] || asOf,
      to: asOf,
      holdingsStatus: "snapshot-plus-confirmed-trades",
      transactionsStatus: "partial",
      cashFlowsStatus: "partial",
      note: "旧表提供账户成本与持仓快照，并保留两笔有日期的 NVDA 买入批次；表后已确认卖出用于修正数量与现金。其余早期成交无日期，日本部分只有组合汇总。",
      missing: ["代持账户早期成交日期", "卖出费用、税费与实际结算汇率", "日本组合的产品代码、份额与申赎流水", "代持账户逐笔入出金"],
      futureCapture: ["海外账户成交：日期、市场、代码、方向、数量、价格、费用与税费", "海外账户资金：入出金日期、币种、金额与换汇", "日本组合：产品代码、份额、成本、现值与申赎日期"],
    },
    accounts: [{ id: accountId, label: "委托代持账户", broker: "示例券商（代持）", country: "JP", ownerType: "custody", baseCurrency: "MIXED", accountClass: "custody-brokerage" }],
    instruments,
    accountSnapshots: [{
      id: `${accountId}-${asOf.replaceAll("-", "")}`,
      asOf,
      accountId,
      totalAssets,
      cash,
      marketValue,
      available: cash,
      withdrawable: null,
      investedRatio: totalAssets > 0 ? marketValue / totalAssets : null,
      reportedPnl: round2(totalAssets - stableCny(totalCostJpy, rate)),
      reportedPnlLabel: "代持表累计盈亏",
      holdingPnl: null,
      sourceQuality: "xlsx-snapshot-plus-confirmed-trades",
      note: `按 ${rate} CNY/JPY 的当前估值汇率折算；已确认卖出按成交额转入账户现金，未计费用与税费。`,
    }],
    cashFlowSummaries: [],
    transactions,
    positionSnapshots,
    historicalInvestments: [],
    marketEvidence: {
      asOf,
      sources: [{
        id: "google-sheet-sunxiang-custody",
        label: "代持账户表（委托代持）",
        kind: "custody-ledger",
        url: custody.googleSheetUrl || GOOGLE_SHEET_URL,
        retrievedAt: String(custody.source?.createdAt || "").slice(0, 10),
      }],
      series: [],
    },
  };
}

export function applyCustodyOverlayToSnapshot(snapshot, parsed, options = {}) {
  if (!snapshot || !parsed?.usStocks) return snapshot;
  const overlay = custodyOverlayItems(parsed, options);
  const replaceNames = new Set(overlay.map((item) => item.name));
  const items = [
    ...snapshot.items.filter((item) => !replaceNames.has(item.name)),
    ...overlay,
  ];
  const totalAssets = items.reduce((sum, item) => sum + Math.max(0, item.cnyValue), 0);
  const totalLiabilities = items.reduce((sum, item) => sum + Math.abs(Math.min(0, item.cnyValue)), 0);
  const categoryMap = new Map();
  for (const item of items) {
    categoryMap.set(item.category, (categoryMap.get(item.category) ?? 0) + item.cnyValue);
  }
  const categories = [...categoryMap.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return {
    ...snapshot,
    items,
    totalAssets,
    totalLiabilities,
    netAssets: totalAssets - totalLiabilities,
    categories,
    custodyOverlaid: true,
  };
}

export async function readSunxiangCustody(root, options = {}) {
  const file = await resolveHoldingsFile(root, options);
  if (!file) {
    return emptyCustody(
      "还没有《代持账户表》表。可从 Google 表格导出 xlsx 到下载文件夹，或放到个人资产目录。",
    );
  }

  const key = `${file.location}:${file.name}:${file.mtimeMs}:${file.size}:v4`;
  if (!options.force && cache?.key === key) return cache.data;

  const source = {
    title: "代持账户表（委托代持）",
    name: file.name,
    path: file.location === "vault" ? SUNXIANG_HOLDINGS_FILE : path.posix.join("~/Downloads", file.name),
    location: file.location,
    createdAt: file.createdAt,
    createdAtKind: file.createdAtKind,
    googleSheetUrl: GOOGLE_SHEET_URL,
  };

  let parsed;
  try {
    parsed = await parseHoldingsXlsx(file.absolute);
  } catch (error) {
    return emptyCustody(error instanceof Error ? error.message : "读委托代持表失败。", source);
  }

  const data = {
    available: true,
    message: "",
    googleSheetUrl: GOOGLE_SHEET_URL,
    source,
    ...parsed,
    income: {
      label: "投资浮动盈亏（现市值 − 成本）",
      gainJpy: round2(parsed.total.gainJpy),
      gainCny: round2(parsed.total.gainCny),
      yield: parsed.total.yield,
      cnyYield: parsed.total.cnyYield,
      usGainJpy: round2(parsed.usStocks.gainJpy),
      fundsGainJpy: round2(parsed.funds.gainJpy),
    },
    overlayItems: custodyOverlayItems(parsed),
    compareJune: {
      usStocksJpyJune: 4096182.04,
      fundsJpyJune: 1652399.43,
      receivableCnyJune: 82017,
      usStocksJpyDelta: round2(parsed.usStocks.amountJpy - 4096182.04),
      fundsJpyDelta: round2(parsed.funds.amountJpy - 1652399.43),
      receivableCnyDelta: round2(parsed.receivableCny - 82017),
    },
  };
  cache = { key, data };
  return data;
}

export async function importSunxiangHoldingsToVault(root, options = {}) {
  const downloadsDir = options.downloadsDir || defaultDownloadsDir();
  const pick = (await listSunxiangDownloadCandidates(downloadsDir))[0];
  if (!pick) {
    const { WorkbenchWriteError } = await import("./workbench-errors.mjs");
    throw new WorkbenchWriteError("下载文件夹里没有《代持账户表》xlsx。", 404, "SUNXIANG_DOWNLOAD_MISSING");
  }
  const dir = ensureInside(root, SUNXIANG_HOLDINGS_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const target = ensureInside(root, SUNXIANG_HOLDINGS_FILE);
  await fsp.copyFile(pick.absolute, target);
  cache = null;
  const custody = await readSunxiangCustody(root, { force: true, downloadsDir });
  return {
    imported: {
      name: pick.name,
      createdAt: pick.createdAt,
      path: SUNXIANG_HOLDINGS_FILE,
    },
    custody,
  };
}

export function resetSunxiangCustodyCache() {
  cache = null;
}
