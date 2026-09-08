import assert from "node:assert/strict";
import test from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyCustodyOverlayToSnapshot,
  buildSunxiangInvestmentExtension,
  custodyOverlayItems,
  isSunxiangHoldingsFileName,
  parseConfirmedTradeMemoMarkdown,
  readSunxiangCustody,
} from "../src/server/workbench-sunxiang-custody.mjs";

test("sunxiang holdings filename pattern", () => {
  assert.equal(isSunxiangHoldingsFileName("黄总美股管理.xlsx"), true);
  assert.equal(isSunxiangHoldingsFileName("黄总美股管理 (1).xlsx"), true);
  assert.equal(isSunxiangHoldingsFileName("个人资产记录.xlsx"), false);
});

test("reads real vault sunxiang holdings workbook", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const custody = await readSunxiangCustody(root, { force: true });
  assert.equal(custody.available, true);
  assert.ok((custody.usStocks?.amountJpy ?? 0) > 4_000_000);
  assert.equal(Math.round(custody.funds?.amountJpy ?? 0), 1652399);
  assert.equal(Math.round(custody.receivableCny ?? 0), 82017);
  assert.ok((custody.income?.gainJpy ?? 0) > 0);
  assert.equal(custody.overlayItems?.length, 3);
  assert.equal(custody.holdings?.us?.length, 5);
  assert.ok((custody.holdings?.accountCashJpy ?? 0) > 0);
});

test("confirmed custody trades adjust stale workbook positions without fabricating cost basis", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const [custody, memo] = await Promise.all([
    readSunxiangCustody(root, { force: true }),
    fsp.readFile(path.join(root, "20_个人档案/个人资产/个人交易备忘.md"), "utf8"),
  ]);
  const trades = parseConfirmedTradeMemoMarkdown(memo);
  const extension = buildSunxiangInvestmentExtension(custody, trades);
  assert.equal(trades.length, 2);
  assert.equal(extension.transactions.length, 4);
  assert.ok(extension.transactions.every((row) => row.currency !== "USD" || (row.performanceGrossAmountCny ?? 0) > row.grossAmount));
  assert.deepEqual(
    extension.transactions.filter((row) => row.instrumentId === "US.NASDAQ.NVDA" && row.side === "buy").map((row) => row.tradedAt.slice(0, 10)),
    ["2025-01-28", "2025-01-28"],
  );
  assert.equal(extension.accounts[0].id, "jp-sbi-custody-sunxiang");
  assert.equal(extension.positionSnapshots.some((row) => row.instrumentId === "US.NASDAQ.GOOGL"), false);
  const nvda = extension.positionSnapshots.find((row) => row.instrumentId === "US.NASDAQ.NVDA");
  assert.equal(nvda.quantity, 10);
  assert.equal(nvda.reportedPnlRate, null);
  assert.match(nvda.note, /剩余批次成本待今后券商明细/);
  assert.equal(extension.positionSnapshots.some((row) => row.instrumentId === "JP.CUSTODY.NIKKEI"), true);
  assert.equal(extension.positionSnapshots.some((row) => row.instrumentId === "JP.CUSTODY.NISA"), true);
  assert.ok(extension.accountSnapshots[0].cash > 0);
});

test("overlay replaces june custody lines on a snapshot", () => {
  const snapshot = {
    date: "2026-06-10",
    sheet: "20260610",
    items: [
      { category: "委托资产", name: "美股投资（由孙翔代持）", currency: "JPY", amount: 1, rateToCny: 0.047, cnyValue: 1, note: "" },
      { category: "委托资产", name: "基金产品（由孙翔代持）", currency: "JPY", amount: 1, rateToCny: 0.047, cnyValue: 1, note: "" },
      { category: "债权资产", name: "孙翔借款（应收账款）", currency: "CNY", amount: 1, rateToCny: 1, cnyValue: 1, note: "" },
      { category: "银行存款", name: "测试", currency: "CNY", amount: 100, rateToCny: 1, cnyValue: 100, note: "" },
    ],
    totalAssets: 103,
    totalLiabilities: 0,
    netAssets: 103,
    categories: [],
  };
  const parsed = {
    usStocks: { amountJpy: 4365408.473, costJpy: 3933151, gainJpy: 432257, yield: 0.1, cnyValue: 186000 },
    funds: { amountJpy: 1652399.43, costJpy: 1089055, gainJpy: 563344, yield: 0.5, cnyValue: 71000 },
    receivableCny: 82017,
    impliedJpyToCny: 0.0428,
  };
  const next = applyCustodyOverlayToSnapshot(snapshot, parsed);
  assert.equal(next.custodyOverlaid, true);
  assert.equal(next.items.filter((item) => item.name.includes("美股")).at(0)?.amount, 4365408.47);
  assert.equal(next.items.some((item) => item.name === "测试"), true);
  assert.equal(custodyOverlayItems(parsed).length, 3);
});

test("prefers newer downloads copy when present", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "infans-custody-"));
  const downloads = path.join(root, "Downloads");
  const vaultDir = path.join(root, "20_个人档案/个人资产");
  await fsp.mkdir(downloads, { recursive: true });
  await fsp.mkdir(vaultDir, { recursive: true });
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const real = path.resolve(import.meta.dirname, "../../../20_个人档案/个人资产/孙翔代持_黄总美股管理.xlsx");
  const workbook = await fsp.readFile(real);
  const vaultFile = path.join(vaultDir, "孙翔代持_黄总美股管理.xlsx");
  const downloadFile = path.join(downloads, "黄总美股管理.xlsx");
  // copyFile 在 APFS 上会保留源文件 birthtime，不能用来构造“后创建的下载副本”。
  await fsp.writeFile(vaultFile, workbook);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fsp.writeFile(downloadFile, workbook);
  const [vaultStat, downloadStat] = await Promise.all([fsp.stat(vaultFile), fsp.stat(downloadFile)]);
  assert.ok(downloadStat.birthtimeMs > vaultStat.birthtimeMs, "测试夹具必须让下载副本的创建时间更新");

  const custody = await readSunxiangCustody(root, { force: true, downloadsDir: downloads });
  assert.equal(custody.available, true);
  assert.equal(custody.source?.location, "downloads");
  assert.equal(custody.source?.name, "黄总美股管理.xlsx");
});
