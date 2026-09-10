/** 本机级快捷键登记：关灯、截屏、截进对话、朗读与听写。不负责小秘书窗口内的书签导航键。 */
import { formatShortcutBinding, normalizeShortcutBinding, shortcutBindingSignature } from "./workbench-shortcut-bindings.mjs";

export const COMPUTER_SHORTCUT_COMMANDS = Object.freeze([
  Object.freeze({
    id: "lights-off",
    label: "关灯模式",
    group: "电脑",
    scope: "这台 Mac 随时可用",
  }),
  Object.freeze({
    id: "screenshot-full",
    label: "全屏截图",
    group: "截屏",
    scope: "这台 Mac 随时可用",
    symbolicHotKey: 28,
  }),
  Object.freeze({
    id: "screenshot-selection",
    label: "框选截图",
    group: "截屏",
    scope: "这台 Mac 随时可用",
    symbolicHotKey: 30,
  }),
  Object.freeze({
    id: "agent-screenshot-chat",
    label: "截进 Cursor 对话",
    group: "截屏",
    scope: "这台 Mac 随时可用，贴进 Cursor",
  }),
  Object.freeze({
    id: "agent-read-aloud",
    label: "秘书朗读",
    group: "对话",
    scope: "Codex 或 Cursor 在前台时",
  }),
  Object.freeze({
    id: "agent-dictation",
    label: "听写麦克风",
    group: "对话",
    scope: "Codex 或 Cursor 在前台时",
  }),
]);

export const DEFAULT_COMPUTER_SHORTCUT_BINDINGS = Object.freeze({
  "lights-off": Object.freeze({ code: "Escape", meta: true, ctrl: false, alt: false, shift: false }),
  "screenshot-full": Object.freeze({ code: "Digit3", meta: true, ctrl: false, alt: false, shift: true }),
  "screenshot-selection": Object.freeze({ code: "Digit4", meta: true, ctrl: false, alt: false, shift: true }),
  "agent-screenshot-chat": Object.freeze({ code: "MetaBoth", meta: true, ctrl: false, alt: false, shift: true }),
  "agent-read-aloud": Object.freeze({ code: "Period", meta: true, ctrl: false, alt: false, shift: false }),
  "agent-dictation": Object.freeze({ code: "Comma", meta: true, ctrl: false, alt: false, shift: false }),
});

export const CURSOR_VOICE_COMMAND = "composer.toggleVoiceDictation";

const VSCODE_KEY_BY_CODE = Object.freeze({
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
  Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  Comma: ",", Period: ".", Slash: "/", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Backslash: "\\", Backquote: "`",
});

const commandIds = new Set(COMPUTER_SHORTCUT_COMMANDS.map((item) => item.id));

const MAC_KEYCODE_BY_CODE = Object.freeze({
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9,
  KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25,
  Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32,
  BracketLeft: 33, KeyI: 34, KeyP: 35, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40, Semicolon: 41,
  Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47, Backquote: 50,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  Escape: 53,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
});

const MAC_ASCII_BY_CODE = Object.freeze({
  Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
  Equal: 61, Minus: 45, BracketLeft: 91, BracketRight: 93, Quote: 39, Semicolon: 59,
  Backslash: 92, Comma: 44, Slash: 47, Period: 46, Backquote: 96,
});

const COMMAND_FLAG = 1 << 20;
const SHIFT_FLAG = 1 << 17;
const OPTION_FLAG = 1 << 19;
const CONTROL_FLAG = 1 << 18;

function macKeyCode(code) {
  return Number.isInteger(MAC_KEYCODE_BY_CODE[code]) ? MAC_KEYCODE_BY_CODE[code] : null;
}

function macAscii(code) {
  if (Number.isInteger(MAC_ASCII_BY_CODE[code])) return MAC_ASCII_BY_CODE[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].charCodeAt(0);
  return 0;
}

export function macModifierFlags(binding) {
  if (!binding) return 0;
  return (binding.meta ? COMMAND_FLAG : 0)
    | (binding.shift ? SHIFT_FLAG : 0)
    | (binding.alt ? OPTION_FLAG : 0)
    | (binding.ctrl ? CONTROL_FLAG : 0);
}

function isCursorScreenshotBinding(value) {
  return Boolean(
    value
    && value.code === "MetaBoth"
    && value.meta === true
    && value.ctrl === false
    && value.alt === false
    && value.shift === true
  );
}

function parseComputerBinding(value) {
  if (
    value
    && value.code === "MetaBoth"
    && value.meta === true
    && value.ctrl === false
    && value.alt === false
  ) {
    return { ...DEFAULT_COMPUTER_SHORTCUT_BINDINGS["agent-screenshot-chat"] };
  }
  return normalizeShortcutBinding(value);
}

function computerBindingSupported(binding, id) {
  if (!binding) return true;
  if (id === "agent-screenshot-chat") return isCursorScreenshotBinding(binding);
  if (isCursorScreenshotBinding(binding)) return false;
  return macKeyCode(binding.code) != null;
}

function readBindings(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(COMPUTER_SHORTCUT_COMMANDS.map(({ id }) => {
    if (!Object.hasOwn(input, id)) return [id, { ...DEFAULT_COMPUTER_SHORTCUT_BINDINGS[id] }];
    if (input[id] === null) return [id, null];
    const binding = parseComputerBinding(input[id]);
    if (id === "lights-off" && shortcutBindingSignature(binding) === "meta+F12") {
      return [id, { ...DEFAULT_COMPUTER_SHORTCUT_BINDINGS[id] }];
    }
    return [id, binding || { ...DEFAULT_COMPUTER_SHORTCUT_BINDINGS[id] }];
  }));
}

export function validateComputerShortcutBindings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ command: null, kind: "invalid", message: "快捷键设置格式无效，请重新设置。" }];
  }
  const issues = [];
  if (Object.keys(value).some((key) => !commandIds.has(key))) {
    issues.push({ command: null, kind: "invalid", message: "包含未登记的本机快捷键，请重新设置。" });
  }
  const bindings = readBindings(value);
  const used = new Map();
  for (const { id, label } of COMPUTER_SHORTCUT_COMMANDS) {
    if (Object.hasOwn(value, id) && value[id] !== null) {
      const binding = parseComputerBinding(value[id]);
      if (!binding) {
        issues.push({ command: id, kind: "invalid", message: "请使用 Command 或 Control 加另一个按键，也可以加入 Shift 或 Option。" });
        continue;
      }
      if (!computerBindingSupported(binding, id)) {
        issues.push({ command: id, kind: "unsupported", message: "这个按键还不能登记成本机快捷键，请换一个。" });
      }
    }
    const signature = shortcutBindingSignature(bindings[id]);
    if (!signature) continue;
    const previous = used.get(signature);
    if (previous) {
      issues.push({ command: id, kind: "conflict", conflictsWith: previous.id, message: `「${label}」与「${previous.label}」使用了同一个组合键。` });
    } else used.set(signature, { id, label });
  }
  return issues;
}

export function normalizeComputerShortcutBindings(value) {
  const bindings = readBindings(value);
  const counts = new Map();
  for (const binding of Object.values(bindings)) {
    const signature = shortcutBindingSignature(binding);
    if (signature) counts.set(signature, (counts.get(signature) || 0) + 1);
  }
  for (const { id } of COMPUTER_SHORTCUT_COMMANDS) {
    const binding = bindings[id];
    if (!binding) continue;
    if (!computerBindingSupported(binding, id) || (counts.get(shortcutBindingSignature(binding)) || 0) > 1) {
      bindings[id] = null;
    }
  }
  return bindings;
}

export function vscodeShortcutKey(binding) {
  if (!binding) return null;
  const letter = /^Key([A-Z])$/.exec(binding.code);
  const key = letter ? letter[1].toLowerCase() : VSCODE_KEY_BY_CODE[binding.code];
  if (!key) return null;
  const parts = [];
  if (binding.ctrl) parts.push("ctrl");
  if (binding.alt) parts.push("alt");
  if (binding.shift) parts.push("shift");
  if (binding.meta) parts.push("cmd");
  parts.push(key);
  return parts.join("+");
}

export function computerShortcutConflictNotes(bindings) {
  const notes = {};
  const dictation = shortcutBindingSignature(bindings["agent-dictation"]);
  if (dictation === "meta+Comma") {
    notes["agent-dictation"] = "Cursor 自己的设置也占用这个组合。保存后会取消设置键，并打开听写。";
  }
  const full = shortcutBindingSignature(bindings["screenshot-full"]);
  const selection = shortcutBindingSignature(bindings["screenshot-selection"]);
  if (full === "meta+shift+Digit3") {
    notes["screenshot-full"] = "这是 Mac 系统原来的全屏截图键。";
  }
  if (selection === "meta+shift+Digit4") {
    notes["screenshot-selection"] = "这是 Mac 系统原来的框选截图键。";
  }
  if (full === "meta+shift+Slash") {
    notes["screenshot-full"] = "会和 Cursor 切模型参数抢键，也占用各软件帮助菜单。";
  }
  if (full === "meta+BracketLeft") {
    notes["screenshot-full"] = "会抢走浏览器和小秘书里原来的返回上一页。";
  }
  if (selection === "meta+BracketRight") {
    notes["screenshot-selection"] = "会抢走浏览器和小秘书里原来的前进下一页。";
  }
  if (full === "meta+KeyZ") {
    notes["screenshot-full"] = "会抢走几乎所有软件里的撤销。";
  }
  if (isCursorScreenshotBinding(bindings["agent-screenshot-chat"])) {
    notes["agent-screenshot-chat"] = "Shift 加左右 Command。任意软件前台都可用：截鼠标所在那块屏，交给 Cursor 当前对话。不加 Shift 的 ⌘⌘ 留给 Codex。";
  }
  if (shortcutBindingSignature(bindings["lights-off"]) === "meta+Escape") {
    notes["lights-off"] = "副屏切掉，Mac 只留一点光。再按一次恢复。系统强制退出是 Option+Command+Esc。";
  }
  return notes;
}

export function nativeComputerShortcutMap(bindings) {
  const lightsOff = bindings["lights-off"];
  const readAloud = bindings["agent-read-aloud"];
  const dictation = bindings["agent-dictation"];
  const screenshot = bindings["agent-screenshot-chat"];
  return {
    lightsOff: {
      enabled: Boolean(lightsOff),
      keyCode: lightsOff ? macKeyCode(lightsOff.code) : null,
      modifiers: macModifierFlags(lightsOff),
    },
    readAloud: {
      enabled: Boolean(readAloud),
      keyCode: readAloud ? macKeyCode(readAloud.code) : null,
      modifiers: macModifierFlags(readAloud),
    },
    dictation: {
      enabled: Boolean(dictation),
      keyCode: dictation ? macKeyCode(dictation.code) : null,
      modifiers: macModifierFlags(dictation),
    },
    agentScreenshot: {
      enabled: Boolean(screenshot),
    },
  };
}

export function screenshotHotKeyPayload(bindings) {
  return Object.fromEntries(["screenshot-full", "screenshot-selection"].map((id) => {
    const command = COMPUTER_SHORTCUT_COMMANDS.find((item) => item.id === id);
    const binding = bindings[id];
    return [id, {
      id: command.symbolicHotKey,
      enabled: Boolean(binding),
      ascii: binding ? macAscii(binding.code) : 0,
      keyCode: binding ? macKeyCode(binding.code) : 0,
      modifiers: macModifierFlags(binding),
    }];
  }));
}

export function presentComputerShortcuts(bindings, { revision = 0 } = {}) {
  const normalized = normalizeComputerShortcutBindings(bindings);
  const notes = computerShortcutConflictNotes(normalized);
  return {
    schemaVersion: 1,
    revision,
    commands: COMPUTER_SHORTCUT_COMMANDS.map(({ id, label, group, scope }) => ({
      id,
      label,
      group,
      scope,
      binding: normalized[id],
      display: formatShortcutBinding(normalized[id]),
      note: notes[id] || "",
    })),
    bindings: normalized,
    native: nativeComputerShortcutMap(normalized),
    screenshots: screenshotHotKeyPayload(normalized),
  };
}

export function cursorSettingsUnbindNeeded(bindings) {
  return shortcutBindingSignature(bindings["agent-dictation"]) === "meta+Comma";
}

export function cursorVoiceShortcutKey(bindings) {
  return vscodeShortcutKey(bindings["agent-dictation"]);
}

export { formatShortcutBinding, shortcutBindingSignature };
