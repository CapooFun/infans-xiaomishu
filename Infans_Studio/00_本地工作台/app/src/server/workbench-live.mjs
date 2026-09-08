import path from "node:path";
import { readBaseInvestmentLedger } from "./workbench-investments.mjs";
import {
  parseJmaTokyoQuake,
  parseJmaTokyoWarningCodes,
  publicWeatherAlert,
  selectTokyoWeatherAlert,
} from "./weather-alert.mjs";
import { readWorldLaneCurrentEvents } from "./workbench-world-brief.mjs";

/** 首页第一页：顺序就是本人指定的观察顺序。SpaceX 2026-06-12 起以 SPCX 上市交易。 */
export const HOME_STOCK_WATCHLIST = [
  { symbol: "^IXIC", label: "纳指" },
  { symbol: "NVDA", label: null },
  { symbol: "SPCX", label: "SpaceX" },
  { symbol: "GOOGL", label: null },
  { symbol: "AAPL", label: null },
  { symbol: "MSFT", label: null },
  { symbol: "AMAT", label: null },
];
const MARKET_TICKERS = HOME_STOCK_WATCHLIST.map((item) => item.symbol);
const TICKER_LABELS = Object.fromEntries(HOME_STOCK_WATCHLIST.map((item) => [item.symbol, item.label]));
const EVERBRIGHT_SELF_ACCOUNT_ID = "cn-ebscn-self-3897";
const TOKYO = { latitude: 35.6895, longitude: 139.6917 };
const WEATHER_CACHE_MS = 20 * 60_000;
/** 美股 / 汇率：服务端保活刷新间隔；启动时先拉一次。 */
export const MARKET_REFRESH_MS = 300_000;

/** @type {{ at: number, value: unknown } | null} */
let weatherCache = null;
/** @type {{ at: number, value: unknown } | null} */
let marketCache = null;
/** @type {ReturnType<typeof setInterval> | null} */
let marketRefreshTimer = null;

const WMO_LABELS = {
  0: "晴",
  1: "大部晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "毛毛雨",
  53: "毛毛雨",
  55: "毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  80: "阵雨",
  81: "阵雨",
  82: "强阵雨",
  95: "雷雨",
};

function uvLabel(index) {
  if (index == null || Number.isNaN(index)) return "—";
  if (index < 3) return "低";
  if (index < 6) return "中";
  if (index < 8) return "高";
  if (index < 11) return "很高";
  return "极高";
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`上游响应 ${response.status}`);
  return response.json();
}

function settledValue(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function emptyWeather(message) {
  return {
    available: false,
    location: "东京",
    temperatureC: null,
    weatherCode: null,
    condition: "暂不可用",
    uvIndex: null,
    uvLabel: "—",
    refreshedAt: null,
    message,
    alert: null,
  };
}

export async function readWeather(vaultRoot = "") {
  if (weatherCache && Date.now() - weatherCache.at < WEATHER_CACHE_MS) return weatherCache.value;
  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(TOKYO.latitude));
  forecastUrl.searchParams.set("longitude", String(TOKYO.longitude));
  forecastUrl.searchParams.set("current", "temperature_2m,weather_code,precipitation,uv_index");
  forecastUrl.searchParams.set("timezone", "Asia/Tokyo");
  let newsEvents = [];
  try {
    const root = path.resolve(vaultRoot || process.env.INFANS_VAULT_ROOT || path.join(process.cwd(), "../.."));
    newsEvents = await readWorldLaneCurrentEvents(root, "japan");
  } catch {
    newsEvents = [];
  }
  try {
    const [forecastResult, r8Result, warningResult, quakeResult] = await Promise.allSettled([
      fetchJson(forecastUrl),
      fetchJson("https://www.jma.go.jp/bosai/warning/data/r8/130000.json"),
      fetchJson("https://www.jma.go.jp/bosai/warning/data/warning/130000.json"),
      fetchJson("https://www.jma.go.jp/bosai/quake/data/list.json"),
    ]);
    const forecast = settledValue(forecastResult);
    const current = forecast?.current ?? {};
    const code = Number(current.weather_code);
    const temperature = Number(current.temperature_2m);
    const uvIndex = Number(current.uv_index);
    const precipitation = Number(current.precipitation);
    const warningCodes = [...new Set([
      ...parseJmaTokyoWarningCodes(settledValue(r8Result)),
      ...parseJmaTokyoWarningCodes(settledValue(warningResult)),
    ])];
    const value = {
      available: Boolean(forecast),
      location: "东京",
      temperatureC: Number.isFinite(temperature) ? Math.round(temperature) : null,
      weatherCode: Number.isFinite(code) ? code : null,
      condition: forecast ? (WMO_LABELS[code] ?? "天气") : "暂不可用",
      uvIndex: Number.isFinite(uvIndex) ? Number(uvIndex.toFixed(1)) : null,
      uvLabel: uvLabel(uvIndex),
      refreshedAt: forecast ? new Date().toISOString() : null,
      message: forecast ? null : (forecastResult.status === "rejected" && forecastResult.reason instanceof Error ? forecastResult.reason.message : "读不到天气"),
      alert: publicWeatherAlert(selectTokyoWeatherAlert({
        warningCodes,
        weatherCode: Number.isFinite(code) ? code : null,
        precipitationMm: Number.isFinite(precipitation) ? precipitation : 0,
        quake: parseJmaTokyoQuake(settledValue(quakeResult)),
        events: newsEvents,
      })),
    };
    weatherCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value = emptyWeather(error instanceof Error ? error.message : "读不到天气");
    weatherCache = { at: Date.now(), value };
    return value;
  }
}

/**
 * 用日 K 收盘序列算相对上一交易日的涨跌。
 *
 * 禁止用 Yahoo chart meta 的 `chartPreviousClose`：它不是「上一交易日收盘」，
 * 在 range=2d/5d 下常落在更早一根 K（例如隔两日），会把涨跌幅算飞。
 * 正确基准是 closes 里最近一根完整日 K 之前的那根收盘价。
 *
 * @param {number | null} price regularMarketPrice（盘中现价或最近收盘）
 * @param {unknown[]} closes 日线 close 数组（可含 null）
 * @returns {{ change: number | null, changePercent: number | null, previousClose: number | null }}
 */
export function dayChangeFromDailyCloses(price, closes) {
  const series = (Array.isArray(closes) ? closes : [])
    .filter((value) => value != null && value !== "")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const previous = series.length >= 2 ? series[series.length - 2] : null;
  if (!Number.isFinite(price) || previous == null || previous === 0) {
    return { change: null, changePercent: null, previousClose: previous };
  }
  const change = price - previous;
  return {
    change,
    changePercent: (change / previous) * 100,
    previousClose: previous,
  };
}

function extractDailyCloses(chartResult) {
  const raw = chartResult?.indicators?.quote?.[0]?.close;
  return Array.isArray(raw) ? raw : [];
}

async function readYahooQuotes(symbols) {
  const url = new URL("https://query1.finance.yahoo.com/v7/finance/quote");
  url.searchParams.set("symbols", symbols.join(","));
  try {
    const data = await fetchJson(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 InfansWorkbench/1.0",
        Accept: "application/json",
      },
    });
    const results = data?.quoteResponse?.result;
    if (!Array.isArray(results) || !results.length) throw new Error("行情数据结构异常");
    return results.map((item) => {
      const price = Number(item.regularMarketPrice);
      const change = Number(item.regularMarketChange);
      const changePercent = Number(item.regularMarketChangePercent);
      const symbol = String(item.symbol || "");
      return {
        symbol,
        label: TICKER_LABELS[symbol] || null,
        name: String(item.shortName || item.longName || item.symbol || ""),
        price: Number.isFinite(price) ? price : null,
        change: Number.isFinite(change) ? change : null,
        changePercent: Number.isFinite(changePercent) ? changePercent : null,
        currency: String(item.currency || "USD"),
      };
    }).filter((item) => item.symbol);
  } catch {
    // v7 quote 常 401：退回日 K。涨跌必须用最近两根收盘，勿信 chartPreviousClose。
    const charts = await Promise.all(symbols.map(async (symbol) => {
      try {
        const chartUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
        chartUrl.searchParams.set("interval", "1d");
        chartUrl.searchParams.set("range", "5d");
        const data = await fetchJson(chartUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 InfansWorkbench/1.0",
            Accept: "application/json",
          },
        });
        const result = data?.chart?.result?.[0];
        const meta = result?.meta;
        if (!meta) return null;
        const price = Number(meta.regularMarketPrice);
        const { change, changePercent } = dayChangeFromDailyCloses(price, extractDailyCloses(result));
        return {
          symbol,
          label: TICKER_LABELS[symbol] || null,
          name: String(meta.shortName || meta.symbol || symbol),
          price: Number.isFinite(price) ? price : null,
          change,
          changePercent,
          currency: String(meta.currency || "USD"),
        };
      } catch {
        // 单个标的临时不可用时保留其余行情，首页对应行显示占位而不是整卡失败。
        return null;
      }
    }));
    const stocks = charts.filter(Boolean);
    if (!stocks.length) throw new Error("读不到行情");
    return stocks;
  }
}

function buildFxRows(usdCny, usdJpy) {
  return [
    // 用交叉盘推算日元兑人民币，比单独拉 JPYCNY=X 的四位截断更贴近盘面。
    { pair: "JPY/CNY", label: "日元 → 人民币", value: Number((usdCny / usdJpy).toFixed(5)) },
    { pair: "USD/CNY", label: "美元 → 人民币", value: Number(usdCny.toFixed(4)) },
    { pair: "USD/JPY", label: "美元 → 日元", value: Number(usdJpy.toFixed(2)) },
  ];
}

/** 按最新交易日回看若干自然日，缺日不补点。 */
export function sliceRecentDailyTrend(points, days = 14) {
  const series = (Array.isArray(points) ? points : [])
    .filter((point) => point && typeof point.date === "string" && Number(point.value) > 0)
    .map((point) => ({ date: point.date, value: Number(point.value) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = series.at(-1)?.date;
  if (!latest) return [];
  const latestTime = Date.parse(`${latest}T00:00:00Z`);
  const cutoff = latestTime - (Math.max(1, Number(days) || 14) - 1) * 24 * 60 * 60_000;
  return series.filter((point) => Date.parse(`${point.date}T00:00:00Z`) >= cutoff);
}

function emptyFxTrends(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, trend: [] }));
}

/** 给三项首页汇率各自挂上最近 14 个自然日的真实日线。 */
export function attachFxTrends(rows, usdCnyDaily, usdJpyDaily) {
  const trends = {
    "JPY/CNY": buildJpyCnyTrend(usdCnyDaily, usdJpyDaily),
    "USD/CNY": sliceRecentDailyTrend(usdCnyDaily),
    "USD/JPY": sliceRecentDailyTrend(usdJpyDaily),
  };
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    trend: trends[row.pair] ?? [],
  }));
}

async function readYahooDailySeries(symbol) {
  const chartUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  chartUrl.searchParams.set("interval", "1d");
  chartUrl.searchParams.set("range", "1mo");
  const data = await fetchJson(chartUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 InfansWorkbench/1.0",
      Accept: "application/json",
    },
  });
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo 汇率日线结构异常");
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = extractDailyCloses(result);
  const points = timestamps.flatMap((timestamp, index) => {
    const time = Number(timestamp);
    const value = Number(closes[index]);
    if (!Number.isFinite(time) || !Number.isFinite(value) || value <= 0) return [];
    return [{ date: new Date(time * 1000).toISOString().slice(0, 10), value }];
  });
  const quoted = Number(result.meta?.regularMarketPrice);
  const price = Number.isFinite(quoted) && quoted > 0 ? quoted : points.at(-1)?.value;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Yahoo 汇率日线缺少当前值");
  return { price, points };
}

/** 从同日 USD/CNY 与 USD/JPY 日线交叉计算最近 14 个自然日的 JPY/CNY。 */
export function buildJpyCnyTrend(usdCnyDaily, usdJpyDaily) {
  const usdJpyByDate = new Map((Array.isArray(usdJpyDaily) ? usdJpyDaily : [])
    .filter((point) => point && typeof point.date === "string" && Number(point.value) > 0)
    .map((point) => [point.date, Number(point.value)]));
  const combined = (Array.isArray(usdCnyDaily) ? usdCnyDaily : [])
    .flatMap((point) => {
      const usdCny = Number(point?.value);
      const usdJpy = usdJpyByDate.get(point?.date);
      if (!point?.date || !Number.isFinite(usdCny) || usdCny <= 0 || !usdJpy) return [];
      return [{ date: point.date, value: Number((usdCny / usdJpy).toFixed(5)) }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return sliceRecentDailyTrend(combined);
}

async function readFxFromYahoo() {
  const [usdCnySeries, usdJpySeries] = await Promise.all([
    readYahooDailySeries("USDCNY=X"),
    readYahooDailySeries("USDJPY=X"),
  ]);
  const usdCny = Number(usdCnySeries.price);
  const usdJpy = Number(usdJpySeries.price);
  if (!Number.isFinite(usdCny) || !Number.isFinite(usdJpy) || usdCny <= 0 || usdJpy <= 0) {
    throw new Error("Yahoo 汇率数据结构异常");
  }
  return attachFxTrends(buildFxRows(usdCny, usdJpy), usdCnySeries.points, usdJpySeries.points);
}

async function readFxRates() {
  try {
    return await readFxFromYahoo();
  } catch {
    // 备用：近实时汇总源；不用 Frankfurter——它常停在上一个工作日 ECB 价，盘中会明显偏。
    const data = await fetchJson("https://open.er-api.com/v6/latest/USD");
    const usdCny = Number(data?.rates?.CNY);
    const usdJpy = Number(data?.rates?.JPY);
    if (!Number.isFinite(usdCny) || !Number.isFinite(usdJpy) || usdCny <= 0 || usdJpy <= 0) throw new Error("汇率数据结构异常");
    return emptyFxTrends(buildFxRows(usdCny, usdJpy));
  }
}

/**
 * @param {{ force?: boolean }} [options]
 */
export async function readMarketLive(options = {}) {
  const force = Boolean(options.force);
  if (!force && marketCache && Date.now() - marketCache.at < MARKET_REFRESH_MS) return marketCache.value;
  const base = {
    available: false,
    stocks: [],
    fx: [],
    refreshedAt: null,
    message: null,
  };
  try {
    const [stockQuotes, fxRows] = await Promise.all([readYahooQuotes(MARKET_TICKERS), readFxRates()]);
    const stockBySymbol = Object.fromEntries(stockQuotes.map((item) => [item.symbol, item]));
    const stocks = HOME_STOCK_WATCHLIST.map((item) => ({
      symbol: item.symbol,
      label: item.label,
      name: stockBySymbol[item.symbol]?.name || item.label || item.symbol,
      price: stockBySymbol[item.symbol]?.price ?? null,
      change: stockBySymbol[item.symbol]?.change ?? null,
      changePercent: stockBySymbol[item.symbol]?.changePercent ?? null,
      currency: stockBySymbol[item.symbol]?.currency || "USD",
    }));
    const value = {
      available: true,
      stocks,
      fx: fxRows,
      refreshedAt: new Date().toISOString(),
      message: null,
    };
    marketCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value = {
      ...base,
      message: error instanceof Error ? error.message : "读不到行情",
    };
    // 失败时若已有可用快照，保留旧值供看板继续显示，避免把成功态冲掉。
    const previous = marketCache?.value;
    if (previous && typeof previous === "object" && "available" in previous && previous.available) {
      return previous;
    }
    marketCache = { at: Date.now(), value };
    return value;
  }
}

function yahooSymbolForCnInstrument(instrument) {
  if (instrument.exchange === "SSE") return `${instrument.symbol}.SS`;
  if (instrument.exchange === "SZSE") return `${instrument.symbol}.SZ`;
  return null;
}

/**
 * 从账本的最新光大持仓快照派生最小公开行情请求。
 * 返回值刻意不含数量、成本、盈亏、市值或账户金额。
 */
export function buildHomeHoldingQuoteRequests(ledger) {
  const positions = (ledger?.positionSnapshots || [])
    .filter((row) => row.accountId === EVERBRIGHT_SELF_ACCOUNT_ID && row.quantity > 0);
  const latestAsOf = positions.map((row) => row.asOf).sort().at(-1);
  if (!latestAsOf) return [];
  const instruments = new Map((ledger?.instruments || []).map((row) => [row.id, row]));
  return positions
    .filter((row) => row.asOf === latestAsOf)
    .flatMap((row) => {
      const instrument = instruments.get(row.instrumentId);
      const quoteSymbol = instrument ? yahooSymbolForCnInstrument(instrument) : null;
      return instrument && quoteSymbol ? [{
        quoteSymbol,
        symbol: instrument.symbol,
        label: instrument.name,
        name: instrument.name,
        currency: instrument.listingCurrency || "CNY",
      }] : [];
    });
}

async function readHomeHoldingStocks(root) {
  const ledger = await readBaseInvestmentLedger(root);
  const requests = buildHomeHoldingQuoteRequests(ledger);
  if (!requests.length) return [];
  let quotes = [];
  try {
    quotes = await readYahooQuotes(requests.map((item) => item.quoteSymbol));
  } catch {
    // 持仓事实仍可显示；公开行情源临时不可用时价格留空。
  }
  const bySymbol = Object.fromEntries(quotes.map((item) => [item.symbol, item]));
  return requests.map((item) => ({
    symbol: item.symbol,
    label: item.label,
    name: item.name,
    price: bySymbol[item.quoteSymbol]?.price ?? null,
    change: bySymbol[item.quoteSymbol]?.change ?? null,
    changePercent: bySymbol[item.quoteSymbol]?.changePercent ?? null,
    currency: bySymbol[item.quoteSymbol]?.currency || item.currency,
  }));
}

/** 首页专用派生：公共市场快照 + 本人光大最新持仓标的的公开行情。 */
export async function readHomeMarketLive(root, options = {}) {
  const [market, holdingStocks] = await Promise.all([
    readMarketLive(options),
    readHomeHoldingStocks(root).catch(() => []),
  ]);
  return { ...market, holdingStocks };
}

/** 工作台进程启动时预热，并在运行期间每 MARKET_REFRESH_MS 强制刷新一次。 */
export function startMarketLiveRefresh() {
  if (marketRefreshTimer) return;
  const tick = () => {
    readMarketLive({ force: true }).catch(() => {});
  };
  tick();
  marketRefreshTimer = setInterval(tick, MARKET_REFRESH_MS);
  marketRefreshTimer.unref?.();
}

export function stopMarketLiveRefresh() {
  if (!marketRefreshTimer) return;
  clearInterval(marketRefreshTimer);
  marketRefreshTimer = null;
}
