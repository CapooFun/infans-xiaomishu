import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { courseMaterialPath, readCourseStCard } from "../src/server/workbench-language-course.mjs";

const VAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const BOOKS = {
  beginner: {
    lessons: 15,
    stPerLesson: 3,
    sectionTotal: 150,
    finalTrack: 300,
    pageRanges: [[1, 9], [10, 21], [22, 33], [34, 44], [45, 58], [59, 71], [72, 83], [84, 96], [97, 109], [110, 120], [121, 135], [136, 148], [149, 160], [161, 170], [171, 182]],
  },
  intermediate: {
    lessons: 15,
    stPerLesson: 2,
    sectionTotal: 120,
    finalTrack: 234,
    pageRanges: [[1, 12], [13, 25], [26, 37], [38, 47], [48, 60], [61, 68], [69, 79], [80, 91], [92, 102], [103, 118], [119, 127], [128, 137], [138, 147], [148, 156], [157, 166]],
  },
};

function expandTrack(locator) {
  const match = String(locator).match(/^(\d{3})(?:-(\d{3}))?$/);
  assert.ok(match, `音轨定位格式无效：${locator}`);
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  assert.ok(end >= start, `音轨范围倒置：${locator}`);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function collectIds(card) {
  const ids = [card.stId];
  for (const section of card.sections) {
    ids.push(section.id);
    for (const item of section.items) {
      ids.push(item.id);
      for (const block of item.blocks) {
        ids.push(block.id);
        for (const line of block.lines || []) ids.push(line.id);
      }
    }
  }
  return ids;
}

test("两册官方配套资料完整形成30课75张ST学习卡", async () => {
  let lessonTotal = 0;
  let stTotal = 0;
  let sectionTotal = 0;
  const allIds = [];

  for (const [bookId, book] of Object.entries(BOOKS)) {
    const tracks = [];
    let bookSectionTotal = 0;
    for (let lesson = 1; lesson <= book.lessons; lesson += 1) {
      const payload = JSON.parse(await readFile(courseMaterialPath(VAULT_ROOT, bookId, lesson), "utf8"));
      assert.equal(payload.schemaVersion, 1);
      assert.equal(payload.book.id, bookId);
      assert.equal(payload.lesson.number, lesson);
      assert.deepEqual(payload.source.pdfPages, book.pageRanges[lesson - 1]);
      assert.equal(payload.stCards.length, book.stPerLesson);

      const lessonCards = [];
      for (let st = 1; st <= book.stPerLesson; st += 1) {
        const card = await readCourseStCard(VAULT_ROOT, { book: bookId, lesson, st });
        assert.ok(card, `${bookId} 第${lesson}课 ST${st} 缺失`);
        lessonCards.push(card);
        stTotal += 1;
        sectionTotal += card.sections.length;
        bookSectionTotal += card.sections.length;
        allIds.push(...collectIds(card));
        for (const section of card.sections) {
          for (const item of section.items) {
            if (item.audioTrack) tracks.push(...expandTrack(item.audioTrack));
          }
        }

        const kinds = card.sections.map((section) => section.kind);
        for (const required of ["challenge", "say", "try"]) {
          assert.equal(kinds.filter((kind) => kind === required).length, 1, `${card.stId} 缺少或重复 ${required}`);
        }
      }

      const lessonKinds = lessonCards.flatMap((card) => card.sections.map((section) => section.kind));
      assert.equal(lessonKinds.filter((kind) => kind === "listen").length, 1, `${bookId} 第${lesson}课 listen 数量错误`);
      assert.equal(
        lessonKinds.filter((kind) => kind === "integrated").length,
        bookId === "intermediate" ? 1 : 0,
        `${bookId} 第${lesson}课 integrated 数量错误`,
      );
      lessonTotal += 1;
    }

    assert.equal(bookSectionTotal, book.sectionTotal);
    assert.deepEqual(tracks, Array.from({ length: book.finalTrack }, (_, index) => index + 1), `${bookId} 音轨应连续且不重复`);
  }

  assert.equal(lessonTotal, 30);
  assert.equal(stTotal, 75);
  assert.equal(sectionTotal, 270);
  assert.equal(new Set(allIds).size, allIds.length, "两册嵌套 ID 必须全局唯一");
});

test("正文不保留已确认的文本层错字或不可见控制符", async () => {
  for (const [bookId, book] of Object.entries(BOOKS)) {
    for (let lesson = 1; lesson <= book.lessons; lesson += 1) {
      const raw = await readFile(courseMaterialPath(VAULT_ROOT, bookId, lesson), "utf8");
      assert.doesNotMatch(raw, /ありがとうござます/);
      assert.doesNotMatch(raw, /[\f\uFFFD]/);
    }
  }
});

test("30课75张ST均按小节提供分用法双语例句", async () => {
  let cardTotal = 0;
  const grammarIds = new Set();

  for (const [bookId, book] of Object.entries(BOOKS)) {
    for (let lesson = 1; lesson <= book.lessons; lesson += 1) {
      for (let st = 1; st <= book.stPerLesson; st += 1) {
        const card = await readCourseStCard(VAULT_ROOT, { book: bookId, lesson, st });
        assert.ok(card.grammarFocus.length >= 1, `${card.stId} 缺少按小节整理的语法卡`);
        cardTotal += 1;

        for (const point of card.grammarFocus) {
          assert.ok(point.id.startsWith(`${card.stId}-grammar-`), `${point.id} 没有使用所属 ST 前缀`);
          assert.equal(grammarIds.has(point.id), false, `${point.id} 重复`);
          grammarIds.add(point.id);
          assert.ok(point.kind.trim(), `${point.id} 缺少语法类型`);
          assert.ok(point.pattern.trim(), `${point.id} 缺少句型`);
          assert.ok(point.connection.trim(), `${point.id} 缺少接续`);
          assert.ok(point.summary.trim(), `${point.id} 缺少中文说明`);
          assert.ok(point.usages.length >= 1, `${point.id} 缺少用法`);
          for (const usage of point.usages) {
            assert.ok(usage.label.trim(), `${point.id} 的用法缺少名称`);
            assert.ok(usage.explanation.trim(), `${point.id} 的 ${usage.label} 缺少说明`);
            assert.ok(usage.examples.length >= 1, `${point.id} 的 ${usage.label} 缺少例句`);
            for (const example of usage.examples) {
              assert.ok(example.japanese.trim(), `${point.id} 缺少日文例句`);
              assert.ok(example.chinese.trim(), `${point.id} 缺少中文翻译`);
              assert.match(example.source, /^(课文例句|课内例句|课内练习|复习例句)$/, `${point.id} 的例句来源标签不明确`);
            }
          }
        }
      }
    }
  }

  assert.equal(cardTotal, 75);
});

test("初中级第3课保留已通过的3-1与3-2语法数量", async () => {
  const st1 = await readCourseStCard(VAULT_ROOT, { book: "intermediate", lesson: 3, st: 1 });
  const st2 = await readCourseStCard(VAULT_ROOT, { book: "intermediate", lesson: 3, st: 2 });
  assert.equal(st1.grammarFocus.length, 4);
  assert.equal(st2.grammarFocus.length, 3);
});
