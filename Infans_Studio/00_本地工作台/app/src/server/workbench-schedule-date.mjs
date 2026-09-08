const TOKYO_TIME_ZONE = "Asia/Tokyo";
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_QUESTION_RE = /安排|日程|日历|行程|有什么事|有啥事|要做什么|要干什么|几点有事/u;
const WEEKDAY_INDEX = new Map([
  ["日", 0], ["天", 0], ["一", 1], ["二", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6],
]);

export function tokyoDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TOKYO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function dateKeyFromTokyoNoon(noon) {
  return tokyoDateKey(noon);
}

function tokyoNoonForKey(key) {
  return new Date(`${key}T12:00:00+09:00`);
}

function shiftTokyoDateKey(key, days) {
  return dateKeyFromTokyoNoon(new Date(tokyoNoonForKey(key).getTime() + days * DAY_MS));
}

function explicitDateKey(text, baseKey) {
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/u);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}`;
  const chinese = text.match(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日/u)
    || text.match(/(?<!\d)(\d{1,2})[/.](\d{1,2})(?!\d)/u);
  if (!chinese) return null;
  const baseYear = Number(baseKey.slice(0, 4));
  const hasYear = chinese.length === 4;
  const year = hasYear && chinese[1] ? Number(chinese[1]) : baseYear;
  const month = Number(chinese[hasYear ? 2 : 1]);
  const day = Number(chinese[hasYear ? 3 : 2]);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function resolveScheduleDate(question = "", reference = new Date()) {
  const text = String(question || "");
  const baseKey = tokyoDateKey(reference);
  const explicit = explicitDateKey(text, baseKey);
  if (explicit) return explicit;
  if (/大后天/u.test(text)) return shiftTokyoDateKey(baseKey, 3);
  if (/后天/u.test(text)) return shiftTokyoDateKey(baseKey, 2);
  if (/明天|明日/u.test(text)) return shiftTokyoDateKey(baseKey, 1);
  if (/今天|今日/u.test(text)) return baseKey;

  const weekday = text.match(/(?:星期|礼拜|周)([一二三四五六日天])/u);
  if (!weekday) return baseKey;
  const target = WEEKDAY_INDEX.get(weekday[1]);
  const current = tokyoNoonForKey(baseKey).getUTCDay();
  let delta = (target - current + 7) % 7;
  if (/下(?:个)?(?:星期|礼拜|周)/u.test(text)) delta += 7;
  return shiftTokyoDateKey(baseKey, delta);
}

export function isScheduleQuestion(question = "") {
  return SCHEDULE_QUESTION_RE.test(String(question || ""));
}
