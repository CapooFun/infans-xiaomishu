import assert from "node:assert/strict";
import test from "node:test";
import {
  TRAINING_REVIEW_APPEND_ANCHOR,
  TRAINING_REVIEW_PATH,
  buildTrainingReviewAppendAction,
  buildTrainingReviewDraft,
  buildTrainingReviewWriteAction,
  shiftTokyoDay,
} from "../src/pages/training-review.ts";

test("shiftTokyoDay stays on calendar days", () => {
  assert.equal(shiftTokyoDay("2026-08-05", -20), "2026-07-16");
  assert.equal(shiftTokyoDay("2026-08-01", -1), "2026-07-31");
});

test("buildTrainingReviewDraft fills main lifts from series and leaves missing as 待填", () => {
  const draft = buildTrainingReviewDraft({
    today: "2026-08-05",
    days: 21,
    trainingVolume: {
      weekly: [{ weekStart: "2026-07-28", muscles: { chest: 1000 }, totalTonnageKg: 1000, bodyweightReps: 0 }],
      topSetSeries: [
        {
          name: "杠铃平板卧推",
          points: [
            { date: "2026-07-22", topSet: "60kg × 12次 2组", weightKg: 60, reps: [12, 12], bodyweight: false },
            { date: "2026-08-03", topSet: "60kg × 12次 3组", weightKg: 60, reps: [12, 12, 12], bodyweight: false },
          ],
        },
        {
          name: "引体向上",
          points: [
            { date: "2026-08-03", topSet: "自重 × 20次", weightKg: null, reps: [20], bodyweight: true },
          ],
        },
      ],
    },
    measurements: [{ date: "2026-08-01", weightKg: 74.5, waist: 82 }],
    sleepMinutes: null,
    reviewModel: {
      conclusion: ["近一周吨位约 1,000 kg。"],
      items: [{ kind: "increase", label: "加重", text: "杠铃平板卧推 建议加到 62.5 kg", basis: "2026-08-03 60kg×12×3" }],
      hasSignals: true,
    },
  });

  assert.equal(draft.periodStart, "2026-07-16");
  assert.equal(draft.periodEnd, "2026-08-05");
  assert.equal(draft.heading, "## 2026-07-16 ~ 2026-08-05");
  assert.match(draft.sectionMarkdown, /杠铃平板卧推 \| 60kg × 12次 3组 \| 2026-08-03/);
  assert.match(draft.sectionMarkdown, /引体向上 \| 自重 × 20次 \| 2026-08-03/);
  assert.match(draft.sectionMarkdown, /上斜卧推 \| （待填）/);
  assert.match(draft.sectionMarkdown, /体重：74\.5 kg（2026-08-01）/);
  assert.match(draft.sectionMarkdown, /腰围：82 cm（2026-08-01）/);
  assert.match(draft.sectionMarkdown, /（待填：客观睡眠/);
  assert.match(draft.sectionMarkdown, /哪天最累：（待填）/);
  assert.match(draft.sectionMarkdown, /依据：2026-08-03 60kg×12×3/);
  assert.doesNotMatch(draft.sectionMarkdown, /已进入平台期/);
});

test("buildTrainingReviewDraft does not invent sleep or body metrics", () => {
  const draft = buildTrainingReviewDraft({
    today: "2026-08-05",
    trainingVolume: { weekly: [], topSetSeries: [] },
    measurements: [],
    sleepMinutes: null,
    reviewModel: { conclusion: ["训练日志不足，暂无法生成周期结论。补几次完整组次后再看。"], items: [], hasSignals: false },
  });
  assert.match(draft.sectionMarkdown, /体重：（待填）/);
  assert.match(draft.sectionMarkdown, /腰围：（待填）/);
  assert.match(draft.sectionMarkdown, /（待填：客观睡眠/);
  assert.doesNotMatch(draft.sectionMarkdown, /\d+\.\d+ kg（/);
});

test("buildTrainingReviewWriteAction appends after anchor", () => {
  const existing = `# 训练复盘\n\n## 格式说明\n\n说明。\n\n${TRAINING_REVIEW_APPEND_ANCHOR}\n`;
  const draft = buildTrainingReviewDraft({
    today: "2026-08-05",
    reviewModel: { conclusion: ["ok"], items: [], hasSignals: true },
  });
  const action = buildTrainingReviewWriteAction(existing, draft);
  assert.equal(action.kind, "editFile");
  assert.equal(action.path, TRAINING_REVIEW_PATH);
  assert.equal(action.oldText, TRAINING_REVIEW_APPEND_ANCHOR);
  assert.ok(action.newText?.includes(draft.heading));
  assert.ok(action.newText?.startsWith(TRAINING_REVIEW_APPEND_ANCHOR));
});

test("buildTrainingReviewAppendAction is preview-ready editFile", () => {
  const draft = buildTrainingReviewDraft({
    today: "2026-08-05",
    reviewModel: { conclusion: ["ok"], items: [], hasSignals: true },
  });
  const action = buildTrainingReviewAppendAction(draft);
  assert.equal(action.path, TRAINING_REVIEW_PATH);
  assert.equal(action.oldText, TRAINING_REVIEW_APPEND_ANCHOR);
  assert.ok(action.newText?.includes("### 主项数字"));
  assert.ok(action.newText?.includes("### 主观"));
});

test("buildTrainingReviewWriteAction replaces same period heading instead of stacking", () => {
  const draft = buildTrainingReviewDraft({
    today: "2026-08-05",
    reviewModel: { conclusion: ["新结论"], items: [], hasSignals: true },
  });
  const existing = [
    "# 训练复盘",
    "",
    TRAINING_REVIEW_APPEND_ANCHOR,
    "",
    draft.heading,
    "",
    "### 主观",
    "",
    "- 旧内容",
    "",
    "## 2026-06-01 ~ 2026-06-21",
    "",
    "旧周期",
    "",
  ].join("\n");
  const action = buildTrainingReviewWriteAction(existing, draft);
  assert.equal(action.kind, "editFile");
  assert.ok(action.content);
  assert.equal(action.content.split(draft.heading).length - 1, 1);
  assert.match(action.content, /新结论/);
  assert.doesNotMatch(action.content, /旧内容/);
  assert.match(action.content, /## 2026-06-01 ~ 2026-06-21/);
});
