import { parseIdentityGallery } from "./workbench-identity-gallery.mjs";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { parseGrammarChecklist } from "./workbench-grammar.mjs";
import { LANGUAGE_REACTOR_SOURCE, pickDailySentence, readLanguageReactorData } from "./workbench-language-reactor.mjs";
import { readAppleHealthData } from "./workbench-apple-health.mjs";
import { readProjectManagement } from "./workbench-project-management.mjs";
import { readPaymentGuardSummary } from "./workbench-renewals.mjs";
import { readDomainKnowledgeNodes } from "./workbench-domain-research-content.mjs";
import { readAppleCalendar } from "./workbench-calendar.mjs";
import { matchAnimeCover, readAnimeCoverCatalog } from "./workbench-anime-covers.mjs";
import { deriveSchoolRestDays } from "./workbench-rest-days.mjs";
import { tokyoDateKey } from "../tokyo-time.mjs";
import { canonicalEventLane, displayBriefHeadline, sortBriefEventsByLane } from "../market-brief-copy.mjs";
import { buildWorldNewsSection } from "./workbench-world-brief.mjs";
import {
  APPLE_HEALTH_SUMMARY,
  AVATAR_PATH,
  BODY_RECORD,
  CURRENT_WELLBEING_DAILY_PATH,
  CURRENT_WELLBEING_MONTHLY_PATH,
  CURRENT_WELLBEING_WEEKLY_PATH,
  CAREER_OVERVIEW,
  COACHING_LOG,
  COACHING_OVERVIEW,
  DEDAO_ARCHIVE,
  DEDAO_COVERS_JSON,
  DEDAO_DIR,
  DIR_LIBRARY,
  FLAGSHIP_OVERVIEW,
  HEALTH_OVERVIEW,
  JP_DAILY,
  JP_GRAMMAR_N2,
  JP_GRAMMAR_N3,
  JP_GRAMMAR_N4,
  JP_GRAMMAR_N5,
  JP_OVERVIEW,
  JP_STATUS,
  LIBRARY_OVERVIEW,
  BOOK_COVERS_JSON,
  MARKET_BRIEF,
  MARKET_BRIEF_HISTORY_DIR as MARKET_BRIEF_HISTORY_DIR_CONST,
  MARKET_EVENT_TOPICS_DIR,
  PAPER_BOOKS,
  STEAM_LIBRARY_JSON,
  EXTRA_GAMES_JSON,
  APPLE_GAMES_JSON,
  GAME_CULTURE_OVERVIEW,
  GAME_CULTURE_WOW,
  GAME_CULTURE_SOULS,
  GAME_CULTURE_ZELDA,
  SCREEN_OVERVIEW,
  SCREEN_CULTURE_FANREN,
  SCREEN_CULTURE_FMA,
  SCREEN_CULTURE_MADOKA,
  SCREEN_CULTURE_CODE_GEASS,
  SCREEN_CULTURE_EAGLE,
  SCREEN_CULTURE_CINEMA_PARADISO,
  CULTURE_DOCUMENT_SOURCES,
  GAME_RESEARCH_OVERVIEW,
  GAME_RESEARCH_QUESTIONS,
  TODO_PATH,
  TOPIC_SOURCES,
  TOPICS_OVERVIEW,
  TRAINING_LOG,
  TRAINING_PLAN,
  WEREAD_PATH,
  WORKBENCH_IDENTITY,
  WORKVIEW_DOC,
  LIFEVIEW_DOC,
  LIFE_DESIGN_LOG,
  RECENT_WELLBEING_LOG,
  ODYSSEY_PLAN,
  INTERVENTION_CARDS,
  WRITING_DIR,
  WRITING_OVERVIEW,
  WECHAT_OFFICIAL_DIR,
  animeCoversSupportDir,
  diaryPathForDay,
} from "./vault-paths.mjs";

const require = createRequire(import.meta.url);
export const WORKBENCH_VERSION = String(require("../../package.json").version);

export const SOURCES = Object.freeze({
  identity: WORKBENCH_IDENTITY,
  avatar: AVATAR_PATH,
  todo: TODO_PATH,
  projects: CAREER_OVERVIEW,
  flagship: FLAGSHIP_OVERVIEW,
  coaching: COACHING_OVERVIEW,
  coachingLog: COACHING_LOG,
  healthOverview: HEALTH_OVERVIEW,
  body: BODY_RECORD,
  training: TRAINING_LOG,
  trainingPlan: TRAINING_PLAN,
  appleHealth: APPLE_HEALTH_SUMMARY,
  workview: WORKVIEW_DOC,
  lifeview: LIFEVIEW_DOC,
  lifeDesignLog: LIFE_DESIGN_LOG,
  recentWellbeingLog: RECENT_WELLBEING_LOG,
  wellbeingDailyReport: CURRENT_WELLBEING_DAILY_PATH,
  wellbeingWeeklyReport: CURRENT_WELLBEING_WEEKLY_PATH,
  wellbeingMonthlyReport: CURRENT_WELLBEING_MONTHLY_PATH,
  odysseyPlan: ODYSSEY_PLAN,
  interventionCards: INTERVENTION_CARDS,
  japaneseOverview: JP_OVERVIEW,
  japaneseStatus: JP_STATUS,
  japaneseDaily: JP_DAILY,
  grammarN5: JP_GRAMMAR_N5,
  grammarN4: JP_GRAMMAR_N4,
  grammarN3: JP_GRAMMAR_N3,
  grammarN2: JP_GRAMMAR_N2,
  languageReactor: LANGUAGE_REACTOR_SOURCE,
  library: LIBRARY_OVERVIEW,
  weread: WEREAD_PATH,
  bookCovers: BOOK_COVERS_JSON,
  dedao: DEDAO_ARCHIVE,
  dedaoCovers: DEDAO_COVERS_JSON,
  paperBooks: PAPER_BOOKS,
  writing: WRITING_OVERVIEW,
  learning: TOPICS_OVERVIEW,
  steamGames: STEAM_LIBRARY_JSON,
  extraGames: EXTRA_GAMES_JSON,
  appleGames: APPLE_GAMES_JSON,
  cultureOverview: GAME_CULTURE_OVERVIEW,
  cultureWow: GAME_CULTURE_WOW,
  cultureSouls: GAME_CULTURE_SOULS,
  cultureZelda: GAME_CULTURE_ZELDA,
  screenOverview: SCREEN_OVERVIEW,
  screenFanren: SCREEN_CULTURE_FANREN,
  screenFma: SCREEN_CULTURE_FMA,
  screenMadoka: SCREEN_CULTURE_MADOKA,
  screenCodeGeass: SCREEN_CULTURE_CODE_GEASS,
  screenEagle: SCREEN_CULTURE_EAGLE,
  screenCinemaParadiso: SCREEN_CULTURE_CINEMA_PARADISO,
  gameResearch: GAME_RESEARCH_OVERVIEW,
  gameResearchQuestions: GAME_RESEARCH_QUESTIONS,
  marketBrief: MARKET_BRIEF,
});

export const MARKET_BRIEF_HISTORY_DIR = MARKET_BRIEF_HISTORY_DIR_CONST;
const MARKET_EVENT_TOPIC_SAMPLE_URL = new URL("../../data/market-event-topics.sample.json", import.meta.url);

export function ensureInside(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`路径越出 Vault 白名单：${relativePath}`);
  return absolute;
}

async function readSource(root, relativePath, warnings = [], optional = false) {
  try {
    const absolute = ensureInside(root, relativePath);
    const [text, stat] = await Promise.all([fs.readFile(absolute, "utf8"), fs.stat(absolute)]);
    return { path: relativePath, text, updatedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (optional && error?.code === "ENOENT") return { path: relativePath, text: "", updatedAt: null };
    warnings.push({ source: relativePath, message: error instanceof Error ? error.message : "无法读取" });
    return { path: relativePath, text: "", updatedAt: null };
  }
}

const OPTIONAL_SOURCES = new Set(["appleHealth", "languageReactor", "marketBrief", "avatar", "trainingPlan", "workview", "lifeview", "lifeDesignLog", "recentWellbeingLog", "wellbeingDailyReport", "wellbeingWeeklyReport", "wellbeingMonthlyReport", "odysseyPlan", "interventionCards", "steamGames", "extraGames", "appleGames", "dedaoCovers", "bookCovers", "weread", "writing", "cultureOverview", "cultureWow", "cultureSouls", "cultureZelda", "screenOverview", "screenFanren", "screenFma", "screenMadoka", "screenCodeGeass", "screenEagle", "screenCinemaParadiso", "gameResearch", "gameResearchQuestions"]);

const SECTION_SOURCE_KEYS = Object.freeze({
  health: ["healthOverview", "body", "training", "trainingPlan", "appleHealth", "todo", "workview", "lifeview", "lifeDesignLog", "recentWellbeingLog", "wellbeingDailyReport", "wellbeingWeeklyReport", "wellbeingMonthlyReport", "odysseyPlan", "interventionCards"],
  languages: ["japaneseOverview", "japaneseStatus", "japaneseDaily", "grammarN5", "grammarN4", "grammarN3", "grammarN2", "languageReactor"],
  library: ["library", "weread", "bookCovers", "dedao", "dedaoCovers", "paperBooks", "writing", "learning", "steamGames", "extraGames", "appleGames", "cultureOverview", "cultureWow", "cultureSouls", "cultureZelda", "screenOverview", "screenFanren", "screenFma", "screenMadoka", "screenCodeGeass", "screenEagle", "screenCinemaParadiso", "gameResearch", "gameResearchQuestions"],
  markets: ["marketBrief"],
});

const SCAN_CACHE_TTL_MS = 60_000;
let scanCache = null;

export function invalidateVaultScanCache() {
  scanCache = null;
}

async function readNamedSources(root, keys, warnings) {
  const entries = await Promise.all(keys.map(async (key) => {
    const relativePath = SOURCES[key];
    if (!relativePath) throw new Error(`未知源键：${key}`);
    return [key, await readSource(root, relativePath, warnings, OPTIONAL_SOURCES.has(key))];
  }));
  return Object.fromEntries(entries);
}

/** 健康分区接口默认只下发近 N 日，避免把全年 daily 塞进浏览器。 */
export const HEALTH_SECTION_DAY_WINDOW = 60;

function tokyoDayKey(value = new Date()) {
  return tokyoDateKey(value);
}

export function trimAppleHealthForSection(summary, dayWindow = HEALTH_SECTION_DAY_WINDOW, now = new Date()) {
  if (!summary || typeof summary !== "object") return null;
  const anchor = new Date(`${tokyoDayKey(now)}T00:00:00+09:00`);
  anchor.setDate(anchor.getDate() - Math.max(1, Number(dayWindow) || HEALTH_SECTION_DAY_WINDOW));
  const cutoff = tokyoDayKey(anchor);
  const daily = Array.isArray(summary.daily) ? summary.daily.filter((item) => String(item?.date ?? "") >= cutoff) : [];
  const body = Array.isArray(summary.body) ? summary.body.filter((item) => String(item?.day ?? item?.date ?? "") >= cutoff) : [];
  const workouts = Array.isArray(summary.workouts) ? summary.workouts.filter((item) => String(item?.day ?? item?.date ?? "") >= cutoff) : [];
  return { ...summary, daily, body, workouts };
}

/** 分区只留文法卡片摘要与语料统计；例句/辨析与全量条目走按需接口。 */
export function trimLanguagesForSection(data) {
  if (!data) return data;
  const grammar = (data.grammar ?? []).map((level) => ({
    ...level,
    groups: (level.groups ?? []).map((group) => ({
      ...group,
      points: (group.points ?? []).map((point) => ({
        id: point.id,
        title: point.title,
        mastery: point.mastery,
        review: point.review,
        connection: "",
        meaning: point.meaning || "",
        examples: [],
        distinctions: [],
        notes: [],
      })),
    })),
  }));
  const reactor = data.languageReactor
    ? { ...data.languageReactor, items: [] }
    : null;
  const exploration = data.exploration ? {
    ...data.exploration,
    grammarDetail: Object.fromEntries(
      Object.entries(data.exploration.grammarDetail ?? {}).map(([level, detail]) => [level, {
        groups: (detail?.groups ?? []).map((group) => ({
          points: (group.points ?? []).map((point) => ({
            id: point.id,
            lv: point.lv || 0,
            correctTotal: point.correctTotal || 0,
          })),
        })),
      }]),
    ),
  } : data.exploration;
  return { ...data, grammar, languageReactor: reactor, exploration };
}

export async function readGrammarLevel(vaultRoot, level) {
  const normalized = String(level || "").toUpperCase();
  if (!["N5", "N4", "N3", "N2"].includes(normalized)) throw Object.assign(new Error("文法等级无效"), { statusCode: 400 });
  const key = `grammar${normalized}`;
  const warnings = [];
  const source = await readNamedSources(path.resolve(vaultRoot), [key], warnings);
  return {
    version: WORKBENCH_VERSION,
    generatedAt: new Date().toISOString(),
    data: { ...parseGrammarChecklist(source[key].text, normalized), source: sourceMeta(source[key]) },
    warnings,
  };
}

export async function queryLanguageReactor(vaultRoot, options = {}) {
  const warnings = [];
  const root = path.resolve(vaultRoot);
  await readNamedSources(root, ["languageReactor"], warnings);
  const collection = await readLanguageReactorData(root);
  if (!collection) {
    return { version: WORKBENCH_VERSION, generatedAt: new Date().toISOString(), data: { items: [], total: 0, offset: 0, limit: 0, sources: [], collection: null }, warnings };
  }
  const kind = String(options.kind || "all");
  const sourceFilter = String(options.source || "全部作品");
  const query = String(options.q || "").trim().toLocaleLowerCase("ja");
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 36));
  const sourceName = (title) => String(title || "").split(" · ")[0] || title;
  const sources = [...new Set((collection.items ?? []).map((item) => sourceName(item.sourceTitle)))];
  const filtered = (collection.items ?? []).filter((item) => {
    if (kind !== "all" && item.type !== kind) return false;
    if (sourceFilter !== "全部作品" && sourceName(item.sourceTitle) !== sourceFilter) return false;
    if (!query) return true;
    const haystack = `${item.sentence} ${item.translation} ${item.transliteration} ${item.word} ${(item.wordTranslations || []).join(" ")} ${item.previous} ${item.next} ${item.sourceTitle}`.toLocaleLowerCase("ja");
    return haystack.includes(query);
  });
  const { items: _drop, ...meta } = collection;
  return {
    version: WORKBENCH_VERSION,
    generatedAt: new Date().toISOString(),
    data: {
      collection: meta,
      sources: ["全部作品", ...sources],
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
    },
    warnings,
  };
}

const SIGNAL_TARGETS = new Set(["美股", "油价", "利率", "日元", "芯片"]);
const SIGNAL_TARGET_ALIASES = { "AI半导体": "芯片" };
const SIGNAL_BIAS_CANONICAL = new Set(["利好", "利空", "还没出"]);
const SIGNAL_BIAS_ALIASES = { "偏多": "利好", "偏空": "利空", "待验证": "还没出" };
const SIGNAL_URGENCY = new Set(["重大", "今晚盯"]);

function canonicalSignalTarget(raw) {
  const value = String(raw ?? "");
  if (SIGNAL_TARGETS.has(value)) return value;
  return SIGNAL_TARGET_ALIASES[value] || "";
}

function canonicalSignalTargets(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const canon = canonicalSignalTarget(item);
    if (canon && !out.includes(canon)) out.push(canon);
    if (out.length >= 2) break;
  }
  return out;
}

function canonicalSignalBias(raw) {
  const value = String(raw ?? "");
  if (SIGNAL_BIAS_CANONICAL.has(value)) return value;
  return SIGNAL_BIAS_ALIASES[value] || "";
}

function canonicalSignalUrgency(raw, importance) {
  const value = String(raw ?? "");
  if (value === "背景约束" || !SIGNAL_URGENCY.has(value)) return "";
  if (value === "重大" && (Number(importance) || 0) < 5) return "";
  return value;
}
const MARKET_TOPIC_STATUSES = new Set(["preview", "published", "tracking", "closed"]);
const MARKET_TOPIC_PHASES = new Set(["preview", "release", "d1", "tracking", "d3", "d5", "closed"]);
const MARKET_TOPIC_NODE_STATUSES = new Set(["recorded", "current", "pending"]);
const MARKET_TOPIC_DECISION_GRADES = new Set(["SSS", "S", "A", "B", "C"]);
export const MARKET_TOPIC_CLOSE_RULE = "事件后约 3 天，若无持续重大驱动则结案；历史永久保留。";
const MARKET_TOPIC_BUCKETS = Object.freeze({
  officialFact: "官方事实",
  surveyConsensus: "调查共识",
  marketPriced: "市场已定价",
  priceReaction: "价格反应",
  positioningClue: "仓位线索",
  mediaNarrative: "媒体叙事",
  pending: "待验证",
});

/** 大事小标签：盯谁 / 往哪边 / 要不要现在管。AI热点不填。重大仅当 important≥5；背景约束不展示。 */
export function flattenSignalTags(signal, { category, importance } = {}) {
  if (category === "AI热点" || !signal || typeof signal !== "object") return [];
  const targets = canonicalSignalTargets(signal.targets);
  const bias = canonicalSignalBias(signal.bias);
  const urgency = canonicalSignalUrgency(signal.urgency, importance);
  const tags = [];
  if (targets[0]) tags.push(targets[0]);
  if (bias) tags.push(bias);
  if (urgency) tags.push(urgency);
  if (tags.length < 3 && targets[1]) tags.push(targets[1]);
  return tags.slice(0, 3);
}

export function parseMarketBrief(markdown) {
  const empty = { schemaVersion: 1, generatedAt: "", asOf: "尚未生成", headline: "尚无达到重大事件阈值的新简报。", status: "unavailable", events: [], calendar: [], note: "等待下一次金融市场情报更新。", topics: [] };
  const raw = markdown.match(/<!-- INFANS_MARKET_BRIEF_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- INFANS_MARKET_BRIEF_JSON_END -->/)?.[1];
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    const safeUrl = (value) => /^https:\/\//i.test(String(value ?? "")) ? String(value) : "";
    return {
      schemaVersion: Number(parsed.schemaVersion) || 1,
      generatedAt: String(parsed.generatedAt ?? ""),
      asOf: String(parsed.asOf ?? "尚未标注"),
      headline: displayBriefHeadline(parsed.headline ?? empty.headline),
      status: ["active", "quiet"].includes(parsed.status) ? parsed.status : "unavailable",
      events: Array.isArray(parsed.events) ? sortBriefEventsByLane(parsed.events.slice(0, 5).map((event, index) => {
        const category = String(event.category ?? "市场");
        const importance = Math.max(1, Math.min(5, Number(event.importance) || 1));
        const lane = canonicalEventLane(event.lane, category);
        const signal = category === "AI热点" ? undefined : (event.signal && typeof event.signal === "object" ? {
          targets: canonicalSignalTargets(event.signal.targets),
          bias: canonicalSignalBias(event.signal.bias) || undefined,
          urgency: canonicalSignalUrgency(event.signal.urgency, importance) || undefined,
        } : undefined);
        const cleanedSignal = signal && (signal.targets.length || signal.bias || signal.urgency)
          ? { targets: signal.targets, ...(signal.bias ? { bias: signal.bias } : {}), ...(signal.urgency ? { urgency: signal.urgency } : {}) }
          : undefined;
        return {
          id: String(event.id ?? `event-${index}`),
          importance,
          category,
          lane,
          title: String(event.title ?? "未命名事件"),
          fact: String(event.fact ?? ""),
          whyItMatters: String(event.whyItMatters ?? ""),
          marketReaction: String(event.marketReaction ?? "待验证"),
          impact: String(event.impact ?? ""),
          confidence: String(event.confidence ?? "未标注"),
          watchNext: Array.isArray(event.watchNext) ? event.watchNext.slice(0, 5).map(String) : [],
          sources: Array.isArray(event.sources) ? event.sources.slice(0, 5).map((source) => ({ title: String(source.title ?? "来源"), url: safeUrl(source.url), type: String(source.type ?? "来源") })).filter((source) => source.url) : [],
          ...(cleanedSignal ? { signal: cleanedSignal } : {}),
          signalTags: flattenSignalTags(cleanedSignal, { category, importance }),
        };
      })) : [],
      calendar: Array.isArray(parsed.calendar) ? parsed.calendar.slice(0, 12).map((event) => {
        const date = String(event.date ?? "");
        const importance = Math.max(1, Math.min(5, Number(event.importance) || 1));
        const dateConfirmed = event.dateConfirmed === true && /^20\d{2}-\d{2}-\d{2}$/.test(date);
        const featured = dateConfirmed && importance === 5 && event.featured === true;
        return {
          date,
          title: String(event.title ?? "未命名事件"),
          region: String(event.region ?? "全球"),
          importance,
          ...(dateConfirmed ? { dateConfirmed: true } : {}),
          ...(featured ? { featured: true } : {}),
          whyWatch: String(event.whyWatch ?? ""),
          sourceUrl: safeUrl(event.sourceUrl),
        };
      }).filter((event) => event.date && event.sourceUrl) : [],
      note: String(parsed.note ?? ""),
      topics: [],
    };
  } catch {
    return empty;
  }
}

function boundedStrings(value, limit = 8) {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, limit) : [];
}

function normalizeTopicLifecycle(value) {
  const status = String(value ?? "").trim();
  if (MARKET_TOPIC_STATUSES.has(status)) return status;
  if (status === "已结案") return "closed";
  if (status === "预告" || status === "仅观察") return "preview";
  if (status === "已公布") return "published";
  return "tracking";
}

function normalizeTopicPhase(value) {
  const phase = String(value ?? "").trim().toLowerCase();
  return ({ bulletin: "release", review: "closed" })[phase] ?? phase;
}

function normalizeEvidenceBuckets(value) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(MARKET_TOPIC_BUCKETS).flatMap(([key, label]) => {
    const text = String(value[key] ?? "").trim();
    return text ? [{ key, label, text }] : [];
  });
}

function normalizeMarketEventTopic(value, sourcePath, fileUpdatedAt, inheritedSample = false) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id ?? value.eventId ?? "").trim();
  const title = String(value.title ?? "").trim();
  const eventDate = String(value.eventDate ?? value.occurredAt ?? "").match(/20\d{2}-\d{2}-\d{2}/)?.[0] ?? "";
  const sourceStatus = value.sourceStatus != null
    ? String(value.sourceStatus)
    : (MARKET_TOPIC_STATUSES.has(String(value.status ?? "")) ? "" : String(value.status ?? ""));
  const status = normalizeTopicLifecycle(value.status);
  const latestConclusion = String(value.latestConclusion ?? value.statusLine ?? "").trim();
  if (!id || !title || !/^20\d{2}-\d{2}-\d{2}$/.test(eventDate) || !latestConclusion) return null;
  const safeUrl = (input) => /^https:\/\//i.test(String(input ?? "")) ? String(input) : "";
  const requestedDecisionGrade = String(value.decisionGrade ?? "").trim().toUpperCase();
  const decisionGrade = status === "closed" && MARKET_TOPIC_DECISION_GRADES.has(requestedDecisionGrade) ? requestedDecisionGrade : "";
  const seenPhases = new Set();
  const nodes = (Array.isArray(value.nodes) ? value.nodes : []).flatMap((node) => {
    const phase = normalizeTopicPhase(node?.phase ?? node?.id);
    if (!MARKET_TOPIC_PHASES.has(phase) || seenPhases.has(phase)) return [];
    seenPhases.add(phase);
    const nodeStatus = String(node?.status ?? "pending");
    return [{
      phase,
      status: MARKET_TOPIC_NODE_STATUSES.has(nodeStatus) ? nodeStatus : "pending",
      observedAt: String(node?.observedAt ?? node?.asOf ?? ""),
      attribution: String(node?.attribution ?? ""),
      conclusion: String(node?.conclusion ?? node?.statusLine ?? ""),
      facts: boundedStrings(node?.facts),
      candidateJudgments: boundedStrings(node?.candidateJudgments),
      missingEvidence: boundedStrings(node?.missingEvidence),
      sources: (Array.isArray(node?.sources) ? node.sources : []).slice(0, 6).map((source) => ({
        title: String(source?.title ?? source?.tier ?? "来源"),
        url: safeUrl(source?.url),
        type: String(source?.type ?? source?.tier ?? "来源"),
      })).filter((source) => source.url),
      evidenceBuckets: normalizeEvidenceBuckets(node?.buckets),
    }];
  });
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    id,
    title,
    eventDate,
    eventTime: String(value.eventTime ?? value.occurredAt ?? "待确认"),
    region: String(value.region ?? "全球"),
    category: String(value.category ?? "重大事件"),
    status,
    sourceStatus,
    latestConclusion,
    attributionOverall: String(value.attributionOverall ?? ""),
    officialUrl: safeUrl(value.officialUrl),
    missingEvidence: boundedStrings(value.missingEvidence),
    updatedAt: String(value.updatedAt ?? fileUpdatedAt ?? ""),
    closeRule: String(value.closeRule ?? MARKET_TOPIC_CLOSE_RULE),
    ...(decisionGrade ? {
      decisionGrade,
      decisionReview: String(value.decisionReview ?? "").trim().slice(0, 1000),
      decisionReviewedAt: String(value.decisionReviewedAt ?? "").trim().slice(0, 40),
    } : {}),
    ...((inheritedSample || value.sample === true) ? { sample: true } : {}),
    sourcePath,
    nodes,
  };
}

function extractMarkdownSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdown.match(new RegExp(`^###\\s+${escaped}\\s*$\\n([\\s\\S]*?)(?=^###\\s+|^##\\s+|(?![\\s\\S]))`, "m"))?.[1]?.trim() ?? "";
}

function cleanTopicMarkdownText(value, limit = 1000) {
  return cleanInline(String(value ?? "")
    .replace(/^\s*-\s*来源：.*$/gm, "")
    .replace(/^\s*\|?\s*:?-+.*$/gm, "")
    .replace(/^\s*\|/gm, "")
    .replace(/\|\s*$/gm, "")
    .replace(/\s*\|\s*/g, "；")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function markdownLabel(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cleanTopicMarkdownText(markdown.match(new RegExp(`^-\\s+(?:\\*\\*)?${escaped}(?:\\*\\*)?[：:]\\s*(.+)$`, "m"))?.[1] ?? "", 500);
}

function markdownTableValue(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cleanTopicMarkdownText(markdown.match(new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([\\s\\S]*?)\\|\\s*$`, "m"))?.[1] ?? "", 500);
}

function linksFromMarkdown(markdown) {
  return [...String(markdown).matchAll(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g)]
    .slice(0, 6)
    .map((match) => ({ title: cleanTopicMarkdownText(match[1], 100), url: match[2], type: "来源" }));
}

function listFromMarkdown(value, limit = 8) {
  return String(value ?? "").split("\n").map((line) => line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/)?.[1] ?? "").map((line) => cleanTopicMarkdownText(line, 300)).filter(Boolean).slice(0, limit);
}

function parseCursorMarketEventTopicMarkdown(markdown, sourcePath, fileUpdatedAt) {
  if (!/^##\s+最新状态\s*$/m.test(markdown) || !/^##\s+事件元数据\s*$/m.test(markdown)) return [];
  const title = cleanTopicMarkdownText(markdown.match(/^#\s+(.+)$/m)?.[1] ?? "", 200);
  const eventId = markdownTableValue(markdown, "事件编号").replace(/`/g, "") || sourcePath;
  const occurredAt = markdownTableValue(markdown, "发生时间");
  const eventDate = (eventId.match(/20\d{2}-\d{2}-\d{2}/) ?? occurredAt.match(/20\d{2}-\d{2}-\d{2}/))?.[0] ?? "";
  const sourceStatus = markdownLabel(markdown, "当前状态") || "跟踪中";
  const topicClosed = normalizeTopicLifecycle(sourceStatus) === "closed";
  const requestedDecisionGrade = (markdownLabel(markdown, "决策评级") || markdownLabel(markdown, "判断评级")).replace(/`/g, "").toUpperCase();
  const decisionGrade = topicClosed && MARKET_TOPIC_DECISION_GRADES.has(requestedDecisionGrade) ? requestedDecisionGrade : "";
  const latestConclusion = markdownLabel(markdown, "一句话");
  if (!title || !eventDate || !latestConclusion) return [];
  const nodeSections = [...markdown.matchAll(/^##\s+\d+\.\s+(.+)\s*$\n([\s\S]*?)(?=^##\s+\d+\.|(?![\s\S]))/gm)];
  const nodes = nodeSections.flatMap((match) => {
    const body = match[2];
    const rawPhase = body.match(/^-\s+\*\*节点\*\*[：:]\s*`?([a-z0-9+_-]+)`?/mi)?.[1] ?? "";
    const phase = normalizeTopicPhase(rawPhase);
    if (!MARKET_TOPIC_PHASES.has(phase)) return [];
    const evidenceBuckets = Object.entries(MARKET_TOPIC_BUCKETS).flatMap(([key, label]) => {
      const text = cleanTopicMarkdownText(extractMarkdownSection(body, label));
      return text ? [{ key, label, text }] : [];
    });
    const attribution = markdownLabel(body, "归因") || markdownLabel(body, "专题状态");
    const pendingText = evidenceBuckets.find((bucket) => bucket.key === "pending")?.text ?? "";
    return [{
      phase,
      status: phase === "closed" && !topicClosed ? "current" : (phase === "tracking" && !topicClosed ? "current" : "recorded"),
      observedAt: markdownLabel(body, "截止"),
      attribution,
      conclusion: "",
      facts: [],
      candidateJudgments: [],
      missingEvidence: pendingText ? [pendingText] : [],
      sources: linksFromMarkdown(body),
      evidenceBuckets,
    }];
  });
  const seenPhases = new Set(nodes.map((node) => node.phase));
  const followupSections = [...markdown.matchAll(/^###\s+D\+(3|5)\s*[·・]\s*(20\d{2}-\d{2}-\d{2})\s*$\n([\s\S]*?)(?=^###\s+|^##\s+|(?![\s\S]))/gm)];
  for (const match of followupSections) {
    const phase = `d${match[1]}`;
    if (seenPhases.has(phase)) continue;
    const body = match[3];
    const attribution = markdownLabel(body, "归因");
    const conclusion = markdownLabel(body, "结案处理");
    const missingEvidence = markdownLabel(body, "暂不判断缺项");
    nodes.push({
      phase,
      status: attribution || conclusion || missingEvidence ? "recorded" : "pending",
      observedAt: markdownLabel(body, "截止（asOf）") || match[2],
      attribution,
      conclusion,
      facts: [],
      candidateJudgments: [],
      missingEvidence: missingEvidence ? [missingEvidence] : [],
      sources: linksFromMarkdown(body),
      evidenceBuckets: [],
    });
    seenPhases.add(phase);
  }
  const finalPending = nodeSections.at(-1)?.[2] ? extractMarkdownSection(nodeSections.at(-1)[2], "待验证 / 下次应补") : "";
  const officialLink = markdown.match(/^\|\s*官方入口\s*\|[^\n]*\((https:\/\/[^)]+)\)/m)?.[1] ?? "";
  return [{
    schemaVersion: 1,
    id: eventId,
    title,
    eventDate,
    eventTime: occurredAt || "待确认",
    region: /美国|美东|US-/i.test(`${eventId} ${occurredAt}`) ? "美国" : "全球",
    category: /CPI|通胀/i.test(`${eventId} ${title}`) ? "通胀" : "重大事件",
    status: normalizeTopicLifecycle(sourceStatus),
    sourceStatus,
    latestConclusion,
    attributionOverall: markdownLabel(markdown, "总归因"),
    officialUrl: officialLink,
    missingEvidence: listFromMarkdown(finalPending),
    updatedAt: fileUpdatedAt || "",
    closeRule: MARKET_TOPIC_CLOSE_RULE,
    ...(decisionGrade ? {
      decisionGrade,
      decisionReview: markdownLabel(markdown, "评级评语"),
      decisionReviewedAt: markdownLabel(markdown, "评级时间"),
    } : {}),
    ...(/沙盘演练样本/.test(markdown) ? { sample: true } : {}),
    sourcePath,
    nodes,
  }];
}

/**
 * Cursor 专题资料的唯一解析入口。支持一事一档 Markdown 内的标记 JSON，也支持原始 JSON。
 * 解析失败只忽略该文件，不把 Markdown 正文或未经约束的字段下发给浏览器。
 */
export function parseMarketEventTopicDocument(document, sourcePath = "", fileUpdatedAt = "") {
  const text = String(document ?? "");
  const marked = text.match(/<!-- INFANS_MARKET_EVENT_TOPIC_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- INFANS_MARKET_EVENT_TOPIC_JSON_END -->/)?.[1];
  const raw = marked ?? (/^\s*[\[{]/.test(text) ? text : "");
  if (!raw) return parseCursorMarketEventTopicMarkdown(text, sourcePath, fileUpdatedAt);
  try {
    const parsed = JSON.parse(raw);
    const inheritedSample = parsed?.sample === true;
    const values = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.topics) ? parsed.topics : [parsed]);
    return values.slice(0, 8).map((value) => normalizeMarketEventTopic(value, sourcePath, fileUpdatedAt, inheritedSample)).filter(Boolean);
  } catch {
    return [];
  }
}

export async function readMarketEventTopics(root) {
  const topics = [];
  try {
    const files = (await fs.readdir(ensureInside(root, MARKET_EVENT_TOPICS_DIR)))
      .filter((name) => /\.(?:md|json)$/i.test(name))
      .sort()
      .slice(0, 12);
    const documents = await Promise.all(files.map(async (name) => {
      const source = await readSource(root, `${MARKET_EVENT_TOPICS_DIR}/${name}`, [], true);
      return parseMarketEventTopicDocument(source.text, source.path, source.updatedAt ?? "");
    }));
    topics.push(...documents.flat());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const resolved = topics.length ? topics : parseMarketEventTopicDocument(
    await fs.readFile(MARKET_EVENT_TOPIC_SAMPLE_URL, "utf8"),
    "00_本地工作台/app/data/market-event-topics.sample.json",
  );
  return resolved
    .filter((topic, index, all) => all.findIndex((candidate) => candidate.id === topic.id) === index)
    .sort((a, b) => b.eventDate.localeCompare(a.eventDate))
    .slice(0, 8);
}

export function briefDateKey(value) {
  return String(value ?? "").match(/(20\d{2}-\d{2}-\d{2})/)?.[1] ?? null;
}

function historyEntry(date, brief, latest) {
  return { date, asOf: brief.asOf, eventsCount: brief.events.length, status: brief.status, latest: Boolean(latest) };
}

export async function buildMarketSection(root, marketBriefSource) {
  const current = parseMarketBrief(marketBriefSource.text);
  const [topics, world] = await Promise.all([
    readMarketEventTopics(root),
    buildWorldNewsSection(root),
  ]);
  const latestDate = briefDateKey(current.asOf) || briefDateKey(current.generatedAt);
  const byDate = new Map();
  try {
    const files = await fs.readdir(ensureInside(root, MARKET_BRIEF_HISTORY_DIR));
    for (const file of files.filter((name) => /^20\d{2}-\d{2}-\d{2}\.md$/.test(name))) {
      const date = file.slice(0, 10);
      const archived = await readSource(root, `${MARKET_BRIEF_HISTORY_DIR}/${file}`, [], true);
      if (!archived.text) continue;
      byDate.set(date, historyEntry(date, parseMarketBrief(archived.text), false));
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
    topics,
    date: resolvedLatest,
    latest: true,
    history,
    source: sourceMeta(marketBriefSource),
    world,
  };
}

export async function readMarketBriefByDate(vaultRoot, date) {
  const root = path.resolve(vaultRoot);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(date || ""))) {
    const error = new Error("日期格式无效，需 YYYY-MM-DD");
    error.statusCode = 400;
    throw error;
  }
  const warnings = [];
  const marketBriefSource = await readSource(root, SOURCES.marketBrief, warnings, true);
  const section = await buildMarketSection(root, marketBriefSource);
  const entry = section.history.find((item) => item.date === date);
  if (!entry) {
    const error = new Error("没有该日简报归档");
    error.statusCode = 404;
    throw error;
  }
  if (entry.latest) {
    return { ...section, date, latest: true };
  }
  const archived = await readSource(root, `${MARKET_BRIEF_HISTORY_DIR}/${date}.md`, warnings, false);
  const brief = parseMarketBrief(archived.text);
  return {
    ...brief,
    topics: section.topics,
    date,
    latest: false,
    history: section.history,
    source: sourceMeta(archived),
  };
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
}

export function cleanInline(value = "") {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_match, target) => String(target).split("/").at(-1) ?? target)
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\\\|/g, "|")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function extractSection(markdown, heading, level = 2, options = {}) {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const marker = "#".repeat(level);
  const normalizeHeading = (value) => cleanInline(value).replace(/^[^A-Za-z0-9\u3400-\u9fff]+/u, "").trim();
  const target = normalizeHeading(heading);
  const prefix = Boolean(options.prefix);
  const start = lines.findIndex((line) => {
    const match = line.trim().match(new RegExp(`^${marker}\\s+(.+)$`));
    if (!match) return false;
    const normalized = normalizeHeading(match[1]);
    return prefix ? normalized.startsWith(target) : normalized === target;
  });
  if (start < 0) return "";
  const boundary = new RegExp(`^#{1,${level}}\\s+`);
  const end = lines.findIndex((line, index) => index > start && boundary.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join("\n").trim();
}

/** 取日志里最新的 `## YYYY-MM-DD` 节；没有则返回空串。 */
export function extractLatestDateSection(markdown, level = 2) {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const marker = "#".repeat(level);
  let best = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(new RegExp(`^${marker}\\s+(20\\d{2}-\\d{2}-\\d{2})\\b`));
    if (!match) continue;
    if (!best || match[1] >= best.date) best = { date: match[1], index };
  }
  if (!best) return { date: null, section: "" };
  const boundary = new RegExp(`^#{1,${level}}\\s+`);
  const end = lines.findIndex((line, index) => index > best.index && boundary.test(line));
  return { date: best.date, section: lines.slice(best.index + 1, end < 0 ? lines.length : end).join("\n").trim() };
}

function firstParagraph(markdown) {
  const chunks = stripFrontmatter(markdown).split(/\n\s*\n/);
  for (const chunk of chunks) {
    const text = chunk.split(/\r?\n/).filter((line) => !/^\s*(#|>|\||-|```)/.test(line)).map(cleanInline).join(" ").trim();
    if (text) return text;
  }
  return "";
}

function listItems(section, limit = 12) {
  return section.split(/\r?\n/).map((line) => line.match(/^\s*-\s+(?!\[[ xX]\])(.+)$/)?.[1]).filter(Boolean).map(cleanInline).filter(Boolean).slice(0, limit);
}

function parseCheckboxes(section, limit = 20) {
  return section.split(/\r?\n/).map((line) => line.match(/^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/)).filter(Boolean).map((match) => ({ done: match[1].toLowerCase() === "x", text: cleanInline(match[2]) })).slice(0, limit);
}

const PLAIN_PLANNING_DONE_RE = /(?:已完成(?:事实|成果|项目记录|日程)?|已结束|已过去|已核验(?:证据)?|既有记录习惯)\s*(?:[：:（()）]|$)/u;

/**
 * 中央“长期在推”同时承载旧复选框里程碑和五类事项治理后的战略/进度/日程行。
 * 普通项目行不是可勾选待办，因此只读取顶层 `- `，不把它的说明子项误当主线。
 */
export function parsePlanningItems(section, limit = 60) {
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    const checkbox = line.match(/^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (checkbox) {
      rows.push({ done: checkbox[1].toLowerCase() === "x", text: cleanInline(checkbox[2]) });
    } else {
      const bullet = line.match(/^-\s+(?!\[[ xX]\])(.+?)\s*$/);
      if (!bullet) continue;
      const text = cleanInline(bullet[1]);
      if (!text) continue;
      rows.push({ done: PLAIN_PLANNING_DONE_RE.test(text), text });
    }
    if (rows.length >= limit) break;
  }
  return rows;
}

export function splitMarkdownRow(line) {
  const placeholder = "\u0000PIPE\u0000";
  return line.trim().slice(1, -1).replace(/\\\|/g, placeholder).split("|").map((cell) => cell.trim().replaceAll(placeholder, "|"));
}

export function parseRawTable(section) {
  return section.split(/\r?\n/).filter((line) => line.trim().startsWith("|") && line.trim().endsWith("|")).map(splitMarkdownRow);
}

function dataRows(section) {
  return parseRawTable(section).filter((row, index) => index !== 0 && !row.every((cell) => /^:?-{3,}:?$/.test(cleanInline(cell))));
}

function wikiTarget(value = "") { return value.match(/\[\[([^\]|]+)/)?.[1]?.trim() ?? null; }
function contentId(relativePath) { return crypto.createHash("sha256").update(relativePath).digest("hex").slice(0, 18); }
function coverSeed(value) { return Number.parseInt(crypto.createHash("md5").update(value).digest("hex").slice(0, 6), 16); }
function sourceMeta(source) { return { path: source.path, updatedAt: source.updatedAt }; }

function parseIdentity(markdown) {
  const parseMode = (name) => {
    const section = extractSection(markdown, name, 2);
    return {
      title: firstParagraph(extractSection(section, "标题", 3)),
      intro: firstParagraph(extractSection(section, "简介", 3)),
      roles: listItems(extractSection(section, name === "现在" ? "当前角色" : "关键线索", 3), 8),
    };
  };
  return { current: parseMode("现在"), past: parseMode("过去"), gallery: parseIdentityGallery(markdown) };
}

function parseTodo(markdown) {
  const rows = dataRows(extractSection(markdown, "当前主线"));
  return {
    today: parseCheckboxes(extractSection(markdown, "最近两天"), 60),
    longTerm: parsePlanningItems(extractSection(markdown, "长期在推"), 60),
    // 表可为 3–5 列：优先级 | 事项 | 前缀 | 大类色 | 入口
    mainlines: rows.map((row) => ({
      priority: cleanInline(row[0] ?? ""),
      item: cleanInline(row[1] ?? ""),
      prefix: cleanInline(row[2] ?? ""),
      category: cleanInline(row[3] ?? ""),
      entry: cleanInline(row[row.length - 1] ?? ""),
    })).filter((row) => row.item),
  };
}

function parseProjectTable(markdown, sectionTitle, archived) {
  return dataRows(extractSection(markdown, sectionTitle)).map((row) => ({
    name: cleanInline(row[0] ?? ""),
    status: cleanInline(row[1] ?? ""),
    entry: cleanInline(row[2] ?? ""),
    entryPath: wikiTarget(row[2]),
    archived: Boolean(archived),
  })).filter((row) => row.name);
}

function parseProjects(markdown) {
  return [
    ...parseProjectTable(markdown, "当前重点", false),
    ...parseProjectTable(markdown, "归档", true),
  ].slice(0, 20);
}

function projectIdFromName(name) {
  if (name === "小秘书") return "flagship";
  if (name === "阳台种植计划") return "coach";
  return `venture:${encodeURIComponent(name)}`;
}

function parseFlagship(markdown, warnings = []) {
  const version = markdown.match(/Alpha\s+\*\*([^*]+)\*\*/)?.[1] ?? markdown.match(/版本[^\n]*?v([\d.]+)/i)?.[1] ?? "开发中";
  const progress = extractSection(markdown, "当前进度", 2, { prefix: true });
  if (!progress) warnings.push({ source: SOURCES.flagship, message: "未找到「当前进度」章节，旗舰进度可能为空。" });
  const readyBlock = progress.match(/\*\*已较成型\*\*([\s\S]*?)(?=\n\*\*正在推)/)?.[1] ?? "";
  const pendingBlock = progress.match(/\*\*正在推 \/ 待验收\*\*([\s\S]*?)(?=\n\*\*明确未做|$)/)?.[1] ?? "";
  const ready = listItems(readyBlock, 5);
  const pending = listItems(pendingBlock, 5);
  return {
    version: version.startsWith("v") ? version : `v${version}`,
    focus: pending[0] ?? "剧情模式最短闭环",
    ready,
    pending,
  };
}

function parseCoaching(markdown, log, warnings = []) {
  const focusSection = extractSection(markdown, "现在最重要的一件事");
  if (!focusSection) warnings.push({ source: SOURCES.coaching, message: "未找到「现在最重要的一件事」章节。" });
  const { date, section: latest } = extractLatestDateSection(log);
  if (!date) warnings.push({ source: SOURCES.coachingLog, message: "示例项目更新日志缺少 YYYY-MM-DD 日期节，latest 为空。" });
  return { focus: cleanInline(focusSection.match(/>\s*\*\*([^*]+)\*\*/)?.[1] ?? firstParagraph(focusSection)), latest: listItems(latest, 2).join(" · ") };
}

function numeric(value) { const found = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/); return found ? Number(found[0]) : undefined; }

const WEEKDAY_KEYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 与 muscle-map 分区对齐的粗粒度「该练了 / 太久没练」提示。 */
const STALE_MUSCLE_ZONES = [
  { id: "chest", label: "胸", idealCadenceDays: 5, overdueDays: 10, keywords: ["卧推", "夹胸", "飞鸟", "俯卧撑", "胸推", "上斜"] },
  { id: "back", label: "背", idealCadenceDays: 5, overdueDays: 10, keywords: ["引体", "划船", "下拉", "山羊挺身"] },
  { id: "shoulders", label: "肩", idealCadenceDays: 5, overdueDays: 10, keywords: ["侧平举", "肩推", "推举", "面拉", "耸肩"] },
  { id: "arms", label: "手臂", idealCadenceDays: 5, overdueDays: 10, keywords: ["弯举", "臂屈伸", "三头", "二头", "绳索下压"] },
  { id: "quads", label: "股四", idealCadenceDays: 7, overdueDays: 14, keywords: ["深蹲", "保加利亚", "分腿蹲", "腿屈伸", "单腿蹲", "腿举"] },
  { id: "posterior", label: "后链", idealCadenceDays: 7, overdueDays: 14, keywords: ["硬拉", "腿弯举", "臀桥", "髋推", "山羊挺身", "罗马尼亚"] },
  { id: "core", label: "核心", idealCadenceDays: 4, overdueDays: 10, keywords: ["悬垂举腿", "举腿", "抬腿", "平板支撑", "卷腹", "核心", "死虫", "腹轮", "骨盆"] },
];

export function tokyoWeekday(date = new Date()) {
  const key = tokyoDateKey(date);
  const weekday = new Date(`${key}T12:00:00+09:00`).getDay();
  return { key, weekday, label: WEEKDAY_KEYS[weekday] };
}

/**
 * 从训练计划正文里抽出某次课（如「上肢日 B」）的动作名。
 * 认 `## 上肢日 B` 节里 `[详解](...#动作名)` 锚点；游泳/休息返回空。
 */
export function parseSessionExercises(markdown, sessionTitle) {
  const title = String(sessionTitle || "").trim();
  if (!title || title === "—" || /游泳|完全休息|^休息/.test(title)) return [];
  const lines = String(markdown || "").split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = line.trim().match(/^##\s+(.+)$/);
    if (!match) return false;
    const heading = cleanInline(match[1]);
    return (
      heading === title
      || heading.startsWith(`${title} `)
      || heading.startsWith(`${title}—`)
      || heading.startsWith(`${title}–`)
      || heading.startsWith(`${title}-`)
    );
  });
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line.trim()));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end).join("\n");
  const names = [];
  const seen = new Set();
  for (const hit of body.matchAll(/\[[^\]]*\]\([^)\n]*#([^)\n]+)\)/g)) {
    let name = hit[1];
    try {
      name = decodeURIComponent(name);
    } catch {
      /* 锚点本就是中文时 decode 失败就原样用 */
    }
    name = cleanInline(name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function parseTodayTrainingPlan(markdown, date = new Date()) {
  const { label } = tokyoWeekday(date);
  const week = parseWeekTrainingPlan(markdown, date);
  const hit = week.find((day) => day.label === label);
  if (!hit || hit.title === "—") {
    return {
      weekday: `周${label}`,
      title: "今天没排训练",
      detail: "训练计划的周表里没找到今天。",
      exercises: [],
    };
  }
  return {
    weekday: hit.weekday,
    title: hit.title,
    detail: hit.detail,
    exercises: hit.exercises || [],
  };
}

/** 周表七天：给体魄页小日历用。 */
export function parseWeekTrainingPlan(markdown, date = new Date()) {
  const { label: todayLabel } = tokyoWeekday(date);
  const order = ["一", "二", "三", "四", "五", "六", "日"];
  const section = extractSection(markdown, "周安排") || markdown;
  const rows = [...section.matchAll(/\|\s*周([一二三四五六日])\s*\|\s*([^|]+)\|/g)];
  const byLabel = new Map(rows.map((row) => [row[1], cleanInline(row[2]).replace(/\*\*/g, "")]));
  return order.map((label) => {
    const raw = byLabel.get(label) || "";
    const title = raw.replace(/（[^）]*）/g, "").trim() || raw || "—";
    let short = title;
    let kind = "other";
    if (/游泳/.test(title)) {
      kind = "swim";
      short = "游泳";
    } else if (/完全休息|举铁休息|^休息/.test(title)) {
      kind = "rest";
      short = "休息";
    } else if (/上肢|下肢/.test(title)) {
      kind = "lift";
      short = title
        .replace(/上肢日\s*([AB])/i, "上肢$1")
        .replace(/下肢日\s*([AB])/i, "下肢$1")
        .replace(/\s+/g, "");
    } else {
      short = title.replace(/\s+/g, "") || "—";
    }
    const detail = raw.includes("（") ? raw : (raw ? `照周表：${raw}` : "周表里没写");
    const exercises = kind === "lift" ? parseSessionExercises(markdown, title) : [];
    return {
      weekday: `周${label}`,
      label,
      title,
      short,
      detail,
      kind,
      exercises,
      isToday: label === todayLabel,
    };
  });
}

function daysBetweenTokyo(fromDay, toDay) {
  const a = Date.parse(`${fromDay}T00:00:00+09:00`);
  const b = Date.parse(`${toDay}T00:00:00+09:00`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function staleMusclesFromSessions(sessions, todayKey = tokyoWeekday().key) {
  const stale = [];
  for (const zone of STALE_MUSCLE_ZONES) {
    let lastDate = null;
    for (const session of sessions) {
      const hit = (session.exercises || []).some((exercise) => zone.keywords.some((keyword) => String(exercise.name || "").includes(keyword)));
      if (!hit) continue;
      if (!lastDate || session.date > lastDate) lastDate = session.date;
    }
    const daysSince = lastDate ? daysBetweenTokyo(lastDate, todayKey) : null;
    if (daysSince === null) continue;
    if (daysSince >= zone.overdueDays) stale.push({ id: zone.id, label: zone.label, status: "overdue", daysSince, lastDate });
    else if (daysSince >= zone.idealCadenceDays) stale.push({ id: zone.id, label: zone.label, status: "due", daysSince, lastDate });
  }
  return stale.sort((a, b) => b.daysSince - a.daysSince).slice(0, 4);
}

/** 从单元格或备注抽出 RPE / RIR；缺填返回 null，不编造。 */
export function parseRpeRirToken(text = "") {
  const raw = cleanInline(text);
  if (!raw || raw === "—" || raw === "-" || /待填/.test(raw)) return { rpe: null, rir: null };
  let rpe = null;
  let rir = null;
  const rpeMatch = raw.match(/\bRPE\s*[=:：]?\s*(\d+(?:\.\d+)?)/i);
  if (rpeMatch) {
    const value = Number(rpeMatch[1]);
    if (value >= 1 && value <= 10) rpe = value;
  } else if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const value = Number(raw);
    if (value >= 1 && value <= 10) rpe = value;
  }
  const rirMatch = raw.match(/\bRIR\s*[=:：]?\s*(\d+(?:\.\d+)?)/i);
  if (rirMatch) {
    const value = Number(rirMatch[1]);
    if (value >= 0 && value <= 10) rir = value;
  }
  return { rpe, rir };
}

/** 解析训练日志一行：兼容四列旧表与五列（含 RPE）新表。 */
export function parseTrainingExerciseRow(row = []) {
  const cells = (Array.isArray(row) ? row : []).map((cell) => cleanInline(cell ?? ""));
  const name = cells[0] || "";
  const topSet = cells[2] || cells[1] || "";
  let note = "";
  let rpe = null;
  let rir = null;

  if (cells.length >= 5) {
    const dedicated = parseRpeRirToken(cells[3]);
    note = cells.slice(4).filter(Boolean).join(" ");
    if (dedicated.rpe != null || dedicated.rir != null) {
      rpe = dedicated.rpe;
      rir = dedicated.rir;
    } else if (cells[3] && cells[3] !== "—" && !/^\d+(?:\.\d+)?$/.test(cells[3]) && !/^RPE/i.test(cells[3])) {
      // 第 4 格不像 RPE（可能是旧备注错位）→ 并入备注再扫
      note = [cells[3], note].filter(Boolean).join(" ");
    }
  } else {
    note = cells[3] || "";
  }

  if (rpe == null && rir == null) {
    const fromNote = parseRpeRirToken(note);
    rpe = fromNote.rpe;
    rir = fromNote.rir;
  }

  return { name, topSet, rpe, rir, note };
}

/**
 * 强度维：只收录有 RPE/RIR 的样本；缺填不编造相对强度。
 * sessions 约定为新→旧（与 parseHealth 输出一致）。
 */
export function deriveSessionIntensity(sessions = []) {
  const samples = [];
  for (const session of sessions || []) {
    for (const exercise of session.exercises || []) {
      if (exercise.rpe == null && exercise.rir == null) continue;
      const bits = [
        session.date,
        exercise.name,
        exercise.rpe != null ? `RPE ${exercise.rpe}` : null,
        exercise.rir != null ? `RIR ${exercise.rir}` : null,
      ].filter(Boolean);
      samples.push({
        date: session.date,
        exercise: exercise.name,
        rpe: exercise.rpe ?? null,
        rir: exercise.rir ?? null,
        basis: bits.join(" · "),
      });
    }
  }
  return {
    sampleCount: samples.length,
    latest: samples[0] ?? null,
    samples: samples.slice(0, 24),
  };
}

/** 从「最重一组」文本抽出负重数字与次数序列（掉组用 → 分隔）。 */
export function parseTopSetLoad(topSet = "") {
  const text = String(topSet || "").replace(/^\*\*|\*\*$/g, "").trim();
  if (!text) return null;
  const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*kg/i);
  const weightKg = weightMatch ? Number(weightMatch[1]) : null;
  const arrowChunk = text.match(/×\s*([\d→\->次\/侧组\s]+)/i)?.[1] ?? text;
  const reps = [...arrowChunk.matchAll(/(\d+)\s*(?:次)?/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
  // 过滤掉「3组」里的组数：若末尾是小组数且前面有更大次数，去掉组数
  const filtered = reps.length >= 2 && reps.at(-1) <= 6 && reps[0] >= 8 ? reps.slice(0, -1) : reps;
  return { weightKg, reps: filtered, raw: text };
}

/**
 * 从「最重一组」估算容量。自重只计次；口述总量无组数不计吨位。
 * @returns {{ kind: "loaded", weightKg: number, volumeKg: number, sets: number|null, reps: number[], unilateral: boolean, raw: string }
 *   | { kind: "bodyweight", reps: number, sets: number|null, raw: string }
 *   | { kind: "skip", reason: string, raw: string }
 *   | null}
 */
export function parseSetVolume(topSet = "") {
  const text = String(topSet || "").replace(/^\*\*|\*\*$/g, "").trim();
  if (!text || text === "—") return null;
  // 「引体共约 20 个」这类口述总量：无组数 → 不计吨位
  if (/共\s*(?:约\s*)?\d+\s*个/.test(text) && !/\d+\s*组/.test(text)) {
    return { kind: "skip", reason: "oral-total-no-sets", raw: text };
  }

  const hasKg = /(\d+(?:\.\d+)?)\s*kg/i.test(text);
  const isBodyweight = /自重/.test(text) && !hasKg;
  const setsMatch = text.match(/(\d+)\s*组/);
  const sets = setsMatch ? Number(setsMatch[1]) : null;
  const parsed = parseTopSetLoad(text);
  const reps = parsed?.reps || [];
  const unilateral = /单手|\/侧/.test(text);

  const totalReps = () => {
    if (reps.length >= 2) return reps.reduce((sum, n) => sum + n, 0);
    if (reps.length === 1 && sets != null) return reps[0] * sets;
    if (reps.length === 1) return reps[0];
    return null;
  };

  if (isBodyweight) {
    const repTotal = totalReps();
    if (repTotal == null) return { kind: "skip", reason: "bodyweight-incomplete", raw: text };
    return { kind: "bodyweight", reps: repTotal, sets, raw: text };
  }

  if (parsed?.weightKg == null) return { kind: "skip", reason: "no-weight", raw: text };

  let volumeKg = null;
  if (reps.length >= 2) {
    volumeKg = parsed.weightKg * reps.reduce((sum, n) => sum + n, 0);
  } else if (reps.length === 1 && sets != null) {
    volumeKg = parsed.weightKg * reps[0] * sets;
  } else {
    return { kind: "skip", reason: sets == null ? "no-sets" : "no-reps", raw: text };
  }

  return {
    kind: "loaded",
    weightKg: parsed.weightKg,
    volumeKg,
    sets,
    reps,
    unilateral,
    raw: text,
  };
}

function tokyoWeekStartKey(dayKey) {
  const date = new Date(`${dayKey}T12:00:00+09:00`);
  const weekday = date.getDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  return tokyoDateKey(new Date(date.getTime() + offset * 86_400_000));
}

function muscleIdForExerciseName(name = "") {
  const text = String(name || "");
  for (const zone of STALE_MUSCLE_ZONES) {
    if (zone.keywords.some((keyword) => text.includes(keyword))) return zone.id;
  }
  return "other";
}

/**
 * 周容量（按肌群吨位）+ 各动作最重一组时间序列。
 * 自重动作只进 bodyweightReps，不折算进 tonnage。
 */
export function deriveTrainingVolume(sessions = []) {
  const weekMap = new Map();
  const seriesMap = new Map();

  const ensureWeek = (weekStart) => {
    let row = weekMap.get(weekStart);
    if (!row) {
      row = { weekStart, muscles: {}, bodyweightReps: {}, totalTonnageKg: 0 };
      weekMap.set(weekStart, row);
    }
    return row;
  };

  for (const session of sessions || []) {
    const date = String(session?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const week = ensureWeek(tokyoWeekStartKey(date));

    for (const exercise of session.exercises || []) {
      const name = String(exercise?.name || "").trim();
      if (!name) continue;
      const muscleId = muscleIdForExerciseName(name);
      const volume = parseSetVolume(exercise.topSet);
      const topParsed = parseTopSetLoad(exercise.topSet);

      const series = seriesMap.get(name) || [];
      series.push({
        date,
        topSet: String(exercise.topSet || ""),
        weightKg: topParsed?.weightKg ?? null,
        reps: topParsed?.reps ?? [],
        bodyweight: Boolean(volume && volume.kind === "bodyweight"),
      });
      seriesMap.set(name, series);

      if (!volume || volume.kind === "skip") continue;
      if (volume.kind === "bodyweight") {
        week.bodyweightReps[muscleId] = (week.bodyweightReps[muscleId] || 0) + volume.reps;
        continue;
      }
      week.muscles[muscleId] = (week.muscles[muscleId] || 0) + volume.volumeKg;
      week.totalTonnageKg += volume.volumeKg;
    }
  }

  const weekly = [...weekMap.values()]
    .map((row) => ({
      ...row,
      totalTonnageKg: Number(row.totalTonnageKg.toFixed(1)),
      muscles: Object.fromEntries(
        Object.entries(row.muscles).map(([id, kg]) => [id, Number(Number(kg).toFixed(1))]),
      ),
    }))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

  const topSetSeries = [...seriesMap.entries()]
    .map(([name, points]) => ({
      name,
      points: [...points].sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));

  return { weekly, topSetSeries };
}

/**
 * 力量里程碑：各动作个人最佳一组（按重量优先，同重比次数），并归大类。
 * 与肌肉图用的 `deriveStrengthBaseline` 目录表分开，避免双份同名覆盖。
 */
export function categorizeStrengthExercise(name = "") {
  const text = String(name || "");
  if (/热身|步行|纠正|拉伸|激活|放松|Cooldown|骨盆|前倾/.test(text)) return "激活与其他";
  if (/卧推|飞鸟|推胸|肩推|推举|俯卧撑|上斜|下斜|夹胸|侧平举|前平举|推肩/.test(text)) return "推举";
  if (/划船|引体|下拉|面拉|俯身|背阔|绳索面|高位下拉|坐姿划/.test(text)) return "拉力";
  if (/蹲|硬拉|腿举|分腿|弓步|提踵|臀桥|山羊|腿弯|腿伸|髋|罗马尼亚/.test(text)) return "下肢";
  if (/卷腹|举腿|平板支撑|核心|腹|扭转|鸟狗|死虫|侧撑/.test(text)) return "核心";
  return "其他";
}

function compareTopSetPoints(a, b) {
  const pa = parseTopSetLoad(a?.topSet);
  const pb = parseTopSetLoad(b?.topSet);
  const wa = pa?.weightKg;
  const wb = pb?.weightKg;
  if (wa != null && wb != null && wa !== wb) return wa - wb;
  if (wa != null && wb == null) return 1;
  if (wa == null && wb != null) return -1;
  const ra = pa?.reps?.[0] ?? 0;
  const rb = pb?.reps?.[0] ?? 0;
  if (ra !== rb) return ra - rb;
  return String(a?.date || "").localeCompare(String(b?.date || ""));
}

export function deriveStrengthBaselineTable(sessions = []) {
  const { topSetSeries } = deriveTrainingVolume(sessions);
  return topSetSeries
    .map((series) => {
      const candidates = (series.points || []).filter((point) => {
        const raw = String(point.topSet || "").trim();
        return raw && raw !== "—" && !raw.includes("?");
      });
      if (!candidates.length) return null;
      const best = [...candidates].sort(compareTopSetPoints).at(-1);
      if (!best?.topSet) return null;
      return {
        name: series.name,
        topSet: best.topSet,
        date: best.date,
        category: categorizeStrengthExercise(series.name),
        basis: `${best.date} [[训练日志]] 个人最佳一组`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const cat = String(a.category).localeCompare(String(b.category), "zh");
      if (cat) return cat;
      return a.name.localeCompare(b.name, "zh");
    });
}

/** 训练计划进阶规则原文参数：4 组都干到 8 次 → +2.5 kg；连续两周同重量次数不增 → 减 10%。 */
const PROGRESSION_TARGET_SETS = 4;
const PROGRESSION_REP_CEILING = 8;
const PROGRESSION_INCREASE_KG = 2.5;
const PROGRESSION_STALL_WEEKS = 2;

function setRepsFromVolume(volume) {
  if (!volume || volume.kind !== "loaded") return [];
  if (volume.reps.length >= 2) return volume.reps;
  if (volume.reps.length === 1 && volume.sets != null) {
    return Array.from({ length: volume.sets }, () => volume.reps[0]);
  }
  return [];
}

function bestFirstRep(points = []) {
  let best = 0;
  for (const point of points) {
    const reps = parseTopSetLoad(point.topSet)?.reps || [];
    if (reps[0] != null && reps[0] > best) best = reps[0];
  }
  return best;
}

/**
 * 进阶状态机（训练计划「先加次数，再加重量」）。
 * 每条建议必带 basis；同一动作若同时满足减载与加重，只出减载。
 */
export function deriveProgressionAdvice(sessions = []) {
  const { topSetSeries } = deriveTrainingVolume(sessions);
  const advice = [];

  for (const series of topSetSeries) {
    const loaded = series.points.filter((point) => point.weightKg != null && !point.bodyweight);
    if (!loaded.length) continue;

    const byWeek = new Map();
    for (const point of loaded) {
      const weekStart = tokyoWeekStartKey(point.date);
      const list = byWeek.get(weekStart) || [];
      list.push(point);
      byWeek.set(weekStart, list);
    }
    const weeks = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    let stalled = false;
    if (weeks.length >= PROGRESSION_STALL_WEEKS) {
      const recent = weeks.slice(-PROGRESSION_STALL_WEEKS);
      const weights = recent.map(([, points]) => points.at(-1)?.weightKg);
      const sameWeight = weights.every((kg) => kg != null && kg === weights[0]);
      if (sameWeight) {
        const repScores = recent.map(([, points]) => bestFirstRep(points));
        const notImproved = repScores.at(-1) <= repScores[0];
        if (notImproved) {
          stalled = true;
          const fromKg = weights[0];
          const toKg = Number((fromKg * 0.9).toFixed(1));
          advice.push({
            kind: "deload",
            exercise: series.name,
            text: `${series.name} 连续两周没进步，建议减到约 ${toKg} kg，或者先查睡眠和吃饭`,
            basis: recent
              .map(([weekStart, points], index) => `${weekStart} 最佳首组 ${repScores[index]} 次 @ ${points.at(-1).weightKg}kg（${points.at(-1).topSet}）`)
              .join(" → "),
            fromKg,
            toKg,
          });
        }
      }
    }

    if (stalled) continue;

    const last = loaded.at(-1);
    const volume = parseSetVolume(last.topSet);
    const setReps = setRepsFromVolume(volume);
    if (
      setReps.length >= PROGRESSION_TARGET_SETS
      && setReps.every((reps) => reps >= PROGRESSION_REP_CEILING)
    ) {
      const toKg = Number((last.weightKg + PROGRESSION_INCREASE_KG).toFixed(1));
      advice.push({
        kind: "increase",
        exercise: series.name,
        text: `${series.name} 四组都做到次数上限了，下次可以加到约 ${toKg} kg，从低次数重新开始`,
        basis: `${last.date} ${last.topSet}（${setReps.length} 组均 ≥ ${PROGRESSION_REP_CEILING} 次）`,
        fromKg: last.weightKg,
        toKg,
      });
    }
  }

  return advice;
}

const PUSH_MUSCLES = new Set(["chest", "shoulders"]);
const PULL_MUSCLES = new Set(["back"]);
const UPPER_MUSCLES = new Set(["chest", "back", "shoulders", "arms"]);
const LOWER_MUSCLES = new Set(["quads", "posterior"]);
const BALANCE_MIN_WEEKS = 2;
const BALANCE_MIN_SIDE_KG = 200;
const PLATEAU_WEEKS = 3;

function sumMuscleSet(muscles = {}, ids) {
  let total = 0;
  for (const id of ids) total += Number(muscles[id] || 0);
  return total;
}

/**
 * 推/拉、上/下肢容量比 + 平台期候选。
 * 样本不足返回 null 比值（不编造）；停滞措辞只用「平台期候选」。
 */
export function deriveMuscleBalance(sessions = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const { weekly, topSetSeries } = deriveTrainingVolume(list);
  const window = weekly.slice(0, 4); // 近最多 4 周
  const weekCount = window.length;

  let pushKg = 0;
  let pullKg = 0;
  let upperKg = 0;
  let lowerKg = 0;
  for (const week of window) {
    pushKg += sumMuscleSet(week.muscles, PUSH_MUSCLES);
    pullKg += sumMuscleSet(week.muscles, PULL_MUSCLES);
    upperKg += sumMuscleSet(week.muscles, UPPER_MUSCLES);
    lowerKg += sumMuscleSet(week.muscles, LOWER_MUSCLES);
  }
  pushKg = Number(pushKg.toFixed(1));
  pullKg = Number(pullKg.toFixed(1));
  upperKg = Number(upperKg.toFixed(1));
  lowerKg = Number(lowerKg.toFixed(1));

  const pushPullRatio =
    weekCount >= BALANCE_MIN_WEEKS && pushKg >= BALANCE_MIN_SIDE_KG && pullKg >= BALANCE_MIN_SIDE_KG
      ? Number((pushKg / pullKg).toFixed(2))
      : null;
  const upperLowerRatio =
    weekCount >= BALANCE_MIN_WEEKS && upperKg >= BALANCE_MIN_SIDE_KG && lowerKg >= BALANCE_MIN_SIDE_KG
      ? Number((upperKg / lowerKg).toFixed(2))
      : null;

  const plateauCandidates = [];
  for (const series of topSetSeries) {
    const loaded = series.points.filter((point) => point.weightKg != null && !point.bodyweight);
    if (loaded.length < PLATEAU_WEEKS) continue;

    const byWeek = new Map();
    for (const point of loaded) {
      const weekStart = tokyoWeekStartKey(point.date);
      const rows = byWeek.get(weekStart) || [];
      rows.push(point);
      byWeek.set(weekStart, rows);
    }
    const weeks = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (weeks.length < PLATEAU_WEEKS) continue;

    const recent = weeks.slice(-PLATEAU_WEEKS);
    const weights = recent.map(([, points]) => points.at(-1).weightKg);
    const reps = recent.map(([, points]) => bestFirstRep(points));
    const sameWeight = weights.every((kg) => kg === weights[0]);
    const noRepProgress = reps.every((value, index) => index === 0 || value <= reps[0]);
    if (!sameWeight || !noRepProgress) continue;

    plateauCandidates.push({
      exercise: series.name,
      weeks: PLATEAU_WEEKS,
      text: `${series.name} 连续 ${PLATEAU_WEEKS} 周没进步，可能卡住了`,
      basis: recent
        .map(([weekStart, points], index) => `${weekStart} ${points.at(-1).topSet}（首组 ${reps[index]} 次）`)
        .join(" → "),
      weightKg: weights[0],
    });
  }

  return {
    windowWeeks: weekCount,
    pushKg,
    pullKg,
    upperKg,
    lowerKg,
    pushPullRatio,
    upperLowerRatio,
    pushPullBasis:
      pushPullRatio == null
        ? weekCount < BALANCE_MIN_WEEKS
          ? `最近 ${weekCount} 周记录太少（要满 ${BALANCE_MIN_WEEKS} 周才算）`
          : `最近 ${weekCount} 周推 ${pushKg} kg / 拉 ${pullKg} kg，有一边不到 ${BALANCE_MIN_SIDE_KG} kg，先不算比例`
        : `最近 ${weekCount} 周推 ${pushKg} kg / 拉 ${pullKg} kg`,
    upperLowerBasis:
      upperLowerRatio == null
        ? weekCount < BALANCE_MIN_WEEKS
          ? `最近 ${weekCount} 周记录太少（要满 ${BALANCE_MIN_WEEKS} 周才算）`
          : `最近 ${weekCount} 周上肢 ${upperKg} kg / 下肢 ${lowerKg} kg，有一边不到 ${BALANCE_MIN_SIDE_KG} kg，先不算比例`
        : `最近 ${weekCount} 周上肢 ${upperKg} kg / 下肢 ${lowerKg} kg`,
    plateauCandidates,
  };
}

/**
 * 从训练计划解析「阶段起始日：YYYY-MM-DD」。
 */
export function parseStageStartDate(markdown = "") {
  const match = String(markdown || "").match(/阶段起始日[：:]\s*(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * 周期位置：自阶段起始日算第几周；满 4 周起提示讨论 deload（不自动改计划）。
 */
export function deriveMesocyclePosition({
  stageStart = null,
  today = tokyoWeekday().key,
} = {}) {
  if (!stageStart || !/^\d{4}-\d{2}-\d{2}$/.test(stageStart)) {
    return {
      stageStart: null,
      weekIndex: null,
      elapsedDays: null,
      suggestDeloadDiscuss: false,
      text: null,
      basis: "训练计划里没写这个阶段从哪天开始",
    };
  }
  const startMs = Date.parse(`${stageStart}T00:00:00+09:00`);
  const todayMs = Date.parse(`${today}T00:00:00+09:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(todayMs) || todayMs < startMs) {
    return {
      stageStart,
      weekIndex: null,
      elapsedDays: null,
      suggestDeloadDiscuss: false,
      text: null,
      basis: `阶段起始日 ${stageStart} 还没到，或者写错了`,
    };
  }
  const elapsedDays = Math.floor((todayMs - startMs) / 86_400_000);
  const weekIndex = Math.floor(elapsedDays / 7) + 1;
  const suggestDeloadDiscuss = weekIndex >= 4;
  return {
    stageStart,
    weekIndex,
    elapsedDays,
    suggestDeloadDiscuss,
    text: suggestDeloadDiscuss
      ? `这个训练阶段进行到第 ${weekIndex} 周，可以考虑安排一周减量`
      : `这个训练阶段进行到第 ${weekIndex} 周`,
    basis: `从 ${stageStart} 算起 ${elapsedDays} 天 · 第 ${weekIndex} 周`,
  };
}

/** 恢复负荷阈值：三者均达才提减量（NSCA 落地设计「恢复负荷」）。 */
const RECOVERY_TRAINING_DAYS_MIN = 3;
const RECOVERY_DETACH_DAYS_MIN = 2;
const RECOVERY_SLEEP_POOR_MIN = 2;

/**
 * 恢复负荷：力量日频率 + 心理脱离失败天数 + 睡眠「差」——三者叠加才 suggestDeload。
 * 缺测侧 elevated=null，绝不单靠训练或单靠心理一侧提减量。
 */
export function deriveRecoveryLoad({
  sessions = [],
  mindSignals = null,
  mindDays = [],
  today = tokyoWeekday().key,
} = {}) {
  const anchor = Date.parse(`${today}T00:00:00+09:00`);
  const cutoff7 = tokyoDateKey(new Date(anchor - 6 * 86_400_000));
  const cutoff14 = tokyoDateKey(new Date(anchor - 13 * 86_400_000));

  const trainingDates = [
    ...new Set(
      (sessions || [])
        .map((session) => String(session?.date || ""))
        .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= cutoff7 && day <= today),
    ),
  ];
  const strengthDays7 = trainingDates.length;
  const training = {
    elevated: strengthDays7 >= RECOVERY_TRAINING_DAYS_MIN,
    days: strengthDays7,
    basis: `最近 7 天练了 ${strengthDays7} 次（${RECOVERY_TRAINING_DAYS_MIN} 次以上才提醒）`,
  };

  const signalDays = (mindSignals?.days || []).filter(
    (day) => day?.date && day.date >= cutoff14 && day.date <= today,
  );
  const hasMindSample = signalDays.some((day) => day.sampled);
  const detachFailDays = signalDays.filter(
    (day) => day.sampled && Number(day.hits?.detachmentFail || 0) > 0,
  ).length;
  const detachment = hasMindSample
    ? {
        elevated: detachFailDays >= RECOVERY_DETACH_DAYS_MIN,
        days: detachFailDays,
        basis: `最近两周有 ${detachFailDays} 天写到下班停不下来（${RECOVERY_DETACH_DAYS_MIN} 天以上才提醒）`,
      }
    : {
        elevated: null,
        days: null,
        basis: "最近两周日志里没写到状态，这项没法看",
      };

  const sleepWindow = (mindDays || []).filter(
    (day) => day?.date && day.date >= cutoff14 && day.date <= today,
  );
  const sleepSampled = sleepWindow.filter((day) => day.sleep != null);
  const poorSleepDays = sleepSampled.filter((day) => day.sleep === "差").length;
  const sleep = sleepSampled.length > 0
    ? {
        elevated: poorSleepDays >= RECOVERY_SLEEP_POOR_MIN,
        days: poorSleepDays,
        basis: `最近两周有 ${poorSleepDays} 天自己写睡得差（一共记了 ${sleepSampled.length} 天；${RECOVERY_SLEEP_POOR_MIN} 天以上才提醒）`,
      }
    : {
        elevated: null,
        days: null,
        basis: "最近两周没记睡眠，这项没法看",
      };

  const allKnown = training.elevated != null && detachment.elevated != null && sleep.elevated != null;
  const suggestDeload = Boolean(allKnown && training.elevated && detachment.elevated && sleep.elevated);
  const factorBasis = [training.basis, detachment.basis, sleep.basis].join("；");

  return {
    suggestDeload,
    text: suggestDeload
      ? "练得多、恢复又差（下班停不下来加睡得差），建议这周减量或多休一天"
      : null,
    basis: factorBasis,
    factors: { training, detachment, sleep },
  };
}

/** 心舱传感词表（与 [[心理健康_理论框架]] §7 对齐；改词表须同步那边版本记录）。 */
const MIND_SIGNAL_LEXICON = {
  controlledMotivation: ["不得不", "必须", "答应了", "欠着", "拖不下去", "怕丢脸", "不好意思推", "硬扛"],
  autonomousMotivation: ["愿意", "值得", "有意思", "舍不得停", "自己挑的", "乐在其中"],
  competenceMet: ["搞明白了", "终于跑通", "越做越顺", "比上次强", "跑通了", "验收通过"],
  competenceThwarted: ["怎么都不对", "白折腾", "又搞砸", "看不到进展", "任重道远"],
  relatednessMet: ["一起", "被理解", "帮上忙了", "交到", "聚了"],
  relatednessThwarted: ["没人说得上话", "一个人闷", "懒得联系"],
  detachmentFail: ["一直在想", "睡前还在想", "停不下来", "刷到几点", "废寝忘食", "熬夜到"],
  relaxation: ["散步", "泡澡", "发呆", "听了会儿", "放空", "好好休息"],
  mastery: ["学会", "第一次做成", "试了个新的"],
  controlLoss: ["被安排", "被打断", "临时插进来", "计划全乱", "计划外"],
  ruminationAvoidance: ["又拖了", "不敢看", "打开又关掉", "越想越", "拖着没"],
};

const MIND_SIGNAL_PATTERNS = {
  relatednessMet: [/和.{1,12}聊/],
  autonomousMotivation: [/(?:^|[^\u4e00-\u9fff])想(?!着|到|必)/],
};

const MIND_SIGNAL_KEYS = Object.keys(MIND_SIGNAL_LEXICON);

function emptyMindHits() {
  return Object.fromEntries(MIND_SIGNAL_KEYS.map((key) => [key, 0]));
}

function countLexiconHits(text, key) {
  let count = 0;
  for (const term of MIND_SIGNAL_LEXICON[key] || []) {
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(term, from);
      if (at < 0) break;
      count += 1;
      from = at + term.length;
    }
  }
  for (const pattern of MIND_SIGNAL_PATTERNS[key] || []) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matches = text.match(new RegExp(pattern.source, flags));
    if (matches) count += matches.length;
  }
  return count;
}

/**
 * 解析日记里的日评恢复行（优先于词表兜底）。
 * 格式：恢复：收工就能放下 N · 日程未被打乱 N · 解决过难事 N · 有过真放松 N
 * N 为 0–100 或「未知」；缺项返回 null，逐项未知保留为 null。
 */
export function parseDiaryRecoveryLine(text = "") {
  const raw = String(text || "");
  const legacy = raw.match(
    /恢复[：:]\s*收工就能放下\s*(\d{1,3}|未知|—|-)\s*[·•、,，]\s*日程未被打乱\s*(\d{1,3}|未知|—|-)\s*[·•、,，]\s*解决过难事\s*(\d{1,3}|未知|—|-)\s*[·•、,，]\s*有过真放松\s*(\d{1,3}|未知|—|-)/,
  );
  const current = raw.match(
    /恢复[：:]\s*收工后?能放下\s*(\d{1,3}|未知|—|-)\s*[·•、,，]\s*休息时间由自己(?:支配)?\s*(\d{1,3}|未知|—|-)\s*[·•、,，]\s*有过真放松\s*(\d{1,3}|未知|—|-)/,
  );
  if (!legacy && !current) return null;
  const parseScore = (token) => {
    const normalized = String(token || "").trim();
    if (/^(?:未知|—|-)$/.test(normalized)) return null;
    const v = Number(normalized);
    if (!Number.isFinite(v)) return null;
    return Math.max(0, Math.min(100, Math.round(v)));
  };
  const detachmentFail = parseScore((legacy || current)[1]);
  const controlLoss = parseScore((legacy || current)[2]);
  const mastery = legacy ? parseScore(legacy[3]) : null;
  const relaxation = parseScore(legacy ? legacy[4] : current[3]);
  return { detachmentFail, controlLoss, mastery, relaxation };
}

/**
 * Capoo 自定「有没有真恢复」日分 → 近窗各维度有据日平均（0/50/100 档）。
 * 优先读日评写入的「恢复：」行；逐项未知不进该维度分母。没有明示行时才词表兜底，
 * 且无命中保持未知，不能把「没写到」换算成确定的 0 或 100。
 */
export function deriveRecoveryPercents(diaryEntries = []) {
  const keys = ["detachmentFail", "controlLoss", "mastery", "relaxation"];
  const sums = {
    detachmentFail: 0,
    controlLoss: 0,
    mastery: 0,
    relaxation: 0,
  };
  const sampleDays = {
    detachmentFail: 0,
    controlLoss: 0,
    mastery: 0,
    relaxation: 0,
  };
  let scoredDays = 0;

  const addDayScores = (scores) => {
    let dayHasScore = false;
    for (const key of keys) {
      const value = scores[key];
      if (value == null) continue;
      sums[key] += value;
      sampleDays[key] += 1;
      dayHasScore = true;
    }
    if (dayHasScore) scoredDays += 1;
  };

  for (const entry of diaryEntries || []) {
    const text = String(entry?.text || "").trim();
    if (!text) continue;

    const explicit = parseDiaryRecoveryLine(text);
    if (explicit) {
      addDayScores(explicit);
      continue;
    }

    const hits = emptyMindHits();
    for (const key of MIND_SIGNAL_KEYS) hits[key] = countLexiconHits(text, key);

    const lateWork = /通宵|跨夜|废寝忘食|熬夜到|凌晨\s*[0-4]|0[2-4]\s*[:：点]|约\s*0?[2-4]\s*点/.test(text);
    const detachHits = hits.detachmentFail || 0;
    const disruptHits = hits.controlLoss || 0;
    const masteryHits = hits.mastery || 0;
    const relaxHits = hits.relaxation || 0;
    addDayScores({
      detachmentFail: detachHits >= 2 ? 0 : detachHits === 1 || lateWork ? 50 : null,
      controlLoss: disruptHits >= 2 ? 0 : disruptHits === 1 ? 50 : null,
      mastery: masteryHits >= 2 ? 100 : masteryHits === 1 ? 50 : null,
      relaxation: relaxHits >= 2 ? 100 : relaxHits === 1 ? 50 : null,
    });
  }

  if (scoredDays === 0) {
    return {
      scoredDays: 0,
      sampleDays,
      percents: {
        detachmentFail: null,
        controlLoss: null,
        mastery: null,
        relaxation: null,
      },
    };
  }

  const avg = (key) => sampleDays[key] > 0 ? Math.round(sums[key] / sampleDays[key]) : null;
  return {
    scoredDays,
    sampleDays,
    percents: {
      detachmentFail: avg("detachmentFail"),
      controlLoss: avg("controlLoss"),
      mastery: avg("mastery"),
      relaxation: avg("relaxation"),
    },
  };
}

/**
 * 近 N 日日志传感：只出类别命中计数，不出正文。
 * 无日志、或纯流水无命中 → sampled:false / hits:null（缺就是缺，不补零）；
 * 有命中才算采样日。
 */
export function parseMindSignals(diaryEntries = []) {
  const days = [];
  const totals = emptyMindHits();
  let sampleDays = 0;
  let hitDays = 0;

  for (const entry of diaryEntries || []) {
    const date = entry?.date || "";
    const text = String(entry?.text || "");
    if (!text.trim()) {
      days.push({ date, sampled: false, hits: null, hitTotal: 0 });
      continue;
    }
    const hits = emptyMindHits();
    let hitTotal = 0;
    for (const key of MIND_SIGNAL_KEYS) {
      const n = countLexiconHits(text, key);
      hits[key] = n;
      hitTotal += n;
    }
    // 纯流水无命中：与无日志同属「无采样」，禁止回传全 0 hits
    if (hitTotal === 0) {
      days.push({ date, sampled: false, hits: null, hitTotal: 0 });
      continue;
    }
    for (const key of MIND_SIGNAL_KEYS) totals[key] += hits[key];
    sampleDays += 1;
    hitDays += 1;
    days.push({ date, sampled: true, hits, hitTotal });
  }

  return {
    days,
    sampleDays,
    hitDays,
    recovery: {
      detachmentFail: totals.detachmentFail,
      relaxation: totals.relaxation,
      mastery: totals.mastery,
      controlLoss: totals.controlLoss,
    },
    motivation: {
      controlled: totals.controlledMotivation,
      autonomous: totals.autonomousMotivation,
      competenceMet: totals.competenceMet,
      competenceThwarted: totals.competenceThwarted,
      relatednessMet: totals.relatednessMet,
      relatednessThwarted: totals.relatednessThwarted,
      ruminationAvoidance: totals.ruminationAvoidance,
    },
  };
}

/** 回能向命中（SDT / 恢复正向）。 */
const LINE_RECHARGE_KEYS = ["autonomousMotivation", "competenceMet", "relatednessMet", "relaxation", "mastery"];
/** 耗能向命中。 */
const LINE_DRAIN_KEYS = ["controlledMotivation", "competenceThwarted", "relatednessThwarted", "detachmentFail", "controlLoss", "ruminationAvoidance"];

function lineMatchAliases(item) {
  const name = String(item || "").trim();
  if (!name) return [];
  const aliases = [name];
  const stripped = name.replace(/[《》「」]/g, "").trim();
  if (stripped && stripped !== name) aliases.push(stripped);
  // 仅加不易误伤的简称；过宽词（如单独「公众号」）不加
  if (/日语/.test(name)) aliases.push("JLPT", "N2");
  if (/抖音/.test(name)) aliases.push("抖音");
  if (/小红书/.test(name)) aliases.push("小红书");
  return [...new Set(aliases.filter((alias) => alias.length >= 2))];
}

function diaryMentionsLine(text, item) {
  const body = String(text || "");
  if (!body.trim()) return false;
  return lineMatchAliases(item).some((alias) => alias.length >= 2 && body.includes(alias));
}

function scoreSignalPolarity(hits) {
  if (!hits) return { recharge: 0, drain: 0 };
  let recharge = 0;
  let drain = 0;
  for (const key of LINE_RECHARGE_KEYS) recharge += Number(hits[key] || 0);
  for (const key of LINE_DRAIN_KEYS) drain += Number(hits[key] || 0);
  return { recharge, drain };
}

/**
 * 衡舱聚合：用已有日记文本做主线名匹配 + X1 当日信号极性。
 * 不新建词表解析器；不回传正文。无共现信号 → 不出候选。
 */
export function aggregateLineEnergyCandidates(mainlines = [], mindSignals = null, diaryEntries = []) {
  const signalByDate = new Map((mindSignals?.days || []).map((day) => [day.date, day]));
  const buckets = new Map();

  for (const line of mainlines || []) {
    const item = String(line?.item || "").trim();
    if (!item) continue;
    buckets.set(item, { recharge: 0, drain: 0, dates: [] });
  }

  for (const entry of diaryEntries || []) {
    const date = entry?.date || "";
    const text = entry?.text || "";
    if (!date || !String(text).trim()) continue;
    const signalDay = signalByDate.get(date);
    if (!signalDay?.sampled || !signalDay.hits) continue; // 无传感命中不出候选
    const { recharge, drain } = scoreSignalPolarity(signalDay.hits);
    if (recharge + drain <= 0) continue;

    for (const [item, bucket] of buckets) {
      if (!diaryMentionsLine(text, item)) continue;
      bucket.recharge += recharge;
      bucket.drain += drain;
      if (!bucket.dates.includes(date)) bucket.dates.push(date);
    }
  }

  return (mainlines || []).map((line) => {
    const item = String(line?.item || "").trim();
    const bucket = buckets.get(item) || { recharge: 0, drain: 0, dates: [] };
    let energyCandidate = null;
    if (bucket.dates.length) {
      if (bucket.recharge > bucket.drain) energyCandidate = "回能";
      else if (bucket.drain > bucket.recharge) energyCandidate = "耗能";
      // 回能=耗能持平 → 不出候选，避免「中性?」噪声
    }
    return {
      ...line,
      energyCandidate,
      // 无候选时日期一并清空，避免「无候选伪依据」
      energyEvidenceDates: energyCandidate ? bucket.dates.slice().sort() : [],
    };
  });
}

function isDropSetWithinTopSet(parsed) {
  if (!parsed || parsed.reps.length < 2) return false;
  for (let i = 1; i < parsed.reps.length; i += 1) {
    if (parsed.reps[i] < parsed.reps[i - 1]) return true;
  }
  return false;
}

function findDropSetHint(sessions) {
  const chronological = [...(sessions || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // 同一次「最重一组」内掉组（如 15→12→10）
  for (let i = chronological.length - 1; i >= 0; i -= 1) {
    const session = chronological[i];
    for (const exercise of session.exercises || []) {
      const parsed = parseTopSetLoad(exercise.topSet);
      if (!parsed?.weightKg || !isDropSetWithinTopSet(parsed)) continue;
      const weightLabel = `${parsed.weightKg} kg`;
      return {
        tone: "action",
        text: `${exercise.name} 先稳住 ${weightLabel} 三组再加重`,
        basis: `${session.date} 最重一组 ${parsed.raw}`,
      };
    }
  }
  // 相邻两次同动作：负重相同、次数递减
  const byName = new Map();
  for (const session of chronological) {
    for (const exercise of session.exercises || []) {
      const name = String(exercise.name || "").trim();
      if (!name) continue;
      const list = byName.get(name) || [];
      list.push({ date: session.date, topSet: exercise.topSet, parsed: parseTopSetLoad(exercise.topSet) });
      byName.set(name, list);
    }
  }
  for (const [name, hits] of byName) {
    if (hits.length < 2) continue;
    const prev = hits.at(-2);
    const last = hits.at(-1);
    if (!prev.parsed?.weightKg || !last.parsed?.weightKg) continue;
    if (prev.parsed.weightKg !== last.parsed.weightKg) continue;
    const prevRep = prev.parsed.reps[0];
    const lastRep = last.parsed.reps[0];
    if (!prevRep || !lastRep || lastRep >= prevRep) continue;
    return {
      tone: "action",
      text: `${name} 先稳住 ${last.parsed.weightKg} kg 三组再加重`,
      basis: `${prev.date} ${prev.parsed.raw} → ${last.date} ${last.parsed.raw}`,
    };
  }
  return null;
}

function countStrengthDays(appleHealth, todayKey, windowDays) {
  const workouts = Array.isArray(appleHealth?.workouts) ? appleHealth.workouts : [];
  const anchor = Date.parse(`${todayKey}T00:00:00+09:00`);
  const cutoff = tokyoDateKey(new Date(anchor - (windowDays - 1) * 86_400_000));
  const days = new Set();
  for (const workout of workouts) {
    const day = String(workout?.day ?? workout?.date ?? "");
    if (!day || day < cutoff || day > todayKey) continue;
    const type = String(workout?.type ?? "");
    if (!/力量|Strength|传统力量/i.test(type)) continue;
    days.add(day);
  }
  return days.size;
}

/**
 * 教练行动条建议：只引用日志事实，无据不说话。
 * 今日菜单作为 info 首条（不算建议数）；其后最多 3 条 action/warn。
 */
export function buildCoachHints({ sessions = [], staleMuscles = [], todayPlan = null, appleHealth = null, today = tokyoWeekday().key } = {}) {
  const hints = [];
  if (todayPlan?.title && todayPlan.title !== "今天没排训练") {
    hints.push({
      tone: "info",
      text: `今日：${todayPlan.title}`,
      basis: todayPlan.detail || todayPlan.weekday || "",
    });
  }

  const actions = [];
  for (const muscle of staleMuscles) {
    if (muscle.status !== "overdue") continue;
    actions.push({
      tone: "warn",
      text: `${muscle.label} 已 ${muscle.daysSince} 天未练，本周排一次`,
      basis: muscle.lastDate ? `最近练到 ${muscle.lastDate}` : `已经 ${muscle.daysSince} 天没练`,
    });
  }

  const drop = findDropSetHint(sessions);
  if (drop) actions.push(drop);

  const strength7 = countStrengthDays(appleHealth, today, 7);
  const strength30 = countStrengthDays(appleHealth, today, 30);
  if (strength30 >= 4) {
    const weeklyAvg = strength30 / (30 / 7);
    if (strength7 + 0.5 < weeklyAvg) {
      const deficit = Math.max(1, Math.round(weeklyAvg - strength7));
      actions.push({
        tone: "action",
        text: `这周力量训练比平时少 ${deficit} 次`,
        basis: `最近 7 天 ${strength7} 次 · 最近 30 天 ${strength30} 次（平均每周约 ${weeklyAvg.toFixed(1)} 次）`,
      });
    }
  }

  hints.push(...actions.slice(0, 3));
  return hints;
}

export function parseHealth(bodyMarkdown, trainingMarkdown) {
  const measurements = [];
  const main = extractSection(bodyMarkdown, "围度与体重");
  const table = parseRawTable(main.split(/\*\*2026-/)[0]);
  if (table.length > 3) {
    const dates = table[0].slice(1);
    const rows = new Map(table.slice(2).map((row) => [cleanInline(row[0]), row.slice(1)]));
    dates.forEach((date, index) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const weightJin = numeric(rows.get("体重（斤）")?.[index]);
      measurements.push({ date, weightKg: weightJin ? Number((weightJin / 2).toFixed(2)) : undefined, waist: numeric(rows.get("腰围")?.[index]), chest: numeric(rows.get("胸围")?.[index]), arm: numeric(rows.get("大臂（曲臂）")?.[index]) });
    });
  }
  const bodyBeforeStrength = bodyMarkdown.split(/^##\s+力量表现/m)[0] ?? bodyMarkdown;
  for (const match of bodyBeforeStrength.matchAll(/\*\*(\d{4}-\d{2}-\d{2})[^*]*\*\*[^\n]*\n+([\s\S]*?)(?=\n\*\*\d{4}-\d{2}-\d{2}|\n## |\n$)/g)) {
    const date = match[1];
    const section = match[2];
    const rows = dataRows(section);
    if (!rows.length) continue;
    const lookup = (label) => numeric(rows.find((row) => cleanInline(row[0]).includes(label))?.[1]);
    const rawWeight = lookup("体重");
    const waist = lookup("腰围");
    const chest = lookup("胸围");
    const arm = lookup("大臂");
    if (rawWeight == null && waist == null && chest == null && arm == null) continue;
    measurements.push({ date, weightKg: rawWeight ? Number((rawWeight > 100 ? rawWeight / 2 : rawWeight).toFixed(2)) : undefined, waist: waist ?? undefined, chest: chest ?? undefined, arm: arm ?? undefined });
  }
  measurements.sort((a, b) => a.date.localeCompare(b.date));

  const sessions = [...trainingMarkdown.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})（[^\n]*?）｜([^\n]+)$/gm)].map((match, index, all) => {
    const start = match.index + match[0].length;
    const end = all[index + 1]?.index ?? trainingMarkdown.length;
    const section = trainingMarkdown.slice(start, end);
    const exercises = dataRows(section).map((row) => {
      const parsed = parseTrainingExerciseRow(row);
      return {
        name: parsed.name,
        topSet: parsed.topSet,
        rpe: parsed.rpe,
        rir: parsed.rir,
      };
    }).filter((item) => item.name && item.name !== "动作" && item.name !== "最重一组");
    const status = cleanInline(section.match(/\*\*(?:状态|事件|定位)\*\*：([^\n]+)/)?.[1] ?? "未记录");
    return { date: match[1], title: cleanInline(match[2]), status, exercises };
  });
  const latest = sessions.at(-1);
  const strength = deriveStrengthBaseline(sessions);
  const baselineDate = measurements[0]?.date || sessions[0]?.date || tokyoDateKey();
  return {
    baselineDate,
    weight: `${measurements.at(-1)?.weightKg?.toFixed(1) ?? "—"} kg`,
    latestTraining: latest ? `${latest.date} · ${latest.title}` : "还没有训练记录",
    note: "体脂秤只信体重那个数；腰围、照片和力量变化更靠得住。各动作最重记录是从训练日志自动算的。",
    measurements,
    undated: [],
    sessions: sessions.reverse(),
    strength,
  };
}

/** 从各次训练的「最重一组」列派生力量基线；含 ? 的存疑值不采信。 */
export function deriveStrengthBaseline(sessions) {
  const catalog = [
    { category: "拉力", label: "标准引体", match: /标准引体/ },
    { category: "拉力", label: "引体训练容量", match: /引体/ },
    { category: "拉力", label: "划船", match: /划船/ },
    { category: "推举", label: "杠铃卧推", match: /杠铃.*卧推|平板杠铃卧推|^卧推$/ },
    { category: "推举", label: "平板哑铃卧推", match: /哑铃卧推|平板哑铃/ },
    { category: "推举", label: "俯卧撑", match: /俯卧撑/ },
    { category: "下肢", label: "深蹲", match: /深蹲/ },
    { category: "下肢", label: "保加利亚分腿蹲", match: /保加利亚|分腿蹲/ },
    { category: "核心", label: "悬垂举腿", match: /悬垂举腿|举腿/ },
    { category: "核心", label: "平板支撑", match: /平板支撑/ },
  ];
  const latestByLabel = new Map();
  for (const session of sessions) {
    for (const exercise of session.exercises || []) {
      const raw = String(exercise.topSet || "").replace(/^\*\*|\*\*$/g, "").trim();
      if (!raw || raw === "—" || raw.includes("?")) continue;
      const hit = catalog.find((item) => item.match.test(exercise.name));
      if (!hit) continue;
      const prev = latestByLabel.get(hit.label);
      if (!prev || session.date >= prev.date) {
        latestByLabel.set(hit.label, {
          category: hit.category,
          label: hit.label,
          value: raw.replace(/\s+/g, " "),
          date: session.date,
          note: "来自训练日志的最重一组",
        });
      }
    }
  }
  // 标准引体与引体训练容量都匹配「引体」时，优先更具体的标签已各自写入；若只有一条引体，两边都可能命中——上面按 catalog 顺序，标准引体优先。
  return catalog.map((item) => latestByLabel.get(item.label)).filter(Boolean);
}

export function parseJapanese(statusMarkdown, dailyMarkdown) {
  const levels = dataRows(extractSection(statusMarkdown, "词汇线（Anki）")).map((row) => ({ name: cleanInline(row[0]), total: numeric(row[1]) ?? 0, learned: numeric(row[2]) ?? 0, status: cleanInline(row[5]) })).filter((row) => row.name && row.total);
  const scope = statusMarkdown.match(/当前计划范围[^：]*：已学\s*([\d]+)\s*\/\s*([\d]+)/);
  const decisions = parseCheckboxes(extractSection(statusMarkdown, "待办决策"), 8).map((item) => item.text);
  const latestDaily = [...dailyMarkdown.matchAll(/^##\s+(\d{4}-\d{2}-\d{2}[^\n]*)$/gm)].at(-1)?.[1] ?? "暂无每日记录";
  const reviewPace7 = numeric(statusMarkdown.match(/最近 7 个完整学习日[^\n]*答题[^\n]*日均约\s*([\d.]+)\s*次/)?.[1]);
  const newCardPace7 = numeric(statusMarkdown.match(/最近 7 个完整学习日[^\n]*引入新卡[^\n]*日均约\s*([\d.]+)\s*张/)?.[1]);
  const newCardPace14 = numeric(statusMarkdown.match(/最近 14 个完整学习日[^\n]*引入新卡[^\n]*日均约\s*([\d.]+)\s*张/)?.[1]);
  return {
    updatedAt: statusMarkdown.match(/最近更新：([^\n]+)/)?.[1]?.trim() ?? "未标注",
    stage: cleanInline(statusMarkdown.match(/## 当前阶段\s+\n+\*\*([^*]+)\*\*/)?.[1] ?? "暂无阶段判断"),
    progress: scope ? { learned: Number(scope[1]), total: Number(scope[2]) } : null,
    queue: numeric(statusMarkdown.match(/今日待复习\s*([^。\n]+)/)?.[1]),
    streak: numeric(statusMarkdown.match(/当前连续学习\s*([^。\n]+)/)?.[1]),
    pace7: newCardPace7,
    pace14: newCardPace14,
    reviewPace7,
    newCardPace7,
    newCardPace14,
    ankiSource: null,
    latestDaily: cleanInline(latestDaily),
    note: "词汇进度不代替文法、阅读和听力判断。",
    levels,
    decisions,
  };
}

function inferCourseCategory(title) {
  const rules = [
    ["文史经典", /通鉴|唐诗|宋词|苏轼|莎士比亚|中国史|罗马史|西方史|名家/],
    ["哲学思想", /哲学|思想|宗教|佛学|批判性/],
    ["经济金融", /经济|金融|保险|财务|行为金融|产业/],
    ["产品管理", /产品|增长|管理|组织|团队|品牌|营销|销售|商学院|职业|人脉/],
    ["AI 前沿", /AI|GPT|智能|NFT/],
    ["健康", /健康|医学|减肥|营养|大脑/],
    ["学习方法", /学习|研究|阅读与写作|数学|概率|信息论|声音|英语口语/],
  ];
  return rules.find(([, pattern]) => pattern.test(title))?.[0] ?? "通识课程";
}

function parseBooks(weread, paper, coversJsonText = "", warnings = []) {
  const coverMap = parseBookCoverMap(coversJsonText, warnings);
  const books = [];
  const append = (headingPrefix, status) => {
    const section = extractSection(weread, headingPrefix, 2, { prefix: true });
    if (!section) {
      if (String(weread || "").trim()) warnings.push({ source: SOURCES.weread, message: `未找到以「${headingPrefix}」开头的章节，${status}书目可能为空。` });
      return;
    }
    for (const row of dataRows(section)) {
      const title = cleanInline(row[0]);
      if (!title) continue;
      const cover = coverMap.get(title);
      books.push({
        id: contentId(`weread:${status}:${title}:${row[1]}`),
        kind: "book",
        title,
        author: cleanInline(row[1]),
        date: cleanInline(row[3]),
        category: cleanInline(row[2]) || "未分类",
        tags: ["微信读书", "虚构演示"],
        status,
        description: `${cleanInline(row[1]) || "作者未标"} · ${cleanInline(row[2]) || "分类未标"}`,
        tip: cover?.tip,
        sourcePath: SOURCES.weread,
        coverSeed: coverSeed(title),
        coverUrl: cover?.coverUrl,
      });
    }
  };
  append("已读完", "已读完");
  append("书架其他", "书架中");
  const paperSections = [...paper.matchAll(/^##\s+([^\n]+)\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm)];
  for (const match of paperSections) {
    if (match[1] === "待续") continue;
    for (const row of dataRows(match[2])) {
      const title = cleanInline(row[0]);
      if (!title) continue;
      const cover = coverMap.get(title);
      books.push({
        id: contentId(`paper:${title}:${row[1]}`),
        kind: "book",
        title,
        author: cleanInline(row[1]),
        category: cleanInline(match[1]),
        tags: ["纸质书"],
        status: "纸质通读",
        description: cleanInline(row[2]),
        tip: cover?.tip,
        sourcePath: SOURCES.paperBooks,
        coverSeed: coverSeed(title),
        coverUrl: cover?.coverUrl,
      });
    }
  }
  return books;
}

function formatPlaytimeLabel(hours) {
  const value = Number(hours) || 0;
  if (value <= 0) return "未启动";
  if (value >= 10) return `${Math.round(value)} 小时`;
  return `${value.toFixed(1)} 小时`;
}

function steamLibraryCoverUrl(appid) {
  return `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900.jpg`;
}

function hasCjkText(value = "") {
  return /[\u4e00-\u9fff]/.test(String(value));
}

function cleanOptionalInline(value) {
  if (value == null) return "";
  const text = cleanInline(value);
  if (!text || text === "null" || text === "undefined") return "";
  return text;
}

function pickSteamTitle(row) {
  const zh = cleanOptionalInline(row?.name_zh);
  const en = cleanOptionalInline(row?.name_en || row?.name_original || row?.name);
  const ja = cleanOptionalInline(row?.name_ja);
  if (zh && hasCjkText(zh)) return { title: zh, zh, en, ja };
  const fallback = en || zh || ja || "";
  return { title: fallback, zh: zh || null, en: en || fallback || null, ja: ja || null };
}

function steamAltNamesLine(title, en, ja) {
  const parts = [];
  if (en && en !== title) parts.push(en);
  if (ja && ja !== title && ja !== en) parts.push(ja);
  return parts.join(" · ");
}

function localGameCoverUrl(coverFile) {
  const relative = cleanOptionalInline(coverFile).replace(/^\/+/, "");
  if (!relative || relative.includes("..")) return undefined;
  return `/api/library-cover?path=${encodeURIComponent(relative)}`;
}

function localDedaoCoverUrl(coverFile) {
  const relative = cleanOptionalInline(coverFile).replace(/^\/+/, "");
  if (!relative || relative.includes("..")) return undefined;
  const vaultRelative = relative.startsWith(`${DEDAO_DIR}/`)
    ? relative
    : path.posix.join(DEDAO_DIR, relative.startsWith("封面/") ? relative : path.posix.join("封面", relative));
  return `/api/library-cover?path=${encodeURIComponent(vaultRelative)}`;
}

function localBookCoverUrl(coverFile) {
  const relative = cleanOptionalInline(coverFile).replace(/^\/+/, "");
  if (!relative || relative.includes("..")) return undefined;
  const shelfDir = path.posix.dirname(LIBRARY_OVERVIEW);
  const vaultRelative = relative.startsWith(`${shelfDir}/`)
    ? relative
    : path.posix.join(shelfDir, relative.startsWith("封面/") ? relative : path.posix.join("封面", relative));
  return `/api/library-cover?path=${encodeURIComponent(vaultRelative)}`;
}

function parseBookCoverMap(coversJsonText, warnings = []) {
  if (!String(coversJsonText || "").trim()) return new Map();
  let payload;
  try {
    payload = JSON.parse(coversJsonText);
  } catch (error) {
    warnings.push({ source: SOURCES.bookCovers, message: error instanceof Error ? error.message : "书架封面 JSON 无法解析" });
    return new Map();
  }
  const rows = Array.isArray(payload?.covers) ? payload.covers : [];
  const map = new Map();
  for (const row of rows) {
    const title = cleanOptionalInline(row?.title);
    const coverFile = cleanOptionalInline(row?.cover_file);
    if (!title || !coverFile) continue;
    map.set(title, {
      coverUrl: localBookCoverUrl(coverFile),
      tip: cleanOptionalInline(row?.cover_source) || undefined,
    });
  }
  return map;
}

function parseDedaoCoverMap(coversJsonText, warnings = []) {
  if (!String(coversJsonText || "").trim()) return new Map();
  let payload;
  try {
    payload = JSON.parse(coversJsonText);
  } catch (error) {
    warnings.push({ source: SOURCES.dedaoCovers, message: error instanceof Error ? error.message : "得到课程封面 JSON 无法解析" });
    return new Map();
  }
  const rows = Array.isArray(payload?.covers) ? payload.covers : [];
  const map = new Map();
  for (const row of rows) {
    const title = cleanOptionalInline(row?.title);
    const coverFile = cleanOptionalInline(row?.cover_file);
    if (!title || !coverFile) continue;
    map.set(title, {
      coverUrl: localDedaoCoverUrl(coverFile),
      tip: cleanOptionalInline(row?.cover_source) || undefined,
    });
  }
  return map;
}

function parseSteamGames(steamJsonText, warnings = []) {
  if (!String(steamJsonText || "").trim()) return [];
  let payload;
  try {
    payload = JSON.parse(steamJsonText);
  } catch (error) {
    warnings.push({ source: SOURCES.steamGames, message: error instanceof Error ? error.message : "Steam 库 JSON 无法解析" });
    return [];
  }
  const rows = Array.isArray(payload?.games) ? payload.games : [];
  return rows.map((row) => {
    const appid = Number(row?.appid);
    if (!Number.isFinite(appid)) return null;
    const { title, zh, en, ja } = pickSteamTitle(row);
    if (!title) return null;
    const playtimeMinutes = Math.max(0, Number(row?.playtime_minutes) || 0);
    const playtimeHours = Number.isFinite(Number(row?.playtime_hours))
      ? Number(row.playtime_hours)
      : Math.round((playtimeMinutes / 60) * 10) / 10;
    const played = playtimeMinutes > 0;
    const releaseDate = cleanOptionalInline(row?.release_date) || cleanOptionalInline(row?.acquired_at) || "";
    const altNames = steamAltNamesLine(title, en, ja);
    const localCover = localGameCoverUrl(row?.cover_file);
    const remoteCover = cleanOptionalInline(row?.cover_url);
    return {
      id: contentId(`steam:${appid}`),
      kind: "game",
      title,
      titleZh: zh || undefined,
      titleEn: en || undefined,
      titleJa: ja || undefined,
      date: releaseDate || "未标日期",
      category: "Steam",
      medium: "Steam",
      tags: played ? ["Steam", "玩过"] : ["Steam", "未启动"],
      status: formatPlaytimeLabel(playtimeHours),
      description: altNames || (played ? `累计 ${formatPlaytimeLabel(playtimeHours)}` : "库里有，还没启动过"),
      sourcePath: SOURCES.steamGames,
      coverSeed: coverSeed(title),
      coverUrl: localCover || remoteCover || steamLibraryCoverUrl(appid),
      playtimeHours,
      playtimeMinutes,
      externalUrl: `https://store.steampowered.com/app/${appid}/`,
    };
  }).filter(Boolean);
}

function parseExtraGames(extraJsonText, warnings = [], sourcePath = SOURCES.extraGames) {
  if (!String(extraJsonText || "").trim()) return [];
  let payload;
  try {
    payload = JSON.parse(extraJsonText);
  } catch (error) {
    warnings.push({ source: sourcePath, message: error instanceof Error ? error.message : "非 Steam 游戏 JSON 无法解析" });
    return [];
  }
  const rows = Array.isArray(payload?.games) ? payload.games : [];
  return rows.map((row) => {
    const id = cleanOptionalInline(row?.id) || cleanOptionalInline(row?.name_zh) || cleanOptionalInline(row?.name_en);
    if (!id) return null;
    const platform = cleanOptionalInline(row?.platform) || "其他";
    const { title, zh, en, ja } = pickSteamTitle(row);
    if (!title) return null;
    const releaseDate = cleanOptionalInline(row?.release_date);
    const medium = cleanOptionalInline(row?.medium) || "";
    const note = cleanOptionalInline(row?.note);
    const altNames = steamAltNamesLine(title, en, ja);
    const coverUrl = localGameCoverUrl(row?.cover_file)
      || cleanOptionalInline(row?.cover_url)
      || (Number(row?.steam_appid) ? steamLibraryCoverUrl(Number(row.steam_appid)) : undefined);
    const playtimeMinutes = Math.max(0, Number(row?.playtime_minutes) || 0);
    const playtimeHours = Number.isFinite(Number(row?.playtime_hours))
      ? Number(row.playtime_hours)
      : Math.round((playtimeMinutes / 60) * 10) / 10;
    const played = playtimeMinutes > 0 || playtimeHours > 0;
    return {
      id: contentId(`extra-game:${id}`),
      kind: "game",
      title,
      titleZh: zh || undefined,
      titleEn: en || undefined,
      titleJa: ja || undefined,
      date: releaseDate || "未标日期",
      category: platform,
      medium: medium || undefined,
      tags: [platform, row?.app_store_id ? "Apple Games" : "手录", played ? "玩过" : null].filter(Boolean),
      // 左下与 Steam 一致：有时长显示「N 小时」；没有就不占位（介质在右上）
      status: played ? formatPlaytimeLabel(playtimeHours) : "",
      description: [altNames, note].filter(Boolean).join(" · ") || platform,
      tip: note || undefined,
      sourcePath,
      coverSeed: coverSeed(title),
      coverUrl,
      playtimeHours: played ? playtimeHours : 0,
      playtimeMinutes: played
        ? (playtimeMinutes || Math.round(playtimeHours * 60))
        : 0,
      externalUrl: cleanOptionalInline(row?.external_url)
        || (Number(row?.steam_appid)
          ? `https://store.steampowered.com/app/${Number(row.steam_appid)}/`
          : undefined),
    };
  }).filter(Boolean);
}

function sortLibraryGames(games) {
  return [...games].sort((a, b) => {
    const play = (b.playtimeMinutes || 0) - (a.playtimeMinutes || 0);
    if (play) return play;
    const handA = (a.tags || []).includes("手录") ? 1 : 0;
    const handB = (b.tags || []).includes("手录") ? 1 : 0;
    if (handA !== handB) return handB - handA;
    return a.title.localeCompare(b.title, "zh-CN");
  });
}

function parseLibraryGames(steamJsonText, extraJsonText, appleJsonText, warnings = []) {
  const steam = parseSteamGames(steamJsonText, warnings);
  const extra = parseExtraGames(extraJsonText, warnings);
  const apple = parseExtraGames(appleJsonText, warnings, SOURCES.appleGames);
  return sortLibraryGames([...steam, ...extra, ...apple]);
}

function courseReviewOverviewPath(title) {
  return path.posix.join(DEDAO_DIR, title, `${title}_总览.md`);
}

async function pathExists(root, relativePath) {
  try {
    await fs.access(ensureInside(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function parseCourses(root, markdown, coversJsonText = "", warnings = []) {
  const coverMap = parseDedaoCoverMap(coversJsonText, warnings);
  const courses = [];
  const sections = [...markdown.matchAll(/^##\s+(20\d{2}|日期截图未完整显示)\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm)];
  for (const match of sections) {
    const year = match[1];
    for (const row of dataRows(match[2])) {
      const title = cleanInline(row[0]);
      if (!title) continue;
      const date = cleanInline(row[1]);
      const category = inferCourseCategory(title);
      const overviewPath = courseReviewOverviewPath(title);
      const openable = await pathExists(root, overviewPath);
      const cover = coverMap.get(title);
      courses.push({
        id: contentId(`course:${title}:${date}`),
        kind: "course",
        title,
        date,
        category,
        tags: ["得到", category],
        status: openable ? "有复习卡" : date === "待补" ? "日期待补" : "已毕业",
        description: openable
          ? `${year === "日期截图未完整显示" ? "日期待补" : year} · 有复习卡`
          : `${year === "日期截图未完整显示" ? "日期待补" : year} · ${category}`,
        tip: cover?.tip,
        sourcePath: openable ? overviewPath : SOURCES.dedao,
        coverSeed: coverSeed(title),
        coverUrl: cover?.coverUrl,
        openable,
      });
    }
  }
  return courses;
}

async function listMarkdown(root, relativeDirectory) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.name.endsWith(".md")) files.push(absolute);
    }
  }
  try { await visit(ensureInside(root, relativeDirectory)); } catch { return []; }
  return files;
}

function tagsOf(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "").replace(/^\[|\]$/g, "").split(",").map((tag) => tag.trim()).filter(Boolean);
}

function normalizeDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value ?? "未标日期");
}

const writingParseCache = new Map();

function shouldSkipWritingFile(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  if (base.includes("_总览")) return true;
  if (base.includes("更新日志")) return true;
  if (base === "创建公众号的朋友圈文案.md") return true;
  return false;
}

function writingCategory(relativePath, tags) {
  const normalized = String(relativePath).replace(/\\/g, "/");
  if (normalized.includes("公众号_示例手记")) {
    return "示例手记";
  }
  if (normalized.includes("创业日记")) return "创业日记";
  if (normalized.includes("自传系列")) return "自传";
  if (normalized.includes("English_Writing")) return "英文写作";
  if (normalized.includes("自由写作训练营")) return "自由写作训练";
  if (tags.includes("读后感")) return "读后感";
  if (tags.includes("虚构演示") || tags.includes("演示数据")) return "虚构演示";
  return "随笔";
}

function webWritingTitle(relativePath, headingTitle, fromWechat) {
  const base = path.posix.basename(String(relativePath), ".md");
  const cleanedFile = base
    .replace(/^\d+[_\s.\-]+/u, "")
    .replace(/^第\d+[期章节]?[_\s.\-]*/u, "")
    .trim();
  // 公众号文件名带 Obsidian 排序序号；网页展示优先用去序号后的文件名，避免正文小标题抢标题。
  if (fromWechat && cleanedFile) return cleanedFile;
  const heading = cleanInline(headingTitle || cleanedFile);
  const cleanedHeading = heading
    .replace(/^\d+[_\s.\-]+/u, "")
    .trim();
  if (/^[·•‧]/.test(cleanedHeading) || /^[一二三四五六七八九十百]+[、．.]/u.test(cleanedHeading)) {
    return cleanedFile || cleanedHeading;
  }
  return cleanedHeading || cleanedFile || heading;
}

async function parseWritingFile(root, absolute) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (shouldSkipWritingFile(relative)) return null;
  const stat = await fs.stat(absolute);
  const cacheKey = `${absolute}:${stat.mtimeMs}:title-v2`;
  let cached = writingParseCache.get(cacheKey);
  if (!cached) {
    const text = await fs.readFile(absolute, "utf8");
    const parsed = matter(text);
    const headingTitle = cleanInline(parsed.content.match(/^#\s+([^\n]+)/m)?.[1] ?? "");
    const fromWechat = relative.includes("公众号_示例手记");
    const title = webWritingTitle(relative, headingTitle || path.basename(relative, ".md"), fromWechat);
    if (!title || /^《?近思》?系列\/?\d*_?$/.test(title) || title === "13_") return null;
    const tags = tagsOf(parsed.data.tags);
    if (fromWechat && !tags.includes("示例手记")) tags.push("示例手记");
    if (fromWechat && !tags.includes("公众号")) tags.push("公众号");
    const category = writingCategory(relative, tags);
    const body = cleanInline(parsed.content.replace(/^#+\s+/gm, "")).replace(/\s+/g, " ");
    const bodyText = body.slice(0, 2000);
    cached = {
      id: contentId(relative),
      kind: "writing",
      title,
      date: normalizeDateValue(parsed.data.date),
      category,
      tags,
      status: relative.includes("/归档/") ? "归档" : fromWechat ? "公众号" : (tags.includes("虚构演示") || tags.includes("演示数据") ? "虚构演示" : "作品"),
      description: String(parsed.data.description ?? bodyText.slice(0, 120)),
      sourcePath: relative,
      coverSeed: coverSeed(title),
      archived: relative.includes("/归档/"),
      readTime: Math.max(1, Math.ceil(parsed.content.replace(/\s/g, "").length / 500)),
      searchableBody: body,
      openable: true,
    };
    for (const key of writingParseCache.keys()) {
      if (key.startsWith(`${absolute}:`) && key !== cacheKey) writingParseCache.delete(key);
    }
    writingParseCache.set(cacheKey, cached);
  }
  return cached;
}

async function parseWriting(root) {
  const dirs = [WRITING_DIR, WECHAT_OFFICIAL_DIR];
  const items = [];
  for (const dir of dirs) {
    const files = await listMarkdown(root, dir);
    for (const absolute of files) {
      const item = await parseWritingFile(root, absolute);
      if (item) items.push(item);
    }
  }
  return items.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.title.localeCompare(b.title, "zh-CN"));
}

function cleanTip(value = "") {
  return String(value)
    .split(/\r?\n/)
    .map((line) => cleanInline(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function topicHomeTip(parsed) {
  const fromMatter = cleanTip(String(parsed.data.tip ?? ""));
  if (fromMatter) return fromMatter;
  const fromBody = parsed.content.match(/^\s*-\s*\*\*首页 tip\*\*[：:]\s*(.+)$/m)?.[1]
    ?? parsed.content.match(/^\s*-\s*\*\*当前听到\*\*[：:]\s*(.+)$/m)?.[1];
  return fromBody ? cleanTip(fromBody) : "";
}

async function parseTopics(root, warnings) {
  const topics = [];
  for (const sourcePath of TOPIC_SOURCES) {
    const source = await readSource(root, sourcePath, warnings, true);
    if (!source.text.trim()) continue;
    const parsed = matter(source.text || "");
    const title = cleanInline(parsed.content.match(/^#\s+([^\n]+)/m)?.[1] ?? path.basename(sourcePath, ".md")).replace(/_总览$/, "");
    topics.push({
      id: contentId(sourcePath),
      topicId: cleanInline(parsed.data.topicId || "") || undefined,
      kind: "topic",
      title,
      category: "专题课程",
      tags: tagsOf(parsed.data.tags),
      status: "持续学习",
      description: String(parsed.data.description ?? firstParagraph(parsed.content)),
      tip: topicHomeTip(parsed),
      sourcePath,
      coverSeed: coverSeed(title),
      openable: true,
    });
  }
  return topics;
}

function markdownBullets(markdown) {
  return String(markdown || "")
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/u)?.[1] ?? "")
    .map(cleanInline)
    .filter(Boolean);
}

function parseGameResearchDomain(source, topics) {
  const overview = topics.find((item) => item.sourcePath === GAME_RESEARCH_OVERVIEW) ?? null;
  const parsed = matter(source.gameResearchQuestions?.text || "");
  const lines = String(parsed.content || "")
    .split(/^##\s+/mu)
    .slice(1)
    .map((section) => {
      const [heading = "", ...body] = section.split("\n");
      const title = cleanInline(heading);
      return {
        id: contentId(`${GAME_RESEARCH_QUESTIONS}#${title}`),
        title,
        questions: markdownBullets(body.join("\n")),
      };
    })
    .filter((section) => section.title && section.title !== "研究完成后要回答" && section.questions.length);
  return {
    id: "game",
    title: "游戏",
    description: overview?.description || "从作品、文化、设计与制作理解游戏这个领域。",
    overviewId: overview?.id ?? null,
    sourcePath: overview?.sourcePath ?? GAME_RESEARCH_OVERVIEW,
    updatedAt: source.gameResearch?.updatedAt ?? null,
    researchLines: lines,
  };
}

function parseCultureCard(source) {
  if (!source?.text?.trim()) return null;
  const parsed = matter(source.text);
  const title = cleanInline(parsed.content.match(/^#\s+([^\n]+)/mu)?.[1] ?? path.basename(source.path, ".md"));
  const judgmentBody = extractSection(parsed.content, "本人原始判断");
  const originalJudgment = cleanInline(judgmentBody.match(/^>\s*(?!\[!)(.+)$/mu)?.[1] ?? "");
  const prompts = markdownBullets(extractSection(parsed.content, "待本人补充"));
  const archiveRoles = (Array.isArray(parsed.data.archive_roles)
    ? parsed.data.archive_roles
    : String(parsed.data.archive_roles || "").split(","))
    .map((role) => cleanInline(role))
    .filter(Boolean);
  return {
    id: contentId(source.path),
    title,
    description: String(parsed.data.description ?? "").trim(),
    medium: cleanInline(parsed.data.medium || "游戏"),
    region: cleanInline(parsed.data.region || ""),
    tags: tagsOf(parsed.data.tags),
    viewingStatus: cleanInline(parsed.data.viewing_status || ""),
    recommended: archiveRoles.includes("recommendation"),
    influence: archiveRoles.includes("influence"),
    originalJudgment,
    prompts,
    sourcePath: source.path,
  };
}

function parseScreenCatalog(source) {
  if (!source?.text?.trim()) return [];
  const parsed = matter(source.text);
  const metadataByTitle = new Map(
    dataRows(extractSection(parsed.content, "动漫展示元数据")).flatMap((row) => {
      const [rawTitle = "", rawYear = "", rawGenre = "", rawRecommended = "", rawSource = ""] = row;
      const title = cleanInline(rawTitle);
      const releaseYear = Number.parseInt(cleanInline(rawYear), 10);
      if (!title || !Number.isFinite(releaseYear)) return [];
      return [[title, {
        releaseYear,
        primaryGenre: cleanInline(rawGenre),
        recommended: cleanInline(rawRecommended) === "是",
        metadataSource: cleanInline(rawSource),
      }]];
    }),
  );
  const groups = [
    { heading: "日漫馆藏清单", medium: "动画", region: "日漫" },
    { heading: "国漫馆藏清单", medium: "动画", region: "国漫" },
    { heading: "其他引进动画馆藏清单", medium: "动画", region: "其他引进" },
    { heading: "电影馆藏清单", medium: "电影", region: "" },
  ];
  return groups.flatMap(({ heading, medium, region }) => dataRows(extractSection(parsed.content, heading)).flatMap((row) => {
    const [rawTitle = "", rawStatus = "", rawSource = ""] = row;
    const title = cleanInline(rawTitle);
    const viewingStatus = cleanInline(rawStatus);
    if (!title || !["看过", "正在看", "想看"].includes(viewingStatus)) return [];
    const descriptions = {
      看过: "已确认观看过。",
      正在看: "已经开始观看，尚未看完。",
      想看: "已收藏，尚未观看。",
    };
    return [{
      id: contentId(`${source.path}#${medium}:${title}`),
      title,
      description: descriptions[viewingStatus],
      medium,
      region,
      tags: ["艺术馆藏", medium, viewingStatus],
      viewingStatus,
      confirmationSource: cleanInline(rawSource),
      ...(metadataByTitle.get(title) || {}),
      sourcePath: source.path,
      openable: false,
    }];
  }));
}

function buildCultureArchive(sources) {
  const cultureSources = [
    sources.cultureWow,
    sources.cultureSouls,
    sources.cultureZelda,
    sources.screenFanren,
    sources.screenFma,
    sources.screenMadoka,
    sources.screenCodeGeass,
    sources.screenEagle,
    sources.screenCinemaParadiso,
  ];
  return {
    cards: cultureSources.map(parseCultureCard).filter(Boolean),
    screenCatalog: parseScreenCatalog(sources.screenOverview),
    paths: {
      gameOverview: GAME_CULTURE_OVERVIEW,
      screenOverview: SCREEN_OVERVIEW,
    },
  };
}

export async function buildLibrary(root, sources, warnings) {
  const [writing, topics, courses, animeCovers] = await Promise.all([
    parseWriting(root),
    parseTopics(root, warnings),
    parseCourses(root, sources.dedao.text, sources.dedaoCovers?.text || "", warnings),
    readAnimeCoverCatalog(animeCoversSupportDir(root)),
  ]);
  for (const message of animeCovers.warnings) warnings.push({ source: "Infans_Support/10_学习资料/艺术馆藏/动漫封面/封面清单.json", message });
  const books = parseBooks(sources.weread.text, sources.paperBooks.text, sources.bookCovers?.text || "", warnings);
  const games = parseLibraryGames(sources.steamGames?.text, sources.extraGames?.text, sources.appleGames?.text, warnings);
  const cultureArchive = buildCultureArchive(sources);
  const screenCatalogByTitle = new Map(cultureArchive.screenCatalog.map((item) => [item.title, item]));
  const cultureScreenItems = cultureArchive.cards
    .filter((card) => card.medium !== "游戏")
    .map((card) => ({
      ...screenCatalogByTitle.get(card.title),
      id: card.id,
      kind: card.medium === "动画" ? "animation" : "screen",
      title: card.title,
      category: card.medium,
      tags: card.tags,
      status: screenCatalogByTitle.get(card.title)?.viewingStatus || card.viewingStatus || "已记录",
      description: card.originalJudgment || card.description,
      sourcePath: card.sourcePath,
      coverSeed: coverSeed(card.title),
      coverUrl: matchAnimeCover(animeCovers.covers, {
        title: card.title,
        metadataSource: screenCatalogByTitle.get(card.title)?.metadataSource,
      })?.coverUrl,
      medium: card.medium,
      region: screenCatalogByTitle.get(card.title)?.region || card.region,
      viewingStatus: screenCatalogByTitle.get(card.title)?.viewingStatus || card.viewingStatus,
      recommended: card.recommended || Boolean(screenCatalogByTitle.get(card.title)?.recommended),
      influence: card.influence,
      reflectionPrompt: card.prompts[0] || "",
      openable: true,
    }));
  const cultureScreenTitles = new Set(cultureScreenItems.map((item) => item.title));
  const catalogScreenItems = cultureArchive.screenCatalog
    .filter((item) => !cultureScreenTitles.has(item.title))
    .map((item) => ({
      ...item,
      kind: item.medium === "动画" ? "animation" : "screen",
      category: item.medium,
      status: item.viewingStatus,
      coverSeed: coverSeed(item.title),
      coverUrl: matchAnimeCover(animeCovers.covers, item)?.coverUrl,
      reflectionPrompt: "",
    }));
  const screenItems = [...cultureScreenItems, ...catalogScreenItems];
  return {
    books,
    courses,
    writing,
    topics,
    games,
    animation: screenItems.filter((item) => item.kind === "animation"),
    screen: screenItems.filter((item) => item.kind === "screen"),
    cultureArchive,
    items: [...writing, ...books, ...courses, ...topics, ...games, ...screenItems],
  };
}

function sortReviewFileNames(a, b) {
  const overviewScore = (name) => (name.includes("_总览") ? 0 : 1);
  const byOverview = overviewScore(a) - overviewScore(b);
  if (byOverview) return byOverview;
  return a.localeCompare(b, "zh-CN", { numeric: true });
}

function rewriteWikiLinks(markdown, linkMap) {
  return String(markdown || "").replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (full, raw, label) => {
    const key = cleanInline(raw).replace(/\.md$/i, "");
    const id = linkMap.get(key) || linkMap.get(key.replace(/^.*\//, ""));
    if (!id) return full;
    const text = cleanInline(label || key.replace(/^.*\//, "").replace(/^\d+_/, ""));
    return `[${text}](infans-doc:${id})`;
  });
}

async function listDedaoReviewSiblings(root, courseTitle, courseId, overviewPath) {
  const dirRelative = path.posix.join(DEDAO_DIR, courseTitle);
  let names = [];
  try {
    names = (await fs.readdir(ensureInside(root, dirRelative)))
      .filter((name) => name.endsWith(".md"))
      .sort(sortReviewFileNames);
  } catch {
    return [];
  }
  return names.map((name) => {
    const relative = path.posix.join(dirRelative, name);
    const isOverview = relative === overviewPath || name.includes("_总览");
    const stem = name.replace(/\.md$/i, "");
    return {
      id: isOverview ? courseId : contentId(relative),
      title: isOverview ? "总览" : stem.replace(/^\d+_/, ""),
      sourcePath: relative,
      stem,
    };
  });
}

async function hydrateMarkdownDocument(root, item, siblings = []) {
  const parsed = matter(await fs.readFile(ensureInside(root, item.sourcePath), "utf8"));
  const linkMap = new Map();
  for (const sibling of siblings) {
    linkMap.set(sibling.stem, sibling.id);
    linkMap.set(sibling.title, sibling.id);
    linkMap.set(path.posix.basename(sibling.sourcePath, ".md"), sibling.id);
    if (sibling.sourcePath.endsWith("_总览.md")) {
      linkMap.set(path.posix.basename(sibling.sourcePath, ".md"), sibling.id);
    }
  }
  const markdown = siblings.length ? rewriteWikiLinks(parsed.content, linkMap) : parsed.content;
  const headings = [...markdown.matchAll(/^(#{1,4})\s+([^\n]+)/gm)].map((match) => ({
    level: match[1].length,
    text: cleanInline(match[2]),
    id: `h-${coverSeed(`${item.id}:${match.index}`).toString(36)}`,
  }));
  const index = siblings.findIndex((entry) => entry.id === item.id);
  const previousId = index > 0 ? siblings[index - 1].id : null;
  const nextId = index >= 0 && index < siblings.length - 1 ? siblings[index + 1].id : null;
  return {
    ...item,
    markdown,
    headings,
    previousId: siblings.length ? previousId : item.previousId ?? null,
    nextId: siblings.length ? nextId : item.nextId ?? null,
    siblings: siblings.map((entry) => ({ id: entry.id, title: entry.title })),
  };
}

export async function readWritingById(root, id) {
  const writing = await parseWriting(root);
  const item = writing.find((entry) => entry.id === id);
  if (!item) return null;
  const index = writing.findIndex((entry) => entry.id === id);
  return hydrateMarkdownDocument(root, {
    ...item,
    previousId: writing[index - 1]?.id ?? null,
    nextId: writing[index + 1]?.id ?? null,
  });
}

export async function readLibraryDocumentById(root, id) {
  const writing = await readWritingById(root, id);
  if (writing) return writing;

  for (const sourcePath of CULTURE_DOCUMENT_SOURCES) {
    if (contentId(sourcePath) !== id) continue;
    const source = await readSource(root, sourcePath, [], true);
    const card = parseCultureCard(source);
    if (!card) return null;
    return hydrateMarkdownDocument(root, {
      ...card,
      kind: "topic",
      category: card.medium === "游戏" ? "个人游戏文化谱系" : "个人动漫与影视文化谱系",
      tags: card.tags,
      coverSeed: coverSeed(card.title),
      openable: true,
    });
  }

  for (const sourcePath of TOPIC_SOURCES) {
    if (contentId(sourcePath) !== id) continue;
    const source = await readSource(root, sourcePath, []);
    const parsed = matter(source.text || "");
    const title = cleanInline(parsed.content.match(/^#\s+([^\n]+)/m)?.[1] ?? path.basename(sourcePath, ".md")).replace(/_总览$/, "");
    return hydrateMarkdownDocument(root, {
      id,
      topicId: cleanInline(parsed.data.topicId || "") || undefined,
      kind: "topic",
      title,
      category: "专题课程",
      tags: tagsOf(parsed.data.tags),
      status: "持续学习",
      description: String(parsed.data.description ?? firstParagraph(parsed.content)),
      sourcePath,
      coverSeed: coverSeed(title),
      openable: true,
    });
  }

  const warnings = [];
  const dedao = await readSource(root, SOURCES.dedao, warnings);
  const dedaoCovers = await readSource(root, SOURCES.dedaoCovers, warnings, true);
  const courses = await parseCourses(root, dedao.text || "", dedaoCovers.text || "", warnings);
  for (const course of courses) {
    if (!course.openable) continue;
    const siblings = await listDedaoReviewSiblings(root, course.title, course.id, course.sourcePath);
    const hit = siblings.find((entry) => entry.id === id) || (course.id === id ? siblings[0] : null);
    if (!hit) continue;
    return hydrateMarkdownDocument(root, {
      ...course,
      id: hit.id,
      title: hit.id === course.id ? course.title : hit.title,
      sourcePath: hit.sourcePath,
      openable: true,
      readTime: undefined,
    }, siblings);
  }

  return null;
}

export async function searchVault(root, query) {
  const q = cleanInline(query).toLocaleLowerCase("zh-CN").slice(0, 80);
  if (!q) return [];
  const warnings = [];
  const entries = await Promise.all([SOURCES.weread, SOURCES.paperBooks, SOURCES.dedao, SOURCES.projects, SOURCES.flagship, SOURCES.coaching].map((p) => readSource(root, p, warnings)));
  const sources = { weread: entries[0], paperBooks: entries[1], dedao: entries[2] };
  const library = await buildLibrary(root, sources, warnings);
  const results = [];
  for (const item of library.items) {
    let searchable = `${item.title} ${item.author ?? ""} ${item.category} ${item.description} ${item.tags.join(" ")}`;
    let description = item.description;
    if (item.kind === "writing") {
      const body = item.searchableBody || "";
      searchable += ` ${body}`;
      const at = body.toLocaleLowerCase("zh-CN").indexOf(q);
      if (at >= 0) description = `${at > 28 ? "…" : ""}${body.slice(Math.max(0, at - 28), at + q.length + 72)}${at + q.length + 72 < body.length ? "…" : ""}`;
    }
    if (!searchable.toLocaleLowerCase("zh-CN").includes(q)) continue;
    results.push({
      id: item.id,
      module: item.kind,
      title: item.title,
      description,
      route: item.kind === "writing"
        ? `/library?kind=writing&open=${item.id}`
        : item.kind === "book"
          ? `/library?kind=book&q=${encodeURIComponent(q)}`
          : item.kind === "game"
            ? `/library?kind=game&q=${encodeURIComponent(q)}`
          : item.kind === "course"
            ? (item.openable ? `/topics?tab=done&open=${item.id}` : `/topics?tab=done&q=${encodeURIComponent(q)}`)
            : `/topics?q=${encodeURIComponent(q)}`,
      sourcePath: item.sourcePath,
    });
  }
  const projectRows = parseProjects(entries[3].text);
  const flagship = parseFlagship(entries[4].text, warnings);
  const coaching = parseCoaching(entries[5].text, "", warnings);
  const projects = [
    { id: contentId(SOURCES.flagship), module: "project", title: "小秘书", description: `${flagship.version} · ${flagship.focus}`, route: "/projects?project=flagship", sourcePath: SOURCES.flagship },
    { id: contentId(SOURCES.coaching), module: "project", title: "阳台种植计划", description: coaching.focus, route: "/projects?project=coach", sourcePath: SOURCES.coaching },
    ...projectRows.map((item) => ({ id: contentId(`project:${item.name}`), module: "project", title: item.name, description: `${item.status} · ${item.entry}`, route: `/projects?project=${encodeURIComponent(projectIdFromName(item.name))}`, sourcePath: SOURCES.projects })),
  ];
  for (const project of projects) if (`${project.title} ${project.description}`.toLocaleLowerCase("zh-CN").includes(q) && !results.some((item) => item.title === project.title && item.module === "project")) results.push(project);
  return results.slice(0, 30);
}

async function readRecentDiaries(root, days = 14, today = tokyoWeekday().key) {
  const entries = [];
  const anchor = Date.parse(`${today}T00:00:00+09:00`);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = tokyoDateKey(new Date(anchor - offset * 86_400_000));
    const relativePath = diaryPathForDay(day);
    try {
      const absolute = ensureInside(root, relativePath);
      const text = await fs.readFile(absolute, "utf8");
      entries.push({ date: day, text });
    } catch {
      entries.push({ date: day, text: "" });
    }
  }
  return entries;
}

/**
 * 只认「工作强度 N/10」（N=0–10）。旧「工作强度 N/5」按 ×2 换算到 10 级（兼容未改稿的日志）。
 * 旧「精力 N/5」口径不同，不映射。
 * 整篇日志搜（不限「工作台快速记录」节——行可能写在小结里）。
 * 若仍写了「睡眠 差/一般/好」则顺带解析，供恢复负荷旁证；日评不再要求写睡眠。
 */
export function parseDiaryWorkIntensity(diaryEntries = [], sessions = [], today = tokyoWeekday().key, calendarSnapshot = null) {
  const trainedDates = new Set((sessions || []).map((session) => session.date));
  const restDays = new Map(deriveSchoolRestDays(diaryEntries.map((entry) => entry.date || today), calendarSnapshot).map((day) => [day.date, day]));
  const days = [];
  for (const entry of diaryEntries) {
    const date = entry.date || today;
    const text = entry.text || "";
    const quick = extractSection(text, "工作台快速记录");
    // 强度：全文搜，避免写在小结而快速记录节里没有
    let workIntensity = null;
    const intensity10 = text.match(/工作强度\s*(10|[0-9])\s*\/\s*10/);
    if (intensity10) {
      workIntensity = Number(intensity10[1]);
    } else {
      const intensity5 = text.match(/工作强度\s*([1-5])\s*\/\s*5/);
      if (intensity5) workIntensity = Number(intensity5[1]) * 2;
    }
    // 睡眠：优先快速记录节，否则全文（旧模板常在状态节）
    let sleep = null;
    const sleepHaystack = quick || text;
    const sleepMatch = sleepHaystack.match(/睡眠\s*(差|一般|好)/);
    if (sleepMatch) sleep = sleepMatch[1];
    const rest = restDays.get(date);
    days.push({
      date,
      workIntensity,
      sleep,
      trained: trainedDates.has(date),
      restDay: Boolean(rest?.restDay),
      restReasons: rest?.restReasons || [],
    });
  }
  return {
    days,
    sampleDays: days.filter((day) => day.workIntensity != null).length,
  };
}

function compassSnippet(markdown = "") {
  const raw = String(markdown || "");
  if (!raw.trim() || /待本人填写/.test(raw)) return { filled: false, text: "", body: [] };
  const oneLiner = extractSection(raw, "一句话", 2);
  const body = extractSection(raw, "正文", 2);
  const candidate = cleanInline(oneLiner || body || raw)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#+\s*.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate || candidate.length < 4) return { filled: false, text: "", body: [] };
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((block) => block
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:#|\||<!--)/.test(line))
      .map((line) => cleanInline(line.replace(/^\s*>\s?/, "")))
      .filter(Boolean)
      .join(" ")
      .trim())
    .filter(Boolean)
    .slice(0, 8);
  return { filled: true, text: candidate.slice(0, 1200), body: paragraphs };
}

export function parseCompassDocs(workviewMarkdown = "", lifeviewMarkdown = "") {
  const work = compassSnippet(workviewMarkdown);
  const life = compassSnippet(lifeviewMarkdown);
  return {
    filled: work.filled && life.filled,
    workview: work.text,
    lifeview: life.text,
    workviewBody: work.body,
    lifeviewBody: life.body,
  };
}

/** H8：指南针一致性三边。人工判定，不做算法评分、不合成总分。 */
const COHERENCE_EDGE_DEFS = Object.freeze([
  { id: "work_life", label: "工作观 ↔ 人生观", aliases: ["工作观↔人生观", "工作观 × 人生观", "工作观×人生观"] },
  {
    id: "work_lines",
    label: "工作观 ↔ 在推进的事项",
    aliases: [
      "工作观↔在推进的事项", "工作观 × 在推进的事项", "工作观×在推进的事项",
      "工作观 ↔ 在跑的线", "工作观↔在跑的线", "工作观 × 在跑的线", "工作观×在跑的线",
    ],
  },
  {
    id: "life_lines",
    label: "人生观 ↔ 在推进的事项",
    aliases: [
      "人生观↔在推进的事项", "人生观 × 在推进的事项", "人生观×在推进的事项",
      "人生观 ↔ 在跑的线", "人生观↔在跑的线", "人生观 × 在跑的线", "人生观×在跑的线",
    ],
  },
]);
const COHERENCE_VERDICTS = new Set(["说得通", "说不通", "没想过"]);

function normalizeCoherenceEdgeKey(value = "") {
  return cleanInline(value).replace(/\s+/g, "").replace(/[－—–−]/g, "↔").replace(/[×xX]/g, "↔");
}

export function parseCompassCoherence(markdown = "") {
  const section = extractSection(markdown, "指南针一致性", 2);
  if (!section.trim()) return null;
  const byKey = new Map();
  for (const row of dataRows(section)) {
    const edgeRaw = cleanInline(row[0] ?? "");
    if (!edgeRaw || edgeRaw === "边") continue;
    const verdictRaw = cleanInline(row[1] ?? "");
    const note = cleanInline(row[2] ?? "");
    const verdict = COHERENCE_VERDICTS.has(verdictRaw) ? verdictRaw : null;
    byKey.set(normalizeCoherenceEdgeKey(edgeRaw), { verdict, note });
  }
  const edges = COHERENCE_EDGE_DEFS.map((def) => {
    const keys = [def.label, ...def.aliases].map(normalizeCoherenceEdgeKey);
    let hit = null;
    for (const key of keys) {
      if (byKey.has(key)) {
        hit = byKey.get(key);
        break;
      }
    }
    return {
      id: def.id,
      label: def.label,
      verdict: hit?.verdict ?? null,
      note: hit?.note ?? "",
    };
  });
  return { edges };
}

function parsePercent(value) {
  const match = String(value ?? "").match(/(\d+(?:\.\d+)?)\s*%?/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : null;
}

function parseSelfAssessmentBlock(section) {
  const block = extractSection(section, "月度自评", 3);
  if (!block) return null;
  const needsSection = extractSection(block, "三需要", 4) || block;
  const needs = [];
  for (const row of dataRows(needsSection)) {
    const need = cleanInline(row[0] ?? "");
    if (!need || need === "需要") continue;
    needs.push({
      need,
      met: cleanInline(row[1] ?? "") || "—",
      thwarted: cleanInline(row[2] ?? "") || "—",
    });
  }
  const motiveSection = extractSection(block, "动机质量", 4);
  const motives = [];
  if (motiveSection) {
    for (const row of dataRows(motiveSection)) {
      const line = cleanInline(row[0] ?? "");
      if (!line || line === "线") continue;
      motives.push({ line, quality: cleanInline(row[1] ?? "") || "—" });
    }
  }
  let reviewStatus = "confirmed";
  if (/INFANS_MONTHLY_REVIEW:pending/.test(block) || /AI 草稿\s*[·.•]\s*待本人改/.test(block)) {
    reviewStatus = "pending";
  } else if (/INFANS_MONTHLY_REVIEW:dismissed/.test(block) || /已关闭未确认/.test(block)) {
    reviewStatus = "dismissed";
  } else if (/INFANS_MONTHLY_REVIEW:confirmed/.test(block) || /本人已确认/.test(block)) {
    reviewStatus = "confirmed";
  }
  const rawMatch = String(section).match(/###\s*月度自评\n[\s\S]*?(?=\n###\s|\n##\s|<!--\s*INFANS_MONTH_TAIL:|$)/);
  const rawSection = rawMatch ? `${rawMatch[0].trimEnd()}\n` : `### 月度自评\n\n${block}\n`;
  return { needs, motives, reviewStatus, rawSection };
}

export function parseOdysseyPlan(markdown = "") {
  const text = String(markdown || "");
  if (!text.trim()) return null;
  const plans = [];
  const planRe = /^##\s+方案\s*([ABC])\s*[·・.]\s*(.+)$/gm;
  const heads = [...text.matchAll(planRe)];
  for (let i = 0; i < heads.length; i += 1) {
    const id = heads[i][1];
    const title = cleanInline(heads[i][2] ?? `方案 ${id}`);
    const start = heads[i].index + heads[i][0].length;
    const end = heads[i + 1]?.index ?? text.length;
    const body = text.slice(start, end);
    const blurb = cleanInline(body.match(/>\s*一句话[：:]\s*([^\n]+)/)?.[1] ?? "");
    const scores = [];
    for (const row of dataRows(body)) {
      const dim = cleanInline(row[0] ?? "");
      if (!dim || dim === "维度") continue;
      const raw = cleanInline(row[1] ?? "");
      const score = raw === "—" || raw === "" || raw === "待填" ? null : Number(raw);
      scores.push({
        dim,
        score: Number.isFinite(score) ? score : null,
        note: cleanInline(row[2] ?? ""),
      });
    }
    plans.push({ id, title, blurb, scores });
  }
  return plans.length ? { plans } : null;
}

function sectionHasTempTest(section = "") {
  return /临时测试/.test(String(section || ""));
}

function parseOptionalNumber(raw = "") {
  const value = cleanInline(raw);
  if (!value || value === "—" || value === "待填") return null;
  const num = Number(value.replace(/%$/, ""));
  return Number.isFinite(num) ? num : null;
}

/** 衡 · 工具箱：好时光 / 原型 / 选择四步 / 卡住时 */
export function parseLifeToolbox(markdown = "") {
  const section = extractSection(markdown, "工具箱", 2);
  if (!section) return null;
  const tempTest = sectionHasTempTest(section);

  const goodTimes = [];
  const goodSection = extractSection(section, "好时光（按线）", 3) || extractSection(section, "好时光", 3);
  if (goodSection) {
    for (const row of dataRows(goodSection)) {
      const line = cleanInline(row[0] ?? "");
      if (!line || line === "线") continue;
      const leanRaw = cleanInline(row[1] ?? "");
      const lean = leanRaw === "回能" || leanRaw === "耗能" || leanRaw === "中性" ? leanRaw : null;
      const dates = cleanInline(row[2] ?? "")
        .split(/[,，、\s]+/)
        .map((item) => item.trim())
        .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
      goodTimes.push({
        line,
        lean,
        dates,
        note: cleanInline(row[3] ?? ""),
      });
    }
  }

  const prototypes = [];
  const protoSection = extractSection(section, "原型", 3);
  if (protoSection) {
    for (const row of dataRows(protoSection)) {
      const name = cleanInline(row[0] ?? "");
      if (!name || name === "名称") continue;
      prototypes.push({
        name,
        kind: cleanInline(row[1] ?? ""),
        status: cleanInline(row[2] ?? ""),
        blurb: cleanInline(row[3] ?? ""),
      });
    }
  }

  let choiceSteps = null;
  const choiceSection = extractSection(section, "选择四步", 3, { prefix: true });
  if (choiceSection) {
    const pick = (label) => cleanInline(choiceSection.match(new RegExp(`\\*\\*${label}\\*\\*[：:]\\s*([^\\n]+)`))?.[1] ?? "");
    choiceSteps = {
      topic: pick("大事"),
      generate: pick("生成"),
      narrow: pick("收窄"),
      choose: pick("选定"),
      letGo: pick("放手"),
    };
    if (!choiceSteps.topic && !choiceSteps.generate && !choiceSteps.narrow && !choiceSteps.choose && !choiceSteps.letGo) {
      choiceSteps = null;
    }
  }

  const stuckSection = extractSection(section, "卡住时看什么", 3) || extractSection(section, "免疫于失败", 3);
  const stuckNote = stuckSection
    ? cleanInline(stuckSection.split("\n").find((line) => line.trim() && !line.trim().startsWith(">") && !line.trim().startsWith("|")) || "")
    : "";

  if (!goodTimes.length && !prototypes.length && !choiceSteps && !stuckNote) return null;
  return { tempTest, goodTimes, prototypes, choiceSteps, stuckNote };
}

/** 量表小节里的 `#### 解读` 正文（去掉引用标记行，保留段落） */
function extractScaleReport(body = "") {
  const match = body.match(/^####\s+解读\s*$/m);
  if (!match || match.index == null) return "";
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const end = rest.search(/^#{1,4}\s+/m);
  const raw = end < 0 ? rest : rest.slice(0, end);
  return raw
    .split(/\n/)
    .map((line) => line.replace(/^>\s?/, "").trimEnd())
    .join("\n")
    .replace(/^\s*\n+/, "")
    .replace(/\n+\s*$/, "")
    .trim();
}

/** 心 · 量表仪表：BPNSFS / REQ / AAQ / CBI（写在校准文件，挂到 mind） */
export function parseMindScales(markdown = "") {
  const section = extractSection(markdown, "量表仪表", 2);
  if (!section) return null;
  const tempTest = sectionHasTempTest(section);

  let bpnsfs = null;
  const bpnsfsHeads = [...section.matchAll(/^###\s+BPNSFS\s*[·・.]\s*(.+)$/gm)];
  if (bpnsfsHeads[0]) {
    const period = cleanInline(bpnsfsHeads[0][1] ?? "");
    const start = bpnsfsHeads[0].index + bpnsfsHeads[0][0].length;
    const end = section.slice(start).search(/^###\s+/m);
    const body = section.slice(start, end < 0 ? undefined : start + end);
    const rows = [];
    for (const row of dataRows(body)) {
      const need = cleanInline(row[0] ?? "");
      if (!need || need === "需要") continue;
      rows.push({
        need,
        met: parseOptionalNumber(row[1]),
        thwarted: parseOptionalNumber(row[2]),
        note: cleanInline(row[3] ?? ""),
      });
    }
    if (rows.length) bpnsfs = { period, rows, report: extractScaleReport(body) };
  }

  let req = null;
  const reqHeads = [...section.matchAll(/^###\s+REQ\s*[·・.]\s*(.+)$/gm)];
  if (reqHeads[0]) {
    const period = cleanInline(reqHeads[0][1] ?? "");
    const start = reqHeads[0].index + reqHeads[0][0].length;
    const end = section.slice(start).search(/^###\s+/m);
    const body = section.slice(start, end < 0 ? undefined : start + end);
    const rows = [];
    for (const row of dataRows(body)) {
      const dim = cleanInline(row[0] ?? "");
      if (!dim || dim === "维度") continue;
      rows.push({
        dim,
        score: parseOptionalNumber(row[1]),
        note: cleanInline(row[2] ?? ""),
      });
    }
    if (rows.length) req = { period, rows, report: extractScaleReport(body) };
  }

  let aaq = null;
  const aaqHeads = [...section.matchAll(/^###\s+(?:AAQ-II|CompACT)\s*[·・.]\s*(.+)$/gm)];
  if (aaqHeads[0]) {
    const period = cleanInline(aaqHeads[0][1] ?? "");
    const start = aaqHeads[0].index + aaqHeads[0][0].length;
    const end = section.slice(start).search(/^###\s+/m);
    const body = section.slice(start, end < 0 ? undefined : start + end);
    const lookup = Object.fromEntries(dataRows(body).map((row) => [cleanInline(row[0]), cleanInline(row[1])]));
    aaq = {
      period,
      score: parseOptionalNumber(lookup["总分（自参）"] ?? lookup["总分"] ?? ""),
      blurb: cleanInline(lookup["一句话"] ?? ""),
      report: extractScaleReport(body),
    };
  }

  let cbi = null;
  const cbiHeads = [...section.matchAll(/^###\s+CBI\s*[·・.]\s*(.+)$/gm)];
  if (cbiHeads[0]) {
    const period = cleanInline(cbiHeads[0][1] ?? "");
    const start = cbiHeads[0].index + cbiHeads[0][0].length;
    const end = section.slice(start).search(/^###\s+/m);
    const body = section.slice(start, end < 0 ? undefined : start + end);
    const rows = [];
    for (const row of dataRows(body)) {
      const face = cleanInline(row[0] ?? "");
      if (!face || face === "面" || face === "维度") continue;
      rows.push({
        face,
        score: parseOptionalNumber(row[1]),
        note: cleanInline(row[2] ?? ""),
      });
    }
    if (rows.length) cbi = { period, rows, report: extractScaleReport(body) };
  }

  if (!bpnsfs && !req && !aaq && !cbi) return null;
  return { tempTest, bpnsfs, req, aaq, cbi };
}

/** 正式近期心理／平衡层：日常定性判断 + 已停更的历史周度数字，不覆盖月度量表历史。 */
export function parseRecentWellbeing(markdown = "") {
  const weeklySection = extractSection(markdown, "历史周度心理数字", 2)
    || extractSection(markdown, "周度心理状态", 2);
  const weeklyMindSnapshots = weeklySection
    ? dataRows(weeklySection).flatMap((row) => {
        const weekEnding = cleanInline(row[0] ?? "");
        if (!/^20\d{2}-\d{2}-\d{2}$/.test(weekEnding)) return [];
        const score = (value) => {
          const parsed = parseOptionalNumber(value);
          return parsed == null ? null : Math.max(0, Math.min(10, Math.round(parsed)));
        };
        const confidence = cleanInline(row[7] ?? "") || "未知";
        const basis = cleanInline(row[8] ?? "");
        const need = (name, metIndex, thwartedIndex) => ({
          need: name,
          met: score(row[metIndex]),
          thwarted: score(row[thwartedIndex]),
          note: [confidence ? `可信度：${confidence}` : "", basis].filter(Boolean).join(" · "),
        });
        return [{
          weekEnding,
          confidence,
          basis,
          needs: [need("自主", 1, 2), need("胜任", 3, 4), need("联结", 5, 6)],
        }];
      }).sort((a, b) => b.weekEnding.localeCompare(a.weekEnding))
    : [];

  const subjectiveSection = extractSection(markdown, "当前主观睡眠", 2) || "";
  const subjectiveRating = cleanInline(subjectiveSection.match(/^- 体感[：:]\s*(差|一般|好)\s*$/m)?.[1] ?? "");
  const subjectiveSleep = /^(?:差|一般|好)$/.test(subjectiveRating)
    ? {
        rating: subjectiveRating,
        observedAt: cleanInline(subjectiveSection.match(/^- 记录日[：:]\s*(.+)$/m)?.[1] ?? ""),
        source: cleanInline(subjectiveSection.match(/^- 来源[：:]\s*(.+)$/m)?.[1] ?? ""),
      }
    : null;

  const section = extractSection(markdown, "近期记录", 2);
  const heads = section ? [...section.matchAll(/^###\s+(20\d{2}-\d{2}-\d{2})\s*$/gm)] : [];
  const entries = [];
  for (let index = 0; index < heads.length; index += 1) {
    const date = heads[index][1];
    const start = heads[index].index + heads[index][0].length;
    const end = heads[index + 1]?.index ?? section.length;
    const body = section.slice(start, end);
    const pickMeta = (label) => cleanInline(body.match(new RegExp(`^- ${label}[：:]\\s*(.+)$`, "m"))?.[1] ?? "");
    const parseRows = (title) => {
      const block = extractSection(body, title, 4);
      if (!block) return [];
      return dataRows(block).flatMap((row) => {
        const first = cleanInline(row[0] ?? "");
        if (!first || first === "维度" || first === "判断" || first === "类型") return [];
        const hasDimension = title === "心理状态" || title === "好时光";
        return [{
          dimension: hasDimension ? first : title,
          judgment: cleanInline(row[hasDimension ? 1 : 0] ?? "") || "暂不判断",
          confidence: cleanInline(row[hasDimension ? 2 : 1] ?? "") || "低",
          evidence: cleanInline(row[hasDimension ? 3 : 2] ?? ""),
          unknown: cleanInline(row[hasDimension ? 4 : 3] ?? ""),
        }];
      });
    };
    entries.push({
      date,
      sourceDate: pickMeta("来源日") || date,
      closedBy: pickMeta("收口"),
      sources: pickMeta("来源"),
      correction: pickMeta("用户纠偏") || "无",
      mind: parseRows("心理状态"),
      balance: parseRows("人生平衡")[0] ?? null,
      goodTimes: parseRows("好时光"),
    });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return {
    entries,
    latestDate: entries[0]?.date ?? null,
    weeklyMindSnapshots,
    subjectiveSleep,
  };
}

function reportDate(value) {
  if (!value) return "";
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  return cleanInline(String(value));
}

function reportLine(section, label) {
  return cleanInline(String(section || "").match(new RegExp(`^-\\s*(?:\\*\\*)?${label}(?:\\*\\*)?[：:]\\s*(.+)$`, "m"))?.[1] ?? "");
}

function reportParagraph(section) {
  return String(section || "")
    .split(/\r?\n/)
    .map((line) => cleanInline(line))
    .find((line) => line && !/^[-|>#]/.test(line)) || "";
}

function reportNumber(value, max = 100) {
  const token = String(value ?? "").trim();
  if (!token || /^(?:未知|暂不判断|—|-)$/.test(token)) return null;
  const parsed = Number(token.match(/-?\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(max, parsed));
}

function reportList(section) {
  return String(section || "")
    .split(/\r?\n/)
    .map((line) => cleanInline(line.match(/^\s*[-*]\s+(.+)$/)?.[1] ?? ""))
    .filter((line) => line && !/^(?:无|未知|暂不判断|—|-)$/.test(line));
}

/**
 * 解析面向 Capoo 的日／周／月状态报告。新报告共用固定章节；当前日评在兼容期
 * 仍可读取旧顶栏，不把「解决过难事」继续算进恢复。
 */
export function parseHealthStatusReport(markdown = "", fallbackKind = "daily") {
  const raw = String(markdown || "").trim();
  if (!raw) return null;
  const parsed = matter(raw);
  const content = parsed.content || raw;
  const requestedKind = cleanInline(String(parsed.data?.report_kind ?? fallbackKind));
  const kind = ["daily", "weekly", "monthly"].includes(requestedKind) ? requestedKind : fallbackKind;
  const declaredStatus = cleanInline(String(parsed.data?.status ?? ""));
  if (["awaiting_first_run", "draft", "disabled"].includes(declaredStatus)) return null;

  const periodStart = reportDate(parsed.data?.period_start)
    || reportDate(parsed.data?.date)
    || reportLine(content, "评估日");
  const periodEnd = reportDate(parsed.data?.period_end) || periodStart;
  const generatedAt = reportDate(parsed.data?.generated_at) || reportDate(parsed.data?.date) || periodEnd;
  const title = cleanInline(content.match(/^#\s+(.+)$/m)?.[1] ?? "")
    || ({ daily: "每日状态", weekly: "每周身心报告", monthly: "每月身心报告" })[kind];
  const summary = reportParagraph(extractSection(content, "一句话状态", 2))
    || reportLine(content, "一句话");

  const workloadSection = extractSection(content, "工作负荷", 2);
  const legacyWorkload = content.match(/^- 工作强度[：:]\s*(10|[0-9])\s*\/\s*10(?:（([^）]+)）)?/m);
  const score = reportNumber(reportLine(workloadSection, "分数"), 10)
    ?? (legacyWorkload ? Number(legacyWorkload[1]) : null);
  const average7d = reportNumber(reportLine(workloadSection, "近7日均值"), 10);
  const comparison28d = reportLine(workloadSection, "对比近28日") || reportLine(workloadSection, "与近28日常态");
  const workloadNote = reportLine(workloadSection, "说明") || cleanInline(legacyWorkload?.[2] ?? "");
  const workload = score != null || average7d != null || comparison28d || workloadNote
    ? { score, average7d, comparison28d, note: workloadNote }
    : null;

  const achievementSection = extractSection(content, "主要成果", 2);
  const achievements = dataRows(achievementSection).flatMap((row) => {
    const text = cleanInline(row[0] ?? "");
    if (!text || text === "成果") return [];
    return [{ text, status: cleanInline(row[1] ?? ""), evidence: cleanInline(row[2] ?? "") }];
  });

  const interruptionSection = extractSection(content, "节奏与打断", 2);
  const interruptionJudgment = reportLine(interruptionSection, "判断");
  const interruptionEvidence = reportLine(interruptionSection, "依据");
  const interruptions = interruptionJudgment || interruptionEvidence
    ? { judgment: interruptionJudgment || "暂不判断", evidence: interruptionEvidence }
    : null;

  const recoverySection = extractSection(content, "恢复观察", 2);
  const recovery = dataRows(recoverySection).flatMap((row) => {
    const dimension = cleanInline(row[0] ?? "");
    if (!dimension || dimension === "维度") return [];
    return [{
      dimension,
      judgment: cleanInline(row[1] ?? "") || "暂不判断",
      score: reportNumber(row[2]),
      evidence: cleanInline(row[3] ?? ""),
    }];
  });

  const legacyRecovery = parseDiaryRecoveryLine(content);
  if (!recovery.length && legacyRecovery) {
    const legacyRow = (dimension, value, evidence) => ({
      dimension,
      judgment: value == null ? "暂不判断" : value >= 100 ? "明确做到" : value <= 0 ? "明确没有做到" : "部分做到",
      score: value,
      evidence,
    });
    recovery.push(
      legacyRow("收工后能放下", legacyRecovery.detachmentFail, "旧日评兼容读取"),
      legacyRow("日程自主（旧口径）", legacyRecovery.controlLoss, "旧日评兼容读取；后续改读休息时间是否由自己支配"),
      legacyRow("有过真放松", legacyRecovery.relaxation, "旧日评兼容读取"),
    );
    if (legacyRecovery.mastery != null) {
      achievements.push({
        text: "有解决过难事",
        status: legacyRecovery.mastery >= 100 ? "明确发生" : legacyRecovery.mastery <= 0 ? "未发生" : "部分发生",
        evidence: "从旧恢复行迁出；不再计入恢复",
      });
    }
  }

  const allocationSection = extractSection(content, "时间精力投入", 2);
  const allocation = dataRows(allocationSection).flatMap((row) => {
    const area = cleanInline(row[0] ?? "");
    if (!area || area === "领域") return [];
    return [{ area, value: reportNumber(row[1]), change: cleanInline(row[2] ?? ""), evidence: cleanInline(row[3] ?? "") }];
  });

  const goodTimeSection = extractSection(content, "好时光与回能", 2);
  const goodTimes = dataRows(goodTimeSection).flatMap((row) => {
    const text = cleanInline(row[0] ?? "");
    if (!text || text === "内容") return [];
    return [{ text, effect: cleanInline(row[1] ?? ""), evidence: cleanInline(row[2] ?? "") }];
  });

  const subjectiveSection = extractSection(content, "本人感受", 2);
  const subjectiveSummary = reportLine(subjectiveSection, "摘要") || reportParagraph(subjectiveSection);
  const subjectiveSource = reportLine(subjectiveSection, "来源");
  const subjective = subjectiveSummary || subjectiveSource
    ? { summary: subjectiveSummary || "暂不判断", source: subjectiveSource }
    : null;

  const notableChange = reportParagraph(extractSection(content, "最值得注意", 2))
    || reportLine(content, "可执行提醒");
  const experimentRaw = reportParagraph(extractSection(content, "下一步只试一件事", 2));
  const oneExperiment = /^(?:无|—|-)$/.test(experimentRaw) ? "" : experimentRaw;
  const confidenceSection = extractSection(content, "可信度与未知", 2);
  const confidence = reportLine(confidenceSection, "可信度") || "未知";
  const unknownLine = reportLine(confidenceSection, "未知");
  const unknowns = [
    ...unknownLine.split(/[；;]/).map((item) => cleanInline(item)).filter(Boolean),
    ...reportList(confidenceSection).filter((item) => !/^(?:可信度|未知)[：:]/.test(item)),
  ].filter((item, index, list) => list.indexOf(item) === index);
  const sources = reportList(extractSection(content, "来源", 2));
  const legacySources = cleanInline(content.match(/^依据[：:]\s*(.+)$/m)?.[1] ?? "");
  if (!sources.length && legacySources) sources.push(...legacySources.split(/\s*[·•]\s*/).filter(Boolean));

  if (!summary && !workload && !achievements.length && !recovery.length && !allocation.length) return null;
  return {
    kind,
    status: declaredStatus === "partial" ? "partial" : "ready",
    periodStart,
    periodEnd,
    generatedAt,
    title,
    summary,
    workload,
    achievements,
    interruptions,
    recovery,
    allocation,
    goodTimes,
    subjective,
    notableChange,
    oneExperiment,
    confidence,
    unknowns,
    sources,
  };
}

export function parseHealthReports({ daily = "", weekly = "", monthly = "" } = {}) {
  return {
    daily: parseHealthStatusReport(daily, "daily"),
    weekly: parseHealthStatusReport(weekly, "weekly"),
    monthly: parseHealthStatusReport(monthly, "monthly"),
  };
}

/** 日志词表太稀时的演示恢复四维（须标临时测试） */
export function parseMindDemoSignals(markdown = "") {
  const section = extractSection(markdown, "心·演示信号", 2) || extractSection(markdown, "心演示信号", 2);
  if (!section) return null;
  const tempTest = sectionHasTempTest(section);
  if (!tempTest) return null;
  const recovery = {
    detachmentFail: 0,
    relaxation: 0,
    mastery: 0,
    controlLoss: 0,
  };
  const labelMap = {
    下班停不下来: "detachmentFail",
    放松: "relaxation",
    有成就感: "mastery",
    时间不由自己: "controlLoss",
  };
  for (const row of dataRows(section)) {
    const label = cleanInline(row[0] ?? "");
    const key = labelMap[label];
    if (!key) continue;
    const count = parseOptionalNumber(row[1]);
    if (count != null) recovery[key] = Math.max(0, Math.round(count));
  }
  return { tempTest, recovery };
}

export function parseInterventionCardLibrary(markdown = "") {
  const text = String(markdown || "");
  const cards = [];
  const heads = [...text.matchAll(/^##\s+([a-z0-9-]+)\s*[·・.]\s*(.+)$/gm)];
  for (let i = 0; i < heads.length; i += 1) {
    const id = heads[i][1];
    const title = cleanInline(heads[i][2] ?? id);
    const start = heads[i].index + heads[i][0].length;
    const end = heads[i + 1]?.index ?? text.length;
    const body = text.slice(start, end);
    const process = cleanInline(body.match(/\*\*过程\*\*[：:]\s*([^\n]+)/)?.[1] ?? "");
    const trigger = cleanInline(body.match(/\*\*触发信号\*\*[：:]\s*`?([a-zA-Z]+)`?/)?.[1] ?? "");
    const basis = cleanInline(body.match(/\*\*依据\*\*[：:]\s*([^\n]+)/)?.[1] ?? "");
    const steps = [];
    const stepsBlock = body.match(/\*\*做法\*\*[：:]([\s\S]*?)(?=\n-\s*\*\*|$)/)?.[1] ?? "";
    for (const line of stepsBlock.split("\n")) {
      const m = line.match(/^\s*\d+\.\s+(.+)/);
      if (m) steps.push(cleanInline(m[1]));
    }
    if (id && title) cards.push({ id, title, process, trigger, steps, basis });
  }
  return cards;
}

/** 按传感命中推荐干预卡；无采样或无命中 → 空数组。 */
export function recommendInterventionCards(cards = [], mindSignals = null) {
  const sampleDays = mindSignals?.sampleDays ?? 0;
  if (!sampleDays || !cards.length) return [];
  const recovery = mindSignals?.recovery || {};
  const motivation = mindSignals?.motivation || {};
  const hits = {
    detachmentFail: recovery.detachmentFail || 0,
    relaxation: recovery.relaxation || 0,
    mastery: recovery.mastery || 0,
    controlLoss: recovery.controlLoss || 0,
    competenceThwarted: motivation.competenceThwarted || 0,
    relatednessThwarted: motivation.relatednessThwarted || 0,
    ruminationAvoidance: motivation.ruminationAvoidance || 0,
  };
  const picked = [];
  for (const card of cards) {
    const key = card.trigger;
    if (!key) continue;
    const count = hits[key] ?? 0;
    const should = key === "relaxation" ? count === 0 && (hits.detachmentFail > 0 || sampleDays >= 3) : count > 0;
    if (!should) continue;
    picked.push({
      ...card,
      basis: `${card.basis} · 参考记录 ${count} 条`,
    });
  }
  return picked.slice(0, 4);
}

/** 处置四档：界面用「多投入/保持/少投入/停」；旧稿「加注/维持/减注」仍认，读入后统一成新人话。 */
function normalizeDisposition(raw = "") {
  const value = cleanInline(raw);
  if (value === "多投入" || value === "加注") return "多投入";
  if (value === "保持" || value === "维持") return "保持";
  if (value === "少投入" || value === "减注") return "少投入";
  if (value === "停") return "停";
  return null;
}

function compactLineName(name = "") {
  return String(name).replace(/[「」『』《》""]/g, "").trim();
}

function namesAlias(left = "", right = "") {
  const a = compactLineName(left);
  const b = compactLineName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes("公众号") && b.includes("公众号");
}

function matchAnnotationKey(store, item) {
  if (!store || !item) return null;
  if (typeof store.has === "function" && store.has(item)) return item;
  const keys = typeof store.keys === "function" ? store.keys() : store;
  for (const key of keys) {
    if (namesAlias(key, item)) return key;
  }
  return null;
}

export function parseLifeDesignLog(markdown = "", todoMainlines = [], today = tokyoWeekday().key) {
  const text = String(markdown || "");
  const lifecycleStatus = /\*\*四格长期状态\*\*[：:]\s*正式/u.test(text) ? "formal" : "trial";
  const formalFromRaw = cleanInline(text.match(/\*\*正式起点\*\*[：:]\s*([^\n]+)/u)?.[1] ?? "");
  const gaugeLifecycle = {
    status: lifecycleStatus,
    formalFrom: /^\d{4}-\d{2}-\d{2}$/.test(formalFromRaw) ? formalFromRaw : null,
  };
  const monthHeads = [...text.matchAll(/^##\s+(\d{4}-\d{2})\s*$/gm)];
  const gauges = [];
  const weeklyGauges = [];
  const annotations = new Map();
  const selfAssessments = [];

  for (let index = 0; index < monthHeads.length; index += 1) {
    const month = monthHeads[index][1];
    const start = monthHeads[index].index + monthHeads[index][0].length;
    const end = monthHeads[index + 1]?.index ?? text.length;
    const section = text.slice(start, end);
    const gaugeSection = extractSection(section, "四格", 3) || section;
    const rows = dataRows(gaugeSection);
    const lookup = Object.fromEntries(rows.map((row) => [cleanInline(row[0]), cleanInline(row[1])]));
    const surprise = cleanInline(section.match(/\*\*最意外\*\*[：:]\s*([^\n]+)/)?.[1] ?? "");
    const refuel = cleanInline(
      section.match(/\*\*(?:优先提升|先加哪格)\*\*[：:]\s*([^\n]+)/)?.[1] ?? "",
    );
    gauges.push({
      month,
      health: parsePercent(lookup["健康"]),
      work: parsePercent(lookup["工作"]),
      play: parsePercent(lookup["游戏"]),
      love: parsePercent(lookup["情感"] ?? lookup["爱"]),
      surprise,
      refuel,
    });

    const weeklySection = extractSection(section, "周快照", 3);
    for (const row of dataRows(weeklySection)) {
      const weekEnding = cleanInline(row[0] ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnding)) continue;
      weeklyGauges.push({
        weekEnding,
        health: parsePercent(row[1]),
        work: parsePercent(row[2]),
        play: parsePercent(row[3]),
        love: parsePercent(row[4]),
        status: cleanInline(row[5]) === "正式" ? "formal" : "trial",
        confidence: cleanInline(row[6]),
        basis: cleanInline(row[7]),
      });
    }

    const assessed = parseSelfAssessmentBlock(section);
    if (assessed) selfAssessments.push({ month, ...assessed });

    const lineSection = extractSection(section, "在推进的事项", 3) || extractSection(section, "在跑的线", 3);
    if (lineSection) {
      for (const row of dataRows(lineSection)) {
        const item = cleanInline(row[0] ?? "");
        if (!item || item === "线") continue;
        const energyRaw = cleanInline(row[1] ?? "");
        const dispositionRaw = cleanInline(row[2] ?? "");
        const energy = ["回能", "中性", "耗能"].includes(energyRaw) ? energyRaw : null;
        const disposition = normalizeDisposition(dispositionRaw);
        annotations.set(item, {
          energy,
          disposition,
          reason: cleanInline(row[3] ?? ""),
        });
      }
    }
  }

  gauges.sort((a, b) => b.month.localeCompare(a.month));
  weeklyGauges.sort((a, b) => b.weekEnding.localeCompare(a.weekEnding));
  selfAssessments.sort((a, b) => b.month.localeCompare(a.month));
  const pendingAssessment = selfAssessments.find((item) => item.reviewStatus === "pending");
  const monthlySelfAssessment = (pendingAssessment || selfAssessments[0])
    ? {
        month: (pendingAssessment || selfAssessments[0]).month,
        needs: (pendingAssessment || selfAssessments[0]).needs,
        motives: (pendingAssessment || selfAssessments[0]).motives,
        reviewStatus: (pendingAssessment || selfAssessments[0]).reviewStatus || "confirmed",
        rawSection: (pendingAssessment || selfAssessments[0]).rawSection || "",
      }
    : null;

  const mainlineNames = new Set((todoMainlines || []).map((row) => row.item));
  const usedAnnotationKeys = new Set();
  const mainlines = (todoMainlines || []).map((row) => {
    const hitKey = matchAnnotationKey(annotations, row.item);
    if (hitKey) usedAnnotationKeys.add(hitKey);
    const hit = (hitKey && annotations.get(hitKey)) || {};
    return {
      item: row.item,
      prefix: row.prefix || "",
      category: row.category || "",
      energy: hit.energy ?? null,
      disposition: hit.disposition ?? null,
      reason: hit.reason ?? "",
      lastActionDays: null,
      offMainline: false,
    };
  });

  for (const [item, hit] of annotations) {
    if (usedAnnotationKeys.has(item) || matchAnnotationKey(mainlineNames, item)) continue;
    mainlines.push({
      item,
      prefix: "",
      category: "",
      energy: hit.energy ?? null,
      disposition: hit.disposition ?? null,
      reason: hit.reason ?? "",
      lastActionDays: null,
      offMainline: true,
    });
  }

  let overdueWeeks = null;
  if (gauges[0]?.month) {
    const [y, m] = gauges[0].month.split("-").map(Number);
    const calibrated = Date.parse(`${y}-${String(m).padStart(2, "0")}-01T00:00:00+09:00`);
    const now = Date.parse(`${today}T00:00:00+09:00`);
    overdueWeeks = Math.max(0, Math.floor((now - calibrated) / (7 * 86_400_000)));
  }

  return {
    mainlines,
    gauges: gauges.slice(0, 8),
    weeklyGauges: weeklyGauges.slice(0, 12),
    gaugeLifecycle,
    monthlySelfAssessment,
    coherence: parseCompassCoherence(text),
    toolbox: parseLifeToolbox(text),
    overdueWeeks,
  };
}

async function buildHealthFromSources(root, source) {
  const health = parseHealth(source.body.text, source.training.text);
  const todayPlan = parseTodayTrainingPlan(source.trainingPlan.text);
  const weekPlan = parseWeekTrainingPlan(source.trainingPlan.text);
  const today = tokyoWeekday().key;
  const staleMuscles = staleMusclesFromSessions(health.sessions, today);
  const appleHealth = await readAppleHealthData(root);
  const coachHints = buildCoachHints({
    sessions: health.sessions,
    staleMuscles,
    todayPlan,
    appleHealth,
    today,
  });
  const diaries = await readRecentDiaries(root, 14, today);
  const calendarFrom = new Date(`${diaries[0]?.date || today}T00:00:00+09:00`);
  const calendarTo = new Date(`${today}T00:00:00+09:00`);
  calendarTo.setDate(calendarTo.getDate() + 1);
  // 日历只是休息日旁证，冷启动无缓存或 Calendar 卡住时不能阻塞整页健康数据。
  const calendar = await readAppleCalendar(calendarFrom, calendarTo, { maxWaitMs: 1000 });
  const mindWork = parseDiaryWorkIntensity(diaries, health.sessions, today, calendar);
  const mindSignals = parseMindSignals(diaries);
  const recoveryPercents = deriveRecoveryPercents(diaries);
  const lifeDesignText = source.lifeDesignLog?.text || "";
  const recentWellbeing = parseRecentWellbeing(source.recentWellbeingLog?.text || "");
  const reports = parseHealthReports({
    daily: source.wellbeingDailyReport?.text || "",
    weekly: source.wellbeingWeeklyReport?.text || "",
    monthly: source.wellbeingMonthlyReport?.text || "",
  });
  const mindScales = parseMindScales(lifeDesignText);
  const mindDemo = parseMindDemoSignals(lifeDesignText);
  const mind = {
    ...mindWork,
    signals: mindDemo
      ? {
          ...mindSignals,
          recovery: mindDemo.recovery,
          sampleDays: Math.max(mindSignals.sampleDays || 0, 1),
          hitDays: Math.max(mindSignals.hitDays || 0, 1),
          recoveryPercents,
        }
      : {
          ...mindSignals,
          recoveryPercents,
        },
    recoveryTempTest: Boolean(mindDemo?.tempTest),
    scales: mindScales,
    recentAssessment: recentWellbeing,
  };
  const trainingVolume = deriveTrainingVolume(health.sessions);
  const strengthBaseline = deriveStrengthBaselineTable(health.sessions);
  const progressionAdvice = deriveProgressionAdvice(health.sessions);
  const muscleBalance = deriveMuscleBalance(health.sessions);
  const intensity = deriveSessionIntensity(health.sessions);
  const recoveryLoad = deriveRecoveryLoad({
    sessions: health.sessions,
    mindSignals,
    mindDays: mindWork.days,
    today,
  });
  const mesocycle = deriveMesocyclePosition({
    stageStart: parseStageStartDate(source.trainingPlan?.text || ""),
    today,
  });
  const todo = parseTodo(source.todo?.text || "");
  const compass = parseCompassDocs(source.workview?.text || "", source.lifeview?.text || "");
  const lifeParsed = parseLifeDesignLog(lifeDesignText, todo.mainlines, today);
  const mainlines = aggregateLineEnergyCandidates(lifeParsed.mainlines, mindSignals, diaries);
  const cardLibrary = parseInterventionCardLibrary(source.interventionCards?.text || "");
  const interventionCards = recommendInterventionCards(cardLibrary, mindSignals);
  const odyssey = parseOdysseyPlan(source.odysseyPlan?.text || "");
  return {
    ...health,
    todayPlan,
    weekPlan,
    staleMuscles,
    coachHints,
    appleHealth,
    trainingVolume,
    strengthBaseline,
    progressionAdvice,
    muscleBalance,
    intensity,
    recoveryLoad,
    mesocycle,
    mind,
    reports,
    interventionCards,
    life: {
      compass,
      mainlines,
      gauges: lifeParsed.gauges,
      weeklyGauges: lifeParsed.weeklyGauges,
      gaugeLifecycle: lifeParsed.gaugeLifecycle,
      monthlySelfAssessment: lifeParsed.monthlySelfAssessment,
      coherence: lifeParsed.coherence,
      toolbox: lifeParsed.toolbox,
      recentAssessment: recentWellbeing,
      odyssey,
      overdueWeeks: lifeParsed.overdueWeeks,
    },
    sources: [
      sourceMeta(source.healthOverview),
      sourceMeta(source.body),
      sourceMeta(source.training),
      sourceMeta(source.trainingPlan),
      sourceMeta(source.appleHealth),
      sourceMeta(source.todo),
      sourceMeta(source.workview),
      sourceMeta(source.lifeview),
      sourceMeta(source.lifeDesignLog),
      sourceMeta(source.recentWellbeingLog),
      sourceMeta(source.wellbeingDailyReport),
      sourceMeta(source.wellbeingWeeklyReport),
      sourceMeta(source.wellbeingMonthlyReport),
      sourceMeta(source.odysseyPlan),
      sourceMeta(source.interventionCards),
    ],
  };
}

async function buildJapaneseFromSources(root, source) {
  const japanese = parseJapanese(source.japaneseStatus.text, source.japaneseDaily.text);
  const grammar = ["N5", "N4", "N3", "N2"].map((level) => {
    const key = `grammar${level}`;
    return { ...parseGrammarChecklist(source[key].text, level), source: sourceMeta(source[key]) };
  });
  const { applyAnkiVocabProgress, readAnkiDayReviews, readAnkiVocabProgress, tokyoTodayKey } = await import("./workbench-anki.mjs");
  const ankiProgress = await readAnkiVocabProgress(root);
  const merged = applyAnkiVocabProgress(japanese, ankiProgress);
  const base = {
    ...merged,
    grammar,
    languageReactor: await readLanguageReactorData(root),
    sources: [sourceMeta(source.japaneseOverview), sourceMeta(source.japaneseStatus), sourceMeta(source.japaneseDaily), ...grammar.map((item) => item.source), sourceMeta(source.languageReactor)],
  };
  const { buildJapaneseExploration } = await import("./workbench-japanese-exam.mjs");
  const today = tokyoTodayKey();
  const { buildJapaneseTodayStudy, hasJapaneseStudyActivity, tokyoPreviousDateKey } = await import("./workbench-japanese-today.mjs");
  const previous = tokyoPreviousDateKey();
  const [exploration, todayAnkiActivity, previousAnkiActivity] = await Promise.all([
    buildJapaneseExploration(root, base),
    ankiProgress ? readAnkiDayReviews(today, root) : Promise.resolve(null),
    ankiProgress ? readAnkiDayReviews(previous, root) : Promise.resolve(null),
  ]);
  const todayStudy = buildJapaneseTodayStudy({
    date: today,
    oralSessions: exploration.courseProgress.oralSessions,
    ankiActivity: todayAnkiActivity,
    examSessions: exploration.studySessions,
  });
  const previousStudy = buildJapaneseTodayStudy({
    date: previous,
    oralSessions: exploration.courseProgress.oralSessions,
    ankiActivity: previousAnkiActivity,
    examSessions: exploration.studySessions,
  });
  return {
    ...base,
    exploration,
    studySummary: hasJapaneseStudyActivity(todayStudy) ? todayStudy : previousStudy,
  };
}

async function buildLibrarySection(root, source, warnings) {
  const library = await buildLibrary(root, source, warnings);
  const domainKnowledge = await readDomainKnowledgeNodes(root);
  warnings.push(...domainKnowledge.warnings);
  const courseSummary = Number(source.dedao.text.match(/共\s*\*\*(\d+)\*\*\s*门/)?.[1] ?? library.courses.filter((item) => item.status === "已毕业").length);
  const completedCourseRows = library.courses.filter((item) => item.status === "已毕业").length;
  const pendingCourseRows = library.courses.filter((item) => item.status === "日期待补").length;
  if (completedCourseRows !== courseSummary) {
    warnings.push({ source: SOURCES.dedao, message: `课程摘要标注 ${courseSummary} 门，明细表解析出 ${completedCourseRows} 门${pendingCourseRows ? ` + ${pendingCourseRows} 门日期待补` : ""}，建议校对源档案。` });
  }
  return {
    books: library.books.filter((item) => item.tags.includes("微信读书")).length,
    completedBooks: library.books.filter((item) => item.status === "已读完").length,
    courses: courseSummary,
    games: library.games.length,
    animation: library.animation.length,
    screen: library.screen.length,
    writing: { count: library.writing.length, updatedAt: source.writing.updatedAt },
    learning: { count: library.topics.length, updatedAt: source.learning.updatedAt },
    cultureArchive: library.cultureArchive,
    domainResearch: { game: parseGameResearchDomain(source, library.topics), knowledgeNodes: domainKnowledge.nodes },
    items: library.items.map(({ searchableBody: _omit, ...item }) => item),
    sources: [sourceMeta(source.library), sourceMeta(source.weread), sourceMeta(source.bookCovers), sourceMeta(source.dedao), sourceMeta(source.dedaoCovers), sourceMeta(source.writing), sourceMeta(source.learning), sourceMeta(source.steamGames), sourceMeta(source.extraGames), sourceMeta(source.appleGames), sourceMeta(source.cultureOverview), sourceMeta(source.cultureWow), sourceMeta(source.cultureSouls), sourceMeta(source.cultureZelda), sourceMeta(source.screenOverview), sourceMeta(source.screenFanren), sourceMeta(source.screenFma), sourceMeta(source.screenMadoka), sourceMeta(source.screenCodeGeass), sourceMeta(source.screenEagle), sourceMeta(source.screenCinemaParadiso), sourceMeta(source.gameResearch), sourceMeta(source.gameResearchQuestions)],
  };
}

async function scanVaultUncached(root) {
  const warnings = [];
  const source = await readNamedSources(root, Object.keys(SOURCES), warnings);
  const health = await buildHealthFromSources(root, source);
  const japanese = await buildJapaneseFromSources(root, source);
  const library = await buildLibrarySection(root, source, warnings);
  const projects = parseProjects(source.projects.text);
  return {
    version: WORKBENCH_VERSION,
    generatedAt: new Date().toISOString(),
    identity: { ...parseIdentity(source.identity.text), source: sourceMeta(source.identity) },
    todo: { ...parseTodo(source.todo.text), source: sourceMeta(source.todo) },
    projects: {
      items: projects,
      flagship: parseFlagship(source.flagship.text, warnings),
      coaching: parseCoaching(source.coaching.text, source.coachingLog.text, warnings),
      source: sourceMeta(source.projects),
      flagshipSource: sourceMeta(source.flagship),
      coachingSource: sourceMeta(source.coaching),
      coachUrl: "http://127.0.0.1:5174/",
      coachClientUrl: "https://infans-coach.github.io/life-coach-client/",
    },
    projectManagement: await readProjectManagement(root),
    paymentGuard: await readPaymentGuardSummary(root),
    health,
    japanese,
    library,
    market: await buildMarketSection(root, source.marketBrief),
    warnings,
  };
}

export async function scanVault(vaultRoot, options = {}) {
  const root = path.resolve(vaultRoot);
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && scanCache?.root === root && scanCache.value && (now - scanCache.at) < SCAN_CACHE_TTL_MS) {
    return scanCache.value;
  }
  if (!force && scanCache?.root === root && scanCache.promise) {
    return scanCache.promise;
  }
  const promise = scanVaultUncached(root).then((value) => {
    scanCache = { root, at: Date.now(), value, promise: null };
    return value;
  }).catch((error) => {
    if (scanCache?.root === root && scanCache.promise === promise) scanCache = scanCache.value ? { root, at: scanCache.at, value: scanCache.value, promise: null } : null;
    throw error;
  });
  scanCache = { root, at: now, value: scanCache?.root === root ? scanCache.value : null, promise };
  return promise;
}

function summarizeWorldNewsHomeLaneItems(events, limit = 3) {
  return (Array.isArray(events) ? events : []).slice(0, limit).map((event) => ({
    id: event.id,
    title: event.title,
    tags: event.category ? [event.category] : [],
  }));
}

function summarizeWorldNewsHomeLanes(snapshot) {
  const world = snapshot.market?.world || {};
  const financeEvents = Array.isArray(snapshot.market?.events) ? snapshot.market.events : [];
  const financeItems = [
    ...financeEvents.filter((event) => event.category === "AI热点").slice(0, 2).map((event) => ({
      id: event.id,
      title: event.title,
      tags: ["AI热点"],
    })),
    ...financeEvents.filter((event) => event.category !== "AI热点").slice(0, 3).map((event) => ({
      id: event.id,
      title: event.title,
      tags: Array.isArray(event.signalTags) && event.signalTags.length ? event.signalTags : [event.category],
    })),
  ];
  const fromBrief = (id, label, href, brief) => ({
    id,
    label,
    href,
    status: brief?.status || "quiet",
    headline: brief?.headline || "今天没有够格的新闻。",
    date: brief?.date ?? null,
    items: summarizeWorldNewsHomeLaneItems(brief?.events, id === "japan" ? 5 : 4),
  });
  return [
    fromBrief("japan", "日本", "/markets", world.japan),
    {
      id: "finance",
      label: "金融",
      href: "/markets?lane=finance",
      status: snapshot.market?.status || "quiet",
      headline: snapshot.market?.headline || "今天没有够格的新闻。",
      date: snapshot.market?.date ?? null,
      items: financeItems,
    },
    fromBrief("ai", "AI", "/markets?lane=ai", world.ai),
    fromBrief("games", "游戏", "/markets?lane=games", world.games),
  ];
}

export function summarizeWorkbench(snapshot) {
  const latestWriting = snapshot.library.items.find((item) => item.kind === "writing" && !item.archived) ?? null;
  const topics = snapshot.library.items
    .filter((item) => item.kind === "topic")
    .map((item) => ({ id: item.id, topicId: item.topicId, title: item.title, description: item.description, tip: item.tip || "", sourcePath: item.sourcePath }));
  return {
    version: snapshot.version,
    generatedAt: snapshot.generatedAt,
    identity: snapshot.identity,
    todo: snapshot.todo,
    projects: snapshot.projects,
    projectManagement: {
      ...snapshot.projectManagement,
      currentTodos: snapshot.projectManagement.currentTodos.map((task) => ({ ...task, details: [] })),
      relationIndex: { edges: [], issues: snapshot.projectManagement.relationIndex.issues },
      projects: snapshot.projectManagement.projects.map((project) => ({
        ...project,
        management: project.management ? {
          ...project.management,
          doing: project.management.doing.filter((task) => !task.done).slice(0, 3),
          next: project.management.next.filter((task) => !task.done).slice(0, 3),
          blockers: [],
          recentCompleted: [],
          authoritativeEntries: [],
        } : null,
        hasFeatureTree: Boolean(project.featureTree),
        featureTree: null,
        hasProjectHub: Boolean(project.hasProjectHub || project.projectHub),
        projectHub: null,
      })),
    },
    paymentGuard: snapshot.paymentGuard,
    health: {
      baselineDate: snapshot.health.baselineDate,
      weight: snapshot.health.weight,
      latestTraining: snapshot.health.latestTraining,
      todayPlan: snapshot.health.todayPlan,
      staleMuscles: snapshot.health.staleMuscles,
      life: { overdueWeeks: snapshot.health.life.overdueWeeks },
    },
    japanese: {
      updatedAt: snapshot.japanese.updatedAt,
      stage: snapshot.japanese.stage,
      progress: snapshot.japanese.progress,
      queue: snapshot.japanese.queue,
      streak: snapshot.japanese.streak,
      pace7: snapshot.japanese.pace7,
      pace14: snapshot.japanese.pace14,
      reviewPace7: snapshot.japanese.reviewPace7,
      newCardPace7: snapshot.japanese.newCardPace7,
      newCardPace14: snapshot.japanese.newCardPace14,
      ankiSource: snapshot.japanese.ankiSource,
      studySummary: snapshot.japanese.studySummary,
      dailySentence: pickDailySentence(snapshot.japanese.languageReactor),
    },
    library: {
      books: snapshot.library.books,
      completedBooks: snapshot.library.completedBooks,
      courses: snapshot.library.courses,
      games: snapshot.library.games,
      writing: snapshot.library.writing,
      learning: snapshot.library.learning,
      latestWriting,
      topics,
    },
    market: {
      status: snapshot.market.status,
      headline: snapshot.market.headline,
      eventsCount: snapshot.market.events.length,
      topEvents: snapshot.market.events
        .filter((event) => event.category !== "AI热点")
        .slice(0, 3)
        .map((event) => ({ id: event.id, title: event.title, category: event.category, signalTags: event.signalTags ?? [] })),
      aiHotspots: snapshot.market.events
        .filter((event) => event.category === "AI热点")
        .slice(0, 2)
        .map((event) => ({ id: event.id, title: event.title, category: event.category })),
      date: snapshot.market.date ?? null,
      worldLanes: summarizeWorldNewsHomeLanes(snapshot),
    },
    warnings: snapshot.warnings,
  };
}

export async function scanWorkbenchSummary(vaultRoot) {
  return summarizeWorkbench(await scanVault(vaultRoot));
}

export async function scanWorkbenchSection(vaultRoot, section) {
  if (!SECTION_SOURCE_KEYS[section]) throw new Error("未知工作台分区");
  const root = path.resolve(vaultRoot);
  const warnings = [];
  const source = await readNamedSources(root, SECTION_SOURCE_KEYS[section], warnings);
  const generatedAt = new Date().toISOString();
  let data;
  if (section === "health") {
    data = await buildHealthFromSources(root, source);
    const recentAssessment = data.mind?.recentAssessment || data.life?.recentAssessment || null;
    data = {
      ...data,
      appleHealth: trimAppleHealthForSection(data.appleHealth),
      mind: {
        ...data.mind,
        recentAssessment: recentAssessment ? {
          subjectiveSleep: recentAssessment.subjectiveSleep,
          entries: recentAssessment.entries,
        } : undefined,
      },
      life: {
        ...data.life,
        recentAssessment: recentAssessment ? { entries: recentAssessment.entries } : undefined,
      },
    };
  } else if (section === "languages") {
    data = trimLanguagesForSection(await buildJapaneseFromSources(root, source));
  } else if (section === "library") {
    data = await buildLibrarySection(root, source, warnings);
  } else {
    data = await buildMarketSection(root, source.marketBrief);
  }
  return {
    version: WORKBENCH_VERSION,
    generatedAt,
    data,
    warnings,
  };
}
