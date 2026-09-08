const CHINA_TIMEZONES = new Set([
  "Asia/Shanghai",
  "Asia/Chongqing",
  "Asia/Harbin",
  "Asia/Urumqi",
  "Asia/Kashgar",
  "Asia/Hong_Kong",
  "Asia/Macau",
]);

export function clientWeatherRegion(timeZone: string | null | undefined) {
  const zone = String(timeZone || "").trim();
  if (zone === "Asia/Tokyo") return "japan";
  if (CHINA_TIMEZONES.has(zone)) return "china";
  return "other";
}

export function shouldShowLocalWeatherAlert(timeZone: string | null | undefined) {
  return clientWeatherRegion(timeZone) !== "china";
}
