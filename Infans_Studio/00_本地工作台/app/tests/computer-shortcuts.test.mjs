import assert from "node:assert/strict";
import test from "node:test";
import {
  cursorSettingsUnbindNeeded,
  cursorVoiceShortcutKey,
  nativeComputerShortcutMap,
  normalizeComputerShortcutBindings,
  presentComputerShortcuts,
  screenshotHotKeyPayload,
  validateComputerShortcutBindings,
  vscodeShortcutKey,
} from "../src/computer-shortcuts.mjs";

test("本机快捷键默认是关灯、系统全屏、框选、Shift 双 Command 截进 Cursor、句号朗读、逗号听写", () => {
  const snapshot = presentComputerShortcuts({});
  assert.equal(snapshot.commands[0]?.id, "lights-off");
  assert.equal(snapshot.commands.find((item) => item.id === "lights-off")?.display, "⌘Esc");
  assert.equal(snapshot.commands.find((item) => item.id === "screenshot-full")?.display, "⇧⌘3");
  assert.equal(snapshot.commands.find((item) => item.id === "screenshot-selection")?.display, "⇧⌘4");
  assert.equal(snapshot.commands.find((item) => item.id === "agent-screenshot-chat")?.display, "⇧⌘⌘");
  assert.equal(snapshot.commands.find((item) => item.id === "agent-read-aloud")?.display, "⌘.");
  assert.equal(snapshot.commands.find((item) => item.id === "agent-read-aloud")?.label, "秘书朗读");
  assert.equal(snapshot.commands.find((item) => item.id === "agent-dictation")?.display, "⌘,");
  assert.equal(snapshot.native.lightsOff.keyCode, 53);
  assert.equal(snapshot.native.readAloud.keyCode, 47);
  assert.equal(snapshot.native.dictation.keyCode, 43);
  assert.equal(snapshot.native.agentScreenshot.enabled, true);
  assert.equal(snapshot.screenshots["screenshot-full"].keyCode, 20);
  assert.equal(snapshot.screenshots["screenshot-selection"].keyCode, 21);
  assert.equal(snapshot.screenshots["screenshot-full"].modifiers, (1 << 20) | (1 << 17));
  assert.equal(cursorSettingsUnbindNeeded(snapshot.bindings), true);
  assert.equal(cursorVoiceShortcutKey(snapshot.bindings), "cmd+,");
  assert.match(snapshot.commands.find((item) => item.id === "agent-dictation")?.note || "", /取消设置键/u);
  assert.match(snapshot.commands.find((item) => item.id === "screenshot-full")?.note || "", /原来的全屏截图键/u);
  assert.match(snapshot.commands.find((item) => item.id === "agent-screenshot-chat")?.note || "", /鼠标所在那块屏/u);
  const upgradedLights = presentComputerShortcuts({
    "lights-off": { code: "F12", meta: true, ctrl: false, alt: false, shift: false },
  });
  assert.equal(upgradedLights.commands.find((item) => item.id === "lights-off")?.display, "⌘Esc");
  const upgraded = presentComputerShortcuts({
    "agent-screenshot-chat": { code: "MetaBoth", meta: true, ctrl: false, alt: false, shift: false },
  });
  assert.equal(upgraded.commands.find((item) => item.id === "agent-screenshot-chat")?.display, "⇧⌘⌘");
});

test("本机快捷键拒绝互相占用同一个组合，并允许停用", () => {
  const clash = validateComputerShortcutBindings({
    "screenshot-full": { code: "Period", meta: true, ctrl: false, alt: false, shift: false },
    "agent-read-aloud": { code: "Period", meta: true, ctrl: false, alt: false, shift: false },
  });
  assert.equal(clash.some((item) => item.kind === "conflict"), true);
  const normalized = normalizeComputerShortcutBindings({
    "agent-dictation": null,
  });
  assert.equal(normalized["agent-dictation"], null);
  assert.equal(nativeComputerShortcutMap(normalized).dictation.enabled, false);
  assert.equal(screenshotHotKeyPayload(normalized)["screenshot-full"].id, 28);
  const bothOnFull = validateComputerShortcutBindings({
    "screenshot-full": { code: "MetaBoth", meta: true, ctrl: false, alt: false, shift: false },
  });
  assert.equal(bothOnFull.some((item) => item.kind === "unsupported"), true);
  const customChatShot = validateComputerShortcutBindings({
    "agent-screenshot-chat": { code: "Digit3", meta: true, ctrl: false, alt: false, shift: true },
  });
  assert.equal(customChatShot.some((item) => item.kind === "unsupported"), true);
  const disabledShot = normalizeComputerShortcutBindings({ "agent-screenshot-chat": null });
  assert.equal(disabledShot["agent-screenshot-chat"], null);
  assert.equal(nativeComputerShortcutMap(disabledShot).agentScreenshot.enabled, false);
});

test("听写键转成 Cursor 自己的快捷键写法", () => {
  assert.equal(vscodeShortcutKey({ code: "Comma", meta: true, ctrl: false, alt: false, shift: false }), "cmd+,");
  assert.equal(vscodeShortcutKey({ code: "Digit3", meta: true, ctrl: false, alt: false, shift: true }), "shift+cmd+3");
  assert.equal(vscodeShortcutKey(null), null);
});

test("保存时会取消 Cursor 自己的设置键，并把本机快捷键放进这台 Mac 的系统设置", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/server/workbench-computer-shortcuts.mjs", import.meta.url), "utf8");
  const settings = await readFile(new URL("../src/pages/tools/ShortcutSettings.tsx", import.meta.url), "utf8");
  const tools = await readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const prefs = await readFile(new URL("../src/pages/tools/PersonalizationSettings.tsx", import.meta.url), "utf8");
  const commands = await readFile(new URL("../src/computer-shortcuts.mjs", import.meta.url), "utf8");
  assert.match(source, /-aiSettings\.action\.open/u);
  assert.match(source, /-workbench\.action\.openSettings/u);
  assert.match(source, /os\.homedir\(\)/u);
  assert.match(source, /Path\.home\(\)/u);
  assert.match(settings, /这台电脑 · 关灯/u);
  assert.match(settings, /这台电脑 · 截屏/u);
  assert.match(settings, /截进 Cursor 当前对话/u);
  assert.match(settings, /鼠标所在那块屏/u);
  assert.match(prefs, /settingsTabFromLocation/u);
  assert.match(prefs, /computerValue=\{computerDraft\}/u);
  assert.match(prefs, /SECRETARY_PROFILES\.filter\(profile=>profile\.secretaryEligible\)/u);
  assert.match(tools, /\/tools\/settings\?section=shortcuts/u);
  assert.equal(tools.includes("ComputerShortcutsView"), false);
  assert.equal(tools.includes('id: "keyboard-shortcuts"'), false);
  assert.match(commands, /label: "关灯模式"/u);
  assert.match(commands, /label: "秘书朗读"/u);
});
