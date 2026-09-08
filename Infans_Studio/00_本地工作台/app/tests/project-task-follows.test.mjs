import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAllProjectTodoGroups,
  projectTaskFollowKey as browserFollowKey,
  retainRecentlyCompletedProjectTodos,
} from "../src/project-task-follow-model.ts";
import {
  followableProjectTaskKeys,
  normalizeProjectTaskFollowKeys,
  projectTaskFollowsPath,
  readProjectTaskFollows,
  writeProjectTaskFollow,
} from "../src/server/workbench-project-task-follows.mjs";

test("关注状态缺失时只读返回空，不创建文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-project-follows-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readProjectTaskFollows(root), { taskKeys: [] });
  assert.equal(await fs.access(projectTaskFollowsPath(root)).then(() => true, () => false), false);
});

test("关注状态去重、有上限，并以 0600 原子文件持久化", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-project-follows-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeProjectTaskFollow(root, { taskKey: "game-a:task-1", followed: true });
  await writeProjectTaskFollow(root, { taskKey: "game-a:task-1", followed: true });
  await writeProjectTaskFollow(root, { taskKey: "game-b:task-2", followed: true });
  assert.deepEqual(await readProjectTaskFollows(root), { taskKeys: ["game-a:task-1", "game-b:task-2"] });
  assert.equal((await fs.stat(projectTaskFollowsPath(root))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(projectTaskFollowsPath(root)))).filter((name) => name.endsWith(".infans-tmp")), []);
  await writeProjectTaskFollow(root, { taskKey: "game-a:task-1", followed: false });
  assert.deepEqual(await readProjectTaskFollows(root), { taskKeys: ["game-b:task-2"] });
  assert.equal(normalizeProjectTaskFollowKeys([...Array.from({ length: 550 }, (_, index) => `game-a:t-${index}`)]).length, 500);
  await assert.rejects(() => writeProjectTaskFollow(root, { taskKey: "../bad", followed: true }), /稳定编号/u);
});

test("同一进程的并发关注不会互相覆盖", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-project-follows-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all([
    writeProjectTaskFollow(root, { taskKey: "game-a:task-a", followed: true }),
    writeProjectTaskFollow(root, { taskKey: "game-b:task-b", followed: true }),
  ]);
  assert.deepEqual(await readProjectTaskFollows(root), { taskKeys: ["game-a:task-a", "game-b:task-b"] });
});

test("全部待办按注册项目和原件区块顺序过滤，缺稳定 ID 只能展示", () => {
  const task = (id, section, extra = {}) => ({
    id,
    idKind: "explicit",
    writable: true,
    done: false,
    completedAt: null,
    text: id,
    displayText: id,
    section,
    priority: null,
    date: null,
    parentId: null,
    featureId: null,
    featureIds: [],
    dependencyIds: [],
    sourcePath: `30_事业顺利/${id}.md`,
    sourceKind: "project",
    projectId: null,
    projectName: null,
    ...extra,
  });
  const projects = [
    { projectId: "first", name: "第一项目", archived: false, management: { doing: [task("doing-1", "doing"), task("done", "doing", { done: true })], next: [task("derived", "next", { idKind: "derived", writable: false })] } },
    { projectId: "second", name: "第二项目", archived: false, management: { doing: [], next: [task("next-1", "next")] } },
    { projectId: "archived", name: "归档项目", archived: true, management: { doing: [task("hidden", "doing")], next: [] } },
  ];
  const groups = buildAllProjectTodoGroups({ projects, currentTodos: [], warnings: [] });
  assert.deepEqual(groups.map((group) => group.projectName), ["第一项目", "第二项目"]);
  assert.deepEqual(groups[0].tasks.map((item) => item.id), ["doing-1", "derived"]);
  assert.equal(groups[0].tasks[0].followKey, "first:doing-1");
  assert.equal(groups[0].tasks[1].followKey, null);
  assert.equal(browserFollowKey("first", "doing-1"), "first:doing-1");
  assert.deepEqual([...followableProjectTaskKeys({ projects })], ["first:doing-1", "second:next-1"]);
});

test("全部待办不会因一条任务关联多个功能而复制", () => {
  const task = {
    id: "multi-feature",
    idKind: "explicit",
    writable: true,
    done: false,
    completedAt: null,
    text: "复查指标",
    displayText: "复查指标",
    section: "next",
    priority: null,
    date: null,
    parentId: null,
    featureId: "health-mind",
    featureIds: ["health-mind", "health-life"],
    dependencyIds: [],
    sourcePath: "30_事业顺利/项目进度与待办.md",
    sourceKind: "project",
    projectId: "secretary",
    projectName: "小秘书",
  };
  const groups = buildAllProjectTodoGroups({
    projects: [{ projectId: "secretary", name: "小秘书", archived: false, management: { doing: [], next: [task] } }],
    currentTodos: [],
    warnings: [],
  });
  assert.equal(groups[0].tasks.filter((item) => item.id === task.id).length, 1);
});

test("全部待办按项目分组，小秘书在前，找不到项目的归入小秘书", () => {
  const task = (id, extra = {}) => ({
    id, idKind: "explicit", writable: true, done: false, completedAt: null,
    text: `公司：开发：${id}`, displayText: id, section: "doing", priority: null, date: null,
    parentId: null, featureId: null, featureIds: [], dependencyIds: [], sourcePath: `30_事业顺利/${id}.md`,
    sourceKind: "project", projectId: extra.projectId ?? null, projectName: extra.projectName ?? null, executorId: null,
    automationMode: "manual", automationContractStatus: "missing", automationIssueCodes: [], reviewAt: null,
    ...extra,
  });
  const groups = buildAllProjectTodoGroups({
    projects: [
      { projectId: "game-a", name: "游戏甲", archived: false, management: { doing: [task("game-task", { projectId: "game-a", projectName: "游戏甲" })], next: [] } },
      { projectId: "demo-secretary", name: "小秘书", archived: false, management: { doing: [task("secretary-task", { projectId: "demo-secretary", projectName: "小秘书" })], next: [] } },
      { projectId: null, name: "未登记", archived: false, management: { doing: [task("orphan-task")], next: [] } },
    ],
    currentTodos: [],
    warnings: [],
  });
  assert.deepEqual(groups.map((group) => group.projectName), ["小秘书", "游戏甲"]);
  assert.equal(groups[0].projectId, "demo-secretary");
  assert.deepEqual(groups[0].tasks.map((item) => item.id), ["secretary-task", "orphan-task"]);
  assert.equal(groups[0].tasks[1].followKey, null);
  assert.deepEqual(groups[1].tasks.map((item) => item.id), ["game-task"]);
});

test("全部待办在当前展开会话中保留刚完成任务，找不到原项目时归入小秘书", () => {
  const baseTask = {
    id: "task-1", idKind: "explicit", writable: true, done: false, completedAt: null,
    text: "任务一", displayText: "任务一", section: "next", priority: "A", date: null,
    parentId: null, featureId: null, featureIds: [], dependencyIds: [], sourcePath: "30_事业顺利/项目.md",
    sourceKind: "project", projectId: "project-a", projectName: "项目 A",
  };
  const retained = [{ projectId: "project-a", projectName: "项目 A", task: baseTask }];
  const completedOnly = retainRecentlyCompletedProjectTodos([], retained);
  assert.equal(completedOnly[0].projectName, "项目 A");
  assert.equal(completedOnly[0].tasks[0].done, true);
  assert.equal(completedOnly[0].tasks[0].recentlyCompleted, true);
  assert.equal(completedOnly[0].tasks[0].followKey, null);

  const visible = [{ projectId: "project-a", projectName: "项目 A", tasks: [{ ...baseTask, followKey: "project-a:task-1" }] }];
  const deduplicated = retainRecentlyCompletedProjectTodos(visible, retained);
  assert.equal(deduplicated[0].tasks.length, 1);
  assert.equal(deduplicated[0].tasks[0].done, false);

  const unknown = retainRecentlyCompletedProjectTodos([], [{ projectId: "", projectName: "", task: { ...baseTask, projectId: null, projectName: null } }]);
  assert.equal(unknown[0].projectName, "小秘书");
  assert.equal(unknown[0].tasks[0].recentlyCompleted, true);
});

test("日程页提供内联全部待办、可访问星标与自然文档流", async () => {
  const source = await fs.readFile(new URL("../src/pages/SchedulePage.tsx", import.meta.url), "utf8");
  const css = await fs.readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /全部待办/u);
  assert.match(source, /aria-controls="schedule-all-project-todos"/u);
  assert.match(source, /aria-pressed=\{followed\}/u);
  assert.match(source, /此待办暂未分配编号，暂时不能关注/u);
  assert.match(source, /\{group\.items\.map\(\(item\)/u);
  assert.doesNotMatch(source, /group\.items\.slice\(0,\s*3\)/u);
  assert.match(source, /focused && item\.writeTarget && !item\.done/u);
  assert.match(source, /schedule-todo-main-link/u);
  assert.match(source, /schedule-all-todo-text-link/u);
  assert.match(source, /schedule-all-todo-check/u);
  assert.match(source, /恢复未完成/u);
  assert.match(source, /setRecentlyCompletedProjectTodos\(\[\]\)/u);
  assert.match(source, /schedule-all-todo-priority-picker/u);
  assert.match(source, /schedule-all-todos-shell/u);
  assert.match(source, /schedule-all-todo-group/u);
  assert.match(source, /按项目分组/u);
  assert.match(source, /对不上项目的，归入小秘书/u);
  assert.match(source, /AI 储备 · 待排期/u);
  assert.doesNotMatch(source, /buildChronologicalProjectTodos/u);
  assert.doesNotMatch(source, /按时间先后/u);
  assert.doesNotMatch(source, /近期候选/u);
  assert.doesNotMatch(source, /task\.section === "doing"/u);
  assert.doesNotMatch(source, /task\.section === "下一步"/u);
  assert.match(source, /aria-label="显示隐藏的事项"/u);
  assert.match(source, /aria-label="回到今天"/u);
  assert.doesNotMatch(source, /localStorage/u);
  assert.match(css, /\.schedule-all-todos-shell\s*\{[\s\S]*?border:\s*1px solid var\(--line\);/u);
  assert.match(css, /\.schedule-follow-star\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/u);
  assert.match(css, /\.schedule-all-todos-trigger\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*color-mix\(in srgb, var\(--surface-2\)/u);
  assert.match(css, /\.schedule-all-todos-trigger\s*\{[\s\S]*?height:\s*48px;/u);
  assert.match(css, /\.schedule-all-todo-group\s*\{/u);
  const allTodosRule = css.match(/\.schedule-all-todos\s*\{[\s\S]*?\}/u)?.[0] || "";
  assert.match(allTodosRule, /overflow:\s*visible;/u);
  assert.doesNotMatch(allTodosRule, /max-height|overflow-y|scrollbar-gutter/u);
  assert.match(css, /\.schedule-quadrant\.is-focused \.schedule-todo-rows\s*\{[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;/u);
  assert.match(css, /\.schedule-quadrant\s*\{[\s\S]*?min-height:\s*160px;/u);
  assert.doesNotMatch(css, /schedule-all-todos-preview/u);
  assert.match(css, /\.gantt-corner-actions \.gantt-fold-all span,[\s\S]*?display:\s*none;/u);
});
