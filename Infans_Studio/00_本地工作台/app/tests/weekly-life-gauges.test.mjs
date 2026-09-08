import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { parseLifeDesignLog } from "../src/server/workbench-data.mjs";

test("人生设计校准按周日解析带状态的四格快照，并把最近一周放在最前", () => {
  const life = parseLifeDesignLog(`> **四格长期状态**：试运行
> **正式起点**：待本人明确认可

## 2026-08

### 四格

| 格 | 油量 |
|---|---:|
| 健康 | 66% |
| 工作 | 99% |
| 游戏 | 82% |
| 情感 | 68% |

### 周快照

| 截至周日 | 健康 | 工作 | 游戏 | 情感 | 状态 | 可信度 | 依据 |
|---|---:|---:|---:|---:|---|---|---|
| 2026-08-16 | 72% | 91% | 75% | 62% | 试运行参考 | 粗略 | 边界恢复 |
| 2026-08-23 | 68% | 96% | 78% | 65% | 正式 | 较高 | 周一封存 |
`);

  assert.deepEqual(life.weeklyGauges, [
    { weekEnding: "2026-08-23", health: 68, work: 96, play: 78, love: 65, status: "formal", confidence: "较高", basis: "周一封存" },
    { weekEnding: "2026-08-16", health: 72, work: 91, play: 75, love: 62, status: "trial", confidence: "粗略", basis: "边界恢复" },
  ]);
  assert.deepEqual(life.gaugeLifecycle, { status: "trial", formalFrom: null });
});

test("当前两份完整周快照存在可见变化，不会被同日当前值抵消", async () => {
  const markdown = await fs.readFile(
    new URL("../../../40_身心健康/平衡/人生设计校准.md", import.meta.url),
    "utf8",
  );
  const [current, previous] = parseLifeDesignLog(markdown).weeklyGauges;
  assert.deepEqual(
    {
      health: current.health - previous.health,
      work: current.work - previous.work,
      play: current.play - previous.play,
      love: current.love - previous.love,
    },
    { health: 0, work: 0, play: 0, love: 12 },
  );
});

test("平衡卡让油柱只表示当前值，并在数字旁显示有方向的周变化", async () => {
  const [source, styles, prompt] = await Promise.all([
    fs.readFile(new URL("../src/pages/LifePanel.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../../../40_身心健康/状态报告/身心日评_本机定时prompt.md", import.meta.url), "utf8"),
  ]);

  assert.match(source, /const current = weekly\[0\] \?\? latest/);
  assert.match(source, /const previous = weekly\[1\] \?\? null/);
  assert.match(source, /<Kicker>时间与精力投入<\/Kicker>/);
  assert.doesNotMatch(source, /comparisonLabel|最近把时间和精力主要投向哪里/);
  assert.doesNotMatch(source, /GaugeComparison|"monthly"/);
  assert.match(source, /className="life-gauge-reading"/);
  assert.match(source, /className=\{`life-gauge-delta/);
  assert.match(source, /`↑\$\{Math\.abs\(item\.change\)\}`/);
  assert.match(source, /`↓\$\{Math\.abs\(item\.change\)\}`/);
  assert.doesNotMatch(source, /life-gauge-shift/);
  assert.doesNotMatch(source, /stableValue/);
  assert.doesNotMatch(source, /life-gauge-surface/);
  assert.doesNotMatch(source, /gaugeLifecycle\?\.status !== "formal"/);
  assert.doesNotMatch(source, /TempBadge label="试运行"/);
  assert.doesNotMatch(source, /GaugeSparkline|life-gauge-spark/);
  assert.match(styles, /\.life-gauge-delta\.is-up/);
  assert.match(styles, /\.life-gauge-delta\.is-down/);
  assert.match(styles, /\.life-gauge-delta\.is-steady/);
  assert.doesNotMatch(styles, /\.life-gauge-shift/);
  assert.doesNotMatch(styles, /\.life-gauge-surface/);
  assert.match(styles, /\.health-life-panel\.is-full \.life-gauges-block \.life-gauges[^}]+grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/s);
  assert.match(styles, /\.life-gauges-block \.life-gauge \{ min-width:0; \}/);
  assert.doesNotMatch(styles, /\.life-gauge-spark/);
  assert.match(prompt, /待补窗口终点为星期日[\s\S]*最晚评估日是东京星期日/);
  assert.match(prompt, /不得从 GPT 空白推成下降/);
});
