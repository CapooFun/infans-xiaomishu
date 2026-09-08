import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { ensureInside } from "./workbench-data.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { MEETING_MINUTES_DIR } from "./vault-paths.mjs";

const MEETING_MINUTE_FILE_RE = /^(20\d{2}-\d{2}-\d{2})_([\p{L}\p{N}_-]{1,120})\.md$/u;
const MEETING_MINUTE_ID_RE = /^20\d{2}-\d{2}-\d{2}_[\p{L}\p{N}_-]{1,120}$/u;

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

function meetingDateLabel(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(`${date}T12:00:00+09:00`));
}

export function parseMeetingMinuteFile(markdown, fileName) {
  const match = String(fileName || "").match(MEETING_MINUTE_FILE_RE);
  if (!match) return null;
  const parsed = matter(String(markdown || ""));
  const body = parsed.content.trim();
  const title = compact(body.match(/^#\s+(.+?)\s*$/mu)?.[1] || match[2].replace(/_/gu, " "), 120);
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gmu)]
    .map((heading) => compact(heading[1], 100))
    .filter(Boolean);
  const date = /^20\d{2}-\d{2}-\d{2}$/u.test(String(parsed.data?.date || ""))
    ? String(parsed.data.date)
    : match[1];
  return {
    summary: {
      id: fileName.slice(0, -3),
      date,
      dateLabel: meetingDateLabel(date),
      title,
      description: compact(parsed.data?.description || "这份纪要没有填写简介。", 220),
      headings,
      sourcePath: path.posix.join(MEETING_MINUTES_DIR, fileName),
    },
    markdown: body,
  };
}

async function readMeetingMinuteFile(root, fileName) {
  const sourcePath = path.posix.join(MEETING_MINUTES_DIR, fileName);
  const markdown = await fs.readFile(ensureInside(root, sourcePath), "utf8");
  return parseMeetingMinuteFile(markdown, fileName);
}

export async function listMeetingMinutes(root) {
  const directory = ensureInside(root, MEETING_MINUTES_DIR);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { sourcePath: MEETING_MINUTES_DIR, minutes: [] };
    throw error;
  }
  const fileNames = entries
    .filter((entry) => entry.isFile() && MEETING_MINUTE_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  const minutes = await Promise.all(fileNames.map((fileName) => readMeetingMinuteFile(root, fileName)));
  return { sourcePath: MEETING_MINUTES_DIR, minutes: minutes.map((minute) => minute.summary) };
}

export async function readMeetingMinute(root, id) {
  const key = String(id || "").trim();
  if (!MEETING_MINUTE_ID_RE.test(key)) {
    throw new WorkbenchWriteError("请选择有效的会议纪要", 400, "MEETING_MINUTE_ID_INVALID");
  }
  try {
    return await readMeetingMinuteFile(root, `${key}.md`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new WorkbenchWriteError("找不到这份会议纪要", 404, "MEETING_MINUTE_NOT_FOUND");
    }
    throw error;
  }
}
