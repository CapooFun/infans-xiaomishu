import { interpretSecretaryDictation } from "../secretary-identity.mjs";
import { resolveScheduleDate, tokyoDateKey } from "./workbench-schedule-date.mjs";

const CHINESE_DURATION_DIGITS = new Map([
  ["半", 0.5], ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4], ["五", 5],
  ["六", 6], ["七", 7], ["八", 8], ["九", 9], ["十", 10], ["百", 100],
]);

function chineseDurationNumber(raw) {
  if (/^\d+(?:\.\d+)?$/u.test(raw)) return Number(raw);
  if (raw === "半") return 0.5;
  if (raw === "十") return 10;
  if (raw.includes("十")) {
    const [left, right] = raw.split("十");
    return (left ? CHINESE_DURATION_DIGITS.get(left) || 0 : 1) * 10 + (right ? CHINESE_DURATION_DIGITS.get(right) || 0 : 0);
  }
  return CHINESE_DURATION_DIGITS.get(raw) || null;
}

function durationSecondsFromText(text) {
  const matched = String(text || "").match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十百半]+)(?:个)?(秒|分钟|小时)(?:之)?后/u);
  if (!matched) return null;
  const value = chineseDurationNumber(matched[1]);
  if (!(value > 0)) return null;
  return value * (matched[2] === "小时" ? 3_600 : matched[2] === "分钟" ? 60 : 1);
}

function explicitClockMinutes(text) {
  const matched = String(text || "").match(/(凌晨|早上|上午|中午|下午|晚上|夜里)?\s*(\d{1,2})(?::(\d{2})|点(?:(\d{1,2})分?)?)/u);
  if (!matched) return null;
  let hour = Number(matched[2]);
  const minute = Number(matched[3] ?? matched[4] ?? 0);
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return null;
  if (/凌晨|早上|上午/u.test(matched[1] || "") && hour === 12) hour = 0;
  if (/下午|晚上|夜里/u.test(matched[1] || "") && hour < 12) hour += 12;
  if ((matched[1] || "") === "中午" && hour < 11) hour += 12;
  return hour * 60 + minute;
}

function generatedTimeMatchesCommand(fireAt, command) {
  const interpreted = interpretSecretaryDictation(command?.text);
  const generated = new Date(String(fireAt || ""));
  if (Number.isNaN(generated.getTime())) return false;
  const reference = new Date(command?.createdAt || Date.now());
  const hasExplicitDate = /今天|今日|明天|明日|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}月\d{1,2}日|20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/u.test(interpreted);
  if (hasExplicitDate) {
    const expectedDate = resolveScheduleDate(interpreted, Number.isNaN(reference.getTime()) ? new Date() : reference);
    if (tokyoDateKey(generated) !== expectedDate) return false;
  }
  const expectedMinutes = explicitClockMinutes(interpreted);
  if (expectedMinutes !== null) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TOKYO_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(generated);
    const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (Number(fields.hour) * 60 + Number(fields.minute) !== expectedMinutes) return false;
  }
  return true;
}

export function unifiedReminderActionFromGenerated(pendingAction, command, target = null) {
  const routing = command?.routing?.unifiedReminder;
  if (!routing) return pendingAction || null;
  if (routing.requiresClarification || routing.executor === "secretary_monitor") return null;
  if (routing.operation !== "create") {
    if (!target?.nativeID || !target?.actionID || !target?.executor) return null;
    if (target.executor === "apple_calendar" && ["complete", "snooze"].includes(routing.operation)) return null;
    if (target.executor === "alarmkit_timer" && ["update", "snooze"].includes(routing.operation)) return null;
    const needsNewTime = ["update", "snooze"].includes(routing.operation);
    if (needsNewTime && pendingAction?.kind !== "calendarCreate") return null;
    const fireAt = needsNewTime ? String(pendingAction.start || "") : undefined;
    if (needsNewTime && !generatedTimeMatchesCommand(fireAt, command)) return null;
    const operationLabel = { update: "修改", cancel: "取消", complete: "完成", snooze: "稍后提醒" }[routing.operation];
    return {
      kind: "unifiedReminder",
      schemaVersion: 1,
      actionID: target.actionID,
      executor: target.executor,
      operation: routing.operation,
      title: String(target.title || command.text).trim().slice(0, 160),
      timeZone: "Asia/Tokyo",
      nativeID: target.nativeID,
      ...(fireAt ? { fireAt } : {}),
      ...(target.executor === "apple_calendar" && needsNewTime ? { endAt: String(pendingAction.end || "") } : {}),
      ...(Array.isArray(target.safeguardExecutors) ? { safeguardExecutors: target.safeguardExecutors } : {}),
      label: `${operationLabel}系统提醒`,
      summary: `${operationLabel}：${String(target.title || command.text).trim().slice(0, 160)}`,
      requiresConfirm: false,
    };
  }
  if (pendingAction?.kind !== "calendarCreate") return null;
  const fireAt = String(pendingAction.start || "");
  const endAt = String(pendingAction.end || "");
  const durationSeconds = routing.executor === "alarmkit_timer" ? durationSecondsFromText(command.text) : null;
  if (routing.executor === "alarmkit_timer" && !durationSeconds) return null;
  if (routing.executor !== "alarmkit_timer" && !generatedTimeMatchesCommand(fireAt, command)) return null;
  return {
    kind: "unifiedReminder",
    schemaVersion: 1,
    actionID: command.commandId,
    executor: routing.executor,
    operation: routing.operation,
    title: String(pendingAction.title || command.text).trim().slice(0, 160),
    timeZone: "Asia/Tokyo",
    ...(routing.executor === "alarmkit_timer" ? { durationSeconds } : { fireAt }),
    ...(routing.executor === "apple_calendar" ? { endAt, containerTitle: pendingAction.calendar } : {}),
    ...(routing.executor === "alarmkit_alarm" && routing.safeguards?.length ? { safeguardExecutors: routing.safeguards } : {}),
    label: routing.executor === "apple_reminders"
      ? "创建 Apple 提醒事项"
      : routing.executor === "apple_calendar"
        ? "创建 Apple 日历事件"
        : routing.executor === "alarmkit_timer"
          ? "启动本机计时器"
          : "创建本机强提醒",
    summary: String(pendingAction.title || command.text).trim().slice(0, 160),
    requiresConfirm: false,
  };
}
