#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TOKYO_TZ = "Asia/Tokyo";
const WINDOW_GAP_MS = 45 * 60 * 1000;
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TOKYO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function tokyoParts(timestamp) {
  const parts = {};
  for (const item of dateFormatter.formatToParts(new Date(timestamp))) {
    if (item.type !== "literal") parts[item.type] = item.value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function messageText(row) {
  const content = row?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => typeof item === "string" || item?.type === "text")
    .map((item) => typeof item === "string" ? item : (item.text ?? ""))
    .join("\n");
}

function isAutomatedMessage(text) {
  const withoutTimestamp = String(text ?? "")
    .replace(/<timestamp>[^<]+<\/timestamp>/gi, "")
    .trimStart()
    .replace(/^<user_query>\s*/i, "");
  if (/^<(heartbeat|automation)(\s|>)/i.test(withoutTimestamp)) return true;

  // 统一 Agent runner 接管前，本机 LaunchAgent 会直接生成这类定时任务信封。
  // 它们不是使用者的本人开口，且后续的系统追问也应随整段 transcript 一并排除。
  return /^今天是日本时间 \d{4}-\d{2}-\d{2}。/u.test(withoutTimestamp)
    && /(?:身心日评|金融简报|月度总结|训练复盘|日本活动|小秘书每日版本收口|小秘书每周版本收口)_本机定时prompt\.md/u.test(withoutTimestamp)
    && /只允许写入(?:任务说明列出的)?白名单路径/u.test(withoutTimestamp);
}

function extractHandoff(text) {
  const normalized = String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join("\n");
  const start = normalized.indexOf("【身心日评交接】");
  if (start < 0) return null;

  const block = normalized.slice(start).split(/\n\s*\n/)[0].split("\n").slice(0, 7);
  const fields = {};
  for (const line of block.slice(1)) {
    const match = line.match(/^\s*([^：:]+)[：:]\s*(.+?)\s*$/);
    if (match) fields[match[1].trim()] = match[2].trim();
  }
  const date = fields["归属日"];
  const recognized = ["归属日", "活跃时段", "工作性质", "状态", "一句话"].filter((key) => fields[key]).length;
  if (!VALID_DATE.test(date ?? "") || recognized < 2) return null;
  return {
    date,
    activeWindows: fields["活跃时段"] ?? "未写",
    workType: fields["工作性质"] ?? "未写",
    status: fields["状态"] ?? "未写",
    note: fields["一句话"] ?? null,
  };
}

function earliestScanMtime(dates) {
  const earliest = dates.slice().sort()[0];
  return Date.parse(`${earliest}T00:00:00+09:00`) - 10 * 24 * 60 * 60 * 1000;
}

function listTranscriptFiles(projectRoot, dates) {
  const files = [];
  const minMtime = earliestScanMtime(dates);
  function walk(directory, insideTranscriptDirectory = false) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(target, insideTranscriptDirectory || entry.name === "agent-transcripts");
        continue;
      }
      if (!insideTranscriptDirectory || !entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        if (fs.statSync(target).mtimeMs >= minMtime) files.push(target);
      } catch {
        // 文件在扫描期间被移动时跳过；缺覆盖不能解释成没工作。
      }
    }
  }
  walk(projectRoot);
  return files;
}

function buildWindows(events) {
  const sorted = [...new Set(events)].sort((a, b) => a - b);
  const windows = [];
  for (const timestamp of sorted) {
    const current = windows.at(-1);
    if (!current || timestamp - current.last > WINDOW_GAP_MS) {
      windows.push({ first: timestamp, last: timestamp });
    } else {
      current.last = timestamp;
    }
  }
  return windows.map((window) => ({
    start: tokyoParts(window.first).time,
    end: tokyoParts(window.last).time,
  }));
}

export function scanCursorWorkload(dates, {
  projectRoot = path.join(os.homedir(), ".cursor/projects"),
} = {}) {
  if (!dates.length || dates.some((date) => !VALID_DATE.test(date))) throw new Error("日期必须使用 YYYY-MM-DD");
  const targets = new Map(dates.map((date) => [date, {
    events: [],
    roots: new Set(),
    markers: new Map(),
  }]));
  const seenEvents = new Set();

  for (const file of listTranscriptFiles(projectRoot, dates)) {
    const transcriptId = path.basename(file, ".jsonl");
    let rows;
    try {
      rows = fs.readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    } catch {
      continue;
    }
    const firstUserRow = rows.find((row) => row.role === "user");
    const automatedTranscript = firstUserRow ? isAutomatedMessage(messageText(firstUserRow)) : false;
    for (const row of rows) {
      const text = messageText(row);
      if (row.role === "user" && !automatedTranscript && !isAutomatedMessage(text)) {
        for (const match of text.matchAll(/<timestamp>([^<]+)<\/timestamp>/gi)) {
          const timestamp = Date.parse(match[1]);
          if (!Number.isFinite(timestamp)) continue;
          const local = tokyoParts(timestamp);
          if (!targets.has(local.date)) continue;
          const fingerprint = crypto.createHash("sha1").update(`${match[1]}\n${text}`).digest("hex");
          if (seenEvents.has(fingerprint)) continue;
          seenEvents.add(fingerprint);
          targets.get(local.date).events.push(timestamp);
          targets.get(local.date).roots.add(transcriptId);
        }
      }

      if (row.role !== "assistant") continue;
      const handoff = extractHandoff(text);
      if (!handoff || !targets.has(handoff.date)) continue;
      targets.get(handoff.date).markers.set(transcriptId, handoff);
    }
  }

  return dates.map((date) => {
    const target = targets.get(date);
    return {
      schemaVersion: 1,
      source: "cursor",
      date,
      activeWindows: buildWindows(target.events),
      rootTaskCount: target.roots.size,
      handoffs: [...target.markers.values()],
      caveat: "时段只取 Cursor 根对话中带东京时间戳的本人开口，并按内容去重；45 分钟无开口即拆段。mtime 只缩小扫描文件范围，不用于归属日期。它不是精确工时。",
    };
  });
}

function printText(results) {
  for (const result of results) {
    console.log(`Cursor 主任务工作量摘要 · ${result.date}`);
    console.log(result.activeWindows.length
      ? `- 本人活跃时段：${result.activeWindows.map((item) => item.start === item.end ? item.start : `${item.start}–${item.end}`).join("；")}`
      : "- 本人活跃时段：未查到");
    console.log(`- 涉及根任务：${result.rootTaskCount} 个（只作覆盖检查，不用于直接打分）`);
    console.log(`- 口径：${result.caveat}`);
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const jsonMode = args.includes("--json");
  const projectRootIndex = args.indexOf("--project-root");
  let projectRoot;
  if (projectRootIndex >= 0) {
    projectRoot = args[projectRootIndex + 1];
    if (!projectRoot) throw new Error("--project-root 缺少值");
    args.splice(projectRootIndex, 2);
  }
  return {
    jsonMode,
    projectRoot,
    dates: [...new Set(args.filter((arg) => arg !== "--json"))],
  };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const results = scanCursorWorkload(options.dates, { projectRoot: options.projectRoot });
    if (options.jsonMode) console.log(JSON.stringify(results, null, 2));
    else printText(results);
  } catch (error) {
    console.error(`用法：node cursor-workload-summary.mjs [--json] [--project-root PATH] YYYY-MM-DD [YYYY-MM-DD ...]\n${error.message}`);
    process.exitCode = 2;
  }
}
