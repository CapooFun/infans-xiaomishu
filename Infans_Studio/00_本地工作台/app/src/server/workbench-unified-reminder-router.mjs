const TOKYO_TIME_ZONE = "Asia/Tokyo";

const REMINDER_WORDS = /提醒|待办|记得|别忘|要做|缴|交(?:水电费|房租|账单)|倒垃圾|买(?:药|菜|东西)/u;
const CALENDAR_WORDS = /日历|日程|行程|会议|开会|约会|预约|面试|看电影|吃饭|见面|和[^，。！？]{1,24}(?:去|看|吃|见|聊)/u;
const STRONG_WORDS = /闹钟|强提醒|一定(?:叫|提醒)|千万(?:叫|提醒)|别让我错过|叫我起床|喊我起床|服药|吃药|出门|开票|抢票/u;
const TIMER_WORDS = /计时|倒计时|(?:\d+|[一二两三四五六七八九十百半]+)(?:个)?(?:秒|分钟|小时)(?:之)?后/u;
const MONITOR_WORDS = /一(?:开卖|开售|放票|有票|公布|发布|降价|恢复|开放)|有票就|开卖就|开售就|放票就|公布(?:后|就)|持续(?:看|查|关注|监控)|盯着|监控|价格.{0,8}(?:低于|跌到|降到)/u;
const MUTATION_WORDS = /改到|改成|改为|修改|更改|推迟|提前|取消|删掉|删除|完成|办完|稍后提醒|再提醒/u;
const REFERENCE_WORDS = /刚才|上一个|上一条|那个|这条|它/u;

const DATE_WORDS = /今天|明天|明日|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}月\d{1,2}日|20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/u;
const CLOCK_WORDS = /(?:凌晨|早上|上午|中午|下午|晚上|夜里)?\s*\d{1,2}(?::\d{2}|点(?:\d{1,2}分?)?)/u;
const RELATIVE_TIME_WORDS = /(?:\d+|[一二两三四五六七八九十百半]+)(?:个)?(?:秒|分钟|小时|天)(?:之)?后/u;
const REPEAT_WORDS = /每天|每日|每周|每星期|每礼拜|每月|每年|工作日/u;
const BEFORE_OFFSET_WORDS = /(?:提前|前)(?:\d+|[一二两三四五六七八九十百半]+)(?:个)?(?:分钟|小时|天)/u;

function operationFor(text) {
  if (/取消|删掉|删除/u.test(text)) return "cancel";
  if (/完成|办完/u.test(text)) return "complete";
  if (/稍后提醒|再提醒/u.test(text)) return "snooze";
  if (/改到|改成|改为|修改|更改|推迟|提前/u.test(text)) return "update";
  return "create";
}

function timingFacts(text) {
  return {
    hasDate: DATE_WORDS.test(text),
    hasClock: CLOCK_WORDS.test(text),
    hasRelativeTime: RELATIVE_TIME_WORDS.test(text),
    hasRepeat: REPEAT_WORDS.test(text),
    hasBeforeOffset: BEFORE_OFFSET_WORDS.test(text),
  };
}

function result(kind, executor, operation, facts, options = {}) {
  const missing = [...new Set(options.missing || [])];
  return {
    schemaVersion: 1,
    kind,
    executor,
    operation,
    timeZone: TOKYO_TIME_ZONE,
    timing: facts,
    confidence: options.confidence || "high",
    requiresClarification: missing.length > 0,
    missing,
    ...(options.safeguards?.length ? { safeguards: options.safeguards } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

/**
 * Classifies reminder-like natural language without creating anything.
 * Apple system items remain authoritative; this result is only a routing decision.
 */
export function classifyUnifiedReminderIntent(input = "") {
  const text = String(input || "").replace(/\s+/gu, " ").trim();
  if (!text) return null;
  const operation = operationFor(text);
  const facts = timingFacts(text);
  const mutatingExisting = operation !== "create";

  if (MONITOR_WORDS.test(text)) {
    return result("monitor", "secretary_monitor", operation, facts, {
      missing: operation === "create" && !/(票|价格|公布|发布|预约|开卖|开售|放票|恢复|开放)/u.test(text) ? ["监控对象"] : [],
      reason: "触发条件来自未来外部状态，不能预先当作固定到点提醒。",
    });
  }

  if (TIMER_WORDS.test(text) && !facts.hasBeforeOffset) {
    return result("timer", "alarmkit_timer", operation, facts, {
      missing: facts.hasRelativeTime ? [] : ["时长"],
      reason: "短时相对时间应由 iPhone 本地计时，到点不依赖 Mac 在线。",
    });
  }

  if (CALENDAR_WORDS.test(text) && !STRONG_WORDS.test(text)) {
    return result("calendar", "apple_calendar", operation, facts, {
      missing: mutatingExisting ? [] : [
        ...(!facts.hasDate && !facts.hasRelativeTime ? ["日期"] : []),
        ...(!facts.hasClock && !/全天/u.test(text) ? ["开始时间"] : []),
      ],
      reason: "这是占用时间的安排，写入 Apple Calendar。",
    });
  }

  if (STRONG_WORDS.test(text)) {
    return result("strong_alarm", "alarmkit_alarm", operation, facts, {
      missing: mutatingExisting ? [] : [
        ...(facts.hasBeforeOffset && !facts.hasDate && !facts.hasClock && !REFERENCE_WORDS.test(text) ? ["基准事件时间"] : []),
        ...(!facts.hasDate && !facts.hasRepeat && !facts.hasRelativeTime && !facts.hasBeforeOffset ? ["日期"] : []),
        ...(!facts.hasClock && !facts.hasRelativeTime && !facts.hasBeforeOffset ? ["触发时间"] : []),
      ],
      safeguards: /开票|抢票|服药|吃药|出门|起床/u.test(text) ? ["apple_reminders"] : [],
      reason: "语义要求不可轻易错过，优先由 iPhone 的 AlarmKit 本地调度。",
    });
  }

  const timedNote = /记(?:一下|下来)/u.test(text)
    && (facts.hasDate || facts.hasClock || facts.hasRelativeTime || facts.hasRepeat);
  if (REMINDER_WORDS.test(text) || timedNote || mutatingExisting) {
    return result("reminder", "apple_reminders", operation, facts, {
      missing: mutatingExisting || facts.hasDate || facts.hasClock || facts.hasRelativeTime || facts.hasRepeat ? [] : ["提醒时间"],
      reason: "这是可完成的行动提醒，写入 Apple Reminders。",
    });
  }

  return null;
}
