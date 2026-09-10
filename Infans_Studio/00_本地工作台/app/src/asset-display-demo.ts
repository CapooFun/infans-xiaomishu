import type {
  AssetCashflowEntry,
  AssetCashflowData,
  AssetSnapshot,
  AssetVaultData,
  InvestmentInstrumentSeries,
  InvestmentLedgerData,
  InvestmentPeriodPerformance,
} from "./types";

const DEMO_AS_OF = "2026-08-27";
const DEMO_DATES = [
  "2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30", "2025-05-30",
  "2025-06-30", "2025-07-31", "2025-08-29", "2025-09-30", "2025-10-31",
  "2025-11-28", "2025-12-31", "2026-01-30", "2026-02-27", "2026-03-31",
  "2026-04-30", "2026-05-29", "2026-06-30", "2026-07-31", "2026-08-27",
];

const DEMO_INSTRUMENTS = [
  { id: "DEMO.CN.300", symbol: "510300", name: "沪深300ETF", exchange: "SSE", assetClass: "ETF", listingCurrency: "CNY", exposureTags: ["中国股票", "大盘"], officialBenchmark: null },
  { id: "DEMO.CN.DIV", symbol: "512890", name: "红利低波ETF", exchange: "SSE", assetClass: "ETF", listingCurrency: "CNY", exposureTags: ["中国股票", "红利"], officialBenchmark: null },
  { id: "DEMO.US.NDX", symbol: "513100", name: "纳指100ETF", exchange: "SSE", assetClass: "ETF", listingCurrency: "CNY", exposureTags: ["美国股票", "科技", "QDII"], officialBenchmark: null },
  { id: "DEMO.GOLD", symbol: "518880", name: "黄金ETF", exchange: "SSE", assetClass: "ETF", listingCurrency: "CNY", exposureTags: ["黄金", "商品"], officialBenchmark: null },
  { id: "DEMO.BOND", symbol: "009999", name: "稳健债券基金", exchange: "OTC", assetClass: "MutualFund", listingCurrency: "CNY", exposureTags: ["中国债券", "固收"], officialBenchmark: null },
  { id: "DEMO.CN.MFG", symbol: "600999", name: "制造龙头", exchange: "SSE", assetClass: "Stock", listingCurrency: "CNY", exposureTags: ["中国股票", "制造业"], officialBenchmark: null },
  { id: "DEMO.CN.500", symbol: "510500", name: "中证500ETF", exchange: "SSE", assetClass: "ETF", listingCurrency: "CNY", exposureTags: ["中国股票", "中小盘"], officialBenchmark: null },
  { id: "DEMO.CN.HEALTH", symbol: "512170", name: "医疗创新ETF", exchange: "SSE", assetClass: "ETF", listingCurrency: "CNY", exposureTags: ["中国股票", "医疗"], officialBenchmark: null },
  { id: "DEMO.JP.225", symbol: "513520", name: "日经225ETF", exchange: "SSE", assetClass: "ETF", listingCurrency: "CNY", exposureTags: ["日本股票", "QDII"], officialBenchmark: null },
  { id: "DEMO.CN.UTIL", symbol: "560580", name: "公用事业ETF", exchange: "SSE", assetClass: "ETF", listingCurrency: "CNY", exposureTags: ["中国股票", "公用事业"], officialBenchmark: null },
];

const DEMO_SERIES_CONFIG = [
  { id: "DEMO.CN.300", accountId: "demo-account-a", profit: 300_000, marketValue: 1_350_000, strategy: [100, 101, 96, 103, 108, 106, 112, 116, 109, 121, 127, 132, 126, 119, 134, 141, 149, 145, 154, 160], market: [100, 100, 95, 101, 105, 103, 108, 111, 106, 115, 119, 122, 117, 113, 124, 129, 135, 132, 138, 142] },
  { id: "DEMO.CN.DIV", accountId: "demo-account-a", profit: 145_000, marketValue: 850_000, strategy: [100, 102, 104, 103, 107, 109, 112, 115, 113, 118, 122, 125, 123, 127, 131, 134, 137, 136, 140, 143], market: [100, 101, 103, 102, 105, 106, 108, 110, 109, 112, 115, 117, 116, 119, 121, 123, 125, 124, 127, 129] },
  { id: "DEMO.US.NDX", accountId: "demo-account-b", profit: 270_000, marketValue: 1_100_000, strategy: [100, 96, 91, 88, 101, 111, 119, 113, 126, 137, 130, 145, 139, 127, 143, 155, 149, 166, 158, 173], market: [100, 97, 93, 90, 99, 106, 112, 108, 118, 127, 122, 134, 131, 120, 134, 143, 138, 151, 145, 158] },
  { id: "DEMO.GOLD", accountId: "demo-account-b", profit: -40_000, marketValue: 550_000, strategy: [100, 103, 106, 109, 107, 102, 105, 103, 101, 98, 96, 94, 95, 92, 90, 91, 89, 88, 90, 92], market: [100, 103, 105, 108, 110, 109, 112, 115, 117, 119, 121, 124, 126, 129, 132, 133, 135, 138, 141, 144] },
  { id: "DEMO.BOND", accountId: "demo-account-b", profit: 55_000, marketValue: 500_000, strategy: [100, 100.5, 101, 101.4, 102, 102.6, 103.1, 103.8, 104.2, 104.9, 105.4, 106, 106.6, 107.1, 107.8, 108.4, 109, 109.6, 110.2, 111], market: [100, 100.4, 100.9, 101.3, 101.8, 102.3, 102.8, 103.3, 103.8, 104.3, 104.8, 105.3, 105.8, 106.3, 106.8, 107.3, 107.8, 108.3, 108.8, 109.3] },
  { id: "DEMO.CN.MFG", accountId: "demo-account-c", profit: 105_000, marketValue: 350_000, strategy: [100, 95, 101, 92, 108, 103, 116, 124, 110, 129, 118, 137, 128, 112, 136, 147, 130, 158, 146, 165], market: [100, 98, 102, 96, 104, 102, 109, 114, 106, 119, 111, 125, 119, 107, 126, 133, 121, 142, 135, 148] },
  { id: "DEMO.CN.500", accountId: "demo-account-a", profit: 120_000, marketValue: 400_000, strategy: [100, 97, 92, 95, 104, 101, 113, 118, 110, 124, 132, 128, 121, 115, 131, 140, 136, 150, 146, 157], market: [100, 98, 94, 96, 102, 100, 108, 111, 106, 116, 121, 119, 114, 110, 121, 128, 125, 136, 132, 141] },
  { id: "DEMO.CN.HEALTH", accountId: "demo-account-a", profit: 90_000, marketValue: 300_000, strategy: [100, 94, 89, 91, 98, 105, 101, 110, 117, 109, 121, 129, 123, 116, 132, 126, 139, 148, 143, 155], market: [100, 96, 91, 92, 97, 101, 99, 105, 110, 104, 113, 119, 115, 109, 121, 117, 128, 135, 130, 140] },
  { id: "DEMO.JP.225", accountId: "demo-account-b", profit: 95_000, marketValue: 300_000, strategy: [100, 102, 98, 105, 111, 108, 116, 113, 121, 128, 124, 135, 131, 126, 139, 145, 141, 152, 149, 158], market: [100, 101, 99, 103, 107, 105, 111, 109, 116, 121, 118, 127, 124, 120, 131, 136, 133, 143, 140, 148] },
  { id: "DEMO.CN.UTIL", accountId: "demo-account-c", profit: 56_000, marketValue: 200_000, strategy: [100, 101, 103, 102, 105, 108, 107, 111, 114, 113, 118, 121, 119, 123, 126, 129, 132, 131, 135, 138], market: [100, 101, 102, 101, 103, 105, 104, 107, 109, 108, 112, 114, 113, 116, 118, 120, 122, 121, 124, 126] },
] as const;

const DEMO_ACTIONS: Record<string, InvestmentInstrumentSeries["actions"]> = {
  "DEMO.CN.300": [
    { id: "demo-300-buy-1", date: "2025-03-31", side: "buy", quantity: 280_000, price: 3.86 },
    { id: "demo-300-buy-2", date: "2025-09-30", side: "buy", quantity: 110_000, price: 4.08 },
    { id: "demo-300-sell-1", date: "2025-12-31", side: "sell", quantity: 80_000, price: 4.92 },
    { id: "demo-300-buy-3", date: "2026-02-27", side: "buy", quantity: 70_000, price: 4.20 },
    { id: "demo-300-sell-2", date: "2026-06-30", side: "sell", quantity: 95_000, price: 5.42 },
  ],
  "DEMO.CN.DIV": [
    { id: "demo-div-buy-1", date: "2025-01-31", side: "buy", quantity: 420_000, price: 1.16 },
    { id: "demo-div-buy-2", date: "2025-04-30", side: "buy", quantity: 160_000, price: 1.19 },
    { id: "demo-div-sell-1", date: "2025-12-31", side: "sell", quantity: 90_000, price: 1.46 },
    { id: "demo-div-buy-3", date: "2026-02-27", side: "buy", quantity: 55_000, price: 1.35 },
  ],
  "DEMO.US.NDX": [
    { id: "demo-ndx-buy-1", date: "2025-03-31", side: "buy", quantity: 180_000, price: 1.62 },
    { id: "demo-ndx-buy-2", date: "2025-04-30", side: "buy", quantity: 210_000, price: 1.58 },
    { id: "demo-ndx-sell-1", date: "2025-10-31", side: "sell", quantity: 90_000, price: 2.31 },
    { id: "demo-ndx-sell-2", date: "2025-12-31", side: "sell", quantity: 60_000, price: 2.43 },
    { id: "demo-ndx-buy-3", date: "2026-02-27", side: "buy", quantity: 75_000, price: 2.08 },
    { id: "demo-ndx-buy-4", date: "2026-03-31", side: "buy", quantity: 65_000, price: 2.02 },
    { id: "demo-ndx-sell-3", date: "2026-06-30", side: "sell", quantity: 85_000, price: 2.78 },
  ],
  "DEMO.GOLD": [
    { id: "demo-gold-buy-1", date: "2025-04-30", side: "buy", quantity: 95_000, price: 5.62 },
    { id: "demo-gold-buy-2", date: "2025-08-29", side: "buy", quantity: 30_000, price: 6.14 },
    { id: "demo-gold-sell-1", date: "2026-07-31", side: "sell", quantity: 18_000, price: 7.03 },
  ],
  "DEMO.BOND": [
    { id: "demo-bond-buy-1", date: "2025-01-31", side: "buy", quantity: 320_000, price: 1.01 },
    { id: "demo-bond-buy-2", date: "2025-07-31", side: "buy", quantity: 120_000, price: 1.04 },
  ],
  "DEMO.CN.MFG": [
    { id: "demo-mfg-buy-1", date: "2025-04-30", side: "buy", quantity: 18_000, price: 9.35 },
    { id: "demo-mfg-buy-2", date: "2025-09-30", side: "buy", quantity: 8_000, price: 10.60 },
    { id: "demo-mfg-sell-1", date: "2025-12-31", side: "sell", quantity: 7_000, price: 14.80 },
    { id: "demo-mfg-buy-3", date: "2026-02-27", side: "buy", quantity: 5_000, price: 10.95 },
    { id: "demo-mfg-sell-2", date: "2026-06-30", side: "sell", quantity: 6_000, price: 16.40 },
  ],
  "DEMO.CN.500": [
    { id: "demo-500-buy-1", date: "2025-03-31", side: "buy", quantity: 55_000, price: 5.05 },
    { id: "demo-500-buy-2", date: "2025-09-30", side: "buy", quantity: 18_000, price: 5.72 },
    { id: "demo-500-sell-1", date: "2025-11-28", side: "sell", quantity: 16_000, price: 6.96 },
    { id: "demo-500-buy-3", date: "2026-02-27", side: "buy", quantity: 12_000, price: 5.88 },
    { id: "demo-500-sell-2", date: "2026-06-30", side: "sell", quantity: 14_000, price: 7.42 },
  ],
  "DEMO.CN.HEALTH": [
    { id: "demo-health-buy-1", date: "2025-03-31", side: "buy", quantity: 120_000, price: 0.74 },
    { id: "demo-health-buy-2", date: "2025-04-30", side: "buy", quantity: 80_000, price: 0.72 },
    { id: "demo-health-sell-1", date: "2025-11-28", side: "sell", quantity: 55_000, price: 1.03 },
    { id: "demo-health-buy-3", date: "2026-02-27", side: "buy", quantity: 36_000, price: 0.88 },
    { id: "demo-health-sell-2", date: "2026-06-30", side: "sell", quantity: 42_000, price: 1.18 },
  ],
  "DEMO.JP.225": [
    { id: "demo-jp-buy-1", date: "2025-03-31", side: "buy", quantity: 70_000, price: 1.32 },
    { id: "demo-jp-buy-2", date: "2025-08-29", side: "buy", quantity: 45_000, price: 1.48 },
    { id: "demo-jp-sell-1", date: "2025-12-31", side: "sell", quantity: 35_000, price: 1.86 },
    { id: "demo-jp-buy-3", date: "2026-02-27", side: "buy", quantity: 28_000, price: 1.61 },
    { id: "demo-jp-sell-2", date: "2026-06-30", side: "sell", quantity: 30_000, price: 2.08 },
  ],
  "DEMO.CN.UTIL": [
    { id: "demo-util-buy-1", date: "2025-01-31", side: "buy", quantity: 90_000, price: 1.02 },
    { id: "demo-util-buy-2", date: "2025-09-30", side: "buy", quantity: 35_000, price: 1.10 },
    { id: "demo-util-sell-1", date: "2026-06-30", side: "sell", quantity: 28_000, price: 1.39 },
  ],
};

const DEMO_ALL_ACTIONS = Object.entries(DEMO_ACTIONS).flatMap(([instrumentId, actions]) =>
  (actions || []).map((action) => ({ ...action, instrumentId })),
);

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function makeDemoSeries(config: typeof DEMO_SERIES_CONFIG[number]): InvestmentInstrumentSeries {
  const lastReturn = config.strategy.at(-1)! - 100;
  const startingValue = config.marketValue - config.profit;
  const contributed = lastReturn ? round2(config.profit / (lastReturn / 100)) : startingValue;
  const rows = DEMO_DATES.map((date, index) => {
    const strategy = config.strategy[index]!;
    const market = config.market[index]!;
    const profit = lastReturn ? round2(config.profit * ((strategy - 100) / lastReturn)) : 0;
    return {
      date,
      strategy,
      market,
      profit,
      value: round2(startingValue + profit),
      passiveValue: round2(contributed * (market / 100)),
      contributed,
      price: round2(strategy / 50),
      quantity: round2((startingValue + profit) / Math.max(strategy / 50, 0.01)),
      externalFlow: index === 0 ? startingValue : 0,
      passiveUnitsPurchased: 0,
    };
  });
  const instrument = DEMO_INSTRUMENTS.find((row) => row.id === config.id)!;
  return {
    available: true,
    instrumentId: config.id,
    symbol: instrument.symbol,
    name: instrument.name,
    from: DEMO_DATES[0],
    to: DEMO_AS_OF,
    sourceLabel: "成交链与公开日线",
    rows,
    actions: DEMO_ACTIONS[config.id] || [],
    message: "",
  };
}

const DEMO_SERIES = new Map<string, InvestmentInstrumentSeries>(DEMO_SERIES_CONFIG.map((config) => [config.id, makeDemoSeries(config)]));

function makeSnapshot(date: string, factor: number): AssetSnapshot {
  const positives = [
    { category: "银行与现金", name: "日常资金账户", currency: "CNY", amount: round2(850_000 * factor), rateToCny: 1, note: "人民币" },
    { category: "银行与现金", name: "流动性管理", currency: "CNY", amount: round2(350_000 * factor), rateToCny: 1, note: "人民币" },
    { category: "证券投资", name: "国内证券账户", currency: "CNY", amount: round2(3_800_000 * factor), rateToCny: 1, note: "人民币" },
    { category: "证券投资", name: "全球ETF组合", currency: "CNY", amount: round2(2_000_000 * factor), rateToCny: 1, note: "人民币" },
    { category: "证券投资", name: "海外证券账户", currency: "CNY", amount: round2(600_000 * factor), rateToCny: 1, note: "人民币" },
    { category: "不动产", name: "住宅权益", currency: "CNY", amount: round2(3_000_000 * factor), rateToCny: 1, note: "估值" },
    { category: "其他资产", name: "应收及其他", currency: "CNY", amount: round2(150_000 * factor), rateToCny: 1, note: "人民币" },
  ].map((item) => ({ ...item, cnyValue: item.amount }));
  const liability = { category: "负债", name: "住房贷款", currency: "CNY", amount: -750_000, rateToCny: 1, cnyValue: -750_000, note: "人民币" };
  const items = [...positives, liability];
  const totalAssets = round2(positives.reduce((sum, item) => sum + item.cnyValue, 0));
  const categories = [...new Map(items.map((item) => [item.category, items.filter((row) => row.category === item.category).reduce((sum, row) => sum + row.cnyValue, 0)])).entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return { date, capturedAt: `${date} 20:00`, sheet: "功能展示", items, totalAssets, totalLiabilities: 750_000, netAssets: round2(totalAssets - 750_000), categories };
}

const DEMO_SNAPSHOTS = [
  makeSnapshot("2026-03-31", 0.93),
  makeSnapshot("2026-04-30", 0.95),
  makeSnapshot("2026-05-31", 0.965),
  makeSnapshot("2026-06-30", 0.98),
  makeSnapshot("2026-07-31", 0.992),
  makeSnapshot(DEMO_AS_OF, 1),
];

function demoExpense(id: string, day: string, name: string, amount: number, category: string, method = "银行卡"): AssetCashflowEntry {
  return {
    id,
    at: `${day} 12:00`,
    day,
    name,
    amount: -amount,
    kind: "expense",
    category,
    type: "支出",
    method,
    status: "已入账",
    note: "",
    channel: method === "移动支付" ? "alipay" : "bank",
    currency: "CNY",
  };
}

const DEMO_EXPENSE_LEDGER: Record<string, AssetCashflowEntry[]> = {
  "2026-06": [
    demoExpense("demo-202606-home", "2026-06-05", "房租与物业", 28_000, "居住"),
    demoExpense("demo-202606-grocery", "2026-06-08", "生鲜与日用品", 12_000, "吃喝", "移动支付"),
    demoExpense("demo-202606-dining", "2026-06-12", "餐厅与外卖", 7_500, "吃喝", "移动支付"),
    demoExpense("demo-202606-transit", "2026-06-14", "通勤与打车", 4_800, "出行", "移动支付"),
    demoExpense("demo-202606-utility", "2026-06-16", "电费燃气与水道", 3_400, "居住"),
    demoExpense("demo-202606-software", "2026-06-18", "ChatGPT 与软件会员", 1_800, "订阅"),
    demoExpense("demo-202606-fitness", "2026-06-20", "JOYFIT 月费", 2_400, "健康"),
    demoExpense("demo-202606-health", "2026-06-21", "门诊与药品", 2_100, "健康"),
    demoExpense("demo-202606-shopping", "2026-06-23", "衣物与家居", 4_000, "购物", "移动支付"),
    demoExpense("demo-202606-social", "2026-06-25", "礼物与聚会", 4_000, "人情"),
    demoExpense("demo-202606-travel", "2026-06-28", "周末短途旅行", 8_000, "出行"),
  ],
  "2026-07": [
    demoExpense("demo-202607-home", "2026-07-05", "房租与物业", 28_000, "居住"),
    demoExpense("demo-202607-grocery", "2026-07-07", "生鲜与日用品", 12_500, "吃喝", "移动支付"),
    demoExpense("demo-202607-dining", "2026-07-10", "餐厅与外卖", 8_000, "吃喝", "移动支付"),
    demoExpense("demo-202607-transit", "2026-07-12", "通勤与打车", 5_000, "出行", "移动支付"),
    demoExpense("demo-202607-utility", "2026-07-15", "电费燃气与水道", 3_500, "居住"),
    demoExpense("demo-202607-software", "2026-07-17", "ChatGPT 与软件会员", 1_800, "订阅"),
    demoExpense("demo-202607-fitness", "2026-07-18", "JOYFIT 月费", 2_400, "健康"),
    demoExpense("demo-202607-learning", "2026-07-20", "课程与书籍", 4_800, "学习"),
    demoExpense("demo-202607-health", "2026-07-21", "体检与保健", 2_000, "健康"),
    demoExpense("demo-202607-shopping", "2026-07-23", "衣物与家居", 4_000, "购物", "移动支付"),
    demoExpense("demo-202607-social", "2026-07-25", "礼物与聚会", 4_000, "人情"),
    demoExpense("demo-202607-travel", "2026-07-29", "周末短途旅行", 6_000, "出行"),
  ],
  "2026-08": [
    demoExpense("demo-202608-home", "2026-08-05", "房租与物业", 28_000, "居住"),
    demoExpense("demo-202608-grocery", "2026-08-07", "生鲜买菜", 12_800, "吃喝", "移动支付"),
    demoExpense("demo-202608-dining", "2026-08-09", "餐厅与外卖", 8_600, "吃喝", "移动支付"),
    demoExpense("demo-202608-transit", "2026-08-11", "通勤与打车", 5_200, "出行", "移动支付"),
    demoExpense("demo-202608-learning", "2026-08-13", "课程与书籍", 6_800, "学习"),
    demoExpense("demo-202608-fitness", "2026-08-15", "JOYFIT 月费", 2_400, "健康"),
    demoExpense("demo-202608-health", "2026-08-16", "门诊与保健", 1_500, "健康"),
    demoExpense("demo-202608-utility", "2026-08-17", "电费燃气水道与通信", 3_600, "居住"),
    demoExpense("demo-202608-software", "2026-08-18", "ChatGPT 与软件会员", 1_800, "订阅"),
    demoExpense("demo-202608-travel", "2026-08-20", "周末旅行与酒店", 14_000, "出行"),
    demoExpense("demo-202608-social", "2026-08-22", "礼物与社交", 4_500, "人情"),
    demoExpense("demo-202608-household", "2026-08-23", "家居日用", 2_800, "购物", "移动支付"),
    demoExpense("demo-202608-clothes", "2026-08-24", "衣物护理", 1_600, "购物", "移动支付"),
    demoExpense("demo-202608-culture", "2026-08-25", "电影与展览", 1_400, "娱乐", "移动支付"),
    demoExpense("demo-202608-snack", "2026-08-26", "咖啡与零食", 1_000, "吃喝", "移动支付"),
  ],
};

const DEMO_CASHFLOW: AssetCashflowData = {
  schemaVersion: 1,
  currency: "CNY",
  sourceLabel: "生活账本",
  sourceDir: "",
  sources: [],
  transactionCount: 96,
  latestMonth: "2026-08",
  years: [{ year: "2026", income: 1_040_000, expense: 612_000, neutral: 0, balance: 428_000, incomeCount: 18, expenseCount: 76, neutralCount: 0, monthCount: 8, categories: [{ name: "经营收入", amount: 720_000 }, { name: "投资现金流", amount: 320_000 }] }],
  months: [
    { month: "2026-06", income: 120_000, expense: 78_000, neutral: 0, balance: 42_000, incomeCount: 1, expenseCount: 11, neutralCount: 0, categories: [{ name: "经营收入", amount: 120_000 }, { name: "居住", amount: -31_400 }, { name: "吃喝", amount: -19_500 }, { name: "出行", amount: -12_800 }, { name: "健康", amount: -4_500 }, { name: "购物", amount: -4_000 }, { name: "人情", amount: -4_000 }, { name: "订阅", amount: -1_800 }] },
    { month: "2026-07", income: 135_000, expense: 82_000, neutral: 0, balance: 53_000, incomeCount: 1, expenseCount: 12, neutralCount: 0, categories: [{ name: "经营收入", amount: 135_000 }, { name: "居住", amount: -31_500 }, { name: "吃喝", amount: -20_500 }, { name: "出行", amount: -11_000 }, { name: "学习", amount: -4_800 }, { name: "健康", amount: -4_400 }, { name: "购物", amount: -4_000 }, { name: "人情", amount: -4_000 }, { name: "订阅", amount: -1_800 }] },
    { month: "2026-08", income: 168_000, expense: 96_000, neutral: 0, balance: 72_000, incomeCount: 2, expenseCount: 15, neutralCount: 0, categories: [{ name: "经营收入", amount: 138_000 }, { name: "投资分配", amount: 30_000 }, { name: "居住", amount: -31_600 }, { name: "吃喝", amount: -22_400 }, { name: "出行", amount: -19_200 }, { name: "学习", amount: -6_800 }, { name: "购物", amount: -4_400 }, { name: "人情", amount: -4_500 }, { name: "健康", amount: -3_900 }, { name: "订阅", amount: -1_800 }, { name: "娱乐", amount: -1_400 }] },
  ],
  trend: [
    { month: "2026-06", label: "6月", income: 120_000, expense: 78_000, balance: 42_000 },
    { month: "2026-07", label: "7月", income: 135_000, expense: 82_000, balance: 53_000 },
    { month: "2026-08", label: "8月", income: 168_000, expense: 96_000, balance: 72_000 },
  ],
  ledgerByMonth: DEMO_EXPENSE_LEDGER,
  available: true,
  message: "",
};

const DEMO_PERFORMANCE_ROWS = DEMO_SERIES_CONFIG.map((config, index) => ({
  id: `demo-performance-${index + 1}`,
  accountId: config.accountId,
  instrumentId: config.id,
  from: DEMO_DATES[0],
  to: DEMO_AS_OF,
  transactionCount: DEMO_ACTIONS[config.id]?.length || 0,
  currentPosition: true,
  quantityMatched: true,
  status: "available" as const,
  basis: "transaction-gross" as const,
  investedAmount: round2(config.marketValue - config.profit),
  endingValue: config.marketValue,
  profit: config.profit,
  returnRate: round2(config.profit / (config.marketValue - config.profit) * 10_000) / 10_000,
  currentMarketValue: config.marketValue,
  lastTradedAt: DEMO_ACTIONS[config.id]?.at(-1)?.date || DEMO_DATES[0],
  platformProfit: config.profit,
  note: "完整成交链毛收益",
}));

const DEMO_INVESTMENTS: InvestmentLedgerData = {
  schemaVersion: 1,
  baseCurrency: "CNY",
  source: { title: "投资账本", asOf: DEMO_AS_OF, path: "" },
  coverage: { status: "complete", holdingsStatus: "complete", transactionsStatus: "complete", cashFlowsStatus: "complete", from: DEMO_DATES[0], to: DEMO_AS_OF, note: "", missing: [], futureCapture: [] },
  accounts: [
    { id: "demo-account-a", label: "核心证券账户", broker: "证券账户 A", country: "中国", ownerType: "self", baseCurrency: "CNY", accountClass: "brokerage" },
    { id: "demo-account-b", label: "全球配置账户", broker: "证券账户 B", country: "中国", ownerType: "self", baseCurrency: "CNY", accountClass: "brokerage" },
    { id: "demo-account-c", label: "策略观察账户", broker: "证券账户 C", country: "中国", ownerType: "self", baseCurrency: "CNY", accountClass: "brokerage" },
  ],
  instruments: DEMO_INSTRUMENTS,
  accountSnapshots: [
    { id: "demo-snapshot-a", asOf: DEMO_AS_OF, accountId: "demo-account-a", totalAssets: 3_200_000, cash: 300_000, marketValue: 2_900_000, available: 300_000, withdrawable: 280_000, investedRatio: 0.90625, reportedPnl: 655_000, reportedPnlRate: null, reportedPnlLabel: "累计盈亏", holdingPnl: 655_000, sourceQuality: "complete", note: "" },
    { id: "demo-snapshot-b", asOf: DEMO_AS_OF, accountId: "demo-account-b", totalAssets: 2_600_000, cash: 150_000, marketValue: 2_450_000, available: 150_000, withdrawable: 135_000, investedRatio: 0.9423, reportedPnl: 380_000, reportedPnlRate: null, reportedPnlLabel: "累计盈亏", holdingPnl: 380_000, sourceQuality: "complete", note: "" },
    { id: "demo-snapshot-c", asOf: DEMO_AS_OF, accountId: "demo-account-c", totalAssets: 600_000, cash: 50_000, marketValue: 550_000, available: 50_000, withdrawable: 45_000, investedRatio: 0.9167, reportedPnl: 161_000, reportedPnlRate: null, reportedPnlLabel: "累计盈亏", holdingPnl: 161_000, sourceQuality: "complete", note: "" },
  ],
  cashFlowSummaries: [{ id: "demo-cash-bridge", accountId: "demo-account-a", range: "all", asOf: DEMO_AS_OF, initialAssets: 4_000, transferIn: 7_200_000, transferOut: 2_000_000, netInflow: 5_200_000, reportedPnl: 1_196_000, endingAssets: 6_400_000, reconciliationDifference: 0, sourceQuality: "complete", note: "全周期资金流与账户资产已对平。" }],
  transactions: DEMO_ALL_ACTIONS.map((action) => ({
    id: action.id,
    accountId: DEMO_SERIES_CONFIG.find((config) => config.id === action.instrumentId)?.accountId || "demo-account-a",
    instrumentId: action.instrumentId,
    tradedAt: `${action.date}T10:00:00+08:00`, side: action.side, quantity: action.quantity, price: action.price, currency: "CNY", grossAmount: round2(action.quantity * action.price), fees: 25, taxes: action.side === "sell" ? 50 : 0, sourceRef: "成交记录",
  })),
  positionSnapshots: DEMO_SERIES_CONFIG.map((config, index) => ({ id: `demo-position-${index + 1}`, asOf: DEMO_AS_OF, accountId: DEMO_PERFORMANCE_ROWS[index]!.accountId, instrumentId: config.id, quantity: round2(config.marketValue / 2), quantityApproximate: false, alternateReportedQuantity: null, referencePrice: 2, costPrice: round2((config.marketValue - config.profit) / (config.marketValue / 2)), marketValue: config.marketValue, reportedPnl: config.profit, reportedPnlRate: DEMO_PERFORMANCE_ROWS[index]!.returnRate, pnlBasis: "average-cost", sourceQuality: "complete", note: "" })),
  historicalInvestments: [],
  summary: {
    tradeCount: DEMO_ALL_ACTIONS.length,
    buyCount: DEMO_ALL_ACTIONS.filter((row) => row.side === "buy").length,
    sellCount: DEMO_ALL_ACTIONS.filter((row) => row.side === "sell").length,
    buyQuantity: DEMO_ALL_ACTIONS.filter((row) => row.side === "buy").reduce((sum, row) => sum + row.quantity, 0),
    sellQuantity: DEMO_ALL_ACTIONS.filter((row) => row.side === "sell").reduce((sum, row) => sum + row.quantity, 0),
    netQuantity: DEMO_ALL_ACTIONS.reduce((sum, row) => sum + (row.side === "buy" ? row.quantity : -row.quantity), 0),
    buyGross: DEMO_ALL_ACTIONS.filter((row) => row.side === "buy").reduce((sum, row) => sum + row.quantity * row.price, 0),
    sellGross: DEMO_ALL_ACTIONS.filter((row) => row.side === "sell").reduce((sum, row) => sum + row.quantity * row.price, 0),
    feesKnown: true,
    taxesKnown: true,
  },
  reconciliations: DEMO_SERIES_CONFIG.map((config, index) => ({ accountId: DEMO_PERFORMANCE_ROWS[index]!.accountId, instrumentId: config.id, asOf: DEMO_AS_OF, coveredNetQuantity: 1, reportedQuantity: 1, openingOrMissingQuantity: 0, status: "matched" })),
  accountReconciliations: [
    { accountId: "demo-account-a", asOf: DEMO_AS_OF, reportedMarketValue: 2_900_000, positionMarketValue: 2_900_000, marketValueDifference: 0, reportedPnl: 655_000, positionReportedPnl: 655_000, pnlDifference: 0, status: "matched" },
    { accountId: "demo-account-b", asOf: DEMO_AS_OF, reportedMarketValue: 2_450_000, positionMarketValue: 2_450_000, marketValueDifference: 0, reportedPnl: 380_000, positionReportedPnl: 380_000, pnlDifference: 0, status: "matched" },
    { accountId: "demo-account-c", asOf: DEMO_AS_OF, reportedMarketValue: 550_000, positionMarketValue: 550_000, marketValueDifference: 0, reportedPnl: 161_000, positionReportedPnl: 161_000, pnlDifference: 0, status: "matched" },
  ],
  portfolio: { asOf: DEMO_AS_OF, totalAssets: 6_400_000, cash: 500_000, marketValue: 5_900_000, investedRatio: 0.921875, accountCount: 3, positionCount: 10, reconciledAccountCount: 3, largestPositionId: "DEMO.CN.300", largestPositionWeight: 1_350_000 / 5_900_000, exposures: [{ name: "中国股票", value: 3_450_000, weight: 3_450_000 / 5_900_000 }, { name: "美国股票", value: 1_100_000, weight: 1_100_000 / 5_900_000 }, { name: "日本股票", value: 300_000, weight: 300_000 / 5_900_000 }, { name: "黄金", value: 550_000, weight: 550_000 / 5_900_000 }, { name: "债券", value: 500_000, weight: 500_000 / 5_900_000 }] },
  performance: { from: DEMO_DATES[0], to: DEMO_AS_OF, availableCount: DEMO_PERFORMANCE_ROWS.length, rows: DEMO_PERFORMANCE_ROWS, accountReturns: [{ accountId: "demo-account-a", asOf: DEMO_AS_OF, rate: 0.257, basis: "current-holdings", note: "" }, { accountId: "demo-account-b", asOf: DEMO_AS_OF, rate: 0.184, basis: "current-holdings", note: "" }, { accountId: "demo-account-c", asOf: DEMO_AS_OF, rate: 0.367, basis: "current-holdings", note: "" }] },
  returns: { available: true, reasons: [] },
  marketEvidence: { asOf: DEMO_AS_OF, sources: [{ id: "demo-market", label: "公开行情日线", kind: "market", url: "", retrievedAt: DEMO_AS_OF }], series: [] },
  analysis: { asOf: DEMO_AS_OF, available: true, episodes: [], officialBenchmarks: [] },
  warnings: [],
  available: true,
  message: "",
};

export const ASSET_DISPLAY_DEMO: AssetVaultData = {
  schemaVersion: 1,
  source: { title: "资产管理", url: "", googleUpdatedAt: DEMO_AS_OF, syncedAt: DEMO_AS_OF, path: "" },
  fx: { stableJpyToCny: 0.047, stableNote: "固定展示汇率", liveJpyToCny: null, liveUpdatedAt: null, liveAvailable: false },
  snapshots: DEMO_SNAPSHOTS,
  trend: DEMO_SNAPSHOTS.map((snapshot) => ({ date: snapshot.date, netAssets: snapshot.netAssets })),
  sessionExpiresAt: null,
  openAccess: true,
  cashflow: DEMO_CASHFLOW,
  investments: DEMO_INVESTMENTS,
  fixedExpenses: {
    schemaVersion: 1,
    updatedAt: DEMO_AS_OF,
    note: "",
    path: "",
    items: [
      { id: "demo-home", name: "房租与物业", kind: "monthly", group: "living", subgroup: "living_cost", amount: 28_000, currency: "CNY", status: "持续", dueDay: 5 },
      { id: "demo-electric", name: "家庭电费", kind: "monthly", group: "living", subgroup: "living_cost", amount: 1_400, currency: "CNY", status: "持续", dueDay: 15 },
      { id: "demo-gas", name: "家庭燃气", kind: "monthly", group: "living", subgroup: "living_cost", amount: 700, currency: "CNY", status: "持续", dueDay: 16 },
      { id: "demo-water", name: "水道", kind: "monthly", group: "living", subgroup: "living_cost", amount: 600, currency: "CNY", status: "持续", dueDay: 17 },
      { id: "demo-chatgpt", name: "ChatGPT Plus", kind: "monthly", group: "living", subgroup: "subscription", amount: 140, currency: "CNY", status: "持续", dueDay: 18 },
      { id: "demo-fitness", name: "JOYFIT 月费", kind: "monthly", group: "living", subgroup: "deduction", amount: 2_400, currency: "CNY", status: "持续", dueDay: 20 },
    ],
    available: true,
    message: "",
  },
  bankIncome: {
    schemaVersion: 1,
    updatedAt: DEMO_AS_OF,
    note: "",
    path: "",
    available: true,
    message: "",
    sourceAccount: { bank: "银行账户", last4: "0000" },
    incomeItems: [
      { id: "demo-bank-income-202606", categoryKey: "business", categoryLabel: "经营收入", date: "2026-06-06", amount: 120_000, currency: "CNY", counterparty: "项目月度结算" },
      { id: "demo-bank-income-202607", categoryKey: "business", categoryLabel: "经营收入", date: "2026-07-06", amount: 135_000, currency: "CNY", counterparty: "项目月度结算" },
      { id: "demo-bank-income-202608", categoryKey: "business", categoryLabel: "经营收入", date: "2026-08-05", amount: 138_000, currency: "CNY", counterparty: "项目月度结算" },
      { id: "demo-bank-income-investment", categoryKey: "investment", categoryLabel: "投资现金流", date: "2026-08-18", amount: 30_000, currency: "CNY", counterparty: "投资分配" },
    ],
  },
};

export function readAssetDisplayDemoSeries(instrumentId: string): InvestmentInstrumentSeries {
  return DEMO_SERIES.get(instrumentId) || { available: false, instrumentId, message: "这项资产没有可展示的曲线。" };
}

export function readAssetDisplayDemoPerformance(from = "", to = DEMO_AS_OF): InvestmentPeriodPerformance {
  const start = from || DEMO_DATES[0];
  const rows = DEMO_SERIES_CONFIG.flatMap((config, index) => {
    const series = DEMO_SERIES.get(config.id)?.rows || [];
    const firstIndex = series.findIndex((row) => row.date >= start && row.date <= to);
    if (firstIndex < 0) return [];
    const selected = series.slice(firstIndex).filter((row) => row.date <= to);
    const last = selected.at(-1);
    if (!last) return [];
    const baseline = firstIndex > 0 ? series[firstIndex - 1]! : { strategy: 100, market: 100, profit: 0 };
    const returnRate = baseline.strategy && last.strategy !== null ? last.strategy / baseline.strategy - 1 : null;
    const marketReturn = baseline.market && last.market !== null ? last.market / baseline.market - 1 : null;
    const profit = round2(last.profit - baseline.profit);
    const operationDifference = returnRate !== null && marketReturn !== null ? returnRate - marketReturn : null;
    const passiveValue = operationDifference === null ? null : round2(last.value / Math.max(0.1, 1 + operationDifference));
    return [{
      id: `demo-period-${config.id}-${start}-${to}`,
      accountId: DEMO_PERFORMANCE_ROWS[index]!.accountId,
      instrumentId: config.id,
      from: selected[0]!.date,
      to: last.date,
      currentPosition: true,
      currentMarketValue: config.marketValue,
      lastTradedAt: DEMO_PERFORMANCE_ROWS[index]!.lastTradedAt,
      transactionCount: DEMO_PERFORMANCE_ROWS[index]!.transactionCount,
      status: "available" as const,
      basis: "period-strategy" as const,
      profit,
      returnRate,
      marketReturn,
      operationDifference,
      operationProfit: passiveValue === null ? null : round2(last.value - passiveValue),
      passiveValue,
      endingValue: last.value,
      contributionRate: null as number | null,
      note: "成交链区间毛收益",
    }];
  });
  const totalProfit = round2(rows.reduce((sum, row) => sum + (row.profit || 0), 0));
  for (const row of rows) row.contributionRate = totalProfit ? (row.profit || 0) / totalProfit : null;
  return {
    available: rows.length > 0,
    from: rows[0]?.from || start,
    to: rows[0]?.to || to,
    sourceLabel: "成交链与公开日线",
    summary: { totalCount: rows.length, availableCount: rows.length, positiveCount: rows.filter((row) => (row.profit || 0) > 0).length, negativeCount: rows.filter((row) => (row.profit || 0) < 0).length, totalProfit },
    rows,
    message: rows.length ? "" : "所选区间没有投资记录。",
  };
}
