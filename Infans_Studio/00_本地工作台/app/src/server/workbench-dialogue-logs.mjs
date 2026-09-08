import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { ensureInside } from "./workbench-data.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { PRIVATE_DIALOGUE_DIARY_DIR } from "./vault-paths.mjs";

const DIALOGUE_DAY_FILE_RE = /^(20\d{2}-\d{2}-\d{2})\.md$/u;
const SPEAKER_RE = /^\s*\*\*([^*\n：:]{1,80})[：:]\*\*\s*(.*)$/u;
const USER_SPEAKER_RE = /^(?:用户|我)$/iu;

function compact(value, limit = 180) {
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

function dialogueDayLabel(date) {
  const parsed = new Date(`${date}T12:00:00+09:00`);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" }).format(parsed);
}

function cleanMessageMarkdown(lines) {
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.join("\n").trim();
}

/** 把对话日志原件中的角色标记转成只读聊天流；说明文字和施工段落不冒充聊天。 */
export function parseDialogueLogThread(markdown = "") {
  const lines = matter(String(markdown || "")).content.split(/\r?\n/u);
  const items = [];
  let current = null;
  let pendingDivider = "";
  let sequence = 0;

  const flush = () => {
    if (!current) return;
    const body = cleanMessageMarkdown(current.lines);
    if (body) {
      if (pendingDivider) {
        items.push({ id: `divider-${sequence += 1}`, kind: "divider", label: pendingDivider });
        pendingDivider = "";
      }
      items.push({
        id: `message-${sequence += 1}`,
        kind: "message",
        role: USER_SPEAKER_RE.test(current.speaker) ? "user" : "assistant",
        speaker: current.speaker,
        markdown: body,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const speaker = line.match(SPEAKER_RE);
    if (speaker) {
      flush();
      current = { speaker: compact(speaker[1], 60), lines: [speaker[2]] };
      continue;
    }

    const section = line.match(/^##\s+(.+?)\s*$/u);
    if (section) {
      flush();
      const label = compact(section[1], 100);
      pendingDivider = /给未来 AI 的阅读说明/u.test(label) ? "" : label;
      continue;
    }

    if (/^###\s+对话片段\s+/u.test(line)) {
      flush();
      continue;
    }

    if (current) current.lines.push(line);
  }
  flush();
  return items;
}

async function readDialogueDay(root, fileName) {
  const match = fileName.match(DIALOGUE_DAY_FILE_RE);
  if (!match) throw new WorkbenchWriteError("对话日志日期格式不对", 400, "DIALOGUE_LOG_DATE_INVALID");
  const date = match[1];
  const sourcePath = path.posix.join(PRIVATE_DIALOGUE_DIARY_DIR, fileName);
  const markdown = await fs.readFile(ensureInside(root, sourcePath), "utf8");
  const parsed = matter(markdown);
  const items = parseDialogueLogThread(markdown);
  const messages = items.filter((item) => item.kind === "message");
  const userCount = messages.filter((item) => item.role === "user").length;
  return {
    summary: {
      date,
      dateLabel: dialogueDayLabel(date),
      description: compact(parsed.data?.description || "这一天的对话", 180),
      messageCount: messages.length,
      userCount,
      assistantCount: messages.length - userCount,
    },
    items,
  };
}

export async function listDialogueLogDays(root) {
  const directory = ensureInside(root, PRIVATE_DIALOGUE_DIARY_DIR);
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return { logs: [] }; throw error; }
  const fileNames = entries
    .filter((entry) => entry.isFile() && DIALOGUE_DAY_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  const days = await Promise.all(fileNames.map((fileName) => readDialogueDay(root, fileName)));
  return { logs: days.map((day) => day.summary) };
}

export async function readDialogueLogDay(root, date) {
  const key = String(date || "").trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(key)) throw new WorkbenchWriteError("请选择有效的对话日期", 400, "DIALOGUE_LOG_DATE_INVALID");
  try { return await readDialogueDay(root, `${key}.md`); }
  catch (error) {
    if (error?.code === "ENOENT") throw new WorkbenchWriteError("找不到这一天的对话日志", 404, "DIALOGUE_LOG_NOT_FOUND");
    throw error;
  }
}
