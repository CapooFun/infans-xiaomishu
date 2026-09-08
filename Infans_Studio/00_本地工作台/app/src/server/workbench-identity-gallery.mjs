/** Display curation only. Never reads biography files or expands linked sources. */
export function parseIdentityGallery(markdown = "") {
  const section = markdown.split(/^## 人生长廊\s*$/m)[1]?.split(/^## /m)[0] || "";
  const seen = new Set();
  const gallery = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().slice(1, -1).replace(/\\\|/g, "\u0000").split("|").map(s => s.trim().replaceAll("\u0000", "|"));
    const [id, era, year, title, summary, detail, source] = cells;
    if (cells.length !== 7 || !/^[a-z][a-z0-9-]+$/.test(id) || !["past", "current"].includes(era) || seen.has(id)) continue;
    if (![year,title,summary,detail,source].every(Boolean) || !source.endsWith(".md") || source.startsWith("/") || source.includes(":") || source.split("/").includes("..")) continue;
    seen.add(id); gallery.push({ id, era, year, title, summary, detail, source });
    if (gallery.length === 24) break;
  }
  return gallery;
}
