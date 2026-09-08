// Shared by every derived task view. A stored session is not necessarily a user task.
const PUBLIC_THREAD_SOURCES = new Set(["user", "agent_created_thread", "realtime_voice"]);
const INTERNAL_TITLE = /^(?:the following is the codex agent history|reviewed codex session id\s*:|assess the exact planned action|approval request(?:\s|:|$))/iu;

export function cleanCodexTaskTitle(value) {
  const firstLine = String(value || "").split(/\r?\n|>>>/u, 1)[0]
    .replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return firstLine.length > 72 ? `${firstLine.slice(0, 71).trimEnd()}…` : firstLine;
}

function sourceObject(source) {
  if (source && typeof source === "object") return source;
  try { return JSON.parse(String(source || "")); } catch { return null; }
}

export function codexTaskIdentity(row = {}, metadata = {}) {
  const source = sourceObject(row.source) || sourceObject(metadata.source);
  const threadSource = String(row.thread_source || "").trim();
  // Unknown future thread types stay in the source ledger until explicitly supported.
  const internal = Boolean(source?.subagent)
    || Boolean(threadSource && !PUBLIC_THREAD_SOURCES.has(threadSource))
    || INTERNAL_TITLE.test(cleanCodexTaskTitle(row.title));
  const parentId = String(metadata.parent_thread_id || source?.subagent?.thread_spawn?.parent_thread_id || "").trim();
  return { internal, parentId };
}

export function isInternalCodexTask(task = {}) {
  return task.internal === true || codexTaskIdentity(task).internal;
}
