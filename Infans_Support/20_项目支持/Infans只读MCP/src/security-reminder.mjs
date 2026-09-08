import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function reminderMessage(status) {
  if (!status.overdue) return null;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(status.nextDueDateTokyo || "")
    ? status.nextDueDateTokyo
    : "尚未记录";
  return `Infans 只读 MCP 的 90 天安全复查已到期（${due}）。请撤销旧 Tunnel Runtime Key、检查审计并重新连接。`;
}

export async function showMacNotification(message) {
  if (process.platform !== "darwin") return false;
  const safeMessage = String(message).replace(/["\\]/g, "");
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    `display notification "${safeMessage}" with title "Infans 只读 MCP"`,
  ]);
  return true;
}
