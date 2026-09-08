import { execFile } from "node:child_process";
import { promisify } from "node:util";

const STEAM_KEYCHAIN_SERVICE = "Infans Steam Web API";
const execFileAsync = promisify(execFile);

/** @type {{ at: number, value: unknown } | null} */
let steamCache = null;
/** @type {{ at: number, value: unknown } | null} */
let steamWishlistCache = null;

export function parseSteamCredentials(markdown = "") {
  const text = String(markdown);
  const steamid = text.match(/SteamID\s*`?(7656119\d{10})`?/)?.[1]
    || text.match(/\b(7656119\d{10})\b/)?.[1]
    || "";
  const key = text.match(/Steam Web API Key\s*\|\s*[^|\n]*\|\s*([A-Fa-f0-9]{32})\s*\|/)?.[1]
    || "";
  return { steamid, key };
}

export function hoursFromSteamMinutes(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value / 60 * 10) / 10;
}

export async function readSteamApiKey({ execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl("/usr/bin/security", [
      "find-generic-password",
      "-s", STEAM_KEYCHAIN_SERVICE,
      "-w",
    ], { timeout: 5_000, maxBuffer: 16_384 });
    const key = String(stdout || "").trim();
    if (!/^[A-Fa-f0-9]{32}$/.test(key)) throw new Error("invalid key");
    return key;
  } catch {
    throw new Error("还没有配置 Steam Web API 密钥。");
  }
}

function unavailable(message) {
  return {
    available: false,
    persona: "",
    playing: null,
    gameCount: 0,
    hours2weeks: 0,
    games: [],
    refreshedAt: null,
    message,
  };
}

/**
 * 开源示例不代查真实 Steam 账号。
 */
export async function readSteamLive(_vaultRoot, _options = {}) {
  return unavailable("开源示例没有实时 Steam 接口。馆藏来自本地示意清单。");
}

export function parseStoreDate(dateLabel) {
  const label = String(dateLabel || "").trim();
  const exact = label.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/u);
  if (exact) {
    const [, year, month, day] = exact;
    return {
      kind: "confirmed",
      date: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
      label,
    };
  }
  if (!label || /待定|即将推出|即将宣布|未定|to be announced|coming soon/i.test(label)) {
    return { kind: "tbd", date: null, label: label || "日期待定" };
  }
  return { kind: "window", date: null, label };
}

function steamWishlistUnavailable(message) {
  return {
    available: false,
    accountLabel: "",
    totalWishlistCount: 0,
    upcomingCount: 0,
    releasedCount: 0,
    unresolvedCount: 0,
    items: [],
    refreshedAt: null,
    sourceLabel: "Steam 愿望单",
    message,
  };
}

/**
 * 开源示例不读取 Steam 愿望单。
 */
export async function readSteamWishlistReleases(_vaultRoot, _options = {}) {
  return steamWishlistUnavailable("开源示例没有 Steam 愿望单接口。");
}

export function formatSteamLiveForAi(live) {
  if (!live?.available) {
    return `Steam 近两周暂不可用：${live?.message || "未知原因"}。不要假装已经现查到。`;
  }
  const playing = live.playing?.name ? `此刻在玩：${live.playing.name}` : "此刻没在 Steam 里玩";
  const lines = (live.games || []).slice(0, 20).map((game) => (
    `- ${game.name} · 近两周 ${game.hours2weeks} 小时（累计 ${game.hoursForever} 小时）`
  ));
  return [
    "工作台已代查 Steam 近两周（不要说接不上，不要只翻馆藏快照 steam_库.json）：",
    `刷新时间：${live.refreshedAt || "—"}`,
    `账号：${live.persona || "示例账号"}。${playing}。`,
    `近两周 ${live.gameCount} 款，合计约 ${live.hours2weeks} 小时。`,
    lines.length ? lines.join("\n") : "近两周 Steam 没碰。",
    "看不到精确到哪一天，也看不到 Switch / 战网 / 手机。不要把钥匙念出来。不要用这次结果整份覆盖馆藏快照，除非他明确说更新馆藏且你另有全库。",
  ].join("\n");
}

/** 测试用。 */
export function resetSteamLiveCache() {
  steamCache = null;
  steamWishlistCache = null;
}
