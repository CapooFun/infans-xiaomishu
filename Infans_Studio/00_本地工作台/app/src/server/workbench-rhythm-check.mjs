/**
 * 定期任务检查：原料新鲜度、周/月覆盖、资产盘点缺项。
 * 供 workbench-cron-monitor 拼进 /api/tools/cron。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  APPLE_HEALTH_DERIVED,
  ASSET_SOURCE,
  BODY_RECORD,
  DIARY_DIR,
  STEAM_LIBRARY_JSON,
  TRAINING_LOG,
  ANKI_SNAPSHOT_DERIVED,
  diaryPathForDay,
} from "./vault-paths.mjs";
import { parseHealth } from "./workbench-data.mjs";
import { readAppleHealthData } from "./workbench-apple-health.mjs";
import { appleHealthAutoSyncStatus, appleHealthSourceReadiness } from "./workbench-health-readiness.mjs";
import { detectBillMonthCoverage } from "./workbench-wechat-bills.mjs";

const MONTHLY_REVIEW_DIR = path.posix.join("10_日志记录", "月度回顾");

/** 与 [[资产盘点清单]] 对齐；生活收支靠账单文件 + 口头确认，不靠余额快照。 */
export const ASSET_CHECKLIST_GROUPS = [
  { id: "bank", label: "银行存款" },
  { id: "cash", label: "现金与第三方" },
  { id: "credit", label: "信用卡 / 贷款" },
  { id: "securities", label: "证券与代持" },
  { id: "loans", label: "其他债权" },
  { id: "cashflow", label: "生活收支" },
];

  /** 余额快照项：开源树只用明确虚构示例，不写真实卡号或具名联系人。 */
  export const ASSET_SNAPSHOT_ITEMS = [
  { id: "bank-a", group: "bank", label: "示例银行账户甲", match: /示例银行甲|尾号\s*1001/ },
  { id: "bank-b", group: "bank", label: "示例银行账户乙", match: /示例银行乙|尾号\s*2002/ },
  { id: "bank-c", group: "bank", label: "示例银行账户丙", match: /示例银行丙|尾号\s*3003/ },
  { id: "bank-jp", group: "bank", label: "示例日本账户", match: /示例日本账户|ゆうちょ示例/ },
  { id: "bank-d", group: "bank", label: "示例银行账户丁", match: /示例银行丁|尾号\s*4004/ },
  { id: "cash-jpy", group: "cash", label: "日元现金", match: /日元现金/ },
  { id: "paypay-balance", group: "cash", label: "PayPay 余额", match: /现金\/第三方.*PayPay|^PayPay$|PayPay余额|name":"PayPay"/ },
  { id: "alipay", group: "cash", label: "支付宝余额", match: /支付宝/ },
  { id: "credit-a", group: "credit", label: "示例信用卡甲", match: /示例信用卡甲|尾号\s*5005/ },
  { id: "credit-b", group: "credit", label: "示例信用卡乙", match: /示例信用卡乙|尾号\s*6006/ },
  { id: "credit-c", group: "credit", label: "示例信用卡丙", match: /示例信用卡丙|尾号\s*7007/ },
  { id: "paypay-card", group: "credit", label: "PayPay 卡", match: /PayPay卡/ },
  { id: "consumer-loan", group: "credit", label: "示例消费贷", match: /示例消费贷/ },
  { id: "a-shares", group: "securities", label: "A 股", match: /^A股$|A\s*股/ },
  { id: "cn-funds", group: "securities", label: "大陆基金", match: /基金产品（中国大陆）|大陆.*基金/ },
  { id: "us-brokerage", group: "securities", label: "示例美股账户", match: /示例美股/ },
  { id: "managed-funds", group: "securities", label: "示例基金账户", match: /示例基金账户/ },
  { id: "managed-note", group: "securities", label: "示例托管份额", match: /示例托管/ },
  { id: "personal-loans", group: "loans", label: "借款情况", match: /示例借款|对私人借款/ },
];

/** 生活收支项（账单覆盖 + 口头确认；不进余额快照匹配）。 */
export const ASSET_CASHFLOW_ITEMS = [
  { id: "wechat-bills", group: "cashflow", label: "微信账单" },
  { id: "paypay-bills", group: "cashflow", label: "PayPay 账单" },
  { id: "alipay-bills", group: "cashflow", label: "支付宝账单" },
  { id: "large-other", group: "cashflow", label: "其他大额支付（口头确认）" },
];

export const ASSET_CHECKLIST_ITEMS = [...ASSET_SNAPSHOT_ITEMS, ...ASSET_CASHFLOW_ITEMS];

/**
 * @param {Array<{ id: string, label: string, present: boolean, group?: string }>} items
 */
export function groupAssetChecklistItems(items) {
  return ASSET_CHECKLIST_GROUPS.map((group) => {
    const rows = items.filter((item) => item.group === group.id);
    const missingCount = rows.filter((item) => !item.present).length;
    return {
      id: group.id,
      label: group.label,
      items: rows,
      missingCount,
    };
  }).filter((group) => group.items.length > 0);
}

/**
 * 资产记录里的口头确认行，例：
 * 大额支付确认（2026-08）：无其他未统计 · 2026-08-09
 * @param {string} assetMd
 * @param {string} monthKey
 */
export function readLargeOtherPaymentConfirm(assetMd, monthKey) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ""))) return { present: false, note: null };
  const escaped = monthKey.replace(/-/g, "\\-");
  const re = new RegExp(`大额支付确认[（(]\\s*${escaped}\\s*[）)]\\s*[：:]\\s*([^\\n]+)`);
  const hit = String(assetMd || "").match(re);
  if (!hit) return { present: false, note: null };
  const note = hit[1].trim();
  if (!note || /^待/.test(note)) return { present: false, note };
  return { present: true, note };
}

/**
 * 把生活收支三项叠进盘点结果（与有没有余额快照无关）。
 * @param {{ items: Array<{ id: string, group?: string, label: string, present: boolean }>, snapshotDate?: string | null }} view
 * @param {{ wechat: boolean, paypay: boolean, alipay?: boolean, largeOther: boolean }} flags
 */
export function applyCashflowChecklist(view, flags) {
  const byId = new Map((view.items || []).map((item) => [item.id, item]));
  for (const row of ASSET_CASHFLOW_ITEMS) {
    let present = false;
    if (row.id === "wechat-bills") present = Boolean(flags.wechat);
    else if (row.id === "paypay-bills") present = Boolean(flags.paypay);
    else if (row.id === "alipay-bills") present = Boolean(flags.alipay);
    else if (row.id === "large-other") present = Boolean(flags.largeOther);
    byId.set(row.id, { id: row.id, group: row.group, label: row.label, present });
  }
  const items = [
    ...ASSET_SNAPSHOT_ITEMS.map((row) => byId.get(row.id) || { id: row.id, group: row.group, label: row.label, present: false }),
    ...ASSET_CASHFLOW_ITEMS.map((row) => byId.get(row.id)),
  ];
  const missing = items.filter((item) => !item.present);
  return {
    snapshotDate: view.snapshotDate ?? null,
    items,
    groups: groupAssetChecklistItems(items),
    missingCount: missing.length,
    missingLabels: missing.map((item) => item.label),
  };
}
const MONTHLY_COVERAGE_RATIO = 0.8;
const ASSET_DUE_DAY = 10;

/**
 * @param {string} todayKey YYYY-MM-DD
 */
export function mondayOfWeek(todayKey) {
  const [y, m, d] = todayKey.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const weekday = new Date(utc).getUTCDay(); // 0 Sun
  const offset = weekday === 0 ? -6 : 1 - weekday;
  const mon = new Date(utc);
  mon.setUTCDate(mon.getUTCDate() + offset);
  return mon.toISOString().slice(0, 10);
}

/**
 * @param {string} todayKey
 */
export function previousMonthRange(todayKey) {
  const [y, m] = todayKey.split("-").map(Number);
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  const daysInMonth = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  const monthKey = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
  /** @type {string[]} */
  const days = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    days.push(`${monthKey}-${String(day).padStart(2, "0")}`);
  }
  return { year: prevYear, month: prevMonth, monthKey, daysInMonth, days };
}

/**
 * 月末盘点在次月 1–10 日开放。上一轮已经完成后，不继续把绿色旧清单冒充当前任务，
 * 而是把尚未结月的下一轮标为待安排，并保留上一轮作为依据。
 * @param {string} todayKey YYYY-MM-DD
 * @param {boolean} complete 上一月末清单是否已经齐全
 */
export function assetInventoryCycle(todayKey, complete) {
  const [year, month, day] = String(todayKey).split("-").map(Number);
  const currentMonthKey = `${year}-${String(month).padStart(2, "0")}`;
  const previousMonthKey = previousMonthRange(todayKey).monthKey;
  if (!complete) {
    return {
      state: day >= ASSET_DUE_DAY ? "overdue" : "open",
      targetMonthKey: previousMonthKey,
      opensAt: `${currentMonthKey}-01`,
      dueAt: `${currentMonthKey}-${String(ASSET_DUE_DAY).padStart(2, "0")}`,
      lastCompletedMonthKey: null,
    };
  }
  const nextMonth = new Date(Date.UTC(year, month, 1));
  const nextMonthKey = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}`;
  return {
    state: "next-pending",
    targetMonthKey: currentMonthKey,
    opensAt: `${nextMonthKey}-01`,
    dueAt: `${nextMonthKey}-${String(ASSET_DUE_DAY).padStart(2, "0")}`,
    lastCompletedMonthKey: previousMonthKey,
  };
}

/** @param {string} iso */
export function formatShortDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/**
 * @param {string} text
 */
export function diaryDayComplete(text = "") {
  const body = String(text);
  return /工作强度\s*(?:(?:10|[0-9])\s*\/\s*10|[1-5]\s*\/\s*5)/.test(body) && /恢复[：:]/.test(body);
}

/**
 * @param {string[]} dateKeys sorted ascending
 * @param {string} from inclusive
 * @param {string} to inclusive
 */
export function countDatesInRange(dateKeys, from, to) {
  return dateKeys.filter((key) => key >= from && key <= to).length;
}

/**
 * @param {string[]} dateKeys
 * @param {string} from
 * @param {string} to
 */
export function latestInRange(dateKeys, from, to) {
  const hit = dateKeys.filter((key) => key >= from && key <= to);
  return hit.length ? hit[hit.length - 1] : null;
}

/**
 * @param {string[]} dateKeys ascending
 */
export function latestDate(dateKeys) {
  return dateKeys.length ? dateKeys[dateKeys.length - 1] : null;
}

/**
 * @param {{ date: string, items: Array<{ name?: string }> } | null} snapshot
 * @param {typeof ASSET_SNAPSHOT_ITEMS} checklist
 */
export function matchAssetChecklist(snapshot, checklist = ASSET_SNAPSHOT_ITEMS) {
  const names = (snapshot?.items || []).map((item) => String(item.name || ""));
  const haystack = names.join("\n");
  const items = checklist.map((row) => {
    const present = names.some((name) => row.match.test(name)) || row.match.test(haystack);
    return { id: row.id, group: row.group, label: row.label, present };
  });
  const missing = items.filter((item) => !item.present);
  return {
    snapshotDate: snapshot?.date || null,
    items,
    groups: groupAssetChecklistItems(items),
    missingCount: missing.length,
    missingLabels: missing.map((item) => item.label),
  };
}

/**
 * PayPay 余额 vs PayPay 卡：按 category 区分更稳。
 * @param {{ date: string, items: Array<{ name?: string, category?: string }> } | null} snapshot
 * @param {typeof ASSET_SNAPSHOT_ITEMS} checklist
 */
export function matchAssetChecklistSmart(snapshot, checklist = ASSET_SNAPSHOT_ITEMS) {
  const items = (snapshot?.items || []).map((item) => ({
    name: String(item.name || ""),
    category: String(item.category || ""),
  }));
  const result = checklist.map((row) => {
    let present = false;
    if (row.id === "paypay-balance") {
      present = items.some((item) => /PayPay/.test(item.name) && /现金|第三方/.test(item.category) && !/卡/.test(item.name));
    } else if (row.id === "paypay-card") {
      present = items.some((item) => (/PayPay/.test(item.name) && /信用|负债/.test(item.category)) || /PayPay卡/.test(item.name));
    } else if (row.id === "alipay") {
      present = items.some((item) => /支付宝/.test(item.name));
    } else if (row.id === "personal-loans") {
      present = items.some((item) => /示例借款|对私人借款/.test(item.name));
    } else {
      present = items.some((item) => row.match.test(item.name));
    }
    return { id: row.id, group: row.group, label: row.label, present };
  });
  const missing = result.filter((item) => !item.present);
  return {
    snapshotDate: snapshot?.date || null,
    items: result,
    groups: groupAssetChecklistItems(result),
    missingCount: missing.length,
    missingLabels: missing.map((item) => item.label),
  };
}

/**
 * @param {number} have
 * @param {number} total
 * @param {number} ratio
 */
export function coverageAlarm(have, total, ratio = MONTHLY_COVERAGE_RATIO) {
  if (total <= 0) return { alarm: false, ratio: 0 };
  const actual = have / total;
  return { alarm: actual < ratio, ratio: actual };
}

/**
 * @param {string} fromKey
 * @param {string} toKey
 */
export function calendarDaysBetween(fromKey, toKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromKey || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toKey || ""))) {
    return Number.POSITIVE_INFINITY;
  }
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * 本周睡眠告警。
 * 周一刚开局时，「本周」只含今天；导出往往还没含「今天醒来」那一截，
 * 若总体睡眠仍新鲜（昨/今有数据），不报红，避免刚导入仍显示缺口。
 * @param {number} have
 * @param {number} elapsed
 * @param {{ latestSleepKey?: string | null, todayKey?: string | null }} [opts]
 */
export function weeklySleepAlarm(have, elapsed, opts = {}) {
  if (elapsed <= 0) return { alarm: false };
  const latest = opts.latestSleepKey || null;
  const today = opts.todayKey || null;
  if (elapsed <= 2 && latest && today) {
    const lag = calendarDaysBetween(latest, today);
    if (lag <= 1) return { alarm: false, freshEnough: true };
  }
  return { alarm: have < elapsed / 2, freshEnough: false };
}

/**
 * @param {string} text steam json
 */
export function steamPlayedRecently(text = "") {
  try {
    const parsed = JSON.parse(text);
    const games = Array.isArray(parsed?.games) ? parsed.games : [];
    const minutes = games.reduce((sum, game) => sum + (Number(game.playtime_2weeks_minutes) || 0), 0);
    return { played: minutes > 0, minutes2weeks: minutes, syncedAt: parsed?.synced_at || null };
  } catch {
    return { played: false, minutes2weeks: 0, syncedAt: null };
  }
}

/**
 * @param {string} markdown asset file
 * @param {string} monthPrefix YYYY-MM
 */
export function pickMonthAssetSnapshot(markdown, monthPrefix) {
  const raw = String(markdown).match(
    /<!-- INFANS_ASSET_SNAPSHOT_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- INFANS_ASSET_SNAPSHOT_JSON_END -->/,
  )?.[1];
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const snapshots = (Array.isArray(parsed.snapshots) ? parsed.snapshots : [])
    .filter((snap) => Array.isArray(snap.items) && String(snap.date || "").startsWith(monthPrefix))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (snapshots.length) return snapshots[snapshots.length - 1];
  // 本月没有：仍返回全库最新，供对照缺项（但 snapshotDate 会标不是本月）
  const all = (Array.isArray(parsed.snapshots) ? parsed.snapshots : [])
    .filter((snap) => Array.isArray(snap.items) && /^\d{4}-\d{2}-\d{2}$/.test(String(snap.date || "")))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return all.length ? { ...all[all.length - 1], _notThisMonth: true } : null;
}

/**
 * 原料新鲜度 0–100：越新越高；没有日期为 0。
 * @param {string | null} asOf
 * @param {string} todayKey
 */
export function freshnessReadyPercent(asOf, todayKey) {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return 0;
  const [ay, am, ad] = asOf.split("-").map(Number);
  const [ty, tm, td] = todayKey.split("-").map(Number);
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
  if (days <= 0) return 100;
  if (days === 1) return 92;
  if (days <= 3) return 78;
  if (days <= 7) return 55;
  if (days <= 14) return 32;
  return 12;
}

function withFreshnessReady(row, todayKey) {
  const readyPercent = row.id === "steam"
    ? (row.asOfLabel === "有碰" ? 100 : 18)
    : freshnessReadyPercent(row.asOf, todayKey);
  return { ...row, readyPercent };
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string} vaultRoot
 * @param {string} todayKey
 */
async function collectDiaryCompleteDates(vaultRoot, todayKey) {
  const dir = path.join(vaultRoot, DIARY_DIR);
  /** @type {string[]} */
  const dates = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return dates;
  }
  const keys = entries
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
    .filter(Boolean)
    .sort();
  // 只扫近 90 天，避免全库。上月日评覆盖已从检查台拿掉，不必再为整月补扫。
  const cutoff = (() => {
    const [y, m, d] = todayKey.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 90);
    return dt.toISOString().slice(0, 10);
  })();
  const need = keys.filter((key) => key >= cutoff);
  for (const key of need) {
    const text = await readText(path.join(vaultRoot, diaryPathForDay(key)));
    if (text && diaryDayComplete(text)) dates.push(key);
  }
  return dates.sort();
}

/**
 * @param {string} vaultRoot
 * @param {string} todayKey
 * @param {{ hour?: number }} [clock]
 */
export async function buildRhythmExtras(vaultRoot, todayKey, clock = {}) {
  const root = path.resolve(vaultRoot);
  const weekStart = mondayOfWeek(todayKey);
  const prev = previousMonthRange(todayKey);
  /** 月初盘点标成上月末；检查台认上月，不认日历本月。 */
  const inventoryMonthKey = prev.monthKey;
  const dayOfMonth = Number(todayKey.slice(8, 10));

  const [bodyMd, trainingMd, apple, steamText, assetMd, diaryDates, ankiSnapText] = await Promise.all([
    readText(path.join(root, BODY_RECORD)),
    readText(path.join(root, TRAINING_LOG)),
    readAppleHealthData(root),
    readText(path.join(root, STEAM_LIBRARY_JSON)),
    readText(path.join(root, ASSET_SOURCE)),
    collectDiaryCompleteDates(root, todayKey),
    readText(path.join(root, ANKI_SNAPSHOT_DERIVED)),
  ]);

  const health = parseHealth(bodyMd || "", trainingMd || "");
  const trainingDates = [...new Set((health.sessions || []).map((session) => session.date).filter(Boolean))].sort();
  const bodyDates = [...new Set(
    (health.measurements || [])
      .filter((row) => row.weightKg != null || row.waist != null)
      .map((row) => row.date),
  )].sort();

  const sleepDates = [...new Set(
    ((apple && Array.isArray(apple.daily) ? apple.daily : [])
      .filter((row) => (row.sleepMinutes != null && row.sleepMinutes > 0)
        || (row.asleepMinutes != null && row.asleepMinutes > 0))
      .map((row) => String(row.date || ""))
      .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))),
  )].sort();
  const appleDailyDates = [...new Set(
    ((apple && Array.isArray(apple.daily) ? apple.daily : [])
      .map((row) => String(row.date || ""))
      .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))),
  )].sort();
  const healthSource = appleHealthSourceReadiness(apple, todayKey);
  const autoSync = appleHealthAutoSyncStatus(apple, todayKey, clock.hour ?? 0);
  const [todayYear, todayMonth, todayDay] = todayKey.split("-").map(Number);
  const todayWeekday = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay)).getUTCDay();
  // 周一训练复盘与每月 1 日月报会消费整段 Apple Health；其它日子只展示日期，不催日更。
  const healthReviewDueToday = todayWeekday === 1 || todayDay === 1;
  const healthSourceAlarm = healthReviewDueToday && !healthSource.ready;

  const steam = steamPlayedRecently(steamText || "{}");
  let ankiAsOf = null;
  let ankiDetail = "还没有 Anki 定时快照";
  try {
    const snap = ankiSnapText ? JSON.parse(ankiSnapText) : null;
    const raw = String(snap?.syncedAt || snap?.tokyoDay || "");
    ankiAsOf = raw.match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
    if (ankiAsOf) {
      const reviews = snap?.dayReviews?.reviewCount;
      ankiDetail = `快照有效到 ${formatShortDate(ankiAsOf)}${reviews != null ? ` · 昨日复习 ${reviews} 次` : ""}`;
    }
  } catch {
    ankiAsOf = null;
  }

  const freshness = [
    {
      id: "apple-health-sync",
      label: "iPhone 自动同步",
      asOf: autoSync.lastSyncedDay,
      asOfLabel: formatShortDate(autoSync.lastSyncedDay),
      alarm: autoSync.alarm,
      detail: autoSync.detail,
    },
    {
      id: "diary",
      label: "日志（有工作强度+恢复）",
      asOf: latestDate(diaryDates),
      asOfLabel: formatShortDate(latestDate(diaryDates)),
      alarm: false,
      detail: latestDate(diaryDates) ? `有效到 ${formatShortDate(latestDate(diaryDates))}` : "还没有完整日评行",
    },
    {
      id: "apple-activity",
      label: "Apple 活动数据",
      asOf: latestDate(appleDailyDates),
      asOfLabel: formatShortDate(latestDate(appleDailyDates)),
      alarm: healthSourceAlarm,
      detail: healthSourceAlarm
        ? `${healthSource.detail}；相关周/月复盘暂停`
        : (latestDate(appleDailyDates)
          ? `步数、活动与心率导入 · 有效到 ${formatShortDate(latestDate(appleDailyDates))}`
          : "还没有 Apple 健康活动数据"),
    },
    {
      id: "apple-sleep",
      label: "睡眠数据",
      asOf: latestDate(sleepDates),
      asOfLabel: formatShortDate(latestDate(sleepDates)),
      alarm: healthSourceAlarm,
      detail: healthSourceAlarm
        ? `${healthSource.detail}；不能用旧睡眠概括新周期`
        : (latestDate(sleepDates)
          ? `苹果手表导入 · 有效到 ${formatShortDate(latestDate(sleepDates))}`
          : "当前导入里没有苹果手表睡眠数据"),
    },
    {
      id: "training",
      label: "身体训练日志",
      asOf: latestDate(trainingDates),
      asOfLabel: formatShortDate(latestDate(trainingDates)),
      alarm: false,
      detail: latestDate(trainingDates) ? `有效到 ${formatShortDate(latestDate(trainingDates))}` : "还没有训练记录",
    },
    {
      id: "body",
      label: "体重/腰围",
      asOf: latestDate(bodyDates),
      asOfLabel: formatShortDate(latestDate(bodyDates)),
      alarm: false,
      detail: latestDate(bodyDates) ? `有效到 ${formatShortDate(latestDate(bodyDates))}` : "还没有三维记录",
    },
    {
      id: "anki",
      label: "Anki 背词快照",
      asOf: ankiAsOf,
      asOfLabel: formatShortDate(ankiAsOf),
      alarm: false,
      detail: ankiDetail,
    },
    {
      id: "steam",
      label: "Steam 近两周",
      asOf: null,
      asOfLabel: steam.played ? "有碰" : "没碰",
      alarm: false,
      detail: steam.played
        ? `近两周约 ${Math.round(steam.minutes2weeks / 60 * 10) / 10} 小时（旁证；玩得怎样仍要问）`
        : "近两周 Steam 没碰（旁证；仍要问）",
    },
  ].map((row) => withFreshnessReady(row, todayKey));

  const weekElapsedDays = (() => {
    const days = [];
    let cursor = weekStart;
    while (cursor <= todayKey) {
      days.push(cursor);
      const [y, m, d] = cursor.split("-").map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      cursor = next.toISOString().slice(0, 10);
    }
    return days;
  })();
  const weekElapsed = weekElapsedDays.length;
  const weekTrainHave = countDatesInRange(trainingDates, weekStart, todayKey);
  const weekTrainLatest = latestInRange(trainingDates, weekStart, todayKey);
  const weekSleepHave = countDatesInRange(sleepDates, weekStart, todayKey);
  const weekSleepLatest = latestInRange(sleepDates, weekStart, todayKey);
  const sleepAsOf = latestDate(sleepDates);
  const weekSleepAlarmState = healthSourceAlarm
    ? { alarm: true, freshEnough: false, sourceStale: true }
    : weeklySleepAlarm(weekSleepHave, weekElapsed, {
      latestSleepKey: sleepAsOf,
      todayKey,
    });
  const weekSleepRed = weekSleepAlarmState.alarm;

  const askGameDay = (() => {
    const [y, m, d] = todayKey.split("-").map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return wd === 1 || wd === 3 || wd === 5;
  })();
  let gameAskDetail = "今天不用估游戏与情感";
  if (askGameDay) {
    gameAskDetail = "今天由日评自己估 · 前端不对再说";
  }

  const monthSleepHave = countDatesInRange(sleepDates, prev.days[0], prev.days[prev.days.length - 1]);
  const monthSleepLatest = latestInRange(sleepDates, prev.days[0], prev.days[prev.days.length - 1]);
  const monthSleepRed = coverageAlarm(monthSleepHave, prev.daysInMonth).alarm;

  let monthlyReviewExists = false;
  try {
    await fs.access(path.join(root, MONTHLY_REVIEW_DIR, `${prev.monthKey}.md`));
    monthlyReviewExists = true;
  } catch {
    monthlyReviewExists = false;
  }

  const snapshot = assetMd ? pickMonthAssetSnapshot(assetMd, inventoryMonthKey) : null;
  // 顶替快照（proxy）只为趋势不断档，不算真正完成上月末盘点
  const inventorySnapshot = snapshot && !snapshot._notThisMonth && snapshot.proxy !== true ? snapshot : null;
  // 没有上月末快照 → 余额项全缺；生活收支另看账单与口头确认（也按上月）
  const snapshotView = inventorySnapshot
    ? matchAssetChecklistSmart(inventorySnapshot)
    : matchAssetChecklistSmart(null);
  const billCoverage = await detectBillMonthCoverage(root, inventoryMonthKey);
  const largeOther = readLargeOtherPaymentConfirm(assetMd || "", inventoryMonthKey);
  const assetsView = applyCashflowChecklist(snapshotView, {
    wechat: billCoverage.wechat,
    paypay: billCoverage.paypay,
    alipay: billCoverage.alipay,
    largeOther: largeOther.present,
  });
  const assetPastDue = dayOfMonth >= ASSET_DUE_DAY;
  const assetsAlarm = assetPastDue && assetsView.missingCount > 0;
  const assetCycle = assetInventoryCycle(todayKey, assetsView.missingCount === 0);

  const coverage = {
    weekly: {
      weekStart,
      elapsedDays: weekElapsed,
      training: {
        id: "week-training",
        label: "本周身体训练",
        have: weekTrainHave,
        total: weekElapsed,
        asOf: weekTrainLatest,
        alarm: false,
        readyPercent: weekElapsed ? Math.round((100 * weekTrainHave) / weekElapsed) : 0,
        detail: weekTrainHave
          ? `${weekTrainHave} 天有记录 · 最新 ${formatShortDate(weekTrainLatest)}`
          : "本周还没有训练记录",
      },
      sleep: {
        id: "week-sleep",
        label: "本周睡眠数据",
        have: weekSleepHave,
        total: weekElapsed,
        asOf: weekSleepLatest || sleepAsOf,
        alarm: weekSleepRed,
        readyPercent: weekElapsed ? Math.round((100 * weekSleepHave) / weekElapsed) : 0,
        detail: (() => {
          if (weekSleepAlarmState.sourceStale) {
            return `${healthSource.detail}；训练复盘保持暂停`;
          }
          if (weekSleepHave) {
            return `${weekSleepHave}/${weekElapsed} 天有睡眠数据 · 有效到 ${formatShortDate(weekSleepLatest || sleepAsOf)}`;
          }
          if (weekSleepAlarmState.freshEnough && sleepAsOf) {
            return `睡眠有效到 ${formatShortDate(sleepAsOf)} · 本周从 ${formatShortDate(weekStart)} 起算，今天还没有醒来日数据（正常）`;
          }
          if (weekSleepRed) {
            return `睡眠有效到 ${formatShortDate(sleepAsOf)} · 本周仅 ${weekSleepHave}/${weekElapsed} 天`;
          }
          if (sleepAsOf) {
            return `睡眠有效到 ${formatShortDate(sleepAsOf)} · 本周从 ${formatShortDate(weekStart)} 起算，这几天还没有醒来日数据`;
          }
          return `本周 ${weekElapsed} 天里还没有睡眠数据`;
        })(),
      },
      gameAsk: {
        id: "week-game-ask",
        label: "游戏与情感",
        alarm: false,
        readyPercent: 100,
        detail: gameAskDetail,
      },
    },
    monthly: {
      prevMonthKey: prev.monthKey,
      daysInMonth: prev.daysInMonth,
      sleep: {
        id: "month-sleep",
        label: "上月睡眠覆盖",
        have: monthSleepHave,
        total: prev.daysInMonth,
        asOf: monthSleepLatest,
        alarm: monthSleepRed,
        readyPercent: Math.round((100 * monthSleepHave) / prev.daysInMonth),
        detail: monthSleepRed
          ? `${monthSleepHave}/${prev.daysInMonth} 天 · 有效到 ${formatShortDate(monthSleepLatest)}`
          : `${monthSleepHave}/${prev.daysInMonth} 天有睡眠数据 · 有效到 ${formatShortDate(monthSleepLatest)}`,
      },
      monthlyReviewExists,
      assets: {
        ...assetsView,
        inventoryMonthKey,
        cycle: assetCycle,
        pastDue: assetPastDue,
        alarm: assetsAlarm,
        detail: inventorySnapshot
          ? (assetsView.missingCount
            ? `缺 ${assetsView.missingCount} 项 · ${inventoryMonthKey} 月末快照写到 ${formatShortDate(assetsView.snapshotDate)}（实采可看资产页）`
            : `${inventoryMonthKey} 月末清单齐了 · 快照 ${formatShortDate(assetsView.snapshotDate)}`)
          : (assetPastDue
            ? `缺 ${assetsView.missingCount} 项 · 还没有 ${inventoryMonthKey} 月末快照`
            : `还没有 ${inventoryMonthKey} 月末快照（约 ${ASSET_DUE_DAY} 日前不强迫）`),
      },
    },
  };

  const materialAlarms = [
    autoSync.alarm,
    healthSourceAlarm,
    healthSourceAlarm,
    monthSleepRed,
    assetsAlarm,
  ].filter(Boolean).length;

  return {
    freshness,
    coverage,
    healthSource,
    materialAlarms,
    noteExtras: "每天 15:00 后检查 iPhone 自动同步；周一训练复盘会等 Apple Health 覆盖到截止日，月报缺覆盖时降级并注明缺口。",
  };
}

/**
 * @param {Array<{ status: string }>} tasks
 * @param {number} materialAlarms
 */
export function buildVerdict(tasks, materialAlarms) {
  const hardTask = tasks.some((task) => ["failed", "missed", "missing"].includes(task.status));
  const softTask = tasks.some((task) => ["pending", "running", "waiting"].includes(task.status));
  if (hardTask || materialAlarms > 0) {
    const bits = [];
    const failN = tasks.filter((task) => task.status === "failed" || task.status === "missed").length;
    const missN = tasks.filter((task) => task.status === "missing").length;
    if (failN) bits.push(`${failN} 个定时要看`);
    if (missN) bits.push(`${missN} 个未安装`);
    if (materialAlarms) bits.push(`${materialAlarms} 处原料缺口`);
    return { level: "red", label: bits.join(" · ") || "有要看一眼的" };
  }
  if (softTask) {
    return { level: "yellow", label: "有任务还没到点或正在跑" };
  }
  return { level: "green", label: "定时与原料看起来正常" };
}
