import fs from "node:fs/promises";
import path from "node:path";

import {
  WORLD_NEWS_CURRENT,
  WORLD_NEWS_LANES,
  WORLD_READING_AUDIO_DIR,
  worldNewsHistoryDir,
} from "./vault-paths.mjs";

export const WORLD_NEWS_LANE_IDS = Object.freeze(["ai", "games", "japan"]);

export const WORLD_EVENT_CATEGORIES = Object.freeze({
  ai: Object.freeze(["大模型", "芯片", "工具", "治理", "安全"]),
  games: Object.freeze(["展会", "平台", "发行", "独立", "政策"]),
  japan: Object.freeze(["签证", "生活", "灾害", "交通", "社会", "政治"]),
});

const WORLD_EVENT_LANES = new Set(["now", "ahead"]);

export function parseWorldEventLane(value) {
  return WORLD_EVENT_LANES.has(value) ? value : "now";
}

function parseEventCategory(lane, value) {
  const allowed = WORLD_EVENT_CATEGORIES[lane] || [];
  const text = String(value ?? "").trim();
  return allowed.includes(text) ? text : "";
}

const WORLD_HEADLINE_PROCESS_TALK = /(?:[；;，,]\s*)?(?:昨天.{0,24}仍有效|留下来凑满.{0,16}|凑满\d+[条篇]|官方页还在|今天没有新的(?:官方)?改写)/gu;

export function displayWorldHeadline(headline, events = []) {
  const stripped = String(headline ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(WORLD_HEADLINE_PROCESS_TALK, "")
    .replace(/[；;，,]+$/u, "")
    .trim();
  if (stripped) return stripped;
  const fallback = String(events[0]?.title || "").trim();
  return fallback || "今天没有够格的新闻。";
}

const ALLOWED_RUBY_TAGS = new Set([
  "ruby", "rt", "rp", "p", "br", "span", "em", "strong", "b", "i",
  "h1", "h2", "h3", "h4", "ul", "ol", "li", "div", "article", "section", "time",
]);
const VOID_RUBY_TAGS = new Set(["br"]);
const READING_LEVELS = new Set(["N5", "N4", "N3", "N2"]);
const READING_LEVEL_RANK = Object.freeze({ N5: 0, N4: 1, N3: 2, N2: 3 });
const FURIGANA_SOURCES = new Set(["original", "added"]);
const AUDIO_SOURCES = new Set(["original"]);
const AUDIO_FILE_RE = /^20\d{2}-\d{2}-\d{2}-[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}\.mp3$/;

export function isWorldNewsLaneId(value) {
  return WORLD_NEWS_LANE_IDS.includes(String(value ?? ""));
}

function safeHttpsUrl(value) {
  return /^https:\/\//i.test(String(value ?? "")) ? String(value) : "";
}

function sourceMeta(source) {
  return { path: source.path, updatedAt: source.updatedAt };
}

function briefDateKey(value) {
  return String(value ?? "").match(/(20\d{2}-\d{2}-\d{2})/)?.[1] ?? null;
}

export function emptyWorldLane(lane, extras = {}) {
  const id = isWorldNewsLaneId(lane) ? lane : "ai";
  return {
    schemaVersion: 1,
    lane: id,
    generatedAt: "",
    asOf: "尚未生成",
    headline: "今天没有够格的新闻。",
    status: "quiet",
    events: [],
    calendar: [],
    readings: [],
    note: "等待下一次更新。",
    ...extras,
  };
}

export function sanitizeRubyHtml(html) {
  const text = String(html ?? "");
  if (!text.trim()) return "";
  const stripped = text
    .replace(/<\/(?:script|style|iframe|object|embed)[^>]*>/gi, "")
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src|xlink:href|style|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return stripped.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (all, rawTag) => {
    const tag = String(rawTag).toLowerCase();
    if (!ALLOWED_RUBY_TAGS.has(tag)) return "";
    if (all.startsWith("</")) return `</${tag}>`;
    if (VOID_RUBY_TAGS.has(tag)) return `<${tag}>`;
    return `<${tag}>`;
  });
}

export function isSafeReadingAudioBasename(name) {
  return AUDIO_FILE_RE.test(String(name || ""));
}

export function readingAudioBasename(briefDate, readingId) {
  const date = String(briefDate || "").match(/20\d{2}-\d{2}-\d{2}/)?.[0] ?? "";
  const id = String(readingId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!date || !id || !/^[a-zA-Z0-9]/.test(id)) return "";
  const name = `${date}-${id}.mp3`;
  return isSafeReadingAudioBasename(name) ? name : "";
}

export function resolveReadingAudioAbsolute(root, basename) {
  if (!isSafeReadingAudioBasename(basename)) return "";
  const dir = path.resolve(root, WORLD_READING_AUDIO_DIR);
  const absolute = path.resolve(dir, basename);
  if (absolute !== dir && !absolute.startsWith(`${dir}${path.sep}`)) return "";
  return absolute;
}

export function rubyHtmlToSpeechText(html) {
  return String(html || "")
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
    .replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, "")
    .replace(/<br\s*\/?>/gi, "。")
    .replace(/<\/p>/gi, "。")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .replace(/。{2,}/g, "。")
    .replace(/^。+|。+$/g, "")
    .trim();
}

function parseAudioFile(value) {
  const name = path.posix.basename(String(value || "").replace(/\\/g, "/"));
  return isSafeReadingAudioBasename(name) ? name : "";
}

function parseCalendar(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((event) => {
    const date = String(event?.date ?? "");
    const importance = Math.max(1, Math.min(5, Number(event?.importance) || 1));
    const dateConfirmed = event?.dateConfirmed === true && /^20\d{2}-\d{2}-\d{2}$/.test(date);
    const featured = dateConfirmed && importance === 5 && event?.featured === true;
    return {
      date,
      title: String(event?.title ?? "未命名事件"),
      region: String(event?.region ?? "全球"),
      importance,
      ...(dateConfirmed ? { dateConfirmed: true } : {}),
      ...(featured ? { featured: true } : {}),
      whyWatch: String(event?.whyWatch ?? ""),
      sourceUrl: safeHttpsUrl(event?.sourceUrl),
    };
  }).filter((event) => event.date && event.sourceUrl);
}

function parseVocab(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item) => ({
    word: String(item?.word ?? "").trim(),
    reading: String(item?.reading ?? "").trim(),
    meaning: String(item?.meaning ?? "").trim(),
    note: String(item?.note ?? "").trim(),
  })).filter((item) => item.word);
}

function parseReadings(value) {
  if (!Array.isArray(value)) return [];
  const seenLevels = new Set();
  const readings = value.slice(0, 4).flatMap((item, index) => {
    const level = String(item?.level ?? "").toUpperCase();
    if (!READING_LEVELS.has(level) || seenLevels.has(level)) return [];
    seenLevels.add(level);
    const sourceUrl = safeHttpsUrl(item?.sourceUrl);
    const title = String(item?.title ?? "").trim();
    if (!title || !sourceUrl) return [];
    const furiganaSource = FURIGANA_SOURCES.has(item?.furiganaSource) ? item.furiganaSource : "added";
    const audioSource = AUDIO_SOURCES.has(item?.audioSource) ? item.audioSource : "";
    const id = String(item?.id ?? `reading-${level}-${index}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)
      || `reading-${level}-${index}`;
    return [{
      id,
      level,
      title,
      date: String(item?.date ?? "").match(/20\d{2}-\d{2}-\d{2}/)?.[0] ?? "",
      sourceName: String(item?.sourceName ?? "やさしい朝日新聞").trim() || "やさしい朝日新聞",
      sourceUrl,
      rubyHtml: sanitizeRubyHtml(item?.rubyHtml),
      vocab: parseVocab(item?.vocab),
      furiganaSource,
      audioSource,
      audioUrl: safeHttpsUrl(item?.audioUrl),
      audioFile: parseAudioFile(item?.audioFile),
      audioAvailable: false,
    }];
  });
  return readings.sort((a, b) => (READING_LEVEL_RANK[a.level] ?? 9) - (READING_LEVEL_RANK[b.level] ?? 9));
}

export function parseWorldLaneBrief(markdown, lane = "ai") {
  const empty = emptyWorldLane(lane);
  const raw = String(markdown ?? "").match(/<!-- INFANS_WORLD_BRIEF_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- INFANS_WORLD_BRIEF_JSON_END -->/)?.[1];
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    const resolvedLane = isWorldNewsLaneId(parsed.lane) ? parsed.lane : lane;
    const status = ["active", "quiet", "unavailable"].includes(parsed.status) ? parsed.status : "unavailable";
    const events = Array.isArray(parsed.events) ? parsed.events.slice(0, 8).map((event, index) => ({
      id: String(event?.id ?? `world-${resolvedLane}-${index}`),
      title: String(event?.title ?? "未命名事件"),
      category: parseEventCategory(resolvedLane, event?.category),
      lane: parseWorldEventLane(event?.lane),
      fact: String(event?.fact ?? ""),
      whyItMatters: String(event?.whyItMatters ?? ""),
      impact: String(event?.impact ?? "").trim(),
      watchNext: Array.isArray(event?.watchNext) ? event.watchNext.slice(0, 5).map(String) : [],
      sources: Array.isArray(event?.sources)
        ? event.sources.slice(0, 5).map((source) => ({
          title: String(source?.title ?? "来源"),
          url: safeHttpsUrl(source?.url),
          type: String(source?.type ?? "来源"),
        })).filter((source) => source.url)
        : [],
    })).sort((a, b) => Number(a.lane === "ahead") - Number(b.lane === "ahead")) : [];
    return {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      lane: resolvedLane,
      generatedAt: String(parsed.generatedAt ?? ""),
      asOf: String(parsed.asOf ?? "尚未标注"),
      headline: displayWorldHeadline(parsed.headline ?? empty.headline, events),
      status,
      events,
      calendar: parseCalendar(parsed.calendar),
      readings: resolvedLane === "japan" ? parseReadings(parsed.readings) : [],
      note: String(parsed.note ?? ""),
    };
  } catch {
    return { ...empty, status: "unavailable", note: "这份世界资讯稿格式损坏，先留空。" };
  }
}

async function readingAudioExists(root, basename) {
  const absolute = resolveReadingAudioAbsolute(root, basename);
  if (!absolute) return false;
  try {
    const stat = await fs.stat(absolute);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function readingAudioDeclaredSource(root, basename, declared) {
  const absolute = resolveReadingAudioAbsolute(root, basename);
  if (absolute) {
    try {
      const text = (await fs.readFile(`${absolute}.source`, "utf8")).trim();
      if (AUDIO_SOURCES.has(text)) return text;
    } catch {
      // 没有 sidecar 就退回稿里写的来源。
    }
  }
  return AUDIO_SOURCES.has(declared) ? declared : "";
}

function publicReading(reading) {
  return {
    id: reading.id,
    level: reading.level,
    title: reading.title,
    date: reading.date,
    sourceName: reading.sourceName,
    sourceUrl: reading.sourceUrl,
    rubyHtml: reading.rubyHtml,
    vocab: reading.vocab,
    furiganaSource: reading.furiganaSource,
    audioSource: reading.audioSource || "",
    audioAvailable: Boolean(reading.audioAvailable),
  };
}

export function resolveReadingAudioName(reading, briefDate) {
  if (reading?.audioFile && isSafeReadingAudioBasename(reading.audioFile)) return reading.audioFile;
  return readingAudioBasename(briefDate || reading?.date, reading?.id);
}

export async function attachReadingAudio(root, brief, dateHint) {
  const briefDate = briefDateKey(dateHint) || briefDateKey(brief?.asOf) || briefDateKey(brief?.generatedAt);
  const readings = await Promise.all((brief?.readings || []).map(async (reading) => {
    const basename = resolveReadingAudioName(reading, briefDate);
    const exists = basename ? await readingAudioExists(root, basename) : false;
    const audioSource = exists ? await readingAudioDeclaredSource(root, basename, reading.audioSource) : "";
    const available = exists && audioSource === "original";
    return publicReading({ ...reading, audioSource: available ? "original" : "", audioAvailable: available });
  }));
  return { ...brief, readings };
}

function historyEntry(date, brief, latest) {
  return {
    date,
    asOf: brief.asOf,
    eventsCount: brief.events.length,
    status: brief.status,
    latest: Boolean(latest),
  };
}

async function readOptionalMarkdown(root, relativePath) {
  try {
    const absolute = path.resolve(root, relativePath);
    const resolvedRoot = path.resolve(root);
    if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`路径越出 Vault 白名单：${relativePath}`);
    }
    const [text, stat] = await Promise.all([fs.readFile(absolute, "utf8"), fs.stat(absolute)]);
    return { path: relativePath, text, updatedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: relativePath, text: "", updatedAt: null };
    throw error;
  }
}

export async function readWorldLaneCurrentEvents(root, lane) {
  if (!isWorldNewsLaneId(lane)) return [];
  const currentSource = await readOptionalMarkdown(root, WORLD_NEWS_CURRENT[lane]);
  return parseWorldLaneBrief(currentSource.text, lane).events;
}

export async function buildWorldLaneSection(root, lane) {
  const currentPath = WORLD_NEWS_CURRENT[lane];
  const historyDir = worldNewsHistoryDir(lane);
  const currentSource = await readOptionalMarkdown(root, currentPath);
  const parsedCurrent = parseWorldLaneBrief(currentSource.text, lane);
  const current = await attachReadingAudio(root, parsedCurrent, parsedCurrent.asOf);
  const latestDate = briefDateKey(current.asOf) || briefDateKey(current.generatedAt);
  const byDate = new Map();
  try {
    const files = await fs.readdir(path.resolve(root, historyDir));
    for (const file of files.filter((name) => /^20\d{2}-\d{2}-\d{2}\.md$/.test(name))) {
      const date = file.slice(0, 10);
      const archived = await readOptionalMarkdown(root, `${historyDir}/${file}`);
      if (!archived.text) continue;
      byDate.set(date, historyEntry(date, parseWorldLaneBrief(archived.text, lane), false));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (latestDate) byDate.set(latestDate, historyEntry(latestDate, current, true));
  const history = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const resolvedLatest = latestDate || history.at(-1)?.date || null;
  for (const entry of history) entry.latest = entry.date === resolvedLatest;
  return {
    ...current,
    date: resolvedLatest,
    latest: true,
    history,
    source: sourceMeta(currentSource),
  };
}

export async function buildWorldNewsSection(root) {
  const entries = await Promise.all(WORLD_NEWS_LANE_IDS.map(async (lane) => [lane, await buildWorldLaneSection(root, lane)]));
  return Object.fromEntries(entries);
}

export async function readWorldLaneByDate(vaultRoot, lane, date) {
  const root = path.resolve(vaultRoot);
  if (!isWorldNewsLaneId(lane)) {
    const error = new Error("栏位无效，需 ai、games 或 japan");
    error.statusCode = 400;
    throw error;
  }
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(date || ""))) {
    const error = new Error("日期格式无效，需 YYYY-MM-DD");
    error.statusCode = 400;
    throw error;
  }
  const section = await buildWorldLaneSection(root, lane);
  const entry = section.history.find((item) => item.date === date);
  if (!entry) {
    const error = new Error("没有该日世界资讯归档");
    error.statusCode = 404;
    throw error;
  }
  if (entry.latest) {
    return { ...section, date, latest: true };
  }
  const archived = await readOptionalMarkdown(root, `${worldNewsHistoryDir(lane)}/${date}.md`);
  const brief = await attachReadingAudio(root, parseWorldLaneBrief(archived.text, lane), date);
  return {
    ...brief,
    date,
    latest: false,
    history: section.history,
    source: sourceMeta(archived),
  };
}

export async function readWorldReadingAudio(vaultRoot, lane, date, readingId) {
  const root = path.resolve(vaultRoot);
  if (!isWorldNewsLaneId(lane) || lane !== "japan") {
    const error = new Error("只有日本栏有课文配音");
    error.statusCode = 400;
    throw error;
  }
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(date || ""))) {
    const error = new Error("日期格式无效，需 YYYY-MM-DD");
    error.statusCode = 400;
    throw error;
  }
  const brief = await readWorldLaneByDate(root, lane, date);
  const id = String(readingId || "");
  const reading = brief.readings.find((item) => item.id === id);
  if (!reading?.audioAvailable || reading.audioSource !== "original") {
    const error = new Error("这篇没有真人配音");
    error.statusCode = 404;
    throw error;
  }
  const basename = readingAudioBasename(date, reading.id);
  const absolute = resolveReadingAudioAbsolute(root, basename);
  if (!absolute) {
    const error = new Error("配音文件名不合法");
    error.statusCode = 400;
    throw error;
  }
  try {
    const bytes = await fs.readFile(absolute);
    if (!bytes.length) {
      const error = new Error("这篇没有真人配音");
      error.statusCode = 404;
      throw error;
    }
    return { bytes, contentType: "audio/mpeg", basename };
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.code === "ENOENT") {
      const missing = new Error("这篇没有真人配音");
      missing.statusCode = 404;
      throw missing;
    }
    throw error;
  }
}

export function worldNewsLaneDir(lane) {
  return WORLD_NEWS_LANES[lane] || "";
}
