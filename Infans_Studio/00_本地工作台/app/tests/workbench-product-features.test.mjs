import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseProductFeatureIndex, parseProductFeatureTree, readProductFeatureTree } from "../src/server/workbench-product-features.mjs";

const SAMPLE = `# 测试产品 · 产品功能树

> 当前能力地图。

## 项目管理｜ID：project-management

> 管理项目与任务。

| 功能 | 状态 | 说明 | 功能点 | 当前进度 | 原件 | ID |
|---|---|---|---|---|---|---|
| 项目总览 | 稳定 | 查看全部项目。 | 活跃项目；🔒 归档项目；稳定入口 | — | [[设计稿]] | project-overview |
| 模块功能视图 | 等待验收 | 用 Wiki 树看功能。 | 模块折叠；状态提示；详情切换 | 完成：信息结构；当前：等待验收；下一步：推广模板 | [[功能树]] | feature-tree |
`;

test("产品功能树读取模块、稳定功能、新功能进度和原件", () => {
  const parsed = parseProductFeatureTree(SAMPLE, { sourcePath: "功能树.md" });
  assert.equal(parsed.title, "测试产品 · 产品功能树");
  assert.equal(parsed.modules[0].id, "project-management");
  assert.equal(parsed.modules[0].features[0].status, "稳定");
  assert.deepEqual(parsed.modules[0].features[0].points, [
    { text: "活跃项目", hiddenInDisplayMode: false },
    { text: "归档项目", hiddenInDisplayMode: true },
    { text: "稳定入口", hiddenInDisplayMode: false },
  ]);
  assert.deepEqual(parsed.modules[0].features[1].progress.map((item) => item.kind), ["done", "current", "next"]);
  assert.equal(parsed.modules[0].features[1].source.path, "功能树.md");
  assert.equal(parsed.warnings.length, 0);
});

test("复杂小模块同时保留前台平铺摘要和后台多层功能明细", () => {
  const parsed = parseProductFeatureTree(`${SAMPLE}
### 功能明细

#### 模块功能视图｜ID：feature-tree

- 功能导航
  - 展开大模块
  - 选择小模块
- 状态提示
  - 稳定功能不挂标签
  - 待推进功能显示状态
    - 单项显示状态名
    - 多项显示数量
- 🔒 内部维护信息
  - 原件检查警告
`);
  assert.deepEqual(parsed.modules[0].features[1].points, [
    {
      text: "功能导航",
      hiddenInDisplayMode: false,
      children: [
        { text: "展开大模块", hiddenInDisplayMode: false, children: [] },
        { text: "选择小模块", hiddenInDisplayMode: false, children: [] },
      ],
    },
    {
      text: "状态提示",
      hiddenInDisplayMode: false,
      children: [
        { text: "稳定功能不挂标签", hiddenInDisplayMode: false, children: [] },
        {
          text: "待推进功能显示状态",
          hiddenInDisplayMode: false,
          children: [
            { text: "单项显示状态名", hiddenInDisplayMode: false, children: [] },
            { text: "多项显示数量", hiddenInDisplayMode: false, children: [] },
          ],
        },
      ],
    },
    {
      text: "内部维护信息",
      hiddenInDisplayMode: true,
      children: [{ text: "原件检查警告", hiddenInDisplayMode: false, children: [] }],
    },
  ]);
  assert.deepEqual(parsed.modules[0].features[1].summaryPoints, [
    { text: "模块折叠", hiddenInDisplayMode: false },
    { text: "状态提示", hiddenInDisplayMode: false },
    { text: "详情切换", hiddenInDisplayMode: false },
  ]);
  assert.equal(parsed.warnings.length, 0);
});

test("多层功能明细引用不存在的小模块时给出警告", () => {
  const parsed = parseProductFeatureTree(`${SAMPLE}\n### 功能明细\n\n#### 不存在｜ID：missing-feature\n\n- 无法关联\n`);
  assert.equal(parsed.warnings.some((item) => item.code === "FEATURE_DETAIL_ORPHAN"), true);
});

test("前台功能点超过 48 个字符时要求移入功能明细", () => {
  const parsed = parseProductFeatureTree(SAMPLE.replace("模块折叠；状态提示；详情切换", `${"过长功能说明".repeat(9)}；状态提示`));
  assert.equal(parsed.warnings.some((item) => item.code === "FEATURE_SUMMARY_POINT_TOO_LONG" && item.featureId === "feature-tree"), true);
});

test("功能树对非标准表头、重复 ID 与异常状态给出明确警告", () => {
  const parsed = parseProductFeatureTree(SAMPLE
    .replace("功能点 | 当前进度", "现行能力 | 当前进度")
    .replace("| 项目总览 | 稳定", "| 项目总览 | 不知道")
    .replace("| feature-tree |", "| project-overview |"));
  const codes = new Set(parsed.warnings.map((item) => item.code));
  assert.equal(codes.has("FEATURE_COLUMNS_INVALID"), true);
  assert.equal(codes.has("FEATURE_STATUS_INVALID"), true);
  assert.equal(codes.has("FEATURE_ID_DUPLICATE"), true);
});

test("功能树读取限制在 Vault 根内且缺文件局部降级", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-feature-tree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "功能树.md"), SAMPLE);
  assert.equal((await readProductFeatureTree(root, "功能树.md"))?.modules.length, 1);
  assert.equal(await readProductFeatureTree(root, "不存在.md"), null);
  await assert.rejects(() => readProductFeatureTree(root, "../越界.md"), /FEATURE_TREE_PATH_OUTSIDE_VAULT/u);
});

test("模块登记表从各模块原件组装功能树，并把本模块解析为当前原件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-feature-modules-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "模块"));
  const index = `# 测试产品 · 产品功能树

> 只负责登记模块原件。

| 模块 | ID | 说明 | 原件 |
|---|---|---|---|
| 首页 | home | 每日入口。 | [[模块/首页模块]] |
| 对话 | assistant | 单人与来访。 | [[模块/对话模块]] |
`;
  const home = `# 首页模块

## 首页｜ID：home

> 每日入口。

| 小模块 | 状态 | 说明 | 功能点 | 当前进度 | 原件 | ID |
|---|---|---|---|---|---|---|
| 今日摘要 | 稳定 | 查看重点。 | 日期；待处理数量 | — | 本模块 | home-summary |
`;
  const assistant = `# 对话模块

## 对话｜ID：assistant

> 单人与来访。

| 功能 | 状态 | 说明 | 功能点 | 当前进度 | 原件 | ID |
|---|---|---|---|---|---|---|
| 单人对话 | 稳定 | 继续会话。 | 上下文问答；会话续接 | — | 本模块 | assistant-chat |
`;
  await fs.writeFile(path.join(root, "功能树.md"), index);
  await fs.writeFile(path.join(root, "模块/首页模块.md"), home);
  await fs.writeFile(path.join(root, "模块/对话模块.md"), assistant);

  const parsedIndex = parseProductFeatureIndex(index, { sourcePath: "功能树.md" });
  assert.deepEqual(parsedIndex.moduleRefs.map((item) => item.id), ["home", "assistant"]);
  const parsed = await readProductFeatureTree(root, "功能树.md");
  assert.deepEqual(parsed.modules.map((item) => [item.id, item.features.length]), [["home", 1], ["assistant", 1]]);
  assert.deepEqual(parsed.modules[1].features[0].points, [
    { text: "上下文问答", hiddenInDisplayMode: false },
    { text: "会话续接", hiddenInDisplayMode: false },
  ]);
  assert.equal(parsed.modules[0].features[0].source.path, "模块/首页模块.md");
  assert.equal(parsed.warnings.length, 0);
});

test("模块登记表缺少原件时保留模块并给出局部警告", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-feature-module-missing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "功能树.md"), `# 测试产品\n\n| 模块 | ID | 说明 | 原件 |\n|---|---|---|---|\n| 首页 | home | 每日入口。 | [[模块/不存在]] |\n`);
  const parsed = await readProductFeatureTree(root, "功能树.md");
  assert.equal(parsed.modules[0].id, "home");
  assert.equal(parsed.modules[0].features.length, 0);
  assert.equal(parsed.warnings.some((item) => item.code === "FEATURE_MODULE_FILE_MISSING"), true);
});
