import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JP_COURSE_RECORDS_DIR,
  JP_COURSE_STRUCTURE_PATH,
  JP_ORAL_REVIEW_LEDGER_PATH,
  buildJapaneseCourseProgress,
  parseCourseLearningRecord,
  parseCoursePracticeConfirmation,
  parseOralPracticeRecord,
  parseOralReviewLedger,
  parseCourseStructure,
} from "../src/server/workbench-japanese-course-progress.mjs";
import { JP_STATUS } from "../src/server/vault-paths.mjs";

const STRUCTURE = `
| 课次 | 初級 | 初中級 |
|---:|---|---|
${Array.from({ length: 15 }, (_, index) => `| ${index + 1} | 初級题${index + 1} | 初中級题${index + 1} |`).join("\n")}
`;

const CONFIRMATION = `
record_kind: capoo-practice-confirmation
confirmation_id: jpractice-20260903-chukyu-03-st2
evidence_origin: capoo-explicit
practice_confirmed: true
confirmed_on: 2026-09-03
sourceConversationId: 01a06791-85f6-7f80-91e7-b60501c1e684
confirmation_quote: 我3-2也是练了的！
lesson_id: dekiru-chukyu-03
unit_id: dekiru-chukyu-03-st2
verified_by_codex: true
`;

test("本人练习确认只接受明确来源与有效小节，不是分级或新场次", () => {
  const record = parseCoursePracticeConfirmation(CONFIRMATION, "confirmation.md");
  assert.equal(record.stId, "dekiru-chukyu-03-st2");
  assert.equal(record.confirmedOn, "2026-09-03");
  assert.equal(record.level, undefined);
  assert.equal(parseCourseLearningRecord(CONFIRMATION).valid, false);
  assert.equal(parseOralPracticeRecord(CONFIRMATION), null);
  for (const invalid of [
    CONFIRMATION.replace("capoo-explicit", "ai-synthesis"),
    CONFIRMATION.replace("practice_confirmed: true", "practice_confirmed: false"),
    CONFIRMATION.replace("verified_by_codex: true", "verified_by_codex: false"),
    CONFIRMATION.replace("chukyu-03-st2", "chukyu-03-st9").replace("unit_id: dekiru-chukyu-03-st2", "unit_id: dekiru-chukyu-03-st9"),
    CONFIRMATION.replace(/sourceConversationId:.*/, ""),
    CONFIRMATION.replace(/confirmation_quote:.*/, ""),
  ]) assert.equal(parseCoursePracticeConfirmation(invalid), null);
});

test("多次同节、自由口语与本人确认分别统计，不把确认日当练习日", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jp-practice-coverage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, JP_COURSE_RECORDS_DIR);
  await fs.mkdir(directory, { recursive: true });
  const second = VALID_RECORD.replaceAll("20260828-2030-a7b9", "20260901-2030-a7b9").replaceAll("2026-08-28", "2026-09-01");
  const free = VALID_RECORD.replaceAll("20260828-2030-a7b9", "20260830-2030-a7b9").replaceAll("2026-08-28", "2026-08-30").replace("lesson_id：dekiru-chukyu-03", "lesson_id：unresolved");
  for (const [name, contents] of Object.entries({ first: VALID_RECORD, second, duplicate: second, free, confirmation: CONFIRMATION })) {
    await fs.writeFile(path.join(directory, `${name}.md`), contents);
  }
  const progress = await buildJapaneseCourseProgress(root);
  assert.equal(progress.summary.recordedSessionCount, 3);
  assert.equal(progress.summary.validRecordCount, 2);
  assert.equal(progress.summary.practicedSt, 2);
  assert.equal(progress.summary.stWithEvidence, 1);
  assert.equal(progress.summary.ungradedPracticedSt, 1);
  assert.equal(progress.summary.masteredSt, 0);
  assert.equal(progress.summary.lastPracticedOn, "2026-09-01");
  const st2 = progress.books[1].lessons[2].stItems[1];
  assert.equal(st2.practiced, true);
  assert.equal(st2.status, "in-progress");
  assert.equal(st2.level, null);
  assert.deepEqual(st2.recordIds, []);
  assert.deepEqual(st2.modalities, { speaking: false, listening: false, output: false });
  await fs.writeFile(path.join(directory, "graded-st2.md"), second.replaceAll("st1", "st2").replaceAll("a7b9", "c8d0"));
  const updated = await buildJapaneseCourseProgress(root);
  assert.equal(updated.summary.practicedSt, 2);
  assert.equal(updated.summary.stWithEvidence, 2);
  assert.equal(updated.summary.ungradedPracticedSt, 0);
  assert.equal(updated.books[1].lessons[2].stItems[1].level, 2);
});

const VALID_RECORD = `
record_kind：real-capoo-session
session_id：jlive-20260828-2030-a7b9
session_outcome：completed
practice_surface: mixed
练习日期：2026-08-28（Asia/Tokyo）
实际练习时间：约 16:34–17:29；含热身与当场复盘
- lesson_id：dekiru-chukyu-03
- unit_id：dekiru-chukyu-03-st1
- 练习后等级：LV2 可独立完成
- 独立正确次数：2
- 换词或换场景成功次数：1
- 观察：能听懂指令并听辨目标形式

## Codex 核验
- verified_by_codex: true
- verified_at: 2026-08-28T21:00+09:00
`;

const ORAL_REVIEW_LEDGER = `
# 日语口语复习台账

\`\`\`json
{
  "schemaVersion": 1,
  "updatedOn": "2026-08-31",
  "scheduleDays": [1, 3, 7, 21, 60],
  "items": [
    {
      "reviewItemId": "recent-high",
      "knowledgeId": "N4-02",
      "label": "意向形",
      "kind": "conjugation",
      "trigger": "prompted",
      "stage": "activated",
      "successfulDays": 0,
      "reviewStep": 0,
      "lastPracticedOn": "2026-08-30",
      "lastResult": "提示后完成",
      "maxPassedGapDays": 0,
      "nextReviewOn": "2026-08-31",
      "priority": "high",
      "queueRank": 1,
      "testInstruction": "隐藏目标",
      "passRule": "首次正确",
      "sourceEvidence": ["session#conjugation-01"]
    },
    {
      "reviewItemId": "later-medium",
      "knowledgeId": "N4-03",
      "label": "计划表达",
      "kind": "grammar",
      "trigger": "single-correct",
      "stage": "activated",
      "successfulDays": 0,
      "reviewStep": 0,
      "lastPracticedOn": "2026-08-30",
      "lastResult": "独立一次",
      "maxPassedGapDays": 0,
      "nextReviewOn": "2026-08-31",
      "priority": "medium",
      "queueRank": 2,
      "testInstruction": "隐藏目标",
      "passRule": "首次正确",
      "sourceEvidence": []
    },
    {
      "reviewItemId": "third-low",
      "knowledgeId": "N4-48",
      "label": "计划表达二",
      "kind": "grammar",
      "trigger": "corrected",
      "stage": "activated",
      "successfulDays": 0,
      "reviewStep": 0,
      "lastPracticedOn": "2026-08-30",
      "lastResult": "纠正后完成",
      "maxPassedGapDays": 0,
      "nextReviewOn": "2026-08-31",
      "priority": "low",
      "queueRank": 3,
      "testInstruction": "隐藏目标",
      "passRule": "首次正确",
      "sourceEvidence": []
    }
  ]
}
\`\`\`
`;

test("官方课次表派生 15 课标题", () => {
  const rows = parseCourseStructure(STRUCTURE);
  assert.equal(rows.length, 15);
  assert.equal(rows[2].beginnerTitle, "初級题3");
  assert.equal(rows[14].intermediateTitle, "初中級题15");
});

test("只有真实、完成或主动结束、Codex 核验的记录可计入", () => {
  const valid = parseCourseLearningRecord(VALID_RECORD, "record.md");
  assert.equal(valid.valid, true);
  assert.equal(valid.recordId, "jlive-20260828-2030-a7b9");
  assert.equal(valid.stId, "dekiru-chukyu-03-st1");
  assert.equal(valid.status, "in-progress");
  assert.deepEqual(valid.modalities, { speaking: true, listening: true, output: true });

  const failure = parseCourseLearningRecord(
    VALID_RECORD.replace("real-capoo-session", "system-pilot-failure"),
    "failure.md",
  );
  assert.equal(failure.valid, false);
  assert.equal(failure.excludedReason, "not-real-session");

  const unverified = parseCourseLearningRecord(
    VALID_RECORD.replace("verified_by_codex: true", "verified_by_codex: false"),
    "unverified.md",
  );
  assert.equal(unverified.valid, false);
  assert.equal(unverified.excludedReason, "not-codex-verified");
});

test("只有 LV3 才派生为跨日稳定完成", () => {
  const stable = parseCourseLearningRecord(VALID_RECORD.replace("LV2 可独立完成", "LV3 跨日稳定"), "stable.md");
  assert.equal(stable.valid, true);
  assert.equal(stable.status, "mastered");
});

test("口语复习台账固定 1/3/7/21/60 节奏并只预装前两项", () => {
  const ledger = parseOralReviewLedger(ORAL_REVIEW_LEDGER, "2026-08-31");
  assert.equal(ledger.valid, true);
  assert.deepEqual(ledger.scheduleDays, [1, 3, 7, 21, 60]);
  assert.equal(ledger.activeCount, 3);
  assert.equal(ledger.dueCount, 3);
  assert.equal(ledger.dueItems.length, 2);
  assert.equal(ledger.dueItems[0].reviewItemId, "recent-high");
  assert.equal(ledger.dueItems[1].reviewItemId, "later-medium");
  assert.equal(ledger.nextDueOn, "2026-08-31");
});

test("口语活动兼容机器时长和旧记录时间区间", () => {
  const legacy = parseOralPracticeRecord(VALID_RECORD, "legacy.md");
  assert.equal(legacy.durationMinutes, 55);
  assert.equal(legacy.estimated, true);
  const explicit = parseOralPracticeRecord(`${VALID_RECORD}\npractice_duration_minutes: 42\n`, "new.md");
  assert.equal(explicit.durationMinutes, 42);
  assert.equal(explicit.estimated, false);
});

test("初級 45 ST + 初中級 30 ST，当前选课不自动计完成", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jp-course-progress-"));
  await fs.mkdir(path.join(root, path.dirname(JP_COURSE_STRUCTURE_PATH)), { recursive: true });
  await fs.writeFile(path.join(root, JP_COURSE_STRUCTURE_PATH), STRUCTURE);
  await fs.mkdir(path.join(root, path.dirname(JP_STATUS)), { recursive: true });
  await fs.writeFile(path.join(root, JP_STATUS), "当前课：`dekiru-chukyu-03`。这不是完成证据。\n");
  await fs.mkdir(path.join(root, JP_COURSE_RECORDS_DIR), { recursive: true });
  await fs.writeFile(path.join(root, JP_COURSE_RECORDS_DIR, "README.md"), "模板不是记录\n");
  await fs.mkdir(path.join(root, path.dirname(JP_ORAL_REVIEW_LEDGER_PATH)), { recursive: true });
  await fs.writeFile(path.join(root, JP_ORAL_REVIEW_LEDGER_PATH), ORAL_REVIEW_LEDGER);

  const progress = await buildJapaneseCourseProgress(root, { today: "2026-08-31" });
  assert.equal(progress.summary.lessonTotal, 30);
  assert.equal(progress.books[0].stTotal, 45);
  assert.equal(progress.books[1].stTotal, 30);
  assert.equal(progress.summary.stTotal, 75);
  assert.equal(progress.summary.stWithEvidence, 0);
  assert.equal(progress.summary.masteredSt, 0);
  assert.equal(progress.oralReview.dueCount, 3);
  assert.equal(progress.paths.oralReview, JP_ORAL_REVIEW_LEDGER_PATH);
  assert.equal(progress.currentSelection.lessonId, "dekiru-chukyu-03");
  assert.equal(progress.evidenceRule, "只有你真的练过并留下记录，才会算进这里；只是导入教材、让 AI 整理内容或选中课程，都不算学过。");
  const current = progress.books[1].lessons[2];
  assert.equal(current.isCurrentSelection, true);
  assert.equal(current.status, "not-started");
  assert.ok(current.stItems.every((item) => item.status === "not-started"));
});

test("真实记录只点亮对应 ST 和实际能力证据", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jp-course-evidence-"));
  await fs.mkdir(path.join(root, path.dirname(JP_COURSE_STRUCTURE_PATH)), { recursive: true });
  await fs.writeFile(path.join(root, JP_COURSE_STRUCTURE_PATH), STRUCTURE);
  await fs.mkdir(path.join(root, path.dirname(JP_STATUS)), { recursive: true });
  await fs.writeFile(path.join(root, JP_STATUS), "当前课：`dekiru-chukyu-03`\n");
  await fs.mkdir(path.join(root, JP_COURSE_RECORDS_DIR), { recursive: true });
  await fs.writeFile(path.join(root, JP_COURSE_RECORDS_DIR, "valid.md"), VALID_RECORD);
  await fs.writeFile(
    path.join(root, JP_COURSE_RECORDS_DIR, "failure.md"),
    VALID_RECORD.replace("real-capoo-session", "system-pilot-failure"),
  );

  const progress = await buildJapaneseCourseProgress(root);
  assert.equal(progress.summary.validRecordCount, 1);
  assert.equal(progress.summary.stWithEvidence, 1);
  assert.equal(progress.summary.masteredSt, 0);
  assert.equal(progress.summary.speakingSt, 1);
  assert.equal(progress.summary.listeningSt, 1);
  assert.equal(progress.summary.outputSt, 1);
  assert.equal(progress.oralSessions[0].durationMinutes, 55);
  assert.equal(progress.books[1].lessons[2].status, "in-progress");
  assert.equal(progress.books[1].lessons[2].stItems[0].recordIds[0], "jlive-20260828-2030-a7b9");
});
