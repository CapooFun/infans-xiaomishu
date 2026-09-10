import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_TASK_FOLLOWS_PATH } from "./vault-paths.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";

const MAX_TASK_KEYS = 500;
const TASK_KEY_RE = /^[a-z0-9][a-z0-9-]{0,79}:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;

function emptyFollows() {
  return { taskKeys: [] };
}

export function projectTaskFollowKey(projectId, taskId) {
  const key = `${String(projectId || "").trim()}:${String(taskId || "").trim()}`;
  return TASK_KEY_RE.test(key) ? key : null;
}

export function normalizeProjectTaskFollowKeys(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const keys = [];
  for (const value of raw) {
    const key = String(value || "").trim();
    if (!TASK_KEY_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= MAX_TASK_KEYS) break;
  }
  return keys;
}

export function projectTaskFollowsPath(vaultRoot) {
  return path.resolve(vaultRoot, PROJECT_TASK_FOLLOWS_PATH);
}

async function writeFollowsFile(absolute, payload) {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.infans-tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, absolute);
    await fs.chmod(absolute, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readFollowsFrom(absolute) {
  try {
    const text = await fs.readFile(absolute, "utf8");
    return { taskKeys: normalizeProjectTaskFollowKeys(JSON.parse(text)?.taskKeys) };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyFollows();
    throw error;
  }
}

export async function readProjectTaskFollows(vaultRoot) {
  return readFollowsFrom(projectTaskFollowsPath(vaultRoot));
}

/** 关注仅保存稳定任务键；任务标题、日期和状态继续实时读取项目原件。 */
export async function writeProjectTaskFollow(vaultRoot, payload = {}) {
  const taskKey = String(payload.taskKey || "").trim();
  if (!TASK_KEY_RE.test(taskKey)) throw new WorkbenchWriteError("这个项目待办没有可关注的稳定编号", 400, "INVALID_PROJECT_TASK_FOLLOW_KEY");
  if (typeof payload.followed !== "boolean") throw new WorkbenchWriteError("关注状态不正确", 400, "INVALID_PROJECT_TASK_FOLLOW_STATE");
  return withVaultFileWrite(vaultRoot, PROJECT_TASK_FOLLOWS_PATH, async (absolute) => {
    const current = await readFollowsFrom(absolute);
    const keys = new Set(current.taskKeys);
    if (payload.followed) keys.add(taskKey);
    else keys.delete(taskKey);
    const next = { taskKeys: normalizeProjectTaskFollowKeys([...keys]) };
    await writeFollowsFile(absolute, next);
    return next;
  });
}

export function followableProjectTaskKeys(snapshot) {
  const keys = new Set();
  for (const project of snapshot?.projects ?? []) {
    if (project.archived || !project.projectId || !project.management) continue;
    for (const task of [...project.management.doing, ...project.management.next]) {
      if (task.done || task.idKind !== "explicit" || !task.writable) continue;
      const key = projectTaskFollowKey(project.projectId, task.id);
      if (key) keys.add(key);
    }
  }
  return keys;
}
