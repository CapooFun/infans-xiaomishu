import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildRhythmExtras, buildVerdict, formatShortDate } from "./workbench-rhythm-check.mjs";
import { healthSourceGateForTask, readAppleHealthSourceReadiness } from "./workbench-health-readiness.mjs";

const HOME = os.homedir();
const STATE = path.join(HOME, ".local", "state");
const AGENTS = path.join(HOME, "Library", "LaunchAgents");
const BIN = path.join(HOME, ".local", "bin");

/** @typedef {"daily" | "monthly" | "weekly" | "quarterly"} CronCadence */
/** @typedef {"ok" | "failed" | "running" | "pending" | "waiting" | "idle" | "missed" | "missing"} CronStatus */

/**
 * @type {Array<{
 *   id: string;
 *   name: string;
 *   blurb: string;
 *   scheduleLabel: string;
 *   cadence: CronCadence;
 *   hour: number;
 *   minute: number;
 *   eventDriven?: boolean;
 *   intervalWeeks?: number;
 *   anchorDate?: string | null;
 *   weekday?: number | null;
 *   dayOfMonth?: number | null;
 *   monthsOfYear?: number[];
 *   plist: string;
 *   script: string;
 *   logFile: string;
 *   extraLogFiles?: string[];
 *   lockDir: string;
 *   stampFile?: string | null;
 *   successPatterns: RegExp[];
 *   failPatterns: RegExp[];
 *   waitPatterns?: RegExp[];
 * }>}
 */
const TASKS = [
  {
    id: "workbench-daily-health",
    name: "小秘书每日轻量检查",
    blurb: "不调用模型；只看调度、备份和可选运行健康",
    scheduleLabel: "每天 06:00",
    cadence: "daily",
    hour: 6,
    minute: 0,
    plist: "com.capoo.infans-workbench-daily-health.plist",
    script: "infans_workbench_daily_health.sh",
    logFile: "infans_workbench_daily_health.log",
    lockDir: "infans_workbench_daily_health.lock",
    stampFile: null,
    successPatterns: [/✅ 轻量检查通过/],
    failPatterns: [/❌/],
  },
  {
    id: "workbench-daily-release",
    name: "小秘书版本收口",
    blurb: "Cursor 每周汇总各施工 Agent 交接并形成稳定版",
    scheduleLabel: "每周一 06:00",
    cadence: "weekly",
    hour: 6,
    minute: 0,
    weekday: 1,
    plist: "com.capoo.infans-workbench-daily-release.plist",
    script: "infans_workbench_daily_release.sh",
    logFile: "infans_workbench_daily_release.log",
    lockDir: "infans_workbench_daily_release.lock",
    stampFile: null,
    successPatterns: [
      /✅ 无待收口/,
      /✅ 已收口/,
      /✅ 当前版本号：/,
      /✅ 已升级版本号：/,
      /❌ 版本队列仍有待处理事项；Cursor 已保留原因/,
    ],
    failPatterns: [/❌/],
  },
  {
    id: "vault-backup",
    name: "Vault 备份",
    blurb: "提交并镜像到 NAS",
    scheduleLabel: "每天 07:10",
    cadence: "daily",
    hour: 7,
    minute: 10,
    plist: "com.capoo.infans-vault-backup.plist",
    script: "infans_vault_backup.sh",
    logFile: "infans_vault_backup.log",
    extraLogFiles: ["infans_vault_launchd.log"],
    lockDir: "infans_vault_backup.lock",
    stampFile: null,
    successPatterns: [/推送成功/, /镜像触发/, /没有变更/, /已提交/, /Git 分支 .* 已推送到 NAS/, /主库完整镜像已/, /主库 NAS 镜像成功/],
    failPatterns: [/❌/, /失败/, /error/i, /unbound variable/i, /fatal:/i],
  },
  {
    id: "world-brief",
    name: "世界资讯",
    blurb: "覆盖写入金融、AI、游戏、日本四栏",
    scheduleLabel: "每天 06:10",
    cadence: "daily",
    hour: 6,
    minute: 10,
    plist: "com.capoo.infans-world-brief.plist",
    script: "infans_world_brief.sh",
    logFile: "infans_world_brief.log",
    lockDir: "infans_world_brief.lock",
    stampFile: "50_世界资讯/日本/当前.md",
    extraStampFiles: ["50_世界资讯/金融/当前简报.md", "50_世界资讯/AI/当前.md", "50_世界资讯/游戏/当前.md"],
    successPatterns: [/✅/],
    failPatterns: [/❌/],
  },
  {
    id: "health-daily",
    name: "身心日评",
    blurb: "负荷 · 成果 · 恢复 · 周一周报",
    scheduleLabel: "每天 06:30",
    cadence: "daily",
    hour: 6,
    minute: 30,
    plist: "com.capoo.infans-health-daily.plist",
    script: "infans_health_daily.sh",
    logFile: "infans_health_daily.log",
    lockDir: "infans_health_daily.lock",
    stampFile: "40_身心健康/状态报告/当前身心日评.md",
    successPatterns: [/✅/],
    failPatterns: [/❌/],
  },
  {
    id: "monthly-review",
    name: "身心月报",
    blurb: "写上月长期趋势、校准与下一阶段重点",
    scheduleLabel: "每月 1 日 06:05",
    cadence: "monthly",
    hour: 6,
    minute: 5,
    dayOfMonth: 1,
    plist: "com.capoo.infans-monthly-review.plist",
    script: "infans_monthly_review.sh",
    logFile: "infans_monthly_review.log",
    lockDir: "infans_monthly_review.lock",
    stampFile: null,
    successPatterns: [/✅/],
    failPatterns: [/❌/],
    waitPatterns: [/⏸.*待苹果健康导入/],
  },
  {
    id: "training-review",
    name: "训练复盘",
    blurb: "主项 + 训练建议落档",
    scheduleLabel: "每周一 06:35",
    cadence: "weekly",
    hour: 6,
    minute: 35,
    weekday: 1,
    plist: "com.capoo.infans-training-review.plist",
    script: "infans_training_review.sh",
    logFile: "infans_training_review.log",
    lockDir: "infans_training_review.lock",
    stampFile: null,
    successPatterns: [/✅/],
    failPatterns: [/❌/],
    waitPatterns: [/⏸.*待苹果健康导入/],
  },
  {
    id: "japan-activities",
    name: "本地活动",
    blurb: "身边能去的活动卡；当前按官方源刷新",
    scheduleLabel: "隔周一 09:00",
    cadence: "weekly",
    hour: 9,
    minute: 0,
    weekday: 1,
    intervalWeeks: 2,
    anchorDate: "2026-09-07",
    plist: "com.capoo.infans-japan-activities.plist",
    script: "infans_japan_activities.sh",
    logFile: "infans_japan_activities.log",
    lockDir: "infans_japan_activities.lock",
    stampFile: "80_生活事务/日本游玩攻略/日本活动.md",
    successPatterns: [/✅ 已更新/],
    failPatterns: [/❌/, /已恢复旧活动卡/],
  },
  {
    id: "ai-tools-quarterly",
    name: "AI 工具季报",
    blurb: "核对已用工具的重大迭代",
    scheduleLabel: "每季度第一天 09:30",
    cadence: "quarterly",
    hour: 9,
    minute: 30,
    dayOfMonth: 1,
    monthsOfYear: [1, 4, 7, 10],
    plist: "com.capoo.infans-ai-tools-quarterly.plist",
    script: "infans_ai_tools_quarterly.sh",
    logFile: "infans_ai_tools_quarterly.log",
    lockDir: "infans_ai_tools_quarterly.lock",
    stampFile: null,
    successPatterns: [/✅ .* 报告已写入小秘书横幅/, /⏸ .* 不调用模型/, /⏸ .* 报告已存在/],
    failPatterns: [/❌/],
  },
  {
    id: "anki-snapshot",
    name: "Anki 快照",
    blurb: "背词进度写入派生文件",
    scheduleLabel: "每天 07:15",
    cadence: "daily",
    hour: 7,
    minute: 15,
    plist: "com.capoo.infans-anki-snapshot.plist",
    script: "infans_anki_snapshot.sh",
    logFile: "infans_anki_snapshot.log",
    lockDir: "infans_anki_snapshot.lock",
    stampFile: "00_本地工作台/派生数据/anki-snapshot.json",
    // 打开后仍连不上、只保留旧快照 ≠ 今天跑成功，要能点卡重跑。
    successPatterns: [/✅/, /快照已写/],
    failPatterns: [/❌/, /Anki 未开/, /AnkiConnect 仍连不上/, /已保留旧快照/],
  },
];

const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]));
const RERUN_STATUSES = new Set(["failed", "missed"]);

function tokyoParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    month: Number(get("month")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdayMap[get("weekday")] ?? null,
    dayOfMonth: Number(get("day")),
  };
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readTail(filePath, maxBytes = 48_000) {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const size = stat.size;
      if (size <= 0) return "";
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function parseFrontmatterDate(markdown = "") {
  const match = String(markdown).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const updatedLine = match[1].match(/^updated:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m);
  const dateLine = match[1].match(/^date:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m);
  return updatedLine?.[1] || dateLine?.[1] || null;
}

/**
 * @param {string} text
 * @param {RegExp[]} successPatterns
 * @param {RegExp[]} failPatterns
 */
/** 行首时间戳 → 东京日历日（兼容 `2026-08-08T22:15:01Z`）。 */
function stampFromLogLine(line) {
  const iso = String(line || "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/);
  if (iso) {
    const tokyo = tokyoParts(new Date(iso[1]));
    return {
      date: tokyo.date,
      time: `${String(tokyo.hour).padStart(2, "0")}:${String(tokyo.minute).padStart(2, "0")}`,
    };
  }
  const stamp = String(line || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (!stamp) return { date: null, time: null };
  return { date: stamp[1], time: stamp[2] };
}

export function scanLog(text, successPatterns, failPatterns, waitPatterns = []) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  /** @type {Array<{ date: string | null; time: string | null; line: string; kind: "ok" | "fail" | "wait" | "other" }>} */
  const events = [];
  for (const line of lines) {
    const { date, time } = stampFromLogLine(line);
    let kind = "other";
    if (waitPatterns.some((pattern) => pattern.test(line))) kind = "wait";
    else if (successPatterns.some((pattern) => pattern.test(line))) kind = "ok";
    else if (failPatterns.some((pattern) => pattern.test(line))) kind = "fail";
    if (kind !== "other" || /开始|跳过|stamp_file/.test(line)) {
      events.push({ date, time, line: line.slice(0, 220), kind });
    }
  }
  const lastOk = [...events].reverse().find((event) => event.kind === "ok") || null;
  const lastFail = [...events].reverse().find((event) => event.kind === "fail") || null;
  const lastWait = [...events].reverse().find((event) => event.kind === "wait") || null;
  const recent = events.slice(-8).map((event) => event.line);
  return { lastOk, lastFail, lastWait, recent };
}

function calendarDayNumber(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000) : null;
}

export function scheduledToday(task, tokyo) {
  if (task.eventDriven) return false;
  if (task.cadence === "daily") return true;
  if (task.cadence === "monthly") return tokyo.dayOfMonth === (task.dayOfMonth ?? 1);
  if (task.cadence === "quarterly") {
    return tokyo.dayOfMonth === (task.dayOfMonth ?? 1) && (task.monthsOfYear || [1, 4, 7, 10]).includes(tokyo.month);
  }
  if (task.cadence === "weekly") {
    if (tokyo.weekday !== (task.weekday ?? 0)) return false;
    if (!task.intervalWeeks || task.intervalWeeks <= 1 || !task.anchorDate) return true;
    const today = calendarDayNumber(tokyo.date);
    const anchor = calendarDayNumber(task.anchorDate);
    return today !== null && anchor !== null && today >= anchor && (today - anchor) % (task.intervalWeeks * 7) === 0;
  }
  return false;
}

function schedulePassed(task, tokyo) {
  const nowMinutes = tokyo.hour * 60 + tokyo.minute;
  const dueMinutes = task.hour * 60 + task.minute;
  return nowMinutes >= dueMinutes + 3;
}

function shiftCalendarDay(dayKey, amount) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function partsForDay(dayKey) {
  const [year, month, day] = String(dayKey).split("-").map(Number);
  return {
    date: dayKey,
    month,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    dayOfMonth: day,
    hour: 0,
    minute: 0,
  };
}

function taskClock(task) {
  return `${String(task.hour).padStart(2, "0")}:${String(task.minute).padStart(2, "0")}`;
}

/** 下一次自动触发；失败/等待中的本次先显示为待处理，不假装已经翻篇。 */
export function nextRunLabel(task, tokyo, status) {
  if (task.eventDriven) return task.scheduleLabel;
  const clock = taskClock(task);
  if (scheduledToday(task, tokyo) && ["failed", "missed", "waiting"].includes(status)) {
    return `本次待处理 · 原定今天 ${clock}`;
  }
  const nowMinutes = tokyo.hour * 60 + tokyo.minute;
  const dueMinutes = task.hour * 60 + task.minute;
  if (task.cadence === "daily") {
    return nowMinutes < dueMinutes ? `今天 ${clock}` : `明天 ${clock}`;
  }
  for (let offset = 0; offset <= 400; offset += 1) {
    if (offset === 0 && nowMinutes >= dueMinutes) continue;
    const date = shiftCalendarDay(tokyo.date, offset);
    const candidate = partsForDay(date);
    if (scheduledToday(task, candidate)) return `${date} ${clock}`;
  }
  return task.scheduleLabel;
}

function cleanLogSentence(line = "") {
  return String(line)
    .replace(/^\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s+JST)?\s*/, "")
    .replace(/^[✅❌⏸]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function quarterEndLabel(dayKey) {
  const [year, month] = String(dayKey).split("-").map(Number);
  const quarter = Math.floor((month - 1) / 3) + 1;
  const endMonth = quarter * 3;
  const endDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  return `${year} Q${quarter} · ${endMonth}/${endDay} 前完成`;
}

function requirement(id, label, state, detail, action) {
  return { id, label, state, detail, ...(action ? { action } : {}) };
}

function readinessFromRequirements(rows) {
  const missing = rows.filter((row) => row.state === "missing").length;
  const checks = rows.filter((row) => row.state === "check").length;
  if (missing) return { readinessStatus: "blocked", readinessLabel: `还缺 ${missing} 项，暂不能顺利执行` };
  if (checks) return { readinessStatus: "check", readinessLabel: `基本齐全 · 执行时确认 ${checks} 项` };
  return { readinessStatus: "ready", readinessLabel: "条件已齐，可以按时执行" };
}

export function healthRequirementForTask(task, healthSource, options = {}) {
  const nextDate = String(task.nextRunLabel || "").match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
  const nextRequiredThrough = nextDate ? shiftCalendarDay(nextDate, -1) : healthSource?.requiredThrough || null;
  const currentlyMissing = !healthSource?.ready;
  const stillBuilding = !currentlyMissing
    && Boolean(nextRequiredThrough && healthSource?.asOf && healthSource.asOf < nextRequiredThrough);
  const state = currentlyMissing
    ? (options.optional ? "optional" : "missing")
    : stillBuilding
      ? (options.optional ? "optional" : "check")
      : "ready";
  const detail = currentlyMissing
    ? `${healthSource?.detail || "还没有可核对的 Apple Health 覆盖日期"}${nextDate && nextRequiredThrough !== healthSource?.requiredThrough ? `；${nextDate} 执行前还需覆盖到 ${nextRequiredThrough}` : ""}`
    : stillBuilding
      ? `当前已覆盖到 ${healthSource.asOf}；${nextDate} 执行前还需覆盖到 ${nextRequiredThrough}`
      : `Apple Health 已覆盖到 ${healthSource?.asOf || nextRequiredThrough || "所需截止日"}`;
  return requirement("apple-health", "Apple Health 覆盖", state, detail, "apple-health");
}

function conditionRowsForTask(task, rhythm, healthSource) {
  const freshness = new Map((rhythm.freshness || []).map((row) => [row.id, row]));
  const weekly = rhythm.coverage?.weekly;
  const monthly = rhythm.coverage?.monthly;
  const runnerState = task.agentInstalled && task.scriptInstalled ? "ready" : "missing";
  const rows = [requirement(
    "runner",
    "运行器",
    runnerState,
    runnerState === "ready" ? "定时登记与执行脚本都在" : "LaunchAgent 或执行脚本缺失",
  )];
  const addFreshness = (id, label, options = {}) => {
    const row = freshness.get(id);
    if (!row) return;
    rows.push(requirement(
      id,
      label,
      row.alarm && options.required ? "missing" : (options.optional ? "optional" : "ready"),
      row.detail,
      options.action,
    ));
  };

  if (task.id === "vault-backup") {
    rows.push(requirement("nas-link", "私人 NAS 链路", task.status === "missed" || task.status === "failed" ? "missing" : "check", task.status === "missed" || task.status === "failed" ? "脚本已修，尚缺一次内容镜像成功证据" : "执行时确认 NAS 可达并核对镜像指纹"));
  } else if (task.id === "workbench-daily-health") {
    rows.push(requirement("no-model", "不调用模型", "ready", "只回读调度、备份日志和可选运行健康"));
  } else if (task.id === "workbench-daily-release") {
    rows.push(requirement("main-agent", "主收口 Agent", "ready", "当前绑定 Cursor；其他 Agent 只提交稳定 ID、状态与证据"));
    rows.push(requirement("semantic-gap", "GPT／Codex 语义收拢", "check", "当前不能自动启动；缺本周交接时只记缺口，不代做合并归档"));
  } else if (task.id === "world-brief") {
    rows.push(requirement("official-sources", "一手来源", "check", "执行时打开官方页抄原文，打不开就留空，不编课文"));
    rows.push(requirement("news-algorithm", "新闻算法", "ready", "先读可见的选稿规矩，收藏只加权，不喜欢只押后，不为凑满只喂爱看的类"));
  } else if (task.id === "health-daily") {
    addFreshness("diary", "日志与恢复记录");
    rows.push(requirement("gpt-handoff", "GPT 交接", "optional", "没有交接也会明确记为无交接并继续"));
  } else if (task.id === "anki-snapshot") {
    addFreshness("anki", "Anki 快照");
    rows.push(requirement("anki-connect", "AnkiConnect", task.status === "ok" ? "ready" : "check", task.status === "ok" ? "上次已连接成功；脚本会按需自动打开 Anki" : "执行时会自动打开 Anki 并等待连接"));
  } else if (task.id === "training-review") {
    rows.push(healthRequirementForTask(task, healthSource));
    if (weekly?.training) rows.push(requirement("training", "训练日志", "optional", weekly.training.detail));
    addFreshness("body", "体重 / 腰围", { optional: true });
  } else if (task.id === "monthly-review") {
    rows.push(healthRequirementForTask(task, healthSource, { optional: true }));
    if (monthly?.sleep) rows.push(requirement("month-sleep", "上月睡眠覆盖", monthly.sleep.alarm ? "check" : "ready", monthly.sleep.detail));
    if (monthly?.assets) {
      const cycle = monthly.assets.cycle;
      const waitingForNextCycle = cycle?.state === "next-pending";
      rows.push(requirement(
        "assets",
        "资产盘点",
        waitingForNextCycle || monthly.assets.alarm ? "check" : "ready",
        waitingForNextCycle
          ? `${cycle.targetMonthKey} 月末盘点待安排 · ${formatShortDate(cycle.opensAt)} 开放，${formatShortDate(cycle.dueAt)} 前完成`
          : monthly.assets.detail,
      ));
    }
  } else if (task.id === "japan-activities") {
    rows.push(requirement("official-sources", "官方活动来源", "check", "执行时联网核验；不需要你预先上传"));
  } else if (task.id === "ai-tools-quarterly") {
    rows.push(requirement("used-tools", "已用工具清单", "ready", "只读 0600 使用记录；没有已用工具时不调用模型"));
    rows.push(requirement("official-sources", "官方更新来源", "check", "执行时联网核对，不读登录凭据"));
  }
  return rows;
}

function quarterlyRecoveryTask(tokyo) {
  const requirements = [
    requirement("nas-sample", "NAS 内容镜像", "check", "恢复一个普通文件和一个小目录到临时位置"),
    requirement("google-sample", "Google 加密档案", "check", "恢复一个普通小文件并验证解密链路"),
    requirement("safe-record", "安全记录", "ready", "不用 S1 样本、不覆盖正式原件，完成后记录结果"),
  ];
  return {
    id: "quarterly-restore-drill",
    name: "备份恢复演练",
    blurb: "NAS 与 Google 加密档案的小样本真实恢复",
    scheduleLabel: "每季度一次 · 季末前",
    cadence: "quarterly",
    dueToday: false,
    status: "idle",
    statusLabel: "本季待安排",
    running: false,
    canRerun: false,
    agentInstalled: true,
    scriptInstalled: false,
    lastOkAt: null,
    lastFailAt: null,
    outputDate: null,
    detail: "当前规则要求每季度做一次；尚无可核对的完成记录",
    recentLines: [],
    nextRunLabel: quarterEndLabel(tokyo.date),
    lastOutcomeState: "none",
    lastOutcomeLabel: "上次执行暂无证据",
    lastOutcomeAt: null,
    lastOutcomeSummary: "没有找到可核对的季度恢复演练记录，不能当作已经做过",
    ...readinessFromRequirements(requirements),
    requirements,
  };
}

function statusLabel(status, task) {
  if (status === "idle" && task?.eventDriven) return "按需同步";
  switch (status) {
    case "ok":
      return "今天成功";
    case "failed":
      return "今天失败";
    case "running":
      return "正在跑";
    case "pending":
      return "还没到点 / 待跑";
    case "waiting":
      return "待健康导入";
    case "missed":
      return "今天该跑但没成功";
    case "idle":
      return "今天不用跑";
    case "missing":
      return "定时未安装";
    default:
      return status;
  }
}

/**
 * @param {string} vaultRoot
 */
export async function readCronMonitor(vaultRoot) {
  const tokyo = tokyoParts();
  const tasks = [];
  let currentWorkbenchVersion = null;
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(vaultRoot, "00_本地工作台/app/package.json"), "utf8"));
    currentWorkbenchVersion = typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    currentWorkbenchVersion = null;
  }
  let healthSource = { ready: true, asOf: null, requiredThrough: null, detail: "" };
  try {
    healthSource = await readAppleHealthSourceReadiness(vaultRoot, tokyo.date);
  } catch (error) {
    healthSource = {
      ready: false,
      asOf: null,
      requiredThrough: null,
      detail: error instanceof Error ? `健康原料检查失败：${error.message}` : "健康原料检查失败",
    };
  }

  for (const task of TASKS) {
    const plistPath = path.join(AGENTS, task.plist);
    const scriptPath = path.join(BIN, task.script);
    const logPath = path.join(STATE, task.logFile);
    const extraLogPaths = (task.extraLogFiles || []).map((file) => path.join(STATE, file));
    const lockPath = path.join(STATE, task.lockDir);
    const [agentInstalled, scriptInstalled, running, primaryLogText, extraLogTexts] = await Promise.all([
      pathExists(plistPath),
      pathExists(scriptPath),
      pathExists(lockPath),
      readTail(logPath),
      Promise.all(extraLogPaths.map((file) => readTail(file))),
    ]);
    // launchd stderr 放前面，任务自己的带时间日志放后面；修复后的新记录不会被旧 stderr 淹没。
    const logText = [...extraLogTexts, primaryLogText].filter(Boolean).join("\n");
    const scanned = scanLog(logText, task.successPatterns, task.failPatterns, task.waitPatterns);
    let outputDate = null;
    if (task.stampFile) {
      try {
        const stampText = await fs.readFile(path.join(vaultRoot, task.stampFile), "utf8");
        if (task.stampFile.endsWith(".json")) {
          const parsed = JSON.parse(stampText);
          const raw = String(parsed.syncedAt || parsed.tokyoDay || parsed.date || "");
          outputDate = raw.match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
        } else {
          outputDate = parseFrontmatterDate(stampText);
        }
      } catch {
        outputDate = null;
      }
    }

    const dueToday = scheduledToday(task, tokyo);
    const sourceGate = dueToday ? healthSourceGateForTask(task.id, { daily: healthSource.asOf ? [{ date: healthSource.asOf }] : [] }, tokyo.date) : null;
    const okToday = scanned.lastOk?.date === tokyo.date;
    const failToday = scanned.lastFail?.date === tokyo.date
      && (!scanned.lastOk?.date || scanned.lastFail.date > scanned.lastOk.date
        || (scanned.lastFail.date === scanned.lastOk.date && String(scanned.lastFail.time || "") >= String(scanned.lastOk.time || "")));

    /** @type {CronStatus} */
    let status = "idle";
    const waitAfterSuccess = scanned.lastWait?.date === tokyo.date
      && (!scanned.lastOk?.date || scanned.lastWait.date > scanned.lastOk.date
        || (scanned.lastWait.date === scanned.lastOk.date && String(scanned.lastWait.time || "") >= String(scanned.lastOk.time || "")));
    if (!agentInstalled) status = "missing";
    else if (running) status = "running";
    else if (sourceGate && !sourceGate.ready) status = "waiting";
    else if (waitAfterSuccess) status = "missed";
    else if (okToday) status = "ok";
    else if (failToday) status = "failed";
    else if (dueToday) status = schedulePassed(task, tokyo) ? "missed" : "pending";
    else status = "idle";

    const skipped = /跳过/.test(scanned.recent.join("\n")) || /跳过/.test(logText.slice(-2000));
    if (task.id === "training-review" && skipped && !waitAfterSuccess && (status === "ok" || status === "idle" || status === "missed")) {
      if (scanned.lastOk?.date === tokyo.date || /跳过/.test(String(scanned.lastOk?.line || ""))) {
        status = "ok";
      }
    }

    const detailBits = [];
    if (sourceGate && !sourceGate.ready) detailBits.push(sourceGate.detail);
    if (sourceGate?.ready && waitAfterSuccess) detailBits.push("健康数据已补齐，可以重跑");
    if (task.id === "training-review" && skipped && status === "ok" && (!sourceGate || sourceGate.ready)) detailBits.push("跳过属正常（无新练或未到门槛）");
    if (task.intervalWeeks === 2 && tokyo.weekday === task.weekday && !dueToday) detailBits.push("本周按隔周规则休息");
    if (scanned.lastOk) detailBits.push(`上次成功 ${scanned.lastOk.date}${scanned.lastOk.time ? ` ${scanned.lastOk.time}` : ""}`);
    if (scanned.lastFail && scanned.lastFail.date === tokyo.date) detailBits.push(`今天失败记录有`);
    if (outputDate) detailBits.push(`产出日期 ${outputDate}`);
    if (!scriptInstalled) detailBits.push("执行脚本缺失");

    const canRerun = scriptInstalled && RERUN_STATUSES.has(status) && !running;
    if (canRerun) detailBits.push("点一下可重跑");

    const unboundFailure = task.id === "vault-backup" && /EXCLUDES\[@\].*unbound variable|unbound variable/i.test(logText);
    const currentNeedsAttention = ["failed", "missed", "waiting"].includes(status);
    const lastOutcomeState = status === "waiting"
      ? "waiting"
      : currentNeedsAttention
        ? "failed"
        : scanned.lastOk
          ? "success"
          : scanned.lastFail
            ? "failed"
            : "none";
    const lastOutcomeLabel = status === "waiting"
      ? "本次未执行"
      : currentNeedsAttention
        ? "本次没有跑成"
        : scanned.lastOk
          ? "上次顺利执行"
          : scanned.lastFail
            ? "上次执行失败"
            : "上次执行暂无证据";
    const lastOutcomeAt = currentNeedsAttention
      ? (dueToday ? `${tokyo.date} ${taskClock(task)}` : (scanned.lastFail ? `${scanned.lastFail.date || "日期不明"}${scanned.lastFail.time ? ` ${scanned.lastFail.time}` : ""}` : null))
      : scanned.lastOk
        ? `${scanned.lastOk.date || "日期不明"}${scanned.lastOk.time ? ` ${scanned.lastOk.time}` : ""}`
        : scanned.lastFail
          ? `${scanned.lastFail.date || "日期不明"}${scanned.lastFail.time ? ` ${scanned.lastFail.time}` : ""}`
          : null;
    const lastOutcomeSummary = status === "waiting"
      ? (sourceGate?.detail || "运行条件还没有齐，所以没有启动")
      : unboundFailure && currentNeedsAttention
        ? "脚本曾在空排除清单处中断；兼容修复已安装，尚缺一次补跑成功证据"
        : currentNeedsAttention
          ? (failToday && scanned.lastFail ? cleanLogSentence(scanned.lastFail.line) : `原定 ${taskClock(task)} 后没有找到成功记录${scanned.lastFail ? `；最近失败：${cleanLogSentence(scanned.lastFail.line)}` : ""}`)
          : scanned.lastOk
            ? `${cleanLogSentence(scanned.lastOk.line)}${outputDate ? `；产出日期 ${outputDate}` : ""}`
            : scanned.lastFail
              ? cleanLogSentence(scanned.lastFail.line)
              : "没有可核对的运行记录";
    const explicitReleaseVersion = task.id === "workbench-daily-release"
      ? scanned.lastOk?.line.match(/(已升级版本号|当前版本号)：\s*(V?\d+(?:\.\d+){2})/)
      : null;
    const versionOutcomeLabel = task.id === "workbench-daily-release" && status === "ok"
      ? explicitReleaseVersion
        ? `${explicitReleaseVersion[1]}：${explicitReleaseVersion[2].startsWith("V") ? explicitReleaseVersion[2] : `V${explicitReleaseVersion[2]}`}`
        : currentWorkbenchVersion
          ? `当前版本号：V${currentWorkbenchVersion}`
          : null
      : null;

    tasks.push({
      id: task.id,
      name: task.name,
      blurb: task.blurb,
      scheduleLabel: task.scheduleLabel,
      cadence: task.cadence,
      dueToday,
      status,
      statusLabel: statusLabel(status, task),
      running,
      canRerun,
      agentInstalled,
      scriptInstalled,
      lastOkAt: scanned.lastOk ? `${scanned.lastOk.date}${scanned.lastOk.time ? ` ${scanned.lastOk.time}` : ""}` : null,
      lastFailAt: scanned.lastFail ? `${scanned.lastFail.date}${scanned.lastFail.time ? ` ${scanned.lastFail.time}` : ""}` : null,
      outputDate,
      detail: detailBits.join(" · ") || "还没有可读记录",
      recentLines: scanned.recent,
      nextRunLabel: nextRunLabel(task, tokyo, status),
      lastOutcomeState,
      lastOutcomeLabel,
      lastOutcomeAt,
      lastOutcomeSummary,
      versionOutcomeLabel,
      readinessStatus: "check",
      readinessLabel: "正在核对条件",
      requirements: [],
    });
  }

  const summary = {
    ok: tasks.filter((task) => task.status === "ok").length,
    failed: tasks.filter((task) => task.status === "failed" || task.status === "missed").length,
    running: tasks.filter((task) => task.status === "running").length,
    pending: tasks.filter((task) => task.status === "pending" || task.status === "waiting").length,
    missing: tasks.filter((task) => task.status === "missing").length,
  };

  let rhythm = {
    freshness: [],
    coverage: null,
    materialAlarms: 0,
    noteExtras: "",
  };
  try {
    rhythm = await buildRhythmExtras(vaultRoot, tokyo.date, { hour: tokyo.hour });
  } catch (error) {
    rhythm = {
      freshness: [],
      coverage: null,
      materialAlarms: 0,
      noteExtras: error instanceof Error ? `原料读取失败：${error.message}` : "原料读取失败",
    };
  }

  for (const task of tasks) {
    task.requirements = conditionRowsForTask(task, rhythm, healthSource);
    Object.assign(task, readinessFromRequirements(task.requirements));
  }
  tasks.push(quarterlyRecoveryTask(tokyo));
  summary.blocked = tasks.filter((task) => task.readinessStatus === "blocked").length;

  const verdict = buildVerdict(tasks, rhythm.materialAlarms || 0);
  const dailyTasks = tasks.filter((task) => task.cadence === "daily");
  const weeklyTasks = tasks.filter((task) => task.cadence === "weekly");
  const monthlyTasks = tasks.filter((task) => task.cadence === "monthly");
  const quarterlyTasks = tasks.filter((task) => task.cadence === "quarterly");

  return {
    observedAt: new Date().toISOString(),
    today: tokyo.date,
    summary: {
      ...summary,
      materialAlarms: rhythm.materialAlarms || 0,
    },
    verdict,
    tasks,
    sections: {
      daily: { tasks: dailyTasks, freshness: rhythm.freshness || [] },
      weekly: {
        tasks: weeklyTasks,
        coverage: rhythm.coverage?.weekly || null,
      },
      monthly: {
        tasks: monthlyTasks,
        coverage: rhythm.coverage?.monthly || null,
      },
      quarterly: { tasks: quarterlyTasks },
    },
    freshness: rhythm.freshness || [],
    coverage: rhythm.coverage,
    note: "看定时有没有跑完，以及原料有效到哪天、覆盖够不够、资产还缺哪几项。",
    noteExtras: rhythm.noteExtras || "",
  };
}

async function startTaskScript(task, vaultRoot) {
  const scriptPath = path.join(BIN, task.script);
  const lockPath = path.join(STATE, task.lockDir);
  if (!(await pathExists(scriptPath))) {
    return { id: task.id, name: task.name, ok: false, started: false, message: "执行脚本缺失" };
  }
  if (await pathExists(lockPath)) {
    return { id: task.id, name: task.name, ok: false, started: false, message: "已经在跑了" };
  }
  const child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
    cwd: HOME,
    env: {
      ...process.env,
      INFANS_VAULT_ROOT: path.resolve(vaultRoot),
      PATH: `${BIN}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ""}`,
    },
  });
  child.unref();
  return { id: task.id, name: task.name, ok: true, started: true, message: "已开始重跑" };
}

/**
 * 手动重跑定时脚本（仅白名单任务；由工作台持久写入身份门禁授权）。
 * @param {string} vaultRoot
 * @param {{ ids?: string[]; failedToday?: boolean; cadence?: CronCadence | null }} [options]
 */
export async function runCronTasks(vaultRoot, options = {}) {
  const root = path.resolve(vaultRoot);
  const failedToday = Boolean(options.failedToday);
  const cadence = options.cadence || null;
  const requestedIds = Array.isArray(options.ids)
    ? options.ids.map((id) => String(id || "").trim()).filter(Boolean)
    : options.id
      ? [String(options.id).trim()]
      : [];

  if (!failedToday && !requestedIds.length) {
    return { ok: false, message: "请指定任务，或选择重跑今天没成功的", results: [] };
  }

  for (const id of requestedIds) {
    if (!TASK_BY_ID.has(id)) {
      return { ok: false, message: `未知任务：${id}`, results: [] };
    }
  }

  const monitor = await readCronMonitor(root);
  /** @type {typeof monitor.tasks} */
  let targets = [];
  if (failedToday) {
    targets = monitor.tasks.filter((task) => {
      if (!RERUN_STATUSES.has(task.status) || !task.scriptInstalled || task.running) return false;
      if (cadence && task.cadence !== cadence) return false;
      return true;
    });
  } else {
    const wanted = new Set(requestedIds);
    targets = monitor.tasks.filter((task) => wanted.has(task.id));
  }

  if (!targets.length) {
    return { ok: true, message: failedToday ? "今天没有能重跑的失败任务" : "没有可重跑的任务", results: [] };
  }

  const results = [];
  for (const row of targets) {
    const def = TASK_BY_ID.get(row.id);
    if (!def) continue;
    if (!RERUN_STATUSES.has(row.status)) {
      results.push({ id: row.id, name: row.name, ok: false, started: false, message: "当前不是失败状态，不用重跑" });
      continue;
    }
    results.push(await startTaskScript(def, root));
  }

  const started = results.filter((item) => item.started).length;
  return {
    ok: started > 0 || results.every((item) => item.ok),
    message: started > 0 ? `已开始重跑 ${started} 个任务` : (results[0]?.message || "没有启动任何任务"),
    results,
  };
}
