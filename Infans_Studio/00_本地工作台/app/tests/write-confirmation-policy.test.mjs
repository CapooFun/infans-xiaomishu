import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  directWriteSuccessMessage,
  skipsAiWriteConfirmation,
  skipsWorkbenchWriteConfirmation,
} from "../src/write-confirmation-policy.ts";

test("只有完成恢复与 SABC 单项点击直接写入", () => {
  assert.equal(skipsWorkbenchWriteConfirmation({ kind: "setTodoPriority", sourcePath: "a.md", id: "t1", expectedDone: false, expectedPriority: "", priority: "A" }), true);
  assert.equal(skipsWorkbenchWriteConfirmation({ kind: "toggleTodo", sourcePath: "a.md", id: "t1", expectedDone: false }), true);
  assert.equal(skipsWorkbenchWriteConfirmation({ kind: "acceptProductFeature", projectId: "p", moduleId: "m", featureId: "f", sourcePath: "a.md", expectedStatus: "等待验收" }), false);
  assert.equal(skipsWorkbenchWriteConfirmation({ kind: "addTodo", scope: "project", projectId: "game", text: "下一步" }), false);
  assert.equal(skipsWorkbenchWriteConfirmation({ kind: "journal", text: "今天完成了测试" }), false);
  assert.equal(skipsWorkbenchWriteConfirmation({ kind: "editFile", path: "a.md", content: "正文" }), false);
});

test("梅凝对话只直写项目新增与今日日志", () => {
  assert.equal(skipsAiWriteConfirmation({ kind: "addTodo", scope: "project", projectId: "game", text: "下一步", label: "新增项目任务", summary: "下一步" }), true);
  assert.equal(skipsAiWriteConfirmation({ kind: "journal", text: "今天完成了测试", label: "写今日日志", summary: "今天完成了测试" }), true);
  assert.equal(skipsAiWriteConfirmation({ kind: "addTodo", scope: "today", text: "临时事项", label: "新增待办", summary: "临时事项" }), false);
  assert.equal(skipsAiWriteConfirmation({ kind: "calendarCreate", title: "见面", calendar: "个人", start: "2026-08-21T10:00:00+09:00", end: "2026-08-21T11:00:00+09:00", allDay: false, label: "新增日程", summary: "见面" }), false);
});

test("梅凝对话的写入确认政策不按手机或平板额外分级", () => {
  const overlays = readFileSync(new URL("../src/shell/WorkbenchOverlays.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(overlays, /mobileGate|isMobileClient/);
  assert.match(overlays, /const needsConfirm = !skipsAiWriteConfirmation\(action\) && actionNeedsConfirm\(action, preview\)/);
});

test("直写完成提示与动作一致", () => {
  assert.equal(directWriteSuccessMessage({ kind: "toggleTodo", sourcePath: "a.md", id: "t1", expectedDone: false }), "任务已完成");
  assert.equal(directWriteSuccessMessage({ kind: "acceptProductFeature", projectId: "p", moduleId: "m", featureId: "f", sourcePath: "a.md", expectedStatus: "等待验收" }), "功能已验收");
  assert.equal(directWriteSuccessMessage({ kind: "toggleTodo", sourcePath: "a.md", id: "t1", expectedDone: true }), "任务已恢复");
  assert.equal(directWriteSuccessMessage({ kind: "setTodoPriority", sourcePath: "a.md", id: "t1", expectedDone: false, expectedPriority: "", priority: "A" }), "任务等级已更新");
  assert.equal(directWriteSuccessMessage({ kind: "journal", text: "记录" }), "已记到今天");
});
