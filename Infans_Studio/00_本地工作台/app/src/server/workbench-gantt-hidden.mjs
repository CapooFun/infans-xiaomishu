import fs from "node:fs/promises";
import path from "node:path";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";
import { GANTT_HIDDEN_PATH } from "./vault-paths.mjs";

const MAX_TEXTS = 200;

function emptyHidden() {
  return { texts: [] };
}

function normalizeTexts(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_TEXTS) break;
  }
  return out;
}

function normalizeHidden(raw) {
  return { texts: normalizeTexts(raw?.texts) };
}

export function ganttHiddenPath(vaultRoot) {
  return path.resolve(vaultRoot, GANTT_HIDDEN_PATH);
}

async function writeHiddenFile(absolute, payload) {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.infans-tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(temporary, absolute);
}

async function readHiddenFrom(absolute) {
  try {
    const text = await fs.readFile(absolute, "utf8");
    return normalizeHidden(JSON.parse(text));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyHidden();
    throw error;
  }
}

export async function readGanttHidden(vaultRoot) {
  return readHiddenFrom(ganttHiddenPath(vaultRoot));
}

/** 日程页本地隐藏清单：不改 Vault 待办正文，只影响工作台展示。 */
export async function writeGanttHidden(vaultRoot, payload = {}) {
  return withVaultFileWrite(vaultRoot, GANTT_HIDDEN_PATH, async (absolute) => {
    const next = normalizeHidden({
      texts: payload.texts !== undefined ? payload.texts : (await readHiddenFrom(absolute)).texts,
    });
    await writeHiddenFile(absolute, next);
    return next;
  });
}

export function todoHideKey(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase();
}

export function hiddenTextKeys(texts = []) {
  return new Set((Array.isArray(texts) ? texts : []).map((text) => todoHideKey(text)).filter(Boolean));
}

/** 首页近 2 日约会按标题对照隐藏清单；不改苹果日历原件。 */
export function filterVisibleCalendarEvents(events = [], texts = []) {
  const keys = hiddenTextKeys(texts);
  if (!keys.size || !Array.isArray(events)) return Array.isArray(events) ? events : [];
  return events.filter((event) => !keys.has(todoHideKey(event?.title)));
}

export function applyHiddenCalendarEvents(snapshot, texts = []) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  return { ...snapshot, events: filterVisibleCalendarEvents(events, texts) };
}
