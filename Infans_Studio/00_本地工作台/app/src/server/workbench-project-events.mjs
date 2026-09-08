import crypto from "node:crypto";
import { WorkbenchWriteError } from "./workbench-errors.mjs";

const PROJECT_EVENT_TYPES = new Set(["started", "completed", "blocked", "resumed"]);

function stableVariant(key, variants) {
  const index = crypto.createHash("sha256").update(String(key)).digest()[0] % variants.length;
  return variants[index];
}

function validateId(value, pattern, message, code) {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) throw new WorkbenchWriteError(message, 400, code);
  return normalized;
}

function taskOccurrences(project, taskId) {
  const management = project?.management;
  if (!management) return [];
  return [
    ...(management.doing || []).map((task) => ({ task, section: "doing" })),
    ...(management.next || []).map((task) => ({ task, section: "next" })),
    ...(management.blocked || []).map((task) => ({ task, section: "blocked" })),
    ...(management.recentCompleted || []).map((task) => ({ task, section: "recent-completed" })),
  ].filter(({ task }) => task?.id === taskId);
}

function assertEventMatchesSource(eventType, occurrence) {
  const { task, section } = occurrence;
  if (eventType === "started" && (section !== "doing" || task.done)) {
    throw new WorkbenchWriteError("这个任务目前不在正在做，不能登记开始事件", 409, "PROJECT_EVENT_STATE_MISMATCH");
  }
  if (eventType === "completed" && section !== "recent-completed" && !task.done) {
    throw new WorkbenchWriteError("这个任务尚未完成，不能登记完成事件", 409, "PROJECT_EVENT_STATE_MISMATCH");
  }
  if (eventType === "blocked" && (section !== "blocked" || task.done)) {
    throw new WorkbenchWriteError("这个任务目前没有阻塞，不能登记阻塞事件", 409, "PROJECT_EVENT_STATE_MISMATCH");
  }
  if (eventType === "resumed" && (section !== "doing" || task.done)) {
    throw new WorkbenchWriteError("这个任务目前没有恢复到正在做，不能登记恢复事件", 409, "PROJECT_EVENT_STATE_MISMATCH");
  }
}

function eventText(eventType, task) {
  const rawTitle = String(task?.displayText || task?.text || "这项任务").trim().slice(0, 120);
  const title = rawTitle.replace(/^AI·\s*/u, "") || "这项任务";
  const variantKey = `${task?.id || title}:${eventType}`;
  if (eventType === "completed") {
    if (task?.executorId && /^AI·/u.test(rawTitle)) {
      return stableVariant(variantKey, [
        `「${title}」我处理得不错对不对？快夸我快夸我～`,
        `哼，「${title}」搞定啦，军功章也有我一半哦！`,
        `「${title}」我可是认真记下来了，不许忘记我的功劳！`,
        `看吧，「${title}」搞定以后，是不是感觉心里踏实多啦？`,
      ]);
    }
    return stableVariant(variantKey, [
      `芜湖！「${title}」终于被啃下来啦！先让我替你得意十秒钟～`,
      `辛苦啦！「${title}」搞定，我先替你记在小功劳簿上！`,
    ]);
  }
  if (eventType === "blocked") return stableVariant(variantKey, [
    `「${title}」好像有点凶？没事的，咱们先歇口气吃点好吃的，回头再收拾它！`,
    `「${title}」卡住了也不许叹气，我先陪你把战线守住，等缓过来咱们再推！`,
  ]);
  if (eventType === "resumed") return `好耶，「${title}」又动起来了！我已经搬好小板凳，准备围观你大显身手啦！`;
  return `「${title}」开始推进了。我会沿着这条项目线陪你继续往下走。`;
}

/**
 * 项目事件只保留稳定来源引用；标题只用于生成当次陪伴文案，任务事实仍以项目原件为准。
 */
export function projectTaskEventCandidate(snapshot, input = {}, now = new Date()) {
  const projectId = validateId(input.projectId, /^[a-z0-9][a-z0-9-]{0,127}$/u, "项目编号不合法", "PROJECT_EVENT_PROJECT_INVALID");
  const taskId = validateId(input.taskId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u, "任务编号不合法", "PROJECT_EVENT_TASK_INVALID");
  const eventType = String(input.eventType || "").trim();
  if (!PROJECT_EVENT_TYPES.has(eventType)) throw new WorkbenchWriteError("项目事件类型不合法", 400, "PROJECT_EVENT_TYPE_INVALID");
  const projectMatches = (snapshot?.projects || []).filter((project) => project.projectId === projectId && !project.archived);
  if (projectMatches.length !== 1) throw new WorkbenchWriteError("找不到唯一的项目原件", 404, "PROJECT_EVENT_PROJECT_NOT_FOUND");
  const matches = taskOccurrences(projectMatches[0], taskId);
  if (matches.length !== 1) throw new WorkbenchWriteError("找不到唯一的稳定任务原件", 404, "PROJECT_EVENT_TASK_NOT_FOUND");
  assertEventMatchesSource(eventType, matches[0]);
  const plannedAt = now.toISOString();
  return {
    kind: "event",
    triggerRef: `project-task:${projectId}:${taskId}:${eventType}`,
    topicKey: `project-task:${taskId}:${eventType}`,
    plannedAt,
    expiresAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(),
    delivery: "ambient",
    text: eventText(eventType, matches[0].task),
    source: { kind: "project-task", projectId, taskId, eventType },
  };
}

export function createProjectEventService(options = {}) {
  if (typeof options.readProjectManagement !== "function" || typeof options.planInteraction !== "function") {
    throw new TypeError("project event service requires project reader and interaction planner");
  }
  return {
    async plan(input, now = new Date()) {
      const snapshot = await options.readProjectManagement(now);
      const candidate = projectTaskEventCandidate(snapshot, input, now);
      return options.planInteraction(candidate, now);
    },
  };
}
