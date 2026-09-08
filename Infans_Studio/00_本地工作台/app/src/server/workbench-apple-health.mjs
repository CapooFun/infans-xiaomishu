import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { SaxesParser } from "saxes";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { formatFileCreatedAt } from "./workbench-wechat-bills.mjs";
import { tokyoDay } from "../tokyo-time.mjs";
import { APPLE_HEALTH_DERIVED, APPLE_HEALTH_SUMMARY } from "./vault-paths.mjs";

const execFileAsync = promisify(execFile);
const TARGET_PATH = APPLE_HEALTH_SUMMARY;
const DERIVED_RELATIVE = APPLE_HEALTH_DERIVED;
const PREVIEW_TTL = 10 * 60 * 1000;
const MAX_UPLOAD = 1024 * 1024 * 1024;
const MAX_XML = 2 * 1024 * 1024 * 1024;

const QUANTITY_TYPES = new Map([
  ["HKQuantityTypeIdentifierStepCount", "steps"],
  ["HKQuantityTypeIdentifierActiveEnergyBurned", "activeEnergy"],
  ["HKQuantityTypeIdentifierAppleExerciseTime", "exerciseMinutes"],
  ["HKQuantityTypeIdentifierAppleStandTime", "standMinutes"],
  ["HKQuantityTypeIdentifierRestingHeartRate", "restingHeartRate"],
  ["HKQuantityTypeIdentifierBodyMass", "weightKg"],
  ["HKQuantityTypeIdentifierWaistCircumference", "waistCm"],
  ["HKQuantityTypeIdentifierBodyFatPercentage", "bodyFatPercent"],
]);

const WORKOUT_NAMES = new Map([
  ["HKWorkoutActivityTypeWalking", "步行"], ["HKWorkoutActivityTypeRunning", "跑步"],
  ["HKWorkoutActivityTypeCycling", "骑行"], ["HKWorkoutActivityTypeHiking", "徒步"],
  ["HKWorkoutActivityTypeTraditionalStrengthTraining", "传统力量训练"],
  ["HKWorkoutActivityTypeFunctionalStrengthTraining", "功能性力量训练"],
  ["HKWorkoutActivityTypeCoreTraining", "核心训练"], ["HKWorkoutActivityTypeYoga", "瑜伽"],
  ["HKWorkoutActivityTypeCooldown", "整理放松"],
  ["HKWorkoutActivityTypeSwimming", "游泳"], ["HKWorkoutActivityTypeOther", "其他训练"],
]);

const STRETCH_DAILY_TARGET_MINUTES = 10;

/** 只从明确的“整理放松”运动派生；缺失日期不生成未完成。 */
export function deriveStretchDays(workouts = []) {
  const days = new Map();
  const seen = new Set();
  for (const workout of workouts) {
    if (!["整理放松", "Cooldown"].includes(String(workout?.type || ""))) continue;
    const date = String(workout?.day || tokyoDay(dateValue(workout?.date)) || "");
    const duration = Number(workout?.durationMinutes);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(duration) || duration <= 0) continue;
    const identity = [workout?.date, workout?.end, duration, workout?.source].map((value) => String(value || "")).join("|");
    if (seen.has(identity)) continue;
    seen.add(identity);
    const previous = days.get(date) || { date, durationMinutes: 0, workoutCount: 0, sources: new Set() };
    previous.durationMinutes += duration;
    previous.workoutCount += 1;
    if (workout?.source) previous.sources.add(String(workout.source));
    days.set(date, previous);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((item) => ({
    date: item.date,
    durationMinutes: round(item.durationMinutes),
    status: item.durationMinutes >= STRETCH_DAILY_TARGET_MINUTES ? "complete" : "partial",
    completed: item.durationMinutes >= STRETCH_DAILY_TARGET_MINUTES,
    workoutCount: item.workoutCount,
    source: [...item.sources].join(" / ") || "未知来源",
  }));
}

export function normalizeAppleHealthData(data) {
  if (!data || typeof data !== "object") return data;
  const workouts = Array.isArray(data.workouts)
    ? data.workouts.map((item) => item?.type === "Cooldown" ? { ...item, type: "整理放松" } : item)
    : [];
  return {
    ...data,
    schemaVersion: Math.max(2, Number(data.schemaVersion) || 1),
    workouts,
    stretch: { dailyTargetMinutes: STRETCH_DAILY_TARGET_MINUTES, days: deriveStretchDays(workouts), missingMeans: "unknown" },
  };
}

/** Apple SleepAnalysis：只计睡着段；不含 InBed / Awake。 */
function isAsleepSleepValue(value) {
  const raw = String(value ?? "");
  if (/HKCategoryValueSleepAnalysisAsleep(Core|Deep|REM|Unspecified)?$/i.test(raw)) return true;
  if (raw === "HKCategoryValueSleepAnalysisAsleep") return true;
  // 旧版整型：1=Asleep；分期 3=Core 4=Deep 5=REM
  return raw === "1" || raw === "3" || raw === "4" || raw === "5";
}
function dateValue(value) {
  if (!value) return null;
  const normalized = String(value).replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function converted(metric, value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (metric === "weightKg") return unit === "lb" ? number * 0.45359237 : unit === "g" ? number / 1000 : number;
  if (metric === "waistCm") return unit === "m" ? number * 100 : unit === "in" ? number * 2.54 : number;
  if (metric === "bodyFatPercent") return number <= 1 ? number * 100 : number;
  if (metric === "activeEnergy") return /kJ/i.test(unit) ? number / 4.184 : number;
  if (["exerciseMinutes", "standMinutes"].includes(metric)) return unit === "s" ? number / 60 : unit === "h" ? number * 60 : number;
  return number;
}

function sourceRank(source = "") { return /Apple Watch/i.test(source) ? 3 : /iPhone/i.test(source) ? 2 : 1; }
function round(value, digits = 1) { const factor = 10 ** digits; return Math.round(value * factor) / factor; }

/** 下载目录里 macOS 会把重复导出命名成「导出 2.zip」「导出 3.zip」——只认精确「导出.zip」会永远读到旧包。 */
const DOWNLOAD_ZIP_NAME = /^(导出|export)( \d+)?\.zip$/i;
const DOWNLOAD_XML_NAME = /^(导出|export)\.xml$/i;

async function appleHealthCandidateMeta(filePath, zip) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile()) return null;
  const stamped = formatFileCreatedAt(stat);
  return {
    filePath,
    zip: Boolean(zip),
    modifiedAt: stat.mtimeMs,
    createdAt: stamped.createdAt,
    createdAtKind: stamped.createdAtKind,
    createdAtMs: stamped.createdAtMs,
  };
}

export async function listAppleHealthDownloadCandidates(downloadsDir = path.join(os.homedir(), "Downloads")) {
  const found = [];
  let entries = [];
  try {
    entries = await fsp.readdir(downloadsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const zip = DOWNLOAD_ZIP_NAME.test(entry.name);
    const xml = DOWNLOAD_XML_NAME.test(entry.name);
    if (!zip && !xml) continue;
    const filePath = path.join(downloadsDir, entry.name);
    try {
      const meta = await appleHealthCandidateMeta(filePath, zip);
      if (meta) found.push(meta);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  // 兼容旧解压目录里的主导出 XML
  for (const name of ["apple_health_export/导出.xml", "apple_health_export/export.xml"]) {
    const filePath = path.join(downloadsDir, name);
    try {
      const meta = await appleHealthCandidateMeta(filePath, false);
      if (meta) found.push(meta);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return found.sort((a, b) => Number(b.zip) - Number(a.zip)
    || (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)
    || b.modifiedAt - a.modifiedAt);
}

function sourceFileFromStamp(name, stamped, createdAtKind) {
  if (!stamped?.createdAt) return undefined;
  return {
    name: String(name || "Apple Health 导出"),
    createdAt: stamped.createdAt,
    createdAtKind: createdAtKind || stamped.createdAtKind,
  };
}

function formatBrowserFileStamp(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return null;
  return formatFileCreatedAt({ birthtimeMs: value, mtimeMs: value });
}

export function pickNewestAppleHealthDownload(candidates = []) {
  return candidates[0] ?? null;
}

export function appleHealthDerivedPath(vaultRoot) {
  return path.resolve(vaultRoot, DERIVED_RELATIVE);
}

async function atomicWriteFile(absolute, content, mode = 0o600) {
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.infans-${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await fsp.rename(temporary, absolute);
    if (mode) await fsp.chmod(absolute, mode);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeAppleHealthDerived(vaultRoot, data) {
  const normalized = { ...data, schemaVersion: Number(data?.schemaVersion) || 1 };
  await atomicWriteFile(appleHealthDerivedPath(vaultRoot), `${JSON.stringify(normalized)}\n`, 0o600);
  return normalized;
}

/** 自动同步与手动导入共用同一份派生数据和 S2 摘要，不另建第二真值。 */
export async function writeAppleHealthSnapshot(vaultRoot, data) {
  const normalized = normalizeAppleHealthData(data);
  await writeAppleHealthDerived(vaultRoot, normalized);
  await atomicWriteFile(path.join(path.resolve(vaultRoot), TARGET_PATH), renderAppleHealthMarkdown(normalized), 0o600);
  return normalized;
}

export async function parseAppleHealthStream(stream, metadata = {}) {
  const dailySources = new Map(); const body = []; const workouts = []; const sleepByDay = new Map();
  let bytes = 0; let records = 0; let rootSeen = false;
  const decoder = new StringDecoder("utf8");
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (node) => {
    if (!rootSeen) {
      rootSeen = true;
      if (node.name !== "HealthData") throw new WorkbenchWriteError("这不是 Apple Health 主导出 XML。请选择“导出.zip”或“导出.xml”，不要选择 export_cda.xml。", 400, "HEALTH_WRONG_XML");
    }
    const a = node.attributes;
    if (node.name === "Record") {
      if (a.type === "HKCategoryTypeIdentifierSleepAnalysis") {
        const start = dateValue(a.startDate); const end = dateValue(a.endDate);
        if (!start || !end || end <= start || !isAsleepSleepValue(a.value)) return;
        const minutes = (end.getTime() - start.getTime()) / 60_000;
        if (!(minutes > 0) || minutes > 24 * 60) return;
        const day = tokyoDay(end); // 归属醒来日
        if (!day) return;
        records += 1;
        const source = String(a.sourceName || "未知来源");
        const prev = sleepByDay.get(day) || { minutes: 0, source: "", rank: 0 };
        const rank = sourceRank(source);
        // 同日多来源：Watch 优先；同优先级累加分段分钟
        if (!prev.source || rank > prev.rank) {
          sleepByDay.set(day, { minutes, source, rank });
        } else if (rank === prev.rank && source === prev.source) {
          sleepByDay.set(day, { minutes: prev.minutes + minutes, source, rank });
        } else if (rank === prev.rank && source !== prev.source) {
          // 同优先级不同来源：取较长者，避免双计
          if (minutes > prev.minutes) sleepByDay.set(day, { minutes, source, rank });
        }
        return;
      }
      const metric = QUANTITY_TYPES.get(a.type); if (!metric) return;
      const value = converted(metric, a.value, a.unit); const date = dateValue(a.startDate); const day = tokyoDay(date); if (value === null || !date || !day) return;
      records += 1;
      const source = String(a.sourceName || "未知来源");
      if (["weightKg", "waistCm", "bodyFatPercent"].includes(metric)) {
        body.push({ date: date.toISOString(), day, metric, value: round(value, 2), unit: metric === "weightKg" ? "kg" : metric === "waistCm" ? "cm" : "%", source });
        return;
      }
      if (!dailySources.has(day)) dailySources.set(day, new Map());
      const metrics = dailySources.get(day); if (!metrics.has(metric)) metrics.set(metric, new Map());
      const sources = metrics.get(metric); if (!sources.has(source)) sources.set(source, { sum: 0, values: [] });
      const bucket = sources.get(source); bucket.sum += value; bucket.values.push(value);
    }
    if (node.name === "Workout") {
      const start = dateValue(a.startDate); const end = dateValue(a.endDate); if (!start) return;
      const duration = converted("exerciseMinutes", a.duration, a.durationUnit || "min");
      const energy = converted("activeEnergy", a.totalEnergyBurned, a.totalEnergyBurnedUnit || "kcal");
      workouts.push({ date: start.toISOString(), day: tokyoDay(start), type: WORKOUT_NAMES.get(a.workoutActivityType) || String(a.workoutActivityType || "训练").replace("HKWorkoutActivityType", ""), durationMinutes: duration === null ? null : round(duration), energyKcal: energy === null ? null : round(energy), source: String(a.sourceName || "未知来源"), end: end?.toISOString() ?? null });
    }
  });
  parser.on("error", (error) => { throw error instanceof WorkbenchWriteError ? error : new WorkbenchWriteError("读不懂这份苹果健康 XML，请优先选未解压的「导出.zip」。", 400, "HEALTH_XML_INVALID"); });
  for await (const chunk of stream) {
    bytes += chunk.length; if (bytes > MAX_XML) throw new WorkbenchWriteError("Apple Health XML 超过 2 GB，已停止解析", 413, "HEALTH_XML_TOO_LARGE");
    parser.write(Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk));
  }
  const tail = decoder.end(); if (tail) parser.write(tail);
  parser.close();
  if (!rootSeen) throw new WorkbenchWriteError("Apple Health XML 是空文件", 400, "HEALTH_XML_EMPTY");
  const daySet = new Set([...dailySources.keys(), ...sleepByDay.keys()]);
  const daily = [...daySet].map((date) => {
    const row = { date, sources: {} };
    const metricMap = dailySources.get(date);
    if (metricMap) {
      for (const [metric, sourceMap] of metricMap) {
        const chosen = [...sourceMap.entries()].sort((a, b) => sourceRank(b[0]) - sourceRank(a[0]) || b[1].values.length - a[1].values.length)[0];
        if (!chosen) continue;
        const [source, bucket] = chosen; row.sources[metric] = source;
        row[metric] = metric === "restingHeartRate" ? round(bucket.sum / bucket.values.length) : round(bucket.sum);
      }
    }
    const sleep = sleepByDay.get(date);
    if (sleep) {
      const asleep = round(sleep.minutes, 0);
      row.sleepMinutes = asleep;
      row.asleepMinutes = asleep;
      row.sources.sleepMinutes = sleep.source;
    }
    return row;
  }).sort((a, b) => a.date.localeCompare(b.date)).slice(-365);
  const uniqueBody = [...new Map(body.sort((a, b) => a.date.localeCompare(b.date)).map((item) => [`${item.metric}:${item.date}:${item.value}`, item])).values()];
  const uniqueWorkouts = [...new Map(workouts.sort((a, b) => a.date.localeCompare(b.date)).map((item) => [`${item.type}:${item.date.slice(0, 16)}:${item.durationMinutes}`, item])).values()].slice(-180).reverse();
  const latestBody = Object.fromEntries(["weightKg", "waistCm", "bodyFatPercent"].map((metric) => [metric, [...uniqueBody].reverse().find((item) => item.metric === metric) ?? null]));
  return normalizeAppleHealthData({
    schemaVersion: 2,
    importedAt: new Date().toISOString(),
    exportFile: metadata.fileName || "Apple Health 导出",
    exportCreatedAt: metadata.exportCreatedAt || "",
    exportCreatedAtKind: metadata.exportCreatedAtKind || "",
    xmlBytes: bytes,
    recordCount: records,
    daily,
    body: uniqueBody,
    workouts: uniqueWorkouts,
    latestBody,
    latestDaily: daily.at(-1) ?? null,
    note: "步数、活动能量与锻炼分钟按当日优先来源汇总，仅作参考；体重与腰围保留原始记录及来源。客观睡眠为睡着分钟（Category SleepAnalysis），与日记主观三档分列，不合成一个数。整理放松只跟踪日期、时长和是否达到每日 10 分钟；无记录不等于未完成。",
  });
}

export function appleHealthXmlExtraction(entries) {
  const entry = entries.find((name) => /(^|\/)export\.xml$/i.test(name));
  const localized = entries.filter((name) => /(^|\/)apple_health_export\/[^/]+\.xml$/i.test(name) && !/(^|\/)export_cda\.xml$/i.test(name));
  if (!entry && localized.length !== 1) throw new WorkbenchWriteError("ZIP 中没有找到唯一的 Apple Health 主导出 XML", 400, "HEALTH_XML_MISSING");
  return entry
    ? ["-p", entry]
    : ["-p", "apple_health_export/*.xml", "-x", "apple_health_export/export_cda.xml"];
}

async function xmlStreamFor(filePath) {
  const file = await fsp.open(filePath, "r"); const signature = Buffer.alloc(4); await file.read(signature, 0, 4, 0); await file.close();
  if (signature.slice(0, 2).toString("hex") !== "504b") return fs.createReadStream(filePath);
  const { stdout } = await execFileAsync("/usr/bin/unzip", ["-Z1", filePath], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  const entries = stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const args = appleHealthXmlExtraction(entries);
  args.splice(1, 0, filePath);
  const child = spawn("/usr/bin/unzip", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout.on("end", () => { if (child.exitCode && child.exitCode !== 0) child.stdout.destroy(new Error(stderr || "解压不了这份苹果健康导出")); });
  return child.stdout;
}

function summaryLine(data) {
  const sleepDays = (data.daily || []).filter((row) => row.sleepMinutes != null || row.asleepMinutes != null).length;
  return `解析 ${data.recordCount} 条健康记录、${data.body.length} 条身体测量、${data.daily.length} 天活动摘要、${data.workouts.length} 次运动、${sleepDays} 天客观睡眠。`;
}

function previewAfterLine(data, sourceFile) {
  // 来源文件时间单独走 sourceFile 字段给确认框置顶展示；这里只写解析摘要。
  if (sourceFile?.createdAt) return summaryLine(data);
  return `来源文件：${data.exportFile || "Apple Health 导出"}\n${summaryLine(data)}`;
}

export function renderAppleHealthMarkdown(data) {
  data = normalizeAppleHealthData(data);
  const bodyRows = data.body.slice(-80).map((item) => `| ${item.day} | ${item.metric} | ${item.value} ${item.unit} | ${String(item.source).replaceAll("|", "\\|")} |`).join("\n") || "| — | 暂无 | — | — |";
  const workoutRows = data.workouts.slice(0, 40).map((item) => `| ${item.day} | ${item.type} | ${item.durationMinutes ?? "—"} 分钟 | ${item.energyKcal ?? "—"} kcal | ${String(item.source).replaceAll("|", "\\|")} |`).join("\n") || "| — | 暂无 | — | — | — |";
  let sleepRows = [...(data.daily || [])]
    .filter((row) => row.sleepMinutes != null || row.asleepMinutes != null)
    .slice(-14)
    .reverse()
    .map((row) => {
      const minutes = row.sleepMinutes ?? row.asleepMinutes;
      const hours = (Number(minutes) / 60).toFixed(1);
      return `| ${row.date} | ${hours} h（${minutes} 分） | ${String(row.sources?.sleepMinutes || "—").replaceAll("|", "\\|")} |`;
    })
    .join("\n") || "| — | 暂无（需重新导入含 SleepAnalysis 的导出） | — |";
  const stretchRows = [...(data.stretch?.days || [])].slice(-40).reverse()
    .map((item) => `| ${item.date} | ${item.completed ? "已完成" : "部分完成"} | ${item.durationMinutes} 分钟 | ${String(item.source).replaceAll("|", "\\|")} |`)
    .join("\n") || "| — | 无记录 | — | — |";
  sleepRows += `\n\n## 每日拉伸（整理放松）\n\n> 目标每日 10 分钟。只列 Apple Watch 已有记录；缺失日期为未知，不视为未完成。\n\n| 日期 | 状态 | 实际时长 | 来源 |\n|---|---|---:|---|\n${stretchRows}`;
  const sourceLabel = data.sync ? "数据来源" : "原始文件";
  const syncLine = data.sync?.lastSyncedAt
    ? `\n- 自动同步：${data.sync.lastSyncedAt}（覆盖到 ${data.sync.completeThrough || data.sync.windowEnd || "—"}）${data.sync.lastRun ? `\n- 本次运行：${data.sync.lastRun.trigger} · ${data.sync.lastRun.runId} · ${data.sync.lastRun.startedAt} → ${data.sync.lastRun.finishedAt}` : "\n- 本次运行：旧版批次，未记录触发来源"}`
    : "";
  return `---\ndescription: Apple 健康导出中的身体、日常活动、运动与客观睡眠摘要\ndate: ${tokyoDay(data.importedAt)}\ntags: [身心健康, Apple健康, 数据导入]\nsensitivity: S2\n---\n\n# Apple 健康导入摘要\n\n> [!info] 导入边界\n> ${data.note} 原始 ZIP/XML 未保存在 Vault。完整结构化数据由工作台派生文件保存。\n\n- 更新时间：${data.importedAt}\n- ${sourceLabel}：${data.exportFile}${data.exportCreatedAt ? `（创建于 ${data.exportCreatedAt}）` : ""}${syncLine}\n- ${summaryLine(data)}\n\n## 身体测量\n\n| 日期 | 指标 | 数值 | 来源 |\n|---|---|---:|---|\n${bodyRows}\n\n## 最近客观睡眠\n\n| 日期 | 睡着时长 | 来源 |\n|---|---:|---|\n${sleepRows}\n\n## 最近运动\n\n| 日期 | 类型 | 时长 | 活动能量 | 来源 |\n|---|---|---:|---:|---|\n${workoutRows}\n`;
}

export function parseAppleHealthMarkdown(markdown) {
  const raw = String(markdown ?? "").match(/<!-- INFANS_APPLE_HEALTH_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- INFANS_APPLE_HEALTH_JSON_END -->/)?.[1];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function readAppleHealthData(vaultRoot) {
  const root = path.resolve(vaultRoot);
  const derivedPath = appleHealthDerivedPath(root);
  try {
    const parsed = JSON.parse(await fsp.readFile(derivedPath, "utf8"));
    if (parsed && typeof parsed === "object") return normalizeAppleHealthData(parsed);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const markdownPath = path.join(root, TARGET_PATH);
  let markdown;
  try {
    markdown = await fsp.readFile(markdownPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const data = parseAppleHealthMarkdown(markdown);
  return data ? normalizeAppleHealthData(data) : null;
}

async function fingerprintFile(filePath) {
  try { const content = await fsp.readFile(filePath, "utf8"); return crypto.createHash("sha256").update(content).digest("hex"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export function createAppleHealthImportService(vaultRoot, options = {}) {
  const root = path.resolve(vaultRoot); const pending = new Map(); const now = options.now ?? (() => new Date());
  const listCandidates = options.listCandidates
    ?? (options.localCandidates
      ? async () => {
          const found = [];
          for (const filePath of options.localCandidates) {
            try {
              const meta = await appleHealthCandidateMeta(filePath, path.extname(filePath).toLowerCase() === ".zip");
              if (meta) found.push(meta);
            } catch (error) { if (error?.code !== "ENOENT") throw error; }
          }
          return found.sort((a, b) => Number(b.zip) - Number(a.zip)
            || (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)
            || b.modifiedAt - a.modifiedAt);
        }
      : listAppleHealthDownloadCandidates);
  const stagePreview = async (filePath, fileName, sourceMeta = null) => {
    let stamped = sourceMeta;
    if (!stamped?.createdAt) {
      try {
        stamped = { ...formatFileCreatedAt(await fsp.lstat(filePath)), name: fileName };
      } catch {
        stamped = null;
      }
    }
    const sourceFile = sourceFileFromStamp(
      stamped?.name || fileName,
      stamped,
      stamped?.createdAtKind,
    );
    const data = await parseAppleHealthStream(await xmlStreamFor(filePath), {
      fileName,
      exportCreatedAt: sourceFile?.createdAt || "",
      exportCreatedAtKind: sourceFile?.createdAtKind || "",
    });
    const target = path.join(root, TARGET_PATH); const expectedHash = await fingerprintFile(target); const token = crypto.randomUUID(); const content = renderAppleHealthMarkdown(data); const expiresAt = now().getTime() + PREVIEW_TTL;
    pending.set(token, { content, expectedHash, expiresAt, data });
    // 整份摘要替换，没有可读的「之前」正文；确认框展示来源文件时间 + 将写入摘要行
    return {
      token,
      kind: "appleHealthImport",
      targetPath: TARGET_PATH,
      summary: "导入 Apple 健康摘要",
      before: "",
      after: previewAfterLine(data, sourceFile),
      expiresAt: new Date(expiresAt).toISOString(),
      health: data,
      sourceFile,
    };
  };
  return {
    async preview(request) {
      const fileName = decodeURIComponent(String(request.headers["x-infans-filename"] || "Apple健康导出"));
      if (/^export_cda\.xml$/i.test(path.basename(fileName))) throw new WorkbenchWriteError("你选择的是 export_cda.xml，它不是健康与运动主数据。请返回上一级选择“导出.zip”，或选择更大的“导出.xml”。", 400, "HEALTH_CDA_UNSUPPORTED");
      const browserStamp = formatBrowserFileStamp(request.headers["x-infans-file-modified"]);
      const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "infans-health-")); const upload = path.join(directory, "upload"); let size = 0;
      try {
        const handle = await fsp.open(upload, "wx");
        try { for await (const chunk of request) { size += chunk.length; if (size > MAX_UPLOAD) throw new WorkbenchWriteError("导出文件超过 1 GB，请优先选择未解压的“导出.zip”", 413, "HEALTH_UPLOAD_TOO_LARGE"); await handle.write(chunk); } } finally { await handle.close(); }
        if (!size) throw new WorkbenchWriteError("没有收到 Apple Health 导出文件");
        return await stagePreview(upload, fileName, browserStamp
          ? { ...browserStamp, name: fileName, createdAtKind: "browser" }
          : null);
      } finally { await fsp.rm(directory, { recursive: true, force: true }); }
    },
    async previewFromDownloads() {
      const selected = pickNewestAppleHealthDownload(await listCandidates());
      if (!selected) throw new WorkbenchWriteError("下载目录中没有找到“导出.zip”。请先从 iPhone 健康 App 导出，或使用手动选择。", 404, "HEALTH_LOCAL_EXPORT_MISSING");
      return await stagePreview(selected.filePath, path.basename(selected.filePath), selected);
    },
    async commit(token) {
      const item = pending.get(token); pending.delete(token);
      if (!item || item.expiresAt < now().getTime()) throw new WorkbenchWriteError("Apple 健康导入预览已过期", 409, "PREVIEW_EXPIRED");
      const target = path.join(root, TARGET_PATH); if (await fingerprintFile(target) !== item.expectedHash) throw new WorkbenchWriteError("Apple 健康摘要已被外部修改，本次导入已停止", 409, "WRITE_CONFLICT");
      await writeAppleHealthDerived(root, item.data);
      await atomicWriteFile(target, item.content, 0o600);
      return { ok: true, targetPath: TARGET_PATH, derivedPath: DERIVED_RELATIVE };
    },
  };
}

export const APPLE_HEALTH_SOURCE = TARGET_PATH;
