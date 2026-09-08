import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseExplorationProgress,
  parseExplorationMistakes,
  suggestExamScope,
  startJapaneseExam,
  gradeJapaneseExam,
  commitExamEvidence,
  buildJapaneseExploration,
  parseMockAnalysisMarkdown,
  registerMockSnapshot,
} from "../src/server/workbench-japanese-exam.mjs";
import {
  clearanceRate,
  trackPartScore,
  explorationTotal,
  lvFromCorrectTotal,
  applyMasteryAnswer,
  assertMistakeSourcesAligned,
  grammarBaseFromMastery,
} from "../src/server/workbench-japanese-exploration-score.mjs";
import { composeMistakeQuiz, applyMistakeStreaks } from "../src/server/workbench-japanese-exam-modes.mjs";
import { scanWorkbenchSection } from "../src/server/workbench-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("探索进度解析：已验/未过写入节点档位", () => {
  const md = `## 2026-08-02 21:00 ｜ N2 ｜ grammar ｜ 2/3

- **已验**：N2-01, N2-03
- **未过**：N2-02（答 つもり）
- **依据**：测试
- **用时**：3.5 分钟
`;
  const { nodeTier, sessions } = parseExplorationProgress(md);
  assert.equal(nodeTier.get("N2:grammar:N2-01"), 2);
  assert.equal(nodeTier.get("N2:grammar:N2-02"), 1);
  assert.equal(sessions[0].correct, 2);
  assert.equal(sessions[0].total, 3);
  assert.equal(sessions[0].durationMinutes, 3.5);
});

test("错题集解析带 level/track/node", () => {
  const items = parseExplorationMistakes(`## 2026-08-02 21:00 ｜ N3 ｜ vocab ｜ N3-V-検討

- **错因**：选了错误义
`);
  assert.equal(items[0].level, "N3");
  assert.equal(items[0].track, "vocab");
  assert.equal(items[0].nodeId, "N3-V-検討");
});

test("建议范围默认专项而非 legacy", () => {
  const a = suggestExamScope({ level: "N4", kind: "special" });
  assert.equal(a.level, "N4");
  assert.equal(a.kind, "special");
  const b = suggestExamScope({});
  assert.equal(b.kind, "special");
  assert.equal(b.mode, "special");
});

test("专项出卷→交卷闭环（不落盘）", async () => {
  const section = await scanWorkbenchSection(root, "languages");
  const paper = await startJapaneseExam(root, section.data, { kind: "special", level: "N5", pointIds: [] }, { persistHistory: false });
  assert.equal(paper.kind, "special");
  assert.ok(paper.sessionId);
  assert.ok(paper.questions.some((item) => item.type === "mcq"));
  const answers = Object.fromEntries(
    paper.questions.filter((item) => item.type === "mcq").map((item) => [item.id, "不可能是这个答案___"]),
  );
  const graded = gradeJapaneseExam(paper.sessionId, answers);
  assert.equal(graded.total, paper.questionCount);
  assert.ok(graded.correct <= graded.total);
  assert.ok(graded.durationMinutes > 0);
  assert.match(graded.progressBlock, /\*\*用时\*\*/);
  assert.match(graded.progressBlock, /N5 ｜ special/);
});

test("专项交卷把时长与成绩回写进同一份会话 JSON", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jp-history-"));
  const section = await scanWorkbenchSection(root, "languages");
  const paper = await startJapaneseExam(root, section.data, { kind: "special", level: "N5", pointIds: [] }, { persistHistory: false });
  const answers = Object.fromEntries(paper.questions.filter((item) => item.type === "mcq").map((item) => [item.id, "___"]));
  const graded = gradeJapaneseExam(paper.sessionId, answers);
  await commitExamEvidence(tmp, graded);
  const historyDir = path.join(tmp, "55_语言学习/日语/练习记录与进度/专项题历史");
  const historyName = (await fs.readdir(historyDir)).find((name) => name.includes(paper.sessionId));
  const history = JSON.parse(await fs.readFile(path.join(historyDir, historyName), "utf8"));
  assert.equal(history.durationMinutes, graded.durationMinutes);
  assert.equal(history.result.correct, graded.correct);
  assert.equal(history.result.total, graded.total);
});

test("正式全卷和真题阅读都不可用", async () => {
  await assert.rejects(
    () => startJapaneseExam(root, {}, { kind: "formal", level: "N2" }),
    /开源版不含真题练习和真题阅读/,
  );
});

test("真题小测不再改走电子考场", async () => {
  await assert.rejects(
    () => startJapaneseExam(root, {}, { kind: "bank_quiz", level: "N2" }),
    /开源版不含真题练习和真题阅读/,
  );
});

test("专项按多级别随机抽卡", async () => {
  const paper = await startJapaneseExam(root, {}, { kind: "special", levels: ["N5", "N4"], level: "N5" }, { persistHistory: false });
  assert.equal(paper.kind, "special");
  assert.ok(paper.questionCount >= 1);
  assert.ok((paper.notes || []).some((note) => /N5|N4|随机/.test(note)));
});

test("错题卷不含 Anki 种子且无假干扰兜底", () => {
  const composed = composeMistakeQuiz({
    mistakes: [{ level: "N2", nodeId: "N2-01", body: "- **错因**：选了「甲」，正解「乙」" }],
    storedByNode: {},
    level: "N2",
  });
  assert.equal(composed.questions.length, 0);
  assert.equal(composed.meta.empty, true);
  assert.ok((composed.meta.notes || []).some((note) => /落盘原题|假干扰/.test(note)));
});

test("错题连续答对 2 次才出队", () => {
  let state = { items: {} };
  let step = applyMistakeStreaks(state, { level: "N2", track: "grammar", verifiedIds: [], missedIds: ["N2-V-a"], stamp: "t1" });
  state = step.state;
  assert.equal(state.items["N2:grammar:N2-V-a"].streak, 0);
  step = applyMistakeStreaks(state, { level: "N2", track: "grammar", verifiedIds: ["N2-V-a"], missedIds: [], stamp: "t2" });
  state = step.state;
  assert.equal(state.items["N2:grammar:N2-V-a"].streak, 1);
  assert.equal(step.cleared.length, 0);
  step = applyMistakeStreaks(state, { level: "N2", track: "grammar", verifiedIds: ["N2-V-a"], missedIds: [], stamp: "t3" });
  assert.equal(step.cleared[0], "N2-V-a");
  assert.equal(step.state.items["N2:grammar:N2-V-a"].status, "cleared");
});

test("探索公式边界：C 分母0→1；B=0→分项0；总分权重", () => {
  assert.equal(clearanceRate(0, 0), 1);
  assert.equal(clearanceRate(1, 1), 0.5);
  assert.equal(trackPartScore(0, 1), 0);
  assert.equal(trackPartScore(1, 1), 1);
  assert.equal(trackPartScore(1, 0), 0.7);
  assert.equal(explorationTotal(1, 1, 1), 1);
  assert.equal(explorationTotal(1, 0, 0), 0.4);
  assert.equal(lvFromCorrectTotal(4), 0);
  assert.equal(lvFromCorrectTotal(5), 1);
  assert.equal(lvFromCorrectTotal(14), 1);
  assert.equal(lvFromCorrectTotal(15), 2);
  assert.equal(lvFromCorrectTotal(34), 2);
  assert.equal(lvFromCorrectTotal(35), 3);
  const base = grammarBaseFromMastery(["a", "b", "c"], { a: { lv: 3 }, b: { lv: 0 }, c: { lv: 0 } });
  assert.ok(Math.abs(base - 1 / 3) < 1e-9);
});

test("掌握状态机累计答对升级且不因做错降级", () => {
  let items = {};
  for (let i = 0; i < 5; i += 1) items = applyMasteryAnswer(items, "N2-01", true);
  assert.equal(items["N2-01"].lv, 1);
  items = applyMasteryAnswer(items, "N2-01", false);
  assert.equal(items["N2-01"].lv, 1);
  assert.equal(items["N2-01"].correctTotal, 5);
  assert.equal(items["N2-01"].correctStreak, 0);
});

test("错题两源对账不变量", () => {
  assert.equal(assertMistakeSourcesAligned(0, 0), true);
  assert.equal(assertMistakeSourcesAligned(3, 2), false);
});

test("探索汇总含 V/G/M 分数且无旧三钮文案依赖", async () => {
  const section = await scanWorkbenchSection(root, "languages");
  const exploration = section.data.exploration || await buildJapaneseExploration(root, section.data);
  assert.equal(exploration.levels.length, 4);
  assert.ok(exploration.grammarDetail.N2);
  assert.ok(exploration.scores);
  assert.ok(typeof exploration.scores.total === "number");
  assert.ok(exploration.examModes?.every((mode) => !["review", "legacy"].includes(mode.kind)));
  assert.ok(exploration.examModes?.some((mode) => mode.kind === "special"));
  assert.ok(exploration.examModes?.some((mode) => mode.kind === "mistake"));
});

test("全卷分析解析与快照登记", async () => {
  const parsed = parseMockAnalysisMarkdown(`场次：2018-12
言語知識・読解用时：01:05:30 / 官方时限 01:45:00
聴解用时：42:30 / 官方参考 50:00
言語知識：40/60
読解：20/30
聴解：25/30
全卷原始正确率：85/120
`);
  assert.equal(parsed.sitting, "2018-12");
  assert.equal(parsed.correct, 85);
  assert.equal(parsed.total, 120);
  assert.equal(parsed.durationMinutes, 108);
  assert.ok(Math.abs(parsed.accuracy - 85 / 120) < 1e-9);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jp-mock-"));
  const snapRel = "55_语言学习/日语/练习记录与进度/探索全卷快照.json";
  await fs.mkdir(path.join(tmp, path.dirname(snapRel)), { recursive: true });
  const result = await registerMockSnapshot(tmp, parsed);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].durationMinutes, 108);
  assert.equal(result.sessions[0].correct, 85);
  assert.ok(result.mock.count === 1);
});

test("阅读库不再提供真题篇目", async () => {
  const { listReadingLibrary, loadJlptBankPool } = await import("../src/server/workbench-japanese-exam-modes.mjs");
  const lib = await listReadingLibrary("N2");
  assert.equal(lib.sittings.length, 0);
  assert.equal(lib.totalPassages, 0);
  const pool = await loadJlptBankPool("N2");
  assert.equal(pool.reading.length, 0);
  assert.equal(pool.contentRoot, "");
  assert.doesNotMatch(JSON.stringify(pool), /Sites\/jlpt-exam/);

  await assert.rejects(
    () => startJapaneseExam(root, {}, { kind: "reading", level: "N2" }, { persistHistory: false }),
    /开源版不含真题练习和真题阅读/,
  );
});

test("证据写入临时目录含错题状态", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jp-exam-"));
  const progressRel = "55_语言学习/日语/练习记录与进度/探索进度.md";
  const mistakeRel = "55_语言学习/日语/练习记录与进度/错题集.md";
  const stateRel = "55_语言学习/日语/练习记录与进度/错题状态.json";
  await fs.mkdir(path.join(tmp, path.dirname(progressRel)), { recursive: true });
  await fs.writeFile(path.join(tmp, progressRel), "# 探索进度\n\n（尚无正式全卷或专项摘要。）\n");
  await fs.writeFile(path.join(tmp, mistakeRel), "# 错题集\n\n（暂无活跃错题。）\n");
  const written = await commitExamEvidence(tmp, {
    level: "N5",
    track: "vocab",
    kind: "bank_quiz",
    progressBlock: "## 2026-08-02 22:00 ｜ N5 ｜ vocab ｜ 1/1\n\n- **已验**：N5-V-a\n- **未过**：—\n- **依据**：测试\n",
    mistakeBlocks: "## 2026-08-02 22:00 ｜ N5 ｜ vocab ｜ N5-V-b\n\n- **错因**：测\n",
    uniqueVerified: ["N5-V-a"],
    uniqueMissed: ["N5-V-b"],
    countsTowardExploration: true,
  });
  assert.ok(written.written.includes(progressRel));
  assert.ok(written.written.includes(stateRel));
  const text = await fs.readFile(path.join(tmp, progressRel), "utf8");
  assert.match(text, /N5 ｜ vocab/);
  const state = JSON.parse(await fs.readFile(path.join(tmp, stateRel), "utf8"));
  assert.equal(state.items["N5:vocab:N5-V-b"].status, "active");
});
