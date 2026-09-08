import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CAREER_OVERVIEW, DIR_CAREER, TODO_PATH } from "./vault-paths.mjs";
import { parseAgentTaskContract } from "./workbench-agent-task-contract.mjs";
import { PRODUCT_FEATURE_TREE_LABEL, readProductFeatureTree } from "./workbench-product-features.mjs";
import { readExternalProjectHub } from "./workbench-project-hubs.mjs";

export const PROJECT_MANAGEMENT_FILE = "项目进度与待办.md";
export const TASK_PRIORITIES = Object.freeze(["S", "A", "B", "C"]);
const RECENT_COMPLETION_TTL_MS = 24 * 60 * 60 * 1000;
const PROJECT_DASHBOARD_SUMMARY_MAX_CHARS = 96;

const REQUIRED_SECTIONS = Object.freeze(["当前状态", "正在做", "下一步", "阻塞", "最近完成", "权威入口"]);
const FOCUS_BATTLE_STATUS = Object.freeze({
  已启用: "enabled",
  已暂停: "paused",
  已完成: "completed",
  已取消: "cancelled",
});
const FOCUS_BATTLE_GATE_STATUS = Object.freeze({
  待验收: "pending",
  已通过: "passed",
  受阻: "blocked",
});
const FOCUS_BATTLE_REVIEW_STATUS = Object.freeze({
  待复盘: "pending",
  复盘中: "in-review",
  已复盘: "completed",
});
const CENTRAL_CURRENT_HEADINGS = Object.freeze(["最近两天", "今天 / 本周", "当前任务"]);
const TASK_LINE_RE = /^(\s*-\s+\[)([ xX])(\]\s+)(.+?)\s*$/u;
const META_RE = /[｜|]\s*(ID|父级|关联任务|依赖|功能|工作线|执行器|完成时间|复验时间)\s*[：:]\s*([^｜|]+)/gu;
const DISPLAY_META_RE = /[｜|]\s*(?:ID|父级|关联任务|依赖|功能|模块|工作线|执行器|计划|日期|状态|进展时间|完成时间|复验时间)\s*[：:]\s*([^｜|]+)/gu;
const NON_SCHEDULE_META_RE = /[｜|]\s*(?:ID|父级|关联任务|依赖|功能|模块|工作线|执行器|状态|进展时间|完成时间|复验时间)\s*[：:]\s*([^｜|]+)/gu;
const PRIORITY_NAMED_RE = /象限\s*[：:]\s*(重要且紧急|重要不紧急|紧急不重要|不重要且不紧急|[SABC])\s*[：:]?/iu;
const PRIORITY_TOKEN_RE = /(^|[：:]\s*)([SABC])\s*[：:]/iu;
const PRIORITY_NAMES = Object.freeze({
  重要且紧急: "S",
  重要不紧急: "A",
  紧急不重要: "B",
  不重要且不紧急: "C",
});

function cleanInline(value = "") {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, (_match, target) => String(target).split("/").at(-1) ?? target)
    .replace(/<[^>]+>/gu, "")
    .replace(/\*\*|__|~~|`/gu, "")
    .replace(/\\\|/gu, "|")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 14)}`;
}

function warning(code, message, extra = {}) {
  return { code, message, ...extra };
}

export function sectionMap(markdown = "") {
  // 保留原文行号：写回定位和报错都需要与磁盘文件对齐。
  const lines = String(markdown).split(/\r?\n/u);
  const sections = new Map();
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^##\s+(.+?)\s*$/u);
    if (heading) {
      current = cleanInline(heading[1]);
      if (!sections.has(current)) sections.set(current, { heading: current, startLine: index + 1, lines: [] });
      continue;
    }
    if (/^#\s+/u.test(lines[index])) current = null;
    if (current) sections.get(current).lines.push({ line: lines[index], lineNumber: index + 1 });
  }
  return sections;
}

function splitMarkdownRow(line) {
  const placeholder = "\u0000PIPE\u0000";
  const protectedLine = String(line)
    .replace(/\\\|/gu, placeholder)
    .replace(/\[\[[^\]]+\]\]/gu, (link) => link.replaceAll("|", placeholder));
  return protectedLine.trim().slice(1, -1).split("|").map((cell) => cell.trim().replaceAll(placeholder, "|"));
}

function tableRows(section) {
  const rows = (section?.lines ?? [])
    .map(({ line }) => line)
    .filter((line) => line.trim().startsWith("|") && line.trim().endsWith("|"))
    .map(splitMarkdownRow);
  return rows.filter((row, index) => index !== 0 && !row.every((cell) => /^:?-{3,}:?$/u.test(cleanInline(cell))));
}

function wikiLink(value = "") {
  const raw = String(value);
  const match = raw.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/u);
  if (!match) return null;
  return { target: match[1].trim(), label: cleanInline(match[2] || match[1]) };
}

function projectExperience(value = "", warnings = [], context = {}) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:—|－|-)$/u.test(raw)) return null;

  const markdownLink = raw.match(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/u);
  const plainUrl = raw.match(/https:\/\/[^\s)]+/u);
  const url = markdownLink?.[2] || plainUrl?.[0] || null;
  if (url) {
    const prefix = cleanInline(raw.split(/[：:]/u)[0]);
    return {
      kind: "external",
      label: prefix || cleanInline(markdownLink?.[1]) || "打开体验",
      url,
      launcherId: null,
    };
  }

  const launcher = raw.match(/本地启动\s*[：:]\s*`?([a-z0-9][a-z0-9-]*)`?/iu);
  if (launcher) {
    return {
      kind: "launcher",
      label: "启动本地试玩",
      url: null,
      launcherId: launcher[1].toLowerCase(),
    };
  }

  warnings.push(warning("PROJECT_EXPERIENCE_INVALID", `项目“${context.name || "未命名项目"}”的体验入口格式不对。`, {
    sourcePath: CAREER_OVERVIEW,
    projectId: context.projectId || undefined,
  }));
  return null;
}

function normalizeManagementPath(target = "") {
  let normalized = String(target).replace(/\\/gu, "/").replace(/^\/+|\.md$/gu, "").trim();
  if (!normalized) return null;
  if (!normalized.includes("/")) return null;
  if (!normalized.startsWith(`${DIR_CAREER}/`)) normalized = path.posix.join(DIR_CAREER, normalized);
  normalized = path.posix.normalize(`${normalized}.md`);
  if (!normalized.startsWith(`${DIR_CAREER}/`) || path.posix.basename(normalized) !== PROJECT_MANAGEMENT_FILE) return null;
  return normalized;
}

export function parseProjectRegistry(markdown = "") {
  const sections = sectionMap(markdown);
  const warnings = [];
  const projects = [];
  for (const [heading, archived] of [["当前重点", false], ["归档", true]]) {
    const section = sections.get(heading);
    if (!section) {
      warnings.push(warning("REGISTRY_SECTION_MISSING", `事业注册表没有“${heading}”区块。`, { sourcePath: CAREER_OVERVIEW }));
      continue;
    }
    for (const row of tableRows(section)) {
      const name = cleanInline(row[0] ?? "");
      if (!name) continue;
      const status = cleanInline(row[1] ?? "");
      const entry = wikiLink(row[2]);
      const projectId = cleanInline(row[3] ?? "") || null;
      const managementLink = wikiLink(row[4]);
      const managementPath = normalizeManagementPath(managementLink?.target);
      if (projectId && !/^[a-z0-9][a-z0-9-]*$/u.test(projectId)) {
        warnings.push(warning("PROJECT_ID_INVALID", `项目“${name}”的项目 ID 格式不对。`, { sourcePath: CAREER_OVERVIEW, projectId }));
      }
      if (!archived && ((projectId && !managementLink) || (managementLink && !managementPath))) {
        warnings.push(warning("MANAGEMENT_LINK_INVALID", `项目“${name}”的“进度与待办”必须是事业目录内项目管理文件的完整双链。`, { sourcePath: CAREER_OVERVIEW, projectId }));
      }
      projects.push({
        projectId,
        name,
        status,
        cardSummary: cleanInline(row[6] ?? ""),
        entryPath: entry?.target ? (entry.target.endsWith(".md") ? entry.target : `${entry.target}.md`) : null,
        archived,
        migrated: Boolean(projectId && managementPath),
        managementPath,
        managementLabel: managementLink?.label || `${name} · 项目进度与待办`,
        experience: projectExperience(row[5], warnings, { name, projectId }),
      });
    }
  }
  const seen = new Map();
  for (const project of projects) {
    if (!project.projectId) continue;
    const previous = seen.get(project.projectId);
    if (previous) warnings.push(warning("DUPLICATE_PROJECT_ID", `项目 ID“${project.projectId}”同时用在“${previous}”和“${project.name}”。`, { sourcePath: CAREER_OVERVIEW, projectId: project.projectId }));
    else seen.set(project.projectId, project.name);
  }
  return { projects, warnings };
}

export function parseTaskPriority(text = "") {
  const named = String(text).match(PRIORITY_NAMED_RE);
  if (named) return PRIORITY_NAMES[named[1]] || named[1].toUpperCase();
  const token = String(text).match(PRIORITY_TOKEN_RE);
  return token ? token[2].toUpperCase() : null;
}

function parseTaskMeta(text = "") {
  let id = null;
  let parentId = null;
  let executorId = null;
  const featureIds = [];
  const worklineIds = [];
  const dependencyIds = [];
  const relatedTaskIds = [];
  let completedAt = null;
  let reviewAt = null;
  for (const match of String(text).matchAll(new RegExp(META_RE.source, "gu"))) {
    const value = cleanInline(match[2]);
    if (!value) continue;
    if (match[1] === "ID") id = value;
    else if (match[1] === "父级") parentId = value;
    else if (match[1] === "执行器") executorId = value;
    else if (match[1] === "功能") {
      for (const item of value.split(/[,\uff0c\s]+/u).filter(Boolean)) if (!featureIds.includes(item)) featureIds.push(item);
    }
    else if (match[1] === "工作线") {
      for (const item of value.split(/[,\uff0c\s]+/u).filter(Boolean)) if (!worklineIds.includes(item)) worklineIds.push(item);
    }
    else if (match[1] === "关联任务") {
      for (const item of value.split(/[,\uff0c、\s]+/u).filter(Boolean)) if (!relatedTaskIds.includes(item)) relatedTaskIds.push(item);
    }
    else if (match[1] === "完成时间" && !Number.isNaN(Date.parse(value))) completedAt = new Date(value).toISOString();
    else if (match[1] === "复验时间") {
      const normalized = value.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})$/u, "$1T$2:00+09:00");
      if (!Number.isNaN(Date.parse(normalized))) reviewAt = new Date(normalized).toISOString();
    }
    else if (match[1] === "依赖") for (const item of value.split(/[,\uff0c\s]+/u).filter(Boolean)) if (!dependencyIds.includes(item)) dependencyIds.push(item);
  }
  return { id, parentId, executorId, featureId: featureIds[0] || null, featureIds, worklineId: worklineIds[0] || null, worklineIds, relatedTaskIds, dependencyIds, completedAt, reviewAt };
}

function parseTokyoProgressTime(value = "") {
  const raw = String(value).trim();
  const local = raw.match(/^(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
  const normalized = local
    ? `${local[1]}T${String(Number(local[2])).padStart(2, "0")}:${local[3]}:${local[4] || "00"}+09:00`
    : raw;
  if (Number.isNaN(Date.parse(normalized))) return null;
  return new Date(normalized).toISOString();
}

function parseAiProgress(details = []) {
  let updatedAt = null;
  let currentState = null;
  let nextAction = null;
  for (const detail of details) {
    const field = String(detail).match(/^(进展时间|当前状态|下一步)\s*[：:]\s*(.+)$/u);
    if (!field) continue;
    if (field[1] === "进展时间") updatedAt = parseTokyoProgressTime(field[2]) || updatedAt;
    else if (field[1] === "当前状态") currentState = cleanInline(field[2]);
    else if (field[1] === "下一步") nextAction = cleanInline(field[2]);
  }
  return { updatedAt, currentState, nextAction };
}

function pad(value) { return String(value).padStart(2, "0"); }

function normalizedDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function addDateKeyDays(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 今日事项与首页一致：提醒所有已到期任务，以及东京明天前将到期的任务。 */
export function isTaskInNearTerm(task, todayKey) {
  if (!task?.date) return false;
  const endKey = addDateKeyDays(todayKey, 1);
  return task.date.start <= endKey;
}

function parseDatePart(raw, defaultYear) {
  const match = String(raw).trim().match(/^(?:(20\d{2})\s*[\/\u5e74.-]\s*)?(\d{1,2})\s*[\/\u6708.-]\s*(\d{1,2})\s*日?$/u);
  if (!match) return null;
  const year = Number(match[1] || defaultYear);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const key = normalizedDate(year, month, day);
  return key ? { year, month, day, key, explicitYear: Boolean(match[1]) } : null;
}

export function parseTaskDate(text = "", todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date())) {
  const scheduleText = String(text).replace(new RegExp(NON_SCHEDULE_META_RE.source, "gu"), " ");
  const defaultYear = Number(String(todayKey).slice(0, 4));
  const range = scheduleText.match(/((?:20\d{2}\s*[\/\u5e74.-]\s*)?\d{1,2}\s*[\/\u6708.-]\s*\d{1,2}\s*日?)\s*[–—~-]\s*((?:20\d{2}\s*[\/\u5e74.-]\s*)?\d{1,2}\s*[\/\u6708.-]\s*\d{1,2}\s*日?)/u);
  if (range) {
    const start = parseDatePart(range[1], defaultYear);
    let end = parseDatePart(range[2], start?.year || defaultYear);
    if (!start || !end) return null;
    if (!end.explicitYear && end.key < start.key) end = parseDatePart(range[2], start.year + 1);
    if (!end) return null;
    return { start: start.key, end: end.key, label: range[0].trim() };
  }
  const single = scheduleText.match(/((?:20\d{2}\s*[\/\u5e74.-]\s*)?\d{1,2}\s*[\/\u6708.-]\s*\d{1,2}\s*日?)\s*(起|·|$)/u);
  if (single) {
    const date = parseDatePart(single[1], defaultYear);
    if (date) return {
      start: date.key,
      end: single[2] === "起" ? "9999-12-31" : date.key,
      label: `${single[1].trim()}${single[2] === "起" ? " 起" : ""}`,
    };
  }
  const monthEnd = scheduleText.match(/(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月末/u);
  if (monthEnd) {
    const year = Number(monthEnd[1] || defaultYear);
    const month = Number(monthEnd[2]);
    const endDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const key = normalizedDate(year, month, endDay);
    if (key) return { start: key, end: key, label: monthEnd[0] };
  }
  return null;
}

export function taskDisplayText(text = "") {
  let result = cleanInline(String(text).replace(new RegExp(DISPLAY_META_RE.source, "gu"), " "));
  result = result.replace(PRIORITY_NAMED_RE, " ").replace(PRIORITY_TOKEN_RE, "$1");
  result = result
    .replace(/^(?:[^\uff1a:\n]{1,16}[\uff1a:](?!\d{2}(?:\s|$))){1,2}\s*/u, "")
    .replace(/^(?:(?:20\d{2}\s*[\/\u5e74.-]\s*)?\d{1,2}\s*[\/\u6708.-]\s*\d{1,2}\s*日?)(?:\s*[–—~-]\s*(?:(?:20\d{2}\s*[\/\u5e74.-]\s*)?\d{1,2}\s*[\/\u6708.-]\s*\d{1,2}\s*日?))?\s*(?:起\s*)?·?\s*/u, "")
    .replace(/^(AI·\s*)?\d{1,2}:\d{2}\s+/u, "$1")
    .replace(/^\d{1,2}月末\s*·?\s*/u, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return result || cleanInline(text);
}

/** AI 已承诺在指定日期执行或回报的任务，不需要借用 Capoo 的 SABC 才能进入今明清单。 */
export function isAiOwnedTask(task) {
  return /^AI·/u.test(String(task?.displayText || "").trim());
}

/** 兼容旧调用名：真正可自动执行必须有有效显式契约，`AI·`、日期和执行器都不够。 */
export function isAiExecutableTask(task) {
  return task?.automationMode === "automatic"
    && task?.automationContractStatus === "valid"
    && Boolean(String(task?.executorId || "").trim());
}

/** 需要 Capoo 主观确认的开发验收会保留在今日事项，直到本人处理。 */
export function isUserAcceptanceTask(task) {
  return /(?:^|[：:])验收[：:]/u.test(String(task?.text || "")) && !isAiOwnedTask(task);
}

/** AI 无法继续后升级给 Capoo 的阻塞项，同样不能因日期过去而消失。 */
export function isUserBlockedTask(task) {
  return /(?:^|[：:])阻塞[：:]/u.test(String(task?.text || "")) && !isAiOwnedTask(task);
}

function isFollowUpVisible(task, todayKey) {
  if (!task?.date) return false;
  return isTaskInNearTerm(task, todayKey);
}

export function parseTaskLine(line, context = {}) {
  const match = String(line).match(TASK_LINE_RE);
  if (!match) return null;
  const text = cleanInline(match[4]);
  const meta = parseTaskMeta(text);
  const derivedId = stableId(context.sourceKind === "project" ? (context.projectId || "project") : "central", `${context.sourcePath || ""}\n${text}`);
  const details = context.details || [];
  const automation = parseAgentTaskContract(details);
  const automationContractStatus = automation.valid
    ? "valid"
    : automation.present && automation.errors.some((item) => item.code === "AUTOMATION_CONTRACT_CONFLICT")
      ? "conflict"
      : automation.present
        ? "invalid"
        : "none";
  return {
    id: meta.id || derivedId,
    idKind: meta.id ? "explicit" : "derived",
    done: match[2].toLowerCase() === "x",
    completedAt: meta.completedAt,
    text,
    displayText: taskDisplayText(text),
    section: context.section || "doing",
    priority: parseTaskPriority(text),
    date: parseTaskDate(text, context.todayKey),
    parentId: meta.parentId,
    executorId: meta.executorId,
    details,
    automationMode: automation.present ? "automatic" : "manual",
    automationContractStatus,
    automationIssueCodes: automation.errors.map((item) => item.code),
    reviewAt: meta.reviewAt,
    featureId: meta.featureId,
    featureIds: meta.featureIds,
    worklineId: meta.worklineId,
    worklineIds: meta.worklineIds,
    relatedTaskIds: meta.relatedTaskIds,
    dependencyIds: meta.dependencyIds,
    sourcePath: context.sourcePath,
    sourceKind: context.sourceKind,
    projectId: context.projectId ?? null,
    projectName: context.projectName ?? null,
    lineNumber: context.lineNumber ?? null,
    writable: Boolean(meta.id || context.sourceKind === "central"),
  };
}

function linesAsText(section) {
  return (section?.lines ?? []).map(({ line }) => line).join("\n").trim();
}

function projectDashboardSummary(section) {
  const paragraph = [];
  let started = false;
  for (const { line } of section?.lines ?? []) {
    const cleaned = cleanInline(line.replace(/^>\s*/u, ""));
    if (!cleaned) {
      if (started) break;
      continue;
    }
    started = true;
    paragraph.push(cleaned);
  }
  const summary = paragraph.join(" ");
  const chars = Array.from(summary);
  if (chars.length <= PROJECT_DASHBOARD_SUMMARY_MAX_CHARS) return summary;
  return `${chars.slice(0, PROJECT_DASHBOARD_SUMMARY_MAX_CHARS - 1).join("")}…`;
}

function splitAssociationIds(value = "") {
  return value.split(/[,，、\s]+/u).map((item) => item.trim().toLowerCase()).filter(Boolean);
}

/** 只读取区块顶层条目；缩进证据属于上一个条目，不得冒充新的阻塞或最近完成。 */
export function parseProjectContextItems(section, limit = 20, options = {}) {
  if (!section) return [];
  const includeCompleted = options.includeCompleted !== false;
  const items = [];
  for (const { line } of section.lines) {
    if (!/^-\s+/u.test(line)) continue;
    const bullet = line.replace(/^-\s+/u, "");
    const isTask = /^\[[ xX]\]\s+/u.test(bullet);
    if (isTask && !includeCompleted && /^\[[xX]\]\s+/u.test(bullet)) continue;
    const cleaned = cleanInline(bullet.replace(/^\[[ xX]\]\s+/u, ""));
    if (!cleaned || cleaned === "无") continue;
    const metadata = new Map();
    for (const match of cleaned.matchAll(/[｜|]\s*(ID|父级|关联任务|工作线|模块|功能)\s*[：:]\s*([^｜|]+)/gu)) metadata.set(match[1], match[2].trim());
    const rawText = cleaned.replace(/[｜|]\s*(ID|父级|关联任务|工作线|模块|功能)\s*[：:]\s*([^｜|]+)/gu, "").trim();
    const taskIds = [...new Set([
      ...splitAssociationIds(metadata.get("父级")),
      ...splitAssociationIds(metadata.get("关联任务")),
    ])];
    items.push({
      id: splitAssociationIds(metadata.get("ID"))[0] || null,
      text: isTask ? taskDisplayText(rawText) : rawText,
      taskIds,
      worklineIds: splitAssociationIds(metadata.get("工作线")),
      moduleIds: splitAssociationIds(metadata.get("模块")),
      featureIds: splitAssociationIds(metadata.get("功能")),
    });
    if (items.length >= limit) break;
  }
  return items;
}

export function parseRecentCompleted(section, limit = 20) {
  return parseProjectContextItems(section, limit);
}

function focusBattleDateKey(value = "") {
  const match = String(value).trim().match(/^(20\d{2})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  return normalizedDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function calendarDayDistance(startKey, endKey) {
  const [startYear, startMonth, startDay] = String(startKey).split("-").map(Number);
  const [endYear, endMonth, endDay] = String(endKey).split("-").map(Number);
  return Math.round((Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay)) / 86_400_000);
}

function focusBattlePhase(status, startDate, endDate, todayKey) {
  if (status === "paused" || status === "completed" || status === "cancelled") return status;
  if (todayKey < startDate) return "upcoming";
  if (todayKey > endDate) return "expired";
  return "active";
}

function focusBattleCell(row, columnIndex, name) {
  const index = columnIndex.get(name);
  return index == null ? "" : cleanInline(row[index] ?? "");
}

function splitFocusList(value = "") {
  const cleaned = String(value).trim();
  if (!cleaned || /^(?:—|－|-|无)$/u.test(cleaned)) return [];
  return cleaned.split(/[,，、]+/u).map((item) => item.trim()).filter(Boolean);
}

function splitFocusRelationIds(value = "") {
  const cleaned = String(value).trim();
  if (!cleaned || /^(?:—|－|-|无)$/u.test(cleaned)) return [];
  return splitAssociationIds(cleaned);
}

/**
 * 限时大作战的唯一原件位于项目管理文件；这里仅解析显式 ID 和关系。
 * 任务文本、完成态与功能定义仍由各自原件单写。
 */
export function parseProjectFocusBattles(section, context = {}) {
  if (!section) return { battles: [], warnings: [] };
  const sourcePath = context.sourcePath || PROJECT_MANAGEMENT_FILE;
  const projectId = context.projectId || null;
  const projectName = context.projectName || "未命名项目";
  const todayKey = context.todayKey || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const knownTaskIds = context.knownTaskIds || new Set();
  const warnings = [];
  const chunks = [];
  let current = null;
  for (const entry of section.lines) {
    const heading = entry.line.match(/^###\s+(.+?)\s*[｜|]\s*ID\s*[：:]\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/u);
    if (heading) {
      current = { name: cleanInline(heading[1]), id: heading[2], lineNumber: entry.lineNumber, lines: [] };
      chunks.push(current);
      continue;
    }
    if (current) current.lines.push(entry);
  }
  if (linesAsText(section) && !chunks.length) {
    warnings.push(warning("FOCUS_BATTLE_FORMAT_INVALID", `“${projectName}”的“限时大作战”没有合法的三级标题和稳定 ID。`, { sourcePath, projectId }));
    return { battles: [], warnings };
  }

  const seenBattleIds = new Set();
  const battles = [];
  for (const chunk of chunks) {
    if (seenBattleIds.has(chunk.id)) {
      warnings.push(warning("DUPLICATE_FOCUS_BATTLE_ID", `限时大作战 ID“${chunk.id}”重复。`, { sourcePath, projectId }));
      continue;
    }
    seenBattleIds.add(chunk.id);
    const metadata = new Map();
    for (const { line } of chunk.lines) {
      const item = line.match(/^\s*-\s+([^：:]+)\s*[：:]\s*(.*?)\s*$/u);
      if (item) metadata.set(cleanInline(item[1]), cleanInline(item[2]));
    }
    const status = FOCUS_BATTLE_STATUS[metadata.get("状态")];
    if (!status) warnings.push(warning("FOCUS_BATTLE_STATUS_INVALID", `限时大作战“${chunk.name}”的状态必须是已启用、已暂停、已完成或已取消。`, { sourcePath, projectId }));
    const dateMatch = String(metadata.get("起止") || "").match(/^(20\d{2}-\d{2}-\d{2})\s*[—–至~～]\s*(20\d{2}-\d{2}-\d{2})$/u);
    const startDate = focusBattleDateKey(dateMatch?.[1]);
    const endDate = focusBattleDateKey(dateMatch?.[2]);
    if (!startDate || !endDate || endDate < startDate) {
      warnings.push(warning("FOCUS_BATTLE_DATE_INVALID", `限时大作战“${chunk.name}”的起止日期格式或顺序不对。`, { sourcePath, projectId }));
      continue;
    }

    const tableLines = chunk.lines.map(({ line }) => line).filter((line) => line.trim().startsWith("|") && line.trim().endsWith("|"));
    const rows = tableLines.map(splitMarkdownRow);
    const header = rows[0] || [];
    const columnIndex = new Map(header.map((cell, index) => [cleanInline(cell), index]));
    const stageRows = rows.slice(1).filter((row) => !row.every((cell) => /^:?-{3,}:?$/u.test(cleanInline(cell))));
    const stages = [];
    const seenStageIds = new Set();
    for (const row of stageRows) {
      const id = focusBattleCell(row, columnIndex, "节点 ID");
      const dueDate = focusBattleDateKey(focusBattleCell(row, columnIndex, "最晚验收"));
      const name = focusBattleCell(row, columnIndex, "节点");
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || seenStageIds.has(id)) {
        warnings.push(warning("FOCUS_STAGE_ID_INVALID", `限时大作战“${chunk.name}”有缺失、非法或重复的节点 ID“${id || "空"}”。`, { sourcePath, projectId }));
        continue;
      }
      seenStageIds.add(id);
      if (!dueDate || dueDate < startDate || dueDate > endDate) {
        warnings.push(warning("FOCUS_STAGE_DATE_INVALID", `节点“${name || id}”的最晚验收日不在大作战时间内。`, { sourcePath, projectId }));
        continue;
      }
      const taskIds = splitFocusRelationIds(focusBattleCell(row, columnIndex, "关联任务"));
      const featureIds = splitFocusRelationIds(focusBattleCell(row, columnIndex, "关联功能"));
      const dependencyIds = splitFocusRelationIds(focusBattleCell(row, columnIndex, "依赖"));
      const gateStatusLabel = focusBattleCell(row, columnIndex, "门状态") || "待验收";
      const gateStatus = FOCUS_BATTLE_GATE_STATUS[gateStatusLabel];
      if (!gateStatus) warnings.push(warning("FOCUS_STAGE_STATUS_INVALID", `节点“${name || id}”的门状态不受支持。`, { sourcePath, projectId }));
      for (const taskId of taskIds) {
        if (!knownTaskIds.has(taskId)) warnings.push(warning("FOCUS_STAGE_TASK_MISSING", `节点“${name || id}”关联的任务 ID“${taskId}”不存在于本项目。`, { sourcePath, projectId, taskId }));
      }
      stages.push({
        id,
        name: name || id,
        dueDate,
        focus: focusBattleCell(row, columnIndex, "今日重点"),
        taskIds,
        featureIds,
        dependencyIds,
        deliverables: splitFocusList(focusBattleCell(row, columnIndex, "交付物")),
        gate: focusBattleCell(row, columnIndex, "完成门"),
        gateStatus: gateStatus || "pending",
        evidenceRefs: splitFocusList(focusBattleCell(row, columnIndex, "证据")),
      });
    }
    for (const stage of stages) {
      for (const dependencyId of stage.dependencyIds) {
        if (!seenStageIds.has(dependencyId)) warnings.push(warning("FOCUS_STAGE_DEPENDENCY_MISSING", `节点“${stage.name}”依赖的节点 ID“${dependencyId}”不存在。`, { sourcePath, projectId }));
      }
      if (stage.gateStatus === "passed" && !stage.evidenceRefs.length) warnings.push(warning("FOCUS_STAGE_EVIDENCE_MISSING", `节点“${stage.name}”已通过但没有登记证据。`, { sourcePath, projectId }));
    }
    const totalDays = calendarDayDistance(startDate, endDate) + 1;
    const phase = focusBattlePhase(status || "enabled", startDate, endDate, todayKey);
    const currentDay = phase === "upcoming" ? 0 : Math.min(totalDays, Math.max(1, calendarDayDistance(startDate, todayKey) + 1));
    const todayStage = stages.find((stage) => stage.gateStatus !== "passed" && stage.dueDate >= todayKey)
      || stages.find((stage) => stage.gateStatus !== "passed")
      || null;
    battles.push({
      id: chunk.id,
      projectId: projectId || "unregistered-project",
      projectName,
      name: chunk.name,
      status: status || "enabled",
      phase,
      startDate,
      endDate,
      totalDays,
      currentDay,
      todayStageId: todayStage?.id || null,
      totalGoal: metadata.get("总目标") || "",
      finalGate: metadata.get("最终完成门") || "",
      riskIds: splitFocusRelationIds(metadata.get("风险")),
      reviewStatus: FOCUS_BATTLE_REVIEW_STATUS[metadata.get("复盘")] || "pending",
      sourcePath,
      stages,
    });
  }
  return { battles, warnings };
}

function parseAuthoritativeEntries(section, warnings, context) {
  const entries = [];
  for (const { line, lineNumber } of section?.lines ?? []) {
    if (!/^\s*-\s+/u.test(line)) continue;
    const link = wikiLink(line);
    const plainText = cleanInline(line.replace(/^\s*-\s*/u, ""));
    const label = cleanInline(line.replace(/^\s*-\s*/u, "").split(/[：:]/u)[0]);
    if (!link) {
      if (line.includes("[[")) warnings.push(warning("AUTHORITATIVE_LINK_INVALID", `“权威入口”第 ${lineNumber} 行的双链格式不对。`, { ...context }));
      entries.push({ label: plainText || "未命名入口", path: null });
    } else entries.push({ label: label || link.label, path: link.target.endsWith(".md") ? link.target : `${link.target}.md` });
  }
  return entries;
}

export function parseProjectManagementDocument(markdown = "", context = {}) {
  const sourcePath = context.sourcePath || PROJECT_MANAGEMENT_FILE;
  const projectId = context.projectId || null;
  const projectName = context.projectName || "未命名项目";
  const sections = sectionMap(markdown);
  const warnings = [];
  for (const heading of REQUIRED_SECTIONS) {
    if (!sections.has(heading)) warnings.push(warning("PROJECT_SECTION_MISSING", `“${projectName}”的项目管理文件缺少“${heading}”区块。`, { sourcePath, projectId }));
    else if (!linesAsText(sections.get(heading))) warnings.push(warning("PROJECT_SECTION_EMPTY", `“${projectName}”的“${heading}”还是空的。`, { sourcePath, projectId }));
  }
  if (/\[\[[^\n\]]*(?:$|\n)/u.test(String(markdown))) warnings.push(warning("WIKILINK_MALFORMED", `“${projectName}”的项目管理文件里有未闭合的双链。`, { sourcePath, projectId }));

  const parseTasks = (heading, section) => {
    const result = [];
    const target = sections.get(heading);
    const lines = target?.lines ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      const { line, lineNumber } = lines[index];
      if (!/^\s*-\s+\[/u.test(line)) continue;
      const details = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor].line;
        if (/^\s*-\s+\[/u.test(candidate)) break;
        if (/^\s{2,}-\s+/u.test(candidate)) details.push(cleanInline(candidate.replace(/^\s*-\s*/u, "")));
      }
      const task = parseTaskLine(line, { sourcePath, sourceKind: "project", projectId, projectName, section, lineNumber, todayKey: context.todayKey, details });
      if (!task) {
        warnings.push(warning("TASK_FORMAT_INVALID", `“${projectName}”的“${heading}”第 ${lineNumber} 行待办格式不对。`, { sourcePath, projectId }));
        continue;
      }
      if (task.idKind !== "explicit") warnings.push(warning("TASK_ID_MISSING", `“${projectName}”的“${heading}”第 ${lineNumber} 行缺少稳定 ID，暂时不能在页面写回。`, { sourcePath, projectId, taskId: task.id }));
      else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(task.id)) warnings.push(warning("TASK_ID_INVALID", `任务 ID“${task.id}”格式不对。`, { sourcePath, projectId, taskId: task.id }));
      if (task.executorId && !/^[a-z0-9][a-z0-9-]*$/u.test(task.executorId)) {
        warnings.push(warning("AI_EXECUTOR_INVALID", `任务“${task.id}”的执行器编号格式不对。`, { sourcePath, projectId, taskId: task.id }));
      }
      if (!task.done && task.automationContractStatus === "valid" && !task.executorId) {
        warnings.push(warning("AUTOMATION_EXECUTOR_MISSING", `自动任务“${task.displayText.replace(/^AI·\s*/u, "")}”没有绑定执行器，已停止自动派发。`, { sourcePath, projectId, taskId: task.id }));
      } else if (!task.done && ["invalid", "conflict"].includes(task.automationContractStatus)) {
        warnings.push(warning("AUTOMATION_CONTRACT_INVALID", `任务“${task.displayText.replace(/^AI·\s*/u, "")}”的自动推进契约无效，已停止自动派发。`, { sourcePath, projectId, taskId: task.id, issueCodes: task.automationIssueCodes }));
      } else if (!task.done && task.executorId && task.automationContractStatus === "none") {
        warnings.push(warning("EXECUTOR_WITHOUT_AUTOMATION_CONTRACT", `任务“${task.displayText.replace(/^AI·\s*/u, "")}”只有执行器、没有显式自动推进契约，按人工派发处理。`, { sourcePath, projectId, taskId: task.id }));
      }
      result.push(task);
    }
    return result;
  };

  const doing = parseTasks("正在做", "doing");
  const next = parseTasks("下一步", "next");
  const blocked = parseTasks("阻塞", "blocked");
  const allManagedTasks = [...doing, ...next, ...blocked];
  const focusBattleResult = parseProjectFocusBattles(sections.get("限时大作战"), {
    sourcePath,
    projectId,
    projectName,
    todayKey: context.todayKey,
    knownTaskIds: new Set(allManagedTasks.filter((task) => task.idKind === "explicit").map((task) => task.id)),
  });
  warnings.push(...focusBattleResult.warnings);
  for (const task of allManagedTasks) {
    if (!isAiOwnedTask(task)) continue;
    const blockedByTaskIds = blocked.filter((candidate) => !candidate.done && candidate.parentId === task.id).map((candidate) => candidate.id);
    task.blockedByTaskIds = blockedByTaskIds;
    const latestRunEvidence = task.details.filter((detail) =>
      /^20\d{2}-\d{2}-\d{2}\b/u.test(detail)
      && /(?:自动验收|自动复核|自动复验|自然唤醒|自然运行|调度运行|复验|结果|结论)/u.test(detail)).at(-1);
    const latestRunFailed = Boolean(latestRunEvidence
      && /(?:未通过|失败|受阻|blocked|incomplete|没有结果|未升版|未重建|未重启|保持未完成)/iu.test(latestRunEvidence));
    const latestRunPassed = Boolean(latestRunEvidence
      && !latestRunFailed
      && /(?:自动验收|自动复核|自动复验|自然唤醒|自然运行|调度运行|复验|验收)(?:结果|结论)?\s*(?:已)?(?:通过|成功|完成)|(?:结果|结论)\s*[：:]\s*(?:通过|成功|完成)/u.test(latestRunEvidence));
    task.aiExecutionStatus = blockedByTaskIds.length
        ? "blocked"
        : latestRunFailed
        ? "ran-failed"
        : latestRunPassed
        ? "ran-passed"
        : latestRunEvidence
        ? "ran-failed"
        : "not-run";
    const progress = parseAiProgress(task.details);
    task.aiProgressUpdatedAt = progress.updatedAt;
    task.aiCurrentState = progress.currentState;
    task.aiNextAction = progress.nextAction;
    if (!task.done && isAiExecutableTask(task) && task.aiExecutionStatus !== "not-run" && (!progress.updatedAt || !progress.currentState || !progress.nextAction)) {
      warnings.push(warning("AI_PROGRESS_INCOMPLETE", `AI 自动任务“${task.displayText.replace(/^AI·\s*/u, "")}”已有运行结论但进展交接不完整，必须同步进展时间、当前状态和下一步。`, { sourcePath, projectId, taskId: task.id }));
    }
  }
  const taskAssociationsById = new Map(allManagedTasks
    .filter((task) => task.idKind === "explicit")
    .map((task) => [task.id.toLowerCase(), task]));
  const inheritTaskAssociations = (item) => {
    const taskIds = [...new Set([...(item.id ? [item.id] : []), ...item.taskIds])];
    const tasks = taskIds.flatMap((taskId) => {
      const task = taskAssociationsById.get(taskId);
      return task ? [task] : [];
    });
    return {
      ...item,
      worklineIds: [...new Set([...item.worklineIds, ...tasks.flatMap((task) => task.worklineIds)])],
      featureIds: [...new Set([...item.featureIds, ...tasks.flatMap((task) => task.featureIds)])],
    };
  };
  const blockers = parseProjectContextItems(sections.get("阻塞"), 10, { includeCompleted: false })
    .filter((item) => !/^(?:(?:当前)?已确认)?阻塞[：:]?\s*无[。.！!]*$/u.test(item.text) && !/^无[。.！!]*$/u.test(item.text))
    .map(inheritTaskAssociations);
  const recentCompleted = parseRecentCompleted(sections.get("最近完成")).map(inheritTaskAssociations);
  const currentRaw = linesAsText(sections.get("当前状态"));
  const currentStatus = cleanInline(currentRaw.replace(/^>\s*/gmu, " "));
  return {
    currentStatus,
    dashboardSummary: projectDashboardSummary(sections.get("总看板摘要") || sections.get("当前状态")),
    focusBattles: focusBattleResult.battles,
    doing,
    next,
    blocked,
    blockers,
    recentCompleted,
    authoritativeEntries: parseAuthoritativeEntries(sections.get("权威入口"), warnings, { sourcePath, projectId }),
    warnings,
  };
}

export function parseCentralTasks(markdown = "", context = {}) {
  const sections = sectionMap(markdown);
  const currentHeading = CENTRAL_CURRENT_HEADINGS.find((heading) => sections.has(heading));
  const warnings = [];
  if (!currentHeading) warnings.push(warning("CENTRAL_CURRENT_SECTION_MISSING", "中央待办没有“最近两天”或兼容的当前任务区块。", { sourcePath: TODO_PATH }));
  const parse = (heading, section) => {
    const tasks = [];
    const lines = sections.get(heading)?.lines ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      const { line, lineNumber } = lines[index];
      if (!/^\s*-\s+\[/u.test(line)) continue;
      const details = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor].line;
        if (/^\s*-\s+\[/u.test(candidate)) break;
        if (/^\s{2,}-\s+/u.test(candidate)) details.push(cleanInline(candidate.replace(/^\s*-\s*/u, "")));
      }
      const task = parseTaskLine(line, { sourcePath: TODO_PATH, sourceKind: "central", section, lineNumber, todayKey: context.todayKey, details });
      if (task) tasks.push(task);
    }
    return tasks;
  };
  return {
    current: currentHeading ? parse(currentHeading, "central-current") : [],
    longTerm: sections.has("长期在推") ? parse("长期在推", "central-long-term") : [],
    warnings,
  };
}

function assertInside(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("路径越出 Vault");
  return absolute;
}

async function readOptional(root, relativePath) {
  try { return await fs.readFile(assertInside(root, relativePath), "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function duplicateWarnings(tasks) {
  const warnings = [];
  const byId = new Map();
  for (const task of tasks) {
    // 旧中央待办没有 ID 时会生成兼容 ID；它不是“全局 ID”原件，不用它制造虚假冲突警报。
    if (task.idKind !== "explicit") continue;
    const previous = byId.get(task.id);
    if (previous) warnings.push(warning("DUPLICATE_TASK_ID", `任务 ID“${task.id}”同时出现在“${previous.projectName || "中央待办"}”和“${task.projectName || "中央待办"}”，请先改成全局唯一 ID。`, { sourcePath: task.sourcePath, projectId: task.projectId, taskId: task.id }));
    else byId.set(task.id, task);
  }
  return warnings;
}

function relationRef(kind, id, projectId) {
  return { kind, id, projectId: projectId || null };
}

/**
 * 全事业关系索引是每次读原件重建的派生数据，不是第二份任务真值。
 * 只读稳定 ID 和显式元数据；标题、关键词和文件路径都不参与关系猜测。
 */
export function buildProjectRelationIndex(projects, central = { current: [], longTerm: [] }) {
  const projectTasks = projects.flatMap((project) => project.management
    ? [...project.management.doing, ...project.management.next, ...project.management.blocked]
    : []);
  const tasks = [...(central.current || []), ...(central.longTerm || []), ...projectTasks];
  const taskOccurrences = new Map();
  for (const task of tasks) taskOccurrences.set(task.id, [...(taskOccurrences.get(task.id) || []), task]);

  const edges = [];
  const issues = [];
  const edgeKeys = new Set();
  const addEdge = (type, source, target) => {
    const key = `${type}:${source.projectId || "central"}:${source.kind}:${source.id}:${target.projectId || "central"}:${target.kind}:${target.id}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ type, source, target });
  };
  const taskTarget = (source, relationType, targetId) => {
    const matches = taskOccurrences.get(targetId) || [];
    if (matches.length === 1) return relationRef("task", targetId, matches[0].projectId);
    issues.push({
      code: matches.length ? "RELATION_TARGET_AMBIGUOUS" : "RELATION_TARGET_MISSING",
      projectId: source.projectId,
      sourceKind: source.kind,
      sourceId: source.id,
      relationType,
      targetId,
    });
    return null;
  };
  const addScopes = (source, item) => {
    if (source.projectId) addEdge("scoped_to_project", source, relationRef("project", source.projectId, source.projectId));
    for (const id of item.worklineIds || []) addEdge("scoped_to_workline", source, relationRef("workline", id, source.projectId));
    for (const id of item.moduleIds || []) addEdge("scoped_to_module", source, relationRef("module", id, source.projectId));
    for (const id of item.featureIds || []) addEdge("scoped_to_feature", source, relationRef("feature", id, source.projectId));
  };

  for (const task of tasks) {
    const source = relationRef("task", task.id, task.projectId);
    addScopes(source, task);
    if (task.parentId) {
      const target = taskTarget(source, "child_of", task.parentId);
      if (target) addEdge("child_of", source, target);
    }
    for (const id of task.dependencyIds || []) {
      const target = taskTarget(source, "depends_on", id);
      if (target) addEdge("depends_on", source, target);
    }
    for (const id of task.relatedTaskIds || []) {
      const target = taskTarget(source, "related_to", id);
      if (target) addEdge("related_to", source, target);
    }
  }

  for (const project of projects) {
    if (!project.management || project.archived) continue;
    for (const battle of project.management.focusBattles || []) {
      const battleSource = relationRef("focus-battle", battle.id, project.projectId);
      addEdge("scoped_to_project", battleSource, relationRef("project", project.projectId, project.projectId));
      const stageIds = new Set(battle.stages.map((stage) => stage.id));
      for (const stage of battle.stages) {
        const stageSource = relationRef("focus-stage", stage.id, project.projectId);
        addEdge("has_stage", battleSource, stageSource);
        addEdge("scoped_to_project", stageSource, relationRef("project", project.projectId, project.projectId));
        for (const featureId of stage.featureIds) addEdge("scoped_to_feature", stageSource, relationRef("feature", featureId, project.projectId));
        for (const taskId of stage.taskIds) {
          const target = taskTarget(stageSource, "delivers_through", taskId);
          if (target) addEdge("delivers_through", stageSource, target);
        }
        for (const dependencyId of stage.dependencyIds) {
          if (stageIds.has(dependencyId)) addEdge("depends_on", stageSource, relationRef("focus-stage", dependencyId, project.projectId));
        }
      }
    }
  }

  for (const project of projects) {
    if (!project.management || project.archived) continue;
    for (const [kind, relationType, items] of [
      ["blocker", "blocks", project.management.blockers || []],
      ["recent", "recent_for", project.management.recentCompleted || []],
    ]) {
      for (const item of items) {
        if (!item.id) {
          issues.push({ code: "RELATION_SOURCE_ID_MISSING", projectId: project.projectId, sourceKind: kind, sourceId: null });
          continue;
        }
        const source = relationRef(kind, item.id, project.projectId);
        const implicitTaskIds = taskOccurrences.has(item.id) ? [item.id] : [];
        const taskIds = [...new Set(item.taskIds || [])];
        addScopes(source, item);
        for (const id of taskIds) {
          const target = taskTarget(source, relationType, id);
          if (target) addEdge(relationType, source, target);
        }
        for (const id of implicitTaskIds) {
          const implicitRelationType = kind === "recent" ? "completed" : relationType;
          const target = taskTarget(source, implicitRelationType, id);
          if (target) addEdge(implicitRelationType, source, target);
        }
      }
    }
  }
  return { edges, issues };
}

export async function readProjectManagement(root, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const todayKey = options.todayKey || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
  const [registryMarkdown, todoMarkdown] = await Promise.all([
    readOptional(root, CAREER_OVERVIEW),
    readOptional(root, TODO_PATH),
  ]);
  const warnings = [];
  if (registryMarkdown == null) warnings.push(warning("REGISTRY_MISSING", "找不到事业项目注册表。", { sourcePath: CAREER_OVERVIEW }));
  if (todoMarkdown == null) warnings.push(warning("CENTRAL_TODO_MISSING", "找不到中央待办文件。", { sourcePath: TODO_PATH }));
  const registry = parseProjectRegistry(registryMarkdown || "");
  warnings.push(...registry.warnings);
  const projects = await Promise.all(registry.projects.map(async (project) => {
    if (!project.migrated || project.archived) return { ...project, management: null, featureTree: null, hasFeatureTree: false, projectHub: null, hasProjectHub: false };
    const markdown = await readOptional(root, project.managementPath);
    let management;
    if (markdown == null) {
      const itemWarning = warning("PROJECT_FILE_MISSING", `项目“${project.name}”已登记，但找不到项目管理文件。`, { sourcePath: project.managementPath, projectId: project.projectId });
      warnings.push(itemWarning);
      management = { currentStatus: "", dashboardSummary: "", focusBattles: [], doing: [], next: [], blocked: [], blockers: [], recentCompleted: [], authoritativeEntries: [], warnings: [itemWarning] };
    } else {
      management = parseProjectManagementDocument(markdown, { ...project, projectName: project.name, sourcePath: project.managementPath, todayKey });
      warnings.push(...management.warnings);
    }
    const featureEntry = management.authoritativeEntries.find((entry) => entry.label === PRODUCT_FEATURE_TREE_LABEL && entry.path);
    const [featureTree, externalHub] = await Promise.all([
      featureEntry?.path ? readProductFeatureTree(root, featureEntry.path) : Promise.resolve(null),
      readExternalProjectHub(project.projectId),
    ]);
    if (featureEntry?.path && !featureTree) {
      const itemWarning = warning("FEATURE_TREE_FILE_MISSING", `项目“${project.name}”登记了产品功能树，但找不到原件。`, { sourcePath: featureEntry.path, projectId: project.projectId });
      warnings.push(itemWarning);
      management.warnings.push(itemWarning);
    }
    if (featureTree?.warnings.length) {
      const treeWarnings = featureTree.warnings.map((item) => ({ ...item, projectId: project.projectId }));
      warnings.push(...treeWarnings);
      management.warnings.push(...treeWarnings);
    }
    const hubIssues = [...externalHub.errors, ...externalHub.warnings].map((item) => ({ ...item, projectId: project.projectId }));
    if (hubIssues.length) {
      warnings.push(...hubIssues);
      management.warnings.push(...hubIssues);
    }
    return {
      ...project,
      management,
      featureTree,
      hasFeatureTree: Boolean(featureEntry?.path),
      projectHub: externalHub.hub,
      hasProjectHub: externalHub.registered,
    };
  }));
  const central = parseCentralTasks(todoMarkdown || "", { todayKey });
  warnings.push(...central.warnings);
  const projectTasks = projects.flatMap((project) => !project.archived && project.management ? [...project.management.doing, ...project.management.next, ...project.management.blocked] : []);
  const allTasks = [...central.current, ...central.longTerm, ...projectTasks];
  warnings.push(...duplicateWarnings(allTasks));

  // 冲突 ID 只展示第一条，但必须同时显式报警，不做静默去重。
  const displayedIds = new Set();
  const currentTodos = [...central.current, ...projectTasks].filter((task) => {
    const completedAt = task.completedAt ? Date.parse(task.completedAt) : Number.NaN;
    const recentCompletion = task.done
      && Number.isFinite(completedAt)
      && now.getTime() - completedAt >= 0
      && now.getTime() - completedAt < RECENT_COMPLETION_TTL_MS;
    if (task.done && !recentCompletion) return false;
    // 刚完成项的 24 小时恢复窗口按可信完成时刻计，不因原任务日期跨日而提前消失。
    const visibleKind = Boolean(task.date);
    if (!visibleKind || (!task.done && !isFollowUpVisible(task, todayKey)) || displayedIds.has(task.id)) return false;
    displayedIds.add(task.id);
    return true;
  });
  const relationIndex = buildProjectRelationIndex(projects, central);
  return { projects, central, tasks: allTasks, currentTodos, relationIndex, warnings };
}

export async function resolveRegisteredProject(root, projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) return null;
  const markdown = await readOptional(root, CAREER_OVERVIEW);
  if (markdown == null) return null;
  const registry = parseProjectRegistry(markdown);
  const matches = registry.projects.filter((project) => project.projectId === projectId && project.migrated);
  return matches.length === 1 ? matches[0] : null;
}

export async function resolveRegisteredSource(root, sourcePath) {
  if (typeof sourcePath !== "string" || !sourcePath.trim()) return null;
  const markdown = await readOptional(root, CAREER_OVERVIEW);
  if (markdown == null) return null;
  const registry = parseProjectRegistry(markdown);
  const matches = registry.projects.filter((project) => project.migrated && project.managementPath === sourcePath);
  return matches.length === 1 ? matches[0] : null;
}

export async function findGlobalTaskOccurrences(root, taskId) {
  if (typeof taskId !== "string" || !taskId.trim()) return [];
  const [registryMarkdown, todoMarkdown] = await Promise.all([readOptional(root, CAREER_OVERVIEW), readOptional(root, TODO_PATH)]);
  const registry = parseProjectRegistry(registryMarkdown || "");
  const occurrences = [];
  const central = parseCentralTasks(todoMarkdown || "");
  for (const task of [...central.current, ...central.longTerm]) if (task.id === taskId) occurrences.push(task);
  for (const project of registry.projects) {
    if (!project.migrated) continue;
    const markdown = await readOptional(root, project.managementPath);
    if (markdown == null) continue;
    const management = parseProjectManagementDocument(markdown, { ...project, projectName: project.name, sourcePath: project.managementPath });
    for (const task of [...management.doing, ...management.next, ...management.blocked]) if (task.id === taskId) occurrences.push(task);
  }
  return occurrences;
}

export function findTaskLine(content, action) {
  const expectedSourceKind = action.sourcePath === TODO_PATH ? "central" : "project";
  const lines = String(content).split(/\r?\n/u);
  const sections = sectionMap(content);
  const sectionByLine = new Map();
  for (const [heading, section] of sections) for (const row of section.lines) sectionByLine.set(row.lineNumber, heading);
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = sectionByLine.get(index + 1);
    if (!heading) continue;
    const task = parseTaskLine(lines[index], {
      sourcePath: action.sourcePath,
      sourceKind: expectedSourceKind,
      projectId: action.projectId || (expectedSourceKind === "project" ? "project" : null),
      section: heading,
      lineNumber: index + 1,
    });
    if (task?.id === action.id) candidates.push({ index, line: lines[index], task, match: lines[index].match(TASK_LINE_RE) });
  }
  return { lines, candidates };
}

export function replaceTaskPriority(rawText, priority) {
  const nextPriority = priority == null ? null : String(priority).toUpperCase();
  if (nextPriority != null && !TASK_PRIORITIES.includes(nextPriority)) throw new Error("待办等级不受支持");
  const named = String(rawText).match(PRIORITY_NAMED_RE);
  if (named) return nextPriority == null ? String(rawText).replace(PRIORITY_NAMED_RE, "") : String(rawText).replace(PRIORITY_NAMED_RE, `${nextPriority}：`);
  const token = String(rawText).match(PRIORITY_TOKEN_RE);
  if (token) {
    if (nextPriority == null) return String(rawText).replace(PRIORITY_TOKEN_RE, token[1]);
    return String(rawText).replace(PRIORITY_TOKEN_RE, `${token[1]}${nextPriority}：`);
  }
  if (nextPriority == null) return String(rawText);
  const dateIndex = String(rawText).search(/(?:(?:20\d{2}\s*[\/\u5e74.-]\s*)?\d{1,2}\s*[\/\u6708.-]\s*\d{1,2}|待排|无日期)/u);
  if (dateIndex >= 0) return `${String(rawText).slice(0, dateIndex)}${nextPriority}：${String(rawText).slice(dateIndex)}`;
  const typedPrefix = String(rawText).match(/^((?:[^：:\n]{1,16}[：:]){2})/u);
  if (typedPrefix) return `${typedPrefix[1]}${nextPriority}：${String(rawText).slice(typedPrefix[1].length)}`;
  return `${nextPriority}：${rawText}`;
}
