#!/usr/bin/env node

// 平台无关的只读 Codex 会话适配器；正式工作强度口径不在本脚本维护。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKYO_TZ = "Asia/Tokyo";
const WINDOW_GAP_MS = 45 * 60 * 1000;
const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
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

function isRootUserTask(meta) {
  if (!meta || meta.type !== "session_meta") return false;
  const payload = meta.payload ?? {};
  if (payload.parent_thread_id) return false;
  if (typeof payload.source !== "string") return false;
  return payload.thread_source !== "subagent";
}

function isAutomatedMessage(message) {
  const text = String(message ?? "").trimStart();
  return /^<(heartbeat|automation)(\s|>)/i.test(text);
}

function messageText(row) {
  if (row.type === "event_msg" && row.payload?.type === "agent_message") {
    return String(row.payload.message ?? "");
  }
  if (row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "assistant") {
    return (row.payload.content ?? [])
      .filter((item) => item?.type === "output_text" || item?.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
  }
  return "";
}

function extractHandoff(text, fallbackDate) {
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

  const recognized = ["归属日", "活跃时段", "工作性质", "状态", "一句话"].filter((key) => fields[key]).length;
  if (recognized < 2) return null;

  return {
    date: fields["归属日"]?.match(VALID_DATE) ? fields["归属日"] : fallbackDate,
    activeWindows: fields["活跃时段"] ?? "未写",
    workType: fields["工作性质"] ?? "未写",
    status: fields["状态"] ?? "未写",
    note: fields["一句话"] ?? null,
  };
}

function relevantMonthDirs(sessionRoot, dates) {
  const months = new Set();
  for (const date of dates) {
    const current = new Date(`${date}T12:00:00+09:00`);
    for (const delta of [-31, 0, 31]) {
      const shifted = new Date(current.getTime() + delta * 24 * 60 * 60 * 1000);
      const { date: shiftedDate } = tokyoParts(shifted.toISOString());
      months.add(shiftedDate.slice(0, 7));
    }
  }
  return [...months]
    .map((month) => path.join(sessionRoot, month.slice(0, 4), month.slice(5, 7)))
    .filter((dir) => fs.existsSync(dir));
}

function listSessionFiles(monthDirs) {
  const files = [];
  for (const monthDir of monthDirs) {
    for (const day of fs.readdirSync(monthDir, { withFileTypes: true })) {
      if (!day.isDirectory()) continue;
      const dayDir = path.join(monthDir, day.name);
      for (const entry of fs.readdirSync(dayDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(dayDir, entry.name));
      }
    }
  }
  return files;
}

function buildWindows(events) {
  const sorted = [...new Set(events)].sort((a, b) => a - b);
  const windows = [];
  for (const timestamp of sorted) {
    const current = windows.at(-1);
    if (!current || timestamp - current.end > WINDOW_GAP_MS) {
      windows.push({ start: timestamp, end: timestamp });
    } else {
      current.end = timestamp;
    }
  }
  return windows.map(({ start, end }) => ({
    start: tokyoParts(start).time,
    end: tokyoParts(end).time,
  }));
}

function scan(dates) {
  const sessionRoot = path.join(os.homedir(), ".codex", "sessions");
  const targets = new Map(dates.map((date) => [date, { events: [], markers: [], roots: new Set() }]));
  const seenEvents = new Set();

  for (const file of listSessionFiles(relevantMonthDirs(sessionRoot, dates))) {
    const id = path.basename(file).match(UUID_AT_END)?.[1];
    if (!id) continue;

    let rows;
    try {
      rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      continue;
    }

    const meta = rows.find((row) => row.type === "session_meta" && row.payload?.id === id);
    if (!isRootUserTask(meta)) continue;

    for (const row of rows) {
      if (!row.timestamp) continue;
      const timestamp = Date.parse(row.timestamp);
      if (!Number.isFinite(timestamp)) continue;
      const local = tokyoParts(timestamp);

      if (row.type === "event_msg" && row.payload?.type === "user_message" && targets.has(local.date)) {
        const message = String(row.payload.message ?? "");
        if (isAutomatedMessage(message)) continue;
        const fingerprint = crypto.createHash("sha1").update(`${id}\n${row.timestamp}\n${message}`).digest("hex");
        if (seenEvents.has(fingerprint)) continue;
        seenEvents.add(fingerprint);
        targets.get(local.date).events.push(timestamp);
        targets.get(local.date).roots.add(id);
      }

      const handoff = extractHandoff(messageText(row), local.date);
      if (!handoff || !targets.has(handoff.date)) continue;
      const target = targets.get(handoff.date);
      const existingIndex = target.markers.findIndex((item) => item.threadId === id);
      const marker = { ...handoff, threadId: id, timestamp };
      if (existingIndex < 0) target.markers.push(marker);
      else if (timestamp > target.markers[existingIndex].timestamp) target.markers[existingIndex] = marker;
    }
  }

  return dates.map((date) => {
    const target = targets.get(date);
    return {
      schemaVersion: 1,
      source: "codex",
      date,
      activeWindows: buildWindows(target.events),
      rootTaskCount: target.roots.size,
      handoffs: target.markers
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(({ threadId: _threadId, timestamp: _timestamp, ...handoff }) => handoff),
      caveat: "时段仅按根任务中的本人开口合并；45 分钟无开口即拆段。它不是精确工时，也不把 Agent 独立运行算作本人连续工作。",
    };
  });
}

function printText(results) {
  for (const result of results) {
    console.log(`Codex 主任务工作量摘要 · ${result.date}`);
    if (result.activeWindows.length === 0) {
      console.log("- 本人活跃时段：未查到");
    } else {
      console.log(`- 本人活跃时段：${result.activeWindows.map((item) => item.start === item.end ? item.start : `${item.start}–${item.end}`).join("；")}`);
    }
    console.log(`- 涉及根任务：${result.rootTaskCount} 个（只作覆盖检查，不用于直接打分）`);
    if (result.handoffs.length === 0) {
      console.log("- 身心日评交接：未见；仍须按上述主任务时段判断，不能据此写成没干活");
    } else {
      for (const handoff of result.handoffs) {
        console.log(`- 身心日评交接：${handoff.activeWindows}｜${handoff.workType}｜${handoff.status}${handoff.note ? `｜${handoff.note}` : ""}`);
      }
    }
    console.log(`- 口径：${result.caveat}`);
  }
}

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const dates = [...new Set(args.filter((arg) => arg !== "--json"))];

if (dates.length === 0 || dates.some((date) => !VALID_DATE.test(date))) {
  console.error("用法：node codex-workload-summary.mjs [--json] YYYY-MM-DD [YYYY-MM-DD ...]");
  process.exit(2);
}

const results = scan(dates);
if (jsonMode) console.log(JSON.stringify(results, null, 2));
else printText(results);
