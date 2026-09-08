import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { readLanguageReactorData } from "./workbench-language-reactor.mjs";
import { JAPANESE_COLLECTION_INDEX, JAPANESE_KNOWLEDGE_CARDS_DIR } from "./vault-paths.mjs";

const CATEGORIES = new Set(["语言常识", "书写习惯", "词义与意象", "词源考据", "语法记忆", "学习经验"]);
const VERIFICATIONS = new Set(["已核验", "待核验", "个人记法"]);
const DOCUMENT_TYPES = new Set(["歌曲精读", "行业用语", "动漫用语", "学习经验", "实用表达"]);
const JAPANESE_ROOT_PREFIX = "55_语言学习/日语/";

function text(value) {
  return String(value ?? "").replace(/[\u200B-\u200F\u2060\uFEFF]/g, "").trim();
}

function dateText(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  return text(value).slice(0, 10);
}

function cleanInline(value) {
  return text(value)
    .replace(/<rt>[\s\S]*?<\/rt>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, label) => label || target)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

function titleFrom(content, fallback) {
  return cleanInline(content.match(/^#\s+(.+)$/m)?.[1] || fallback);
}

function sectionMap(content) {
  const sections = new Map();
  const source = String(content ?? "");
  const matches = [...source.matchAll(/^##\s+(.+)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const start = current.index + current[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    sections.set(cleanInline(current[1]), source.slice(start, end).trim());
  }
  return sections;
}

function paragraph(value) {
  return cleanInline(String(value ?? "")
    .split(/\n\s*\n/)
    .map((item) => item.replace(/^[-*]\s+/gm, "").replace(/\n/g, " ").trim())
    .filter(Boolean)
    .join("\n\n"));
}

function bullets(value) {
  return String(value ?? "")
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1])
    .filter(Boolean)
    .map(cleanInline);
}

function sourceList(raw) {
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    if (typeof item === "string") return [{ label: cleanInline(item), url: "", path: "" }];
    if (!item || typeof item !== "object") return [];
    const url = text(item.url);
    const sourcePath = text(item.path).replace(/^\/+/, "");
    if (url && !url.startsWith("https://")) return [];
    if (sourcePath && (sourcePath.includes("..") || path.isAbsolute(sourcePath))) return [];
    const label = cleanInline(item.label || sourcePath || url);
    return label ? [{ label, url, path: sourcePath }] : [];
  });
}

export function parseJapaneseKnowledgeCard(markdown, relativePath = "") {
  const parsed = matter(String(markdown ?? ""));
  const id = text(parsed.data.cardId);
  if (!id || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) return null;
  const sections = sectionMap(parsed.content);
  const category = CATEGORIES.has(parsed.data.category) ? parsed.data.category : "学习经验";
  const verification = VERIFICATIONS.has(parsed.data.verification) ? parsed.data.verification : "待核验";
  const summary = cleanInline(parsed.data.summary || paragraph(sections.get("核心结论")));
  return {
    id,
    kind: "knowledge",
    cardType: "知识点",
    title: titleFrom(parsed.content, parsed.data.title || id),
    summary,
    category,
    verification,
    explanation: paragraph(sections.get("展开说明")),
    memoryHook: paragraph(sections.get("我的记法")),
    rules: bullets(sections.get("正确规则")),
    boundaries: bullets(sections.get("适用边界")),
    examples: bullets(sections.get("例子")),
    sources: sourceList(parsed.data.sources),
    tags: Array.isArray(parsed.data.tags) ? parsed.data.tags.map(cleanInline).filter(Boolean) : [],
    updatedAt: dateText(parsed.data.updated || parsed.data.date),
    sourcePath: text(relativePath).replace(/\\/g, "/"),
  };
}

function safeCollectionSourcePath(value) {
  const normalized = text(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith(JAPANESE_ROOT_PREFIX) || !normalized.endsWith(".md") || normalized.includes("..") || path.posix.isAbsolute(normalized)) return "";
  return normalized;
}

export function parseJapaneseCollectionIndex(markdown) {
  const parsed = matter(String(markdown ?? ""));
  const seen = new Set();
  return (Array.isArray(parsed.data.cards) ? parsed.data.cards : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = text(item.id);
    const cardType = text(item.type);
    const category = cleanInline(item.category);
    const sourcePath = safeCollectionSourcePath(item.path);
    if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id) || seen.has(id) || !DOCUMENT_TYPES.has(cardType) || !category || !sourcePath || sourcePath === JAPANESE_COLLECTION_INDEX) return [];
    seen.add(id);
    return [{ id, cardType, category, sourcePath }];
  });
}

function summaryFromDocument(parsed) {
  if (parsed.data.description) return cleanInline(parsed.data.description);
  const candidate = String(parsed.content ?? "")
    .split(/\n\s*\n/)
    .map((block) => block.replace(/^#{1,6}\s+.*$/gm, "").replace(/^>\s?/gm, "").trim())
    .find((block) => block && !/^\|/.test(block));
  return cleanInline(candidate).slice(0, 180);
}

function readTime(markdown) {
  const readable = cleanInline(String(markdown ?? "").replace(/^---[\s\S]*?---\s*/m, ""));
  return Math.max(1, Math.round(readable.length / 650));
}

export function parseJapaneseCollectionDocument(markdown, entry, fileUpdatedAt = "") {
  const parsed = matter(String(markdown ?? ""));
  const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags.map(cleanInline).filter(Boolean) : [];
  return {
    id: entry.id,
    kind: "document",
    cardType: entry.cardType,
    category: entry.category,
    title: titleFrom(parsed.content, parsed.data.title || path.posix.basename(entry.sourcePath, ".md")),
    summary: summaryFromDocument(parsed),
    tags,
    updatedAt: dateText(parsed.data.updated || parsed.data.date || fileUpdatedAt),
    sourcePath: entry.sourcePath,
    readTime: readTime(parsed.content),
    _searchText: cleanInline(`${parsed.content} ${tags.join(" ")}`),
  };
}

async function readCollectionIndex(vaultRoot) {
  try {
    return parseJapaneseCollectionIndex(await fs.readFile(path.join(path.resolve(vaultRoot), JAPANESE_COLLECTION_INDEX), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function readJapaneseCollectionDocuments(vaultRoot) {
  const root = path.resolve(vaultRoot);
  const entries = await readCollectionIndex(root);
  const documents = await Promise.all(entries.map(async (entry) => {
    const absolute = path.resolve(root, entry.sourcePath);
    if (!absolute.startsWith(`${root}${path.sep}`)) return null;
    try {
      const [markdown, stat] = await Promise.all([fs.readFile(absolute, "utf8"), fs.stat(absolute)]);
      return parseJapaneseCollectionDocument(markdown, entry, stat.mtime.toISOString());
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }));
  return documents.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.title.localeCompare(b.title, "zh-CN"));
}

function publicDocumentCard(card) {
  const { _searchText, ...publicCard } = card;
  return publicCard;
}

export async function readJapaneseCollectionDocumentById(vaultRoot, id) {
  const root = path.resolve(vaultRoot);
  const entry = (await readCollectionIndex(root)).find((item) => item.id === text(id));
  if (!entry) return null;
  const absolute = path.resolve(root, entry.sourcePath);
  if (!absolute.startsWith(`${root}${path.sep}`)) return null;
  try {
    const [markdown, stat] = await Promise.all([fs.readFile(absolute, "utf8"), fs.stat(absolute)]);
    return { ...publicDocumentCard(parseJapaneseCollectionDocument(markdown, entry, stat.mtime.toISOString())), markdown };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function readJapaneseKnowledgeCards(vaultRoot) {
  const root = path.resolve(vaultRoot);
  const directory = path.resolve(root, JAPANESE_KNOWLEDGE_CARDS_DIR);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const cards = await Promise.all(files.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    return parseJapaneseKnowledgeCard(await fs.readFile(absolute, "utf8"), relative);
  }));
  return cards.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.title.localeCompare(b.title, "zh-CN"));
}

function corpusSourceName(title) {
  return String(title || "").split(" · ")[0] || title;
}

function corpusItem(item) {
  return { ...item, kind: item.type };
}

function reviewRank(id, dateKey) {
  return crypto.createHash("sha256").update(`${dateKey}:${id}`).digest("hex");
}

export function selectJapaneseKnowledgeReview(cards, dateKey, count = 5) {
  return [...cards]
    .sort((a, b) => reviewRank(a.id, dateKey).localeCompare(reviewRank(b.id, dateKey)))
    .slice(0, Math.max(1, Math.min(20, Number(count) || 5)));
}

export async function queryJapaneseCollection(vaultRoot, options = {}) {
  const [knowledgeCards, documents, reactor] = await Promise.all([
    readJapaneseKnowledgeCards(vaultRoot),
    readJapaneseCollectionDocuments(vaultRoot),
    readLanguageReactorData(vaultRoot),
  ]);
  const corpus = (reactor?.items ?? []).map(corpusItem);
  const requestedScope = text(options.scope);
  const scope = requestedScope === "knowledge" ? "cards" : ["all", "cards", "corpus"].includes(requestedScope) ? requestedScope : "all";
  const cardType = text(options.cardType || "全部类型");
  const category = text(options.category || "全部分类");
  const verification = text(options.verification || "全部状态");
  const source = text(options.source || "全部作品");
  const corpusType = ["all", "phrase", "word"].includes(options.corpusType) ? options.corpusType : "all";
  const query = text(options.q).toLocaleLowerCase("ja");
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 60));
  const review = Math.max(0, Math.min(20, Number(options.review) || 0));
  const dateKey = text(options.dateKey) || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  let filteredKnowledge = knowledgeCards.filter((card) => {
    if (cardType !== "全部类型" && card.cardType !== cardType) return false;
    if (category !== "全部分类" && card.category !== category) return false;
    if (verification !== "全部状态" && card.verification !== verification) return false;
    if (!query) return true;
    return `${card.title} ${card.summary} ${card.explanation} ${card.memoryHook} ${card.rules.join(" ")} ${card.boundaries.join(" ")} ${card.examples.join(" ")} ${card.tags.join(" ")}`.toLocaleLowerCase("ja").includes(query);
  });
  if (review) filteredKnowledge = selectJapaneseKnowledgeReview(filteredKnowledge, dateKey, review);

  const filteredDocuments = documents.filter((card) => {
    if (cardType !== "全部类型" && card.cardType !== cardType) return false;
    if (category !== "全部分类" && card.category !== category) return false;
    if (verification !== "全部状态") return false;
    if (!query) return true;
    return `${card.title} ${card.summary} ${card.cardType} ${card.category} ${card.tags.join(" ")} ${card._searchText}`.toLocaleLowerCase("ja").includes(query);
  });

  const filteredCorpus = corpus.filter((item) => {
    if (corpusType !== "all" && item.type !== corpusType) return false;
    if (source !== "全部作品" && corpusSourceName(item.sourceTitle) !== source) return false;
    if (!query) return true;
    return `${item.sentence} ${item.translation} ${item.transliteration} ${item.word} ${(item.wordTranslations || []).join(" ")} ${item.previous} ${item.next} ${item.sourceTitle}`.toLocaleLowerCase("ja").includes(query);
  });

  const filteredCards = [...filteredKnowledge, ...filteredDocuments];
  const base = scope === "cards" ? filteredCards : scope === "corpus" ? filteredCorpus : [...filteredCards, ...filteredCorpus];
  const items = review
    ? filteredKnowledge
    : [...base].sort((a, b) => String(b.updatedAt || b.modifiedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.modifiedAt || a.createdAt || "")));
  const publicItems = items.map((item) => item.kind === "document" ? publicDocumentCard(item) : item);
  const sources = [...new Set(corpus.map((item) => corpusSourceName(item.sourceTitle)).filter(Boolean))];
  return {
    items: publicItems.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
    review: Boolean(review),
    stats: {
      total: knowledgeCards.length + documents.length + corpus.length,
      cards: knowledgeCards.length + documents.length,
      documents: documents.length,
      knowledge: knowledgeCards.length,
      songs: documents.filter((item) => item.cardType === "歌曲精读").length,
      industry: documents.filter((item) => item.cardType === "行业用语").length,
      anime: documents.filter((item) => item.cardType === "动漫用语").length,
      methods: documents.filter((item) => item.cardType === "学习经验").length,
      expressions: documents.filter((item) => item.cardType === "实用表达").length,
      phrases: corpus.filter((item) => item.type === "phrase").length,
      words: corpus.filter((item) => item.type === "word").length,
    },
    cardTypes: ["全部类型", "知识点", "歌曲精读", "行业用语", "动漫用语", "学习经验", "实用表达"].filter((item) => item === "全部类型" || knowledgeCards.some((card) => card.cardType === item) || documents.some((card) => card.cardType === item)),
    categories: ["全部分类", ...new Set([...knowledgeCards, ...documents].map((card) => card.category))],
    verifications: ["全部状态", "已核验", "个人记法", "待核验"],
    sources: ["全部作品", ...sources],
  };
}
