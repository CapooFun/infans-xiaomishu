type HoldToTalkKeyboardEvent = Pick<
  KeyboardEvent,
  "code" | "key" | "repeat" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing" | "target"
>;

type ShortcutTarget = EventTarget & {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

function isEditableTarget(target: EventTarget | null) {
  if (!target) return false;
  const element = target as ShortcutTarget;
  const tag = element.tagName?.toUpperCase();
  if (tag && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) return true;
  if (element.isContentEditable) return true;
  return Boolean(element.closest?.("[contenteditable='true'],[contenteditable='']"));
}

/** 只让页面空白处的单独空格触发按住说话，不抢输入框和按钮的正常键盘行为。 */
export function isHoldToTalkSpace(event: HoldToTalkKeyboardEvent) {
  const isSpace = event.code === "Space" || event.key === " ";
  return isSpace
    && !event.repeat
    && !event.isComposing
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && !isEditableTarget(event.target);
}

/** 浏览器与原生识别都可能分段回传，始终保留更完整的那一句。 */
export function mergeVoiceTranscript(current: string, incoming: string) {
  const previous = String(current || "").trim();
  const next = String(incoming || "").trim();
  return next.length >= previous.length ? next : previous;
}

/** 给浏览器和原生识别一个收尾窗口，避免松手时最后几个字还没回调。 */
export async function waitForVoiceTranscripts(tasks: Promise<unknown>[], timeoutMs = 1100) {
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
