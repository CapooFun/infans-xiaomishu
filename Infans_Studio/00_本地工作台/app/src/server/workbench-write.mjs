import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { cleanInline, invalidateVaultScanCache, SOURCES } from "./workbench-data.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { resolveWritableVaultPath, withVaultFileWrite } from "./workbench-file-write-guard.mjs";
import { diaryPathForDay, isWorkbenchCodePath, PROTECTED_RELATIONSHIP_MEMORY_PATHS, RENEWAL_EXPIRY_SOURCE } from "./vault-paths.mjs";
import { prepareRenewalDecisionUpdate, readRenewalExpiry } from "./workbench-renewals.mjs";
import {
  findTaskLine,
  findGlobalTaskOccurrences,
  parseTaskLine,
  parseTaskPriority,
  readProjectManagement,
  replaceTaskPriority,
  resolveRegisteredProject,
  resolveRegisteredSource,
  taskDisplayText,
  TASK_PRIORITIES,
} from "./workbench-project-management.mjs";

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_NOTE_LENGTH = 1200;
const MAX_TASK_LENGTH = 280;
const MAX_EDIT_FILE_LENGTH = 200_000;

/** 工作台源码与运行相关路径：任何客户端写入前必须二次确认。 */
export function isCodePath(relativePath = "") {
  const normalized = String(relativePath).replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.includes("..")) return false;
  return isWorkbenchCodePath(normalized);
}

function assertEditablePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  if (!normalized || normalized.includes("..")) throw new WorkbenchWriteError("写入路径不对", 400, "PATH_INVALID");
  if (normalized.startsWith(".git/") || normalized === ".git") throw new WorkbenchWriteError("禁止写入 .git", 403, "PATH_FORBIDDEN");
  if (normalized.includes("/node_modules/") || normalized.endsWith("/node_modules") || normalized.startsWith("node_modules/")) {
    throw new WorkbenchWriteError("禁止写入 node_modules", 403, "PATH_FORBIDDEN");
  }
  // 本人草稿：使用者手写区，工作台 AI 写入一律拒绝
  if (normalized === "00_本地工作台/本人草稿" || normalized.startsWith("00_本地工作台/本人草稿/")) {
    throw new WorkbenchWriteError("禁止写入本人草稿（只读手写区）", 403, "PATH_FORBIDDEN");
  }
  if (PROTECTED_RELATIONSHIP_MEMORY_PATHS.includes(normalized)) {
    throw new WorkbenchWriteError("关系记忆只能经专用预览与本人确认通道修改", 403, "RELATIONSHIP_MEMORY_PROTECTED");
  }
  if (/\.(png|jpe?g|gif|webp|avif|mp3|mp4|mov|zip|pdf|ico|woff2?|ttf|otf|db|anki2?)$/i.test(normalized)) {
    throw new WorkbenchWriteError("禁止写入该二进制/媒体类型", 403, "PATH_FORBIDDEN");
  }
  return normalized;
}

function prepareEditFile(originalContent, action) {
  const oldText = typeof action.oldText === "string" ? action.oldText : "";
  const newText = typeof action.newText === "string" ? action.newText : null;
  const content = typeof action.content === "string" ? action.content : null;
  let next;
  let before;
  let after;
  if (content != null) {
    if (content.length > MAX_EDIT_FILE_LENGTH) throw new WorkbenchWriteError(`文件内容不能超过 ${MAX_EDIT_FILE_LENGTH} 字符`);
    next = content;
    before = originalContent.length > 1200 ? `${originalContent.slice(0, 1200)}\n…` : originalContent || "（文件找不到或是空的）";
    after = content.length > 1200 ? `${content.slice(0, 1200)}\n…` : content;
  } else if (newText != null) {
    if (!oldText) throw new WorkbenchWriteError("editFile 替换模式需要 oldText");
    if (!originalContent.includes(oldText)) throw new WorkbenchWriteError("未找到要替换的原文，请刷新后重试", 409, "EDIT_TEXT_MISSING");
    const occurrences = originalContent.split(oldText).length - 1;
    if (occurrences !== 1) throw new WorkbenchWriteError(`原文出现 ${occurrences} 次，请改用更精确片段或整文件 content`, 409, "EDIT_TEXT_AMBIGUOUS");
    if (newText.length > MAX_EDIT_FILE_LENGTH) throw new WorkbenchWriteError(`替换内容过长`);
    next = originalContent.replace(oldText, newText);
    if (next.length > MAX_EDIT_FILE_LENGTH) throw new WorkbenchWriteError(`文件内容不能超过 ${MAX_EDIT_FILE_LENGTH} 字符`);
    before = oldText.length > 800 ? `${oldText.slice(0, 800)}\n…` : oldText;
    after = newText.length > 800 ? `${newText.slice(0, 800)}\n…` : newText;
  } else {
    throw new WorkbenchWriteError("editFile 需要 content 或 newText");
  }
  return { content: next, before, after, summary: `编辑 ${action.path}` };
}

function fingerprint(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function hideTaskMetadata(value) {
  return String(value).replace(/\s*[｜|]\s*(?:ID|父级|依赖)\s*[：:]\s*([^｜|]+)/gu, "").trimEnd();
}

async function readOptional(absolute) {
  try {
    const [content, stat] = await Promise.all([fs.readFile(absolute, "utf8"), fs.stat(absolute)]);
    return { absolute, exists: true, content, hash: fingerprint(content), mode: stat.mode };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { absolute, exists: false, content: "", hash: null, mode: null };
    }
    throw error;
  }
}

function normalizeText(value, maxLength, singleLine = false) {
  if (typeof value !== "string") throw new WorkbenchWriteError("内容格式不正确");
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const result = singleLine ? normalized.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ") : normalized;
  if (!result) throw new WorkbenchWriteError("内容不能为空");
  if (result.length > maxLength) throw new WorkbenchWriteError(`内容不能超过 ${maxLength} 个字符`);
  return result;
}

function sectionBounds(lines, heading) {
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) throw new WorkbenchWriteError(`没有找到“${heading}”区块`, 409, "SECTION_MISSING");
  const next = lines.findIndex((line, index) => index > start && /^#{1,2}\s+/.test(line));
  return { start, end: next < 0 ? lines.length : next };
}

function insertAtSectionEnd(lines, bounds, value) {
  let insertion = bounds.end;
  while (insertion > bounds.start + 1 && lines[insertion - 1].trim() === "") insertion -= 1;
  lines.splice(insertion, 0, value);
}

function todoHeading(scope, lines = []) {
  if (scope === "today") {
    for (const heading of ["最近两天", "今天 / 本周", "当前任务"]) {
      if (lines.some((line) => line.trim() === `## ${heading}`)) return heading;
    }
    return "最近两天";
  }
  if (scope === "longTerm") return "长期在推";
  throw new WorkbenchWriteError("待办分类不受支持");
}

function withCompletionTime(text, completed, now) {
  const cleaned = String(text).replace(/[｜|]\s*完成时间\s*[：:]\s*[^｜|]+/gu, "").trim();
  return completed ? `${cleaned}｜完成时间：${now.toISOString()}` : cleaned;
}

function prepareTodoToggle(content, action) {
  const text = normalizeText(action.text, MAX_TASK_LENGTH, true);
  const lines = content.split(/\r?\n/);
  const heading = todoHeading(action.scope, lines);
  const bounds = sectionBounds(lines, heading);
  const candidates = [];
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const match = lines[index].match(/^(\s*-\s+\[)([ xX])(\]\s+)(.+)$/);
    if (match && cleanInline(match[4]) === text) candidates.push({ index, match });
  }
  if (candidates.length !== 1) {
    throw new WorkbenchWriteError(candidates.length ? "存在同名待办，请在 Obsidian 中处理" : "待办已变化，请刷新后重试", 409, "TODO_CHANGED");
  }
  const candidate = candidates[0];
  const currentDone = candidate.match[2].toLowerCase() === "x";
  if (currentDone !== Boolean(action.expectedDone)) {
    throw new WorkbenchWriteError("待办状态已被外部修改，请刷新后重试", 409, "TODO_CHANGED");
  }
  const before = lines[candidate.index];
  const after = `${candidate.match[1]}${currentDone ? " " : "x"}${candidate.match[3]}${candidate.match[4]}`;
  lines[candidate.index] = after;
  return { content: lines.join("\n"), before, after, summary: currentDone ? "恢复待办" : "完成待办" };
}

function prepareTodoAdd(content, action) {
  const text = normalizeText(action.text, MAX_TASK_LENGTH, true);
  const lines = content.split(/\r?\n/);
  const heading = todoHeading(action.scope, lines);
  const bounds = sectionBounds(lines, heading);
  const after = `- [ ] ${text}`;
  insertAtSectionEnd(lines, bounds, after);
  return { content: lines.join("\n"), before: `“${heading}”区块末尾`, after, summary: "新增待办" };
}

async function resolveTodoTarget(root, action) {
  if (!action.sourcePath || action.sourcePath === SOURCES.todo) {
    return { targetPath: SOURCES.todo, targetLabel: "中央待办" };
  }
  const project = await resolveRegisteredSource(root, action.sourcePath);
  if (!project) throw new WorkbenchWriteError("待办来源未在事业项目注册表登记，请刷新后重试", 403, "TODO_SOURCE_FORBIDDEN");
  return { targetPath: project.managementPath, targetLabel: `${project.name} · 项目进度与待办`, project };
}

function uniqueTaskCandidate(content, action) {
  const { lines, candidates } = findTaskLine(content, action);
  if (candidates.length !== 1) {
    throw new WorkbenchWriteError(candidates.length ? "任务 ID 重复，请先修正项目文件" : "待办已变化，请刷新后重试", 409, "TODO_CHANGED");
  }
  return { lines, candidate: candidates[0] };
}

function tokyoDateKey(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function recentCompletionId(line = "") {
  return line.match(/[｜|]\s*ID\s*[：:]\s*([^｜|\s]+)/u)?.[1]?.trim().toLowerCase() || null;
}

function syncFeatureTaskRecentCompletion(lines, candidate, id, completed, now) {
  if (!candidate.task.featureIds?.length) return false;
  const bounds = sectionBounds(lines, "最近完成");
  const normalizedId = id.toLowerCase();
  const matches = [];
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    if (/^\s*-\s+/u.test(lines[index]) && recentCompletionId(lines[index]) === normalizedId) matches.push(index);
  }
  if (completed) {
    if (matches.length) return false;
    for (let index = bounds.end - 1; index > bounds.start; index -= 1) {
      if (/^\s*-\s*无[。.！!]*\s*$/u.test(lines[index])) lines.splice(index, 1);
    }
    while (lines[bounds.start + 1]?.trim() === "") lines.splice(bounds.start + 1, 1);
    lines.splice(bounds.start + 1, 0, "", `- ${tokyoDateKey(now)} · ${taskDisplayText(candidate.task.text)}｜ID：${id}`);
    if (lines[bounds.start + 3]?.trim() !== "") lines.splice(bounds.start + 3, 0, "");
    return true;
  }
  for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
    const start = matches[matchIndex];
    let end = start + 1;
    while (end < lines.length && (/^\s{2,}\S/u.test(lines[end]) || lines[end].trim() === "")) end += 1;
    lines.splice(start, end - start);
  }
  const refreshed = sectionBounds(lines, "最近完成");
  const hasEntries = lines.slice(refreshed.start + 1, refreshed.end).some((line) => /^\s*-\s+\S/u.test(line));
  if (!hasEntries) {
    while (lines[refreshed.start + 1]?.trim() === "") lines.splice(refreshed.start + 1, 1);
    lines.splice(refreshed.start + 1, 0, "", "- 无", "");
  }
  return matches.length > 0;
}

function prepareSourcedTodoToggle(content, action, now, syncRecentCompletion = false) {
  const id = normalizeText(action.id, MAX_TASK_LENGTH, true);
  const { lines, candidate } = uniqueTaskCandidate(content, { ...action, id });
  const currentDone = candidate.task.done;
  if (currentDone !== Boolean(action.expectedDone)) {
    throw new WorkbenchWriteError("待办状态已被外部修改，请刷新后重试", 409, "TODO_CHANGED");
  }
  const before = lines[candidate.index];
  const nextText = withCompletionTime(candidate.match[4], !currentDone, now);
  const after = `${candidate.match[1]}${currentDone ? " " : "x"}${candidate.match[3]}${nextText}`;
  lines[candidate.index] = after;
  const recentChanged = syncRecentCompletion
    ? syncFeatureTaskRecentCompletion(lines, candidate, id, !currentDone, now)
    : false;
  return {
    content: lines.join("\n"),
    before,
    after,
    summary: currentDone ? "恢复待办" : recentChanged ? "完成待办并收束到 Wiki" : "完成待办",
  };
}

function normalizePriority(value, fieldName) {
  if (value == null || value === "") return null;
  const priority = String(value).toUpperCase();
  if (!TASK_PRIORITIES.includes(priority)) throw new WorkbenchWriteError(`${fieldName}不受支持`, 400, "TODO_PRIORITY_INVALID");
  return priority;
}

function prepareTodoPriority(content, action) {
  const id = normalizeText(action.id, MAX_TASK_LENGTH, true);
  const { lines, candidate } = uniqueTaskCandidate(content, { ...action, id });
  if (candidate.task.done !== Boolean(action.expectedDone)) {
    throw new WorkbenchWriteError("待办完成状态已被外部修改，请刷新后重试", 409, "TODO_CHANGED");
  }
  const expectedPriority = normalizePriority(action.expectedPriority, "预期等级");
  const currentPriority = parseTaskPriority(candidate.task.text);
  if (currentPriority !== expectedPriority) {
    throw new WorkbenchWriteError("待办等级已被外部修改，请刷新后重试", 409, "TODO_CHANGED");
  }
  const priority = normalizePriority(action.priority, "待办等级");
  const before = lines[candidate.index];
  const nextText = replaceTaskPriority(candidate.match[4], priority);
  const after = `${candidate.match[1]}${candidate.match[2]}${candidate.match[3]}${nextText}`;
  lines[candidate.index] = after;
  return {
    content: lines.join("\n"),
    before,
    after,
    summary: priority ? `设为 ${priority} 级` : "恢复默认 C 级",
  };
}

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function prepareProductFeatureAcceptance(content, action, featureName) {
  if (action.expectedStatus !== "等待验收") throw new WorkbenchWriteError("只能验收等待验收的功能", 409, "FEATURE_STATUS_CHANGED");
  const id = normalizeText(action.featureId, 120, true).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new WorkbenchWriteError("功能 ID 格式不对", 400, "FEATURE_ID_INVALID");
  const lines = content.split(/\r?\n/u);
  const idPattern = new RegExp(`\\|\\s*${escapedRegExp(id)}\\s*\\|\\s*$`, "iu");
  const candidates = lines.map((line, index) => ({ line, index })).filter(({ line }) => idPattern.test(line));
  if (candidates.length !== 1) throw new WorkbenchWriteError(candidates.length ? "功能 ID 重复，请先修正功能原件" : "功能原件已变化，请刷新后重试", 409, "FEATURE_CHANGED");
  const candidate = candidates[0];
  const statusCells = candidate.line.match(/\|\s*等待验收\s*(?=\|)/gu) || [];
  if (statusCells.length !== 1) throw new WorkbenchWriteError("功能状态已被外部修改，请刷新后重试", 409, "FEATURE_STATUS_CHANGED");
  const after = candidate.line.replace(/\|\s*等待验收\s*(?=\|)/u, "| 稳定 ");
  lines[candidate.index] = after;
  return { content: lines.join("\n"), before: `${featureName} · 等待验收`, after: `${featureName} · 稳定`, summary: `验收功能“${featureName}”` };
}

function prepareProjectTodoAdd(content, action, project, text) {
  const heading = action.section === "next" ? "下一步" : "正在做";
  const parsed = parseTaskLine(`- [ ] ${text}`, {
    sourcePath: project.managementPath,
    sourceKind: "project",
    projectId: project.projectId,
    projectName: project.name,
    section: heading === "下一步" ? "next" : "doing",
  });
  if (!parsed || parsed.idKind !== "explicit") throw new WorkbenchWriteError("项目待办必须带全局唯一 ID", 400, "TASK_ID_REQUIRED");
  const duplicate = findTaskLine(content, { sourcePath: project.managementPath, projectId: project.projectId, id: parsed.id }).candidates;
  if (duplicate.length) throw new WorkbenchWriteError(`任务 ID“${parsed.id}”已存在`, 409, "DUPLICATE_TASK_ID");
  const lines = content.split(/\r?\n/u);
  const bounds = sectionBounds(lines, heading);
  const after = `- [ ] ${text}`;
  insertAtSectionEnd(lines, bounds, after);
  return { content: lines.join("\n"), before: `“${heading}”区块末尾`, after, summary: "新增项目待办" };
}

function tokyoParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

function prepareJournal(content, action, now) {
  const text = normalizeText(action.text, MAX_NOTE_LENGTH, false);
  const { day, time } = tokyoParts(now);
  const indented = text.split("\n").map((line, index) => index ? `  ${line}` : line).join("\n");
  const entry = `- **${time}** ${indented}`;
  let base = content;
  if (!base.trim()) {
    base = `---\ndescription: ${day} 的日常记录\ndate: ${day}\ntags: [日志, 日记]\n---\n\n# ${day}\n`;
  }
  const lines = base.replace(/\s+$/, "").split(/\r?\n/);
  const heading = "工作台快速记录";
  const existing = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (existing < 0) {
    lines.push("", `## ${heading}`, "", entry);
  } else {
    insertAtSectionEnd(lines, sectionBounds(lines, heading), entry);
  }
  return { content: `${lines.join("\n")}\n`, before: `${diaryPathForDay(day)} · “${heading}”`, after: entry, summary: "记录到当天日志", day };
}

async function atomicWrite(absolute, content, mode) {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.infans-${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    if (mode) await fs.chmod(temporary, mode);
    await fs.rename(temporary, absolute);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createWriteService(vaultRoot, options = {}) {
  const root = path.resolve(vaultRoot);
  const pending = new Map();
  const clock = options.now || (() => new Date());
  const taskIdFactory = options.taskIdFactory || ((projectId) => `${projectId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`);

  async function preview(action) {
    const now = clock();
    let targetPath;
    let mutation;
    if (action?.kind === "toggleTodo" || action?.kind === "setTodoPriority") {
      const target = await resolveTodoTarget(root, action);
      targetPath = target.targetPath;
      const original = await readOptional(await resolveWritableVaultPath(root, targetPath));
      if (!original.exists) throw new WorkbenchWriteError("找不到待办原文件", 409, "SOURCE_MISSING");
      const usesStableId = typeof action.id === "string" && action.id.trim();
      if (action.kind === "setTodoPriority" && !usesStableId) throw new WorkbenchWriteError("待办 ID 不能为空", 400, "TASK_ID_REQUIRED");
      mutation = action.kind === "setTodoPriority"
        ? prepareTodoPriority(original.content, action)
        : (usesStableId ? prepareSourcedTodoToggle(original.content, action, now, Boolean(target.project)) : prepareTodoToggle(original.content, action));
      return register(targetPath, original, mutation, action.kind, now, target.targetLabel);
    }
    if (action?.kind === "addTodo") {
      let targetLabel = "中央待办";
      let project = null;
      if (action.scope === "project") {
        project = await resolveRegisteredProject(root, action.projectId);
        if (!project) throw new WorkbenchWriteError("项目未登记或尚未迁移，不能从页面写入", 403, "PROJECT_NOT_REGISTERED");
        targetPath = project.managementPath;
        targetLabel = `${project.name} · 项目进度与待办`;
      } else targetPath = SOURCES.todo;
      const original = await readOptional(await resolveWritableVaultPath(root, targetPath));
      if (!original.exists) throw new WorkbenchWriteError("找不到待办原文件", 409, "SOURCE_MISSING");
      if (project) {
        let text = normalizeText(action.text, MAX_TASK_LENGTH, true);
        let parsed = parseTaskLine(`- [ ] ${text}`, { sourcePath: project.managementPath, sourceKind: "project", projectId: project.projectId });
        if (!parsed || parsed.idKind !== "explicit") {
          const generatedId = normalizeText(taskIdFactory(project.projectId), 100, true);
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(generatedId)) throw new WorkbenchWriteError("服务端生成的任务 ID 格式不对", 500, "TASK_ID_INVALID");
          text = `${text}｜ID：${generatedId}`;
          parsed = parseTaskLine(`- [ ] ${text}`, { sourcePath: project.managementPath, sourceKind: "project", projectId: project.projectId });
        }
        if (!parsed || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parsed.id)) throw new WorkbenchWriteError("任务 ID 格式不对", 400, "TASK_ID_INVALID");
        if ((await findGlobalTaskOccurrences(root, parsed.id)).length) throw new WorkbenchWriteError(`任务 ID“${parsed.id}”已在其他来源使用`, 409, "DUPLICATE_TASK_ID");
        mutation = prepareProjectTodoAdd(original.content, action, project, text);
      } else mutation = prepareTodoAdd(original.content, action);
      return register(targetPath, original, mutation, action.kind, now, targetLabel);
    }
    if (action?.kind === "acceptProductFeature") {
      const projectId = normalizeText(action.projectId, 120, true).toLowerCase();
      const moduleId = normalizeText(action.moduleId, 120, true).toLowerCase();
      const featureId = normalizeText(action.featureId, 120, true).toLowerCase();
      const sourcePath = assertEditablePath(action.sourcePath);
      const snapshot = await readProjectManagement(root);
      const project = snapshot.projects.find((item) => item.projectId === projectId && !item.archived);
      const module = project?.featureTree?.modules.find((item) => item.id === moduleId && item.sourcePath === sourcePath);
      const feature = module?.features.find((item) => item.id === featureId);
      if (!project || !module || !feature) throw new WorkbenchWriteError("该功能不在项目正式功能树中，请刷新后重试", 403, "FEATURE_SOURCE_FORBIDDEN");
      if (feature.status !== action.expectedStatus) throw new WorkbenchWriteError("功能状态已变化，请刷新后重试", 409, "FEATURE_STATUS_CHANGED");
      targetPath = sourcePath;
      const original = await readOptional(await resolveWritableVaultPath(root, targetPath));
      if (!original.exists) throw new WorkbenchWriteError("找不到功能原件", 409, "SOURCE_MISSING");
      mutation = prepareProductFeatureAcceptance(original.content, { ...action, featureId }, feature.name);
      return register(targetPath, original, mutation, action.kind, now, `${project.name} · ${module.name}`);
    }
    if (action?.kind === "journal") {
      const { day } = tokyoParts(now);
      targetPath = diaryPathForDay(day);
      const original = await readOptional(await resolveWritableVaultPath(root, targetPath));
      mutation = prepareJournal(original.content, action, now);
      return register(targetPath, original, mutation, action.kind, now);
    }
    if (action?.kind === "updateRenewalDecision") {
      const id = normalizeText(action.id, 160, true);
      const snapshot = await readRenewalExpiry(root);
      if (!snapshot.items.some((item) => item.id === id)) {
        throw new WorkbenchWriteError("该项目不在支付与续约确认单中，请刷新后重试", 409, "RENEWAL_ITEM_MISSING");
      }
      targetPath = RENEWAL_EXPIRY_SOURCE;
      const original = await readOptional(await resolveWritableVaultPath(root, targetPath));
      if (!original.exists) throw new WorkbenchWriteError("找不到支付与续约授权原件", 409, "SOURCE_MISSING");
      mutation = prepareRenewalDecisionUpdate(original.content, { ...action, id }, now);
      return register(targetPath, original, mutation, action.kind, now, "支付与续约确认单");
    }
    if (action?.kind === "editFile") {
      targetPath = assertEditablePath(action.path);
      const original = await readOptional(await resolveWritableVaultPath(root, targetPath));
      mutation = prepareEditFile(original.content, { ...action, path: targetPath });
      return register(targetPath, original, mutation, action.kind, now);
    }
    throw new WorkbenchWriteError("写入类型不受支持");
  }

  function register(targetPath, original, mutation, kind, now, targetLabel = targetPath) {
    const token = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS).toISOString();
    pending.set(token, {
      targetPath,
      absolute: original.absolute,
      originalHash: original.hash,
      originalExists: original.exists,
      mode: original.mode,
      content: mutation.content,
      expiresAt: now.getTime() + PREVIEW_TTL_MS,
    });
    const hidesProjectMetadata = targetPath !== SOURCES.todo && ["toggleTodo", "setTodoPriority", "addTodo"].includes(kind);
    return {
      token,
      kind,
      targetPath,
      targetLabel,
      summary: mutation.summary,
      before: hidesProjectMetadata ? hideTaskMetadata(mutation.before) : mutation.before,
      after: hidesProjectMetadata ? hideTaskMetadata(mutation.after) : mutation.after,
      expiresAt,
      requiresConfirm: isCodePath(targetPath),
    };
  }

  async function commit(token) {
    if (typeof token !== "string" || !token) throw new WorkbenchWriteError("预览凭证丢了");
    const write = pending.get(token);
    pending.delete(token);
    if (!write) throw new WorkbenchWriteError("预览已失效，请重新生成", 409, "PREVIEW_EXPIRED");
    if (write.expiresAt < clock().getTime()) throw new WorkbenchWriteError("预览已过期，请重新生成", 409, "PREVIEW_EXPIRED");
    await withVaultFileWrite(root, write.targetPath, async (absolute) => {
      if (absolute !== write.absolute) {
        throw new WorkbenchWriteError("写入目标已变化，请重新生成预览", 409, "WRITE_PATH_CHANGED");
      }
      const current = await readOptional(absolute);
      if (current.exists !== write.originalExists || current.hash !== write.originalHash) {
        throw new WorkbenchWriteError("源文件已被 Obsidian 或其他工具修改，本次写入已停止", 409, "WRITE_CONFLICT");
      }
      await atomicWrite(absolute, write.content, write.mode);
    });
    invalidateVaultScanCache();
    return { ok: true, targetPath: write.targetPath };
  }

  return { preview, commit };
}
