/** 简报头条给人扫一眼用，不是把当天新闻串成一段。 */
export const BRIEF_HEADLINE_MAX_CHARS = 32;

/** 眼下这条线在前，世界这头在后。AI 热点默认算眼下这条线。 */
export function canonicalEventLane(value, category) {
  if (String(category ?? "") === "AI热点") return "focus";
  return value === "focus" ? "focus" : "world";
}

export function sortBriefEventsByLane(events) {
  const focus = [];
  const world = [];
  for (const event of Array.isArray(events) ? events : []) {
    (event?.lane === "focus" ? focus : world).push(event);
  }
  return [...focus, ...world];
}

export function displayBriefHeadline(headline, maxChars = BRIEF_HEADLINE_MAX_CHARS) {
  const text = String(headline ?? "").replace(/\s+/g, " ").trim();
  if (!text) return text;
  const sentences = text.split(/(?<=[。！？])/u).map((part) => part.trim()).filter(Boolean);
  let chosen = sentences.length > 1 ? sentences[0] : text;
  chosen = chosen.replace(/[。！？]+$/u, "");
  const chars = [...chosen];
  if (chars.length <= maxChars) return chosen;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}
