import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { formatFileCreatedAt } from "./workbench-wechat-bills.mjs";
import { tokyoDateKey, tokyoDay } from "../tokyo-time.mjs";
import { LANGUAGE_REACTOR_DERIVED, LANGUAGE_REACTOR_SOURCE } from "./vault-paths.mjs";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";

const TARGET_PATH = LANGUAGE_REACTOR_SOURCE;
const DERIVED_RELATIVE = LANGUAGE_REACTOR_DERIVED;
const PREVIEW_TTL = 10 * 60 * 1000;
const MAX_UPLOAD = 32 * 1024 * 1024;
const MAX_ITEMS = 20_000;

function text(value) {
  return String(value ?? "").replace(/[\u200B-\u200F\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function isoTime(value) {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function subtitleAt(phrase, index) {
  return text(phrase?.subtitles?.[index] ?? phrase?.subtitles?.[String(index)]);
}

function translationAt(phrase, index) {
  return text(phrase?.hTranslations?.[index] ?? phrase?.hTranslations?.[String(index)] ?? phrase?.mTranslations?.[index] ?? phrase?.mTranslations?.[String(index)]);
}

function transliterationFor(item, phrase) {
  if (item.itemType === "WORD") return text(item.word?.translit);
  const tokens = phrase?.subtitleTokens?.[1] ?? phrase?.subtitleTokens?.["1"];
  if (!Array.isArray(tokens) || !tokens.some((token) => text(token?.form?.translit))) return "";
  return tokens.map((token) => text(token?.form?.translit || token?.form?.text)).join("");
}

function sourceTitle(reference) {
  if (Array.isArray(reference?.title_arr)) {
    const joined = reference.title_arr.map(text).filter(Boolean).join(" · ");
    if (joined) return joined;
  }
  return text(reference?.title ?? reference?.diocoDocName ?? reference?.tm?.name) || "来源未标注";
}

function normalizeItem(item) {
  if (!item || !["PHRASE", "WORD"].includes(item.itemType)) return null;
  const phrase = item.context?.phrase;
  if (!phrase) return null;
  const reference = phrase.reference ?? {};
  const sentence = subtitleAt(phrase, 1);
  const word = text(item.word?.text);
  const id = text(item.key) || crypto.createHash("sha256").update(JSON.stringify([
    item.itemType, item.langCode_G, reference.source, reference.movieId ?? reference.packageId,
    reference.subtitleIndex, sentence, word,
  ])).digest("hex").slice(0, 24);
  if (!sentence && !word) return null;
  return {
    id,
    type: item.itemType === "PHRASE" ? "phrase" : "word",
    language: text(item.langCode_G),
    translationLanguage: text(item.translationLangCode_G),
    sentence: sentence || word,
    translation: translationAt(phrase, 1) || (Array.isArray(item.wordTranslationsArr) ? item.wordTranslationsArr.map(text).filter(Boolean).join("；") : ""),
    transliteration: transliterationFor(item, phrase),
    word: item.itemType === "WORD" ? word : "",
    wordTransliteration: item.itemType === "WORD" ? text(item.word?.translit) : "",
    wordTranslations: item.itemType === "WORD" && Array.isArray(item.wordTranslationsArr) ? item.wordTranslationsArr.map(text).filter(Boolean) : [],
    previous: subtitleAt(phrase, 0),
    previousTranslation: translationAt(phrase, 0),
    next: subtitleAt(phrase, 2),
    nextTranslation: translationAt(phrase, 2),
    source: text(reference.source ?? item.source) || "UNKNOWN",
    sourceTitle: sourceTitle(reference),
    sourceId: text(reference.movieId ?? reference.packageId ?? reference.diocoDocId ?? reference.tm?.id),
    subtitleIndex: Number.isFinite(Number(reference.subtitleIndex)) ? Number(reference.subtitleIndex) : null,
    startTimeMs: Number.isFinite(Number(reference.startTime_ms)) ? Number(reference.startTime_ms) : null,
    endTimeMs: Number.isFinite(Number(reference.endTime_ms)) ? Number(reference.endTime_ms) : null,
    learningStage: text(item.learningStage) || "LEARNING",
    tags: Array.isArray(item.tags) ? item.tags.map(text).filter(Boolean) : [],
    createdAt: isoTime(item.timeCreated_ms),
    modifiedAt: isoTime(item.timeModified_ms),
  };
}

function statsFor(items) {
  const phrases = items.filter((item) => item.type === "phrase").length;
  const words = items.filter((item) => item.type === "word").length;
  return {
    total: items.length,
    phrases,
    words,
    sources: new Set(items.map((item) => item.sourceTitle).filter(Boolean)).size,
    languages: [...new Set(items.map((item) => item.language).filter(Boolean))],
  };
}

export function parseLanguageReactorExport(raw, metadata = {}, existing = null) {
  let parsed;
  try { parsed = typeof raw === "string" || Buffer.isBuffer(raw) ? JSON.parse(String(raw)) : raw; } catch { throw new WorkbenchWriteError("这不是有效的 Language Reactor JSON 导出", 400, "LR_JSON_INVALID"); }
  if (!Array.isArray(parsed)) throw new WorkbenchWriteError("Language Reactor 导出应为 JSON 数组", 400, "LR_JSON_SHAPE_INVALID");
  if (parsed.length > MAX_ITEMS) throw new WorkbenchWriteError(`Language Reactor 条目超过 ${MAX_ITEMS.toLocaleString()} 条，已停止导入`, 413, "LR_ITEMS_TOO_MANY");
  const normalized = parsed.map(normalizeItem).filter(Boolean);
  if (!normalized.length) throw new WorkbenchWriteError("导出中没有找到可识别的收藏句子或单词", 400, "LR_ITEMS_MISSING");
  const previousItems = Array.isArray(existing?.items) ? existing.items : [];
  const merged = new Map(previousItems.map((item) => [item.id, item]));
  let added = 0; let updated = 0;
  for (const item of normalized) {
    if (merged.has(item.id)) updated += 1; else added += 1;
    merged.set(item.id, item);
  }
  const items = [...merged.values()].sort((a, b) => String(b.modifiedAt ?? b.createdAt ?? "").localeCompare(String(a.modifiedAt ?? a.createdAt ?? "")));
  const media = {
    audioOmitted: parsed.filter((item) => Boolean(item?.audio?.dataURL)).length,
    screenshotsOmitted: parsed.reduce((count, item) => count + Number(Boolean(item?.context?.phrase?.thumb_prev?.dataURL)) + Number(Boolean(item?.context?.phrase?.thumb_next?.dataURL)), 0),
  };
  return {
    schemaVersion: 1,
    importedAt: new Date().toISOString(),
    exportFile: text(metadata.fileName) || "Language Reactor JSON",
    import: { received: parsed.length, recognized: normalized.length, added, updated, preserved: Math.max(0, previousItems.length - updated) },
    stats: statsFor(items),
    media,
    note: "仅保存文字、翻译、语境与来源元数据；导出中的音频、截图和登录信息不进入 Vault。",
    items,
  };
}

function escapeCell(value) { return text(value).replaceAll("|", "\\|"); }

function summaryLine(data) {
  return `共 ${data.stats.total} 条收藏：${data.stats.phrases} 条句子、${data.stats.words} 个带语境单词，来自 ${data.stats.sources} 个内容来源。`;
}

async function atomicWriteFile(absolute, content, mode = 0o600) {
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.infans-${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await fsp.rename(temporary, absolute);
    if (mode) await fsp.chmod(absolute, mode);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function languageReactorDerivedPath(vaultRoot) {
  return path.resolve(vaultRoot, DERIVED_RELATIVE);
}

export async function writeLanguageReactorDerived(vaultRoot, data) {
  const normalized = { ...data, schemaVersion: Number(data?.schemaVersion) || 1 };
  await withVaultFileWrite(vaultRoot, DERIVED_RELATIVE, async (absolute) => {
    await atomicWriteFile(absolute, `${JSON.stringify(normalized)}\n`, 0o600);
  });
  return normalized;
}

export function renderLanguageReactorMarkdown(data) {
  const recent = data.items.slice(0, 30).map((item) => `| ${item.type === "phrase" ? "句子" : "单词"} | ${escapeCell(item.sentence)} | ${escapeCell(item.translation)} | ${escapeCell(item.sourceTitle)} |`).join("\n");
  return `---\ndescription: 从 Language Reactor 导入的日语收藏句子、带语境单词与来源摘要\ndate: ${tokyoDay(data.importedAt)}\ntags: [日语, Language Reactor, 沉浸语料, 数据导入]\n---\n\n# Language Reactor 收藏\n\n> [!info] 导入边界\n> ${data.note} 重新导入时按收藏键增量合并，不会因单次导出缺项自动删除旧收藏。完整结构化数据由工作台派生文件保存。\n\n- 导入时间：${data.importedAt}\n- 原始文件：${data.exportFile}\n- ${summaryLine(data)}\n- 本次识别 ${data.import.recognized} 条：新增 ${data.import.added}、更新 ${data.import.updated}、保留旧收藏 ${data.import.preserved}\n- 已略过 ${data.media.audioOmitted} 段音频与 ${data.media.screenshotsOmitted} 张截图\n\n## 最近收藏\n\n| 类型 | 原文 | 翻译 | 来源 |\n|---|---|---|---|\n${recent || "| — | 暂无 | — | — |"}\n\n> 完整收藏、筛选与上下文请在 Infans 本地工作台“语言学习”中查看。\n`;
}

export function parseLanguageReactorMarkdown(markdown) {
  const raw = String(markdown ?? "").match(/<!-- INFANS_LANGUAGE_REACTOR_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- INFANS_LANGUAGE_REACTOR_JSON_END -->/)?.[1];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** 句级展示译：优先完整句译；仅有说话人括号时退回单词义项。 */
export function displayReactorTranslation(item) {
  const translation = text(item?.translation);
  if (translation && !/^[（(][^）)]+[）)]\s*$/.test(translation)) return translation;
  const senses = Array.isArray(item?.wordTranslations) ? item.wordTranslations.map(text).filter(Boolean) : [];
  if (senses.length) return senses[0];
  return translation;
}

function hashDateKey(dateKey) {
  let hash = 0;
  for (const ch of String(dateKey)) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  return hash;
}

/** 语料难度粗分：汉字多、句子长优先；极短感叹/寒暄降权。 */
export function scoreSentenceDifficulty(sentence) {
  const t = text(sentence);
  if (!t) return 0;
  const kanji = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const len = t.replace(/\s+/g, "").length;
  let score = kanji * 3 + Math.min(len, 40);
  if (len < 8) score -= 8;
  if (/^(あ+|う+|え+|お+|ん+|はぁ|へえ|うん)([～〜ー\s]|$)/.test(t) || /^(あ～|う～|え～|お～)/.test(t)) score -= 4;
  if (/気持ち悪い|ありがとう|おはよう|こんにちは|さようなら|構わない|返します|念のために|よい旅を/.test(t)) score -= 4;
  return score;
}

/** 按东京日历日确定性抽取「每日一句」，优先句子条，并偏向偏难句。 */
export function pickDailySentence(collection, dateKey = tokyoDateKey()) {
  const items = Array.isArray(collection?.items) ? collection.items.filter((item) => text(item?.sentence)) : [];
  if (!items.length) return null;
  const phrases = items.filter((item) => item.type === "phrase");
  const base = phrases.length ? phrases : items;
  const scored = base
    .map((item) => ({ item, score: scoreSentenceDifficulty(item.sentence) }))
    .sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)));
  const hardCount = Math.max(8, Math.ceil(scored.length * 0.45));
  const hardPool = scored.length <= 8 ? scored : scored.slice(0, Math.min(hardCount, scored.length));
  const filtered = hardPool.filter((row) => row.score >= 12);
  const pool = filtered.length >= 3 ? filtered : hardPool;
  const item = pool[hashDateKey(dateKey) % pool.length].item;
  return {
    id: item.id,
    sentence: text(item.sentence),
    transliteration: text(item.transliteration || item.wordTransliteration),
    translation: displayReactorTranslation(item),
    sourceTitle: text(item.sourceTitle),
  };
}

export async function readLanguageReactorData(vaultRoot) {
  const root = path.resolve(vaultRoot);
  const derivedPath = languageReactorDerivedPath(root);
  try {
    const parsed = JSON.parse(await fsp.readFile(derivedPath, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const markdownPath = path.join(root, TARGET_PATH);
  let markdown;
  try {
    markdown = await fsp.readFile(markdownPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const data = parseLanguageReactorMarkdown(markdown);
  return data || null;
}

async function fingerprintFile(filePath) {
  try { const content = await fsp.readFile(filePath); return crypto.createHash("sha256").update(content).digest("hex"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export function createLanguageReactorImportService(vaultRoot, options = {}) {
  const root = path.resolve(vaultRoot); const pending = new Map(); const now = options.now ?? (() => new Date());
  return {
    async preview(request) {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw new WorkbenchWriteError("Language Reactor 导出超过 32 MB，请确认选择的是 JSON 收藏导出", 413, "LR_UPLOAD_TOO_LARGE");
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (!size) throw new WorkbenchWriteError("没有收到 Language Reactor 导出文件");
      const target = path.join(root, TARGET_PATH);
      const existing = await readLanguageReactorData(root);
      const fileName = decodeURIComponent(String(request.headers?.["x-infans-filename"] || "Language Reactor JSON"));
      const browserMs = Number(request.headers?.["x-infans-file-modified"]);
      const stamped = Number.isFinite(browserMs) && browserMs > 0
        ? { ...formatFileCreatedAt({ birthtimeMs: browserMs, mtimeMs: browserMs }), createdAtKind: "browser" }
        : null;
      const sourceFile = stamped?.createdAt
        ? { name: fileName, createdAt: stamped.createdAt, createdAtKind: stamped.createdAtKind }
        : undefined;
      const data = parseLanguageReactorExport(Buffer.concat(chunks), { fileName }, existing);
      const expectedHash = await fingerprintFile(target); const token = crypto.randomUUID(); const content = renderLanguageReactorMarkdown(data); const expiresAt = now().getTime() + PREVIEW_TTL;
      pending.set(token, { content, expectedHash, expiresAt, data });
      return {
        token,
        kind: "languageReactorImport",
        targetPath: TARGET_PATH,
        summary: "导入 Language Reactor 收藏",
        before: existing ? summaryLine(existing) : "尚未导入 Language Reactor 收藏",
        after: `${summaryLine(data)} 本次新增 ${data.import.added}、更新 ${data.import.updated}；音频与截图未保存。`,
        expiresAt: new Date(expiresAt).toISOString(),
        sourceFile,
      };
    },
    async commit(token) {
      const item = pending.get(token); pending.delete(token);
      if (!item || item.expiresAt < now().getTime()) throw new WorkbenchWriteError("Language Reactor 导入预览已过期", 409, "PREVIEW_EXPIRED");
      const target = path.join(root, TARGET_PATH);
      if (await fingerprintFile(target) !== item.expectedHash) throw new WorkbenchWriteError("Language Reactor 收藏已被外部修改，本次导入已停止", 409, "WRITE_CONFLICT");
      await writeLanguageReactorDerived(root, item.data);
      await withVaultFileWrite(root, TARGET_PATH, async (absolute) => {
        await atomicWriteFile(absolute, item.content, 0o600);
      });
      return { ok: true, targetPath: TARGET_PATH, derivedPath: DERIVED_RELATIVE };
    },
  };
}

export { LANGUAGE_REACTOR_SOURCE } from "./vault-paths.mjs";
