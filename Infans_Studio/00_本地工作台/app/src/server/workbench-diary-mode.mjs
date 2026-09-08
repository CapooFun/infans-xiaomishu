import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { ensureInside } from "./workbench-data.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { readAppleCalendar } from "./workbench-calendar.mjs";
import { readDevelopmentLog } from "./workbench-development-log.mjs";
import { readProjectManagement } from "./workbench-project-management.mjs";
import {
  CURRENT_WELLBEING_DAILY_PATH,
  DIALOGUE_DIARY_DIR,
  DIARY_MODE_PREFERENCES_PATH,
  DIARY_MODE_PROTOCOL_PATH,
  MOBILE_GPT_LIVE_MCP_RUNBOOK_PATH,
} from "./vault-paths.mjs";

export const DIARY_MODE_WINDOW_DAYS = 21;
export const DIARY_MODE_FUTURE_DAYS = 7;
export const DIARY_MODE_MAX_ITEMS = 16;
export const DIARY_MODE_MAX_CHARS = 10_000;
export const DIARY_MODE_MAX_PER_SOURCE = 5;
export const DIARY_MODE_KIND_LIMITS = Object.freeze({ diary: 5, task: 5, project: 4, calendar: 4, wellbeing: 2 });

const HANDOFF_START = "【INFANS 对话日志交接 v1】";
const LEGACY_HANDOFF_START = "【INFANS 对话日记交接 v1】";
const HANDOFF_STARTS = Object.freeze([HANDOFF_START, LEGACY_HANDOFF_START]);
const HANDOFF_END = "【记录结束】";
const HANDOFF_SECTIONS = Object.freeze([
  "用户明确说过的事实",
  "用户明确表达的感受",
  "进展与变化",
  "仍想继续聊",
  "不确定或 AI 推断",
  "长期聊天偏好候选",
]);
const SIGNAL_RE = /(?:还|继续|尚未|未完|待|下一步|阻塞|担心|期待|想|计划|等待)/u;
const STRONG_SIGNAL_RE = /(?:待办|待问|待回答|下一步|阻塞|未完成|仍待)/u;
const EMPTY_PREFERENCE_RE = /^(?:无|尚无|尚未确认)[。.]?$/u;
const DIALOGUE_FILE_RE = /^(20\d{2}-\d{2}-\d{2})_(dialogue-\d{8}-[a-z0-9][a-z0-9-]{2,31})\.md$/u;

function compact(value, limit = 240) {
  const text = String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/\*\*|__|~~|`/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function readOptional(root, relativePath) {
  try { return await fs.readFile(ensureInside(root, relativePath), "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
}

function sectionBullets(markdown, heading) {
  const body = matter(String(markdown || "")).content;
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return [];
  const result = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index])) break;
    const bullet = lines[index].match(/^\s*-\s+(.+?)\s*$/u);
    if (bullet) {
      const value = compact(bullet[1]);
      if (value && !EMPTY_PREFERENCE_RE.test(value)) result.push(value);
    }
  }
  return result;
}

export function parseDiaryModePreferences(markdown = "") {
  return {
    careAbout: sectionBullets(markdown, "希望主动关心"),
    avoid: sectionBullets(markdown, "不想反复被问"),
    style: sectionBullets(markdown, "适合的聊天方式"),
    sourcePath: DIARY_MODE_PREFERENCES_PATH,
  };
}

function tokyoDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(date);
}

function tokyoCalendarParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function diaryModeReportWindow(date = new Date()) {
  const parts = tokyoCalendarParts(date);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekly = parts.weekday === "Sat" || parts.weekday === "Sun";
  const monthly = lastDay - day <= 4;
  const labels = [weekly ? "周报前" : "", monthly ? "月报前" : ""].filter(Boolean);
  return {
    weekly,
    monthly,
    active: weekly || monthly,
    label: labels.join("／"),
  };
}

function startOfTokyoDay(date) {
  const key = tokyoDateKey(date);
  return new Date(`${key}T00:00:00+09:00`);
}

function ageInDays(day, now) {
  const target = new Date(`${day}T00:00:00+09:00`);
  return Math.max(0, Math.floor((startOfTokyoDay(now) - target) / 86_400_000));
}

function recencyScore(age) {
  if (age <= 2) return 3;
  if (age <= 7) return 2;
  return 1;
}

function candidate({ kind, title, detail, sourcePath, score, reasons, date = null, caution = null }) {
  return { kind, title: compact(title, 100), detail: compact(detail), sourcePath, score, reasons, date, caution };
}

function diaryCandidates(snapshot, now) {
  const result = [];
  for (const day of snapshot?.days || []) {
    const age = ageInDays(day.date, now);
    if (age > DIARY_MODE_WINDOW_DAYS) continue;
    const lines = String(day.markdown || "").split(/\r?\n/u)
      .map((line) => compact(line.replace(/^\s*(?:[-*+]\s+|#{1,6}\s+)/u, "")))
      .filter((line) => line && line.length >= 8 && !/^\d{4}-\d{2}-\d{2}$/u.test(line));
    const interesting = lines.filter((line) => SIGNAL_RE.test(line)).slice(0, DIARY_MODE_MAX_PER_SOURCE);
    const fallback = interesting.length ? interesting : [day.description, ...day.headings].map(compact).filter(Boolean).slice(0, 1);
    for (const line of fallback) {
      const reasons = [`${age === 0 ? "今天" : `${age} 天前`}的正式日记`];
      let score = recencyScore(age);
      if (STRONG_SIGNAL_RE.test(line)) { score += 5; reasons.push("含待更新、下一步或阻塞信号"); }
      else if (SIGNAL_RE.test(line)) { score += 3; reasons.push("含持续性信号"); }
      result.push(candidate({ kind: "diary", title: day.description || `${day.date} 日记线索`, detail: line, sourcePath: day.sourcePath, score, reasons, date: day.date, caution: "旧记录只是线索，先确认后续变化。" }));
    }
  }
  return result;
}

function projectCandidates(snapshot) {
  const result = [];
  for (const task of snapshot?.currentTodos || []) {
    if (task.done) continue;
    const priority = task.priority === "S" || task.priority === "A" ? 4 : 0;
    result.push(candidate({
      kind: "task",
      title: task.projectName || "近期事项",
      detail: task.displayText || task.text,
      sourcePath: task.sourcePath,
      score: 5 + priority,
      reasons: ["当前未完成事项", ...(priority ? [`${task.priority} 级优先级`] : [])],
      date: task.date?.start || null,
    }));
  }
  for (const project of snapshot?.projects || []) {
    if (project.archived || !project.management) continue;
    const management = project.management;
    const openTasks = [...(management.doing || []), ...(management.next || []), ...(management.blocked || [])].filter((task) => !task.done);
    const taskIds = new Set(openTasks.map((task) => String(task.id).toLowerCase()));
    const taskWorklineIds = new Set(openTasks.flatMap((task) => task.worklineIds || []));
    const taskFeatureIds = new Set(openTasks.flatMap((task) => task.featureIds || []));
    const relatedToOpenTask = (item) => {
      if (!item || typeof item === "string") return false;
      if (item.id && taskIds.has(String(item.id).toLowerCase())) return true;
      if ((item.taskIds || []).some((id) => taskIds.has(String(id).toLowerCase()))) return true;
      return (item.worklineIds || []).some((id) => taskWorklineIds.has(id))
        || (item.moduleIds || []).some((id) => taskFeatureIds.has(id))
        || (item.featureIds || []).some((id) => taskFeatureIds.has(id));
    };
    for (const blocker of management.blockers || []) {
      const detail = typeof blocker === "string" ? blocker : blocker?.text;
      if (!detail || /^(?:(?:当前)?已确认)?阻塞[：:]?\s*无[。.！!]*$/u.test(detail) || /^无[。.！!]*$/u.test(detail)) continue;
      if (!relatedToOpenTask(blocker)) continue;
      result.push(candidate({ kind: "project", title: `${project.name}·阻塞`, detail, sourcePath: project.managementPath, score: 8, reasons: ["项目权威原件的当前阻塞", "与当前未完成任务存在显式 ID 关系"] }));
    }
    for (const recent of management.recentCompleted || []) {
      const detail = typeof recent === "string" ? recent : recent?.text;
      if (!detail || !relatedToOpenTask(recent)) continue;
      result.push(candidate({ kind: "project", title: `${project.name}·最近完成`, detail, sourcePath: project.managementPath, score: 4, reasons: ["项目权威原件的完成事实", "与当前未完成任务存在显式 ID 关系"] }));
    }
    if (management.currentStatus) result.push(candidate({ kind: "project", title: project.name, detail: management.currentStatus, sourcePath: project.managementPath, score: 3, reasons: ["项目权威原件的当前状态"] }));
  }
  return result;
}

function calendarCandidates(snapshot, now) {
  const today = startOfTokyoDay(now);
  const afterWindow = new Date(today);
  afterWindow.setUTCDate(afterWindow.getUTCDate() + DIARY_MODE_FUTURE_DAYS + 1);
  return (snapshot?.events || []).flatMap((event) => {
    const startsAt = new Date(event.start);
    if (Number.isNaN(startsAt.getTime()) || startsAt < today || startsAt >= afterWindow) return [];
    const daysAway = Math.floor((startsAt - today) / 86_400_000);
    return candidate({
      kind: "calendar",
      title: event.title,
      detail: `${event.allDay ? "全天" : startsAt.toLocaleString("zh-CN", { timeZone: "Asia/Tokyo", hour12: false })}${event.calendar ? `·${event.calendar}` : ""}`,
      sourcePath: "Apple Calendar",
      score: 4 + (daysAway <= 2 ? 2 : 0),
      reasons: [`${daysAway === 0 ? "今天" : `${daysAway} 天后`}的已登记安排`],
      date: tokyoDateKey(startsAt),
    });
  });
}

function healthCandidates(markdown) {
  if (!markdown) return [];
  const lines = String(markdown).split(/\r?\n/u);
  const picked = [];
  for (const label of ["一句话", "可执行提醒"]) {
    const match = lines.find((line) => line.startsWith(`- ${label}：`));
    if (match) picked.push(compact(match.replace(/^\s*-\s*/u, "")));
  }
  picked.push(...sectionBullets(markdown, "待问你（可空）"));
  return picked.slice(0, 3).map((detail) => candidate({
    kind: "wellbeing",
    title: "已有身心日评线索",
    detail,
    sourcePath: CURRENT_WELLBEING_DAILY_PATH,
    score: STRONG_SIGNAL_RE.test(detail) ? 7 : 4,
    reasons: ["已有记录中的当前问候线索"],
    caution: "仅用于问候，不作诊断；缺数据为未知。",
  }));
}

function meaningfulTokens(text) {
  const stop = new Set(["当前", "已经", "已确认", "今天", "明天", "进行", "完成", "可以", "需要", "这个", "一个", "对话", "日记", "今日日志", "项目", "阻塞"]);
  return new Set((String(text).match(/[\p{Script=Han}]{2,8}|[A-Za-z][A-Za-z0-9_-]{2,}/gu) || []).filter((token) => !stop.has(token)));
}

function applyRepeatedThemeBonus(items) {
  const byToken = new Map();
  items.forEach((item, index) => {
    for (const token of meaningfulTokens(`${item.title} ${item.detail}`)) {
      const value = byToken.get(token) || { sources: new Set(), indexes: new Set() };
      value.sources.add(item.sourcePath);
      value.indexes.add(index);
      byToken.set(token, value);
    }
  });
  const boosted = new Set();
  for (const [token, value] of byToken) {
    if (value.sources.size < 2) continue;
    for (const index of value.indexes) {
      if (boosted.has(index)) continue;
      items[index].score += 2;
      items[index].reasons.push(`“${token}”在多个来源重复出现`);
      boosted.add(index);
    }
  }
}

function preferenceMatch(detail, entries) {
  return entries.find((entry) => entry.length >= 2 && (detail.includes(entry) || entry.includes(detail.slice(0, Math.min(12, detail.length)))));
}

export function selectDiaryModeContext(rawItems, preferences, options = {}) {
  const maxItems = options.maxItems || DIARY_MODE_MAX_ITEMS;
  const maxChars = options.maxChars || DIARY_MODE_MAX_CHARS;
  const items = rawItems.map((item) => ({ ...item, reasons: [...item.reasons] }));
  applyRepeatedThemeBonus(items);
  for (const item of items) {
    const avoid = preferenceMatch(item.detail, preferences.avoid || []);
    const care = preferenceMatch(item.detail, preferences.careAbout || []);
    if (avoid) { item.score -= 8; item.reasons.push(`命中不想反复被问：${avoid}`); }
    if (care) { item.score += 3; item.reasons.push(`命中希望主动关心：${care}`); }
  }
  items.sort((left, right) => right.score - left.score || String(right.date || "").localeCompare(String(left.date || "")) || left.title.localeCompare(right.title));
  const selected = [];
  const sourceCounts = new Map();
  const kindCounts = new Map();
  let characters = 0;
  for (const item of items) {
    if (item.score <= 0) continue;
    const count = sourceCounts.get(item.sourcePath) || 0;
    const kindCount = kindCounts.get(item.kind) || 0;
    const kindLimit = DIARY_MODE_KIND_LIMITS[item.kind] || maxItems;
    const size = item.title.length + item.detail.length + item.reasons.join("").length;
    if (count >= DIARY_MODE_MAX_PER_SOURCE || kindCount >= kindLimit || selected.length >= maxItems || characters + size > maxChars) continue;
    selected.push(item);
    sourceCounts.set(item.sourcePath, count + 1);
    kindCounts.set(item.kind, kindCount + 1);
    characters += size;
  }
  return { items: selected, characters };
}

export function diaryModeMcpPrompt(reportWindow = diaryModeReportWindow()) {
  const reportInstruction = reportWindow.active
    ? `现在处于${reportWindow.label}的自然补访窗口。请先核对已归档对话日志和身心记录；只有发现会影响报告、且我还没有自然表达过的真实缺口时，才借当下话题自然带出。没有缺口就正常聊，不为了补齐报告而提问。`
    : "当前不是周报或月报前的补访窗口；不为了报告额外盘问，只按近期真正相关的话题自然聊。";
  return `请使用 Infans 只读资料库，先完整读取“${DIARY_MODE_PROTOCOL_PATH}”和“${DIARY_MODE_PREFERENCES_PATH}”。严格按协议的近期相关性、时间窗、条数与字符上限，再只读搜索必要的正式日志、当前项目与待办、临近安排、已有身心记录和已归档对话日志。${reportInstruction}相信 GPT Live 当下的对话判断：不固定题数、不用量表腔或标准情绪词套话，不重复问已经说过的事；我跳过、换话题或不想说时就尊重，不从沉默、打字速度或单个表情编造感受。读不到时明确说哪一步失败，不凭记忆补。准备完成后，请先用一句自然的话告诉我你想从哪件事开始；我会在同一聊天打开 GPT Live 继续。聊完后必须按协议输出完整的“INFANS 对话日志交接 v1”，并明确尚未写入 Vault。`;
}

function buildFallbackGuide(selection, preferences, reportWindow) {
  const lines = [
    "【INFANS 日记模式聊天引导包 v1】",
    "用途：仅在 Infans 只读工具实际调用失败时回退；不是正式日记。",
    "规则：旧记录只是线索，先确认后续；每次只聊一个方向；用户跳过就换题；不做心理或医学诊断；事实与推断分开。",
    "",
    "## 长期偏好",
    `- 希望主动关心：${preferences.careAbout.join("；") || "尚未确认"}`,
    `- 不想反复被问：${preferences.avoid.join("；") || "尚未确认"}`,
    `- 适合的聊天方式：${preferences.style.join("；") || "尚未确认"}`,
    ...(reportWindow.active ? [
      "",
      `## ${reportWindow.label}自然补访`,
      "- 先看已归档对话和身心记录；只补会影响报告、且用户还没有自然表达过的缺口。",
      "- 没有缺口就不问。不固定题数，不用量表腔；用户跳过、换话题或不想说时就尊重。",
    ] : []),
    "",
    "## 近期相关线索",
    ...selection.items.map((item, index) => `${index + 1}. [${item.kind}·${item.score} 分] ${item.title}：${item.detail}\n   来源：${item.sourcePath}\n   理由：${item.reasons.join("；")}${item.caution ? `\n   边界：${item.caution}` : ""}`),
    "",
    `结束时完整输出 ${HANDOFF_START} 至 ${HANDOFF_END}，并标明尚未写入 Vault。`,
  ];
  return lines.join("\n");
}

export async function readDialogueLogs(root) {
  const directory = ensureInside(root, DIALOGUE_DIARY_DIR);
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const fileNames = entries.filter((entry) => entry.isFile() && DIALOGUE_FILE_RE.test(entry.name)).map((entry) => entry.name).sort((a, b) => b.localeCompare(a));
  return Promise.all(fileNames.map(async (fileName) => {
    const sourcePath = path.posix.join(DIALOGUE_DIARY_DIR, fileName);
    const parsed = matter(await fs.readFile(ensureInside(root, sourcePath), "utf8"));
    const match = fileName.match(DIALOGUE_FILE_RE);
    return {
      date: match[1],
      recordId: match[2],
      title: compact(parsed.data?.title || match[2], 120),
      description: compact(parsed.data?.description || "对话日志"),
      markdown: parsed.content.trim(),
      sourcePath,
    };
  }));
}

export async function readDiaryMode(root, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const from = startOfTokyoDay(now);
  const to = new Date(from); to.setUTCDate(to.getUTCDate() + DIARY_MODE_FUTURE_DAYS + 1);
  const readLogs = options.readLogs || readDevelopmentLog;
  const readProjects = options.readProjects || readProjectManagement;
  const readCalendar = options.readCalendar || readAppleCalendar;
  const [preferenceMarkdown, healthMarkdown, logs, projects, calendar, dialogueLogs] = await Promise.all([
    readOptional(root, DIARY_MODE_PREFERENCES_PATH),
    readOptional(root, CURRENT_WELLBEING_DAILY_PATH),
    readLogs(root).catch(() => ({ days: [] })),
    readProjects(root, { now }).catch(() => ({ projects: [], currentTodos: [], warnings: [] })),
    readCalendar(from, to).catch(() => ({ available: false, events: [], message: "暂时读不到苹果日历" })),
    readDialogueLogs(root),
  ]);
  const preferences = parseDiaryModePreferences(preferenceMarkdown);
  const reportWindow = diaryModeReportWindow(now);
  const rawItems = [
    ...diaryCandidates(logs, now),
    ...projectCandidates(projects),
    ...calendarCandidates(calendar, now),
    ...healthCandidates(healthMarkdown),
  ];
  const selection = selectDiaryModeContext(rawItems, preferences, options);
  return {
    generatedAt: now.toISOString(),
    config: { windowDays: DIARY_MODE_WINDOW_DAYS, futureDays: DIARY_MODE_FUTURE_DAYS, maxItems: options.maxItems || DIARY_MODE_MAX_ITEMS, maxChars: options.maxChars || DIARY_MODE_MAX_CHARS, maxPerSource: DIARY_MODE_MAX_PER_SOURCE, kindLimits: DIARY_MODE_KIND_LIMITS },
    primaryPath: { verified: true, verifiedAt: "2026-08-28", label: "手机 GPT Live + Infans 只读 MCP", runbookPath: MOBILE_GPT_LIVE_MCP_RUNBOOK_PATH, protocolPath: DIARY_MODE_PROTOCOL_PATH },
    mcpPrompt: diaryModeMcpPrompt(reportWindow),
    fallbackGuide: buildFallbackGuide(selection, preferences, reportWindow),
    preferences,
    context: selection.items,
    contextCharacters: selection.characters,
    sourceWarnings: [...(projects.warnings || []).slice(0, 5), ...(calendar.available === false ? [{ code: "CALENDAR_UNAVAILABLE", message: calendar.message || "暂时读不到苹果日历" }] : [])],
    dialogueLogs,
  };
}

function metadataValue(block, label) {
  const match = block.match(new RegExp(`^${label}：\\s*(.+?)\\s*$`, "mu"));
  return match ? match[1].trim() : "";
}

function sectionValue(block, heading) {
  const marker = `## ${heading}`;
  const start = block.indexOf(marker);
  if (start < 0) return "";
  const after = block.slice(start + marker.length).replace(/^\s*\n/u, "");
  const next = after.search(/^##\s+/mu);
  const tail = after.search(/^\s*(?:需要回看原对话|尚未写入 Vault)：/mu);
  const ends = [next, tail].filter((value) => value >= 0);
  const value = (ends.length ? after.slice(0, Math.min(...ends)) : after).trim();
  return value.length > 4_000 ? `${value.slice(0, 3_999)}…` : value;
}

export function parseDialogueLogHandoff(input) {
  const raw = String(input || "").trim();
  const starts = HANDOFF_STARTS
    .map((marker) => ({ marker, index: raw.indexOf(marker) }))
    .filter(({ index }) => index >= 0)
    .sort((a, b) => a.index - b.index);
  const activeStart = starts[0];
  const start = activeStart?.index ?? -1;
  const end = raw.indexOf(HANDOFF_END, start + (activeStart?.marker.length || 0));
  if (start < 0 || end < 0 || end < start) throw new WorkbenchWriteError("请粘贴完整的 INFANS 对话日志交接 v1", 400, "DIALOGUE_HANDOFF_INCOMPLETE");
  if (HANDOFF_STARTS.some((marker) => raw.indexOf(marker, start + 1) >= 0)) throw new WorkbenchWriteError("一次只能导入一份对话日志交接", 400, "DIALOGUE_HANDOFF_MULTIPLE");
  const block = raw.slice(start, end + HANDOFF_END.length);
  const recordId = metadataValue(block, "记录ID");
  const occurredAt = metadataValue(block, "发生时间");
  const title = compact(metadataValue(block, "会话标题"), 120);
  const summary = compact(metadataValue(block, "一句话"), 240);
  if (!/^dialogue-20\d{6}-[a-z0-9][a-z0-9-]{2,31}$/u.test(recordId)) throw new WorkbenchWriteError("记录 ID 格式不对，应如 dialogue-20260828-abcd", 400, "DIALOGUE_ID_INVALID");
  const occurred = new Date(occurredAt);
  if (!occurredAt || Number.isNaN(occurred.getTime())) throw new WorkbenchWriteError("发生时间不可解析", 400, "DIALOGUE_TIME_INVALID");
  if (!title || !summary) throw new WorkbenchWriteError("会话标题和一句话不能为空", 400, "DIALOGUE_META_REQUIRED");
  const sections = Object.fromEntries(HANDOFF_SECTIONS.map((heading) => [heading, sectionValue(block, heading)]));
  const missing = HANDOFF_SECTIONS.filter((heading) => !sections[heading]);
  if (missing.length) throw new WorkbenchWriteError(`交接缺少分组：${missing.join("、")}`, 400, "DIALOGUE_SECTION_MISSING");
  if (!/^需要回看原对话：\s*(?:是|否)\s*$/mu.test(block)) throw new WorkbenchWriteError("请标明是否需要回看原对话", 400, "DIALOGUE_REVIEW_FLAG_REQUIRED");
  if (!/^尚未写入 Vault：\s*是\s*$/mu.test(block)) throw new WorkbenchWriteError("交接必须明确尚未写入 Vault", 400, "DIALOGUE_WRITE_BOUNDARY_REQUIRED");
  const date = tokyoDateKey(occurred);
  return { recordId, occurredAt: occurred.toISOString(), date, title, summary, sections, needsReview: /^需要回看原对话：\s*是\s*$/mu.test(block) };
}

function yamlText(value) {
  return JSON.stringify(String(value));
}

export function renderDialogueLog(parsed) {
  const frontmatter = [
    "---",
    `description: ${yamlText(parsed.summary)}`,
    `date: ${parsed.date}`,
    "tags: [本地工作台, 对话日志, AI整理]",
    "sensitivity: S1",
    `record_id: ${yamlText(parsed.recordId)}`,
    `occurred_at: ${yamlText(parsed.occurredAt)}`,
    `title: ${yamlText(parsed.title)}`,
    "authorship: 用户口述与AI整理",
    "authority: non-authoritative",
    "---",
  ].join("\n");
  return `${frontmatter}\n\n# ${parsed.title}\n\n> 本记录基于用户口述与 AI 整理；非用户亲笔；非正式日记、健康结论或项目权威原件。\n\n- 记录 ID：\`${parsed.recordId}\`\n- 发生时间：${parsed.occurredAt}\n- 需要回看原对话：${parsed.needsReview ? "是" : "否"}\n\n## 一句话\n\n${parsed.summary}\n\n${HANDOFF_SECTIONS.map((heading) => `## ${heading}\n\n${parsed.sections[heading]}`).join("\n\n")}\n`;
}

export async function previewDialogueLogImport(root, handoff, writes) {
  const parsed = parseDialogueLogHandoff(handoff);
  const targetPath = path.posix.join(DIALOGUE_DIARY_DIR, `${parsed.date}_${parsed.recordId}.md`);
  try {
    await fs.access(ensureInside(root, targetPath));
    throw new WorkbenchWriteError(`记录 ID“${parsed.recordId}”已存在，不会覆盖`, 409, "DIALOGUE_ID_CONFLICT");
  } catch (error) {
    if (error instanceof WorkbenchWriteError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const preview = await writes.preview({ kind: "editFile", path: targetPath, content: renderDialogueLog(parsed) });
  return { ...preview, kind: "dialogueLog", targetLabel: "对话日志（非权威）", parsed };
}
