import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ANKI_SNAPSHOT_DERIVED } from "./vault-paths.mjs";
import { isPublicLanguageDemo } from "./workbench-public-demo.mjs";

const ANKI_URL = "http://127.0.0.1:8765";
const BTN = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
const MAX_WORD_LIST = 80;
const MAX_HARD_LIST = 20;
const ANKI_OPEN_WAIT_MS = 90_000;
const ANKI_OPEN_INTERVAL_MS = 1_500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function invoke(action, params = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(ANKI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, params }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

function tokyoDayBounds(day, rolloverHour = 4) {
  const match = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("日期须为 YYYY-MM-DD");
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // Anki 日界默认本地 04:00；东京 = UTC+9
  const start = Date.UTC(y, m - 1, d, rolloverHour - 9, 0, 0);
  const end = start + 24 * 60 * 60 * 1000;
  return { startMs: start, endMs: end };
}

function tokyoYesterday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  let y = Number(get("year"));
  let m = Number(get("month"));
  let d = Number(get("day"));
  // 未过 Anki 日界 04:00 时，「昨天」再往前一天
  const base = new Date(Date.UTC(y, m - 1, d));
  if (hour < 4) base.setUTCDate(base.getUTCDate() - 1);
  base.setUTCDate(base.getUTCDate() - 1);
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(base.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function tokyoTodayKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function summarizeAnkiReviewRows(rows = []) {
  const unique = new Map();
  for (const row of rows || []) {
    if (!Array.isArray(row) || row[0] == null) continue;
    unique.set(String(row[0]), row);
  }
  const reviews = [...unique.values()];
  const durationMinutes = Math.round(reviews.reduce((sum, row) => sum + Math.max(0, Number(row[7]) || 0), 0) / 6000) / 10;
  return { reviews, reviewCount: reviews.length, durationMinutes };
}

function stripHtml(text = "") {
  return String(text)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldValue(fields, name) {
  const raw = fields?.[name];
  const value = raw && typeof raw === "object" ? raw.value : raw;
  return stripHtml(value || "");
}

function snapshotPath(vaultRoot) {
  return path.join(path.resolve(vaultRoot), ANKI_SNAPSHOT_DERIVED);
}

function defaultOpenAnkiApp() {
  return new Promise((resolve, reject) => {
    const child = spawn("open", ["-a", "Anki"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`打开 Anki 失败（退出码 ${code}）`));
    });
  });
}

/**
 * 定时快照专用：AnkiConnect 不通时先打开桌面端，再等到插件就绪。
 * 语言页实时查询不要走这条，避免一打开页面就弹 Anki。
 */
export async function ensureAnkiConnectReady(options = {}) {
  const ping = options.ping || (() => invoke("version", {}, 2000));
  const openAnki = options.openAnki || defaultOpenAnkiApp;
  const waitMs = options.waitMs ?? (Number(process.env.INFANS_ANKI_OPEN_WAIT_MS) || ANKI_OPEN_WAIT_MS);
  const intervalMs = options.intervalMs ?? ANKI_OPEN_INTERVAL_MS;
  const skipOpen = options.skipOpen ?? process.env.INFANS_ANKI_OPEN === "0";
  const platform = options.platform ?? process.platform;

  try {
    await ping();
    return { ready: true, launched: false };
  } catch {
    // 还没起来
  }

  let launched = false;
  if (!skipOpen && platform === "darwin") {
    try {
      await openAnki();
      launched = true;
    } catch {
      launched = false;
    }
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    try {
      await ping();
      return { ready: true, launched };
    } catch {
      // 继续等启动 / 读库 / 插件加载
    }
  }
  return { ready: false, launched };
}

export async function readAnkiSnapshotFile(vaultRoot) {
  try {
    const raw = await fs.readFile(snapshotPath(vaultRoot), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 开源示例牌组：首页 / 语言页词汇进度用。不要写作者私人牌组名。 */
export const DEMO_JLPT_DECK_ROOT = "JLPT::示例词汇";
export const JLPT_VOCAB_DECKS = [
  { name: "N5", deck: `${DEMO_JLPT_DECK_ROOT}::1-N5`, inPlan: false },
  { name: "N4", deck: `${DEMO_JLPT_DECK_ROOT}::2-N4`, inPlan: false },
  { name: "N3 高频", deck: `${DEMO_JLPT_DECK_ROOT}::3-N3::1-高频`, inPlan: true },
  { name: "N3 中频", deck: `${DEMO_JLPT_DECK_ROOT}::3-N3::2-中频`, inPlan: true },
  { name: "N3 低频", deck: `${DEMO_JLPT_DECK_ROOT}::3-N3::3-低频`, inPlan: true },
  { name: "N2 高频", deck: `${DEMO_JLPT_DECK_ROOT}::4-N2::1-高频`, inPlan: true },
  { name: "N2 中频", deck: `${DEMO_JLPT_DECK_ROOT}::4-N2::2-中频`, inPlan: true },
  { name: "N2 低频", deck: `${DEMO_JLPT_DECK_ROOT}::4-N2::3-低频`, inPlan: false },
  { name: "N1 全部", deck: `${DEMO_JLPT_DECK_ROOT}::5-N1`, inPlan: false },
];

const VOCAB_PROGRESS_CACHE_TTL_MS = 30_000;
let vocabProgressCache = null;

function ankiProgressEnabled(vaultRoot = null) {
  if (process.env.INFANS_ANKI_PROGRESS === "0") return false;
  if (process.env.INFANS_ANKI_PROGRESS === "1") return true;
  if (isPublicLanguageDemo(vaultRoot)) return false;
  return true;
}

function levelStatus(learned, total) {
  if (!total) return "—";
  if (learned >= total) return "✅ 完成";
  if (learned <= 0) return "待推进";
  if (learned / total >= 0.8) return "收尾中";
  return "进行中";
}

/** 由牌组进度推一句话阶段（给首页卡用）。 */
export function deriveJapaneseStageFromLevels(levels = []) {
  const byName = new Map(levels.map((row) => [row.name, row]));
  const n3Low = byName.get("N3 低频");
  const n2Hi = byName.get("N2 高频");
  const n2Mid = byName.get("N2 中频");
  if (n3Low && n3Low.learned < n3Low.total) {
    return n2Hi?.learned > 0
      ? "词汇线：N3 低频收尾 + N2 高频已启动。"
      : "词汇线：N3 低频收尾中。";
  }
  if (n2Hi && n2Hi.learned < n2Hi.total) {
    return "词汇线：N3 已清完，N2 高频推进中。";
  }
  if (n2Mid && n2Mid.learned < n2Mid.total) {
    return n2Mid.learned > 0
      ? "词汇线：N2 中频推进中。"
      : "词汇线：N2 高频已清完，中频待启动。";
  }
  return "词汇线：N2 计划范围已学完，进入巩固。";
}

/** 按 Anki 04:00 东京日界算连续学习天；今天还没刷也不打断。 */
export function streakFromReviewDays(byDay, now = new Date()) {
  const map = new Map();
  for (const row of byDay || []) {
    const day = Array.isArray(row) ? row[0] : row?.day;
    const count = Number(Array.isArray(row) ? row[1] : row?.count);
    if (day && count > 0) map.set(String(day), count);
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  let y = get("year");
  let m = get("month");
  let d = get("day");
  if (get("hour") < 4) {
    const prev = new Date(Date.UTC(y, m - 1, d));
    prev.setUTCDate(prev.getUTCDate() - 1);
    y = prev.getUTCFullYear();
    m = prev.getUTCMonth() + 1;
    d = prev.getUTCDate();
  }
  const key = (yy, mm, dd) => `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  let cursor = new Date(Date.UTC(y, m - 1, d));
  if (!map.get(key(y, m, d))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (map.get(key(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

/** 最近 N 个已经结束的 Anki 日，按自然日含 0 天计算答题次数日均。 */
export function reviewPaceFromReviewDays(byDay, days = 7, now = new Date()) {
  const count = Math.max(1, Math.floor(Number(days) || 7));
  const map = new Map((byDay || []).map((row) => [
    String(Array.isArray(row) ? row[0] : row?.day || ""),
    Number(Array.isArray(row) ? row[1] : row?.count) || 0,
  ]));
  const endKey = tokyoYesterday(now);
  const [year, month, day] = endKey.split("-").map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day));
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const key = cursor.toISOString().slice(0, 10);
    total += map.get(key) || 0;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return Math.round((total / count) * 10) / 10;
}

async function countQuery(query, timeout = 15000) {
  const ids = await invoke("findCards", { query }, timeout);
  return Array.isArray(ids) ? ids.length : 0;
}

/** 按牌组串行拉进度，避免一次打爆 AnkiConnect。 */
async function fetchLiveVocabProgress() {
  const levels = [];
  let queue = 0;
  let planLearned = 0;
  let planTotal = 0;
  let intro7 = 0;
  let intro14 = 0;

  for (const item of JLPT_VOCAB_DECKS) {
    const deckQ = `deck:"${item.deck}"`;
    const [total, learned, due, learning] = await Promise.all([
      countQuery(deckQ),
      countQuery(`${deckQ} -is:new`),
      countQuery(`${deckQ} is:due`),
      countQuery(`${deckQ} is:learn`),
    ]);
    let introduced7 = 0;
    let introduced14 = 0;
    if (item.inPlan) {
      [introduced7, introduced14] = await Promise.all([
        countQuery(`${deckQ} introduced:7`),
        countQuery(`${deckQ} introduced:14`),
      ]);
    }
    levels.push({
      name: item.name,
      deck: item.deck,
      total,
      learned,
      status: levelStatus(learned, total),
    });
    queue += due + learning;
    if (item.inPlan) {
      planLearned += learned;
      planTotal += total;
      intro7 += introduced7;
      intro14 += introduced14;
    }
  }

  const byDay = await invoke("getNumCardsReviewedByDay", {}, 15000);
  const reviewPace7 = reviewPaceFromReviewDays(byDay, 7);
  const checkedAt = new Date().toISOString();
  const tokyoDay = tokyoTodayKey();
  return {
    available: true,
    live: true,
    source: "live",
    checkedAt,
    updatedAt: `${tokyoDay}（Anki 实时）`,
    stage: deriveJapaneseStageFromLevels(levels),
    progress: planTotal ? { learned: planLearned, total: planTotal } : null,
    queue,
    streak: streakFromReviewDays(byDay),
    pace7: Math.round((intro7 / 7) * 10) / 10,
    pace14: Math.round((intro14 / 14) * 10) / 10,
    reviewPace7,
    newCardPace7: Math.round((intro7 / 7) * 10) / 10,
    newCardPace14: Math.round((intro14 / 14) * 10) / 10,
    levels,
    message: "来自本机 AnkiConnect。",
  };
}

/**
 * 词汇进度：优先实时 Anki，否则用该库里的定时快照。
 * 测例可设 INFANS_ANKI_PROGRESS=0，避免本机 Anki 污染 fixture。
 */
export async function readAnkiVocabProgress(vaultRoot = null) {
  if (!ankiProgressEnabled(vaultRoot)) return null;
  const root = vaultRoot ? path.resolve(vaultRoot) : null;
  const now = Date.now();
  if (
    vocabProgressCache
    && vocabProgressCache.root === root
    && vocabProgressCache.value
    && (now - vocabProgressCache.at) < VOCAB_PROGRESS_CACHE_TTL_MS
  ) {
    return vocabProgressCache.value;
  }

  let value = null;
  try {
    value = await fetchLiveVocabProgress();
  } catch {
    const snap = root ? await readAnkiSnapshotFile(root) : null;
    const progress = snap?.vocabProgress;
    if (progress?.available && progress.progress) {
      value = {
        ...progress,
        available: true,
        live: false,
        source: "snapshot",
        checkedAt: new Date().toISOString(),
        snapshotAt: snap.syncedAt || progress.checkedAt || null,
        updatedAt: snap.syncedAt
          ? `${String(snap.syncedAt).slice(0, 10)}（Anki 快照）`
          : (progress.updatedAt || "Anki 快照"),
        message: "Anki 未打开，用定时快照里的词汇进度。",
      };
    }
  }

  // 失败（null）不缓存，避免 Anki 刚醒还被 30 秒空结果挡住。
  if (value) vocabProgressCache = { root, at: now, value };
  return value;
}

/** 把 Anki 词汇进度盖进 parseJapanese 的结果（有数才盖）。 */
export function applyAnkiVocabProgress(japanese, progress) {
  if (!japanese || !progress?.available || !progress.progress) return japanese;
  return {
    ...japanese,
    updatedAt: progress.updatedAt || japanese.updatedAt,
    stage: progress.stage || japanese.stage,
    progress: progress.progress,
    queue: progress.queue ?? japanese.queue,
    streak: progress.streak ?? japanese.streak,
    pace7: progress.pace7 ?? japanese.pace7,
    pace14: progress.pace14 ?? japanese.pace14,
    reviewPace7: progress.reviewPace7 ?? japanese.reviewPace7,
    newCardPace7: progress.newCardPace7 ?? progress.pace7 ?? japanese.newCardPace7,
    newCardPace14: progress.newCardPace14 ?? progress.pace14 ?? japanese.newCardPace14,
    levels: Array.isArray(progress.levels) && progress.levels.length ? progress.levels : japanese.levels,
    ankiSource: progress.source || null,
  };
}

export async function readAnkiStatus(vaultRoot = null) {
  if (!ankiProgressEnabled(vaultRoot)) {
    return {
      available: false,
      live: false,
      checkedAt: new Date().toISOString(),
      message: "当前显示示例进度，还没有接上你自己的 Anki。",
      source: "none",
    };
  }
  try {
    const [version, reviewedToday, deckNames] = await Promise.all([
      invoke("version"),
      invoke("getNumCardsReviewedToday"),
      invoke("deckNames"),
    ]);
    const targetDecks = deckNames.filter((name) => String(name).startsWith(DEMO_JLPT_DECK_ROOT));
    return {
      available: true,
      live: true,
      version,
      reviewedToday,
      decks: targetDecks,
      checkedAt: new Date().toISOString(),
      message: "AnkiConnect 已连接；工作台不会修改卡片或设置。",
      source: "live",
    };
  } catch {
    const snap = vaultRoot ? await readAnkiSnapshotFile(vaultRoot) : null;
    const status = snap?.status;
    if (status) {
      return {
        ...status,
        available: true,
        live: false,
        checkedAt: new Date().toISOString(),
        snapshotAt: snap.syncedAt || status.checkedAt || null,
        message: `Anki 未打开，显示 ${snap.syncedAt ? `定时快照（${String(snap.syncedAt).slice(0, 16).replace("T", " ")}）` : "上次快照"}。`,
        source: "snapshot",
      };
    }
    return {
      available: false,
      live: false,
      checkedAt: new Date().toISOString(),
      message: "Anki 未打开或 AnkiConnect 暂不可用，也还没有定时快照。",
      source: "none",
    };
  }
}

/** 按 Anki 日界（默认东京 04:00）汇总某日复习；供 AI 上下文与调试。 */
export async function readAnkiDayReviews(day = tokyoYesterday(), vaultRoot = null) {
  if (!ankiProgressEnabled(vaultRoot)) {
    return {
      available: false,
      live: false,
      day,
      reviewCount: 0,
      durationMinutes: null,
      message: "示例进度不读取本机 Anki 复习。",
      source: "none",
    };
  }
  try {
    const { startMs, endMs } = tokyoDayBounds(day);
    const targets = [];
    for (const deck of JLPT_VOCAB_DECKS.map((item) => item.deck)) {
      const latest = await invoke("getLatestReviewID", { deck });
      if (latest && latest > 0) targets.push(deck);
    }

    const reviews = [];
    for (const deck of targets) {
      const rows = await invoke("cardReviews", { deck, startID: startMs - 1 });
      for (const row of rows || []) {
        if (row[0] >= startMs && row[0] < endMs) reviews.push(row);
      }
    }

    const summarized = summarizeAnkiReviewRows(reviews);
    const uniqueReviews = summarized.reviews;
    const cardIds = [...new Set(uniqueReviews.map((row) => row[1]))];
    const byCard = new Map();
    for (const row of uniqueReviews) {
      const list = byCard.get(row[1]) || [];
      list.push(row[3]);
      byCard.set(row[1], list);
    }

    const infos = [];
    for (let i = 0; i < cardIds.length; i += 200) {
      infos.push(...(await invoke("cardsInfo", { cards: cardIds.slice(i, i + 200) })));
    }

    const words = infos.map((info) => {
      const word = fieldValue(info.fields, "VocabKanji");
      const reading = fieldValue(info.fields, "VocabFurigana") || fieldValue(info.fields, "VocabPitch");
      const meaning = fieldValue(info.fields, "VocabDefSC") || fieldValue(info.fields, "VocabDefTC");
      const buttons = byCard.get(info.cardId) || [];
      const worst = buttons.length ? Math.min(...buttons) : null;
      const deckLeaf = String(info.deckName || "").split("::").slice(-2).join("/");
      return {
        word,
        reading,
        meaning: meaning.length > 60 ? `${meaning.slice(0, 57)}...` : meaning,
        deck: deckLeaf,
        button: BTN[worst] || "",
      };
    });

    words.sort((a, b) => a.deck.localeCompare(b.deck, "ja") || a.word.localeCompare(b.word, "ja"));
    const hard = words.filter((item) => item.button === "Hard" || item.button === "Again");
    const buttonCounts = { Again: 0, Hard: 0, Good: 0, Easy: 0 };
    for (const row of uniqueReviews) {
      const name = BTN[row[3]];
      if (name) buttonCounts[name] += 1;
    }
    const byDeck = {};
    for (const item of words) {
      byDeck[item.deck] = (byDeck[item.deck] || 0) + 1;
    }

    const first = uniqueReviews.length ? Math.min(...uniqueReviews.map((row) => row[0])) : null;
    const last = uniqueReviews.length ? Math.max(...uniqueReviews.map((row) => row[0])) : null;
    const fmt = (ms) => (ms == null ? null : new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));

    return {
      available: true,
      live: true,
      day,
      reviewCount: summarized.reviewCount,
      durationMinutes: summarized.durationMinutes,
      uniqueCards: words.length,
      buttonCounts,
      byDeck,
      timeRange: first || last ? `${fmt(first)}–${fmt(last)}` : null,
      hard: hard.slice(0, MAX_HARD_LIST),
      words: words.slice(0, MAX_WORD_LIST),
      truncated: words.length > MAX_WORD_LIST,
      checkedAt: new Date().toISOString(),
      message: uniqueReviews.length ? `已汇总 ${day} 的复习记录。` : `${day} 无复习记录（或牌组无 cardReviews）。`,
      source: "live",
    };
  } catch (error) {
    const snap = vaultRoot ? await readAnkiSnapshotFile(vaultRoot) : null;
    const dayReview = snap?.todayReviews?.day === day ? snap.todayReviews : snap?.dayReviews;
    if (dayReview && String(dayReview.day || "") === String(day)) {
      return {
        ...dayReview,
        available: true,
        live: false,
        checkedAt: new Date().toISOString(),
        snapshotAt: snap.syncedAt || null,
        message: `Anki 未打开，用定时快照里的 ${day} 复习。`,
        source: "snapshot",
      };
    }
    return {
      available: false,
      live: false,
      day,
      reviewCount: 0,
      durationMinutes: null,
      uniqueCards: 0,
      buttonCounts: { Again: 0, Hard: 0, Good: 0, Easy: 0 },
      byDeck: {},
      timeRange: null,
      hard: [],
      words: [],
      truncated: false,
      checkedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "AnkiConnect 暂不可用",
      source: "none",
    };
  }
}

/**
 * 拉一次 AnkiConnect 并写入派生快照。不通时先打开 Anki 再等；仍失败则保留旧文件。
 * @returns {Promise<{ ok: boolean; keptOld?: boolean; path: string; message: string; syncedAt?: string; launchedAnki?: boolean }>}
 */
export async function syncAnkiSnapshot(vaultRoot) {
  const root = path.resolve(vaultRoot);
  const outPath = snapshotPath(root);
  const day = tokyoYesterday();
  const todayKey = tokyoTodayKey();
  const boot = await ensureAnkiConnectReady();

  let liveStatus;
  let liveDay;
  let liveVocab;
  let liveToday;
  try {
    const [version, reviewedToday, deckNames] = await Promise.all([
      invoke("version"),
      invoke("getNumCardsReviewedToday"),
      invoke("deckNames"),
    ]);
    liveStatus = {
      available: true,
      live: true,
      version,
      reviewedToday,
      decks: deckNames.filter((name) => String(name).startsWith(DEMO_JLPT_DECK_ROOT)),
      checkedAt: new Date().toISOString(),
      message: "AnkiConnect 已连接；工作台不会修改卡片或设置。",
      source: "live",
    };
    [liveDay, liveToday] = await Promise.all([
      readAnkiDayReviews(day, null),
      readAnkiDayReviews(todayKey, null),
    ]);
    if (!liveDay.available) throw new Error(liveDay.message || "按日复习拉失败");
    liveVocab = await fetchLiveVocabProgress();
  } catch (error) {
    const old = await readAnkiSnapshotFile(root);
    const why = boot.launched
      ? "已打开 Anki，但 AnkiConnect 仍连不上"
      : "Anki 未开或 AnkiConnect 暂不可用";
    return {
      ok: true,
      keptOld: Boolean(old),
      path: outPath,
      launchedAnki: boot.launched,
      message: old
        ? `${why}，已保留旧快照（${old.syncedAt || "无时间"}）`
        : `${why}，还没有旧快照：${error instanceof Error ? error.message : error}`,
      syncedAt: old?.syncedAt || null,
    };
  }

  const payload = {
    schemaVersion: 2,
    syncedAt: new Date().toISOString(),
    tokyoDay: todayKey,
    yesterdayKey: day,
    status: {
      ...liveStatus,
      live: false,
      source: "snapshot",
      message: "来自每日定时快照。",
    },
    dayReviews: {
      ...liveDay,
      live: false,
      source: "snapshot",
    },
    todayReviews: {
      ...liveToday,
      live: false,
      source: "snapshot",
    },
    vocabProgress: {
      ...liveVocab,
      live: false,
      source: "snapshot",
      message: "来自每日定时快照。",
    },
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  vocabProgressCache = null;
  return {
    ok: true,
    keptOld: false,
    path: outPath,
    launchedAnki: boot.launched,
    message: `快照已写 · 昨日 ${day} 复习 ${liveDay.reviewCount} 次 · 今日已答 ${liveStatus.reviewedToday ?? 0} · 计划进度 ${liveVocab.progress?.learned ?? "—"}/${liveVocab.progress?.total ?? "—"}${boot.launched ? " · 已先打开 Anki" : ""}`,
    syncedAt: payload.syncedAt,
  };
}

export function formatAnkiDayReviewsForAi(summary) {
  if (!summary?.available) {
    return `Anki 按日复习：不可用（${summary?.message || "离线"}）。`;
  }
  const hardLines = (summary.hard || [])
    .map((item) => `- ${item.word}（${item.reading}）${item.meaning} [${item.deck}] ${item.button}`)
    .join("\n") || "- 无";
  const wordLines = (summary.words || [])
    .map((item) => `- ${item.word}｜${item.reading}｜${item.meaning}${item.button && item.button !== "Easy" ? ` ⚠${item.button}` : ""}`)
    .join("\n");
  const deckLines = Object.entries(summary.byDeck || {})
    .map(([deck, count]) => `- ${deck}: ${count}`)
    .join("\n") || "- 无";
  const sourceNote = summary.source === "snapshot" ? "（定时快照）" : "";
  return [
    `Anki 按日复习（Anki 日界 04:00 东京）${sourceNote} · ${summary.day}`,
    `复习 ${summary.reviewCount} 次 / ${summary.uniqueCards} 张；时段 ${summary.timeRange || "—"}`,
    `按钮：Again ${summary.buttonCounts?.Again ?? 0} · Hard ${summary.buttonCounts?.Hard ?? 0} · Good ${summary.buttonCounts?.Good ?? 0} · Easy ${summary.buttonCounts?.Easy ?? 0}`,
    `牌组分布：\n${deckLines}`,
    `Hard/Again：\n${hardLines}`,
    summary.truncated ? `词表（截断前 ${MAX_WORD_LIST} 张）：\n${wordLines}` : `词表：\n${wordLines || "- 无"}`,
  ].join("\n");
}

export { tokyoYesterday, tokyoTodayKey };
