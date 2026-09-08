export function isAppleMobileBrowser(navigatorLike = typeof navigator === "undefined" ? null : navigator) {
  if (!navigatorLike) return false;
  const userAgent = String(navigatorLike.userAgent || "");
  const platform = String(navigatorLike.platform || "");
  const maxTouchPoints = Number(navigatorLike.maxTouchPoints || 0);
  return /iPad|iPhone|iPod/.test(userAgent)
    || (platform === "MacIntel" && maxTouchPoints > 1);
}

export function isMacDesktopBrowser(navigatorLike = typeof navigator === "undefined" ? null : navigator) {
  if (!navigatorLike) return false;
  const userAgent = String(navigatorLike.userAgent || "");
  return !isAppleMobileBrowser(navigatorLike) && /Macintosh|Mac OS X/.test(userAgent);
}
