import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConfirmedCourseVocabularyNote,
  buildCourseVocabularyInfansId,
  DEMO_JLPT_DECK_ROOT,
  extractSoundReferences,
  findExactSourceVocabulary,
  INFANS_COURSE_VOCAB_DECK,
  normalizeJapaneseWord,
  previewCourseVocabularyCopy,
} from "../src/server/workbench-anki-course.mjs";

function sourceNote(overrides = {}) {
  return {
    noteId: 101,
    modelName: "Infans示例JLPT",
    tags: ["JLPT_N3"],
    cards: [501],
    fields: {
      VocabKanji: { value: "高校" },
      VocabFurigana: { value: "こうこう" },
      VocabPitch: { value: "高校[0]" },
      VocabDefSC: { value: "高中" },
      VocabDefTC: { value: "高中" },
      VocabAudio: { value: "[sound:高校_NHK-2016.mp3]" },
    },
    ...overrides,
  };
}

function fakeClient({ notes = [sourceNote()], existing = [] } = {}) {
  const actions = [];
  return {
    actions,
    async invoke(action, params) {
      actions.push({ action, params });
      if (action === "findNotes") {
        if (params.query.includes("infans-id::")) return existing.map((note) => note.noteId);
        return notes.map((note) => note.noteId);
      }
      if (action === "notesInfo") {
        const all = [...notes, ...existing];
        return all.filter((note) => params.notes.includes(note.noteId));
      }
      if (action === "cardsInfo") {
        return params.cards.map((cardId) => ({
          cardId,
          deckName: `${DEMO_JLPT_DECK_ROOT}::3-N3::1-高频`,
        }));
      }
      throw new Error(`unexpected action: ${action}`);
    },
  };
}

test("normalizeJapaneseWord only normalizes formatting, not Japanese spellings", () => {
  assert.equal(normalizeJapaneseWord(" <b>高校</b>\u3000"), "高校");
  assert.equal(normalizeJapaneseWord("ＡＩ\u200b"), "AI");
  assert.notEqual(normalizeJapaneseWord("会う"), normalizeJapaneseWord("あう"));
});

test("extractSoundReferences reuses existing media references without duplicating them", () => {
  assert.deepEqual(extractSoundReferences({
    first: { value: "[sound:word.mp3]" },
    second: { value: "<div>[sound:word.mp3] [sound:example.mp3]</div>" },
  }), ["[sound:word.mp3]", "[sound:example.mp3]"]);
});

test("findExactSourceVocabulary scopes search then rejects substring matches locally", async () => {
  const client = fakeClient({
    notes: [
      sourceNote(),
      sourceNote({
        noteId: 102,
        cards: [502],
        fields: { ...sourceNote().fields, VocabKanji: { value: "高校生" } },
      }),
    ],
  });
  const matches = await findExactSourceVocabulary(client, " 高校 ");
  assert.deepEqual(matches.map((item) => item.noteId), ["101"]);
  assert.match(client.actions[0].params.query, /deck:"JLPT::示例词汇"/);
  assert.match(client.actions[0].params.query, /VocabKanji:"高校"/);
  assert.deepEqual(new Set(client.actions.map((item) => item.action)), new Set(["findNotes", "notesInfo", "cardsInfo"]));
});

test("preview returns not_found and never invents an Anki note", async () => {
  const client = fakeClient({ notes: [] });
  const preview = await previewCourseVocabularyCopy({
    client,
    word: "存在しない語",
    lessonId: "dekiru-chukyu-03",
    sessionId: "gpt-live-20260827-01",
  });
  assert.equal(preview.status, "not_found");
  assert.equal(preview.candidates.length, 0);
  assert.deepEqual(client.actions.map((item) => item.action), ["findNotes"]);
});

test("preview does not guess when multiple exact homographs exist", async () => {
  const client = fakeClient({
    notes: [
      sourceNote(),
      sourceNote({
        noteId: 102,
        cards: [502],
        fields: {
          ...sourceNote().fields,
          VocabFurigana: { value: "たかこう" },
          VocabDefSC: { value: "测试用同形词" },
        },
      }),
    ],
  });
  const preview = await previewCourseVocabularyCopy({
    client,
    word: "高校",
    lessonId: "dekiru-chukyu-03",
    sessionId: "gpt-live-20260827-01",
  });
  assert.equal(preview.status, "needs_source_selection");
  assert.equal(preview.candidates.length, 2);
});

test("ready preview carries stable identity, lesson/session tags and existing sound refs", async () => {
  const client = fakeClient();
  const input = {
    client,
    word: "高校",
    lessonId: "dekiru-chukyu-03",
    sessionId: "gpt-live-20260827-01",
  };
  const first = await previewCourseVocabularyCopy(input);
  const second = await previewCourseVocabularyCopy(input);
  assert.equal(first.status, "ready");
  assert.equal(first.infansId, second.infansId);
  assert.deepEqual(first.source.soundReferences, ["[sound:高校_NHK-2016.mp3]"]);
  assert.ok(first.tags.includes("infans::教材::dekiru-chukyu-03"));
  assert.ok(first.tags.includes("infans::session::gpt-live-20260827-01"));
  assert.ok(first.tags.includes(`infans-id::${first.infansId}`));
  assert.equal(first.destination.deckName, INFANS_COURSE_VOCAB_DECK);
});

test("stable InfansID distinguishes source notes for same surface form", () => {
  const one = buildCourseVocabularyInfansId({ sourceNoteId: 101, normalizedWord: "高校" });
  const two = buildCourseVocabularyInfansId({ sourceNoteId: 102, normalizedWord: "高校" });
  assert.match(one, /^infans-jp-vocab-v1-[a-f0-9]{24}$/);
  assert.notEqual(one, two);
});

test("idempotency check returns already_exists instead of a second payload", async () => {
  const infansId = buildCourseVocabularyInfansId({ sourceNoteId: 101, normalizedWord: "高校" });
  const existing = sourceNote({
    noteId: 901,
    cards: [9901],
    tags: [`infans-id::${infansId}`],
    fields: { VocabKanji: { value: "高校" } },
  });
  const client = fakeClient({ existing: [existing] });
  const preview = await previewCourseVocabularyCopy({
    client,
    word: "高校",
    lessonId: "dekiru-chukyu-03",
    sessionId: "gpt-live-20260827-01",
  });
  assert.equal(preview.status, "already_exists");
  const built = buildConfirmedCourseVocabularyNote(preview, { confirmed: true });
  assert.equal(built.action, null);
});

test("confirmed payload creates a fresh destination note without source scheduling data", async () => {
  const client = fakeClient();
  const preview = await previewCourseVocabularyCopy({
    client,
    word: "高校",
    lessonId: "dekiru-chukyu-03",
    sessionId: "gpt-live-20260827-01",
  });
  const beforeConfirm = buildConfirmedCourseVocabularyNote(preview);
  assert.equal(beforeConfirm.status, "confirmation_required");
  assert.equal(beforeConfirm.params, null);

  const built = buildConfirmedCourseVocabularyNote(preview, { confirmed: true });
  assert.equal(built.status, "ready_to_add");
  assert.equal(built.action, "addNote");
  assert.equal(built.params.note.deckName, INFANS_COURSE_VOCAB_DECK);
  assert.equal(built.params.note.modelName, "Infans示例JLPT");
  assert.deepEqual(built.params.note.fields, Object.fromEntries(
    Object.entries(sourceNote().fields).map(([name, value]) => [name, value.value]),
  ));
  assert.equal(built.params.note.fields.VocabAudio, "[sound:高校_NHK-2016.mp3]");
  assert.deepEqual(built.params.note.options, { allowDuplicate: true });
  assert.ok(built.params.note.tags.includes("JLPT_N3"));
  assert.equal("cards" in built.params.note, false);
  assert.equal("due" in built.params.note, false);
  assert.equal("interval" in built.params.note, false);
  assert.equal("ease" in built.params.note, false);

  const writes = client.actions.filter((item) => [
    "addNote",
    "updateNoteFields",
    "addTags",
    "changeDeck",
    "setSpecificValueOfCard",
  ].includes(item.action));
  assert.deepEqual(writes, []);
});
