import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildOpenRouterOrdinaryPrompt, buildProjectsAiContext, buildPrompt, CURSOR_HIGH_MODEL, DEFAULT_MODEL, formatCursorLoginLabel, isLightweightChatTurn, extractAnkiDay, findLastActionsJson, normalizeChatHistory, OPENSOURCE_MODEL_UNCONFIGURED_LABEL, parseProposedActions, readSecretaryAiRuntimeStatus, resolveCursorChatModel, shouldUseOpenRouterOrdinaryChat, splitDualSecretaryAnswer, wantsAnkiDayContext, wantsCapabilityContext, wantsHealthContext, wantsLanguagesContext, wantsLibraryContext, wantsMarketContext, wantsProjectsContext, wantsSteamContext, wantsTopicsContext, wantsVaultWorkTurn, wantsWeatherContext } from "../src/server/workbench-ai.mjs";
import { isCodePath } from "../src/server/workbench-write.mjs";
import { resolveWorkbenchAgentInvocation, streamCursor } from "../src/server/workbench-ai.mjs";
import { DEFAULT_VAULT_ROOT } from "../scripts/infans-agent-runner.mjs";

test("isCodePath covers workbench app and launcher", () => {
  assert.equal(isCodePath("00_本地工作台/app/src/main.tsx"), true);
  assert.equal(isCodePath("00_本地工作台/小秘书.app/Contents/Info.plist"), true);
  assert.equal(isCodePath("00_本地工作台/小秘书.app/对话记录/x.json"), true);
  assert.equal(isCodePath("00_本地工作台/小秘书.app/附件/x.png"), true);
  assert.equal(isCodePath("00_本地工作台/派生数据/secretary-runtime/chats/x.json"), false);
  assert.equal(isCodePath("00_本地工作台/派生数据/secretary-runtime/attachments/x.png"), false);
  assert.equal(isCodePath("10_日志记录/工作日志/2026-08-02.md"), false);
  assert.equal(isCodePath("待办事项与长期规划.md"), false);
});

test("normalizeChatHistory keeps last eight valid turns", () => {
  const history = normalizeChatHistory([
    { role: "system", content: "忽略" },
    { role: "user", content: "  第一问  " },
    { role: "assistant", content: "第一答" },
    ...Array.from({ length: 10 }, (_, index) => ({ role: "user", content: `问${index}` })),
  ]);
  assert.equal(history.length, 8);
  assert.equal(history[0].content, "问2");
  assert.equal(history.at(-1)?.content, "问9");
});

test("plaintext attachments remain available to the ordinary Cursor prompt", () => {
  const prompt = buildPrompt("请看图", [], ["个人"], [], {
    attachments: [{
      id: "att_test",
      kind: "image",
      name: "photo.png",
      path: "00_本地工作台/派生数据/secretary-runtime/attachments/att_test.png",
    }],
  });
  assert.match(prompt, /本轮附件/);
  assert.match(prompt, /00_本地工作台\/派生数据\/secretary-runtime\/attachments\/att_test\.png/);
  assert.doesNotMatch(prompt, /加密|解密/);
});

test("普通一对一由银月值班", () => {
  const prompt = buildPrompt("今天日程", [{ source: "test", text: "无额外资料" }], ["个人"], []);
  assert.match(prompt, /小秘书|银月/);
  assert.match(prompt, /一对一工作秘书/);
  assert.match(prompt, /世界就是当前这一对一窗口/);
});

test("银月值班时称用户「你」", () => {
  const prompt = buildPrompt("今天日程", [{ source: "test", text: "无额外资料" }], ["个人"], [], { activeSecretaryId: "yinyue" });
  assert.match(prompt, /当前值班人物「银月」|银月/);
  assert.match(prompt, /称用户「你」/);
  assert.doesNotMatch(prompt, /你是梅凝/);
});

test("梅凝值班时仍称用户「你」", () => {
  const prompt = buildPrompt("今天日程", [{ source: "test", text: "无额外资料" }], ["个人"], [], { activeSecretaryId: "meining" });
  assert.match(prompt, /当前值班人物「梅凝」|你是梅凝/);
  assert.match(prompt, /称用户「你」/);
});

test("login status label only says whether Cursor Agent is signed in", () => {
  assert.equal(formatCursorLoginLabel(true), "已登录");
  assert.equal(formatCursorLoginLabel(false), "尚未登录 Cursor Agent");
  assert.equal(formatCursorLoginLabel(true, { available: false }), "Cursor Agent 暂不可用");
  assert.doesNotMatch(formatCursorLoginLabel(true), /@|cursor-grok/);
});

test("workbench Cursor chat resolves command and arguments through the local role binding", async () => {
  const prompt = "本轮动态提示";
  let invocation;
  try {
    invocation = await resolveWorkbenchAgentInvocation(DEFAULT_VAULT_ROOT, "workbench-chat-high", prompt);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  assert.equal(invocation.roleId, "workbench-chat-high");
  assert.equal(invocation.adapterId, "cursor-chat-cli");
  assert.equal(invocation.command, "cursor-agent");
  assert.equal(typeof invocation.model, "string");
  assert.equal(invocation.args.at(-1), prompt);
  assert.deepEqual(invocation.args.slice(0, 6), ["--print", "--mode", "ask", "--sandbox", "disabled", "--trust"]);
});

test("lightweight chat turns skip vault search instructions", () => {
  assert.equal(isLightweightChatTurn("我在吗"), true);
  assert.equal(isLightweightChatTurn("在吗"), true);
  assert.equal(isLightweightChatTurn("今天日程"), false);
  assert.equal(isLightweightChatTurn("我在吗", { hasAttachments: true }), false);
  const prompt = buildPrompt("我在吗", [{ source: "test", text: "不应出现" }], ["个人"], [], {
    activeSecretaryId: "yinyue",
    lightweight: true,
  });
  assert.match(prompt, /短寒暄或在场确认/);
  assert.match(prompt, /禁止使用 Read/);
  assert.doesNotMatch(prompt, /加速摘要/);
  assert.doesNotMatch(prompt, /不应出现/);
});

test("开源一对一不带作者私人模型", async () => {
  assert.equal(shouldUseOpenRouterOrdinaryChat("在吗"), false);
  assert.equal(shouldUseOpenRouterOrdinaryChat("在吗", { ordinaryBackend: "openrouter" }), false);
  const status = await readSecretaryAiRuntimeStatus("/tmp/unused", {
    cursorStatus: async () => ({ installed: true, loggedIn: true, model: DEFAULT_MODEL, label: "Cursor 已登录" }),
    openRouterStatus: async () => ({ available: true, model: "example-model", label: "已注入假状态" }),
  });
  assert.equal(status.ordinary.model, "");
  assert.equal(status.ordinary.available, false);
  assert.equal(status.ordinary.label, OPENSOURCE_MODEL_UNCONFIGURED_LABEL);
  assert.equal(status.model, "");
  const overlays = await fs.readFile(new URL("../src/shell/WorkbenchOverlays.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(overlays, /groupOptions\?\.grok|groupOptions\?\.aion/u);
  assert.equal(DEFAULT_MODEL, "");
  assert.equal(CURSOR_HIGH_MODEL, "");
  assert.equal(resolveCursorChatModel({ ordinaryBackend: "cursor", cursorModel: "anything" }, "在吗"), "");
  const result = await streamCursor("/tmp/does-not-exist", { question: "在吗", activeSecretaryId: "yinyue" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MODEL_NOT_CONFIGURED");
  assert.equal(result.model, "");
});

test("Meining treats an unspecified ordinary todo as default C and leaves overdue promotion derived", () => {
  const prompt = buildPrompt("帮我记个待办", [{ source: "test", text: "无额外资料" }], ["个人"], []);
  assert.match(prompt, /普通待办没点名时按 C/);
  assert.match(prompt, /逾期由工作台派生 A→S、C→B/);
  assert.doesNotMatch(prompt, /没点则你自动分级/);
});

test("Meining calendar titles distinguish arrival from official start", () => {
  const prompt = buildPrompt("帮我记电影日程", [{ source: "test", text: "无额外资料" }], ["个人"], []);
  assert.match(prompt, /正式开始 HH:mm/);
  assert.match(prompt, /HH:mm 到场/);
  assert.match(prompt, /不得只靠 start/);
});

test("开源一对一提示词忽略额外席位字段，仍走值班秘书", () => {
  const prompt = buildPrompt("今天日程", [{ source: "test", text: "无额外资料" }], ["个人"], [], {
    allowedSpeakers: ["unknown-one", "unknown-two"],
  });
  assert.match(prompt, /一对一/);
});

test("开源一对一拆句只留给值班银月", () => {
  assert.deepEqual(splitDualSecretaryAnswer("专项已按 N2 抽卡出题。", "yinyue"), [
    { speaker: "yinyue", content: "专项已按 N2 抽卡出题。" },
  ]);
  assert.equal(splitDualSecretaryAnswer("在呀。")[0].speaker, "yinyue");
  assert.equal(splitDualSecretaryAnswer("【梅凝】\n我在。")[0].speaker, "yinyue");
});

test("wantsLibraryContext catches aggregate reading questions", () => {
  assert.equal(wantsLibraryContext("我读了多少书"), true);
  assert.equal(wantsLibraryContext("个人图书管理里有没有"), true);
  assert.equal(wantsLibraryContext("今天天气怎么样"), false);
});

test("domain intent helpers cover health languages topics", () => {
  assert.equal(wantsHealthContext("最近体重多少"), true);
  assert.equal(wantsLanguagesContext("日语学到哪了"), true);
  assert.equal(wantsTopicsContext("通鉴听到第几讲"), true);
  assert.equal(wantsProjectsContext("项目进度"), true);
  assert.equal(wantsProjectsContext("聊聊我关注的事项"), true);
  assert.equal(wantsMarketContext("今天金融简报"), true);
  assert.equal(wantsHealthContext("随便聊聊"), false);
});

test("事业上下文只展开当前仍有效的关注项目待办", () => {
  const task = (id, text, extra = {}) => ({
    id,
    idKind: "explicit",
    writable: true,
    done: false,
    displayText: text,
    section: "doing",
    priority: "A",
    date: { label: "8/31", start: "2026-08-31", end: "2026-08-31" },
    ...extra,
  });
  const summary = {
    projects: { items: [{ name: "测试项目", status: "推进中", entry: "当前方向" }] },
    projectManagement: {
      projects: [{
        projectId: "test-project",
        name: "测试项目",
        archived: false,
        management: { doing: [task("keep", "保留这条")], next: [task("done", "已完成", { done: true })] },
      }],
    },
  };
  const context = buildProjectsAiContext(summary, { taskKeys: ["test-project:keep", "test-project:done", "stale:missing"] });
  assert.match(context.text, /当前关注的项目待办/u);
  assert.match(context.text, /测试项目｜保留这条（正在做 · A · 8\/31）/u);
  assert.doesNotMatch(context.text, /已完成/u);
  assert.doesNotMatch(context.text, /stale/u);
});

test("wantsMarketContext includes FX and capability helpers", () => {
  assert.equal(wantsMarketContext("美元汇率多少"), true);
  assert.equal(wantsWeatherContext("东京天气怎么样"), true);
  assert.equal(wantsCapabilityContext("现在你可以做什么呢"), true);
  assert.equal(wantsMarketContext("随便聊聊"), false);
});

test("wantsSteamContext catches live play questions but not game-dev talk", () => {
  assert.equal(wantsSteamContext("最近在玩什么"), true);
  assert.equal(wantsSteamContext("你接入了我的Steam API了吗"), true);
  assert.equal(wantsSteamContext("阳台种植计划进度"), false);
});

test("Meining prompt is blacklist: can browse, only code edits need confirm", () => {
  const prompt = buildPrompt("你能做什么", [{ source: "test", text: "无" }], ["个人"], []);
  assert.match(prompt, /查网页/);
  assert.match(prompt, /二次确认/);
  assert.doesNotMatch(prompt, /乱爬/);
  assert.doesNotMatch(prompt, /真正做不到的再说/);
});

test("parseProposedActions keeps answer when no JSON is present", () => {
  const parsed = parseProposedActions("只是问答，没有行动。");
  assert.equal(parsed.answer, "只是问答，没有行动。");
  assert.deepEqual(parsed.actions, []);
});

test("parseProposedActions takes only the last actions JSON block", () => {
  const text = `先看这段。
\`\`\`json
{"actions":[{"kind":"addTodo","scope":"today","text":"旧的"}]}
\`\`\`
正文继续。
\`\`\`json
{"actions":[{"kind":"addTodo","scope":"today","text":"明天买车票"},{"kind":"journal","text":"记一句"}]}
\`\`\`
`;
  const parsed = parseProposedActions(text, { calendars: ["个人"] });
  assert.match(parsed.answer, /先看这段/);
  assert.match(parsed.answer, /正文继续/);
  assert.doesNotMatch(parsed.answer, /明天买车票/);
  assert.equal(parsed.actions.length, 2);
  assert.equal(parsed.actions[0].kind, "addTodo");
  assert.equal(parsed.actions[0].text, "明天买车票");
  assert.equal(parsed.actions[1].kind, "journal");
});

test("parseProposedActions rejects unknown kinds and inverted times", () => {
  const text = `说明
{"actions":[
  {"kind":"deleteEverything"},
  {"kind":"addTodo","scope":"today","text":""},
  {"kind":"calendarCreate","title":"会","calendar":"个人","start":"2026-08-02T10:00:00+09:00","end":"2026-08-02T09:00:00+09:00","allDay":false},
  {"kind":"calendarCreate","title":"有效会","calendar":"个人","start":"2026-08-02T10:00:00+09:00","end":"2026-08-02T11:00:00+09:00","allDay":false}
]}`;
  const parsed = parseProposedActions(text, { calendars: ["个人", "Google"] });
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].title, "有效会");
});

test("parseProposedActions remaps reminder calendars to a creatable event calendar", () => {
  const text = `{"actions":[{"kind":"calendarCreate","title":"喝水","calendar":"计划的提醒事项","start":"2026-08-01T16:47:00+09:00","end":"2026-08-01T17:00:00+09:00","allDay":false}]}`;
  const parsed = parseProposedActions(text, { calendars: ["工作", "个人", "计划的提醒事项"] });
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].calendar, "个人");
  assert.equal(parsed.actions[0].title, "喝水");
});

test("parseProposedActions falls back unknown calendar names to preferred event calendar", () => {
  const text = `{"actions":[{"kind":"calendarCreate","title":"会","calendar":"不存在","start":"2026-08-02T10:00:00+09:00","end":"2026-08-02T11:00:00+09:00","allDay":false}]}`;
  const parsed = parseProposedActions(text, { calendars: ["个人", "Google"] });
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].calendar, "个人");
});

test("parseProposedActions caps at five actions and tolerates parse failure", () => {
  const many = {
    actions: Array.from({ length: 8 }, (_, index) => ({ kind: "addTodo", scope: "today", text: `任务${index + 1}` })),
  };
  const parsed = parseProposedActions(`好的\n\`\`\`json\n${JSON.stringify(many)}\n\`\`\``, { calendars: [] });
  assert.equal(parsed.actions.length, 5);
  const broken = parseProposedActions("前言\n```json\n{actions:[}\n```");
  assert.equal(broken.answer.includes("前言"), true);
  assert.deepEqual(broken.actions, []);
});

test("parseProposedActions accepts editFile and marks code paths", () => {
  const text = `{"actions":[
    {"kind":"editFile","path":"10_日志记录/工作日志/2026-08-02.md","oldText":"旧","newText":"新"},
    {"kind":"editFile","path":"00_本地工作台/app/src/main.tsx","oldText":"a","newText":"b"},
    {"kind":"editFile","path":"../outside.md","content":"no"}
  ]}`;
  const parsed = parseProposedActions(text, { calendars: [] });
  assert.equal(parsed.actions.length, 2);
  assert.equal(parsed.actions[0].kind, "editFile");
  assert.equal(parsed.actions[0].requiresConfirm, false);
  assert.equal(parsed.actions[1].requiresConfirm, true);
  assert.equal(parsed.actions[1].path, "00_本地工作台/app/src/main.tsx");
});

test("parseProposedActions keeps relationship memory on the dedicated confirmed channel", () => {
  const text = `先给前辈确认。\n{"actions":[{"kind":"relationshipMemory","secretaryId":"银月","operation":"append","text":"- 2026-08-30：前辈确认了第一声真实手表问候。"}]}`;
  const parsed = parseProposedActions(text, { calendars: [] });
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0].kind, "relationshipMemory");
  assert.equal(parsed.actions[0].secretaryId, "yinyue");
  assert.equal(parsed.actions[0].requiresConfirm, true);
});

test("wantsAnkiDayContext and extractAnkiDay understand yesterday", () => {
  assert.equal(wantsAnkiDayContext("昨天 Anki 背了多少"), true);
  assert.equal(extractAnkiDay("请看 2026-08-01 的复习"), "2026-08-01");
  assert.match(extractAnkiDay("昨天背了啥", new Date("2026-08-02T12:00:00+09:00")), /^2026-08-01$/);
});

test("findLastActionsJson ignores lookalike JSON without actions array", () => {
  const found = findLastActionsJson('{"note":"no actions"} then {"actions":[{"kind":"addTodo","scope":"today","text":"唯一"}]}');
  assert.ok(found);
  assert.equal(found.parsed.actions[0].text, "唯一");
});
