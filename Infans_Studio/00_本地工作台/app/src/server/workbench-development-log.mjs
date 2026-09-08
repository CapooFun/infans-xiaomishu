import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { ensureInside } from "./workbench-data.mjs";
import { DIARY_DIR } from "./vault-paths.mjs";

const DAILY_LOG_FILE = /^(20\d{2}-\d{2}-\d{2})\.md$/;

function cleanHeading(value) {
  return String(value || "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseDailyLogFile(markdown, fileName) {
  const match = String(fileName || "").match(DAILY_LOG_FILE);
  if (!match) return null;
  const parsed = matter(String(markdown || ""));
  const body = parsed.content.trim();
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)]
    .map((heading) => cleanHeading(heading[1]))
    .filter(Boolean);
  return {
    date: match[1],
    description: String(parsed.data?.description || "").trim(),
    headings,
    markdown: body,
    sourcePath: path.posix.join(DIARY_DIR, fileName),
  };
}

export async function readDevelopmentLog(root) {
  const directory = ensureInside(root, DIARY_DIR);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && DAILY_LOG_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  const loaded = await Promise.all(fileNames.map(async (fileName) => {
    const file = ensureInside(root, path.posix.join(DIARY_DIR, fileName));
    const [markdown, stat] = await Promise.all([
      fs.readFile(file, "utf8"),
      fs.stat(file),
    ]);
    return { day: parseDailyLogFile(markdown, fileName), mtimeMs: stat.mtimeMs };
  }));

  return {
    updatedAt: new Date(Math.max(0, ...loaded.map((item) => item.mtimeMs))).toISOString(),
    sourcePath: DIARY_DIR,
    days: loaded.map((item) => item.day).filter(Boolean),
  };
}
