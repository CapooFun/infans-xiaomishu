/** Shared command registry and serializable bindings; no browser state or persistence. */
export const SHORTCUT_COMMANDS = Object.freeze([
  ...Array.from({ length: 6 }, (_, index) => Object.freeze({ id: `bookmark-${index + 1}`, label: `打开书签 ${index + 1}`, group: "书签" })),
  Object.freeze({ id: "history-back", label: "返回上一页", group: "浏览" }),
  Object.freeze({ id: "history-forward", label: "前进下一页", group: "浏览" }),
  Object.freeze({ id: "toggle-sidebar", label: "展开／收起侧栏", group: "浏览" }),
]);

const defaultCodes = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "BracketLeft", "BracketRight", "Backquote"];
export const DEFAULT_SHORTCUT_BINDINGS = Object.freeze(Object.fromEntries(SHORTCUT_COMMANDS.map(({ id }, index) => [id,
  Object.freeze({ code: defaultCodes[index], meta: true, ctrl: false, alt: false, shift: false }),
])));

const validCode = /^(?:Key[A-Z]|Digit[0-9]|BracketLeft|BracketRight|Backquote|Backslash|Semicolon|Quote|Comma|Period|Slash|Minus|Equal|Escape|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|F(?:[1-9]|1[0-2]))$/;
const modifiers = ["meta", "ctrl", "alt", "shift"];
const bindingKeys = new Set(["code", ...modifiers]);
const commandIds = new Set(SHORTCUT_COMMANDS.map(({ id }) => id));

export function normalizeShortcutBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !bindingKeys.has(key)) || typeof value.code !== "string" || !validCode.test(value.code)) return null;
  if (modifiers.some((key) => typeof value[key] !== "boolean")) return null;
  // A plain letter or Option combination may be ordinary text or an IME shortcut.
  if (!value.meta && !value.ctrl) return null;
  return { code: value.code, meta: value.meta, ctrl: value.ctrl, alt: value.alt, shift: value.shift };
}

export function shortcutBindingSignature(binding) {
  if (!binding) return "";
  return [...modifiers.filter((key) => binding[key]), binding.code].join("+");
}

export function shortcutBindingWarning(binding, command) {
  if (!binding) return "";
  if (command && shortcutBindingSignature(binding) === shortcutBindingSignature(DEFAULT_SHORTCUT_BINDINGS[command])) return "";
  const { code, meta, ctrl, alt, shift } = binding;
  const primary = meta || ctrl;
  const plain = primary && !alt && !shift;
  const editingOrBrowser = /^(?:Key[ABCDFHILMNOPQRSTVWXZY]|Digit[0-9]|Comma|Minus|Equal|BracketLeft|BracketRight|Backquote|Home|End|PageUp|PageDown)$/;
  const browserShift = /^(?:Key[BCDHIKMNOPQTUVWZ]|Digit[0-9]|Minus|Equal)$/;
  const browserAlt = /^(?:Key[CIJLU]|ArrowLeft|ArrowRight)$/;
  const system = (meta && ctrl) || (ctrl && alt) || /^F(?:[1-9]|1[0-2])$/.test(code)
    || (meta && /^(?:ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(code))
    || (ctrl && !meta && /^(?:ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(code));
  if (system || (plain && editingOrBrowser.test(code)) || (primary && shift && !alt && browserShift.test(code)) || (primary && alt && browserAlt.test(code))) {
    return "这个组合键通常由系统或浏览器使用，请换一个组合键。";
  }
  return "";
}

function readBindings(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(SHORTCUT_COMMANDS.map(({ id }) => {
    if (!Object.hasOwn(input, id)) return [id, { ...DEFAULT_SHORTCUT_BINDINGS[id] }];
    if (input[id] === null) return [id, null];
    const binding = normalizeShortcutBinding(input[id]);
    return [id, binding && !shortcutBindingWarning(binding, id) ? binding : { ...DEFAULT_SHORTCUT_BINDINGS[id] }];
  }));
}

export function validateShortcutBindings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{ command: null, kind: "invalid", message: "快捷键设置格式无效，请重新设置。" }];
  const input = value;
  const issues = [];
  if (Object.keys(input).some((key) => !commandIds.has(key))) issues.push({ command: null, kind: "invalid", message: "包含未登记的快捷键命令，请重新设置。" });
  const bindings = readBindings(value);
  const used = new Map();
  for (const { id, label } of SHORTCUT_COMMANDS) {
    if (Object.hasOwn(input, id) && input[id] !== null) {
      const binding = normalizeShortcutBinding(input[id]);
      if (!binding) issues.push({ command: id, kind: "invalid", message: "请使用 Command 或 Control 加另一个按键，也可以加入 Shift 或 Option。" });
      else {
        const message = shortcutBindingWarning(binding, id);
        if (message) issues.push({ command: id, kind: "reserved", message });
      }
    }
    const signature = shortcutBindingSignature(bindings[id]);
    if (!signature) continue;
    const previous = used.get(signature);
    if (previous) issues.push({ command: id, kind: "conflict", conflictsWith: previous.id, message: `「${label}」与「${previous.label}」使用了同一个组合键。` });
    else used.set(signature, { id, label });
  }
  return issues;
}

export function normalizeShortcutBindings(value) {
  const bindings = readBindings(value);
  // Corrupt or imported duplicate bindings must never execute an arbitrary command.
  const counts = new Map();
  for (const binding of Object.values(bindings)) {
    const signature = shortcutBindingSignature(binding);
    if (signature) counts.set(signature, (counts.get(signature) || 0) + 1);
  }
  for (const { id } of SHORTCUT_COMMANDS) {
    if ((counts.get(shortcutBindingSignature(bindings[id])) || 0) > 1) bindings[id] = null;
  }
  return bindings;
}

const codeLabels = {
  BracketLeft: "[", BracketRight: "]", Backquote: "`", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Minus: "−", Equal: "=",
  Escape: "Esc",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Home: "Home", End: "End", PageUp: "Page Up", PageDown: "Page Down",
};

export function formatShortcutBinding(binding) {
  if (!binding) return "未设置";
  if (binding.code === "MetaBoth") return binding.shift ? "⇧⌘⌘" : "⌘⌘";
  const key = codeLabels[binding.code] || binding.code.replace(/^(?:Key|Digit)/, "");
  return [binding.ctrl && "⌃", binding.alt && "⌥", binding.shift && "⇧", binding.meta && "⌘", key].filter(Boolean).join("");
}

export function shortcutBindingAriaLabel(binding) {
  if (!binding) return "未设置";
  if (binding.code === "MetaBoth") return binding.shift ? "Shift + 左右 Command" : "左右 Command";
  const key = codeLabels[binding.code] || binding.code.replace(/^(?:Key|Digit)/, "");
  return [binding.ctrl && "Control", binding.alt && "Option", binding.shift && "Shift", binding.meta && "Command", key].filter(Boolean).join(" + ");
}
