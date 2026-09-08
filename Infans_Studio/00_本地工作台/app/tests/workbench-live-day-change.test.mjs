import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJpyCnyTrend,
  buildHomeHoldingQuoteRequests,
  dayChangeFromDailyCloses,
  HOME_STOCK_WATCHLIST,
} from "../src/server/workbench-live.mjs";

test("最近两周汇率趋势只保留同日真实交叉盘并按最新日回看 14 天", () => {
  const usdCny = [
    { date: "2026-08-20", value: 7.10 },
    { date: "2026-08-25", value: 7.12 },
    { date: "2026-09-01", value: 7.14 },
    { date: "2026-09-05", value: 7.15 },
  ];
  const usdJpy = [
    { date: "2026-08-20", value: 150 },
    { date: "2026-08-25", value: 151 },
    { date: "2026-09-01", value: 152 },
    { date: "2026-09-05", value: 153 },
  ];

  assert.deepEqual(buildJpyCnyTrend(usdCny, usdJpy), [
    { date: "2026-08-25", value: 0.04715 },
    { date: "2026-09-01", value: 0.04697 },
    { date: "2026-09-05", value: 0.04673 },
  ]);
});

test("首页观察清单保持本人指定顺序并把 SpaceX 接到上市代码 SPCX", () => {
  assert.deepEqual(HOME_STOCK_WATCHLIST.map((item) => item.symbol), [
    "^IXIC", "NVDA", "SPCX", "GOOGL", "AAPL", "MSFT", "AMAT",
  ]);
  assert.equal(HOME_STOCK_WATCHLIST.find((item) => item.symbol === "SPCX")?.label, "SpaceX");
});

test("首页光大持仓使用中文简称，只派生最新标的身份，不泄露账户财务字段", () => {
  const rows = buildHomeHoldingQuoteRequests({
    instruments: [
      { id: "CN.SH.513850", symbol: "513850", name: "美国50ETF易方达", exchange: "SSE", listingCurrency: "CNY" },
      { id: "CN.SZ.159509", symbol: "159509", name: "纳指科技ETF景顺", exchange: "SZSE", listingCurrency: "CNY" },
    ],
    positionSnapshots: [
      { accountId: "cn-ebscn-self-3897", instrumentId: "CN.SH.513850", asOf: "2026-08-26", quantity: 700, costPrice: 1.3 },
      { accountId: "cn-ebscn-self-3897", instrumentId: "CN.SH.513850", asOf: "2026-08-27", quantity: 700, costPrice: 1.3 },
      { accountId: "cn-ebscn-self-3897", instrumentId: "CN.SZ.159509", asOf: "2026-08-27", quantity: 100, reportedPnl: 53075 },
      { accountId: "someone-else", instrumentId: "CN.SH.513850", asOf: "2026-08-28", quantity: 9000 },
    ],
  });

  assert.deepEqual(rows, [
    { quoteSymbol: "513850.SS", symbol: "513850", label: "美国50ETF易方达", name: "美国50ETF易方达", currency: "CNY" },
    { quoteSymbol: "159509.SZ", symbol: "159509", label: "纳指科技ETF景顺", name: "纳指科技ETF景顺", currency: "CNY" },
  ]);
  for (const row of rows) {
    for (const field of ["quantity", "costPrice", "reportedPnl", "marketValue", "accountId"]) {
      assert.equal(Object.hasOwn(row, field), false);
    }
  }
});

test("dayChangeFromDailyCloses uses prior daily close, not a skipped session", () => {
  // 复现 2026-08-06 看板事故：NVDA 收 219.22，上一交易日 211.94；
  // Yahoo chartPreviousClose 曾误给 206.64（再前一日），算出假 +6.09%。
  const closes = [200.75, 206.64, 211.94, 219.22];
  const result = dayChangeFromDailyCloses(219.22, closes);
  assert.equal(result.previousClose, 211.94);
  assert.ok(Math.abs(result.changePercent - 3.434) < 0.01);
});

test("dayChangeFromDailyCloses matches Aug 5 index session vs Aug 4", () => {
  const nasdaq = dayChangeFromDailyCloses(26363.44, [25373.85, 25913.9, 26584.99, 26363.44]);
  assert.equal(nasdaq.previousClose, 26584.99);
  assert.ok(Math.abs(nasdaq.changePercent - (-0.833)) < 0.01);

  const sox = dayChangeFromDailyCloses(12008.883, [11311.08, 11430.35, 12179.26, 12008.883]);
  assert.equal(sox.previousClose, 12179.26);
  assert.ok(Math.abs(sox.changePercent - (-1.399)) < 0.01);
});

test("dayChangeFromDailyCloses ignores null gaps in close series", () => {
  const result = dayChangeFromDailyCloses(100, [90, null, 95, null, 100]);
  assert.equal(result.previousClose, 95);
  assert.ok(Math.abs(result.changePercent - (100 - 95) / 95 * 100) < 1e-9);
});

test("dayChangeFromDailyCloses returns nulls when fewer than two closes", () => {
  assert.deepEqual(dayChangeFromDailyCloses(100, [100]), {
    change: null,
    changePercent: null,
    previousClose: null,
  });
  assert.deepEqual(dayChangeFromDailyCloses(null, [90, 100]), {
    change: null,
    changePercent: null,
    previousClose: 90,
  });
});
