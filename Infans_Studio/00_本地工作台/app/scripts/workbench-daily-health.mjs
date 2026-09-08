import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKYO = "Asia/Tokyo";
const BACKUP_SUCCESS = /推送成功|镜像触发|没有变更|已提交|Git 分支 .* 已推送到 NAS|主库完整镜像已|主库 NAS 镜像成功/;
const REQUIRED_AGENTS = [
  {
    id: "daily-health",
    plist: "com.capoo.infans-workbench-daily-health.plist",
    script: "infans_workbench_daily_health.sh",
    launchdLabel: "com.capoo.infans-workbench-daily-health",
  },
  {
    id: "weekly-release",
    plist: "com.capoo.infans-workbench-daily-release.plist",
    script: "infans_workbench_daily_release.sh",
    launchdLabel: "com.capoo.infans-workbench-daily-release",
  },
  {
    id: "vault-backup",
    plist: "com.capoo.infans-vault-backup.plist",
    script: "infans_vault_backup.sh",
    launchdLabel: "com.capoo.infans-vault-backup",
  },
];

export function tokyoDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TOKYO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function calendarDayNumber(dayKey) {
  const match = String(dayKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000) : null;
}

function parseLogStamp(line) {
  const match = String(line).match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}:\d{2}))?/);
  return match ? { date: match[1], time: match[2] || null } : null;
}

export function latestBackupSuccess(logText) {
  const lines = String(logText || "").split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!BACKUP_SUCCESS.test(line)) continue;
    const stamp = parseLogStamp(line);
    if (!stamp) continue;
    return { ...stamp, line };
  }
  return null;
}

export function backupIsFresh(success, todayKey, maxAgeDays = 2) {
  if (!success?.date) return false;
  const today = calendarDayNumber(todayKey);
  const last = calendarDayNumber(success.date);
  return today !== null && last !== null && today - last <= maxAgeDays;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function portIsListening(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function readHealth(url, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(2500) });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, body };
}

export async function inspectDailyHealth(options = {}) {
  const home = options.home || os.homedir();
  const today = options.today || tokyoDateKey(options.now || new Date());
  const agentsDir = options.agentsDir || path.join(home, "Library/LaunchAgents");
  const binDir = options.binDir || path.join(home, ".local/bin");
  const stateDir = options.stateDir || path.join(home, ".local/state");
  const healthUrl = options.healthUrl || "http://127.0.0.1:5173/api/health";
  const issues = [];
  const notes = [];

  for (const agent of REQUIRED_AGENTS) {
    if (!await pathExists(path.join(agentsDir, agent.plist))) {
      issues.push(`缺少 LaunchAgent：${agent.plist}`);
    }
    if (!await pathExists(path.join(binDir, agent.script))) {
      issues.push(`缺少执行脚本：${agent.script}`);
    }
  }

  const loadedChecker = options.checkLoaded;
  if (typeof loadedChecker === "function") {
    for (const agent of REQUIRED_AGENTS) {
      const loaded = await loadedChecker(agent.launchdLabel);
      if (loaded === false) issues.push(`LaunchAgent 未加载：${agent.launchdLabel}`);
    }
  }

  let backupLog = "";
  try {
    backupLog = await fs.readFile(path.join(stateDir, "infans_vault_backup.log"), "utf8");
  } catch {
    issues.push("找不到 Vault 备份日志");
  }
  const backupSuccess = latestBackupSuccess(backupLog);
  if (!backupSuccess) {
    issues.push("备份日志里没有可核对的成功记录");
  } else if (!backupIsFresh(backupSuccess, today)) {
    issues.push(`最近一次备份成功已超过两个东京自然日：${backupSuccess.date}`);
  } else {
    notes.push(`备份最近成功：${backupSuccess.date}${backupSuccess.time ? ` ${backupSuccess.time}` : ""}`);
  }

  const listening = options.serviceListening === undefined
    ? await portIsListening("127.0.0.1", 5173)
    : options.serviceListening;
  let health = null;
  if (!listening) {
    notes.push("运行健康跳过（未监听）");
  } else {
    try {
      health = await readHealth(healthUrl, options.fetchHealth || globalThis.fetch);
      if (!health.ok || health.body?.ok !== true) {
        issues.push("正式服务健康接口未返回 ok");
      } else {
        const version = health.body.version ? `V${health.body.version}` : "版本未知";
        notes.push(`运行健康正常：${version}`);
      }
    } catch (error) {
      issues.push(`正式服务健康接口读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ok = issues.length === 0;
  const summary = ok
    ? `轻量检查通过：${notes.join("；") || "调度与备份都在"}`
    : `轻量检查失败：${issues.join("；")}`;
  return { ok, today, issues, notes, backupSuccess, health, summary };
}

export function formatDailyHealthLog(result, now = new Date()) {
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: TOKYO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now).replace(",", "");
  const mark = result.ok ? "✅" : "❌";
  return `${stamp} JST ${mark} ${result.summary}`;
}

async function main() {
  const result = await inspectDailyHealth();
  const line = formatDailyHealthLog(result);
  process.stdout.write(`${line}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
