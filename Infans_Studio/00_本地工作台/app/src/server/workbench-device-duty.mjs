import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOCAL_SOURCE = fileURLToPath(new URL("./native/infans-device-sampler.c", import.meta.url));
const NAS_TARGET = process.env.INFANS_DEVICE_NAS_SSH_TARGET || process.env.INFANS_VPN_SSH_TARGET || "";
const QUIET_INTERVAL_MS = 60_000;
const OBSERVED_INTERVAL_MS = 15_000;
const WATCH_INTERVAL_MS = 10_000;
const OBSERVED_TTL_MS = 45_000;
const WATCH_TTL_MS = 5 * 60_000;
const HISTORY_LIMIT = 24 * 60;

const NAS_PROBE = String.raw`LC_ALL=C
head -n 1 /proc/stat 2>/dev/null | sed 's/^/cpu\t/'
awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {available=$2} END {printf "mem\t%.0f\t%.0f\n", total*1024, available*1024}' /proc/meminfo 2>/dev/null
awk 'BEGIN {physicalRead=0; physicalWrite=0; raidRead=0; raidWrite=0} $3 ~ /^(sd[a-z]+|sata[0-9]+|nvme[0-9]+n[0-9]+)$/ {physicalRead += $6; physicalWrite += $10} $3 ~ /^md[0-9]+$/ {raidRead += $6; raidWrite += $10} END {if (physicalRead+physicalWrite > 0) printf "disk\t%.0f\t%.0f\n", physicalRead*512, physicalWrite*512; else printf "disk\t%.0f\t%.0f\n", raidRead*512, raidWrite*512}' /proc/diskstats 2>/dev/null
awk '{printf "load\t%s\n", $1}' /proc/loadavg 2>/dev/null
for item in /sys/class/thermal/thermal_zone*/temp /sys/class/hwmon/hwmon*/temp*_input; do [ -r "$item" ] && value=$(head -n 1 "$item" 2>/dev/null) && case "$value" in ''|*[!0-9]*) ;; *) printf 'temp\t%s\n' "$value" ;; esac; done
for item in /sys/class/hwmon/hwmon*/fan*_input; do [ -r "$item" ] && value=$(head -n 1 "$item" 2>/dev/null) && case "$value" in ''|*[!0-9]*) ;; *) printf 'fan\t%s\n' "$value" ;; esac; done
ps aux 2>/dev/null | awk 'NR > 1 && $2 ~ /^[0-9]+$/ {name=$11; count=split(name,parts,"/"); printf "proc\t%s\t%s\t%s\t%s\t%s\n",$2,parts[count],$3,$4,$6}' | head -n 120`;

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function cleanProcessName(value) {
  const name = String(value || "未知进程").replace(/[\r\n\t]/g, " ").trim();
  return name.slice(0, 72) || "未知进程";
}

function elapsedSeconds(value) {
  const parts = String(value || "").trim().split("-");
  const days = parts.length === 2 ? safeNumber(parts.shift()) : 0;
  const clock = parts.join("").split(":").map((part) => safeNumber(part));
  if (clock.length < 2 || clock.length > 3) return 0;
  const [hours, minutes, seconds] = clock.length === 3 ? clock : [0, ...clock];
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function executableName(value) {
  return cleanProcessName(path.basename(String(value || "").trim()));
}

function terminalSource(processes, shell) {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  let current = shell;
  for (let depth = 0; current && depth < 12; depth += 1) {
    const name = current.name.toLowerCase();
    if (name === "terminal") return "终端";
    if (name.includes("iterm")) return "iTerm";
    if (name.includes("cursor")) return "Cursor";
    if (name === "codex" || name.includes("codex")) return "Codex";
    if (name.includes("code helper") || name === "code") return "VS Code";
    current = byPid.get(current.ppid);
  }
  return "终端会话";
}

/** 只保留 TTY、进程名和时长；不读取完整命令参数或工作目录。 */
export function parseTerminalProbe(raw) {
  const processes = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/u);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3],
      elapsedSeconds: elapsedSeconds(match[4]),
      name: executableName(match[5]),
    });
  }
  const terminalProcesses = processes.filter((process) => /^(?:ttys?\d+|pts\/\d+|pty[a-z0-9]+)$/iu.test(process.tty));
  const byTty = new Map();
  for (const process of terminalProcesses) {
    const rows = byTty.get(process.tty) || [];
    rows.push(process);
    byTty.set(process.tty, rows);
  }
  const shells = new Set(["zsh", "bash", "fish", "sh", "dash", "nu"]);
  const sessions = [...byTty.entries()].map(([tty, rows]) => {
    const childPids = new Set(rows.map((row) => row.ppid));
    const shell = rows.find((row) => shells.has(row.name.toLowerCase())) || rows[0];
    const active = rows
      .filter((row) => !childPids.has(row.pid) && !shells.has(row.name.toLowerCase()) && row.name !== "login")
      .sort((a, b) => a.elapsedSeconds - b.elapsedSeconds)[0];
    return {
      id: tty,
      tty,
      source: terminalSource(processes, shell),
      shell: shell?.name || "shell",
      activeCommand: active?.name || null,
      busy: Boolean(active),
      elapsedSeconds: shell?.elapsedSeconds || 0,
    };
  }).sort((a, b) => Number(b.busy) - Number(a.busy) || b.elapsedSeconds - a.elapsedSeconds);
  return { available: true, count: sessions.length, sessions, error: null };
}

export function parseLocalProbe(raw) {
  const result = { logicalCpu: 1, memoryTotalBytes: 0, memoryUsedBytes: 0, cpuTicks: null, processes: [] };
  for (const line of String(raw || "").split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts[0] === "meta" && parts.length >= 9) {
      result.logicalCpu = Math.max(1, Math.floor(safeNumber(parts[1], 1)));
      result.memoryTotalBytes = safeNumber(parts[2]);
      result.memoryUsedBytes = safeNumber(parts[3]);
      result.cpuTicks = parts.slice(5, 9).map((value) => safeNumber(value));
    } else if (parts[0] === "proc" && parts.length >= 7) {
      result.processes.push({
        pid: Math.floor(safeNumber(parts[1])),
        name: cleanProcessName(parts[2]),
        cpuTimeNs: safeNumber(parts[3]),
        readBytes: safeNumber(parts[4]),
        writeBytes: safeNumber(parts[5]),
        memoryBytes: safeNumber(parts[6]),
      });
    }
  }
  if (!result.memoryTotalBytes) throw new Error("Mac 原生探针没有返回内存总量");
  return result;
}

export function parseNasProbe(raw) {
  const result = { cpuTicks: null, memoryTotalBytes: 0, memoryAvailableBytes: 0, diskReadBytes: 0, diskWriteBytes: 0, load: 0, temperatureC: null, fanRpm: null, processes: [] };
  for (const line of String(raw || "").split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts[0] === "cpu") {
      const ticks = parts.slice(1).join(" ").replace(/^cpu\s+/, "").trim().split(/\s+/).map((value) => safeNumber(value));
      if (ticks.length >= 4) result.cpuTicks = ticks;
    } else if (parts[0] === "mem") {
      result.memoryTotalBytes = safeNumber(parts[1]);
      result.memoryAvailableBytes = safeNumber(parts[2]);
    } else if (parts[0] === "disk") {
      result.diskReadBytes = safeNumber(parts[1]);
      result.diskWriteBytes = safeNumber(parts[2]);
    } else if (parts[0] === "load") {
      result.load = safeNumber(parts[1]);
    } else if (parts[0] === "temp") {
      const value = safeNumber(parts[1]);
      const celsius = value > 1_000 ? value / 1_000 : value;
      if (celsius > 0 && celsius < 150) result.temperatureC = Math.max(result.temperatureC || 0, celsius);
    } else if (parts[0] === "fan") {
      const value = safeNumber(parts[1]);
      if (value > 0) result.fanRpm = Math.max(result.fanRpm || 0, value);
    } else if (parts[0] === "proc" && parts.length >= 6) {
      result.processes.push({
        pid: Math.floor(safeNumber(parts[1])),
        name: cleanProcessName(parts[2]),
        cpuPercent: safeNumber(parts[3]),
        memoryPercent: safeNumber(parts[4]),
        memoryBytes: safeNumber(parts[5]) * 1024,
        readBytesPerSecond: null,
        writeBytesPerSecond: null,
      });
    }
  }
  if (!result.memoryTotalBytes || !result.cpuTicks) throw new Error("NAS 没有返回可用的系统状态");
  return result;
}

function cpuPercentFromTicks(current, previous) {
  if (!current || !previous || current.length < 4 || previous.length < 4) return null;
  const deltas = current.map((value, index) => Math.max(0, value - (previous[index] || 0)));
  const total = deltas.reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  const idle = (deltas[3] || 0) + (deltas[4] || 0);
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

function deviceLevel({ cpuPercent, memoryPercent, writeBytesPerSecond, temperatureC, available }) {
  if (!available) return "unavailable";
  if ((cpuPercent ?? 0) >= 88 || memoryPercent >= 94 || (writeBytesPerSecond ?? 0) >= 80 * 1024 * 1024 || (temperatureC ?? 0) >= 76) return "hot";
  if ((cpuPercent ?? 0) >= 65 || memoryPercent >= 85 || (writeBytesPerSecond ?? 0) >= 24 * 1024 * 1024 || (temperatureC ?? 0) >= 62) return "watch";
  return "quiet";
}

function statusCopy(level) {
  if (level === "hot") return "持续忙碌";
  if (level === "watch") return "有些动静";
  if (level === "unavailable") return "暂时没接上";
  return "安静值守";
}

function summarizeReason(device) {
  if (!device.available) return device.error || "还没有取得这台设备的只读状态";
  const reasons = [];
  if ((device.cpuPercent ?? 0) >= 65) reasons.push(`CPU ${Math.round(device.cpuPercent)}%`);
  if (device.memoryPercent >= 85) reasons.push(`内存 ${Math.round(device.memoryPercent)}%`);
  if ((device.writeBytesPerSecond ?? 0) >= 24 * 1024 * 1024) reasons.push("正在集中写盘");
  if ((device.temperatureC ?? 0) >= 62) reasons.push(`温度 ${Math.round(device.temperatureC)}°C`);
  const suspect = device.topProcesses[0]?.name;
  return reasons.length ? `${reasons.join(" · ")}${suspect ? `；主要是 ${suspect}` : ""}` : "没有发现持续占用；正常时保持安静。";
}

export function buildLocalDevice(current, previous, elapsedSeconds) {
  const before = new Map((previous?.processes || []).map((process) => [process.pid, process]));
  const processRates = current.processes.map((process) => {
    const old = before.get(process.pid);
    const stable = old && elapsedSeconds > 0;
    return {
      pid: process.pid,
      name: process.name,
      cpuPercent: stable ? Math.max(0, ((process.cpuTimeNs - old.cpuTimeNs) / (elapsedSeconds * 1e9)) * 100) : null,
      memoryBytes: process.memoryBytes,
      memoryPercent: current.memoryTotalBytes ? (process.memoryBytes / current.memoryTotalBytes) * 100 : 0,
      readBytesPerSecond: stable ? Math.max(0, (process.readBytes - old.readBytes) / elapsedSeconds) : null,
      writeBytesPerSecond: stable ? Math.max(0, (process.writeBytes - old.writeBytes) / elapsedSeconds) : null,
    };
  });
  const diskReadBytesPerSecond = processRates.reduce((sum, row) => sum + (row.readBytesPerSecond || 0), 0);
  const diskWriteBytesPerSecond = processRates.reduce((sum, row) => sum + (row.writeBytesPerSecond || 0), 0);
  const topProcesses = processRates.sort((a, b) => {
    const score = (row) => (row.cpuPercent || 0) + ((row.writeBytesPerSecond || 0) / 1024 / 1024) * 2 + row.memoryPercent * 0.5;
    return score(b) - score(a);
  }).slice(0, 8);
  const memoryPercent = current.memoryTotalBytes ? (current.memoryUsedBytes / current.memoryTotalBytes) * 100 : 0;
  const cpuPercent = cpuPercentFromTicks(current.cpuTicks, previous?.cpuTicks);
  const base = {
    id: "mac", label: "这台 Mac", available: true, cpuPercent, memoryPercent,
    memoryUsedBytes: current.memoryUsedBytes, memoryTotalBytes: current.memoryTotalBytes,
    diskReadBytesPerSecond, diskWriteBytesPerSecond, temperatureC: null, fanRpm: null,
    topProcesses, error: null,
  };
  const level = deviceLevel({ ...base, writeBytesPerSecond: diskWriteBytesPerSecond });
  return { ...base, level, statusLabel: statusCopy(level), reason: summarizeReason({ ...base, level }) };
}

export function buildNasDevice(current, previous, elapsedSeconds) {
  const memoryUsedBytes = Math.max(0, current.memoryTotalBytes - current.memoryAvailableBytes);
  const memoryPercent = current.memoryTotalBytes ? (memoryUsedBytes / current.memoryTotalBytes) * 100 : 0;
  const diskReadBytesPerSecond = previous && elapsedSeconds > 0 ? Math.max(0, (current.diskReadBytes - previous.diskReadBytes) / elapsedSeconds) : null;
  const diskWriteBytesPerSecond = previous && elapsedSeconds > 0 ? Math.max(0, (current.diskWriteBytes - previous.diskWriteBytes) / elapsedSeconds) : null;
  const topProcesses = [...current.processes].sort((a, b) => (b.cpuPercent * 4 + b.memoryPercent) - (a.cpuPercent * 4 + a.memoryPercent)).slice(0, 8);
  const base = {
    id: "nas", label: "家里的 NAS", available: true,
    cpuPercent: cpuPercentFromTicks(current.cpuTicks, previous?.cpuTicks), memoryPercent,
    memoryUsedBytes, memoryTotalBytes: current.memoryTotalBytes,
    diskReadBytesPerSecond, diskWriteBytesPerSecond,
    temperatureC: current.temperatureC, fanRpm: current.fanRpm,
    topProcesses, error: null,
  };
  const level = deviceLevel({ ...base, writeBytesPerSecond: diskWriteBytesPerSecond });
  return { ...base, level, statusLabel: statusCopy(level), reason: summarizeReason({ ...base, level }) };
}

function unavailableDevice(id, label, error) {
  return {
    id, label, available: false, level: "unavailable", statusLabel: statusCopy("unavailable"),
    cpuPercent: null, memoryPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 0,
    diskReadBytesPerSecond: null, diskWriteBytesPerSecond: null,
    temperatureC: null, fanRpm: null, topProcesses: [],
    error: String(error || "暂时没有数据").replace(/\s+/g, " ").slice(0, 180),
    reason: String(error || "暂时没有数据").replace(/\s+/g, " ").slice(0, 180),
  };
}

async function defaultLocalProbe() {
  const source = await fs.readFile(LOCAL_SOURCE);
  const fingerprint = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const binary = path.join(os.tmpdir(), `infans-device-sampler-${process.getuid?.() ?? "user"}-${fingerprint}`);
  try {
    await fs.access(binary);
  } catch {
    const temporary = `${binary}.${process.pid}.tmp`;
    await execFileAsync("/usr/bin/clang", ["-O2", LOCAL_SOURCE, "-o", temporary], { timeout: 20_000, maxBuffer: 256 * 1024 });
    await fs.rename(temporary, binary);
    await fs.chmod(binary, 0o700);
  }
  const { stdout } = await execFileAsync(binary, [], { timeout: 4_000, maxBuffer: 2 * 1024 * 1024 });
  return parseLocalProbe(stdout);
}

async function defaultNasProbe() {
  const { stdout } = await execFileAsync("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "-o", "ServerAliveInterval=3", "-o", "ServerAliveCountMax=1",
    NAS_TARGET, NAS_PROBE,
  ], { timeout: 8_000, maxBuffer: 256 * 1024 });
  return parseNasProbe(stdout);
}

async function defaultTerminalProbe() {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,tty=,etime=,comm="], { timeout: 3_000, maxBuffer: 512 * 1024 });
  return parseTerminalProbe(stdout);
}

function publicHistoryPoint(device, at) {
  return { at, deviceId: device.id, level: device.level, cpuPercent: device.cpuPercent, memoryPercent: device.memoryPercent, writeBytesPerSecond: device.diskWriteBytesPerSecond };
}

export function createDeviceDutyMonitor(options = {}) {
  const now = options.now || (() => Date.now());
  const sampleLocal = options.sampleLocal || defaultLocalProbe;
  const sampleNas = options.sampleNas || defaultNasProbe;
  const sampleTerminals = options.sampleTerminals || defaultTerminalProbe;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let previousLocal = null;
  let previousNas = null;
  let previousAt = null;
  let observedUntil = 0;
  let watchUntil = 0;
  let timer = null;
  let running = null;
  let startedAt = null;
  let lastSampleMs = null;
  let history = [];
  let events = [];
  const busyStreaks = new Map();
  let terminals = { available: false, count: 0, sessions: [], error: "第一次采样还没完成" };
  let devices = [unavailableDevice("mac", "这台 Mac", "第一次采样还没完成"), unavailableDevice("nas", "家里的 NAS", "第一次采样还没完成")];

  function intervalMs() {
    const time = now();
    if (time < watchUntil) return WATCH_INTERVAL_MS;
    if (time < observedUntil) return OBSERVED_INTERVAL_MS;
    return QUIET_INTERVAL_MS;
  }

  function observe() {
    observedUntil = Math.max(observedUntil, now() + OBSERVED_TTL_MS);
  }

  function record(device, at) {
    const minute = at.slice(0, 16);
    const existingIndex = history.findIndex((item) => item.deviceId === device.id && item.at.startsWith(minute));
    const point = publicHistoryPoint(device, at);
    if (existingIndex >= 0) history[existingIndex] = point;
    else history.push(point);
    history = history.slice(-HISTORY_LIMIT * 2);

    if (device.level === "watch" || device.level === "hot") {
      watchUntil = Math.max(watchUntil, now() + WATCH_TTL_MS);
      const streak = (busyStreaks.get(device.id) || 0) + 1;
      busyStreaks.set(device.id, streak);
      if (streak < 2) return;
      const open = events.find((event) => event.deviceId === device.id && !event.endedAt);
      if (!open) events.unshift({ id: `${device.id}-${at}`, deviceId: device.id, deviceLabel: device.label, startedAt: at, endedAt: null, level: device.level, summary: device.reason, suspects: device.topProcesses.slice(0, 3).map((row) => row.name) });
      else {
        open.level = device.level === "hot" ? "hot" : open.level;
        open.summary = device.reason;
        open.suspects = device.topProcesses.slice(0, 3).map((row) => row.name);
      }
    } else if (device.level === "quiet") {
      busyStreaks.set(device.id, 0);
      const open = events.find((event) => event.deviceId === device.id && !event.endedAt);
      if (open) open.endedAt = at;
    }
    const cutoff = now() - 24 * 60 * 60_000;
    events = events.filter((event) => new Date(event.startedAt).getTime() >= cutoff).slice(0, 30);
  }

  async function refresh() {
    if (running) return running;
    running = (async () => {
      const begun = now();
      const at = new Date(begun).toISOString();
      const elapsedSeconds = previousAt == null ? 0 : Math.max((begun - previousAt) / 1000, 0.001);
      const [localResult, nasResult, terminalResult] = await Promise.allSettled([sampleLocal(), sampleNas(), sampleTerminals()]);
      const local = localResult.status === "fulfilled"
        ? buildLocalDevice(localResult.value, previousLocal, elapsedSeconds)
        : unavailableDevice("mac", "这台 Mac", localResult.reason instanceof Error ? localResult.reason.message : localResult.reason);
      const nas = nasResult.status === "fulfilled"
        ? buildNasDevice(nasResult.value, previousNas, elapsedSeconds)
        : unavailableDevice("nas", "家里的 NAS", nasResult.reason instanceof Error ? nasResult.reason.message : nasResult.reason);
      if (localResult.status === "fulfilled") previousLocal = localResult.value;
      if (nasResult.status === "fulfilled") previousNas = nasResult.value;
      terminals = terminalResult.status === "fulfilled"
        ? terminalResult.value
        : { available: false, count: 0, sessions: [], error: String(terminalResult.reason instanceof Error ? terminalResult.reason.message : terminalResult.reason || "暂时读不到终端") };
      previousAt = begun;
      devices = [local, nas];
      record(local, at);
      record(nas, at);
      if (startedAt == null) startedAt = at;
      lastSampleMs = Math.max(0, now() - begun);
      return read();
    })().finally(() => { running = null; });
    return running;
  }

  function read() {
    const available = devices.filter((device) => device.available);
    const attention = available.filter((device) => device.level === "watch" || device.level === "hot");
    const unavailable = devices.filter((device) => !device.available);
    return {
      observedAt: previousAt == null ? null : new Date(previousAt).toISOString(),
      startedAt,
      mode: now() < watchUntil ? "watch" : now() < observedUntil ? "observed" : "quiet",
      sampleIntervalSeconds: intervalMs() / 1000,
      lastSampleMs,
      storage: "memory-only",
      headline: attention.length ? `${attention.map((device) => device.label).join("、")}正在忙` : available.length ? "设备目前安静" : "设备状态还没接上",
      note: unavailable.length ? `${unavailable.map((device) => device.label).join("、")}暂时没有数据，其余设备继续值守。` : "只记录负载摘要和进程名，不读取文件内容。",
      devices,
      terminals,
      history,
      events,
    };
  }

  function schedule() {
    if (timer) clearTimer(timer);
    timer = setTimer(async () => {
      await refresh();
      schedule();
    }, intervalMs());
    timer?.unref?.();
  }

  function start() {
    if (timer || running) return;
    void refresh().finally(schedule);
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { read, refresh, observe, start, stop, intervalMs };
}
