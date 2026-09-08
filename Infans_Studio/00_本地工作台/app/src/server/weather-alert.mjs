/** 气象厅东京地方（23 区 + 多摩），不含伊豆、小笠原。 */
export const TOKYO_MAINLAND_WARNING_AREA = "130010";
export const WEATHER_ALERT_HREF = "/markets";
export const WEATHER_ALERT_LOCATION = "东京";

const ACTIVE_WARNING_STATUSES = new Set(["発表", "継続"]);
/** 大雨、强阵雨、雷雨。普通小雨／中雨不套提醒框。 */
const EXTREME_OBSERVED_WEATHER_CODES = new Set([65, 82, 95, 96, 99]);
const WARNING_KIND_MAP = {
  "03": { kind: "rain", level: "warning", title: "暴雨预警", rank: 80 },
  "10": { kind: "rain", level: "advisory", title: "大雨注意", rank: 50 },
  "33": { kind: "rain", level: "emergency", title: "暴雨预警", rank: 100 },
  "43": { kind: "rain", level: "warning", title: "暴雨预警", rank: 90 },
  "04": { kind: "rain", level: "warning", title: "洪水预警", rank: 78 },
  "18": { kind: "rain", level: "advisory", title: "洪水注意", rank: 48 },
  "34": { kind: "rain", level: "emergency", title: "洪水预警", rank: 98 },
  "05": { kind: "rain", level: "warning", title: "强风预警", rank: 74 },
  "15": { kind: "rain", level: "advisory", title: "强风注意", rank: 42 },
  "14": { kind: "rain", level: "advisory", title: "雷雨提醒", rank: 46 },
};

const SHORT_TITLES = {
  下雨提醒: "下雨",
  暴雨预警: "暴雨",
  暴雨提醒: "暴雨",
  大雨注意: "大雨",
  地震提醒: "地震",
  雷雨提醒: "雷雨",
  强风预警: "强风",
  强风注意: "强风",
  洪水预警: "洪水",
  洪水注意: "洪水",
};

const RAIN_NEWS_MARKERS = /雨|洪水|台风|颱風|雷|警報|注意报/;
const QUAKE_NEWS_MARKERS = /地震|余震/;

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function activeKindCode(entry) {
  if (!entry || typeof entry !== "object") return "";
  const status = String(entry.status || "").trim();
  const code = String(entry.code || "").trim();
  if (!code || !ACTIVE_WARNING_STATUSES.has(status)) return "";
  return code;
}

function collectMainlandKinds(items, areaCode = TOKYO_MAINLAND_WARNING_AREA) {
  const kinds = [];
  for (const item of asArray(items)) {
    if (String(item?.areaCode || item?.code || "") !== areaCode) continue;
    for (const entry of asArray(item?.kinds || item?.warnings)) {
      const code = activeKindCode(entry);
      if (code) kinds.push(code);
    }
  }
  return kinds;
}

export function parseJmaTokyoWarningCodes(payload) {
  const codes = new Set();
  for (const report of asArray(payload)) {
    const warning = report?.warning || report;
    for (const code of collectMainlandKinds(warning?.class10Items)) codes.add(code);
    for (const areaType of asArray(warning?.areaTypes)) {
      for (const code of collectMainlandKinds(areaType?.areas)) codes.add(code);
    }
  }
  return [...codes];
}

export function isExtremeObservedWeather(weatherCode) {
  return EXTREME_OBSERVED_WEATHER_CODES.has(Number(weatherCode));
}

export function parseJmaTokyoQuake(payload, now = new Date()) {
  const horizonMs = 3 * 60 * 60 * 1000;
  const nowMs = new Date(now).getTime();
  let best = null;
  for (const item of asArray(payload)) {
    const place = String(item?.anm || item?.en_anm || item?.area || "");
    if (!place.includes("東京") && !/tokyo/i.test(place)) continue;
    const intensity = Number(item?.maxi ?? item?.maxScale ?? item?.intensity);
    if (!Number.isFinite(intensity) || intensity < 3) continue;
    const at = Date.parse(item?.at || item?.rdt || item?.time || "");
    if (!Number.isFinite(at) || nowMs - at > horizonMs) continue;
    if (!best || intensity > best.intensity) best = { intensity, at };
  }
  return best;
}

function alertRecord({ id, kind, level, title, rank }) {
  return {
    id,
    kind,
    level,
    title,
    shortTitle: SHORT_TITLES[title] || title.slice(0, 2),
    location: WEATHER_ALERT_LOCATION,
    rank,
  };
}

export function weatherNewsElementId(eventId) {
  const id = String(eventId || "").trim();
  return id ? `world-event-${id}` : "market-events";
}

function eventSearchText(event) {
  return `${event?.category || ""}${event?.title || ""}${event?.fact || ""}`;
}

export function matchWeatherNewsEvent(alert, events = []) {
  if (!alert || !Array.isArray(events) || !events.length) return null;
  const disaster = events.filter((event) => event?.category === "灾害");
  const pool = disaster.length ? disaster : events;
  const markers = alert.kind === "earthquake" ? QUAKE_NEWS_MARKERS : RAIN_NEWS_MARKERS;
  return pool.find((event) => markers.test(eventSearchText(event))) || disaster[0] || null;
}

export function weatherAlertHref(alert, events = []) {
  const matched = matchWeatherNewsEvent(alert, events);
  if (matched?.id) return `${WEATHER_ALERT_HREF}#${weatherNewsElementId(matched.id)}`;
  return `${WEATHER_ALERT_HREF}#market-events`;
}

export function selectTokyoWeatherAlert({
  warningCodes = [],
  weatherCode = null,
  precipitationMm = 0,
  quake = null,
  events = [],
} = {}) {
  const candidates = [];
  if (quake?.intensity >= 3) {
    candidates.push(alertRecord({
      id: `tokyo-earthquake-${quake.intensity}`,
      kind: "earthquake",
      level: quake.intensity >= 4 ? "warning" : "advisory",
      title: "地震提醒",
      rank: quake.intensity >= 4 ? 95 : 85,
    }));
  }
  for (const code of warningCodes) {
    const mapped = WARNING_KIND_MAP[String(code)];
    if (!mapped) continue;
    candidates.push(alertRecord({
      id: `tokyo-jma-${code}`,
      kind: mapped.kind,
      level: mapped.level,
      title: mapped.title,
      rank: mapped.rank,
    }));
  }
  if (isExtremeObservedWeather(weatherCode)) {
    candidates.push(alertRecord({
      id: "tokyo-rain-heavy",
      kind: "rain",
      level: "advisory",
      title: "暴雨提醒",
      rank: 44,
    }));
  }
  if (!candidates.length) return null;
  const picked = candidates.sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id))[0];
  return { ...picked, href: weatherAlertHref(picked, events) };
}

export function publicWeatherAlert(alert) {
  if (!alert) return null;
  const { id, kind, level, title, shortTitle, location, href } = alert;
  return { id, kind, level, title, shortTitle, location, href };
}
