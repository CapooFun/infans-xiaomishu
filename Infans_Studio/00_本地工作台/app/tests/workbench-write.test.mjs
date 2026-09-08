import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWriteService, isCodePath } from "../src/server/workbench-write.mjs";

const FIXED_NOW = new Date("2026-07-31T14:30:00.000Z");
const TODO_PATH = "待办事项与长期规划.md";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-write-"));
  await fs.writeFile(path.join(root, TODO_PATH), `---\ndescription: test\ntags: [待办]\n---\n# 待办事项与长期规划\n\n## 今天 / 本周\n\n- [ ] **完成工作台**\n- [x] 已核对方案\n\n## 当前主线\n\n| 优先级 | 事项 |\n|---|---|\n| 旗舰 | 游戏 |\n\n## 长期在推\n\n- [ ] 学日语\n`, "utf8");
  return root;
}

const PROJECT_PATH = "30_事业顺利/示例卡牌游戏/项目进度与待办.md";

async function projectFixture() {
  const root = await fixture();
  await fs.mkdir(path.dirname(path.join(root, PROJECT_PATH)), { recursive: true });
  await fs.mkdir(path.join(root, "30_事业顺利"), { recursive: true });
  await fs.writeFile(path.join(root, "30_事业顺利/事业顺利_总览.md"), `# 事业顺利\n\n## 当前重点\n\n| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |\n|---|---|---|---|---|\n| 示例卡牌游戏 | 打磨中 | [[示例卡牌游戏_总览]] | nointerest | [[${PROJECT_PATH.slice(0, -3)}|项目进度与待办]] |\n\n## 归档\n\n| 项目 | 状态 | 入口 | 项目 ID | 进度与待办 |\n|---|---|---|---|---|\n`);
  await fs.writeFile(path.join(root, PROJECT_PATH), `# 示例卡牌游戏\n\n## 当前状态\n\n打磨中。\n\n## 正在做\n\n- [ ] 游戏：细节：8/22 · 验证发行｜ID：nointerest-release\n\n## 下一步\n\n- [x] 游戏：节点：B：已完成任务｜ID：nointerest-done\n\n## 阻塞\n\n- 无\n\n## 最近完成\n\n- 无\n\n## 权威入口\n\n- 项目总览：[[示例卡牌游戏_总览]]\n`);
  return root;
}

test("todo toggle previews first and changes only the target line after commit", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writes = createWriteService(root, { now: () => FIXED_NOW });
  const before = await fs.readFile(path.join(root, TODO_PATH), "utf8");
  const preview = await writes.preview({ kind: "toggleTodo", scope: "today", text: "完成工作台", expectedDone: false });
  assert.equal(preview.before, "- [ ] **完成工作台**");
  assert.equal(preview.after, "- [x] **完成工作台**");
  assert.equal(await fs.readFile(path.join(root, TODO_PATH), "utf8"), before);
  await writes.commit(preview.token);
  const after = await fs.readFile(path.join(root, TODO_PATH), "utf8");
  assert.equal(after.includes("- [x] **完成工作台**"), true);
  assert.equal(after.includes("- [x] 已核对方案"), true);
});

test("new todo goes to the selected section", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writes = createWriteService(root, { now: () => FIXED_NOW });
  const preview = await writes.preview({ kind: "addTodo", scope: "longTerm", text: "整理艺术馆藏" });
  assert.equal(preview.after, "- [ ] 整理艺术馆藏");
  await writes.commit(preview.token);
  const content = await fs.readFile(path.join(root, TODO_PATH), "utf8");
  const longTerm = content.slice(content.indexOf("## 长期在推"));
  assert.equal(longTerm.includes("- [ ] 整理艺术馆藏"), true);
});

test("external edits stop a pending write", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writes = createWriteService(root, { now: () => FIXED_NOW });
  const preview = await writes.preview({ kind: "addTodo", scope: "today", text: "不会被写入" });
  await fs.appendFile(path.join(root, TODO_PATH), "\n外部修改\n", "utf8");
  await assert.rejects(() => writes.commit(preview.token), (error) => error.code === "WRITE_CONFLICT");
  const content = await fs.readFile(path.join(root, TODO_PATH), "utf8");
  assert.equal(content.includes("不会被写入"), false);
  assert.equal(content.includes("外部修改"), true);
});

test("quick capture creates a compliant daily note after confirmation", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writes = createWriteService(root, { now: () => FIXED_NOW });
  const preview = await writes.preview({ kind: "journal", text: "完成了工作台受控写入。" });
  assert.equal(preview.targetPath, "10_日志记录/工作日志/2026-07-31.md");
  assert.equal(preview.requiresConfirm, false);
  await assert.rejects(() => fs.readFile(path.join(root, preview.targetPath), "utf8"), /ENOENT/);
  await writes.commit(preview.token);
  const content = await fs.readFile(path.join(root, preview.targetPath), "utf8");
  assert.match(content, /^---\ndescription: 2026-07-31 的日常记录\ndate: 2026-07-31\ntags: \[日志, 日记\]\n---/);
  assert.equal(content.includes("## 工作台快速记录"), true);
  assert.equal(content.includes("- **23:30** 完成了工作台受控写入。"), true);
});

test("editFile replaces unique snippet and flags code paths", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const note = "10_日志记录/工作日志/note.md";
  const code = "00_本地工作台/app/src/hello.ts";
  await fs.mkdir(path.dirname(path.join(root, note)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(root, code)), { recursive: true });
  await fs.writeFile(path.join(root, note), "alpha\nbeta\n", "utf8");
  await fs.writeFile(path.join(root, code), "const x = 1;\n", "utf8");
  const writes = createWriteService(root, { now: () => FIXED_NOW });

  const notePreview = await writes.preview({ kind: "editFile", path: note, oldText: "beta", newText: "gamma" });
  assert.equal(notePreview.requiresConfirm, false);
  await writes.commit(notePreview.token);
  assert.equal(await fs.readFile(path.join(root, note), "utf8"), "alpha\ngamma\n");

  const codePreview = await writes.preview({ kind: "editFile", path: code, oldText: "1", newText: "2" });
  assert.equal(codePreview.requiresConfirm, true);
  assert.equal(isCodePath(code), true);
  await writes.commit(codePreview.token);
  assert.equal(await fs.readFile(path.join(root, code), "utf8"), "const x = 2;\n");

  await assert.rejects(
    () => writes.preview({ kind: "editFile", path: "node_modules/x.js", content: "no" }),
    (error) => error.code === "PATH_FORBIDDEN",
  );
});

test("项目任务 SABC 可设置、切换、再点取消，并且预览显示真实目标", async (t) => {
  const root = await projectFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writes = createWriteService(root, { now: () => FIXED_NOW });
  const base = { kind: "setTodoPriority", sourcePath: PROJECT_PATH, id: "nointerest-release", expectedDone: false };

  const setA = await writes.preview({ ...base, expectedPriority: null, priority: "A" });
  assert.equal(setA.targetLabel, "示例卡牌游戏 · 项目进度与待办");
  assert.match(setA.after, /细节：A：8\/22/u);
  await writes.commit(setA.token);

  const switchC = await writes.preview({ ...base, expectedPriority: "A", priority: "C" });
  await writes.commit(switchC.token);
  assert.match(await fs.readFile(path.join(root, PROJECT_PATH), "utf8"), /细节：C：8\/22/u);

  const clear = await writes.preview({ ...base, expectedPriority: "C", priority: null });
  await writes.commit(clear.token);
  assert.match(await fs.readFile(path.join(root, PROJECT_PATH), "utf8"), /细节：8\/22/u);
});

test("功能关联任务完成时同步收束到 Wiki，恢复时撤回完成记录并保留 SABC", async (t) => {
  const root = await projectFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, PROJECT_PATH);
  const originalProject = await fs.readFile(projectPath, "utf8");
  await fs.writeFile(projectPath, originalProject.replace("｜ID：nointerest-done", "｜ID：nointerest-done｜功能：release-feedback"), "utf8");
  const writes = createWriteService(root, { now: () => FIXED_NOW });
  const restore = await writes.preview({ kind: "toggleTodo", sourcePath: PROJECT_PATH, id: "nointerest-done", expectedDone: true });
  assert.match(restore.after, /^- \[ \].*：B：/u);
  await writes.commit(restore.token);
  const complete = await writes.preview({ kind: "toggleTodo", sourcePath: PROJECT_PATH, id: "nointerest-done", expectedDone: false });
  assert.match(complete.after, /^- \[x\].*：B：/u);
  assert.match(complete.after, /｜完成时间：2026-07-31T14:30:00\.000Z$/u);
  await writes.commit(complete.token);
  const completedContent = await fs.readFile(projectPath, "utf8");
  assert.match(completedContent, /## 最近完成\n\n- 2026-07-31 · 已完成任务｜ID：nointerest-done/u);
  const restoreAgain = await writes.preview({ kind: "toggleTodo", sourcePath: PROJECT_PATH, id: "nointerest-done", expectedDone: true });
  assert.doesNotMatch(restoreAgain.after, /完成时间/u);
  await writes.commit(restoreAgain.token);
  const restoredContent = await fs.readFile(projectPath, "utf8");
  assert.doesNotMatch(restoredContent, /最近完成[\s\S]*ID：nointerest-done/u);
  assert.match(restoredContent, /## 最近完成\n\n- 无/u);
});

test("新增项目任务由服务端选路径并自动生成 ID，浏览器不能伪造路径", async (t) => {
  const root = await projectFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writes = createWriteService(root, { now: () => FIXED_NOW, taskIdFactory: () => "nointerest-generated" });
  const preview = await writes.preview({ kind: "addTodo", scope: "project", projectId: "nointerest", text: "补齐发行页截图" });
  assert.equal(preview.targetPath, PROJECT_PATH);
  assert.equal(preview.targetLabel, "示例卡牌游戏 · 项目进度与待办");
  assert.equal(preview.after, "- [ ] 补齐发行页截图");
  assert.equal(preview.after.includes("ID"), false);
  await writes.commit(preview.token);
  assert.match(await fs.readFile(path.join(root, PROJECT_PATH), "utf8"), /补齐发行页截图｜ID：nointerest-generated/u);

  await assert.rejects(
    () => writes.preview({ kind: "setTodoPriority", sourcePath: "30_事业顺利/伪造/项目进度与待办.md", id: "x", expectedDone: false, expectedPriority: null, priority: "A" }),
    (error) => error.code === "TODO_SOURCE_FORBIDDEN",
  );
});

test("新增项目任务会跨中央待办与所有已注册项目检查全局 ID", async (t) => {
  const root = await projectFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.appendFile(path.join(root, TODO_PATH), "\n- [ ] 中央重复｜ID：global-duplicate\n");
  const writes = createWriteService(root, { now: () => FIXED_NOW });
  await assert.rejects(
    () => writes.preview({ kind: "addTodo", scope: "project", projectId: "nointerest", text: "不应写入｜ID：global-duplicate" }),
    (error) => error.code === "DUPLICATE_TASK_ID",
  );
  assert.equal((await fs.readFile(path.join(root, PROJECT_PATH), "utf8")).includes("不应写入"), false);
});

test("项目写回仍保留预览后外部修改冲突保护", async (t) => {
  const root = await projectFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writes = createWriteService(root, { now: () => FIXED_NOW });
  const preview = await writes.preview({ kind: "setTodoPriority", sourcePath: PROJECT_PATH, id: "nointerest-release", expectedDone: false, expectedPriority: null, priority: "S" });
  await fs.appendFile(path.join(root, PROJECT_PATH), "\n外部窗口修改\n");
  await assert.rejects(() => writes.commit(preview.token), (error) => error.code === "WRITE_CONFLICT");
  assert.equal((await fs.readFile(path.join(root, PROJECT_PATH), "utf8")).includes("细节：S：8/22"), false);
});

test("产品功能只在正式功能树中按稳定 ID 从等待验收改为稳定", async (t) => {
  const root = await projectFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = "30_事业顺利/示例卡牌游戏/产品功能树.md";
  const modulePath = "30_事业顺利/示例卡牌游戏/发行模块.md";
  await fs.mkdir(path.join(root, path.dirname(modulePath)), { recursive: true });
  await fs.appendFile(path.join(root, PROJECT_PATH), `\n- 产品功能树：[[${indexPath.slice(0, -3)}]]\n`);
  await fs.writeFile(path.join(root, indexPath), `# 示例卡牌游戏产品功能树\n\n| 模块 | 说明 | 原件 | ID |\n|---|---|---|---|\n| 发行 | 对外发行 | [[${modulePath.slice(0, -3)}]] | release |\n`);
  await fs.writeFile(path.join(root, modulePath), `## 发行｜ID：release\n\n| 小模块 | 状态 | 说明 | 功能点 | 当前进度 | 原件 | ID |\n|---|---|---|---|---|---|---|\n| 首轮发布 | 等待验收 | 发布前检查 | — | — | 本模块 | release-first |\n`);
  const writes = createWriteService(root, { now: () => FIXED_NOW });
  const action = { kind: "acceptProductFeature", projectId: "nointerest", moduleId: "release", featureId: "release-first", sourcePath: modulePath, expectedStatus: "等待验收" };
  const preview = await writes.preview(action);
  assert.equal(preview.before, "首轮发布 · 等待验收");
  assert.equal(preview.after, "首轮发布 · 稳定");
  await writes.commit(preview.token);
  assert.match(await fs.readFile(path.join(root, modulePath), "utf8"), /\| 首轮发布 \| 稳定 \|/u);
  await assert.rejects(() => writes.preview(action), (error) => error.code === "FEATURE_STATUS_CHANGED");
});

for (const separateInstances of [false, true]) {
  test(`independent previews cannot both replace the same original (${separateInstances ? "multiple instances" : "one instance"})`, async (t) => {
    const root = await fixture();
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, "note.md");
    await fs.writeFile(target, "alpha\nbeta\n");
    const firstService = createWriteService(root);
    const secondService = separateInstances ? createWriteService(root) : firstService;
    const first = await firstService.preview({ kind: "editFile", path: "note.md", oldText: "alpha", newText: "ALPHA" });
    const second = await secondService.preview({ kind: "editFile", path: "note.md", oldText: "beta", newText: "BETA" });
    const results = await Promise.allSettled([firstService.commit(first.token), secondService.commit(second.token)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "WRITE_CONFLICT");
    const content = await fs.readFile(target, "utf8");
    assert.ok(content === "ALPHA\nbeta\n" || content === "alpha\nBETA\n");
  });
}

test("concurrent reuse of one token performs at most one write", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createWriteService(root);
  const preview = await service.preview({ kind: "editFile", path: "new.md", content: "once" });
  const results = await Promise.allSettled([service.commit(preview.token), service.commit(preview.token)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "PREVIEW_EXPIRED");
});

test("editFile rejects parent links including aliases of protected originals", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "infans-write-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "note.md"), "outside original");
  await fs.symlink(outside, path.join(root, "linked"), "dir");
  const protectedDir = path.join(root, "00_本地工作台/本人草稿");
  await fs.mkdir(protectedDir, { recursive: true });
  await fs.writeFile(path.join(protectedDir, "fixture.md"), "protected original");
  await fs.symlink(protectedDir, path.join(root, "alias"), "dir");
  const service = createWriteService(root);
  for (const target of ["linked/note.md", "alias/fixture.md"]) {
    await assert.rejects(service.preview({ kind: "editFile", path: target, content: "changed" }), { code: "PATH_SYMLINK_FORBIDDEN" });
  }
  assert.equal(await fs.readFile(path.join(outside, "note.md"), "utf8"), "outside original");
  assert.equal(await fs.readFile(path.join(protectedDir, "fixture.md"), "utf8"), "protected original");
});

test("commit rechecks parents replaced with a link after preview", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "original"));
  await fs.writeFile(path.join(root, "original/note.md"), "before");
  const service = createWriteService(root);
  const preview = await service.preview({ kind: "editFile", path: "original/note.md", content: "after" });
  await fs.rename(path.join(root, "original"), path.join(root, "moved"));
  await fs.symlink(path.join(root, "moved"), path.join(root, "original"), "dir");
  await assert.rejects(service.commit(preview.token), { code: "PATH_SYMLINK_FORBIDDEN" });
  assert.equal(await fs.readFile(path.join(root, "moved/note.md"), "utf8"), "before");
});

test("case aliases on a case-insensitive volume cannot bypass the shared queue", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "CaseNote.md"), "alpha\nbeta\n");
  try { await fs.access(path.join(root, "casenote.md")); }
  catch { t.skip("fixture volume is case-sensitive"); return; }
  const firstService = createWriteService(root);
  const secondService = createWriteService(root);
  const first = await firstService.preview({ kind: "editFile", path: "CaseNote.md", oldText: "alpha", newText: "ALPHA" });
  const second = await secondService.preview({ kind: "editFile", path: "casenote.md", oldText: "beta", newText: "BETA" });
  const results = await Promise.allSettled([firstService.commit(first.token), secondService.commit(second.token)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "WRITE_CONFLICT");
});

test("a root alias retargeted after preview cannot write an identical outside fixture", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "infans-write-root-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const firstRoot = path.join(directory, "first");
  const secondRoot = path.join(directory, "second");
  await fs.mkdir(firstRoot);
  await fs.mkdir(secondRoot);
  for (const root of [firstRoot, secondRoot]) await fs.writeFile(path.join(root, "note.md"), "same original");
  const alias = path.join(directory, "vault");
  await fs.symlink(firstRoot, alias, "dir");
  const service = createWriteService(alias);
  const preview = await service.preview({ kind: "editFile", path: "note.md", content: "changed" });
  await fs.unlink(alias);
  await fs.symlink(secondRoot, alias, "dir");
  await assert.rejects(service.commit(preview.token), { code: "WRITE_PATH_CHANGED" });
  assert.equal(await fs.readFile(path.join(secondRoot, "note.md"), "utf8"), "same original");
});
