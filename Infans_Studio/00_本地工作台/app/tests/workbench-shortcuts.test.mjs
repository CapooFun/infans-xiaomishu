import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSidebarBookmarkOrder,
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_COMMANDS,
  normalizeShortcutBindings,
  validateShortcutBindings,
  shortcutBindingFromKeyboardEvent,
  formatShortcutBinding,
  shortcutBindingAriaLabel,
  shouldIgnoreWorkbenchShortcutTarget,
  workbenchShortcutFromCustomEvent,
  workbenchShortcutFromKeyboardEvent,
} from "../src/workbench-shortcuts.ts";

function keyboard(overrides = {}) {
  return {
    altKey: false,
    code: "",
    ctrlKey: false,
    isComposing: false,
    key: "",
    metaKey: true,
    repeat: false,
    shiftKey: false,
    ...overrides,
  };
}

test("Command 快捷键映射到书签、历史与侧栏，不含展示模式", () => {
  for (let slot = 1; slot <= 6; slot += 1) {
    assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ code: `Digit${slot}`, key: String(slot) })), `bookmark-${slot}`);
  }
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ code: "BracketLeft", key: "[" })), "history-back");
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ code: "BracketRight", key: "]" })), "history-forward");
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ code: "Backquote", key: "Dead" })), "toggle-sidebar");
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ code: "Digit0", key: "0" })), null);
});

test("快捷键忽略输入法组合、连发与额外修饰键", () => {
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ key: "1", isComposing: true })), null);
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ key: "1", repeat: true })), null);
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ key: "1", shiftKey: true })), null);
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ key: "1", altKey: true })), null);
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ key: "1", ctrlKey: true })), null);
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ key: "1", metaKey: false })), null);
});

test("原生桥只接受登记过的稳定命令", () => {
  assert.equal(workbenchShortcutFromCustomEvent({ detail: { command: "bookmark-4" } }), "bookmark-4");
  assert.equal(workbenchShortcutFromCustomEvent({ detail: { command: "disable-display-mode" } }), null);
  assert.equal(workbenchShortcutFromCustomEvent({ detail: {} }), null);
});

test("密码和模态验证界面关闭全局快捷键", () => {
  assert.equal(shouldIgnoreWorkbenchShortcutTarget({ closest: () => ({}) }), true);
  assert.equal(shouldIgnoreWorkbenchShortcutTarget({ closest: () => null }), false);
  assert.equal(shouldIgnoreWorkbenchShortcutTarget(null), false);
});

test("折叠书签排序只替换参与拖动的槽位并保留其余顺序", () => {
  const all = ["a", "b", "c", "d", "e", "f"].map((location) => ({ location }));
  const next = mergeSidebarBookmarkOrder(all, [all[2], all[0], all[3], all[1]]);
  assert.deepEqual(next.map((item) => item.location), ["c", "a", "d", "b", "e", "f"]);
});

test("命令注册表是完整默认绑定与设置显示的共同来源", () => {
  assert.deepEqual(SHORTCUT_COMMANDS.map(({ id }) => id).sort(), Object.keys(DEFAULT_SHORTCUT_BINDINGS).sort());
  assert.deepEqual(validateShortcutBindings(DEFAULT_SHORTCUT_BINDINGS), []);
  assert.deepEqual(normalizeShortcutBindings(), DEFAULT_SHORTCUT_BINDINGS);
  assert.deepEqual(normalizeShortcutBindings(JSON.parse(JSON.stringify(DEFAULT_SHORTCUT_BINDINGS))), DEFAULT_SHORTCUT_BINDINGS);
});

test("个人组合键替代原键位并准确区分所有修饰键", () => {
  const binding = { code: "KeyK", meta: true, ctrl: false, alt: true, shift: true };
  const bindings = normalizeShortcutBindings({ "bookmark-2": binding });
  assert.deepEqual(validateShortcutBindings(bindings), []);
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ code: "KeyK", key: "˚", altKey: true, shiftKey: true }), bindings), "bookmark-2");
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ code: "Digit2", key: "2" }), bindings), null);
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ code: "KeyK", key: "k", altKey: true }), bindings), null);
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ code: "KeyK", key: "K", altKey: true, shiftKey: true, ctrlKey: true }), bindings), null);
  assert.equal(formatShortcutBinding(binding), "⌥⇧⌘K");
  assert.equal(shortcutBindingAriaLabel(binding), "Option + Shift + Command + K");
  assert.equal(formatShortcutBinding({ code: "MetaBoth", meta: true, ctrl: false, alt: false, shift: false }), "⌘⌘");
  assert.equal(shortcutBindingAriaLabel({ code: "MetaBoth", meta: true, ctrl: false, alt: false, shift: false }), "左右 Command");
  assert.equal(formatShortcutBinding({ code: "MetaBoth", meta: true, ctrl: false, alt: false, shift: true }), "⇧⌘⌘");
  assert.equal(shortcutBindingAriaLabel({ code: "MetaBoth", meta: true, ctrl: false, alt: false, shift: true }), "Shift + 左右 Command");
  const controlBindings = normalizeShortcutBindings({ "history-back": { code: "KeyE", meta: false, ctrl: true, alt: false, shift: true } });
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ metaKey: false, ctrlKey: true, shiftKey: true, code: "KeyE", key: "E" }), controlBindings), "history-back");
});

test("停用同时影响网页按键和原生命令，重置恢复默认且不修改输入", () => {
  const input = { "bookmark-1": null };
  const bindings = normalizeShortcutBindings(input);
  assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ key: "1" }), bindings), null);
  assert.equal(workbenchShortcutFromCustomEvent({ detail: { command: "bookmark-1" } }, bindings), null);
  assert.equal(workbenchShortcutFromCustomEvent({ detail: { command: "bookmark-2" } }, bindings), "bookmark-2");
  assert.deepEqual(input, { "bookmark-1": null });
  bindings["bookmark-2"].code = "KeyE";
  assert.equal(normalizeShortcutBindings()["bookmark-2"].code, "Digit2");
  assert.equal(formatShortcutBinding(null), "未设置");
});

test("非法和已知保留组合被拒绝，既有默认占用只允许本命令保留", () => {
  for (const binding of ["Cmd+K", { code: "KeyK" }, { code: "KeyK", meta: false, ctrl: false, alt: true, shift: false }]) {
    assert.equal(validateShortcutBindings({ "bookmark-1": binding })[0].kind, "invalid");
  }
  for (const binding of [
    { code: "KeyQ", meta: true, ctrl: false, alt: false, shift: false },
    { code: "KeyR", meta: false, ctrl: true, alt: false, shift: false },
    { code: "KeyK", meta: false, ctrl: true, alt: true, shift: false },
    { code: "Digit2", meta: true, ctrl: false, alt: false, shift: false },
  ]) {
    assert.equal(validateShortcutBindings({ "bookmark-1": binding })[0].kind, "reserved");
    assert.deepEqual(normalizeShortcutBindings({ "bookmark-1": binding })["bookmark-1"], DEFAULT_SHORTCUT_BINDINGS["bookmark-1"]);
  }
  assert.deepEqual(validateShortcutBindings({ "bookmark-1": DEFAULT_SHORTCUT_BINDINGS["bookmark-1"] }), []);
});

test("重复绑定报告相关命令，损坏导入和未归一化调用都不会随机执行", () => {
  const binding = { code: "KeyK", meta: true, ctrl: false, alt: true, shift: true };
  const input = { ...DEFAULT_SHORTCUT_BINDINGS, "bookmark-1": binding, "bookmark-3": binding };
  const issue = validateShortcutBindings(input)[0];
  assert.equal(issue.kind, "conflict");
  assert.equal(issue.command, "bookmark-3");
  assert.equal(issue.conflictsWith, "bookmark-1");
  const normalized = normalizeShortcutBindings(input);
  assert.equal(normalized["bookmark-1"], null);
  assert.equal(normalized["bookmark-3"], null);
  const event = keyboard({ code: "KeyK", key: "K", altKey: true, shiftKey: true });
  assert.equal(workbenchShortcutFromKeyboardEvent(event, normalized), null);
  assert.equal(workbenchShortcutFromKeyboardEvent(event, input), null);
});

test("输入法、已处理事件和普通输入目标均不触发页面命令", () => {
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }, { getModifierState: (key) => key === "AltGraph" }]) {
    assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ key: "1", ...extra })), null);
  }
  for (const matchingSelector of ["input", "textarea", "select", '[contenteditable]:not([contenteditable="false"])', '[role="textbox"]', '[role="combobox"]', '[aria-modal="true"]', '[data-workbench-shortcuts="off"]']) {
    const target = { closest: (selectors) => selectors.split(", ").includes(matchingSelector) ? {} : null };
    assert.equal(shouldIgnoreWorkbenchShortcutTarget(target), true, matchingSelector);
    assert.equal(workbenchShortcutFromKeyboardEvent(keyboard({ key: "1", target })), null, matchingSelector);
  }
});

test("无 code 的按键与键盘布局变体仍可录入，普通文字和单修饰键不能录入", () => {
  assert.equal(shortcutBindingFromKeyboardEvent(keyboard({ key: "k" })).code, "KeyK");
  assert.equal(shortcutBindingFromKeyboardEvent(keyboard({ key: "[" })).code, "BracketLeft");
  assert.equal(shortcutBindingFromKeyboardEvent(keyboard({ code: "Backquote", key: "Dead" })).code, "Backquote");
  assert.equal(shortcutBindingFromKeyboardEvent(keyboard({ key: "Meta", code: "MetaLeft" })), null);
  assert.equal(shortcutBindingFromKeyboardEvent(keyboard({ key: "k", metaKey: false })), null);
});

test("提交校验拒绝未知命令、多余绑定字段和非对象配置", () => {
  for (const value of [null, undefined, [], "Cmd+K", 1]) {
    assert.equal(validateShortcutBindings(value)[0].kind, "invalid");
  }
  assert.equal(validateShortcutBindings({ ...DEFAULT_SHORTCUT_BINDINGS, "unknown-command": null })[0].kind, "invalid");
  const extraField = { ...DEFAULT_SHORTCUT_BINDINGS, "bookmark-1": { ...DEFAULT_SHORTCUT_BINDINGS["bookmark-1"], scope: "system" } };
  const issue = validateShortcutBindings(extraField)[0];
  assert.equal(issue.command, "bookmark-1");
  assert.equal(issue.kind, "invalid");
  assert.deepEqual(validateShortcutBindings({ "bookmark-1": null }), []);
});
