import { DEFAULT_SHORTCUT_BINDINGS, SHORTCUT_COMMANDS, normalizeShortcutBinding, shortcutBindingSignature } from "./workbench-shortcut-bindings.mjs";
import type { ShortcutBinding, ShortcutBindings, WorkbenchShortcutCommand } from "./workbench-shortcut-bindings.mjs";
export * from "./workbench-shortcut-bindings.mjs";

export const WORKBENCH_SHORTCUT_EVENT = "infans:workbench-shortcut";

const WORKBENCH_SHORTCUT_COMMANDS = new Set(SHORTCUT_COMMANDS.map(({ id }) => id));

type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "isComposing" | "key" | "metaKey" | "repeat" | "shiftKey"
> & Partial<Pick<KeyboardEvent, "target" | "defaultPrevented" | "keyCode" | "getModifierState">>;

export function shortcutBindingFromKeyboardEvent(event: ShortcutKeyboardEvent): ShortcutBinding | null {
  if (event.repeat || event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  const fallbackCodes: Record<string, string> = { "[": "BracketLeft", "]": "BracketRight", "`": "Backquote", "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "-": "Minus", "=": "Equal" };
  const code = event.code && event.code !== "Unidentified" ? event.code
    : /^[a-z]$/i.test(event.key) ? `Key${event.key.toUpperCase()}`
      : /^[0-9]$/.test(event.key) ? `Digit${event.key}` : fallbackCodes[event.key] || event.key;
  return normalizeShortcutBinding({ code, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey });
}

export function workbenchShortcutFromKeyboardEvent(event: ShortcutKeyboardEvent, bindings: ShortcutBindings = DEFAULT_SHORTCUT_BINDINGS): WorkbenchShortcutCommand | null {
  if (event.defaultPrevented || shouldIgnoreWorkbenchShortcutTarget(event.target ?? null)) return null;
  const binding = shortcutBindingFromKeyboardEvent(event);
  if (!binding) return null;
  const signature = shortcutBindingSignature(binding);
  const matches = SHORTCUT_COMMANDS.filter(({ id }) => shortcutBindingSignature(bindings[id]) === signature);
  return matches.length === 1 ? matches[0].id : null;
}

export function workbenchShortcutFromCustomEvent(event: Event, bindings: ShortcutBindings = DEFAULT_SHORTCUT_BINDINGS): WorkbenchShortcutCommand | null {
  const command = (event as CustomEvent<{ command?: unknown }>).detail?.command;
  // Native menu commands keep their identity; null also disables the native bridge.
  return typeof command === "string" && WORKBENCH_SHORTCUT_COMMANDS.has(command as WorkbenchShortcutCommand) && bindings[command as WorkbenchShortcutCommand] != null
    ? command as WorkbenchShortcutCommand
    : null;
}

export function shouldIgnoreWorkbenchShortcutTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [aria-modal="true"], [data-workbench-shortcuts="off"]'));
}

export function mergeSidebarBookmarkOrder<T extends { location: string }>(all: T[], reordered: T[]): T[] {
  const locations = new Set(reordered.map((item) => item.location));
  let nextIndex = 0;
  return all.map((item) => locations.has(item.location) ? reordered[nextIndex++] ?? item : item);
}
