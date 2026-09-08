import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyDailyVersion,
  bumpVersion,
  decideDailyVersion,
  parseHandoffLine,
  parsePendingChangeBlocks,
  validateVersionHandoffs,
} from "../scripts/workbench-version-core.mjs";

const INTRO = `---
description: test
---

# 更新日志

> 新记录写在最上方。

`;

const V114 = `## 2026-08-13 · V1.14.0 · 旧基线

- 已发布。
`;

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

test("parses compact version handoff fields", () => {
  const result = parseHandoffLine("- 版本交接：ID=home-todo｜状态=已验证｜运行=已启用｜建议=patch｜任务=首页待办限行｜证据=测试和390检查通过");
  assert.equal(result.id, "home-todo");
  assert.equal(result.status, "已验证");
  assert.equal(result.bump, "patch");
  assert.deepEqual(result.errors, []);
});

test("missing handoff blocks daily release", () => {
  const changelog = `${INTRO}## 2026-08-21 · feat · 新功能\n\n- 已写代码。\n\n${V114}`;
  const parsed = parsePendingChangeBlocks(changelog);
  const decision = decideDailyVersion(parsed.blocks);
  assert.equal(decision.state, "blocked");
  assert.match(decision.blockers[0], /缺少版本交接/);
});

test("enabled unfinished work blocks release while isolated work does not", () => {
  const enabled = `${INTRO}## 2026-08-21 · feat · 半成品\n\n- 版本交接：ID=wip｜状态=进行中｜运行=已启用｜建议=minor｜任务=半成品｜遗留=待验收\n\n${V114}`;
  assert.equal(decideDailyVersion(parsePendingChangeBlocks(enabled).blocks).state, "blocked");

  const isolated = enabled.replace("运行=已启用", "运行=已隔离");
  const decision = decideDailyVersion(parsePendingChangeBlocks(isolated).blocks);
  assert.equal(decision.state, "none");
  assert.equal(decision.unresolved.length, 1);
});

test("subjective acceptance does not block an evidenced technical baseline", () => {
  const changelog = `${INTRO}## 2026-08-21 · fix · 待本人看一眼\n\n- 版本交接：ID=visual｜状态=待验收｜运行=已启用｜建议=patch｜任务=已验证排版｜证据=专项、构建与真实页面通过｜遗留=等待本人确认观感\n\n${V114}`;
  const decision = decideDailyVersion(parsePendingChangeBlocks(changelog).blocks);
  assert.equal(decision.state, "ready");
  assert.equal(decision.level, "patch");
  assert.equal(decision.eligible.length, 1);
});

test("same stable ID is merged once and keeps the highest bump", () => {
  const changelog = `${INTRO}## 2026-08-22 · fix · 后续修复\n\n- 版本交接：ID=feature｜状态=已验收｜运行=已启用｜建议=patch｜任务=功能最终收口｜证据=真实页面通过\n\n## 2026-08-21 · feat · 功能首版\n\n- 版本交接：ID=feature｜状态=待验收｜运行=已启用｜建议=minor｜任务=功能首版｜证据=全量测试通过\n\n${V114}`;
  const decision = decideDailyVersion(parsePendingChangeBlocks(changelog).blocks);
  assert.equal(decision.state, "ready");
  assert.equal(decision.level, "minor");
  assert.equal(decision.eligible.length, 1);
  assert.equal(decision.eligible[0].records.length, 2);
});

test("one update heading can carry multiple stable task IDs", () => {
  const changelog = `${INTRO}## 2026-08-21 · feat · 工具组合\n\n- 版本交接：ID=tool-a｜状态=已验证｜运行=已启用｜建议=minor｜任务=工具A｜证据=专项通过\n- 版本交接：ID=tool-b｜状态=待验收｜运行=已启用｜建议=patch｜任务=工具B修复｜证据=构建与实页通过\n\n${V114}`;
  const parsed = parsePendingChangeBlocks(changelog);
  const decision = decideDailyVersion(parsed.blocks);
  assert.equal(parsed.blocks[0].handoffs.length, 2);
  assert.equal(decision.state, "ready");
  assert.equal(decision.eligible.length, 2);
});

test("minor wins once when a day has features and fixes", () => {
  const changelog = `${INTRO}## 2026-08-21 · feat · 新工具\n\n- 版本交接：ID=tool｜状态=已验证｜运行=已启用｜建议=minor｜任务=新增工具｜证据=全量测试通过\n\n## 2026-08-21 · fix · 修排版\n\n- 版本交接：ID=layout｜状态=已验证｜运行=已启用｜建议=patch｜任务=修复排版｜证据=390检查通过\n\n${V114}`;
  const decision = decideDailyVersion(parsePendingChangeBlocks(changelog).blocks);
  assert.equal(decision.state, "ready");
  assert.equal(decision.level, "minor");
  assert.equal(decision.eligible.length, 2);
});

test("release keeps isolated unfinished work above the new stable baseline", () => {
  const changelog = `${INTRO}## 2026-08-21 · feat · 以后再做\n\n- 版本交接：ID=later｜状态=进行中｜运行=已隔离｜建议=minor｜任务=以后再做｜遗留=待继续\n\n## 2026-08-21 · fix · 已完成修复\n\n- 版本交接：ID=fix｜状态=已验证｜运行=已启用｜建议=patch｜任务=已完成修复｜证据=测试通过\n\n${V114}`;
  const result = applyDailyVersion({
    packageText: '{"name":"test","version":"1.14.0"}\n',
    changelog,
    date: "2026-08-21",
  });
  assert.equal(result.version, "1.14.1");
  assert.ok(result.changelog.indexOf("以后再做") < result.changelog.indexOf("V1.14.1"));
  assert.ok(result.changelog.indexOf("V1.14.1") < result.changelog.indexOf("已完成修复"));
  assert.equal(JSON.parse(result.packageText).version, "1.14.1");
});

test("version arithmetic follows daily stable batch semantics", () => {
  assert.equal(bumpVersion("1.14.3", "minor"), "1.15.0");
  assert.equal(bumpVersion("1.14.3", "patch"), "1.14.4");
  assert.equal(bumpVersion("1.15.0", "minor"), "1.16.0");
  assert.equal(bumpVersion("1.15.0", "patch"), "1.15.1");
});

test("weekly release runtime prompt uses incremental gates and does not pretend GPT/Codex is automated", async () => {
  const promptPath = path.resolve(TEST_DIR, "../../10_设计/定时与自动化/小秘书每日版本收口_本机定时prompt.md");
  const prompt = await fs.readFile(promptPath, "utf8");
  assert.match(prompt, /当前正式版本之后至少有一项改动已经完成客观闭环/);
  assert.match(prompt, /已知且与本批无关的失败继续保留修复任务和真实计数，但不冻结/);
  assert.match(prompt, /缺少此前指纹、独立修复任务或影响范围证据时仍应阻塞/);
  assert.match(prompt, /1\.15\.0 → 1\.16\.0/);
  assert.match(prompt, /每周一/);
  assert.match(prompt, /不得把 GPT／Codex 语义收拢写成已经自动启动/);
  assert.doesNotMatch(prompt, /任何一步失败都不升版/);
});

test("已验证但隔离的候选暂缓，保留证据位置且不阻塞已启用修复", () => {
  const isolated = `## 2026-09-05 · feat · 隔离\n\n- 版本交接：ID=later｜状态=已验证｜运行=已隔离｜建议=minor｜任务=隔离功能\n\n`;
  const ready = `## 2026-09-05 · fix · 完成\n\n- 版本交接：ID=now｜状态=已验证｜运行=已启用｜建议=patch｜任务=完成｜证据=专项通过\n\n`;
  const result = applyDailyVersion({ packageText: '{"version":"1.14.0"}', changelog: INTRO + isolated + ready + V114, date: "2026-09-07" });
  assert.equal(result.version, "1.14.1");
  assert.ok(result.changelog.indexOf("ID=later") < result.changelog.indexOf("V1.14.1"));
  assert.equal(decideDailyVersion(parsePendingChangeBlocks(result.changelog).blocks).state, "none");
});

test("同一归属周跨日期也不能重复升版，旧历史无需补标记", () => {
  const entry = (id) => `## 2026-09-07 · fix · ${id}\n\n- 版本交接：ID=${id}｜状态=已验证｜运行=已启用｜建议=patch｜任务=${id}｜证据=专项通过\n\n`;
  const first = applyDailyVersion({ packageText: '{"version":"1.14.0"}', changelog: INTRO + entry("a") + V114, date: "2026-09-07" });
  assert.throws(() => applyDailyVersion({ packageText: first.packageText, changelog: entry("b") + first.changelog, date: "2026-09-08" }), /归属周/);
  assert.equal(applyDailyVersion({ packageText: first.packageText, changelog: entry("b") + first.changelog, date: "2026-09-14" }).version, "1.14.2");
});

test("施工校验发现新增缺交接和非法字段，但不重复拦截未改的旧错误", () => {
  const old = `## 2026-09-04 · fix · 旧条目\n\n- 版本交接：ID=old｜状态=旧错误｜运行=已启用｜建议=patch｜任务=旧条目\n\n`;
  const fresh = `## 2026-09-05 · fix · 新条目\n\n- 版本交接：ID=new｜状态=已验证、已启用｜运行=已启用｜建议=patch｜任务=新条目｜证据=测试\n\n`;
  assert.equal(validateVersionHandoffs(old + V114, { baseline: old + V114 }).errors.length, 0);
  assert.equal(validateVersionHandoffs(fresh + old + V114, { baseline: old + V114 }).errors.length, 1);
  assert.match(validateVersionHandoffs(`## 2026-09-05 · fix · 漏写\n\n正文\n\n` + old + V114, { baseline: old + V114 }).errors[0], /缺少版本交接/);
  assert.match(validateVersionHandoffs(old + V114, { taskId: "missing" }).errors[0], /未找到/);
  assert.equal(validateVersionHandoffs(fresh.replace("已验证、已启用", "已验证") + old + V114, { taskId: "new" }).errors.length, 0);
});

test("the same log date cannot create a second formal version", () => {
  const changelog = `${INTRO}## 2026-08-21 · fix · 第二次修复\n\n- 版本交接：ID=second｜状态=已验证｜运行=已启用｜建议=patch｜任务=第二次修复｜证据=测试通过\n\n## 2026-08-21 · V1.14.1 · 今日已有版本\n\n- 已发布。\n`;
  assert.throws(() => applyDailyVersion({
    packageText: '{"name":"test","version":"1.14.1"}\n',
    changelog,
    date: "2026-08-21",
  }), /最多升版一次/);
});

test("policy start marker leaves older unversioned history outside the daily queue", () => {
  const changelog = `${INTRO}## 2026-08-21 · fix · 新规则后的修复\n\n- 版本交接：ID=new｜状态=已验证｜运行=已启用｜建议=patch｜任务=新规则后的修复｜证据=测试通过\n\n<!-- WORKBENCH_DAILY_VERSION_START -->\n\n## 2026-08-20 · feat · 历史功能\n\n- 当时没有交接。\n\n${V114}`;
  const parsed = parsePendingChangeBlocks(changelog);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].title, "新规则后的修复");
  assert.match(parsed.rest, /历史功能/);
});
