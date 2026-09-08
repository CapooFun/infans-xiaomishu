/** Presentation-only navigation helpers; no content or persistent state. */
export function navigationHref(path: string, values: Record<string, string | number | null | undefined> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value != null && value !== "") params.set(key, String(value));
  return `${path}${params.size ? `?${params}` : ""}`;
}

export function visibleTrailIndices(length: number, compact: boolean) {
  if (length <= (compact ? 2 : 4)) return Array.from({ length }, (_, index) => index);
  return compact ? [0, length - 1] : [0, length - 2, length - 1];
}

export function isInternalNavigationHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//") && !/[\\\r\n]/.test(href);
}
