import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureInside } from "./workbench-data.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { ASSET_SOURCE as ASSET_SOURCE_PATH, FIXED_EXPENSES_FILE, BANK_INCOME_MEMO_FILE } from "./vault-paths.mjs";
import { importBillDownloadsToVault, readWechatCashflow } from "./workbench-wechat-bills.mjs";
import {
  applyCustodyOverlayToSnapshot,
  importSunxiangHoldingsToVault,
  readSunxiangCustody,
} from "./workbench-sunxiang-custody.mjs";
import { readInvestmentInstrumentSeries, readInvestmentLedger, readInvestmentPeriodPerformance } from "./workbench-investments.mjs";
import { readMarketLive } from "./workbench-live.mjs";

export const STABLE_JPY_TO_CNY = 0.047;

export const ASSET_SOURCE = ASSET_SOURCE_PATH;
export { FIXED_EXPENSES_FILE, BANK_INCOME_MEMO_FILE };

function emptyMemo(pathRelative, message) {
  return {
    schemaVersion: 1,
    updatedAt: "",
    note: "",
    path: pathRelative,
    available: false,
    message,
    sourceAccount: null,
    categories: {},
    totalsRough: null,
    incomeItems: [],
  };
}

async function readFixedExpenses(root) {
  const relative = FIXED_EXPENSES_FILE;
  const absolute = ensureInside(root, relative);
  try {
    const raw = await fsp.readFile(absolute, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return {
      schemaVersion: Number(parsed?.schemaVersion) || 1,
      updatedAt: String(parsed?.updatedAt ?? ""),
      note: String(parsed?.note ?? ""),
      path: relative,
      items: items.map((item) => ({
        id: String(item?.id ?? ""),
        name: String(item?.name ?? ""),
        kind: String(item?.kind ?? "one_time"),
        group: item?.group ? String(item.group) : undefined,
        subgroup: item?.subgroup ? String(item.subgroup) : undefined,
        amount: item?.amount != null && item.amount !== "" && Number.isFinite(Number(item.amount)) ? Number(item.amount) : null,
        currency: String(item?.currency ?? "CNY"),
        status: String(item?.status ?? ""),
        confirmedAt: item?.confirmedAt ? String(item.confirmedAt) : undefined,
        fromMonth: item?.fromMonth ? String(item.fromMonth) : undefined,
        fromDate: item?.fromDate ? String(item.fromDate) : undefined,
        eventMonth: item?.eventMonth ? String(item.eventMonth) : undefined,
        eventDate: item?.eventDate ? String(item.eventDate) : undefined,
        dueDay: Number.isFinite(Number(item?.dueDay)) ? Number(item.dueDay) : undefined,
        approximate: item?.approximate === true,
        note: item?.note ? String(item.note) : undefined,
      })),
      available: items.length > 0,
      message: items.length ? "" : "还没有固定开销备忘。",
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        schemaVersion: 1,
        updatedAt: "",
        note: "",
        path: relative,
        items: [],
        available: false,
        message: "还没有固定开销备忘。",
      };
    }
    return {
      schemaVersion: 1,
      updatedAt: "",
      note: "",
      path: relative,
      items: [],
      available: false,
      message: error instanceof Error ? error.message : "固定开销读失败",
    };
  }
}

function flattenBankIncome(parsed) {
  const categories = parsed?.categories && typeof parsed.categories === "object" ? parsed.categories : {};
  const incomeItems = [];
  for (const [key, bucket] of Object.entries(categories)) {
    if (!bucket || typeof bucket !== "object") continue;
    if (bucket.countAsIncome !== true) continue;
    const label = String(bucket.label ?? key);
    const items = Array.isArray(bucket.items) ? bucket.items : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const amount = Number(item.amount);
      if (!Number.isFinite(amount) || amount === 0) continue;
      incomeItems.push({
        id: `${key}:${item.date ?? ""}:${amount}:${item.counterparty ?? item.type ?? ""}`,
        categoryKey: key,
        categoryLabel: label,
        date: String(item.date ?? ""),
        amount,
        currency: "CNY",
        counterparty: item.counterparty ? String(item.counterparty) : undefined,
        type: item.type ? String(item.type) : undefined,
        note: item.note ? String(item.note) : undefined,
      });
    }
  }
  incomeItems.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return incomeItems;
}

async function readBankIncomeMemo(root) {
  const relative = BANK_INCOME_MEMO_FILE;
  const absolute = ensureInside(root, relative);
  try {
    const raw = await fsp.readFile(absolute, "utf8");
    const parsed = JSON.parse(raw);
    const incomeItems = flattenBankIncome(parsed);
    return {
      schemaVersion: Number(parsed?.schemaVersion) || 1,
      updatedAt: String(parsed?.updatedAt ?? ""),
      note: String(parsed?.note ?? ""),
      path: relative,
      available: incomeItems.length > 0,
      message: incomeItems.length ? "" : "还没有可计入的工行收入备忘。",
      sourceAccount: parsed?.sourceAccount
        ? {
            bank: String(parsed.sourceAccount.bank ?? ""),
            branch: parsed.sourceAccount.branch ? String(parsed.sourceAccount.branch) : undefined,
            last4: String(parsed.sourceAccount.last4 ?? ""),
            note: parsed.sourceAccount.note ? String(parsed.sourceAccount.note) : undefined,
          }
        : null,
      categories: parsed?.categories ?? {},
      totalsRough: parsed?.totalsRough ?? null,
      incomeItems,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return emptyMemo(relative, "还没有工行收入备忘。");
    }
    return emptyMemo(relative, error instanceof Error ? error.message : "工行收入备忘读失败");
  }
}
export const ASSET_SESSION_TTL_MS = 15 * 60 * 1000;
const ASSET_PASSWORD_SALT = "infans-asset-v1";
const DEFAULT_PASSWORD_FILE = path.join(os.homedir(), "Library", "Application Support", "com.infans.digitalsecretary", "asset-password.json");

/**
 * 临时开放资产页（2026-08-06 Capoo 要求，重建资产管理时免密）。
 * 恢复口令门：启动前设 INFANS_ASSET_REQUIRE_PASSWORD=1。
 */
export function isAssetOpenAccess(options = {}) {
  if (options.openAccess === true) return true;
  if (options.openAccess === false) return false;
  if (process.env.INFANS_ASSET_REQUIRE_PASSWORD === "1") return false;
  if (process.env.INFANS_ASSET_OPEN_ACCESS === "0") return false;
  return true;
}

export function hashAssetPassword(value) {
  return crypto.scryptSync(String(value ?? ""), ASSET_PASSWORD_SALT, 32).toString("hex");
}

export function assetPasswordFilePath(options = {}) {
  return options.passwordFilePath ?? DEFAULT_PASSWORD_FILE;
}

function writePasswordFileSync(filePath, hash) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ hash }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

function normalizedPasswordHash(value) {
  const hash = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

export function writeAssetPasswordHash(hash, options = {}) {
  const normalized = normalizedPasswordHash(hash);
  if (!normalized) throw new WorkbenchWriteError("解锁码设置有问题", 400, "ASSET_PASSWORD_HASH_INVALID");
  writePasswordFileSync(assetPasswordFilePath(options), normalized);
  return normalized;
}

export function resolveAssetPasswordHash(options = {}) {
  if (options.passwordHash) return normalizedPasswordHash(options.passwordHash);
  if (process.env.INFANS_ASSET_PASSWORD_HASH) return normalizedPasswordHash(process.env.INFANS_ASSET_PASSWORD_HASH);
  const filePath = assetPasswordFilePath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizedPasswordHash(parsed?.hash);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return null;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function summarizeSnapshot(snapshot) {
  const items = snapshot.items.slice(0, 100).map((item) => ({
    category: String(item.category ?? "未分类").slice(0, 40),
    name: String(item.name ?? "没写名字").slice(0, 100),
    currency: String(item.currency ?? "CNY").slice(0, 8),
    amount: safeNumber(item.amount),
    rateToCny: safeNumber(item.rateToCny),
    cnyValue: safeNumber(item.cnyValue),
    note: String(item.note ?? "").slice(0, 180),
  }));
  const totalAssets = items.reduce((sum, item) => sum + Math.max(0, item.cnyValue), 0);
  const totalLiabilities = items.reduce((sum, item) => sum + Math.abs(Math.min(0, item.cnyValue)), 0);
  const categoryMap = new Map();
  for (const item of items) categoryMap.set(item.category, (categoryMap.get(item.category) ?? 0) + item.cnyValue);
  const categories = [...categoryMap.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const proxy = snapshot?.proxy === true;
  return {
    date: String(snapshot.date ?? ""),
    capturedAt: String(snapshot.capturedAt ?? "").slice(0, 32) || undefined,
    sheet: String(snapshot.sheet ?? ""),
    proxy: proxy || undefined,
    proxyOf: proxy && snapshot?.proxyOf ? String(snapshot.proxyOf).slice(0, 32) : undefined,
    proxyNote: proxy && snapshot?.proxyNote ? String(snapshot.proxyNote).slice(0, 240) : undefined,
    items,
    totalAssets,
    totalLiabilities,
    netAssets: totalAssets - totalLiabilities,
    categories,
  };
}

export function parseAssetMarkdown(markdown) {
  const raw = String(markdown).match(/<!-- INFANS_ASSET_SNAPSHOT_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- INFANS_ASSET_SNAPSHOT_JSON_END -->/)?.[1];
  if (!raw) throw new WorkbenchWriteError("资产记录里没有可读的数据块", 500, "ASSET_DATA_INVALID");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new WorkbenchWriteError("读不懂这份资产记录", 500, "ASSET_DATA_INVALID"); }
  const snapshots = (Array.isArray(parsed.snapshots) ? parsed.snapshots : []).filter((snapshot) => Array.isArray(snapshot.items) && /^\d{4}-\d{2}-\d{2}$/.test(String(snapshot.date ?? ""))).map(summarizeSnapshot).sort((a, b) => a.date.localeCompare(b.date));
  if (!snapshots.length) throw new WorkbenchWriteError("这份资产记录是空的", 500, "ASSET_DATA_EMPTY");
  const sourceUrl = /^https:\/\/docs\.google\.com\/spreadsheets\//.test(String(parsed.source?.url ?? "")) ? String(parsed.source.url) : "";
  const stableJpyToCny = safeNumber(parsed.fx?.stableJpyToCny) || STABLE_JPY_TO_CNY;
  return {
    schemaVersion: Number(parsed.schemaVersion) || 1,
    source: { title: String(parsed.source?.title ?? "个人资产记录"), url: sourceUrl, googleUpdatedAt: String(parsed.source?.googleUpdatedAt ?? ""), syncedAt: String(parsed.source?.syncedAt ?? ""), path: ASSET_SOURCE },
    fx: {
      stableJpyToCny,
      stableNote: String(parsed.fx?.stableNote ?? "人工稳定汇率（与历史快照同口径）"),
    },
    snapshots,
    trend: snapshots.map((snapshot) => ({ date: snapshot.date, netAssets: snapshot.netAssets })),
  };
}

export async function readAssetData(root) {
  const markdown = await fsp.readFile(ensureInside(root, ASSET_SOURCE), "utf8");
  return parseAssetMarkdown(markdown);
}

export function createAssetAccessService(root, options = {}) {
  const sessions = new Map();
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? ASSET_SESSION_TTL_MS;
  const openAccess = isAssetOpenAccess(options);
  let passwordHash = null;
  try { passwordHash = resolveAssetPasswordHash(options); } catch { /* 资产模块单独失效，不拖垮整个工作台。 */ }
  let failures = 0;
  let blockedUntil = 0;

  function cleanSessions() {
    const current = now();
    for (const [token, expiresAt] of sessions) if (expiresAt <= current) sessions.delete(token);
  }

  function unlock(password) {
    if (openAccess) {
      const token = crypto.randomBytes(24).toString("base64url");
      const expiresAt = now() + ttlMs;
      sessions.set(token, expiresAt);
      return { token, expiresAt, openAccess: true };
    }
    const current = now();
    if (!passwordHash) throw new WorkbenchWriteError("还没设解锁码，请先在这台电脑上运行 pnpm asset-password", 503, "ASSET_PASSWORD_NOT_CONFIGURED");
    if (blockedUntil > current) throw new WorkbenchWriteError("试太多次了，等一会儿再试", 429, "ASSET_UNLOCK_THROTTLED");
    const supplied = Buffer.from(hashAssetPassword(password), "hex");
    const expected = Buffer.from(passwordHash, "hex");
    const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!valid) {
      failures += 1;
      if (failures >= 5) { blockedUntil = current + 30_000; failures = 0; }
      throw new WorkbenchWriteError("密码不正确", 401, "ASSET_PASSWORD_INVALID");
    }
    failures = 0;
    cleanSessions();
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = current + ttlMs;
    sessions.set(token, expiresAt);
    return { token, expiresAt, openAccess: false };
  }

  function requireSession(token) {
    if (openAccess) return now() + ttlMs;
    cleanSessions();
    const expiresAt = sessions.get(String(token ?? ""));
    if (!expiresAt) throw new WorkbenchWriteError("已经锁上了，请重新解锁", 401, "ASSET_LOCKED");
    return expiresAt;
  }

  async function read(token) {
    const expiresAt = requireSession(token);
    const [assets, cashflow, custody, fixedExpenses, bankIncome, live] = await Promise.all([
      readAssetData(root),
      readWechatCashflow(root).catch((error) => ({
        schemaVersion: 1,
        currency: "CNY",
        sourceLabel: "微信支付账单",
        sourceDir: "80_生活事务/生活账单",
        sources: [],
        transactionCount: 0,
        latestMonth: "",
        years: [],
        months: [],
        trend: [],
        ledgerByMonth: {},
        available: false,
        message: error instanceof Error ? error.message : "微信账单读失败",
      })),
      readSunxiangCustody(root).catch((error) => ({
        available: false,
        message: error instanceof Error ? error.message : "代持表读失败",
        googleSheetUrl: "",
        source: null,
        overlayItems: [],
      })),
      readFixedExpenses(root),
      readBankIncomeMemo(root),
      readMarketLive().catch(() => null),
    ]);

    const liveJpy = Array.isArray(live?.fx)
      ? live.fx.find((row) => row.pair === "JPY/CNY" || /日元/.test(String(row.label ?? "")))
      : null;
    const liveJpyToCny = Number(liveJpy?.value);
    const liveAvailable = Boolean(live?.available && Number.isFinite(liveJpyToCny) && liveJpyToCny > 0);
    const stableJpyToCny = assets.fx?.stableJpyToCny ?? STABLE_JPY_TO_CNY;
    const currentJpyToCny = liveAvailable ? liveJpyToCny : stableJpyToCny;
    const currentFxSource = liveAvailable ? "live" : "stable-fallback";
    const investments = await readInvestmentLedger(root, { jpyToCny: currentJpyToCny }).catch((error) => ({
      schemaVersion: 1,
      baseCurrency: "CNY",
      source: { title: "投资账本", asOf: "", path: "" },
      coverage: { status: "partial", from: "", to: "", note: "", missing: [] },
      accounts: [],
      instruments: [],
      transactions: [],
      positionSnapshots: [],
      summary: { tradeCount: 0, buyCount: 0, sellCount: 0, buyQuantity: 0, sellQuantity: 0, netQuantity: 0, buyGross: 0, sellGross: 0, feesKnown: false, taxesKnown: false },
      reconciliations: [],
      returns: { available: false, reasons: ["投资账本尚未接入"] },
      warnings: [],
      available: false,
      message: error instanceof Error ? error.message : "投资账本读取失败",
    }));

    let snapshots = assets.snapshots;
    if (custody?.available && snapshots.length) {
      const latestIndex = snapshots.length - 1;
      snapshots = snapshots.map((snapshot, index) => {
        if (index !== latestIndex) return snapshot;
        const hasCustodyLines = snapshot.items.some((item) =>
          /美股投资（委托代持|基金产品（委托代持/.test(String(item.name ?? "")),
        );
        return hasCustodyLines ? applyCustodyOverlayToSnapshot(snapshot, custody, { jpyToCny: currentJpyToCny }) : snapshot;
      });
    }

    const fx = {
      ...(assets.fx ?? { stableJpyToCny: STABLE_JPY_TO_CNY, stableNote: "人工稳定汇率" }),
      liveJpyToCny: Number.isFinite(liveJpyToCny) && liveJpyToCny > 0 ? liveJpyToCny : null,
      liveUpdatedAt: live?.refreshedAt || live?.updatedAt || null,
      liveAvailable,
      currentJpyToCny,
      currentSource: currentFxSource,
      currentUpdatedAt: liveAvailable ? live?.refreshedAt || live?.updatedAt || null : assets.source?.asOf || null,
    };

    return {
      ...assets,
      fx,
      snapshots,
      trend: snapshots.map((snapshot) => ({ date: snapshot.date, netAssets: snapshot.netAssets })),
      openAccess,
      cashflow,
      custody,
      investments,
      fixedExpenses,
      bankIncome,
      sessionExpiresAt: openAccess ? null : new Date(expiresAt).toISOString(),
    };
  }

  function lock(token) {
    if (openAccess) return { locked: false, openAccess: true };
    sessions.delete(String(token ?? ""));
    return { locked: true, openAccess: false };
  }

  async function importBillDownloads(token, body = {}) {
    requireSession(token);
    return importBillDownloadsToVault(root, {
      channels: Array.isArray(body.channels) ? body.channels : undefined,
    });
  }

  async function importCustodyDownloads(token) {
    requireSession(token);
    return importSunxiangHoldingsToVault(root);
  }

  async function readInvestmentSeries(token, instrumentId) {
    requireSession(token);
    return readInvestmentInstrumentSeries(root, String(instrumentId || "").slice(0, 100));
  }

  async function readInvestmentPerformance(token, query = {}) {
    requireSession(token);
    return readInvestmentPeriodPerformance(root, {
      from: String(query.from || "").slice(0, 16),
      to: String(query.to || "").slice(0, 16),
    });
  }

  return { unlock, read, lock, importBillDownloads, importCustodyDownloads, readInvestmentSeries, readInvestmentPerformance, requireSession, openAccess };
}
