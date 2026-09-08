import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  diaryModeMcpPrompt,
  diaryModeReportWindow,
  parseDialogueLogHandoff,
  parseDiaryModePreferences,
  previewDialogueLogImport,
  readDiaryMode,
  renderDialogueLog,
  selectDiaryModeContext,
} from "../src/server/workbench-diary-mode.mjs";
import { DIALOGUE_DIARY_DIR, DIARY_MODE_PREFERENCES_PATH } from "../src/server/vault-paths.mjs";

const HANDOFF = `对话前的其他文字。
【INFANS 对话日志交接 v1】
记录ID：dialogue-20260828-a1b2
发生时间：2026-08-28T21:30:00+09:00
会话标题：项目与周末安排
一句话：聊了进度和接下来想休息的安排。

## 用户明确说过的事实
- 今天完成了一项聚焦工作。

## 用户明确表达的感受
- 觉得累，但对结果满意。

## 进展与变化
- 计划从“继续硬推”改为先休息。

## 仍想继续聊
- 周末怎样真正放松。

## 不确定或 AI 推断
- AI 推断：可能需要降低节奏，用户未明确确认。

## 长期聊天偏好候选
- 希望聊近况时先问一件事。

需要回看原对话：否
尚未写入 Vault：是
【记录结束】`;

test("聊天偏好只读取人工确认的非空项", () => {
  const preferences = parseDiaryModePreferences(`---\ntags: [test]\n---\n## 希望主动关心\n- 近期的睡眠\n## 不想反复被问\n- 旧工作\n## 适合的聊天方式\n- 每次一件事\n## 已否定或过期\n- 尚无。\n`);
  assert.deepEqual(preferences.careAbout, ["近期的睡眠"]);
  assert.deepEqual(preferences.avoid, ["旧工作"]);
  assert.deepEqual(preferences.style, ["每次一件事"]);
});

test("近期相关性会说明加减分，并限制条数与单一来源", () => {
  const raw = Array.from({ length: 8 }, (_, index) => ({
    kind: "diary",
    title: `线索 ${index}`,
    detail: index === 0 ? "旧工作仍在阻塞" : `睡眠话题 ${index}`,
    sourcePath: index < 7 ? "10_日志记录/工作日志/2026-08-28.md" : "待办事项与长期规划.md",
    score: 8 - index,
    reasons: ["原始理由"],
    date: "2026-08-28",
  }));
  const selected = selectDiaryModeContext(raw, { careAbout: ["睡眠"], avoid: ["旧工作"] }, { maxItems: 7, maxChars: 10_000 });
  assert.ok(selected.items.length <= 6);
  assert.ok(selected.items.filter((item) => item.sourcePath.includes("2026-08-28")).length <= 5);
  assert.ok(!selected.items.some((item) => item.detail.includes("旧工作")));
  assert.ok(selected.items.some((item) => item.reasons.some((reason) => reason.includes("希望主动关心"))));
});

test("各类来源有配额，项目阻塞不会挤掉日程和日记", () => {
  const projects = Array.from({ length: 10 }, (_, index) => ({ kind: "project", title: `项目 ${index}`, detail: `阻塞 ${index}`, sourcePath: `project-${index}.md`, score: 20 - index, reasons: ["阻塞"] }));
  const others = [
    { kind: "calendar", title: "明天见面", detail: "明天 18:00", sourcePath: "Apple Calendar", score: 5, reasons: ["日程"] },
    { kind: "diary", title: "近期日记", detail: "还想继续聊", sourcePath: "day.md", score: 5, reasons: ["近期"] },
  ];
  const selected = selectDiaryModeContext([...projects, ...others], { careAbout: [], avoid: [] });
  assert.equal(selected.items.filter((item) => item.kind === "project").length, 4);
  assert.ok(selected.items.some((item) => item.kind === "calendar"));
  assert.ok(selected.items.some((item) => item.kind === "diary"));
});

test("日记模式只带入与当前任务显式关联的阻塞和最近完成", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-diary-blocker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const preferenceFile = path.join(root, DIARY_MODE_PREFERENCES_PATH);
  await fs.mkdir(path.dirname(preferenceFile), { recursive: true });
  await fs.writeFile(preferenceFile, "## 希望主动关心\n- 项目进展\n## 不想反复被问\n- 尚未确认\n## 适合的聊天方式\n- 每次一件事\n");
  const snapshot = await readDiaryMode(root, {
    readLogs: async () => ({ days: [] }),
    readProjects: async () => ({
      currentTodos: [],
      warnings: [],
      projects: [{
        name: "小秘书",
        archived: false,
        managementPath: "project.md",
        management: {
          doing: [{ id: "diary-task", done: false, worklineIds: [], featureIds: ["assistant-diary-mode"] }],
          next: [],
          blocked: [],
          blockers: [{ id: "blocker", text: "等待手机验收", taskIds: ["diary-task"], worklineIds: [], moduleIds: [], featureIds: ["assistant-diary-mode"] }],
          recentCompleted: [
            { id: "recent-related", text: "已打通手机预览", taskIds: ["diary-task"], worklineIds: [], moduleIds: [], featureIds: [] },
            { id: "recent-unrelated", text: "其他项目的旧完成", taskIds: ["other-task"], worklineIds: [], moduleIds: [], featureIds: [] },
          ],
          currentStatus: "继续推进。",
        },
      }],
    }),
    readCalendar: async () => ({ available: true, events: [] }),
  });
  assert.ok(snapshot.context.some((item) => item.detail === "等待手机验收"));
  assert.ok(snapshot.context.some((item) => item.detail === "已打通手机预览"));
  assert.ok(!snapshot.context.some((item) => item.detail === "其他项目的旧完成"));
  assert.ok(!snapshot.context.some((item) => item.detail.includes("[object Object]")));
});

test("日记模式快照以已验证手机 MCP 为主路径，复制包只作回退", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-diary-mode-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const preferenceFile = path.join(root, DIARY_MODE_PREFERENCES_PATH);
  await fs.mkdir(path.dirname(preferenceFile), { recursive: true });
  await fs.writeFile(preferenceFile, "## 希望主动关心\n- 项目进展\n## 不想反复被问\n- 尚未确认\n## 适合的聊天方式\n- 每次一件事\n");
  const snapshot = await readDiaryMode(root, {
    now: new Date("2026-08-28T12:00:00+09:00"),
    readLogs: async () => ({ days: [{ date: "2026-08-27", description: "昨天", headings: [], sourcePath: "10_日志记录/工作日志/2026-08-27.md", markdown: "## 小结\n- 项目进展还想继续推进。" }] }),
    readProjects: async () => ({ projects: [], currentTodos: [], warnings: [] }),
    readCalendar: async () => ({ available: true, events: [
      { id: "old", title: "已经过期的安排", start: "2026-08-26T18:00:00+09:00", end: "2026-08-26T19:00:00+09:00", allDay: false, calendar: "个人" },
      { id: "1", title: "周末吃饭", start: "2026-08-30T18:00:00+09:00", end: "2026-08-30T19:00:00+09:00", allDay: false, calendar: "个人" },
      { id: "far", title: "超出七天的安排", start: "2026-09-05T18:00:00+09:00", end: "2026-09-05T19:00:00+09:00", allDay: false, calendar: "个人" },
    ] }),
  });
  assert.equal(snapshot.primaryPath.verified, true);
  assert.match(snapshot.mcpPrompt, /先完整读取/);
  assert.match(snapshot.fallbackGuide, /仅在 Infans 只读工具实际调用失败时回退/);
  assert.ok(snapshot.context.some((item) => item.kind === "diary"));
  assert.ok(snapshot.context.some((item) => item.kind === "calendar"));
  assert.ok(!snapshot.context.some((item) => item.title === "已经过期的安排" || item.title === "超出七天的安排"));
  assert.match(diaryModeMcpPrompt(), /同一聊天/);
});

test("周报前和月末只开启自然补访窗口，不把日记改成固定问卷", () => {
  assert.deepEqual(diaryModeReportWindow(new Date("2026-09-05T12:00:00+09:00")), {
    weekly: true,
    monthly: false,
    active: true,
    label: "周报前",
  });
  assert.deepEqual(diaryModeReportWindow(new Date("2026-09-28T12:00:00+09:00")), {
    weekly: false,
    monthly: true,
    active: true,
    label: "月报前",
  });
  assert.equal(diaryModeReportWindow(new Date("2026-09-23T12:00:00+09:00")).active, false);

  const activePrompt = diaryModeMcpPrompt({ weekly: true, monthly: true, active: true, label: "周报前／月报前" });
  assert.match(activePrompt, /只有发现会影响报告/);
  assert.match(activePrompt, /没有缺口就正常聊/);
  assert.match(activePrompt, /不固定题数/);
  assert.match(activePrompt, /不用量表腔/);
  assert.match(activePrompt, /跳过、换话题或不想说时就尊重/);
  assert.doesNotMatch(activePrompt, /必须问\s*\d+\s*个|WHO-5|心情\s*\d+分/u);
});

test("固定交接区分事实与推断，渲染文件明确非亲笔与非权威", () => {
  const parsed = parseDialogueLogHandoff(HANDOFF);
  assert.equal(parsed.recordId, "dialogue-20260828-a1b2");
  assert.equal(parsed.date, "2026-08-28");
  assert.match(parsed.sections["用户明确说过的事实"], /^•|^-/u);
  const markdown = renderDialogueLog(parsed);
  assert.match(markdown, /authorship: 用户口述与AI整理/);
  assert.match(markdown, /非用户亲笔/);
  assert.match(markdown, /## 不确定或 AI 推断/);
  assert.doesNotMatch(markdown, /10_日志记录\/日记/);
});

test("旧版对话日记交接标题仍可导入，但新产物统一叫对话日志", () => {
  const parsed = parseDialogueLogHandoff(HANDOFF.replace("对话日志交接", "对话日记交接"));
  assert.equal(parsed.recordId, "dialogue-20260828-a1b2");
  assert.match(renderDialogueLog(parsed), /对话日志/);
});

test("导入只产生独立对话日志预览，同 ID 拒绝覆盖", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-dialogue-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let received;
  const writes = { preview: async (action) => { received = action; return { token: "preview-token", targetPath: action.path, before: "", after: action.content, expiresAt: new Date().toISOString() }; } };
  const preview = await previewDialogueLogImport(root, HANDOFF, writes);
  assert.equal(preview.kind, "dialogueLog");
  assert.equal(received.kind, "editFile");
  assert.equal(received.path, `${DIALOGUE_DIARY_DIR}/2026-08-28_dialogue-20260828-a1b2.md`);
  assert.match(received.content, /authority: non-authoritative/);
  const file = path.join(root, received.path);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, received.content);
  await assert.rejects(() => previewDialogueLogImport(root, HANDOFF, writes), (error) => error.code === "DIALOGUE_ID_CONFLICT");
});

test("缺少分组或尚未写入边界时拒绝导入", () => {
  assert.throws(() => parseDialogueLogHandoff(HANDOFF.replace("## 用户明确表达的感受", "## 感受")), (error) => error.code === "DIALOGUE_SECTION_MISSING");
  assert.throws(() => parseDialogueLogHandoff(HANDOFF.replace("尚未写入 Vault：是", "尚未写入 Vault：否")), (error) => error.code === "DIALOGUE_WRITE_BOUNDARY_REQUIRED");
});
