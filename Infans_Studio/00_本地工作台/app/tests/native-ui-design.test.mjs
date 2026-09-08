import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_NATIVE_DESIGN_STATE,
  IPAD_SCENES,
  NATIVE_BASELINE_TOKENS,
  NATIVE_DESIGN_DEVICES,
  PHONE_SCENES,
  createNativeDesignExport,
  normalizeNativeDesignState,
} from "../src/pages/tools/native-ui-design-model.ts";

test("原生界面设计台默认打开本轮调整方案并保留手机与平板同屏", () => {
  assert.equal(DEFAULT_NATIVE_DESIGN_STATE.mode, "candidate");
  assert.equal(DEFAULT_NATIVE_DESIGN_STATE.schemeName, "原生一代 · 交互设计二次迭代");
  assert.deepEqual(DEFAULT_NATIVE_DESIGN_STATE.selectedDevices, ["iphone15", "ipad129"]);
  assert.equal(DEFAULT_NATIVE_DESIGN_STATE.orientation, "landscape");
  assert.deepEqual(DEFAULT_NATIVE_DESIGN_STATE.scenes, {
    iphone15: "chat",
    ipad129: "chat",
  });
  assert.deepEqual(NATIVE_DESIGN_DEVICES.map((device) => device.id), ["iphone15", "ipad129"]);
});

test("设备点尺寸和现有原生页面固定，不扩成任意设备编辑器", () => {
  const iphone = NATIVE_DESIGN_DEVICES.find((device) => device.id === "iphone15");
  const ipad = NATIVE_DESIGN_DEVICES.find((device) => device.id === "ipad129");
  assert.deepEqual(iphone?.points.portrait, [393, 852]);
  assert.deepEqual(ipad?.points.portrait, [1024, 1366]);
  assert.deepEqual(ipad?.points.landscape, [1366, 1024]);
  assert.deepEqual(PHONE_SCENES.map((scene) => scene.id), ["chat", "conversation", "settings"]);
  assert.deepEqual(IPAD_SCENES.map((scene) => scene.id), ["chat", "conversation", "settings"]);
});

test("本地方案回读会收紧非法模式、设备、页面、token 和颜色", () => {
  const normalized = normalizeNativeDesignState({
    mode: "future",
    selectedDevices: ["unknown"],
    orientation: "upside-down",
    showSafeArea: "yes",
    scenes: { iphone15: "private-chat", ipad129: "settings" },
    tokens: { density: 99, sidebarWidth: -20, topBarHeight: 50, composerHeight: 60, cornerRadius: 88, accent: "javascript:1", canvas: "#abcdef" },
  });
  assert.equal(normalized.mode, "candidate");
  assert.deepEqual(normalized.selectedDevices, ["iphone15"]);
  assert.equal(normalized.orientation, "landscape");
  assert.equal(normalized.showSafeArea, false);
  assert.equal(normalized.scenes.iphone15, "chat");
  assert.equal(normalized.scenes.ipad129, "settings");
  assert.equal(normalized.scenes.watchS10, undefined);
  assert.equal(normalized.tokens.density, 1.18);
  assert.equal(normalized.tokens.sidebarWidth, 280);
  assert.equal(normalized.tokens.composerHeight, 70);
  assert.equal(normalized.tokens.cornerRadius, 30);
  assert.equal(normalized.tokens.accent, NATIVE_BASELINE_TOKENS.accent);
  assert.equal(normalized.tokens.canvas, "#abcdef");
});

test("导出明确以当前 SwiftUI 为基准，并保留候选调整状态", () => {
  const payload = createNativeDesignExport(
    normalizeNativeDesignState({ ...DEFAULT_NATIVE_DESIGN_STATE, mode: "candidate" }),
    "2026-09-03T00:00:00.000Z",
  );
  assert.equal(payload.schema, "infans.native-ui-design.v2");
  assert.equal(payload.basis, "current-swiftui");
  assert.equal(payload.state.mode, "candidate");
  assert.match(payload.note, /当前原生基准/);
});

test("界面使用现有原生文案、真实素材和基准候选切换", async () => {
  const [toolsPage, labSource, labCss] = await Promise.all([
    readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/tools/NativeUiDesignLab.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/tools/native-ui-design.css", import.meta.url), "utf8"),
  ]);
  assert.match(toolsPage, /id: "native-ui-design",\s+group: "work",\s+name: "设计台"/);
  assert.match(toolsPage, /import\("\.\/tools\/NativeUiDesignLab"\)/);
  assert.match(labSource, />当前原生基准</);
  assert.match(labSource, />调整方案</);
  assert.match(labSource, /原生一代，进入第二次交互迭代/);
  assert.match(labSource, /infans-native-ui-design-lab-v3/);
  assert.match(labSource, /你好，银月在呢～/);
  assert.match(labSource, /请先在设置中保存小秘书指令令牌/);
  assert.match(labSource, /连接 Mac 小秘书/);
  assert.doesNotMatch(labSource, /Apple Watch 入口|function WatchScreen|WATCH_SCENES/);
  assert.match(labSource, /avatar-yinyue-public\.svg/);
  assert.doesNotMatch(labSource, /脱敏画布|脱敏内容|不读 Vault|不连 API|不联网/);
  assert.doesNotMatch(labSource, /<aside>\s*<header><strong>消息/);
  assert.match(labCss, /\.tools-page:has\(\.native-ui-design-lab\)/);
  assert.match(labCss, /width:min\(1840px,100%\)/);
  assert.match(labCss, /@media \(min-width:1700px\)/);
  assert.match(labCss, /\.nud-device-row\.is-single/);
  assert.match(labCss, /overflow:auto/);
});

test("iPhone 调整方案收起低频操作并采用熟悉的聊天输入骨架", async () => {
  const [labSource, labCss] = await Promise.all([
    readFile(new URL("../src/pages/tools/NativeUiDesignLab.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/tools/native-ui-design.css", import.meta.url), "utf8"),
  ]);
  assert.match(labSource, /function CandidatePhoneHeader/);
  assert.match(labSource, /<strong>银月<\/strong>/);
  assert.doesNotMatch(labSource, /padGroupSurface/);
  assert.match(labSource, /function CandidateOpeningMessage/);
  assert.match(labSource, /candidate \? <CandidateOpeningMessage \/>/);
  assert.match(labSource, /需要重新配对 · 点此查看/);
  assert.match(labSource, /function CandidateConversationSidebar/);
  assert.match(labSource, /设置与连接/);
  assert.match(labSource, /function CandidateComposer/);
  assert.match(labSource, /<small>照片<\/small>/);
  assert.match(labSource, /<small>拍摄<\/small>/);
  assert.match(labSource, /<small>文件<\/small>/);
  assert.match(labSource, /aria-label=\{showActions \? "收起更多操作" : "更多操作"\}/);
  assert.match(labSource, /voiceMode \? "切换文字输入" : "切换语音输入"/);
  assert.match(labSource, /className="nud-candidate-hold-to-talk">按住 说话/);
  assert.doesNotMatch(labSource, /aria-label="invite-members"/);
  assert.match(labCss, /\.nud-candidate-home-indicator/);
  assert.match(labCss, /\.is-ipad129 \.nud-safe-area \{ inset:6\.8% 2\.5% 3%; \}/);
});

test("iPad 调整方案把头像朗读并入主界面，会话列表在侧栏", async () => {
  const [labSource, labCss] = await Promise.all([
    readFile(new URL("../src/pages/tools/NativeUiDesignLab.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/tools/native-ui-design.css", import.meta.url), "utf8"),
  ]);
  assert.match(labSource, /function CandidateIpadWorkspace/);
  assert.match(labSource, /iPad 左侧纯净聊天浮窗/);
  assert.doesNotMatch(labSource, /CandidateIpadGroupStage|padGroupSurface|inviteMembers/u);
  assert.match(labSource, /scene !== "chat"/);
  assert.match(labSource, /<CandidateConversationSidebar onClose=/);
  assert.doesNotMatch(labSource, /<strong>左右互换<\/strong>/);
  assert.doesNotMatch(labSource, /沉浸单聊/);
  assert.match(labSource, /function CandidateIpadPrivateChat/);
  assert.match(labSource, /aria-label="播放银月语音"/);
  assert.match(labSource, /aria-label="结束朗读并返回文字聊天"/);
  assert.match(labSource, /正在朗读/);
  assert.match(labCss, /\.nud-ipad-chat-pane[\s\S]*left:3\.2%;[\s\S]*width:45%;/);
  assert.match(labCss, /\.nud-ipad-chat-pane > \.nud-native-chat \{ background:transparent; \}/);
  assert.match(labCss, /\.nud-ipad-chat-pane \.nud-native-chat-body \{ background-color:transparent;/);
  assert.match(labCss, /\.nud-ipad-floating-panel[\s\S]*right:3\.2%;[\s\S]*width:43\.5%;/);
  assert.match(labSource, /iPad 左侧设置与连接浮窗/);
  assert.match(labCss, /\.nud-ipad-candidate-workspace\.is-side-panel-open \.nud-ipad-chat-pane \{ left:51\.8%;/);
  assert.match(labCss, /\.nud-ipad-floating-panel \.nud-candidate-sidebar \{ width:100%/);
});

test("设计台不再包含 Watch 调整方案", async () => {
  const labSource = await readFile(new URL("../src/pages/tools/NativeUiDesignLab.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(labSource, /Apple Watch 入口/);
  assert.doesNotMatch(labSource, /function WatchScreen/);
  assert.doesNotMatch(labSource, /WATCH_SCENES/);
  assert.doesNotMatch(labSource, /watchS10/);
});
