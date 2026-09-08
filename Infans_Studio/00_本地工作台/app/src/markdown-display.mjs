import { defaultUrlTransform } from "react-markdown";

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const WIKI_LINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export function stripDisplayFrontmatter(markdown = "") {
  return String(markdown).replace(FRONTMATTER, "");
}

/** 把日语学习原件里用于 Obsidian 的 ruby 与行内学习标签转成安全、可读的标准 Markdown。 */
export function normalizeJapaneseStudyMarkdown(markdown = "") {
  return stripDisplayFrontmatter(markdown)
    .replace(/<ruby>([\s\S]*?)<rt>([\s\S]*?)<\/rt><\/ruby>/gi, (_match, base, reading) => `${base.replace(/<[^>]+>/g, "")}（${reading.replace(/<[^>]+>/g, "")}）`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/^【(歌词|大意|文法|日语|中文)】\s*/gm, "\n\n**$1**　")
    .replace(/^#(大意|文法)\s*/gm, "\n\n**$1**　")
    .replace(/^#\s+[^\n]+\n+/, "")
    .trim();
}

export function vaultMarkdownUrlTransform(url = "") {
  const value = String(url);
  return /^(?:infans-doc|obsidian):/i.test(value) ? value : defaultUrlTransform(value);
}

function readableTarget(target, heading, explicitLabel) {
  if (explicitLabel?.trim()) return explicitLabel.trim();
  const title = String(target || "")
    .replace(/\.md$/i, "")
    .split("/")
    .at(-1)
    ?.replace(/^\d+_/, "")
    .trim();
  if (title && heading) return `${title} · ${heading}`;
  return title || heading || "查看相关档案";
}

function wikiLinkNodes(value, sourcePath) {
  const nodes = [];
  let cursor = 0;
  for (const match of String(value).matchAll(WIKI_LINK)) {
    if (match.index > cursor) nodes.push({ type: "text", value: value.slice(cursor, match.index) });
    const rawTarget = match[1].trim();
    const [filePart, ...headingParts] = rawTarget.split("#");
    const heading = headingParts.join("#").trim();
    const target = (filePart.trim() || sourcePath || "").replace(/\.md$/i, "");
    const label = readableTarget(filePart, heading, match[2]);
    if (target) {
      nodes.push({ type: "text", value: label });
    } else {
      nodes.push({ type: "text", value: label });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

export function remarkVaultWikiLinks(options = {}) {
  const sourcePath = String(options.sourcePath || "").replace(/\.md$/i, "");
  return (tree) => {
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (["code", "inlineCode", "link", "definition"].includes(node.type)) return;
      if (!Array.isArray(node.children)) return;
      const children = [];
      for (const child of node.children) {
        if (child?.type === "text" && WIKI_LINK.test(child.value)) {
          WIKI_LINK.lastIndex = 0;
          children.push(...wikiLinkNodes(child.value, sourcePath));
        } else {
          visit(child);
          children.push(child);
        }
      }
      node.children = children;
    }
    visit(tree);
  };
}
