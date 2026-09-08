import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { ensureInside } from "./workbench-data.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { TECHNICAL_DISCUSSIONS_DIR } from "./vault-paths.mjs";

const TECHNICAL_DISCUSSION_FILE_RE = /^[^/\\\0]{1,180}\.md$/u;

function compact(value, limit = 220) {
  const text = String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/\*\*|__|~~|`/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function discussionDateLabel(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Tokyo",
  }).format(new Date(`${date}T12:00:00+09:00`));
}

function normalizedTags(value) {
  if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter(Boolean);
  return String(value || "").split(",").map((tag) => tag.trim()).filter(Boolean);
}

function discussionDate(parsed, fileName) {
  const rawDate = parsed.data?.date;
  const frontmatterDate = rawDate instanceof Date && !Number.isNaN(rawDate.getTime())
    ? rawDate.toISOString().slice(0, 10)
    : String(rawDate || "");
  if (/^20\d{2}-\d{2}-\d{2}$/u.test(frontmatterDate)) return frontmatterDate;
  return fileName.match(/^(20\d{2}-\d{2}-\d{2})_/u)?.[1] || "1970-01-01";
}

export function parseTechnicalDiscussionFile(markdown, fileName) {
  if (!TECHNICAL_DISCUSSION_FILE_RE.test(String(fileName || "")) || fileName === "README.md") return null;
  const parsed = matter(String(markdown || ""));
  const tags = normalizedTags(parsed.data?.tags);
  const isDiscussion = tags.includes("讨论稿");
  const isReaderGuide = tags.includes("面向人说明");
  if (!tags.includes("技术讨论") || (!isDiscussion && !isReaderGuide)) return null;
  const body = parsed.content.trim();
  const fallbackTitle = fileName.slice(0, -3).replace(/^20\d{2}-\d{2}-\d{2}_/u, "").replace(/_/gu, " ");
  const title = compact(body.match(/^#\s+(.+?)\s*$/mu)?.[1] || fallbackTitle, 120);
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gmu)]
    .map((heading) => compact(heading[1], 100))
    .filter(Boolean);
  const date = discussionDate(parsed, fileName);
  const topics = tags.filter((tag) => !["收藏夹", "技术讨论", "讨论稿", "面向人说明"].includes(tag)).slice(0, 4);
  return {
    summary: {
      id: fileName.slice(0, -3),
      date,
      dateLabel: date === "1970-01-01" ? "日期未记录" : discussionDateLabel(date),
      title,
      description: compact(parsed.data?.description || "这份技术讨论没有填写简介。", 220),
      headings,
      topics,
      sourcePath: path.posix.join(TECHNICAL_DISCUSSIONS_DIR, fileName),
    },
    markdown: body,
  };
}

async function readTechnicalDiscussionFile(root, fileName) {
  const sourcePath = path.posix.join(TECHNICAL_DISCUSSIONS_DIR, fileName);
  const markdown = await fs.readFile(ensureInside(root, sourcePath), "utf8");
  const discussion = parseTechnicalDiscussionFile(markdown, fileName);
  if (!discussion) throw new WorkbenchWriteError("这不是可展示的技术讨论", 404, "TECHNICAL_DISCUSSION_NOT_REFERENCE");
  return discussion;
}

export async function listTechnicalDiscussions(root) {
  const directory = ensureInside(root, TECHNICAL_DISCUSSIONS_DIR);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { sourcePath: TECHNICAL_DISCUSSIONS_DIR, discussions: [] };
    throw error;
  }
  const discussions = (await Promise.all(entries
    .filter((entry) => entry.isFile() && TECHNICAL_DISCUSSION_FILE_RE.test(entry.name) && entry.name !== "README.md")
    .map(async (entry) => {
      try {
        return await readTechnicalDiscussionFile(root, entry.name);
      } catch (error) {
        if (error?.code === "TECHNICAL_DISCUSSION_NOT_REFERENCE") return null;
        throw error;
      }
    })))
    .filter(Boolean)
    .map((discussion) => discussion.summary)
    .sort((left, right) => right.date.localeCompare(left.date) || left.title.localeCompare(right.title, "zh-CN"));
  return { sourcePath: TECHNICAL_DISCUSSIONS_DIR, discussions };
}

export async function readTechnicalDiscussion(root, id) {
  const key = String(id || "").trim();
  if (!key || key.length > 180 || key === "." || key === ".." || /[/\\\0]/u.test(key)) {
    throw new WorkbenchWriteError("请选择有效的技术讨论", 400, "TECHNICAL_DISCUSSION_ID_INVALID");
  }
  try {
    return await readTechnicalDiscussionFile(root, `${key}.md`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkbenchWriteError("找不到这份技术讨论", 404, "TECHNICAL_DISCUSSION_NOT_FOUND");
    }
    throw error;
  }
}
