import { createHash } from "node:crypto";

export const DEMO_JLPT_DECK_ROOT = "JLPT::示例词汇";
export const INFANS_COURSE_VOCAB_DECK = "Infans日语::教材重点";

const DEFAULT_SOURCE_WORD_FIELDS = ["VocabKanji"];
const SOURCE_FIELD_ALIASES = {
  word: ["VocabKanji", "Word", "Expression", "单词"],
  reading: ["VocabFurigana", "VocabKana", "Reading", "读音"],
  pitch: ["VocabPitch", "Pitch", "音调"],
  meaningSc: ["VocabDefSC", "MeaningSC", "Meaning", "释义"],
  meaningTc: ["VocabDefTC", "MeaningTC"],
};

function rawFieldValue(fields, name) {
  const raw = fields?.[name];
  const value = raw && typeof raw === "object" ? raw.value : raw;
  return value == null ? "" : String(value);
}

function decodeCommonHtmlEntities(text) {
  return String(text)
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
}

function plainFieldValue(value) {
  return decodeCommonHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

/**
 * 精确查词只做格式归一：不把平假名、片假名、汉字或同义词互相折叠。
 * 因此「会う」不会误命中「あう」，同形异义词仍由 sourceNoteId 区分。
 */
export function normalizeJapaneseWord(value) {
  return plainFieldValue(value).normalize("NFKC");
}

function escapeAnkiSearchValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function firstRawField(fields, names) {
  for (const name of names) {
    const value = rawFieldValue(fields, name);
    if (value) return value;
  }
  return "";
}

export function extractSoundReferences(fields = {}) {
  const references = [];
  const seen = new Set();
  for (const raw of Object.values(fields)) {
    const value = raw && typeof raw === "object" ? raw.value : raw;
    const text = value == null ? "" : String(value);
    for (const match of text.matchAll(/\[sound:([^\]\r\n]+)\]/gi)) {
      const reference = `[sound:${match[1]}]`;
      if (seen.has(reference)) continue;
      seen.add(reference);
      references.push(reference);
    }
  }
  return references;
}

function sanitizeTagPart(value, fallback) {
  const normalized = normalizeJapaneseWord(value)
    .replace(/::/g, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized || fallback;
}

function lessonTag(lessonId) {
  return `infans::教材::${sanitizeTagPart(lessonId, "unknown-lesson")}`;
}

function sessionTag(sessionId) {
  return `infans::session::${sanitizeTagPart(sessionId, "unknown-session")}`;
}

function infansIdTag(infansId) {
  return `infans-id::${infansId}`;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => String(left).localeCompare(String(right), "ja", { numeric: true }));
}

export function buildCourseVocabularyInfansId({ sourceNoteId, normalizedWord }) {
  const noteId = String(sourceNoteId || "").trim();
  const word = normalizeJapaneseWord(normalizedWord);
  if (!noteId || !word) throw new Error("生成 InfansID 需要 sourceNoteId 和规范化单词");
  const digest = createHash("sha256")
    .update(`infans-demo-jlpt\u0000${noteId}\u0000${word}`)
    .digest("hex")
    .slice(0, 24);
  return `infans-jp-vocab-v1-${digest}`;
}

function getInvoker(client) {
  if (typeof client === "function") return client;
  if (client && typeof client.invoke === "function") {
    return client.invoke.bind(client);
  }
  throw new Error("Anki 客户端必须是 invoke(action, params) 函数或带 invoke 方法的对象");
}

function noteDeckNames(note, cardsById) {
  return uniqueSorted((note.cards || []).map((cardId) => cardsById.get(cardId)?.deckName || ""));
}

function isDeckInsideRoot(deckName, root) {
  const name = String(deckName || "");
  return name === root || name.startsWith(`${root}::`);
}

function sourceSummary(note, deckNames) {
  const fields = note.fields || {};
  const rawWord = firstRawField(fields, SOURCE_FIELD_ALIASES.word);
  const rawReading = firstRawField(fields, SOURCE_FIELD_ALIASES.reading);
  const rawPitch = firstRawField(fields, SOURCE_FIELD_ALIASES.pitch);
  const rawMeaningSc = firstRawField(fields, SOURCE_FIELD_ALIASES.meaningSc);
  const rawMeaningTc = firstRawField(fields, SOURCE_FIELD_ALIASES.meaningTc);
  return {
    noteId: String(note.noteId),
    modelName: String(note.modelName || ""),
    deckNames,
    word: rawWord,
    normalizedWord: normalizeJapaneseWord(rawWord),
    reading: rawReading,
    pitch: rawPitch,
    meaningSc: rawMeaningSc,
    meaningTc: rawMeaningTc,
    soundReferences: extractSoundReferences(fields),
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, rawFieldValue(fields, name)]),
    ),
    sourceTags: uniqueSorted(Array.isArray(note.tags) ? note.tags.map(String) : []),
  };
}

/**
 * 只读查找示例词汇库词条。Anki 搜索先缩小范围，最终仍在本地对字段做规范化后精确相等判断。
 */
export async function findExactSourceVocabulary(client, word, options = {}) {
  const invoke = getInvoker(client);
  const normalizedWord = normalizeJapaneseWord(word);
  const deckRoot = String(options.sourceDeckRoot || DEMO_JLPT_DECK_ROOT);
  const wordFields = Array.isArray(options.sourceWordFields) && options.sourceWordFields.length
    ? options.sourceWordFields.map(String)
    : DEFAULT_SOURCE_WORD_FIELDS;
  if (!normalizedWord) return [];

  const noteIds = new Set();
  for (const fieldName of wordFields) {
    const query = `deck:"${escapeAnkiSearchValue(deckRoot)}" ${fieldName}:"${escapeAnkiSearchValue(normalizedWord)}"`;
    const found = await invoke("findNotes", { query });
    for (const noteId of Array.isArray(found) ? found : []) noteIds.add(noteId);
  }
  if (!noteIds.size) return [];

  const notes = await invoke("notesInfo", { notes: [...noteIds] });
  const cardIds = uniqueSorted((Array.isArray(notes) ? notes : []).flatMap((note) => note.cards || []));
  const cards = cardIds.length ? await invoke("cardsInfo", { cards: cardIds }) : [];
  const cardsById = new Map((Array.isArray(cards) ? cards : []).map((card) => [card.cardId, card]));

  return (Array.isArray(notes) ? notes : [])
    .map((note) => sourceSummary(note, noteDeckNames(note, cardsById)))
    .filter((source) => source.normalizedWord === normalizedWord)
    .filter((source) => !source.deckNames.length || source.deckNames.some((deck) => isDeckInsideRoot(deck, deckRoot)))
    .sort((left, right) => Number(left.noteId) - Number(right.noteId));
}

async function findExistingDestinationNotes(client, { deckName, infansId }) {
  const invoke = getInvoker(client);
  const query = `deck:"${escapeAnkiSearchValue(deckName)}" tag:"${escapeAnkiSearchValue(infansIdTag(infansId))}"`;
  const noteIds = await invoke("findNotes", { query });
  if (!Array.isArray(noteIds) || !noteIds.length) return [];
  const notes = await invoke("notesInfo", { notes: noteIds });
  return (Array.isArray(notes) ? notes : []).filter((note) => {
    const tags = Array.isArray(note.tags) ? note.tags.map(String) : [];
    return tags.includes(infansIdTag(infansId));
  });
}

function previewBase({ word, normalizedWord, lessonId, sessionId, destinationDeck }) {
  return {
    schemaVersion: 1,
    requestedWord: String(word ?? ""),
    normalizedWord,
    lessonId: String(lessonId || ""),
    sessionId: String(sessionId || ""),
    destination: {
      deckName: destinationDeck,
      modelName: null,
    },
  };
}

/**
 * 生成待确认预览，不调用任何 Anki 写动作。
 * 多个同形词不擅自挑选；调用方需把候选展示给 Capoo，并带 sourceNoteId 重新预览。
 */
export async function previewCourseVocabularyCopy(input) {
  const {
    client,
    word,
    lessonId,
    sessionId,
    sourceNoteId = null,
    sourceDeckRoot = DEMO_JLPT_DECK_ROOT,
    destinationDeck = INFANS_COURSE_VOCAB_DECK,
  } = input || {};
  const normalizedWord = normalizeJapaneseWord(word);
  const base = previewBase({ word, normalizedWord, lessonId, sessionId, destinationDeck });
  if (!normalizedWord || !String(lessonId || "").trim() || !String(sessionId || "").trim()) {
    return {
      ...base,
      status: "invalid",
      message: "复制预览需要单词、教材课次 ID 和 GPT Live 会话 ID。",
      candidates: [],
    };
  }

  const matches = await findExactSourceVocabulary(client, normalizedWord, { sourceDeckRoot });
  if (!matches.length) {
    return {
      ...base,
      status: "not_found",
      message: "示例词汇库中没有规范化后完全相同的词条；按约定不新建 Anki 卡。",
      candidates: [],
    };
  }

  const selected = sourceNoteId == null
    ? (matches.length === 1 ? matches[0] : null)
    : matches.find((item) => String(item.noteId) === String(sourceNoteId));
  if (!selected) {
    return {
      ...base,
      status: "needs_source_selection",
      message: sourceNoteId == null
        ? "全量库存在多个同形词条，需要先选择正确读音和释义。"
        : "指定的 sourceNoteId 不在本次精确匹配候选中。",
      candidates: matches,
    };
  }

  const infansId = buildCourseVocabularyInfansId({
    sourceNoteId: selected.noteId,
    normalizedWord,
  });
  const existing = await findExistingDestinationNotes(client, { deckName: destinationDeck, infansId });
  const tags = uniqueSorted([
    ...selected.sourceTags,
    "infans",
    "infans::教材词汇",
    lessonTag(lessonId),
    sessionTag(sessionId),
    infansIdTag(infansId),
  ]);
  const preview = {
    ...base,
    destination: {
      ...base.destination,
      modelName: selected.modelName,
    },
    infansId,
    source: selected,
    candidates: matches,
    tags,
    existingNoteIds: existing.map((note) => String(note.noteId)),
  };
  if (existing.length) {
    return {
      ...preview,
      status: "already_exists",
      message: "教材重点牌组中已有同一 InfansID；不会重复创建，也不会修改原卡。",
    };
  }
  return {
    ...preview,
    status: "ready",
    message: "已生成只读复制预览；需 Capoo 明确确认后才能构造 addNote payload。",
    confirmationRequired: true,
  };
}

/**
 * 确认后只构造 AnkiConnect addNote payload；本模块本身不向真实 Anki 写入。
 * payload 不含卡片 ID、due、interval、ease 或复习记录，新卡由目标牌组配置重新调度。
 */
export function buildConfirmedCourseVocabularyNote(preview, options = {}) {
  if (options.confirmed !== true) {
    return {
      status: "confirmation_required",
      message: "尚未得到 Capoo 明确确认，不生成写入 payload。",
      action: null,
      params: null,
    };
  }
  if (!preview || preview.status !== "ready" || !preview.source || !preview.infansId) {
    return {
      status: preview?.status || "invalid",
      message: "只有状态为 ready 的最新预览才能在确认后生成 payload。",
      action: null,
      params: null,
    };
  }

  const source = preview.source;
  return {
    status: "ready_to_add",
    message: "已构造 addNote payload；源 note、源牌组和源复习历史均不在写入范围。",
    action: "addNote",
    params: {
      note: {
        deckName: preview.destination.deckName,
        modelName: source.modelName,
        fields: { ...source.fields },
        options: { allowDuplicate: true },
        tags: [...preview.tags],
      },
    },
  };
}
