import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { groupFeaturePresentation, withFeaturePresentation } from "../src/product-feature-presentation.ts";
import { filterDisplayModeProductModules } from "../src/display-mode.ts";
import { parseProductFeatureIndex, parseProductFeatureTree, readProductFeatureTree } from "../src/server/workbench-product-features.mjs";
import { projectRecentHasFeature } from "../src/project-workbench-model.ts";

const CLIENT_DETAILS = `
### 客户端功能明细
#### 手机输入｜ID：native-ui-iphone-voice
- 定义与入口：在输入条切换录音。
- 操作与预期：逐字稿先回到草稿。
- 逐项检查：
  - T1：松开后等待转写。
  - T2：未发送前不应出现新消息。
- 当前证据／缺口：已知失败仍待修。
`;

const ORIGINAL = `# 原生模块
## 原生应用｜ID：native
> 原生入口。
| 小模块 | 状态 | 说明 | 功能点 | 当前进度 | 原件 | ID |
|---|---|---|---|---|---|---|
| 聊天总入口 | 测试中 | 原来已有的聊天能力。 | 草稿；重试 | 当前：待测 | 本模块 | native-chat-client |
### 功能明细
#### 聊天总入口｜ID：native-chat-client
- 保留原分类输入
`;
const PRESENTATION = `
### 客户端界面功能
| 界面功能 | 状态 | 说明 | 功能点 | 当前进度 | 原件 | ID | 关联功能 |
|---|---|---|---|---|---|---|---|
| 手机输入 | 测试中 | 新的界面说明。 | 按住说话；转写回填 | 当前：有待修问题 | 本模块 | native-ui-iphone-voice | native-chat-client |
| 会话列表 | 测试中 | 会话列表界面。 | 切换会话 | 当前：待测 | 本模块 | native-ui-iphone-threads | native-chat-client |
| 聊天总入口 | 测试中 | 当前交付说明。 | 状态可见 | 当前：未全验 | 本模块 | native-chat-client | native-chat-client |
### 设备展示分组
| 设备分组 | ID | 功能 ID |
|---|---|---|
| iPhone 客户端 | iphone | native-ui-iphone-voice,native-ui-iphone-threads |
| 跨端共用 | shared | native-chat-client |
`;

test("原生展示细项不改变既有功能数量、ID、归属或分类文本", () => {
  const old = parseProductFeatureTree(ORIGINAL);
  const next = parseProductFeatureTree(ORIGINAL + PRESENTATION);
  assert.deepEqual(next.modules[0].features, old.modules[0].features);
  assert.equal(next.modules[0].presentationFeatures.length, 3);
  assert.deepEqual(next.warnings, []);
  const projected = withFeaturePresentation(next.modules);
  assert.equal(projected[0].features.length, 3);
  assert.equal(projected[0].features[0].description, "当前交付说明。");
  assert.equal(next.modules[0].features[0].description, "原来已有的聊天能力。");
  const selected = projected[0].features.find((f) => f.id === "native-ui-iphone-voice");
  assert.equal(projectRecentHasFeature(next, { featureIds: ["native-chat-client"] }, selected.relatedFeatureId), true);
  assert.equal(projectRecentHasFeature(next, { featureIds: ["native-chat-client"] }, selected.id), false);
  const invalid = parseProductFeatureTree(ORIGINAL + PRESENTATION.replace("| native-ui-iphone-voice |", "| invalid id |"));
  assert.match(invalid.warnings.find((w) => w.code === "FEATURE_PRESENTATION_DETAIL_INVALID")?.message || "", /手机输入.*ID“invalid id”无效/u);
  const invalidStatus = parseProductFeatureTree(ORIGINAL + PRESENTATION.replace("| 手机输入 | 测试中 |", "| 手机输入 | 设计重审 |"));
  assert.match(invalidStatus.warnings.find((w) => w.code === "FEATURE_PRESENTATION_DETAIL_INVALID")?.message || "", /手机输入.*状态“设计重审”不支持/u);
});

test("客户端短摘要与完整定义分别解析，同名旧总项不被覆盖", () => {
  const baseline = parseProductFeatureTree(ORIGINAL + PRESENTATION);
  const parsed = parseProductFeatureTree(ORIGINAL + PRESENTATION + CLIENT_DETAILS);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.modules[0].features, baseline.modules[0].features);
  const voice = parsed.modules[0].presentationFeatures.find((item) => item.id === "native-ui-iphone-voice");
  assert.deepEqual(voice.summaryPoints, [
    { text: "按住说话", hiddenInDisplayMode: false },
    { text: "转写回填", hiddenInDisplayMode: false },
  ]);
  assert.equal(voice.points[0].text, "定义与入口：在输入条切换录音。");
  assert.deepEqual(voice.points[2].children.map((point) => point.text), ["T1：松开后等待转写。", "T2：未发送前不应出现新消息。"]);
  const projected = withFeaturePresentation(parsed.modules)[0].features.find((item) => item.id === voice.id);
  assert.deepEqual(projected.points, voice.points);
  assert.deepEqual(projected.summaryPoints, voice.summaryPoints);
  const undocumented = parsed.modules[0].presentationFeatures.find((item) => item.id === "native-ui-iphone-threads");
  assert.deepEqual(undocumented.points, undocumented.summaryPoints);
});

test("客户端明细的孤儿 ID、重复 ID 与名称漂移均有明确警告", () => {
  const orphan = parseProductFeatureTree(ORIGINAL + PRESENTATION + CLIENT_DETAILS.replace("native-ui-iphone-voice", "missing-client-feature"));
  assert.equal(orphan.warnings.some((item) => item.code === "FEATURE_PRESENTATION_DETAIL_ORPHAN"), true);
  const duplicate = parseProductFeatureTree(ORIGINAL + PRESENTATION + CLIENT_DETAILS + CLIENT_DETAILS);
  assert.equal(duplicate.warnings.some((item) => item.code === "FEATURE_DETAIL_DUPLICATE"), true);
  const renamed = parseProductFeatureTree(ORIGINAL + PRESENTATION + CLIENT_DETAILS.replace("手机输入｜", "不同名称｜"));
  assert.equal(renamed.warnings.some((item) => item.code === "FEATURE_DETAIL_NAME_MISMATCH"), true);
});

test("当前原生功能原件每项均有定义、独立检查编号和事实边界，摘要仍保持短句", async () => {
  const markdown = await fs.readFile(new URL("../../10_设计/20_模块/小秘书模块_原生应用.md", import.meta.url), "utf8");
  const parsed = parseProductFeatureTree(markdown);
  assert.deepEqual(parsed.warnings, []);
  const native = parsed.modules[0];
  const groupIds = native.featureGroups.flatMap((group) => group.memberIds).filter((id) => !["native-pet", "native-window", "native-fullscreen", "native-animation"].includes(id));
  assert.deepEqual(new Set(native.presentationFeatures.map((feature) => feature.id)), new Set(groupIds));
  for (const feature of native.presentationFeatures) {
    assert.match(feature.points[0].text, /^定义与入口：/u, feature.id);
    const checks = feature.points.find((point) => point.text === "逐项检查：");
    assert.ok(checks, `${feature.id} 缺少逐项检查`);
    assert.ok(checks.children.length >= 3, `${feature.id} 检查不足`);
    checks.children.forEach((point, index) => assert.ok(point.text.startsWith(`T${index + 1}：`), feature.id));
    assert.ok(feature.points.some((point) => /^当前(?:证据|实现).*缺口：/u.test(point.text)), `${feature.id} 缺少当前事实边界`);
    assert.ok(feature.points.some((point) => /^实现定位：/u.test(point.text)), `${feature.id} 缺少实现定位`);
    assert.ok(feature.summaryPoints.length, `${feature.id} 缺少前台短摘要`);
    assert.ok(feature.summaryPoints.every((point) => point.text.length <= 48 && !point.children?.length), feature.id);
  }
  const shared = new Set(native.presentationFeatures.map((feature) => feature.id));
  for (const id of ["native-ui-message-delivery", "native-ui-reply-stream", "native-ui-draft-recovery", "native-ui-history-navigation", "native-ui-action-confirmation"]) assert.ok(shared.has(id), id);
  assert.match(markdown, /待执行的检查方法，不是通过记录/u);
  assert.match(markdown, /PROVIDER 返回的分段不合法/u);
});

test("归组仅排序同一对象，缺失或重复引用不丢项也不重复计数", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const groups = [{ id: "group", name: "工作台", memberIds: ["b", "missing", "b"] }];
  const grouped = groupFeaturePresentation(items, groups);
  assert.deepEqual(grouped.flatMap((g) => g.items.map((i) => i.id)), ["b", "a", "c"]);
  assert.equal(grouped[0].items[0], items[1]);
  assert.deepEqual(items.map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(withFeaturePresentation([{ id: "old", features: items }])[0].features, items);
});

test("展示模式先过滤原生细项，再生成分组，不泄露隐藏组名或成员", () => {
  const tree = parseProductFeatureTree(ORIGINAL + PRESENTATION);
  const modules = filterDisplayModeProductModules(withFeaturePresentation(tree.modules));
  const groups = groupFeaturePresentation(modules[0].features, modules[0].featureGroups);
  assert.equal(groups.flatMap((g) => g.items).some((f) => f.id === "native-ui-iphone-threads"), true);
  assert.equal(modules[0].features.some((f) => f.id === "native-ui-iphone-voice"), true);
});

test("跨端显示分区不加入登记模块；非法成员有警告且未知模块保留", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-wiki-presentation-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const index = `# 产品功能树
| 模块 | ID | 说明 | 原件 |
|---|---|---|---|
| 原生应用 | native | 原生入口。 | [[native]] |

| 展示分区 | ID | 模块 ID |
|---|---|---|
| 原生应用 | wiki-native | native |
`;
  await fs.writeFile(path.join(root, "index.md"), index);
  await fs.writeFile(path.join(root, "native.md"), ORIGINAL + PRESENTATION);
  const parsed = await readProductFeatureTree(root, "index.md");
  assert.deepEqual(parsed.modules.map((m) => m.id), ["native"]);
  assert.equal(parsed.presentationGroups[0].id, "wiki-native");
  assert.deepEqual(parsed.warnings, []);
  const bad = parseProductFeatureIndex(index.replace("| native |\n", "| native,missing,native |\n"));
  assert.equal(bad.warnings.filter((w) => w.code === "FEATURE_PRESENTATION_MEMBER_INVALID").length, 2);
  await fs.writeFile(path.join(root, "native.md"), ORIGINAL + PRESENTATION.replaceAll("| native-chat-client |\n", "| missing-owner |\n"));
  assert.equal((await readProductFeatureTree(root, "index.md")).warnings.some((w) => w.code === "FEATURE_PRESENTATION_OWNER_MISSING"), true);
});

test("Wiki 使用展示投影，但任务关联和验收不使用展示 ID 冒充原功能", async () => {
  const source = await fs.readFile(new URL("../src/pages/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.match(source, /withFeaturePresentation\(tree\?\.modules/u);
  assert.match(source, /selectedFeature\?\.relatedFeatureId \|\| selectedFeature\?\.id/u);
  assert.match(source, /featureId=\{selectedRelatedFeatureId\}/u);
  assert.match(source, /!selectedFeature\.relatedFeatureId/u);
  assert.match(source, /groups=\{tree\.presentationGroups\}/u);
  assert.match(source, /selectedFeature\?\.summaryPoints\?\.length\s*\? selectedFeature\.summaryPoints/u);
  const usage = await fs.readFile(new URL("../src/server/workbench-agent-observability.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(usage, /withFeaturePresentation|presentationFeatures|presentationGroups/u);
});
