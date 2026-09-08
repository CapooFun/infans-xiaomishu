import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

import { JAPANESE_LITERATURE_READING_DIR } from "./vault-paths.mjs";

const LITERATURE_WORKS = Object.freeze([
  Object.freeze({ id: "gon-gitsune", file: "ごん狐.md" }),
  Object.freeze({ id: "tebukuro-wo-kai-ni", file: "手袋を買いに.md" }),
  Object.freeze({ id: "chumon-no-oi-ryoriten", file: "注文の多い料理店.md" }),
  Object.freeze({ id: "wagahai-wa-neko-de-aru", file: "吾輩は猫である.md" }),
]);

function cleanText(value) {
  return String(value ?? "").replace(/[\u200B-\u200F\u2060\uFEFF]/g, "").trim();
}

function dateText(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  return cleanText(value).slice(0, 10);
}

function titleFrom(markdown, fallback) {
  return cleanText(String(markdown ?? "").match(/^#\s+(.+)$/m)?.[1] || fallback);
}

function documentCard(markdown, entry, sourcePath, updatedAt = "") {
  const parsed = matter(String(markdown ?? ""));
  const data = parsed.data || {};
  return {
    id: entry.id,
    title: titleFrom(parsed.content, path.posix.basename(entry.file, ".md")),
    author: cleanText(data.author),
    level: cleanText(data.level),
    note: cleanText(data.description),
    sourceName: cleanText(data.source_name || "青空文库"),
    sourceUrl: /^https:\/\//u.test(cleanText(data.source_url)) ? cleanText(data.source_url) : "",
    sourcePath,
    updatedAt: dateText(data.updated || data.date || updatedAt),
    readTime: Math.max(1, Math.round(parsed.content.replace(/\s+/g, "").length / 650)),
  };
}

function resolveEntry(vaultRoot, entry) {
  const root = path.resolve(vaultRoot);
  const sourcePath = path.posix.join(JAPANESE_LITERATURE_READING_DIR, entry.file);
  const absolute = path.resolve(root, sourcePath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) return null;
  return { root, sourcePath, absolute };
}

async function readEntry(vaultRoot, entry) {
  const resolved = resolveEntry(vaultRoot, entry);
  if (!resolved) return null;
  try {
    const [markdown, stat] = await Promise.all([
      fs.readFile(resolved.absolute, "utf8"),
      fs.stat(resolved.absolute),
    ]);
    return {
      card: documentCard(markdown, entry, resolved.sourcePath, stat.mtime.toISOString()),
      markdown,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function parseJapaneseLiteratureDocument(markdown, entry = LITERATURE_WORKS[0], updatedAt = "") {
  const sourcePath = path.posix.join(JAPANESE_LITERATURE_READING_DIR, entry.file);
  return documentCard(markdown, entry, sourcePath, updatedAt);
}

export async function listJapaneseLiterature(vaultRoot) {
  const documents = await Promise.all(LITERATURE_WORKS.map((entry) => readEntry(vaultRoot, entry)));
  return documents.filter(Boolean).map((document) => document.card);
}

export async function readJapaneseLiteratureDocument(vaultRoot, id) {
  const entry = LITERATURE_WORKS.find((item) => item.id === cleanText(id));
  if (!entry) return null;
  const document = await readEntry(vaultRoot, entry);
  return document ? { ...document.card, markdown: document.markdown } : null;
}
