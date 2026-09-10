import assert from "node:assert/strict";
import test from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  categorizeWechatRow,
  formatFileCreatedAt,
  friendlyBillDisplayName,
  isAlipayBillFileName,
  isPayPayBillFileName,
  isWechatBillFileName,
  listBillDownloadCandidates,
  pickLatestDownloadBill,
  readWechatCashflow,
  resolveCashflowKind,
} from "../src/server/workbench-wechat-bills.mjs";

test("wechat category heuristics cover common life spend", () => {
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "サミットストア", product: "妙法寺前店", direction: "支出" }),
    "吃喝",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "ファミリーマート", product: "東高円寺", direction: "支出" }),
    "吃喝",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "中铁网络", product: "12306消费", direction: "支出" }),
    "出行",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "京东", product: "订单", direction: "支出" }),
    "购物",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "株式会社ニトリ", product: "新宿店", direction: "支出" }),
    "购物",
  );
  assert.equal(
    categorizeWechatRow({ type: "微信红包", counterparty: "朋友", product: "/", direction: "收入" }),
    "人情",
  );
  assert.equal(
    categorizeWechatRow({ type: "支払い", counterparty: "TOHOシネマズ", product: "/", direction: "支出", channel: "paypay" }),
    "娱乐",
  );
  assert.equal(
    categorizeWechatRow({ type: "支払い", counterparty: "チケットぴあ", product: "/", direction: "支出", channel: "paypay" }),
    "娱乐",
  );
  assert.equal(
    categorizeWechatRow({ type: "零钱提现", counterparty: "示例银行", product: "/", direction: "/" }),
    "资金划转",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "示例菜馆", product: "/", direction: "支出" }),
    "吃喝",
  );
  assert.equal(
    categorizeWechatRow({ type: "扫二维码付款", counterparty: "示例店甲", product: "/", direction: "支出" }),
    "待确认",
  );
  assert.equal(
    categorizeWechatRow({ type: "支払い", counterparty: "示例店乙", product: "/", direction: "支出", channel: "paypay" }),
    "待确认",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "Apple", product: "apple.com/bill", direction: "支出" }),
    "订阅",
  );
  assert.equal(
    categorizeWechatRow({
      type: "在线支付",
      counterparty: "Stripe Inc",
      product: "Cursor",
      direction: "支出",
      channel: "alipay",
    }),
    "公司支出",
  );
  assert.equal(
    categorizeWechatRow({
      type: "商户消费",
      counterparty: "Valve",
      product: "Steam Purchase 123",
      direction: "支出",
    }),
    "游戏",
  );
  assert.equal(
    categorizeWechatRow({ type: "美团平台商户-退款", counterparty: "美团", product: "退款", direction: "收入" }),
    "退款",
  );
  assert.equal(
    categorizeWechatRow({
      type: "转账",
      counterparty: "示例好友甲",
      product: "还款",
      note: "还我的钱",
      direction: "收入",
      channel: "alipay",
    }),
    "债权回收",
  );
  assert.equal(
    resolveCashflowKind("income", "债权回收"),
    "neutral",
  );
  assert.equal(
    categorizeWechatRow({
      type: "转账",
      counterparty: "示例好友乙",
      product: "转账备注:帮朋友代买",
      direction: "收入",
      channel: "wechat",
    }),
    "代收代付",
  );
  assert.equal(resolveCashflowKind("income", "代收代付"), "neutral");
  assert.equal(
    categorizeWechatRow({ type: "收费", counterparty: "支付宝", product: "提现手续费", direction: "支出", channel: "alipay" }),
    "手续费",
  );
  assert.equal(
    categorizeWechatRow({
      type: "支払い",
      counterparty: "オクトパスエナジー",
      product: "PayPayカード",
      direction: "支出",
      channel: "paypay",
    }),
    "居住",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "湘遇 池袋店", product: "/", direction: "支出" }),
    "吃喝",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "マルエツ", product: "/", direction: "支出" }),
    "吃喝",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "ゼッテリア新宿小田急エース店", product: "/", direction: "支出" }),
    "吃喝",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "渋谷パルコ", product: "/", direction: "支出" }),
    "购物",
  );
  assert.equal(
    categorizeWechatRow({ type: "其他", counterparty: "剪映服务", product: "会员", direction: "支出", channel: "alipay" }),
    "订阅",
  );
  assert.equal(
    categorizeWechatRow({ type: "日用百货", counterparty: "某店", product: "日用品", direction: "支出", channel: "alipay" }),
    "购物",
  );
  assert.equal(
    categorizeWechatRow({ type: "文化休闲", counterparty: "百度网盘", product: "超级会员", direction: "支出", channel: "alipay" }),
    "订阅",
  );
  assert.equal(
    categorizeWechatRow({ type: "其他", counterparty: "グランパ東高円寺", product: "/", direction: "支出", channel: "alipay" }),
    "吃喝",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "熊だ", product: "/", direction: "支出" }),
    "吃喝",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "株式会社Ａｍｐｕｓ", product: "/", direction: "支出" }),
    "购物",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "Ｇｏｔｃｈａ Ｊａｐａｎ株式会社", product: "/", direction: "支出" }),
    "吃喝",
  );
  assert.equal(
    categorizeWechatRow({ type: "商户消费", counterparty: "杭州深度求索", product: "/", direction: "支出" }),
    "订阅",
  );
});

test("friendly bill names unify Apple and Steam", () => {
  assert.equal(
    friendlyBillDisplayName({
      counterparty: "Valve",
      product: "Steam Purchase 1710000126691686",
    }),
    "Steam",
  );
  assert.equal(
    friendlyBillDisplayName({
      counterparty: "Apple",
      product: "apple.com/bill/MQQ7HFKJ5La0",
    }),
    "Apple",
  );
  assert.equal(
    friendlyBillDisplayName({
      counterparty: "ファミリーマート",
      product: "杉並堀ノ内三丁目",
    }),
    "全家 FamilyMart",
  );
  assert.equal(
    friendlyBillDisplayName({
      counterparty: "Appleサービス",
      product: "",
      channel: "paypay",
    }),
    "Apple",
  );
  assert.equal(
    friendlyBillDisplayName({
      counterparty: "らあめん花月嵐 - らあめん花月嵐東高円寺店",
      product: "",
      method: "クレジット VISA 5518",
      channel: "paypay",
    }),
    "花月岚拉面",
  );
  assert.equal(
    friendlyBillDisplayName({
      counterparty: "Stripe Inc",
      product: "STRIPE",
      channel: "alipay",
    }),
    "Cursor",
  );
});

test("alipay bill file name pattern", () => {
  assert.equal(isAlipayBillFileName("支付宝交易明细(20251231-20260731).csv"), true);
  assert.equal(isAlipayBillFileName("Transactions_20260118-20260806.csv"), false);
});

test("bill download file name patterns", () => {
  assert.equal(isWechatBillFileName("微信支付账单流水文件(20251231-20260731)_20260806155723.xlsx"), true);
  assert.equal(isWechatBillFileName("usage-events-2026-08-04.csv"), false);
  assert.equal(isPayPayBillFileName("Transactions_20260118-20260806.csv"), true);
  assert.equal(isPayPayBillFileName("Transactions_20260118-20260806 (1).csv"), true);
  assert.equal(isPayPayBillFileName("usage-events-2026-08-04.csv"), false);
});

test("formatFileCreatedAt is second-precise in Tokyo", () => {
  const stamped = formatFileCreatedAt({ birthtimeMs: Date.parse("2026-08-06T08:30:50.123Z"), mtimeMs: 0 });
  assert.equal(stamped.createdAt, "2026-08-06 17:30:50");
  assert.equal(stamped.createdAtKind, "birthtime");
});

test("manual cash ledger joins monthly cashflow without pretending to be PayPay", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "infans-cash-ledger-"));
  const billsDir = path.join(root, "80_生活事务", "生活账单");
  const downloadsDir = path.join(root, "Downloads");
  await fsp.mkdir(billsDir, { recursive: true });
  await fsp.mkdir(downloadsDir, { recursive: true });
  await fsp.writeFile(path.join(billsDir, "现金账务明细.json"), JSON.stringify({
    source: "现金账务明细",
    currency: "JPY",
    rows: [{
      at: "2026-08-24 17:23:00",
      txnId: "cash-20260824-hanamasa-5223",
      type: "现金消费",
      amount: -5223,
      counterparty: "肉のハナマサ 中野店",
      product: "卤菜食材",
      method: "现金",
      category: "吃喝",
    }],
  }));
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));

  const result = await readWechatCashflow(root, { downloadsDir, force: true });
  assert.equal(result.sourceLabel, "现金");
  assert.equal(result.latestMonth, "2026-08");
  assert.equal(result.months[0].expenseJpy, 5223);
  assert.equal(result.ledgerByMonth["2026-08"][0].channel, "cash");
  assert.equal(result.ledgerByMonth["2026-08"][0].method, "现金");
});

test("picks newest PayPay CSV from Downloads by creation time", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "infans-bills-dl-"));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const older = path.join(dir, "Transactions_20260101-20260201.csv");
  const newer = path.join(dir, "Transactions_20260301-20260401.csv");
  await fsp.writeFile(older, "取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号\n");
  await fsp.writeFile(newer, "取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号\n");
  const oldTime = new Date("2026-03-01T00:00:00+09:00");
  const newTime = new Date("2026-08-06T17:30:50+09:00");
  await fsp.utimes(older, oldTime, oldTime);
  await fsp.utimes(newer, newTime, newTime);

  const candidates = await listBillDownloadCandidates(dir);
  const pick = pickLatestDownloadBill(candidates.paypay);
  assert.equal(pick?.name, "Transactions_20260301-20260401.csv");
  assert.match(pick?.createdAt ?? "", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
