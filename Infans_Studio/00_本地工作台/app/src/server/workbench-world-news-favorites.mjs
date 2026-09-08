import fs from "node:fs/promises";
import path from "node:path";

import {
  MARKET_BRIEF,
  MARKET_BRIEF_HISTORY_DIR,
  WORLD_NEWS_CURRENT,
  WORLD_NEWS_FAVORITES_PATH,
  worldNewsHistoryDir,
} from "./vault-paths.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";

const MAX_FAVORITES = 400;
const LANES = new Set(["finance", "ai", "games", "japan"]);
const SIGNALS = new Set(["like", "dislike"]);
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
let writeQueue = Promise.resolve();

export function worldNewsFavoriteKey(lane, asOf, eventId) {
  return `${lane}:${asOf}:${eventId}`;
}

export function worldNewsFavoritesPath(vaultRoot) {
  return path.resolve(vaultRoot, WORLD_NEWS_FAVORITES_PATH);
}

function cleanText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeItem(item) {
  const lane = String(item?.lane || "").trim();
  const asOf = String(item?.asOf || "").trim();
  const eventId = String(item?.eventId || "").trim();
  const signal = String(item?.signal || "like").trim();
  if (!LANES.has(lane) || !AS_OF_RE.test(asOf) || !EVENT_ID_RE.test(eventId) || !SIGNALS.has(signal)) return null;
  return {
    key: worldNewsFavoriteKey(lane, asOf, eventId),
    lane,
    asOf,
    eventId,
    title: cleanText(item?.title, 120),
    category: cleanText(item?.category, 40),
    signal,
    savedAt: Number.isFinite(Date.parse(item?.savedAt)) ? new Date(item.savedAt).toISOString() : new Date(0).toISOString(),
  };
}

function emptySnapshot() {
  return { schemaVersion: 1, items: [] };
}

async function readStored(vaultRoot) {
  try {
    const raw = JSON.parse(await fs.readFile(worldNewsFavoritesPath(vaultRoot), "utf8"));
    const seen = new Set();
    const items = [];
    for (const candidate of Array.isArray(raw?.items) ? raw.items : []) {
      const item = normalizeItem(candidate);
      if (!item || seen.has(item.key)) continue;
      seen.add(item.key);
      items.push(item);
      if (items.length >= MAX_FAVORITES) break;
    }
    return { schemaVersion: 1, items };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return emptySnapshot();
    throw error;
  }
}

async function writeStored(vaultRoot, items) {
  const absolute = worldNewsFavoritesPath(vaultRoot);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.infans-tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, absolute);
    await fs.chmod(absolute, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function extractEvents(markdown, startMarker) {
  const match = String(markdown || "").match(new RegExp(`${startMarker}[\\s\\S]*?\`\`\`json\\s*([\\s\\S]*?)\\s*\`\`\``));
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

function briefRelativePath(lane, asOf, currentDate) {
  if (lane === "finance") {
    return currentDate === asOf ? MARKET_BRIEF : path.posix.join(MARKET_BRIEF_HISTORY_DIR, `${asOf}.md`);
  }
  const current = WORLD_NEWS_CURRENT[lane];
  if (!current) return "";
  return currentDate === asOf ? current : path.posix.join(worldNewsHistoryDir(lane), `${asOf}.md`);
}

function frontmatterDate(markdown) {
  return String(markdown || "").match(/^date:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1] || "";
}

async function readOptional(vaultRoot, relativePath) {
  if (!relativePath) return "";
  try {
    return await fs.readFile(path.resolve(vaultRoot, relativePath), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw error;
  }
}

export async function findWorldNewsEvent(vaultRoot, { lane, asOf, eventId }) {
  if (!LANES.has(lane) || !AS_OF_RE.test(asOf) || !EVENT_ID_RE.test(eventId)) return null;
  const currentRel = lane === "finance" ? MARKET_BRIEF : WORLD_NEWS_CURRENT[lane];
  const currentMarkdown = await readOptional(vaultRoot, currentRel);
  const currentDate = frontmatterDate(currentMarkdown);
  const relativePath = briefRelativePath(lane, asOf, currentDate);
  const markdown = relativePath === currentRel ? currentMarkdown : await readOptional(vaultRoot, relativePath);
  if (!markdown) return null;
  const marker = lane === "finance" ? "INFANS_MARKET_BRIEF_JSON_START" : "INFANS_WORLD_BRIEF_JSON_START";
  const event = extractEvents(markdown, marker).find((item) => String(item?.id || "") === eventId);
  if (!event) return null;
  return {
    lane,
    asOf,
    eventId,
    title: cleanText(event.title, 120),
    category: cleanText(event.category, 40),
  };
}

export async function readWorldNewsFavorites(vaultRoot) {
  return readStored(vaultRoot);
}

export async function writeWorldNewsFavorite(vaultRoot, payload = {}) {
  const lane = String(payload.lane || "").trim();
  const asOf = String(payload.asOf || "").trim();
  const eventId = String(payload.eventId || "").trim();
  const signal = String(payload.signal || "like").trim();
  if (!LANES.has(lane) || !AS_OF_RE.test(asOf) || !EVENT_ID_RE.test(eventId)) {
    throw new WorkbenchWriteError("这条新闻不能标记", 400, "INVALID_WORLD_NEWS_FAVORITE");
  }
  if (typeof payload.saved !== "boolean") {
    throw new WorkbenchWriteError("标记状态不正确", 400, "INVALID_WORLD_NEWS_FAVORITE_STATE");
  }
  if (payload.saved && !SIGNALS.has(signal)) {
    throw new WorkbenchWriteError("只能收藏或不喜欢", 400, "INVALID_WORLD_NEWS_REACTION");
  }
  const key = worldNewsFavoriteKey(lane, asOf, eventId);
  const operation = writeQueue.then(async () => {
    const current = await readStored(vaultRoot);
    if (!payload.saved) {
      const next = { schemaVersion: 1, items: current.items.filter((item) => item.key !== key) };
      if (next.items.length !== current.items.length) await writeStored(vaultRoot, next.items);
      return next;
    }
    const found = await findWorldNewsEvent(vaultRoot, { lane, asOf, eventId });
    if (!found) throw new WorkbenchWriteError("找不到这条新闻，可能已经换日或不在当天稿里", 409, "WORLD_NEWS_EVENT_NOT_FOUND");
    const existing = current.items.find((item) => item.key === key);
    const saved = {
      ...found,
      key,
      signal,
      savedAt: existing?.signal === signal ? existing.savedAt : new Date().toISOString(),
    };
    const nextItems = [saved, ...current.items.filter((item) => item.key !== key)].slice(0, MAX_FAVORITES);
    await writeStored(vaultRoot, nextItems);
    return { schemaVersion: 1, items: nextItems };
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}
