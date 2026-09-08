import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createLanguageReactorImportService,
  displayReactorTranslation,
  languageReactorDerivedPath,
  parseLanguageReactorExport,
  parseLanguageReactorMarkdown,
  pickDailySentence,
  readLanguageReactorData,
  renderLanguageReactorMarkdown,
} from "../src/server/workbench-language-reactor.mjs";

function phrase(key = "phrase-1") {
  return {
    key,
    itemType: "PHRASE",
    langCode_G: "ja",
    translationLangCode_G: "zh-CN",
    learningStage: "LEARNING",
    tags: ["喜欢"],
    timeCreated_ms: 1785366000000,
    timeModified_ms: 1785367000000,
    audio: { dataURL: "data:audio/mp3;base64,SECRET_AUDIO" },
    context: { phrase: {
      subtitles: { 0: "前の文。", 1: "諦めたらそこで終わりだ。", 2: "次の文。" },
      mTranslations: { 0: "前一句。", 1: "放弃的话就到此为止。", 2: "后一句。" },
      subtitleTokens: { 1: [{ form: { text: "諦めたら", translit: "あきらめたら" } }, { form: { text: "そこで", translit: "そこで" } }, { form: { text: "終わりだ", translit: "おわりだ" } }] },
      thumb_prev: { dataURL: "data:image/jpeg;base64,SECRET_PREV" },
      thumb_next: { dataURL: "data:image/jpeg;base64,SECRET_NEXT" },
      reference: { source: "NETFLIX", packageId: "show-1", title_arr: ["作品", "第1话"], subtitleIndex: 12, startTime_ms: 65000, endTime_ms: 68000 },
    } },
  };
}

function word() {
  return {
    ...phrase("word-1"),
    itemType: "WORD",
    word: { text: "諦める", translit: "あきらめる" },
    wordTranslationsArr: ["放弃"],
    context: { ...phrase().context, wordIndex: 0 },
  };
}

function requestFor(items) {
  const request = Readable.from([JSON.stringify(items)]);
  request.headers = { "x-infans-filename": encodeURIComponent("lln_json_items.json") };
  return request;
}

test("normalizes Language Reactor phrases and contextual words without media", () => {
  const data = parseLanguageReactorExport([phrase(), word()], { fileName: "saved.json" });
  assert.deepEqual(data.stats, { total: 2, phrases: 1, words: 1, sources: 1, languages: ["ja"] });
  assert.equal(data.items[0].sourceTitle, "作品 · 第1话");
  assert.equal(data.items.find((item) => item.type === "word").word, "諦める");
  assert.equal(data.media.audioOmitted, 2);
  assert.equal(data.media.screenshotsOmitted, 4);
  const markdown = renderLanguageReactorMarkdown(data);
  assert.equal(markdown.includes("SECRET_AUDIO"), false);
  assert.equal(markdown.includes("SECRET_PREV"), false);
  assert.equal(markdown.includes("INFANS_LANGUAGE_REACTOR_JSON_START"), false);
  assert.equal(parseLanguageReactorMarkdown(markdown), null);
});

test("reimport merges by stable Language Reactor key", () => {
  const first = parseLanguageReactorExport([phrase()], { fileName: "first.json" });
  const changed = phrase(); changed.context.phrase.mTranslations[1] = "更新后的翻译";
  const second = parseLanguageReactorExport([changed, word()], { fileName: "second.json" }, first);
  assert.equal(second.stats.total, 2);
  assert.deepEqual(second.import, { received: 2, recognized: 2, added: 1, updated: 1, preserved: 0 });
  assert.equal(second.items.find((item) => item.id === "phrase-1").translation, "更新后的翻译");
});

test("Language Reactor import requires preview and stops on external edits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-lr-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createLanguageReactorImportService(root, { now: () => new Date("2026-08-01T00:00:00+09:00") });
  const preview = await service.preview(requestFor([phrase(), word()]));
  assert.match(preview.after, /2 条收藏/);
  const target = path.join(root, preview.targetPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "外部修改", "utf8");
  await assert.rejects(() => service.commit(preview.token), /外部修改/);
});

test("confirmed Language Reactor import writes markdown summary and derived JSON", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-lr-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createLanguageReactorImportService(root);
  const preview = await service.preview(requestFor([phrase(), word()]));
  await service.commit(preview.token);
  const content = await fs.readFile(path.join(root, preview.targetPath), "utf8");
  assert.match(content, /description:/);
  assert.match(content, /諦めたらそこで終わりだ/);
  assert.equal(content.includes("SECRET_AUDIO"), false);
  assert.equal(content.includes("INFANS_LANGUAGE_REACTOR_JSON_START"), false);
  const derived = JSON.parse(await fs.readFile(languageReactorDerivedPath(root), "utf8"));
  assert.equal(derived.stats.total, 2);
});

test("incremental merge prefers the derived file over markdown JSON", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-lr-merge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createLanguageReactorImportService(root);
  const first = await service.preview(requestFor([phrase()]));
  await service.commit(first.token);
  const second = await service.preview(requestFor([word()]));
  await service.commit(second.token);
  const merged = await readLanguageReactorData(root);
  assert.equal(merged.stats.total, 2);
  assert.equal(merged.import.preserved, 1);
});

test("falls back to legacy Language Reactor JSON without mutating files during a read", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-lr-migrate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = parseLanguageReactorExport([phrase(), word()], { fileName: "saved.json" });
  const target = path.join(root, "55_语言学习/日语/收藏/沉浸语料/Language Reactor收藏.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${renderLanguageReactorMarkdown(data)}\n## 工作台结构化数据\n\n<!-- INFANS_LANGUAGE_REACTOR_JSON_START -->\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n<!-- INFANS_LANGUAGE_REACTOR_JSON_END -->\n`, "utf8");
  const loaded = await readLanguageReactorData(root);
  assert.equal(loaded.stats.total, 2);
  assert.equal((await fs.readFile(target, "utf8")).includes("INFANS_LANGUAGE_REACTOR_JSON_START"), true);
  await assert.rejects(() => fs.readFile(languageReactorDerivedPath(root), "utf8"), { code: "ENOENT" });
});

test("pickDailySentence is deterministic by Tokyo date and prefers phrases", () => {
  const collection = parseLanguageReactorExport([
    phrase("phrase-a"),
    phrase("phrase-b"),
    word("word-a"),
  ], { fileName: "daily.json" });
  const a = pickDailySentence(collection, "2026-08-02");
  const b = pickDailySentence(collection, "2026-08-02");
  const c = pickDailySentence(collection, "2026-08-03");
  assert.equal(a?.id, b?.id);
  assert.ok(["phrase-a", "phrase-b"].includes(a?.id));
  assert.ok(a?.sentence);
  assert.ok(a?.translation);
  // 日期不同时允许偶发撞同一索引；用更大池再验一次换日即可
  const wide = parseLanguageReactorExport(
    Array.from({ length: 12 }, (_, i) => phrase(`phrase-${i}`)),
    { fileName: "wide.json" },
  );
  assert.notEqual(pickDailySentence(wide, "2026-08-02")?.id, pickDailySentence(wide, "2026-08-03")?.id);
});

test("pickDailySentence prefers harder phrases over short exclamations", () => {
  const easy = {
    ...phrase("easy"),
    context: {
      phrase: {
        ...phrase("easy").context.phrase,
        subtitles: { 1: "あ～ 気持ち悪い" },
        mTranslations: { 1: "啊~我感觉不好" },
      },
    },
  };
  const hardOnes = Array.from({ length: 10 }, (_, i) => {
    const key = `hard-${i}`;
    const base = phrase(key);
    return {
      ...base,
      context: {
        phrase: {
          ...base.context.phrase,
          subtitles: { 1: `この席に座れば人に会話を聞かれることもない-${i}` },
          mTranslations: { 1: `如果你坐在这个座位上，人们不会听到你的谈话-${i}` },
        },
      },
    };
  });
  const collection = parseLanguageReactorExport([easy, ...hardOnes], { fileName: "hard.json" });
  for (const day of ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]) {
    const picked = pickDailySentence(collection, day);
    assert.ok(picked?.id);
    assert.notEqual(picked.id, "easy");
    assert.match(picked.sentence, /この席に座れば/);
  }
});

test("displayReactorTranslation falls back from speaker-only gloss", () => {
  assert.equal(displayReactorTranslation({ translation: "名不副实", wordTranslations: ["名不副实"] }), "名不副实");
  assert.equal(displayReactorTranslation({ translation: "（厄普森）", wordTranslations: ["真是", "完全"] }), "真是");
});
