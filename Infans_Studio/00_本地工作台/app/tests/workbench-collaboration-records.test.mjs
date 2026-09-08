import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("协作记录用一个启动台入口保留四种独立视图和旧深链", () => {
  const tools = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const dialogue = readFileSync(new URL("../src/pages/tools/DiaryModeView.tsx", import.meta.url), "utf8");
  const meetings = readFileSync(new URL("../src/pages/tools/MeetingMinutesView.tsx", import.meta.url), "utf8");
  const technical = readFileSync(new URL("../src/pages/tools/TechnicalDiscussionsView.tsx", import.meta.url), "utf8");

  assert.match(tools, /id: "collaboration-records",\s+group: "secretary",\s+name: "协作记录"/u);
  assert.equal((tools.match(/name: "工作日志"/gu) || []).length, 0);
  assert.equal((tools.match(/name: "对话日志"/gu) || []).length, 0);
  assert.match(tools, /match\[1\] === "development-log" \|\| match\[1\] === "diary-mode"/u);
  assert.match(tools, /id: "work", label: "工作日志", memory: "行动记忆"/u);
  assert.match(tools, /id: "dialogue", label: "对话日志", memory: "关系与语境"/u);
  assert.match(tools, /id: "meeting", label: "会议纪要", memory: "制度记忆"/u);
  assert.match(tools, /id: "discussion", label: "技术讨论", memory: "讨论与说明"/u);
  assert.match(tools, /displayMode && view === "dialogue"/u);
  assert.match(dialogue, /isLegacyPath = window\.location\.pathname === "\/tools\/diary-mode"/u);
  assert.match(dialogue, /"\/tools\/collaboration-records" && params\.get\("view"\) === "dialogue"/u);
  assert.match(meetings, /\/api\/tools\/meeting-minutes/u);
  assert.match(technical, /\/api\/tools\/technical-discussions/u);
  assert.match(technical, /不替代项目权威原件/u);
  assert.doesNotMatch(meetings, /SourceLink|在 Obsidian/u);
});

test("会议纪要与技术讨论接口沿用私人读取门禁，四层页面有桌面与手机布局", () => {
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const route = routes.slice(routes.indexOf('router.use("/api/tools/meeting-minutes"'), routes.indexOf('router.use("/api/tools/music"'));
  const technicalRoute = routes.slice(routes.indexOf('router.use("/api/tools/technical-discussions"'), routes.indexOf('router.use("/api/tools/music"'));

  assert.match(route, /request\.method !== "GET"/u);
  assert.match(route, /protectAssetResponse\(response\)/u);
  assert.match(route, /assertPrivateAssetAccess\(request\)/u);
  assert.match(technicalRoute, /request\.method !== "GET"/u);
  assert.match(technicalRoute, /protectAssetResponse\(response\)/u);
  assert.match(technicalRoute, /assertPrivateAssetAccess\(request\)/u);
  assert.match(styles, /\.collaboration-record-tabs \{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/u);
  assert.match(styles, /\.development-log-day-list\.collaboration-record-grid,[^{]+\.meeting-minutes-grid\.collaboration-record-grid \{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(styles, /\.meeting-minute-reader-head \{[^}]*grid-template-columns:minmax\(0,1fr\)/u);
  assert.doesNotMatch(styles, /\.meeting-minute-reader-head \{[^}]*grid-template-columns:126px/u);
  assert.match(styles, /@media \(max-width:620px\) \{[\s\S]*?\.collaboration-record-tabs button \{[^}]*flex-direction:column/u);
  assert.match(styles, /@media \(max-width:720px\) \{[\s\S]*?\.meeting-minutes-grid\.collaboration-record-grid \{ grid-template-columns:1fr;grid-auto-rows:auto; \}/u);
});

test("四类记录共享页首、日期签页和详情标题骨架，头像只留在对话日志", () => {
  const tools = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const dialogue = readFileSync(new URL("../src/pages/tools/DiaryModeView.tsx", import.meta.url), "utf8");
  const meetings = readFileSync(new URL("../src/pages/tools/MeetingMinutesView.tsx", import.meta.url), "utf8");
  const workDetail = readFileSync(new URL("../src/pages/tools/DevelopmentLogDay.tsx", import.meta.url), "utf8");
  const technical = readFileSync(new URL("../src/pages/tools/TechnicalDiscussionsView.tsx", import.meta.url), "utf8");

  assert.match(tools, /development-log-head collaboration-index-head/u);
  assert.match(dialogue, /dialogue-log-index-head collaboration-index-head/u);
  assert.match(meetings, /meeting-minutes-index-head collaboration-index-head/u);
  assert.match(tools, /development-log-day-card collaboration-record-card/u);
  assert.match(dialogue, /dialogue-day-card collaboration-record-card/u);
  assert.match(meetings, /meeting-minute-card collaboration-record-card/u);
  assert.match(technical, /technical-plan-card/u);
  assert.match(dialogue, /className="dialogue-day-avatars"/u);
  assert.doesNotMatch(tools, /dialogue-day-avatars/u);
  assert.doesNotMatch(meetings, /dialogue-day-avatars/u);
  assert.match(dialogue, /dialogue-reader-head collaboration-reader-head/u);
  assert.match(meetings, /meeting-minute-reader-head collaboration-reader-head/u);
  assert.match(workDetail, /development-log-reader-head collaboration-reader-head/u);
  assert.match(technical, /meeting-minute-reader-head collaboration-reader-head/u);
});
