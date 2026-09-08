import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMonthlySelfAssessmentAppendAction,
  buildMonthlySelfAssessmentSection,
  buildMonthlySelfAssessmentWriteAction,
  LIFE_DESIGN_LOG_PATH,
  monthTailAnchor,
} from "../src/pages/monthly-self-assessment.ts";

test("buildMonthlySelfAssessmentSection keeps needs split and does not invent scores", () => {
  const section = buildMonthlySelfAssessmentSection("2026-08", ["阳台种植计划", "日语学习"]);
  assert.match(section, /### 月度自评/);
  assert.match(section, /不合成总分/);
  assert.match(section, /INFANS_MONTHLY_REVIEW:pending/);
  assert.match(section, /自主 \| （待填/);
  assert.match(section, /阳台种植计划/);
  assert.doesNotMatch(section, /综合分|总得分/);
  assert.ok(!/\| 总分 \|/.test(section));
});

test("buildMonthlySelfAssessmentAppendAction targets month tail anchor", () => {
  const action = buildMonthlySelfAssessmentAppendAction("2026-08", ["身心健康"]);
  assert.equal(action.kind, "editFile");
  assert.equal(action.path, LIFE_DESIGN_LOG_PATH);
  assert.equal(action.oldText, monthTailAnchor("2026-08"));
  assert.match(action.newText, /### 月度自评/);
  assert.ok(action.newText.includes(monthTailAnchor("2026-08")));
});

test("buildMonthlySelfAssessmentWriteAction inserts before month tail", () => {
  const existing = `## 2026-08

### 四格

| 格 | 油量 |
|---|---|
| 健康 | 90% |

### 在推进的事项

| 线 | 能量 | 处置 | 理由 |
|---|---|---|---|
| 阳台种植计划 | 耗能 | 多投入 | 主线 |

${monthTailAnchor("2026-08")}
`;
  const action = buildMonthlySelfAssessmentWriteAction(existing, "2026-08", ["阳台种植计划"]);
  assert.equal(action.kind, "editFile");
  assert.match(action.content, /### 月度自评[\s\S]*INFANS_MONTH_TAIL:2026-08/);
  assert.equal((action.content.match(/### 月度自评/g) || []).length, 1);
});

test("buildMonthlySelfAssessmentWriteAction replaces existing self-assessment", () => {
  const existing = `## 2026-08

### 月度自评

#### 三需要

| 需要 | 满足 | 受挫 |
|---|---|---|
| 自主 | 高 | 低 |

${monthTailAnchor("2026-08")}
`;
  const action = buildMonthlySelfAssessmentWriteAction(existing, "2026-08", ["日语学习"]);
  assert.match(action.content, /日语学习/);
  assert.equal((action.content.match(/### 月度自评/g) || []).length, 1);
  assert.doesNotMatch(action.content, /自主 \| 高/);
});
