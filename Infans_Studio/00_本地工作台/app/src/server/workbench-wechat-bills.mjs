import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureInside } from "./workbench-data.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { OPENPYXL_BOOTSTRAP, pythonEnv, resolvePython3, runPythonScript } from "./workbench-python.mjs";
import { WECHAT_BILLS_DIR } from "./vault-paths.mjs";

const execFileAsync = promisify(execFile);

/** @type {{ key: string, data: object } | null} */
let cache = null;

const WECHAT_DOWNLOAD_NAME = /^微信支付账单流水文件.+\.xlsx$/i;
const PAYPAY_DOWNLOAD_NAME = /^Transactions_\d{8}-\d{8}(?: \(\d+\))?\.csv$/i;
const CASH_LEDGER_NAME = /^现金账务明细.*\.json$/i;

const PYTHON_PARSE = `
import json, sys
from pathlib import Path
${OPENPYXL_BOOTSTRAP}

path = Path(sys.argv[1])
wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
ws = wb.active
header = False
rows = []
meta = {"title": "", "nickname": "", "range": "", "exportedAt": "", "summaryLine": ""}
for row in ws.iter_rows(values_only=True):
    vals = list(row)
    first = "" if vals[0] is None else str(vals[0]).strip()
    if not header:
        if first.startswith("微信支付账单明细") and "列表" not in first:
            meta["title"] = first
        elif first.startswith("微信昵称："):
            meta["nickname"] = first
        elif first.startswith("起始时间："):
            meta["range"] = first
        elif first.startswith("导出时间："):
            meta["exportedAt"] = first
        elif first.startswith("共") and "笔记录" in first:
            meta["summaryLine"] = first
        if first == "交易时间":
            header = True
        continue
    if not first:
        continue
    amount_raw = vals[5]
    try:
        amount = float(str(amount_raw).replace("¥", "").replace(",", "").strip() or 0)
    except Exception:
        amount = 0.0
    rows.append({
        "at": first,
        "type": "" if vals[1] is None else str(vals[1]),
        "counterparty": "" if vals[2] is None else str(vals[2]),
        "product": "" if vals[3] is None else str(vals[3]),
        "direction": "" if vals[4] is None else str(vals[4]),
        "amount": amount,
        "method": "" if vals[6] is None else str(vals[6]),
        "status": "" if vals[7] is None else str(vals[7]),
        "txnId": "" if vals[8] is None else str(vals[8]),
        "merchantId": "" if vals[9] is None else str(vals[9]),
        "note": "" if len(vals) < 11 or vals[10] is None else str(vals[10]),
    })
wb.close()
print(json.dumps({"meta": meta, "rows": rows}, ensure_ascii=False))
`;

function safeText(value, max = 120) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function directionKind(direction) {
  const value = String(direction ?? "").trim();
  if (value === "收入") return "income";
  if (value === "支出") return "expense";
  return "neutral";
}

/** 不算进账、也不算花销（钱只是挪窝或代收代付）。 */
const NEUTRAL_CATEGORIES = new Set(["债权回收", "还款入账", "代收代付", "资金划转"]);

/**
 * 按分类纠正收/支方向：还款、代买回款等账单上写「收入」也不进收入合计。
 * @param {"income"|"expense"|"neutral"|string} kind
 * @param {string} category
 */
export function resolveCashflowKind(kind, category) {
  if (NEUTRAL_CATEGORIES.has(category)) return "neutral";
  if (kind === "income" || kind === "expense" || kind === "neutral") return kind;
  return "neutral";
}

function rowQualityScore(row) {
  const blob = `${row.counterparty || ""} ${row.product || ""} ${row.note || ""} ${row.name || ""} ${row.category || ""}`;
  let score = 0;
  if (row.note) score += 3;
  if (row.counterparty && row.counterparty !== "/" && String(row.counterparty).length > 1) score += 2;
  if (/还款|代买|代付|帮买|帮付|借款/.test(blob)) score += 6;
  if (String(row.txnId || row.id || "").startsWith("alipay-")) score += 2;
  if (row.category === "债权回收" || row.category === "代收代付") score += 4;
  return score;
}

function parseAtMs(at) {
  const raw = String(at || "").trim();
  const t = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
  return Number.isFinite(t) ? t : NaN;
}

/** 支付宝 CSV 与手录 JSON 常会重复同一笔；60 秒内同额同渠道只留信息更全的一条。 */
function collapseNearDuplicateFlows(flows) {
  const sorted = [...flows].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  /** @type {typeof flows} */
  const out = [];
  for (const flow of sorted) {
    if (flow.channel !== "alipay") {
      out.push(flow);
      continue;
    }
    const ms = parseAtMs(flow.at);
    const dupIndex = out.findIndex((other) => {
      if (other.channel !== "alipay") return false;
      if (other.amount !== flow.amount || other.currency !== flow.currency) return false;
      const oms = parseAtMs(other.at);
      return Number.isFinite(ms) && Number.isFinite(oms) && Math.abs(ms - oms) <= 60_000;
    });
    if (dupIndex < 0) {
      out.push(flow);
      continue;
    }
    if (rowQualityScore(flow) > rowQualityScore(out[dupIndex])) out[dupIndex] = flow;
  }
  return out;
}

/**
 * 生活向分类：微信 / 支付宝 / PayPay 共用。
 * 花哪了大类：居住、吃喝、娱乐、订阅、游戏、健康、购物、出行、学习、人情、还款、公司支出。
 * 不进花哪了：资金划转、代收代付、债权回收。
 * 认不出的进待确认，不再用其他或当面扫码。
 */
export function categorizeWechatRow(row) {
  const type = safeText(row.type, 80).normalize("NFKC");
  const blob = `${row.counterparty ?? ""} ${row.product ?? ""} ${type} ${row.note ?? ""}`.normalize("NFKC");
  const channel = safeText(row.channel, 20);
  const typeAndDirection = `${type} ${row.direction || ""}`;

  if (/代买|代付|帮买|帮付|墊付|垫付/.test(blob)) return "代收代付";
  if (/还款|还我的钱/.test(blob) && /转账|收入/.test(typeAndDirection)) {
    return "债权回收";
  }
  if (/闪电贷|信用卡还款/.test(blob)) return "还款";
  if (/提现/.test(type) || /零钱提现|提现/.test(blob)) {
    return /手续费/.test(blob) ? "手续费" : "资金划转";
  }

  if (channel === "alipay" || /支付宝/.test(blob)) {
    if (/收费|手续费/.test(type) || /手续费/.test(blob)) return "手续费";
    if (/退款/.test(type) || /退款/.test(blob)) return "退款";
    if (/Stripe|Anysphere|Cursor/i.test(blob)) return "公司支出";
    if (/OpenAI|ChatGPT|剪映|CapCut|百度网盘|深度求索|DeepSeek/i.test(blob)) return "订阅";
    if (/转账/.test(type) && /还款/.test(blob)) return "债权回收";
    if (/转账|红包/.test(type) || /转账红包/.test(blob)) return "人情";
    if (/住房物业|物业费/.test(type)) return "居住";
    if (/日用百货|服饰装扮|数码电器|运动户外|母婴亲子|家居家装/.test(type)) return "购物";
    if (/美容美发|医疗健康/.test(type)) return "健康";
    if (/文化休闲/.test(type)) return "购物";
  }

  if (channel === "paypay") {
    if (/ポイント|残高の獲得/.test(type)) return "退款";
    if (/チャージ/.test(type)) return "资金划转";
    if (/送った金額|受け取った金額/.test(type)) return "人情";
  }

  if (/红包|转账|群收款|赞赏码/.test(type) || /红包/.test(blob)) return "人情";
  if (/退款/.test(type)) return "退款";
  if (/还款/.test(blob)) return "债权回收";

  if (/Stripe|Anysphere|Cursor/i.test(blob)) return "公司支出";
  if (/Steam|Valve|ゲーム|游戏|互娱|腾讯计算机|ニンテンドー|PlayStation|Xbox|Epic\s*Games|网易雷火/i.test(blob)) return "游戏";
  if (/Netflix|Spotify|YouTube|iCloud|OpenAI|ChatGPT|Apple|App Store|哔哩哔哩|Bilibili|bilibili|爱奇艺|腾讯视频|Google\s*One|剪映|CapCut|百度网盘|深度求索|DeepSeek|腾讯公司/i.test(blob)) {
    return "订阅";
  }
  if (/PADDLE\.NET|LANG REACT|Language Reactor/i.test(blob)) return "订阅";

  if (/バルト|KINEZO|TOHO|シネマ|映画|チケットぴあ|ぴあ|演唱会|演出/i.test(blob)) return "娱乐";
  if (/JOYFIT|フィットネス|发条鸭|ボルダリング|Bouldering/i.test(blob)) return "健康";

  if (/ファミリーマート|FamilyMart|LAWSON|Lawson|ローソン|好德|喜士多|CITYBOX|魔盒|セブン|Seven-Eleven|全家|MINISTOP|ミニストップ|NewDays|NEWDAYS/i.test(blob)) {
    return "吃喝";
  }
  if (/サミット|Summit|ストア|超市|美团|饿了么|汉堡|咖啡|Coffee|luckin|Cotti|星巴克|Starbucks|麦当劳|McDonald|蜜雪|必胜客|火锅|火鍋|重慶|烧肉|焼|餐饮|点餐|饭堂|鳥貴族|杨二白|湘御|湘遇|烩面|中国物産|独一处|外食|肯德基|KFC|奈雪|喜茶|瑞幸|达美乐|Domino|摩斯|モス|Peet|奥乐齐|ALDI|烧腊|牛肉|酸菜鱼|烧烤|茶坊|熊猫|肥仔|徽州|格瑞思|MO师傅|西池袋|食|餐|锅|面馆|果汁|マクドナルド|珈琲|ラーメン|らあめん|花月嵐|寿司|マルエツ|Maruetsu|ゼッテリア|Zetteria|My\s*Basket|マイバスケット|西友|Seiyu|山崎製パン|松屋|うどん|Manner|霸王茶姬|爱达乐|小杨生煎|生煎|钵钵鸡|板鸭|Burger|\bTEA\b|茶姬|グランパ|Grandpa|熊だ|Gotcha|Ｇｏｔｃｈａ|タピオカ|菜館|菜馆|居酒屋|バー|酒吧|格瓦斯/i.test(blob)) {
    return "吃喝";
  }
  if (/京东|淘宝|天猫|拼多多|小红书|MUJI|無印|无印|UNIQLO|优衣库|ニトリ|Nitori|ルミネ|アニメイト|Animate|迪卡侬|DECATHLON|Amazon|亚马逊|得物|唯品会|苏宁|ダイソー|Daiso|抖音电商|平台商户|顺丰|快递|EMS|德邦|圆通|中通|韵达|新起点|运业|菜鸟|京东物流|パルコ|PARCO|ヨドバシ|Yodobashi|Cando|キャンドゥ|宝岛|万维猫|Ampus|Ａｍｐｕｓ|豆魚雷|TORCH\s*TORCH/i.test(blob)) {
    return "购物";
  }
  if (/JR\s*East\s*Vending|自動販売|自动贩卖/i.test(blob)) return "吃喝";
  if (/12306|交通|地铁|Suica|公交|滴滴|打车|航空|机票|火车|JR|タクシー|携程|去哪儿|飞猪|九寨|景区|门票|酒店|住宿|民宿|万诗顿|单程|御苑|国民公園/i.test(blob)) {
    return "出行";
  }
  if (/JTEST|检定|考试|教育部|知识星球|出版社|得到|樊登|网课|课程|学堂|培训|JLPT|日本語|日语|ノア|诺亚|語学/i.test(blob)) {
    return "学习";
  }
  if (/房租|电费|水费|水道|スイドウ|瓦斯费|燃气|电信|联通|移动|宽带|软银|au |docomo|Wi-?Fi|ガス|オクトパス|エナジー|SoftBank|住房物业/i.test(blob)) {
    return "居住";
  }
  if (/医院|药店|诊所|歯科|SPA|养生|修脚|金足|保健|ココカラ|药妆|调理|ジム|クリニック|薬局/i.test(blob)) {
    return "健康";
  }

  if (type === "扫二维码付款" || type === "支払い") return "待确认";
  if (directionKind(row.direction) === "income") return "收入";
  return "待确认";
}

function alipayDirectionAndKind(type, amount) {
  const abs = Math.abs(Number(amount) || 0);
  if (/提现/.test(type)) return { direction: "/", kind: "neutral", amount: abs };
  if (Number(amount) > 0) return { direction: "收入", kind: "income", amount: abs };
  if (Number(amount) < 0) return { direction: "支出", kind: "expense", amount: abs };
  return { direction: "/", kind: "neutral", amount: 0 };
}

/** 账单展示名：把 Steam 单号、Apple bill、店址收成统一店名，方便「主要」汇总。 */
export function friendlyBillDisplayName(row) {
  const product = safeText(row.product, 80);
  const counterparty = safeText(row.counterparty, 80);
  const blob = `${counterparty} ${product}`;
  if (/Valve|Steam\s*Purchase|\bSteam\b/i.test(blob)) return "Steam";
  if (/iCloud/i.test(blob)) return "iCloud";
  if (/Stripe|Anysphere|Cursor/i.test(blob)) return "Cursor";
  if (/Appleサービス|Apple|apple\.com|App Store/i.test(blob)) return "Apple";
  if (/Netflix/i.test(blob)) return "Netflix";
  if (/JOYFIT|フィットネスカイヒ/i.test(blob)) return "JOYFIT";
  if (/PADDLE\.NET|LANG REACT|Language Reactor/i.test(blob)) return "Language Reactor";
  if (/オクトパス|Octopus/i.test(blob)) return "Octopus 电费";
  if (/ファミリーマート|FamilyMart/i.test(blob)) return "全家 FamilyMart";
  if (/Seven-Eleven|セブン/i.test(blob)) return "7-Eleven";
  if (/LAWSON|ローソン/i.test(blob)) return "罗森 Lawson";
  if (/MINISTOP|ミニストップ/i.test(blob)) return "MINISTOP";
  if (/らあめん花月嵐|花月嵐/i.test(blob)) return "花月岚拉面";
  const productIsPayMethod = /クレジット|PayPay残高|PayPayカード|PayPayポイント|一回払い|ー回払い|本人/.test(product);
  const productIsNoise = productIsPayMethod || /^\d{1,4}$/.test(product) || (product.length > 0 && product.length <= 2);
  if (/ココカラ|Kakuyasu|药妆|調剤/i.test(blob)) return "可可卡拉药妆";
  if (/JR\s*East\s*Vending|自動販売|自动贩卖/i.test(blob)) return "JR 自动售货机";
  if (counterparty && counterparty !== "/") {
    const short = counterparty.split(/\s*[-－—]\s*/)[0].trim();
    if (short && !/^\d{1,4}$/.test(short)) return short.slice(0, 40);
  }
  if (!productIsNoise && product && product !== "/" && !/^订单/.test(product) && !/Steam Purchase|apple\.com\/bill/i.test(product)) {
    return product;
  }
  return safeText(row.type, 40) || "未命名交易";
}

function displayName(row) {
  return friendlyBillDisplayName(row);
}

function maskMethod(method) {
  return safeText(method, 40).replace(/(\d{4})\d+(\d{4})/g, "$1····$2");
}

function monthKey(at) {
  const match = String(at ?? "").match(/^(\d{4}-\d{2})/);
  return match?.[1] ?? "";
}

function dayKey(at) {
  const match = String(at ?? "").match(/^\d{4}-\d{2}-(\d{2})/);
  return match?.[1] ?? "";
}

/** 创建时间（优先 birthtime），东京时区，精确到秒。 */
export function formatFileCreatedAt(stat, timeZone = "Asia/Tokyo") {
  const birth = Number(stat?.birthtimeMs);
  const mtime = Number(stat?.mtimeMs);
  const useBirth = Number.isFinite(birth) && birth > 0 && birth < Date.now() + 86_400_000;
  const ms = useBirth ? birth : mtime;
  const kind = useBirth ? "birthtime" : "mtime";
  if (!Number.isFinite(ms)) return { createdAt: "", createdAtKind: kind };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    createdAt: `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`,
    createdAtKind: kind,
    createdAtMs: ms,
  };
}

export function isWechatBillFileName(name) {
  return WECHAT_DOWNLOAD_NAME.test(String(name ?? ""));
}

export function isPayPayBillFileName(name) {
  return PAYPAY_DOWNLOAD_NAME.test(String(name ?? ""));
}

const ALIPAY_DOWNLOAD_NAME = /^支付宝交易明细.*\.csv$/i;

export function isAlipayBillFileName(name) {
  return ALIPAY_DOWNLOAD_NAME.test(String(name ?? ""));
}

export function defaultDownloadsDir() {
  return path.join(os.homedir(), "Downloads");
}

async function fileMeta(absolute, name, kind, location) {
  const stat = await fsp.stat(absolute);
  const stamped = formatFileCreatedAt(stat);
  return {
    name,
    absolute,
    kind,
    location,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    createdAt: stamped.createdAt,
    createdAtKind: stamped.createdAtKind,
    createdAtMs: stamped.createdAtMs,
  };
}

async function listVaultBillFiles(root) {
  const dir = ensureInside(root, WECHAT_BILLS_DIR);
  let entries = [];
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const name of entries) {
    if (name.startsWith("~$") || name.startsWith(".")) continue;
    const absolute = path.join(dir, name);
    const stat = await fsp.stat(absolute);
    if (!stat.isFile()) continue;
    if (isWechatBillFileName(name) || /\.xlsx$/i.test(name)) {
      files.push(await fileMeta(absolute, name, "wechat-xlsx", "vault"));
    } else if (isPayPayBillFileName(name) || (/Transactions_.*\.csv$/i.test(name) && /\.csv$/i.test(name))) {
      files.push(await fileMeta(absolute, name, "paypay-csv", "vault"));
    } else if (isAlipayBillFileName(name)) {
      files.push(await fileMeta(absolute, name, "alipay-csv", "vault"));
    } else if (/支付宝.*\.json$/i.test(name) || name === "支付宝账务明细.json") {
      files.push(await fileMeta(absolute, name, "alipay-json", "vault"));
    } else if (CASH_LEDGER_NAME.test(name)) {
      files.push(await fileMeta(absolute, name, "cash-json", "vault"));
    }
  }
  return files;
}

/**
 * 文件名里的起止日是否完整盖住某月（YYYY-MM）。
 * 例：Transactions_20260118-20260831.csv 盖住 2026-08；
 * Transactions_20260118-20260806.csv 只盖住 8 月的一部分，不算月度账单已齐。
 * @param {string} fileName
 * @param {string} monthKey
 */
export function billFileCoversMonth(fileName, monthKey) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ""))) return false;
  const [y, m] = monthKey.split("-").map(Number);
  const ym = monthKey.replace("-", "");
  const monthStart = `${ym}01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${ym}${String(lastDay).padStart(2, "0")}`;
  const range = String(fileName || "").match(/(\d{8})\D+(\d{8})/);
  if (!range) return false;
  const start = range[1];
  const end = range[2];
  return start <= monthStart && end >= monthEnd;
}

/**
 * 库内 + 下载夹：本月微信 / PayPay 账单是否已有覆盖文件。
 * @param {string} root
 * @param {string} monthKey
 * @param {{ downloadsDir?: string }} [options]
 */
export async function detectBillMonthCoverage(root, monthKey, options = {}) {
  const downloadsDir = options.downloadsDir || defaultDownloadsDir();
  const vaultFiles = await listVaultBillFiles(root);
  const downloads = await listBillDownloadCandidates(downloadsDir);
  const wechatNames = [
    ...vaultFiles.filter((file) => file.kind === "wechat-xlsx").map((file) => file.name),
    ...downloads.wechat.map((file) => file.name),
  ];
  const paypayNames = [
    ...vaultFiles.filter((file) => file.kind === "paypay-csv").map((file) => file.name),
    ...downloads.paypay.map((file) => file.name),
  ];
  const wechatHit = wechatNames.find((name) => billFileCoversMonth(name, monthKey)) || null;
  const paypayHit = paypayNames.find((name) => billFileCoversMonth(name, monthKey)) || null;
  const alipayNames = [
    ...vaultFiles.filter((file) => file.kind === "alipay-csv" || file.kind === "alipay-json").map((file) => file.name),
    ...downloads.alipay.map((file) => file.name),
  ];
  const alipayHit = alipayNames.find((name) => billFileCoversMonth(name, monthKey)) || null;
  return {
    wechat: Boolean(wechatHit),
    paypay: Boolean(paypayHit),
    alipay: Boolean(alipayHit),
    wechatFile: wechatHit,
    paypayFile: paypayHit,
    alipayFile: alipayHit,
  };
}

export async function listBillDownloadCandidates(downloadsDir = defaultDownloadsDir()) {
  let entries = [];
  try {
    entries = await fsp.readdir(downloadsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { wechat: [], paypay: [], alipay: [] };
    throw error;
  }
  const wechat = [];
  const paypay = [];
  const alipay = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(downloadsDir, entry.name);
    try {
      if (isWechatBillFileName(entry.name)) {
        wechat.push(await fileMeta(absolute, entry.name, "wechat-xlsx", "downloads"));
      } else if (isPayPayBillFileName(entry.name)) {
        paypay.push(await fileMeta(absolute, entry.name, "paypay-csv", "downloads"));
      } else if (isAlipayBillFileName(entry.name)) {
        alipay.push(await fileMeta(absolute, entry.name, "alipay-csv", "downloads"));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const byNewest = (a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0) || (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
  return {
    wechat: wechat.sort(byNewest),
    paypay: paypay.sort(byNewest),
    alipay: alipay.sort(byNewest),
  };
}

export function pickLatestDownloadBill(candidates = []) {
  return candidates[0] ?? null;
}

function yenNumber(raw) {
  const text = String(raw ?? "").trim().replace(/,/g, "").replace(/¥/g, "");
  if (!text || text === "-") return 0;
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

function normalizePayPayAt(raw) {
  const text = String(raw ?? "").trim().replace(/\//g, "-");
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (match) return `${match[1]} ${match[2]}`;
  return text.slice(0, 32);
}

async function parsePayPayCsv(file) {
  const raw = await fsp.readFile(file.absolute, "utf8");
  const text = raw.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) {
    return { file: displayPath(file), meta: { title: "PayPay 交易历史" }, rows: [], channel: "paypay" };
  }
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((name, i) => [name, i]));
  const need = ["取引日", "出金金額（円）", "入金金額（円）", "取引内容", "取引先", "取引方法", "取引番号"];
  if (!need.every((key) => key in idx)) {
    throw new Error(`PayPay CSV 表头不对：${file.name}`);
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    if (!cols.length) continue;
    const out = yenNumber(cols[idx["出金金額（円）"]]);
    const inn = yenNumber(cols[idx["入金金額（円）"]]);
    const type = safeText(cols[idx["取引内容"]], 80);
    let direction = "/";
    let kind = "neutral";
    let amount = 0;
    if (out > 0) {
      direction = "支出";
      kind = "expense";
      amount = out;
    } else if (inn > 0) {
      direction = "收入";
      kind = "income";
      amount = inn;
    }
    if (/チャージ|銀行/.test(type) && out > 0) kind = "neutral";
    rows.push({
      at: normalizePayPayAt(cols[idx["取引日"]]),
      type,
      counterparty: safeText(cols[idx["取引先"]], 80),
      product: "",
      direction,
      amount,
      method: safeText(cols[idx["取引方法"]], 40) || "PayPay",
      status: "",
      txnId: safeText(cols[idx["取引番号"]], 80),
      merchantId: "",
      note: "",
      channel: "paypay",
      currency: "JPY",
      _kindOverride: kind,
    });
  }
  return {
    file: displayPath(file),
    meta: {
      title: "PayPay 交易历史",
      range: rows.length ? `${rows.at(-1).at} ~ ${rows[0].at}` : "",
      exportedAt: file.createdAt ? `文件创建 ${file.createdAt}` : "",
    },
    rows,
    channel: "paypay",
  };
}

/** 简易 CSV 行解析（支持引号内逗号）。 */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function displayPath(file) {
  if (file.location === "downloads") return path.posix.join("~/Downloads", file.name);
  return path.posix.join(WECHAT_BILLS_DIR, file.name);
}

async function readTextMaybeGbk(absolute) {
  try {
    const { stdout } = await execFileAsync("iconv", ["-f", "GBK", "-t", "UTF-8", absolute], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (stdout.includes("交易时间")) return stdout;
  } catch {
    // fall through
  }
  try {
    const python = await resolvePython3();
    if (python) {
      const { stdout } = await execFileAsync(
        python,
        ["-c", "import sys; print(open(sys.argv[1], encoding='gbk').read())", absolute],
        { maxBuffer: 16 * 1024 * 1024, env: pythonEnv() },
      );
      if (stdout.includes("交易时间")) return stdout;
    }
  } catch {
    // fall through
  }
  return await fsp.readFile(absolute, "utf8");
}

async function parseAlipayCsv(file) {
  const text = await readTextMaybeGbk(file.absolute);
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes("交易时间") && line.includes("金额"));
  if (headerIndex < 0) throw new Error(`支付宝 CSV 找不到表头：${file.name}`);
  const header = parseCsvLine(lines[headerIndex]).map((item) => item.trim());
  const idx = Object.fromEntries(header.map((name, i) => [name, i]));
  const need = ["交易时间", "交易对方", "商品说明", "收/支", "金额"];
  if (!need.every((key) => key in idx)) {
    throw new Error(`支付宝 CSV 表头不对：${file.name}`);
  }
  const rows = [];
  let incomeCount = 0;
  let expenseCount = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim() || /^-+$/.test(line.trim())) continue;
    const cols = parseCsvLine(line);
    if (!cols.length) continue;
    const at = safeText(cols[idx["交易时间"]], 32).replace(/\t/g, "").trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(at)) continue;
    const directionRaw = safeText(cols[idx["收/支"]], 20);
    const amount = Math.abs(Number(String(cols[idx["金额"]] ?? "").replace(/,/g, "")) || 0);
    let direction = "/";
    let kind = "neutral";
    if (directionRaw === "收入") {
      direction = "收入";
      kind = "income";
      incomeCount += 1;
    } else if (directionRaw === "支出") {
      direction = "支出";
      kind = "expense";
      expenseCount += 1;
    }
    const type = safeText(cols[idx["交易分类"]] ?? directionRaw, 40) || directionRaw;
    rows.push({
      at,
      type,
      counterparty: safeText(cols[idx["交易对方"]], 80),
      product: safeText(cols[idx["商品说明"]], 80),
      direction,
      amount,
      method: safeText(cols[idx["收/付款方式"]], 40) || "支付宝",
      status: safeText(cols[idx["交易状态"]], 40),
      txnId: safeText(cols[idx["交易订单号"]], 80).replace(/\t/g, "").trim(),
      merchantId: safeText(cols[idx["商家订单号"]], 80).replace(/\t/g, "").trim(),
      note: safeText(cols[idx["备注"]], 120),
      channel: "alipay",
      currency: "CNY",
      _kindOverride: kind,
    });
  }
  const rangeMatch = String(file.name).match(/(\d{8}).*?(\d{8})/);
  return {
    file: displayPath(file),
    meta: {
      title: "支付宝交易明细",
      range: rangeMatch ? `${rangeMatch[1]}-${rangeMatch[2]}` : "",
      exportedAt: "",
      incomeCount,
      expenseCount,
    },
    rows,
    channel: "alipay",
  };
}

async function parseOneFile(file) {
  if (file.kind === "alipay-csv") {
    const parsed = await parseAlipayCsv(file);
    return { ...parsed, sourceFile: file };
  }
  if (file.kind === "alipay-json") {
    const parsed = JSON.parse(await fsp.readFile(file.absolute, "utf8"));
    const rows = [];
    for (const raw of Array.isArray(parsed.rows) ? parsed.rows : []) {
      const typed = safeText(raw.type, 40);
      const signed = Number(raw.amount) || 0;
      const normalized = alipayDirectionAndKind(typed, signed);
      rows.push({
        at: safeText(raw.at, 32),
        type: typed,
        counterparty: safeText(raw.counterparty, 80),
        product: safeText(raw.product, 80),
        direction: normalized.direction,
        amount: normalized.amount,
        method: "支付宝",
        status: "",
        txnId: safeText(raw.txnId, 80),
        merchantId: "",
        note: safeText(raw.note, 120),
        channel: "alipay",
        currency: "CNY",
        _kindOverride: normalized.kind,
      });
    }
    return {
      file: displayPath(file),
      meta: {
        title: safeText(parsed.source, 40) || "支付宝账务明细",
        range: safeText(parsed.note, 120),
        exportedAt: safeText(parsed.recordedAt, 40),
      },
      rows,
      channel: "alipay",
      sourceFile: file,
    };
  }

  if (file.kind === "cash-json") {
    const parsed = JSON.parse(await fsp.readFile(file.absolute, "utf8"));
    const currency = safeText(parsed.currency, 8) === "CNY" ? "CNY" : "JPY";
    const rows = [];
    for (const raw of Array.isArray(parsed.rows) ? parsed.rows : []) {
      const typed = safeText(raw.type, 40) || "现金消费";
      const normalized = alipayDirectionAndKind(typed, Number(raw.amount) || 0);
      rows.push({
        at: safeText(raw.at, 32),
        type: typed,
        counterparty: safeText(raw.counterparty, 80),
        product: safeText(raw.product, 80),
        direction: normalized.direction,
        amount: normalized.amount,
        method: safeText(raw.method, 40) || "现金",
        status: safeText(raw.status, 40),
        txnId: safeText(raw.txnId, 80),
        merchantId: "",
        note: safeText(raw.note, 120),
        channel: "cash",
        currency: safeText(raw.currency, 8) === "CNY" ? "CNY" : currency,
        _kindOverride: normalized.kind,
        _categoryOverride: safeText(raw.category, 40),
      });
    }
    return {
      file: displayPath(file),
      meta: {
        title: safeText(parsed.source, 40) || "现金账务明细",
        range: safeText(parsed.note, 120),
        exportedAt: safeText(parsed.recordedAt, 40),
      },
      rows,
      channel: "cash",
      sourceFile: file,
    };
  }

  if (file.kind === "paypay-csv") {
    const parsed = await parsePayPayCsv(file);
    return { ...parsed, sourceFile: file };
  }

  const parsed = await runPythonScript(PYTHON_PARSE, [file.absolute], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
    task: `读微信账单 ${file.name}`,
  });
  return {
    file: displayPath(file),
    meta: parsed.meta ?? {},
    rows: (Array.isArray(parsed.rows) ? parsed.rows : []).map((row) => ({
      ...row,
      channel: "wechat",
      currency: "CNY",
    })),
    channel: "wechat",
    sourceFile: file,
  };
}

function emptyMoney() {
  return { CNY: 0, JPY: 0 };
}

function addMoney(bucket, currency, amount) {
  const key = currency === "JPY" ? "JPY" : "CNY";
  bucket[key] = round2((bucket[key] ?? 0) + amount);
}

function buildCashflow(parsedFiles, extras = {}) {
  const byId = new Map();
  const sources = [];
  for (const file of parsedFiles) {
    const src = file.sourceFile;
    sources.push({
      path: file.file,
      name: src?.name || path.posix.basename(file.file),
      title: safeText(file.meta.title, 40)
        || (file.channel === "alipay" ? "支付宝账务" : file.channel === "paypay" ? "PayPay 交易历史" : "微信支付账单"),
      range: safeText(file.meta.range, 120),
      exportedAt: safeText(file.meta.exportedAt, 80),
      rowCount: file.rows.length,
      channel: file.channel || "wechat",
      location: src?.location || "vault",
      createdAt: src?.createdAt || "",
      createdAtKind: src?.createdAtKind || "",
    });
    for (const row of file.rows) {
      const txnId = safeText(row.txnId, 80);
      const fallbackId = createHash("sha1")
        .update([row.channel, row.at, row.direction, row.amount, row.counterparty, row.product, row.type].join("|"))
        .digest("hex")
        .slice(0, 16);
      const id = txnId || fallbackId;
      if (byId.has(id)) continue;
      const category = safeText(row._categoryOverride, 40) || categorizeWechatRow(row);
      const kind = resolveCashflowKind(row._kindOverride || directionKind(row.direction), category);
      const month = monthKey(row.at);
      if (!month) continue;
      const channel = safeText(row.channel, 20) || "wechat";
      const currency = row.currency === "JPY" ? "JPY" : "CNY";
      byId.set(id, {
        id,
        at: safeText(row.at, 32),
        month,
        day: dayKey(row.at),
        name: displayName(row),
        amount: Number(row.amount) || 0,
        kind,
        category,
        type: safeText(row.type, 40),
        method: maskMethod(row.method) || (channel === "alipay" ? "支付宝" : channel === "paypay" ? "PayPay" : ""),
        status: safeText(row.status, 40),
        note: safeText(row.note === "/" ? "" : row.note, 80),
        channel,
        currency,
      });
    }
  }

  const flows = collapseNearDuplicateFlows([...byId.values()]).sort((a, b) => b.at.localeCompare(a.at));
  const monthMap = new Map();
  for (const flow of flows) {
    if (!monthMap.has(flow.month)) {
      monthMap.set(flow.month, {
        month: flow.month,
        income: emptyMoney(),
        expense: emptyMoney(),
        neutral: emptyMoney(),
        incomeCount: 0,
        expenseCount: 0,
        neutralCount: 0,
        categories: new Map(),
        ledger: [],
      });
    }
    const bucket = monthMap.get(flow.month);
    bucket.ledger.push(flow);
    if (flow.kind === "income") {
      addMoney(bucket.income, flow.currency, flow.amount);
      bucket.incomeCount += 1;
    } else if (flow.kind === "expense") {
      addMoney(bucket.expense, flow.currency, flow.amount);
      bucket.expenseCount += 1;
      const catKey = `${flow.currency}:${flow.category}`;
      bucket.categories.set(catKey, (bucket.categories.get(catKey) ?? 0) + flow.amount);
    } else {
      addMoney(bucket.neutral, flow.currency, flow.amount);
      bucket.neutralCount += 1;
    }
  }

  const months = [...monthMap.keys()].sort();
  const monthSummaries = months.map((month) => {
    const bucket = monthMap.get(month);
    const categories = [...bucket.categories.entries()]
      .map(([key, amount]) => {
        const [currency, name] = key.split(":");
        return { name, amount: round2(amount), currency };
      })
      .sort((a, b) => {
        const aCny = a.currency === "JPY" ? a.amount * 0.047 : a.amount;
        const bCny = b.currency === "JPY" ? b.amount * 0.047 : b.amount;
        return bCny - aCny;
      });
    const incomeCny = bucket.income.CNY;
    const expenseCny = bucket.expense.CNY;
    const incomeJpy = bucket.income.JPY;
    const expenseJpy = bucket.expense.JPY;
    return {
      month,
      income: incomeCny,
      expense: expenseCny,
      neutral: bucket.neutral.CNY,
      balance: round2(incomeCny - expenseCny),
      incomeJpy,
      expenseJpy,
      neutralJpy: bucket.neutral.JPY,
      balanceJpy: round2(incomeJpy - expenseJpy),
      incomeCount: bucket.incomeCount,
      expenseCount: bucket.expenseCount,
      neutralCount: bucket.neutralCount,
      categories,
      ledger: bucket.ledger
        .slice()
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((item) => ({
          id: item.id,
          at: item.at,
          day: item.day,
          name: item.name,
          amount: round2(item.amount),
          kind: item.kind,
          category: item.category,
          type: item.type,
          method: item.method,
          status: item.status,
          note: item.note,
          channel: item.channel || "wechat",
          currency: item.currency || "CNY",
        })),
    };
  });

  const latestMonth = months.at(-1) ?? "";
  const yearMap = new Map();
  for (const summary of monthSummaries) {
    const year = summary.month.slice(0, 4);
    if (!yearMap.has(year)) {
      yearMap.set(year, {
        year,
        income: 0,
        expense: 0,
        neutral: 0,
        incomeJpy: 0,
        expenseJpy: 0,
        incomeCount: 0,
        expenseCount: 0,
        neutralCount: 0,
        monthCount: 0,
        categories: new Map(),
      });
    }
    const bucket = yearMap.get(year);
    bucket.income += summary.income;
    bucket.expense += summary.expense;
    bucket.neutral += summary.neutral;
    bucket.incomeJpy += summary.incomeJpy;
    bucket.expenseJpy += summary.expenseJpy;
    bucket.incomeCount += summary.incomeCount;
    bucket.expenseCount += summary.expenseCount;
    bucket.neutralCount += summary.neutralCount;
    bucket.monthCount += 1;
    for (const item of summary.categories) {
      const catKey = `${item.currency}:${item.name}`;
      bucket.categories.set(catKey, (bucket.categories.get(catKey) ?? 0) + item.amount);
    }
  }
  const years = [...yearMap.keys()].sort().map((year) => {
    const bucket = yearMap.get(year);
    const categories = [...bucket.categories.entries()]
      .map(([key, amount]) => {
        const [currency, name] = key.split(":");
        return { name, amount: round2(amount), currency };
      })
      .sort((a, b) => {
        const aCny = a.currency === "JPY" ? a.amount * 0.047 : a.amount;
        const bCny = b.currency === "JPY" ? b.amount * 0.047 : b.amount;
        return bCny - aCny;
      });
    return {
      year,
      income: round2(bucket.income),
      expense: round2(bucket.expense),
      neutral: round2(bucket.neutral),
      balance: round2(bucket.income - bucket.expense),
      incomeJpy: round2(bucket.incomeJpy),
      expenseJpy: round2(bucket.expenseJpy),
      balanceJpy: round2(bucket.incomeJpy - bucket.expenseJpy),
      incomeCount: bucket.incomeCount,
      expenseCount: bucket.expenseCount,
      neutralCount: bucket.neutralCount,
      monthCount: bucket.monthCount,
      categories,
    };
  });

  const channels = [...new Set(sources.map((item) => item.channel).filter(Boolean))];
  const labelParts = [];
  if (channels.includes("wechat")) labelParts.push("微信");
  if (channels.includes("paypay")) labelParts.push("PayPay");
  if (channels.includes("alipay")) labelParts.push("支付宝");
  if (channels.includes("cash")) labelParts.push("现金");
  const currencies = [...new Set(flows.map((item) => item.currency).filter(Boolean))];

  return {
    schemaVersion: 4,
    currency: currencies.length > 1 ? "MIXED" : currencies[0] || "CNY",
    sourceLabel: labelParts.join(" + ") || "生活账单",
    sourceDir: WECHAT_BILLS_DIR,
    sources,
    downloadPicks: extras.downloadPicks ?? { wechat: null, paypay: null, alipay: null },
    transactionCount: flows.length,
    latestMonth,
    years,
    months: monthSummaries.map(({ ledger, ...summary }) => summary),
    trend: monthSummaries.map((item) => ({
      month: item.month,
      label: `${item.month.slice(2, 4)}/${Number(item.month.slice(5))}`,
      income: item.income,
      expense: item.expense,
      balance: item.balance,
      incomeJpy: item.incomeJpy,
      expenseJpy: item.expenseJpy,
      balanceJpy: item.balanceJpy,
    })),
    ledgerByMonth: Object.fromEntries(monthSummaries.map((item) => [item.month, item.ledger])),
  };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function summarizePick(file) {
  if (!file) return null;
  const channel =
    file.kind === "paypay-csv" ? "paypay" : file.kind === "alipay-csv" || file.kind === "alipay-json" ? "alipay" : "wechat";
  return {
    name: file.name,
    createdAt: file.createdAt,
    createdAtKind: file.createdAtKind,
    size: file.size,
    location: file.location,
    channel,
    inVault: file.location === "vault",
  };
}

/** 库内同名文件与下载夹最新份：取创建时间更新的那份；下载夹新文件名也会并入。 */
function mergeParseSet(vaultFiles, downloadPicks) {
  const byKey = new Map();
  for (const file of vaultFiles) {
    byKey.set(`${file.kind}:${file.name}`, file);
  }
  for (const pick of [downloadPicks.wechat, downloadPicks.paypay, downloadPicks.alipay]) {
    if (!pick) continue;
    const key = `${pick.kind}:${pick.name}`;
    const existing = byKey.get(key);
    if (!existing || (pick.createdAtMs ?? 0) >= (existing.createdAtMs ?? 0)) {
      byKey.set(key, pick);
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export async function readWechatCashflow(root, options = {}) {
  const downloadsDir = options.downloadsDir || defaultDownloadsDir();
  const vaultFiles = await listVaultBillFiles(root);
  const candidates = await listBillDownloadCandidates(downloadsDir);
  const downloadPicks = {
    wechat: pickLatestDownloadBill(candidates.wechat),
    paypay: pickLatestDownloadBill(candidates.paypay),
    alipay: pickLatestDownloadBill(candidates.alipay),
  };
  const files = mergeParseSet(vaultFiles, downloadPicks);

  const pickMeta = {
    wechat: summarizePick(downloadPicks.wechat),
    paypay: summarizePick(downloadPicks.paypay),
    alipay: summarizePick(downloadPicks.alipay),
  };

  if (!files.length) {
    return {
      schemaVersion: 4,
      currency: "CNY",
      sourceLabel: "生活账单",
      sourceDir: WECHAT_BILLS_DIR,
      sources: [],
      downloadPicks: pickMeta,
      transactionCount: 0,
      latestMonth: "",
      years: [],
      months: [],
      trend: [],
      ledgerByMonth: {},
      available: false,
      message: "还没有账单。把微信 xlsx、PayPay CSV 或支付宝交易明细 CSV 下到「下载」文件夹，刷新本页即可识别。",
    };
  }

  const key =
    files.map((file) => `${file.location}:${file.name}:${file.mtimeMs}:${file.size}`).join("|")
    + `|dw:${downloadPicks.wechat?.name || ""}:${downloadPicks.paypay?.name || ""}:${downloadPicks.alipay?.name || ""}`
    + ":v9-expense-taxonomy";
  if (!options.force && cache?.key === key) return cache.data;

  const parsedFiles = [];
  for (const file of files) parsedFiles.push(await parseOneFile(file));
  const data = {
    ...buildCashflow(parsedFiles, { downloadPicks: pickMeta }),
    available: true,
    message: "",
  };
  cache = { key, data };
  return data;
}

export async function importBillDownloadsToVault(root, options = {}) {
  const downloadsDir = options.downloadsDir || defaultDownloadsDir();
  const channels = new Set(
    Array.isArray(options.channels) && options.channels.length
      ? options.channels.map(String)
      : ["wechat", "paypay", "alipay"],
  );
  const candidates = await listBillDownloadCandidates(downloadsDir);
  const picks = [];
  if (channels.has("wechat") && candidates.wechat[0]) picks.push(candidates.wechat[0]);
  if (channels.has("paypay") && candidates.paypay[0]) picks.push(candidates.paypay[0]);
  if (channels.has("alipay")) {
    for (const pick of candidates.alipay.slice(0, 3)) picks.push(pick);
  }
  if (!picks.length) {
    throw new WorkbenchWriteError("下载文件夹里没有可导入的微信 / PayPay / 支付宝账单。", 404, "BILL_DOWNLOAD_MISSING");
  }

  const dir = ensureInside(root, WECHAT_BILLS_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const imported = [];
  for (const pick of picks) {
    const target = path.join(dir, pick.name);
    await fsp.copyFile(pick.absolute, target);
    const stamped = formatFileCreatedAt(await fsp.stat(target));
    imported.push({
      channel: pick.kind === "paypay-csv" ? "paypay" : pick.kind === "alipay-csv" ? "alipay" : "wechat",
      name: pick.name,
      path: path.posix.join(WECHAT_BILLS_DIR, pick.name),
      createdAt: pick.createdAt,
      createdAtKind: pick.createdAtKind,
      vaultCreatedAt: stamped.createdAt,
    });
  }
  resetWechatCashflowCache();
  const cashflow = await readWechatCashflow(root, { force: true, downloadsDir });
  return { imported, cashflow };
}

export function resetWechatCashflowCache() {
  cache = null;
}
