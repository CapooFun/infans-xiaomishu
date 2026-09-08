import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  domainResearchProgressPath,
  normalizeDomainResearchProgress,
  readDomainResearchProgress,
  writeDomainResearchProgress,
} from "../src/server/workbench-domain-research-progress.mjs";
import { branchResearchStatusFromFormalNodes, buildKnowledgeCards, buildKnowledgeExplainSeed, learningLevelLabel, orderKnowledgeNodesByTopics } from "../src/pages/topics/domain-research-cards.ts";
import { parseDomainKnowledgeCatalog, parseDomainKnowledgeNode, parseDomainLearningRecord, parseDomainLearningResourceCatalog, readDomainKnowledgeNodes } from "../src/server/workbench-domain-research-content.mjs";
import { RESEARCH_DOMAIN_IDS } from "../src/pages/topics/domain-research-home.ts";

const position = {
  domainId: "game",
  branchId: "culture",
  nodeId: "culture-01",
  cardId: "culture-01-overview",
  cardIndex: 0,
};

function assertFirstLookExplainsBeforeSolving(node) {
  const text = node.cards[0].paragraphs.join("");
  assert.ok(text.length >= 180, `${node.nodeId} 的首卡仍然太薄`);
  assert.match(text, /这是什么：/u, `${node.nodeId} 的首卡没有先解释对象`);
  assert.match(text, /例子：/u, `${node.nodeId} 的首卡没有给出可识别案例`);
  assert.match(text, /什么时候会遇到：/u, `${node.nodeId} 的首卡没有说明使用场景`);
}

test("领域研究进度缺失时只读返回空，不创建文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-domain-progress-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readDomainResearchProgress(root), {
    schemaVersion: 1,
    cards: {},
    choices: {},
    lastPosition: null,
    lastPositions: {},
    recentCardIds: [],
  });
  assert.equal(await fs.access(domainResearchProgressPath(root)).then(() => true, () => false), false);
});

test("单点状态、判断选择和浏览位置以 0600 原子文件保存", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-domain-progress-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixed = new Date("2026-08-23T15:00:00.000Z");
  await writeDomainResearchProgress(root, { cardId: position.cardId, status: "unclear", position }, { now: () => fixed });
  const next = await writeDomainResearchProgress(root, { cardId: position.cardId, status: "overview", choiceId: "conditions", position }, { now: () => fixed });
  assert.equal(next.cards[position.cardId].status, "overview");
  assert.equal(next.choices[position.cardId].choiceId, "conditions");
  assert.deepEqual(next.recentCardIds, [position.cardId]);
  assert.equal(next.lastPosition.cardId, position.cardId);
  assert.equal(next.lastPositions.game.cardId, position.cardId);
  assert.equal((await fs.stat(domainResearchProgressPath(root))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(domainResearchProgressPath(root)))).filter((name) => name.endsWith(".infans-tmp")), []);
  await assert.rejects(() => writeDomainResearchProgress(root, { cardId: "../bad", status: "deep", position }), /编号不正确/u);
});

test("纯纲目和无来源草稿不再生成占位知识卡", () => {
  const branch = {
    id: "culture",
    title: "游戏史、文化与作品",
    summary: "理解游戏怎样形成意义。",
    guidingQuestion: "游戏为何变成现在的样子？",
    starterQuestions: ["历史位置由什么决定？"],
  };
  const node = { title: "游戏史与媒介演化", description: "理解不同时代的变化。" };
  assert.deepEqual(buildKnowledgeCards(branch, node, 0), []);
  assert.deepEqual(buildKnowledgeCards(branch, { ...node, status: "formal", authoredCards: [{ id: "draft-card", kind: "authored", eyebrow: "草稿", title: "草稿", paragraphs: ["没有来源。"] }] }, 0), []);
});

test("正式节点只使用 Markdown 派生卡，稳定 ID 不随目录位置改变", () => {
  const branch = { id: "design", title: "游戏设计与体验", summary: "", guidingQuestion: "", starterQuestions: [] };
  const authoredCards = [{ id: "game-design-example-first-look", kind: "authored", eyebrow: "一眼先懂", title: "线索怎样引导探索", paragraphs: ["这是来源支撑的正文。"] }];
  const node = {
    id: "game-design-example",
    status: "formal",
    title: "线索怎样引导探索",
    description: "",
    sources: [{ id: "source-one", title: "来源", kind: "primary", role: "fact", locator: "", url: "https://example.com" }],
    authoredCards,
  };
  const cards = buildKnowledgeCards(branch, node, 99);
  assert.deepEqual(cards, authoredCards);
  assert.doesNotMatch(cards[0].paragraphs.join(""), /熟悉的游戏|真实开发经历|先不要急着背术语/u);
  const seed = buildKnowledgeExplainSeed("游戏", branch.title, node.title, cards[0]);
  assert.match(seed, /游戏设计与体验 \/ 线索怎样引导探索/u);
  assert.match(seed, /详细但好懂/u);
  assert.match(seed, /文字或语音追问/u);
});

test("正式节点阅读顺序先服从专题目录，再服从专题内 order，稳定 ID 不变", () => {
  const source = [
    { topicId: "topic-b", order: 10, nodeId: "b-first" },
    { topicId: "topic-a", order: 20, nodeId: "a-second" },
    { topicId: "topic-a", order: 10, nodeId: "a-first" },
    { topicId: "topic-b", order: 20, nodeId: "b-second" },
  ];
  assert.deepEqual(orderKnowledgeNodesByTopics(source, ["topic-a", "topic-b"]).map((node) => node.nodeId), [
    "a-first",
    "a-second",
    "b-first",
    "b-second",
  ]);
  assert.deepEqual(source.map((node) => node.nodeId), ["b-first", "a-second", "a-first", "b-second"]);
});

test("正式节点解析要求稳定 ID、逐节点来源并保留垂直学习资源", () => {
  const valid = `---\ndescription: 样板\ntags: [领域研究]\ntype: domain-knowledge-node\ndomainId: game\nbranchId: design\ntopicId: design-03\nnodeId: game-design-sample\nstatus: formal\norder: 10\nasOf: 2026-08-25\njurisdiction: global\nsources:\n  - id: source-one\n    title: 一手来源\n    kind: primary\n    url: https://example.com/source\n    role: fact\nlearningResources:\n  - id: classic-talk\n    title: 经典演讲\n    kind: talk\n    level: core\n    reason: 直接听开发者解释这个问题。\n    focus: 规则怎样变成体验？\n    creator: 示例作者\n    duration: 45 分钟\n    language: 英语\n    access: free\n    url: https://example.com/talk\n    use: 先看案例部分。\n    asOf: 2026-08-25\n---\n# 样板节点\n\n## 一眼先懂 {#first-look}\n\n这是第一张正文。\n\n## 继续学习 {#learning-path}\n\n这是第二张正文。`;
  const node = parseDomainKnowledgeNode(valid, "sample.md");
  assert.equal(node.nodeId, "game-design-sample");
  assert.deepEqual(node.cards.map((card) => card.id), ["game-design-sample-first-look", "game-design-sample-learning-path"]);
  assert.equal(node.learningResources[0].title, "经典演讲");
  assert.equal(node.learningResources[0].duration, "45 分钟");
  assert.throws(() => parseDomainKnowledgeNode(valid.replace(/sources:[\s\S]+?---\n# /u, "sources: []\n---\n# "), "bad.md"), /formal 节点必须有来源/u);
});

test("人工智能目录可以批量登记诚实的 outline 节点，不生成正文卡", () => {
  const catalog = `---\ndescription: AI 目录\ntags: [人工智能]\ntype: domain-knowledge-catalog\ndomainId: ai\nasOf: 2026-08-26\n---\n# AI\n\n| branchId | topicId | nodeId | order | 节点标题 | 单次认知任务 |\n|---|---|---|---:|---|---|\n| ai-search-planning | ai-search-planning-01 | ai-search-sample | 10 | A 星搜索 | 走完一次开放表与关闭表更新。 |`;
  const nodes = parseDomainKnowledgeCatalog(catalog, "ai-catalog.md");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].status, "outline");
  assert.equal(nodes[0].nodeId, "ai-search-sample");
  assert.deepEqual(nodes[0].cards, []);
});

test("学习记录保留稳定节点、对话来源与诚实学习状态", () => {
  const record = parseDomainLearningRecord(`---
description: 第一次学习记录
date: 2026-08-27
type: domain-learning-record
domainId: ai
nodeId: ai-representation-tokenization
recordId: learn-20260827-ai-representation-tokenization-test
learningState: session-recorded
sourceConversationId: conversation-token-test
reviewedBy: codex
acceptedByCapoo: false
---
# Token 化 · 第一次学习记录

> 只完成一次真实会话，不等于掌握。

## 下一次从哪里继续

用中英文切分案例说明离散表示。`, "token-record.md");
  assert.equal(record?.nodeId, "ai-representation-tokenization");
  assert.equal(record?.learningState, "session-recorded");
  assert.equal(record?.sourceConversationId, "conversation-token-test");
  assert.match(record?.nextStep ?? "", /中英文切分/u);
  assert.throws(() => parseDomainLearningRecord(`---
description: 错误状态
date: 2026-08-27
type: domain-learning-record
domainId: ai
nodeId: ai-representation-tokenization
recordId: bad-record
learningState: mastered
sourceConversationId: bad-conversation
---
# 错误记录`, "bad-record.md"), /learningState 不在允许状态中/u);
});

test("纲目节点自动挂接学习记录，并拒绝同一对话重复接票与未知节点", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-domain-learning-records-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nodeDirectory = path.join(root, "70_专题研究/人工智能/知识节点");
  const recordDirectory = path.join(root, "70_专题研究/人工智能/学习记录");
  await fs.mkdir(nodeDirectory, { recursive: true });
  await fs.mkdir(recordDirectory, { recursive: true });
  await fs.writeFile(path.join(nodeDirectory, "catalog.md"), `---
type: domain-knowledge-catalog
domainId: ai
asOf: 2026-08-27
---
# AI

| branchId | topicId | nodeId | order | 节点标题 | 单次认知任务 |
|---|---|---|---:|---|---|
| ai-learning-generative | ai-learning-generative-02 | ai-representation-tokenization | 10 | Token 化 | 说明离散表示。 |`, "utf8");
  const record = (recordId, nodeId, conversationId) => `---
description: Token 学习记录
date: 2026-08-27
type: domain-learning-record
domainId: ai
nodeId: ${nodeId}
recordId: ${recordId}
learningState: session-recorded
sourceConversationId: ${conversationId}
reviewedBy: codex
acceptedByCapoo: false
---
# Token 化 · 学习记录

> 只登记真实会话。`;
  await fs.writeFile(path.join(recordDirectory, "01.md"), record("learn-token-01", "ai-representation-tokenization", "conversation-token"), "utf8");
  await fs.writeFile(path.join(recordDirectory, "02.md"), record("learn-token-02", "ai-representation-tokenization", "conversation-token"), "utf8");
  await fs.writeFile(path.join(recordDirectory, "03.md"), record("learn-unknown-01", "ai-unknown-node", "conversation-unknown"), "utf8");
  const { nodes, warnings } = await readDomainKnowledgeNodes(root);
  const token = nodes.find((node) => node.nodeId === "ai-representation-tokenization");
  assert.equal(token?.status, "outline");
  assert.deepEqual(token?.cards, []);
  assert.equal(token?.learningState, "session-recorded");
  assert.deepEqual(token?.learningRecords.map((item) => item.recordId), ["learn-token-01"]);
  assert.ok(warnings.some((warning) => warning.message.includes("同一对话与节点已有学习记录")));
  assert.ok(warnings.some((warning) => warning.message.includes("学习记录没有对应知识节点：ai-unknown-node")));
});

test("关键材料目录按稳定 nodeId 挂回纲目节点而不伪造正文", () => {
  const catalog = `---
type: domain-learning-resource-catalog
domainId: ai
---
# 材料

## 2. A* 原论文

对应 \`ai-search-a-star-open-closed\`。

- **中文标题／原文标题**：最小代价路径的启发式确定
- **作者或机构**：Hart、Nilsson、Raphael；IEEE
- **类型与原始语言**：开山论文；英语
- **主要讲什么**：正式给出启发式搜索框架。
- **为什么在这个节点**：不能只背公式，需要理解正确性条件。
- **重点看什么**：节点选择与启发式条件怎样共同支持结论。
- **建议投入时间**：45—75 分钟选读。
- **访问条件**：DOI 页面，全文可能需要机构访问。
- **核验日期**：2026-08-27
- **原始来源链接**：<https://doi.org/10.1109/TSSC.1968.300136>`;
  const mappings = parseDomainLearningResourceCatalog(catalog, "sample.md");
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].nodeId, "ai-search-a-star-open-closed");
  assert.equal(mappings[0].resource.access, "mixed");
  assert.match(mappings[0].resource.reason, /不能只背公式/u);
});

test("人工智能 185 个稳定节点都有可点读正文、来源与关键材料", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const ai = nodes.filter((node) => node.domainId === "ai");
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/人工智能/知识节点")), []);
  assert.equal(ai.length, 185);
  assert.equal(new Set(ai.map((node) => node.branchId)).size, 9);
  assert.equal(new Set(ai.map((node) => node.topicId)).size, 65);
  assert.equal(new Set(ai.map((node) => node.nodeId)).size, ai.length);
  assert.equal(ai.filter((node) => node.learningResources.length > 0).length, 185);
  assert.equal(ai.filter((node) => node.status === "outline").length, 0);
  for (const legacyTopicId of [
    "ai-history-math-01", "ai-history-math-04", "ai-search-planning-04", "ai-knowledge-reasoning-04",
    "ai-learning-generative-05", "ai-multimodal-05", "ai-agents-robotics-06", "ai-engineering-05",
    "ai-products-05", "ai-society-05",
  ]) assert.ok(ai.some((node) => node.topicId === legacyTopicId), `旧专题 ID 未保留：${legacyTopicId}`);
  const formal = ai.filter((node) => node.status === "formal");
  assert.equal(formal.length, 185);
  for (const branchId of new Set(ai.map((node) => node.branchId))) {
    assert.equal(
      branchResearchStatusFromFormalNodes(formal.filter((node) => node.branchId === branchId).length),
      "正在理解",
    );
  }
  for (const requiredNodeId of [
    "ai-ml-linear-regression-assumptions", "ai-ml-logistic-regression-probability-boundary",
    "ai-ml-decision-tree-split-pruning", "ai-ml-bagging-random-forest", "ai-ml-boosting-sequential-errors",
    "ai-ml-svm-margin-support-vectors", "ai-ml-kernel-implicit-feature-space",
    "ai-ml-empirical-risk-generalization-error", "ai-ml-bias-variance-regularization-selection",
    "ai-ml-cross-validation-metrics-calibration", "ai-ml-feature-preprocessing-leakage-pipeline",
    "ai-krr-expert-system-architecture", "ai-nlp-sequence-labeling-parsing",
    "ai-vision-image-formation-geometry", "ai-speech-speaker-verification-diarization",
    "ai-robot-kinematics-dynamics",
  ]) assert.ok(ai.some((node) => node.nodeId === requiredNodeId), `基础节点缺失：${requiredNodeId}`);
  formal.forEach(assertFirstLookExplainsBeforeSolving);
  assert.ok(formal.every((node) => node.learningResources.length >= 1));
  assert.ok(formal.every((node) => node.sources.length >= 2));
  assert.ok(formal.every((node) => node.sources.every((source) =>
    source.locator && !/定义、算法目标或实验设定|比较、局限或评测条件|原始定义、方法或历史语境|统一教材解释/u.test(source.locator)
  )));
  assert.ok(formal.every((node) => node.learningResources.every((resource) =>
    resource.creator && !/原始发布机构|原作者或研究机构|原始出版方/u.test(resource.creator)
  )));
  assert.ok(formal.every((node) => node.learningResources.every((resource) =>
    !/它把本节点放回可检查的输入、机制和输出链|记录可见信息和中间表示；区分可证明结论|先读原始定义和关键图表，再回到本节点案例/u.test(`${resource.reason} ${resource.focus} ${resource.use}`)
  )));
  for (const field of ["reason", "focus", "use"]) {
    const fieldOwners = new Map();
    for (const node of formal) {
      for (const resource of node.learningResources) {
        const owners = fieldOwners.get(resource[field]) ?? new Set();
        owners.add(node.nodeId);
        fieldOwners.set(resource[field], owners);
      }
    }
    assert.deepEqual(
      [...fieldOwners.entries()].filter(([, owners]) => owners.size >= 3).map(([value, owners]) => ({ field, value, nodes: [...owners] })),
      [],
      `关键材料的 ${field} 出现跨节点批量复用`,
    );
  }
  assert.ok(formal.filter((node) => node.nodeId !== "ai-representation-tokenization").every((node) => node.cards.length >= 7));
  assert.ok(formal.every((node) => node.cards[0].paragraphs.length === 3));
  assert.ok(formal.every((node) => !node.cards.some((card) => /纲目已建立|正文待补/u.test(card.paragraphs.join("")))));
  const paragraphOwners = new Map();
  for (const node of formal) {
    for (const paragraph of node.cards.flatMap((card) => card.paragraphs).filter((paragraph) => paragraph.length >= 80)) {
      const owners = paragraphOwners.get(paragraph) ?? new Set();
      owners.add(node.nodeId);
      paragraphOwners.set(paragraph, owners);
    }
  }
  assert.deepEqual(
    [...paragraphOwners.entries()].filter(([, owners]) => owners.size >= 4).map(([paragraph, owners]) => ({ paragraph, nodes: [...owners] })),
    [],
    "人工智能正文出现跨节点批量复用段落",
  );
  const turing = ai.find((node) => node.nodeId === "ai-history-turing-imitation-game");
  assert.equal(turing?.learningResources.length, 3);
  const aStar = ai.find((node) => node.nodeId === "ai-search-a-star-open-closed");
  assert.equal(aStar?.status, "formal");
  assert.ok((aStar?.cards.length ?? 0) >= 7);
  assert.ok((aStar?.learningResources.length ?? 0) >= 1);
  assert.match(aStar?.learningResources[0].reason ?? "", /A\*/u);
  assert.ok(formal.every((node) => node.learningResources.every((resource) => resource.access !== "unknown")));
  assert.ok(formal.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  const tokenization = ai.find((node) => node.nodeId === "ai-representation-tokenization");
  assert.equal(tokenization?.status, "formal");
  assert.equal(tokenization?.learningState, "session-recorded");
  assert.deepEqual(tokenization?.learningRecords.map((record) => record.recordId), ["learn-20260827-ai-representation-tokenization-a7c4"]);
  assert.ok((tokenization?.cards.length ?? 0) >= 5, "Token 学习结果没有整理成可直接阅读的正文卡");
  assert.equal(tokenization?.learningResources.length, 3);
  assert.ok(tokenization?.sources.some((source) => source.role === "capoo-learning-record"));
  assert.ok(tokenization?.cards.at(-1).id.endsWith("-learning-path"));
  assert.ok(ai.filter((node) => node.nodeId !== "ai-representation-tokenization").every((node) => node.learningState === "not-started"));
  const aiNodeDirectory = path.join(vaultRoot, "70_专题研究", "人工智能", "知识节点");
  for (const fileName of (await fs.readdir(aiNodeDirectory)).filter((fileName) => fileName.endsWith(".md"))) {
    const markdown = await fs.readFile(path.join(aiNodeDirectory, fileName), "utf8");
    assert.doesNotMatch(markdown, /\\n\\n/u, `${fileName} 把换行写成了字面转义，正文不会形成真实段落`);
  }
});

test("游戏设计正式节点都提供完整首屏、解释链和垂直学习梯", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const gameDesign = nodes.filter((node) => node.domainId === "game" && node.branchId === "design");
  const ids = new Set(gameDesign.map((node) => node.nodeId));
  for (const required of [
    "game-design-player-actions-goals-rules-feedback",
    "game-design-core-loop-and-session-loop",
    "game-design-mechanics-dynamics-experience",
    "game-design-meaningful-choice-and-consequence",
    "game-design-information-uncertainty-and-decision",
    "game-design-prototype-playtest-revision",
    "game-design-resources-stocks-and-flows",
    "game-design-sources-sinks-and-scarcity",
    "game-design-positive-negative-feedback-loops",
    "game-design-progression-rewards-and-unlocks",
    "game-design-balance-dominant-strategy",
    "game-design-economy-observation-and-metrics",
    "game-design-affordance-landmark-and-wayfinding",
    "game-design-exploration-clue-hypothesis-loop",
    "game-design-gating-shortcuts-and-topology",
    "game-design-encounter-risk-reward-rhythm",
    "game-design-open-world-density-horizon-and-choice",
    "game-design-exploration-reward-and-new-information",
    "game-design-authored-systemic-and-player-story",
    "game-design-agency-choice-and-consequence",
    "game-design-environmental-storytelling",
    "game-design-character-goals-and-gameplay-role",
    "game-design-fragmented-information-and-reading-order",
    "game-design-theme-mechanics-alignment-and-friction",
    "game-design-control-mapping-and-response",
    "game-design-affordance-signifier-and-feedforward",
    "game-design-feedback-and-state-readability",
    "game-design-game-feel-response-chain",
    "game-design-camera-animation-audio-coordination",
    "game-design-onboarding-and-teaching-by-doing",
    "game-design-sources-of-difficulty",
    "game-design-learning-curve-and-scaffolding",
    "game-design-fairness-telegraph-and-consistency",
    "game-design-failure-cost-recovery-and-retry",
    "game-design-alternate-routes-assists-and-difficulty",
    "game-design-access-versus-challenge",
    "game-design-accessibility-options-and-barrier-testing",
  ]) assert.ok(ids.has(required), `缺少正式游戏节点：${required}`);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(gameDesign.reduce((total, node) => total + node.cards.length, 0) >= 448);
  assert.ok(gameDesign.reduce((total, node) => total + node.learningResources.length, 0) >= 140);
  assert.equal(gameDesign.filter((node) => node.topicId === "game-design-interactive-narrative").length, 6);
  assert.equal(gameDesign.filter((node) => node.topicId === "game-design-interaction-feedback").length, 6);
  assert.equal(gameDesign.filter((node) => node.topicId === "game-design-challenge-accessibility").length, 7);
  assert.ok(gameDesign.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(gameDesign.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(gameDesign.every((node) => node.cards.length >= 16));
  assert.ok(gameDesign.every((node) => node.learningResources.length >= 4));
});

test("游戏完整试点覆盖七分支四十七专题，所有正式节点都达到结构与纵向学习底线", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const game = nodes.filter((node) => node.domainId === "game");
  assert.equal(game.length, 317);
  assert.deepEqual([...new Set(game.map((node) => node.branchId))].sort(), [
    "culture",
    "design",
    "expression",
    "industry",
    "players",
    "production",
    "technology",
  ]);
  assert.equal(new Set(game.map((node) => node.topicId)).size, 47);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(game.every((node) => node.cards.length >= 16));
  assert.ok(game.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(game.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(game.every((node) => node.learningResources.length >= 4));
  game.forEach(assertFirstLookExplainsBeforeSolving);
  for (const node of game) {
    const distinctTargets = new Set(node.learningResources.map((resource) => String(resource.url || resource.path || "").replace(/[?#].*$/u, "").replace(/\/$/u, "")));
    assert.ok(distinctTargets.size >= 3, `${node.nodeId} 的纵向学习梯实际只指向 ${distinctTargets.size} 份不同材料`);
    for (const resource of node.learningResources) {
      assert.ok(resource.reason.length >= 20, `${node.nodeId}/${resource.id} 缺少具体推荐理由`);
      assert.ok(resource.focus.length >= 10, `${node.nodeId}/${resource.id} 缺少带读问题`);
      assert.ok(resource.creator, `${node.nodeId}/${resource.id} 缺少作者或机构`);
      assert.ok(resource.duration, `${node.nodeId}/${resource.id} 缺少投入时间`);
      assert.ok(resource.language, `${node.nodeId}/${resource.id} 缺少语言信息`);
      assert.notEqual(resource.access, "unknown", `${node.nodeId}/${resource.id} 缺少访问条件`);
      assert.ok(resource.use.length >= 10, `${node.nodeId}/${resource.id} 缺少建议用法`);
      assert.match(resource.asOf, /^\d{4}-\d{2}-\d{2}$/u, `${node.nodeId}/${resource.id} 缺少核验日期`);
      assert.notEqual(learningLevelLabel(resource.level), "继续学习", `${node.nodeId}/${resource.id} 使用了界面无法解释的资源层级 ${resource.level}`);
      if (resource.url) assert.match(resource.url, /^https:\/\//u, `${node.nodeId}/${resource.id} 仍在使用不安全或易退化的外部链接`);
    }
  }
});

test("游戏文化代表作品精读从本人原件长出完整节点，不把个人判断交给 AI 补写", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const closeReading = nodes.filter((node) => node.domainId === "game" && node.branchId === "culture" && node.topicId === "game-culture-close-reading");
  assert.deepEqual(closeReading.map((node) => node.nodeId), [
    "game-culture-close-reading-method",
    "game-culture-wow-tbc-long-world",
    "game-culture-souls-artistic-coherence",
    "game-culture-zelda-design-evolution",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(closeReading.reduce((total, node) => total + node.cards.length, 0) >= 70);
  assert.ok(closeReading.reduce((total, node) => total + node.learningResources.length, 0) >= 16);
  assert.ok(closeReading.every((node) => node.cards.every((card) => card.paragraphs.length >= 3)), "代表作品精读专题仍有只给结论的薄卡");
  assert.ok(closeReading.every((node) => node.cards.every((card) => card.paragraphs.join("").length >= 180)), "代表作品精读专题仍有未展开的短卡");
  assert.ok(closeReading.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  for (const personalNodeId of ["game-culture-wow-tbc-long-world", "game-culture-souls-artistic-coherence", "game-culture-zelda-design-evolution"]) {
    const node = closeReading.find((candidate) => candidate.nodeId === personalNodeId);
    assert.ok(node?.sources.some((source) => source.role === "capoo-original-judgment"), `${personalNodeId} 缺少本人判断原件`);
  }
  const tbc = closeReading.find((node) => node.nodeId === "game-culture-wow-tbc-long-world");
  assert.equal(tbc?.cards.length, 18);
  assert.ok(tbc?.cards.some((card) => card.id.endsWith("-capoo-learning-20260826")), "TBC 节点没有呈现第一次真实学习记录摘要");
  assert.ok(tbc?.sources.some((source) => source.role === "capoo-learning-record"), "TBC 节点没有链接可追溯的本人学习记录");
  const itemWalkthrough = tbc?.cards.find((card) => card.id.endsWith("-one-item-walkthrough"));
  const itemWalkthroughText = itemWalkthrough?.paragraphs.join("") ?? "";
  for (const relation of ["现实日程", "职责", "公会", "珠宝加工", "服务器", "角色"]) assert.match(itemWalkthroughText, new RegExp(relation, "u"));
  assert.match(tbc?.cards.find((card) => card.id.endsWith("-capoo-position"))?.paragraphs.join("") ?? "", /教学模型.*不是 Capoo 的传记/u);
  const method = closeReading.find((node) => node.nodeId === "game-culture-close-reading-method");
  assert.ok(method?.cards.some((card) => card.id.endsWith("-fifteen-minute-walkthrough")), "精读方法缺少贯穿一条材料的完整示范");
  const zelda = closeReading.find((node) => node.nodeId === "game-culture-zelda-design-evolution");
  assert.ok(zelda?.cards.some((card) => card.id.endsWith("-discovery-walkthrough")), "塞尔达比较缺少贯穿两部作品的同口径案例");
});

test("游戏史与媒介演化用因果节点替代年代清单，并为每条变化配置纵向学习梯", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const history = nodes.filter((node) => node.domainId === "game" && node.branchId === "culture" && node.topicId === "game-culture-history-media-evolution");
  assert.deepEqual(history.map((node) => node.nodeId), [
    "game-history-periodization-and-forces",
    "game-history-arcade-coin-and-high-score",
    "game-history-home-console-and-platform-control",
    "game-history-pc-mod-network-ecosystem",
    "game-history-persistent-online-worlds",
    "game-history-digital-mobile-and-independent-distribution",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(history.reduce((total, node) => total + node.cards.length, 0) >= 90);
  assert.ok(history.reduce((total, node) => total + node.learningResources.length, 0) >= 24);
  assert.ok(history.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(history.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(history.every((node) => node.learningResources.length >= 4));
  const periodization = history.find((node) => node.nodeId === "game-history-periodization-and-forces");
  assert.ok(periodization?.cards.some((card) => card.id.endsWith("-capoo-learning-20260826")), "游戏史分期节点没有呈现第一次真实学习记录摘要");
  assert.ok(periodization?.sources.some((source) => source.role === "capoo-learning-record"), "游戏史分期节点没有链接可追溯的本人学习记录");
});

test("游戏类型谱系追踪惯例与分化，不把类型退化成标签清单", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const genre = nodes.filter((node) => node.domainId === "game" && node.branchId === "culture" && node.topicId === "game-culture-genre-genealogy");
  assert.deepEqual(genre.map((node) => node.nodeId), [
    "game-genre-as-convention-and-expectation",
    "game-genre-rpg-lineages",
    "game-genre-mmo-and-online-worlds",
    "game-genre-action-adventure-and-zelda",
    "game-genre-soulslike-structure-and-surface",
    "game-genre-open-world-and-sandbox",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(genre.reduce((total, node) => total + node.cards.length, 0) >= 110);
  assert.ok(genre.reduce((total, node) => total + node.learningResources.length, 0) >= 24);
  assert.ok(genre.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(genre.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(genre.every((node) => node.learningResources.length >= 4));
});

test("游戏创作者专题同时追踪个人判断、团队劳动与机构条件", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const creators = nodes.filter((node) => node.domainId === "game" && node.branchId === "culture" && node.topicId === "game-culture-creators-studios");
  assert.deepEqual(creators.map((node) => node.nodeId), [
    "game-authorship-individual-team-and-institution",
    "game-creator-miyamoto-aonuma-and-zelda-lineage",
    "game-creator-miyazaki-and-fromsoftware",
    "game-studio-blizzard-and-live-world-production",
    "game-studio-nintendo-design-and-hardware",
    "game-studio-independence-and-auteur-boundary",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(creators.reduce((total, node) => total + node.cards.length, 0) >= 100);
  assert.ok(creators.reduce((total, node) => total + node.learningResources.length, 0) >= 24);
  assert.ok(creators.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(creators.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(creators.every((node) => node.learningResources.length >= 4));
  assert.ok(creators.every((node) => node.sources.some((source) => /primary-source|primary-document|studio-viewpoint|production-studies/u.test(source.role))));
});

test("游戏批评与审美专题把位置、证据、标准和个人经典组成完整学习链", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const criticism = nodes.filter((node) => node.domainId === "game" && node.branchId === "culture" && node.topicId === "game-culture-criticism-aesthetics");
  assert.deepEqual(criticism.map((node) => node.nodeId), [
    "game-criticism-description-interpretation-evaluation",
    "game-criticism-player-position-and-situated-experience",
    "game-criticism-mechanics-aesthetics-and-meaning",
    "game-criticism-taste-quality-and-historical-impact",
    "game-criticism-evidence-counterexample-and-comparison",
    "game-criticism-review-essay-and-scholarship",
    "game-criticism-personal-canon-without-ranking",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(criticism.reduce((total, node) => total + node.cards.length, 0) >= 110);
  assert.ok(criticism.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(criticism.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(criticism.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(criticism.every((node) => node.learningResources.length >= 4));
  assert.ok(criticism.find((node) => node.nodeId === "game-criticism-personal-canon-without-ranking")?.sources.some((source) => source.role === "capoo-personal-original"));
  const threeLayers = criticism.find((node) => node.nodeId === "game-criticism-description-interpretation-evaluation");
  assert.ok(threeLayers?.cards.every((card) => card.paragraphs.length >= 3), "游戏批评三层入口仍有只给结论的薄卡");
  assert.ok(threeLayers?.cards.every((card) => card.paragraphs.join("").length >= 180), "游戏批评三层入口仍有未展开的短卡");
  const soulsWalkthrough = threeLayers?.cards.find((card) => card.id.endsWith("-souls-example"))?.paragraphs.join("") ?? "";
  for (const layer of ["描述", "解释假设", "评价"]) assert.match(soulsWalkthrough, new RegExp(layer, "u"));
  assert.ok(threeLayers?.learningResources.some((resource) => resource.url?.includes("kilthub.cmu.edu/articles/journal_contribution/Well_Played_1_0")), "游戏批评入口仍引用失效的 Well Played 目录页");
  assert.ok(threeLayers?.learningResources.some((resource) => resource.path?.endsWith("游戏作品精读方法_不是通关以后复述剧情.md")), "三层批评练习没有回到本库精读示范");
});

test("游戏保存专题区分对象、版本、重建路径、在线世界与记忆证据", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const preservation = nodes.filter((node) => node.domainId === "game" && node.branchId === "culture" && node.topicId === "game-culture-preservation-memory");
  assert.deepEqual(preservation.map((node) => node.nodeId), [
    "game-preservation-object-code-server-and-practice",
    "game-preservation-version-patch-and-live-service",
    "game-preservation-emulation-port-and-remake",
    "game-preservation-online-world-shutdown",
    "game-preservation-archive-oral-history-and-player-memory",
    "game-preservation-replay-context-and-present-judgment",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(preservation.reduce((total, node) => total + node.cards.length, 0) >= 108);
  assert.ok(preservation.reduce((total, node) => total + node.learningResources.length, 0) >= 24);
  assert.ok(preservation.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(preservation.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(preservation.every((node) => node.learningResources.length >= 4));
  assert.ok(preservation.every((node) => node.sources.some((source) => /preservation|archive|institutional|heritage|restoration/u.test(source.role))));
  assert.ok(preservation.filter((node) => node.sources.some((source) => source.role === "capoo-personal-original")).length >= 2);
});

test("玩家心理与动机把变化的动机成分、需要、学习、竞争、归属和表达组成完整学习链", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const motivation = nodes.filter((node) => node.domainId === "game" && node.branchId === "players" && node.topicId === "game-players-motivation-psychology");
  assert.deepEqual(motivation.map((node) => node.nodeId), [
    "game-player-motivation-not-fixed-types",
    "game-player-autonomy-competence-relatedness",
    "game-player-mastery-challenge-and-learning",
    "game-player-curiosity-exploration-and-information-gap",
    "game-player-competition-status-and-fairness",
    "game-player-belonging-cooperation-and-obligation",
    "game-player-expression-collection-and-self-directed-goals",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(motivation.reduce((total, node) => total + node.cards.length, 0) >= 112);
  assert.ok(motivation.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(motivation.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(motivation.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(motivation.every((node) => node.learningResources.length >= 4));
  assert.ok(motivation.every((node) => node.sources.some((source) => /empirical|psychological|research|game-studies|ethnographic/u.test(source.role))));
});

test("身份与沉浸区分玩家化身角色、临场心流、认同依恋、媒介效应、选择记忆与安全", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const identity = nodes.filter((node) => node.domainId === "game" && node.branchId === "players" && node.topicId === "game-players-identity-presence");
  assert.deepEqual(identity.map((node) => node.nodeId), [
    "game-player-avatar-character-and-self-distance",
    "game-player-presence-immersion-flow-and-involvement",
    "game-player-identification-attachment-and-role-enactment",
    "game-player-avatar-embodiment-and-proteus-effect",
    "game-player-moral-choice-and-self-inference",
    "game-player-persistent-character-and-autobiographical-memory",
    "game-player-identity-experiment-recognition-and-safety",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(identity.reduce((total, node) => total + node.cards.length, 0) >= 119);
  assert.ok(identity.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(identity.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(identity.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(identity.every((node) => node.learningResources.length >= 4));
  assert.ok(identity.every((node) => node.sources.some((source) => /identity|game-studies|hci|study|experiment|review|synthesis/u.test(source.role))));
  assert.ok(identity.find((node) => node.nodeId === "game-player-persistent-character-and-autobiographical-memory")?.sources.some((source) => source.role === "capoo-personal-original"));
});

test("社群与虚拟关系从共同在线进入协作、治理、社会化、劳动、伤害与共同记忆", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const community = nodes.filter((node) => node.domainId === "game" && node.branchId === "players" && node.topicId === "game-players-community-relationships");
  assert.deepEqual(community.map((node) => node.nodeId), [
    "game-player-co-presence-repeated-encounters-and-friendship",
    "game-player-coordination-interdependence-and-trust",
    "game-player-guild-governance-and-legitimate-authority",
    "game-player-mentorship-norms-and-reputation",
    "game-player-invisible-labor-care-and-burnout",
    "game-player-conflict-harassment-moderation-and-repair",
    "game-player-community-memory-migration-and-world-closure",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(community.reduce((total, node) => total + node.cards.length, 0) >= 119);
  assert.ok(community.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(community.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(community.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(community.every((node) => node.learningResources.length >= 4));
  assert.ok(community.every((node) => node.sources.some((source) => /study|framework|case|analysis|critique|ethnographic/u.test(source.role))));
  assert.ok(community.some((node) => node.sources.some((source) => source.role === "personal-source")));
});

test("MOD、UGC 与共创区分对象、工具、学习、分发、权利、价值与长期维护", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const cocreation = nodes.filter((node) => node.domainId === "game" && node.branchId === "players" && node.topicId === "game-players-mods-ugc-cocreation");
  assert.deepEqual(cocreation.map((node) => node.nodeId), [
    "game-player-mod-ugc-and-cocreation-boundaries",
    "game-player-tool-affordances-and-creator-access",
    "game-player-participatory-learning-and-creative-collaboration",
    "game-player-distribution-curation-and-dependency-graphs",
    "game-player-ownership-licenses-and-platform-permission",
    "game-player-playbour-value-capture-and-creator-economies",
    "game-player-maintenance-versioning-and-preservation",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(cocreation.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(cocreation.every((node) => node.cards.length >= 18));
  assert.ok(cocreation.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(cocreation.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(cocreation.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(cocreation.every((node) => node.learningResources.length >= 4));
  assert.ok(cocreation.every((node) => node.sources.some((source) => /framework|study|case|model|guidance|documentation|contract/u.test(source.role))));
});

test("直播、电竞与传播从公共表演追到生产、关系、可见性、制度、职业劳动和转播叙事", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const streaming = nodes.filter((node) => node.domainId === "game" && node.branchId === "players" && node.topicId === "game-players-streaming-esports");
  assert.deepEqual(streaming.map((node) => node.nodeId), [
    "game-player-play-as-public-performance-and-liveness",
    "game-player-stream-production-chat-and-moderation",
    "game-player-audience-participation-parasociality-and-community",
    "game-player-platform-discovery-metrics-and-algorithmic-visibility",
    "game-player-esports-institutions-integrity-and-publisher-power",
    "game-player-esports-training-team-labor-and-careers",
    "game-player-spectator-interface-broadcast-and-public-narrative",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(streaming.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(streaming.every((node) => node.cards.length >= 18));
  assert.ok(streaming.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(streaming.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(streaming.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(streaming.every((node) => node.learningResources.length >= 4));
  assert.ok(streaming.every((node) => node.sources.some((source) => /study|framework|practice|documentation|policy|governance|regulations|metric/u.test(source.role))));
});

test("成瘾、伦理与包容性区分临床判断、参与压力、消费伤害、安全、无障碍和产品责任", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const ethics = nodes.filter((node) => node.domainId === "game" && node.branchId === "players" && node.topicId === "game-players-harm-ethics-inclusion");
  assert.deepEqual(ethics.map((node) => node.nodeId), [
    "game-player-high-engagement-habit-loss-of-control-and-disorder",
    "game-player-functional-impairment-assessment-and-context",
    "game-player-reward-streak-fomo-and-disengagement-design",
    "game-player-microtransactions-loot-boxes-and-spending-harm",
    "game-player-harassment-discrimination-and-safety-systems",
    "game-player-accessibility-barriers-and-inclusive-participation",
    "game-player-ethical-impact-assessment-child-rights-and-redress",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(ethics.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(ethics.every((node) => node.cards.length >= 18));
  assert.ok(ethics.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(ethics.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(ethics.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(ethics.every((node) => node.learningResources.length >= 4));
  assert.ok(ethics.every((node) => node.sources.some((source) => /diagnostic|health|assessment|ethical|consumer|safety|accessibility|child-rights|intervention/u.test(source.role))));
});

test("严肃游戏与教育从概念边界追到学习机制、模拟、迁移、临床、公民能动性和机构实施", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const seriousGames = nodes.filter((node) => node.domainId === "game" && node.branchId === "players" && node.topicId === "game-players-serious-games-learning");
  assert.deepEqual(seriousGames.map((node) => node.nodeId), [
    "game-player-game-based-learning-gamification-and-serious-purpose",
    "game-player-learning-objectives-mechanics-feedback-and-reflection",
    "game-player-simulation-model-fidelity-and-debriefing",
    "game-player-transfer-retention-assessment-and-evidence",
    "game-player-health-therapy-training-and-clinical-safety",
    "game-player-persuasive-civic-games-values-and-agency",
    "game-player-institutional-implementation-equity-and-sustainability",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(seriousGames.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(seriousGames.every((node) => node.cards.length >= 18));
  assert.ok(seriousGames.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(seriousGames.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(seriousGames.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(seriousGames.every((node) => node.learningResources.length >= 4));
  assert.ok(seriousGames.every((node) => node.sources.some((source) => /learning|education|simulation|transfer|clinical|health|civic|implementation|evidence/u.test(source.role))));
  seriousGames.forEach(assertFirstLookExplainsBeforeSolving);
});

test("玩家分支全部正式节点先解释对象、案例与使用场景", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes } = await readDomainKnowledgeNodes(vaultRoot);
  const playerNodes = nodes.filter((node) => node.domainId === "game" && node.branchId === "players");
  assert.equal(playerNodes.length, 49);
  playerNodes.forEach(assertFirstLookExplainsBeforeSolving);
});

test("互动叙事与玩家能动性区分叙事位置、材料层、行动关系、选择记忆、信息秩序、涌现与玩家边界", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const narrativeAgency = nodes.filter((node) => node.domainId === "game" && node.branchId === "expression" && node.topicId === "game-expression-interactive-narrative-agency");
  assert.deepEqual(narrativeAgency.map((node) => node.nodeId), [
    "game-expression-player-avatar-character-narrator-audience",
    "game-expression-authored-plot-system-events-player-account",
    "game-expression-agency-intention-possibility-legibility-consequence",
    "game-expression-choice-consequence-memory-and-reconvergence",
    "game-expression-narrator-focalization-information-time-unreliability",
    "game-expression-emergence-storytelling-and-player-meaning",
    "game-expression-narrative-ethics-consent-content-boundaries",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(narrativeAgency.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(narrativeAgency.every((node) => node.cards.length >= 18));
  assert.ok(narrativeAgency.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(narrativeAgency.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(narrativeAgency.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(narrativeAgency.every((node) => node.learningResources.length >= 4));
  assert.ok(narrativeAgency.every((node) => node.sources.some((source) => /narrative|agency|story|ethics|safety|consent|practice|interactivity/u.test(source.role))));
  narrativeAgency.forEach(assertFirstLookExplainsBeforeSolving);
});

test("世界观角色与文本从世界规则进入制度日常、人物行动、角色作者权、对白、阅读与本地化", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const worldCharacterText = nodes.filter((node) => node.domainId === "game" && node.branchId === "expression" && node.topicId === "game-expression-worldbuilding-character-text");
  assert.deepEqual(worldCharacterText.map((node) => node.nodeId), [
    "game-expression-world-rules-ontology-and-boundaries",
    "game-expression-history-institutions-and-everyday-life",
    "game-expression-character-desire-capability-and-situation",
    "game-expression-player-character-authorship-and-expression",
    "game-expression-dialogue-action-subtext-and-relationship",
    "game-expression-text-density-information-architecture-and-reading",
    "game-expression-localization-function-context-and-performance",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(worldCharacterText.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(worldCharacterText.every((node) => node.cards.length >= 18));
  assert.ok(worldCharacterText.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(worldCharacterText.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(worldCharacterText.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(worldCharacterText.every((node) => node.learningResources.length >= 4));
  assert.ok(worldCharacterText.every((node) => node.sources.some((source) => /world|character|dialogue|text|localization|cultural|narrative|accessibility|practice|research/u.test(source.role))));
  worldCharacterText.forEach(assertFirstLookExplainsBeforeSolving);
});

test("环境叙事与空间表达从路线顺序进入环境证据、注意、场所、权力、推断和程序空间", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const spatialStorytelling = nodes.filter((node) => node.domainId === "game" && node.branchId === "expression" && node.topicId === "game-expression-environmental-spatial-storytelling");
  assert.deepEqual(spatialStorytelling.map((node) => node.nodeId), [
    "game-expression-spatial-architecture-paths-boundaries-vistas-and-return",
    "game-expression-environmental-traces-objects-absence-and-causality",
    "game-expression-movement-attention-sightlines-thresholds-and-reveal",
    "game-expression-place-attachment-repetition-change-and-memory",
    "game-expression-architecture-access-power-labor-and-maintenance",
    "game-expression-exploration-clues-hypotheses-uncertainty-and-knowledge",
    "game-expression-procedural-space-grammar-landmarks-history-and-place",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(spatialStorytelling.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(spatialStorytelling.every((node) => node.cards.length >= 18));
  assert.ok(spatialStorytelling.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(spatialStorytelling.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(spatialStorytelling.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(spatialStorytelling.every((node) => node.learningResources.length >= 4));
  assert.ok(spatialStorytelling.every((node) => node.sources.some((source) => /spatial|environmental|place|architectural|cultural|exploration|procedural|attention|research|practice/u.test(source.role))));
  spatialStorytelling.forEach(assertFirstLookExplainsBeforeSolving);
});

test("视觉语言与美术方向从辨认进入注意、表面因果、动态构图、视觉语法、界面接缝与量产约束", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const visualArtDirection = nodes.filter((node) => node.domainId === "game" && node.branchId === "expression" && node.topicId === "game-expression-visual-language-art-direction");
  assert.deepEqual(visualArtDirection.map((node) => node.nodeId), [
    "game-expression-shape-silhouette-category-and-action-recognition",
    "game-expression-color-value-contrast-and-attention-hierarchy",
    "game-expression-material-light-state-and-world-rules",
    "game-expression-composition-scale-gaze-and-spatial-relations",
    "game-expression-stylization-visual-grammar-consistency-and-variation",
    "game-expression-interface-world-seam-map-icon-type-and-hud",
    "game-expression-production-constraints-content-scale-and-visual-priority",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(visualArtDirection.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(visualArtDirection.every((node) => node.cards.length >= 18));
  assert.ok(visualArtDirection.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(visualArtDirection.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(visualArtDirection.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(visualArtDirection.every((node) => node.learningResources.length >= 4));
  assert.ok(visualArtDirection.every((node) => node.sources.some((source) => /visual|art|color|material|lighting|composition|style|interface|production|accessibility|practice/u.test(source.role))));
  visualArtDirection.forEach(assertFirstLookExplainsBeforeSolving);
});

test("动画、表演与镜头从力量进入响应、关系行动、身体所有权、镜头任务、控制权交接与系统连续性", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const animationPerformanceCamera = nodes.filter((node) => node.domainId === "game" && node.branchId === "expression" && node.topicId === "game-expression-animation-performance-camera");
  assert.deepEqual(animationPerformanceCamera.map((node) => node.nodeId), [
    "game-expression-pose-timing-weight-and-force",
    "game-expression-input-response-startup-cancel-commitment-and-recovery",
    "game-expression-character-performance-body-face-gaze-pause-and-voice",
    "game-expression-authored-procedural-animation-contact-adaptation-and-control",
    "game-expression-gameplay-camera-framing-visibility-prediction-and-spatial-judgment",
    "game-expression-cinematic-camera-control-handoff-continuity-and-player-position",
    "game-expression-animation-continuity-style-retargeting-framerate-and-system-transitions",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(animationPerformanceCamera.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(animationPerformanceCamera.every((node) => node.cards.length >= 18));
  assert.ok(animationPerformanceCamera.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(animationPerformanceCamera.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(animationPerformanceCamera.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(animationPerformanceCamera.every((node) => node.learningResources.length >= 4));
  assert.ok(animationPerformanceCamera.every((node) => node.sources.some((source) => /animation|performance|camera|procedural|gameplay|cinematic|latency|character|interaction|continuity/u.test(source.role))));
  animationPerformanceCamera.forEach(assertFirstLookExplainsBeforeSolving);
});

test("音乐、音效与声音空间从听觉注意进入因果、动态结构、记忆、空间、对白与听觉边界", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const musicSoundSpace = nodes.filter((node) => node.domainId === "game" && node.branchId === "expression" && node.topicId === "game-expression-music-sound-audio-space");
  assert.deepEqual(musicSoundSpace.map((node) => node.nodeId), [
    "game-expression-auditory-attention-information-hierarchy-and-nonlinear-mix",
    "game-expression-interactive-sound-causality-material-state-and-feedback",
    "game-expression-dynamic-music-layering-resequencing-transition-and-system-state",
    "game-expression-theme-motif-timbre-memory-character-place-and-change",
    "game-expression-spatial-audio-direction-distance-occlusion-reverb-and-propagation",
    "game-expression-voice-dialogue-performance-trigger-mix-and-localization",
    "game-expression-silence-absence-hearing-boundaries-captions-and-player-context",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(musicSoundSpace.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(musicSoundSpace.every((node) => node.cards.length >= 18));
  assert.ok(musicSoundSpace.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(musicSoundSpace.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(musicSoundSpace.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(musicSoundSpace.every((node) => node.learningResources.length >= 4));
  assert.ok(musicSoundSpace.every((node) => node.sources.some((source) => /audio|sound|music|mix|auditory|spatial|voice|dialogue|motif|caption|hearing/u.test(source.role))));
  musicSoundSpace.forEach(assertFirstLookExplainsBeforeSolving);
});

test("表达分支全部正式节点先解释对象、案例与使用场景", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes } = await readDomainKnowledgeNodes(vaultRoot);
  const expressionNodes = nodes.filter((node) => node.domainId === "game" && node.branchId === "expression");
  assert.equal(expressionNodes.length, 42);
  expressionNodes.forEach(assertFirstLookExplainsBeforeSolving);
});

test("创意与立项从玩家承诺进入受众、愿景取舍、能力范围、异质风险、决定权与可撤回授权", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const conceptGreenlight = nodes.filter((node) => node.domainId === "game" && node.branchId === "production" && node.topicId === "game-production-concept-greenlight");
  assert.deepEqual(conceptGreenlight.map((node) => node.nodeId), [
    "game-production-player-promise-core-experience-and-evidence",
    "game-production-audience-context-access-and-market-assumptions",
    "game-production-vision-pillars-anti-pillars-and-priority-rules",
    "game-production-scope-content-quality-time-and-capability-envelope",
    "game-production-risk-map-desirability-feasibility-viability-and-capability",
    "game-production-ownership-decision-rights-stakeholders-and-escalation",
    "game-production-greenlight-evidence-kill-criteria-and-reversible-commitment",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(conceptGreenlight.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(conceptGreenlight.every((node) => node.cards.length >= 18));
  assert.ok(conceptGreenlight.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(conceptGreenlight.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(conceptGreenlight.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(conceptGreenlight.every((node) => node.learningResources.length >= 4));
  assert.ok(conceptGreenlight.every((node) => node.sources.some((source) => /vision|player|market|scope|risk|ownership|decision|greenlight|production|stage-gate/u.test(source.role))));
  conceptGreenlight.forEach(assertFirstLookExplainsBeforeSolving);
});

test("原型与预制作从待验证未知进入信号真实度、实现去向、体验基座、里程碑职责、生产基线与可携带风险", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const prototypePreproduction = nodes.filter((node) => node.domainId === "game" && node.branchId === "production" && node.topicId === "game-production-prototype-preproduction");
  assert.deepEqual(prototypePreproduction.map((node) => node.nodeId), [
    "game-production-question-hypothesis-risk-and-cheapest-test",
    "game-production-prototype-fidelity-speed-and-signal-preservation",
    "game-production-throwaway-prototype-foundation-and-technical-debt",
    "game-production-core-controls-camera-interface-and-key-technology",
    "game-production-prototype-first-playable-vertical-slice-and-pilot-content",
    "game-production-production-baseline-asset-budget-throughput-and-representative-state",
    "game-production-preproduction-exit-criteria-transition-and-remaining-unknowns",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(prototypePreproduction.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(prototypePreproduction.every((node) => node.cards.length >= 18));
  assert.ok(prototypePreproduction.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(prototypePreproduction.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(prototypePreproduction.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(prototypePreproduction.every((node) => node.learningResources.length >= 4));
  assert.ok(prototypePreproduction.every((node) => node.sources.some((source) => /prototype|fidelity|signal|throwaway|technical-debt|control|interface|technology|vertical-slice|first-playable|baseline|throughput|preproduction|production/u.test(source.role))));
  prototypePreproduction.forEach(assertFirstLookExplainsBeforeSolving);
});

test("跨工种协作从专业判断进入共同玩家任务、薄依赖契约、反馈分层、决定权、交接全成本与组织拓扑", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const disciplines = nodes.filter((node) => node.domainId === "game" && node.branchId === "production" && node.topicId === "game-production-disciplines-collaboration");
  assert.deepEqual(disciplines.map((node) => node.nodeId), [
    "game-production-discipline-judgment-objects-deliverables-and-quality-bars",
    "game-production-shared-vocabulary-player-task-and-cross-discipline-intent",
    "game-production-dependency-contract-input-output-state-and-timing",
    "game-production-feedback-observation-interpretation-request-and-ownership",
    "game-production-feature-owner-craft-authority-approval-and-integration",
    "game-production-handoff-context-review-and-integration-cost",
    "game-production-cross-functional-pods-central-teams-and-partner-studios",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(disciplines.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(disciplines.every((node) => node.cards.length >= 18));
  assert.ok(disciplines.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(disciplines.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(disciplines.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(disciplines.every((node) => node.learningResources.length >= 4));
  assert.ok(disciplines.every((node) => node.sources.some((source) => /discipline|workflow|language|direction|dependency|interface|feedback|ownership|handoff|integration|cross-functional|cell|partner|collaboration/u.test(source.role))));
  disciplines.forEach(assertFirstLookExplainsBeforeSolving);
});

test("内容生产管线从单一权威编辑路径进入发现、无损可解释转换、版本策略、设备反馈、规模与健康治理", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const pipeline = nodes.filter((node) => node.domainId === "game" && node.branchId === "production" && node.topicId === "game-production-content-pipeline");
  assert.deepEqual(pipeline.map((node) => node.nodeId), [
    "game-production-source-assets-derived-artifacts-and-authoritative-edit-paths",
    "game-production-naming-metadata-identifiers-and-discovery",
    "game-production-import-validation-conversion-and-loss-reporting",
    "game-production-version-control-locking-merging-and-large-binary-assets",
    "game-production-build-cook-package-deploy-and-fast-feedback",
    "game-production-batch-variation-localization-and-content-scale",
    "game-production-pipeline-health-failures-observability-and-maintenance",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(pipeline.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(pipeline.every((node) => node.cards.length >= 18));
  assert.ok(pipeline.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(pipeline.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(pipeline.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(pipeline.every((node) => node.learningResources.length >= 4));
  assert.ok(pipeline.every((node) => node.sources.some((source) => /source|asset|metadata|validation|conversion|version|merge|binary|build|cook|deploy|localization|pipeline|observability|maintenance/u.test(source.role))));
  pipeline.forEach(assertFirstLookExplainsBeforeSolving);
});

test("项目管理与版本从范围取舍进入区间预测、系统流动、构建证据、稳定发布、五类日志与可持续节奏", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const projectVersion = nodes.filter((node) => node.domainId === "game" && node.branchId === "production" && node.topicId === "game-production-project-version-management");
  assert.deepEqual(projectVersion.map((node) => node.nodeId), [
    "game-production-scope-baseline-change-budget-and-tradeoff-ledger",
    "game-production-estimation-uncertainty-reference-classes-and-forecast-ranges",
    "game-production-dependencies-critical-path-bottlenecks-and-flow",
    "game-production-milestones-integrated-builds-exit-criteria-and-evidence",
    "game-production-versions-branches-release-trains-and-content-freeze",
    "game-production-risk-issue-decision-assumption-and-change-logs",
    "game-production-schedule-buffer-sustainable-pace-and-crunch-boundary",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(projectVersion.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(projectVersion.every((node) => node.cards.length >= 18));
  assert.ok(projectVersion.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(projectVersion.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(projectVersion.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(projectVersion.every((node) => node.learningResources.length >= 4));
  assert.ok(projectVersion.every((node) => node.sources.some((source) => /scope|estimation|schedule|critical-path|flow|milestone|build|branch|release|freeze|risk|decision|change|sustainable|crunch/u.test(source.role))));
  projectVersion.forEach(assertFirstLookExplainsBeforeSolving);
});

test("测试与协作从问题证据匹配进入样本偏差、观察解释、缺陷闭环、因果边界、反馈复测与组织记忆", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const testingCollaboration = nodes.filter((node) => node.domainId === "game" && node.branchId === "production" && node.topicId === "game-production-testing-collaboration");
  assert.deepEqual(testingCollaboration.map((node) => node.nodeId), [
    "game-production-test-question-layer-and-evidence-fit",
    "game-production-playtest-recruitment-context-bias-and-player-fit",
    "game-production-observation-report-interpretation-and-design-response",
    "game-production-defect-reproduction-severity-priority-and-ownership",
    "game-production-telemetry-qualitative-evidence-and-causal-limits",
    "game-production-feedback-triage-decision-history-and-retest",
    "game-production-retrospective-learning-action-and-organizational-memory",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(testingCollaboration.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(testingCollaboration.every((node) => node.cards.length >= 18));
  assert.ok(testingCollaboration.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(testingCollaboration.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(testingCollaboration.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(testingCollaboration.every((node) => node.learningResources.length >= 4));
  assert.ok(testingCollaboration.every((node) => node.sources.some((source) => /test|playtest|recruit|player|observation|research|defect|qa|telemetry|analytics|feedback|triage|retest|retrospective|postmortem|memory/u.test(source.role))));
  testingCollaboration.forEach(assertFirstLookExplainsBeforeSolving);
});

test("独立开发方法从角色与可养范围进入复用、外包、个人跑道、公开期待与完整生命周期", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const independentDevelopment = nodes.filter((node) => node.domainId === "game" && node.branchId === "production" && node.topicId === "game-production-independent-development");
  assert.deepEqual(independentDevelopment.map((node) => node.nodeId), [
    "game-production-solo-role-switching-focus-and-decision-hygiene",
    "game-production-scope-from-energy-skill-time-and-maintenance",
    "game-production-reuse-tools-assets-and-portfolio-capability",
    "game-production-outsourcing-contract-context-review-and-dependency-risk",
    "game-production-personal-runway-health-rhythm-and-stop-rules",
    "game-production-public-progress-community-pressure-and-expectation-management",
    "game-production-ship-update-archive-and-next-project-transition",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(independentDevelopment.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(independentDevelopment.every((node) => node.cards.length >= 18));
  assert.ok(independentDevelopment.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(independentDevelopment.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(independentDevelopment.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(independentDevelopment.every((node) => node.learningResources.length >= 4));
  assert.ok(independentDevelopment.every((node) => node.sources.some((source) => /solo|independent|scope|capacity|reuse|tool|portfolio|outsource|contract|health|runway|work-life|public|community|early-access|release|update|maintenance|archive|transition/u.test(source.role))));
  independentDevelopment.forEach(assertFirstLookExplainsBeforeSolving);
});

test("引擎与工具从能力分层进入适配、作者模型、源边界、扩展层次、证据链与迁移退出", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const enginesTools = nodes.filter((node) => node.domainId === "game" && node.branchId === "technology" && node.topicId === "game-technology-engines-tools");
  assert.deepEqual(enginesTools.map((node) => node.nodeId), [
    "game-technology-engine-runtime-editor-build-and-ecosystem",
    "game-technology-requirements-platform-team-and-engine-fit",
    "game-technology-scene-entity-component-prefab-and-authoring-model",
    "game-technology-asset-import-serialization-reimport-and-source-boundary",
    "game-technology-scripting-native-code-plugin-and-extension-boundaries",
    "game-technology-debugging-profiling-testing-and-tool-observability",
    "game-technology-engine-version-upgrade-lock-in-migration-and-exit",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(enginesTools.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(enginesTools.every((node) => node.cards.length >= 18));
  assert.ok(enginesTools.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(enginesTools.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(enginesTools.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(enginesTools.every((node) => node.learningResources.length >= 4));
  assert.ok(enginesTools.every((node) => node.sources.some((source) => /engine|runtime|editor|build|ecosystem|license|platform|team|scene|node|actor|component|prefab|asset|import|serialization|script|native|plugin|extension|debug|profil|test|observability|version|upgrade|migration|lock-in|exit/u.test(source.role))));
  enginesTools.forEach(assertFirstLookExplainsBeforeSolving);
});

test("程序架构与数据从状态所有权进入边界、配置、存档、确定性、工作集与安全改变", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const softwareArchitecture = nodes.filter((node) => node.domainId === "game" && node.branchId === "technology" && node.topicId === "game-technology-software-architecture-data");
  assert.deepEqual(softwareArchitecture.map((node) => node.nodeId), [
    "game-technology-game-state-lifecycle-ownership-and-transition",
    "game-technology-composition-events-dependencies-and-system-boundaries",
    "game-technology-data-driven-configuration-schema-and-validation",
    "game-technology-save-identity-version-migration-and-recovery",
    "game-technology-determinism-randomness-time-and-replay",
    "game-technology-memory-lifetime-loading-streaming-and-cache",
    "game-technology-api-contract-tests-refactoring-and-technical-debt",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(softwareArchitecture.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(softwareArchitecture.every((node) => node.cards.length >= 18));
  assert.ok(softwareArchitecture.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(softwareArchitecture.every((node) => node.cards[0].paragraphs.length >= 3));
  softwareArchitecture.forEach(assertFirstLookExplainsBeforeSolving);
  assert.ok(softwareArchitecture.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(softwareArchitecture.every((node) => node.learningResources.length >= 4));
  assert.ok(softwareArchitecture.every((node) => node.sources.some((source) => /state|lifecycle|ownership|component|event|dependency|boundary|data|schema|validation|save|version|migration|determin|random|time|replay|memory|loading|cache|contract|test|refactor|debt/u.test(source.role))));
});

test("图形与性能从帧瓶颈进入渲染层、运动稳定、场景规模、资产预算、回归与视觉取舍", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const graphicsPerformance = nodes.filter((node) => node.domainId === "game" && node.branchId === "technology" && node.topicId === "game-technology-graphics-performance");
  assert.deepEqual(graphicsPerformance.map((node) => node.nodeId), [
    "game-technology-frame-time-cpu-gpu-pipeline-and-bottleneck",
    "game-technology-rendering-pipeline-geometry-material-light-and-postprocess",
    "game-technology-resolution-upscaling-antialiasing-and-image-stability",
    "game-technology-draw-calls-batching-instancing-culling-and-lod",
    "game-technology-texture-mesh-animation-memory-and-streaming-budgets",
    "game-technology-profiling-target-hardware-distribution-and-regression",
    "game-technology-visual-priority-scalability-and-player-facing-tradeoffs",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(graphicsPerformance.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(graphicsPerformance.every((node) => node.cards.length >= 18));
  assert.ok(graphicsPerformance.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(graphicsPerformance.every((node) => node.cards[0].paragraphs.length >= 3));
  graphicsPerformance.forEach(assertFirstLookExplainsBeforeSolving);
  assert.ok(graphicsPerformance.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(graphicsPerformance.every((node) => node.learningResources.length >= 4));
  assert.ok(graphicsPerformance.every((node) => node.sources.some((source) => /frame|cpu|gpu|render|material|light|post|resolution|upscal|antialias|stability|draw|batch|instanc|cull|lod|texture|mesh|animation|memory|stream|profil|hardware|distribution|regression|visual|scalability|player/u.test(source.role))));
});

test("动画物理与声音从角色权威进入接触、模拟、稳定、信号流、听觉空间与跨时钟反馈", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const animationPhysicsAudio = nodes.filter((node) => node.domainId === "game" && node.branchId === "technology" && node.topicId === "game-technology-animation-physics-audio");
  assert.deepEqual(animationPhysicsAudio.map((node) => node.nodeId), [
    "game-technology-animation-data-state-blend-root-motion-and-events",
    "game-technology-procedural-animation-ik-rig-retarget-and-contact",
    "game-technology-physics-step-collision-query-and-gameplay-authority",
    "game-technology-physics-stability-scale-continuous-detection-and-debug",
    "game-technology-audio-asset-voice-routing-mix-and-runtime-state",
    "game-technology-spatial-audio-attenuation-occlusion-reverb-and-voice-budget",
    "game-technology-cross-system-timing-feedback-latency-and-authority",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(animationPhysicsAudio.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(animationPhysicsAudio.every((node) => node.cards.length >= 18));
  assert.ok(animationPhysicsAudio.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(animationPhysicsAudio.every((node) => node.cards[0].paragraphs.length >= 3));
  animationPhysicsAudio.forEach(assertFirstLookExplainsBeforeSolving);
  assert.ok(animationPhysicsAudio.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(animationPhysicsAudio.every((node) => node.learningResources.length >= 4));
  assert.ok(animationPhysicsAudio.every((node) => node.sources.some((source) => /animation|state|blend|root|event|ik|rig|retarget|contact|physics|collision|query|step|stability|constraint|audio|voice|routing|mix|spatial|attenuation|occlusion|reverb|timing|clock|latency/u.test(source.role))));
});

test("网络与数据从拓扑权威进入坏网感知、选择性复制、预测公平、多人旅程、长期数据与在线责任", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const networkingData = nodes.filter((node) => node.domainId === "game" && node.branchId === "technology" && node.topicId === "game-technology-networking-data");
  assert.deepEqual(networkingData.map((node) => node.nodeId), [
    "game-technology-network-model-authority-client-server-peer-and-host",
    "game-technology-latency-jitter-loss-bandwidth-and-player-perception",
    "game-technology-replication-interest-delta-frequency-and-priority",
    "game-technology-prediction-interpolation-reconciliation-and-lag-compensation",
    "game-technology-matchmaking-session-lobby-presence-and-recovery",
    "game-technology-backend-identity-save-economy-telemetry-and-privacy",
    "game-technology-online-security-cheating-abuse-operations-and-sunset",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(networkingData.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(networkingData.every((node) => node.cards.length >= 18));
  assert.ok(networkingData.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(networkingData.every((node) => node.cards[0].paragraphs.length >= 3));
  networkingData.forEach(assertFirstLookExplainsBeforeSolving);
  const networkQualityFirstLook = networkingData.find((node) => node.nodeId === "game-technology-latency-jitter-loss-bandwidth-and-player-perception").cards[0];
  assert.match(networkQualityFirstLook.eyebrow, /80ms Ping/u);
  assert.match(networkQualityFirstLook.paragraphs.join(""), /80 毫秒/u);
  assert.doesNotMatch(networkQualityFirstLook.paragraphs.join(""), /60 毫秒/u);
  assert.ok(networkingData.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(networkingData.every((node) => node.learningResources.length >= 4));
  assert.ok(networkingData.every((node) => node.sources.some((source) => /network|client|server|peer|host|authority|latency|jitter|loss|bandwidth|replication|interest|priority|prediction|reconciliation|smoothing|lobby|session|presence|auth|backend|save|economy|telemetry|security|cheat|operations/u.test(source.role))));
});

test("AI 与程序化生成从可解释行动进入导航、决策结构、可解生成、分布评估、模型部署与生成资产责任", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const aiProcedural = nodes.filter((node) => node.domainId === "game" && node.branchId === "technology" && node.topicId === "game-technology-ai-procedural-generation");
  assert.deepEqual(aiProcedural.map((node) => node.nodeId), [
    "game-technology-game-ai-perception-decision-action-and-debug",
    "game-technology-pathfinding-navigation-steering-and-dynamic-worlds",
    "game-technology-behavior-trees-state-machines-planners-and-utility",
    "game-technology-procedural-generation-representation-constraints-and-solvability",
    "game-technology-generation-evaluation-curation-diversity-and-repetition",
    "game-technology-machine-learning-model-data-inference-and-runtime-boundaries",
    "game-technology-generative-ai-authorship-rights-safety-and-editability",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(aiProcedural.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(aiProcedural.every((node) => node.cards.length >= 18));
  assert.ok(aiProcedural.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(aiProcedural.every((node) => node.cards[0].paragraphs.length >= 3));
  aiProcedural.forEach(assertFirstLookExplainsBeforeSolving);
  assert.ok(aiProcedural.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(aiProcedural.every((node) => node.learningResources.length >= 4));
  assert.ok(aiProcedural.every((node) => node.sources.some((source) => /ai|perception|decision|action|debug|path|navigation|steering|behavior|state|planner|utility|procedural|generation|constraint|solvability|evaluation|curation|diversity|machine-learning|model|data|inference|runtime|generative|authorship|rights|safety|editability/u.test(source.role))));
});

test("跨平台与移植从进入顺序进入输入等价、持续预算、显示适配、平台服务、发行与长期维护", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const crossPlatform = nodes.filter((node) => node.domainId === "game" && node.branchId === "technology" && node.topicId === "game-technology-cross-platform-porting");
  assert.deepEqual(crossPlatform.map((node) => node.nodeId), [
    "game-technology-platform-matrix-requirements-risk-and-port-order",
    "game-technology-input-device-capability-remapping-and-equivalence",
    "game-technology-performance-memory-storage-power-and-thermal-budgets",
    "game-technology-display-aspect-density-safe-area-and-interface-adaptation",
    "game-technology-platform-services-save-achievements-commerce-and-identity",
    "game-technology-certification-age-rating-privacy-store-and-release-operations",
    "game-technology-port-branches-vendor-partners-patches-and-parity",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(crossPlatform.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(crossPlatform.every((node) => node.cards.length >= 18));
  assert.ok(crossPlatform.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(crossPlatform.every((node) => node.cards[0].paragraphs.length >= 3));
  crossPlatform.forEach(assertFirstLookExplainsBeforeSolving);
  assert.ok(crossPlatform.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(crossPlatform.every((node) => node.learningResources.length >= 4));
  assert.ok(crossPlatform.every((node) => node.sources.some((source) => /platform|matrix|port|risk|input|device|remapping|equivalence|performance|memory|storage|power|thermal|display|aspect|density|safe-area|service|save|achievement|commerce|identity|certification|rating|privacy|store|release|branch|vendor|partner|patch|parity/u.test(source.role))));
  const technology = nodes.filter((node) => node.domainId === "game" && node.branchId === "technology");
  assert.equal(technology.length, 49);
  technology.forEach(assertFirstLookExplainsBeforeSolving);
});

test("市场与用户从选择边界进入分群定位、需求信号、证据偏差、规模情景与产品决定权", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const marketUsers = nodes.filter((node) => node.domainId === "game" && node.branchId === "industry" && node.topicId === "game-industry-market-users");
  assert.deepEqual(marketUsers.map((node) => node.nodeId), [
    "game-industry-market-boundary-category-player-context-and-substitutes",
    "game-industry-player-segments-jobs-contexts-and-underserved-needs",
    "game-industry-competitors-alternatives-attention-and-positioning",
    "game-industry-demand-signals-wishlists-follows-demos-and-playtests",
    "game-industry-market-research-samples-bias-and-evidence",
    "game-industry-market-sizing-price-regions-and-scenarios",
    "game-industry-market-feedback-decision-rights-and-product-boundaries",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(marketUsers.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(marketUsers.every((node) => node.cards.length >= 18));
  assert.ok(marketUsers.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(marketUsers.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(marketUsers.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(marketUsers.every((node) => node.learningResources.length >= 4));
  assert.ok(marketUsers.every((node) => node.sources.some((source) => /market|category|player|context|substitute|segment|job|need|competitor|alternative|attention|position|demand|signal|wishlist|demo|playtest|research|sample|bias|evidence|sizing|price|region|scenario|feedback|decision|product|boundary/u.test(source.role))));
  marketUsers.forEach(assertFirstLookExplainsBeforeSolving);
});

test("商业模式从一次购买进入订阅、免费、广告、附加内容、混合权益与可持续单位经济", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const businessModels = nodes.filter((node) => node.domainId === "game" && node.branchId === "industry" && node.topicId === "game-industry-business-models");
  assert.deepEqual(businessModels.map((node) => node.nodeId), [
    "game-industry-premium-price-ownership-value-and-discount",
    "game-industry-subscription-access-catalog-and-retention",
    "game-industry-free-to-play-acquisition-retention-and-monetization",
    "game-industry-advertising-attention-privacy-and-player-cost",
    "game-industry-dlc-expansion-season-pass-and-content-commitment",
    "game-industry-hybrid-model-currency-battle-pass-and-entitlements",
    "game-industry-unit-economics-lifetime-value-ethics-and-sustainability",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(businessModels.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(businessModels.every((node) => node.cards.length >= 18));
  assert.ok(businessModels.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(businessModels.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(businessModels.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(businessModels.every((node) => node.learningResources.length >= 4));
  assert.ok(businessModels.every((node) => node.sources.some((source) => /premium|price|package|discount|refund|subscription|access|renewal|retention|free-to-play|monetization|currency|advertis|attention|tracking|privacy|dlc|season-pass|content|promise|hybrid|entitlement|transaction|unit-economics|lifetime-value|cash|harm|trust|sustain/u.test(source.role))));
  businessModels.forEach(assertFirstLookExplainsBeforeSolving);
});

test("发行商与平台从可验证增量进入付款瀑布、平台依赖、自发行、地区交付、作品权利与合作退出", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const publishersPlatforms = nodes.filter((node) => node.domainId === "game" && node.branchId === "industry" && node.topicId === "game-industry-publishers-platforms");
  assert.deepEqual(publishersPlatforms.map((node) => node.nodeId), [
    "game-industry-publisher-capital-services-risk-and-value",
    "game-industry-publishing-deal-advance-recoup-revenue-and-waterfall",
    "game-industry-platform-holder-access-featuring-rules-and-dependency",
    "game-industry-self-publishing-capability-cost-and-control",
    "game-industry-distribution-porting-localization-and-regional-partners",
    "game-industry-rights-ownership-approval-creative-control-and-sequels",
    "game-industry-due-diligence-negotiation-milestones-breach-and-exit",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(publishersPlatforms.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(publishersPlatforms.every((node) => node.cards.length >= 18));
  assert.ok(publishersPlatforms.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(publishersPlatforms.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(publishersPlatforms.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(publishersPlatforms.every((node) => node.learningResources.length >= 4));
  assert.ok(publishersPlatforms.every((node) => node.sources.some((source) => /publisher|capital|service|risk|deal|advance|recoup|royalty|waterfall|platform|access|release|visibility|self-publish|localization|regional|partner|rights|ownership|license|sequel|approval|due-diligence|milestone|breach|termination|exit/u.test(source.role))));
  publishersPlatforms.forEach(assertFirstLookExplainsBeforeSolving);
});

test("商店定价与愿望单从当前承诺进入视觉证据、发现关系、地区价格、促销等待、兴趣队列与净漏斗", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const storePricingWishlists = nodes.filter((node) => node.domainId === "game" && node.branchId === "industry" && node.topicId === "game-industry-store-pricing-wishlists");
  assert.deepEqual(storePricingWishlists.map((node) => node.nodeId), [
    "game-industry-store-page-player-promise-and-current-facts",
    "game-industry-capsule-trailer-screenshot-and-visual-proof",
    "game-industry-tags-categories-discovery-and-similarity",
    "game-industry-pricing-value-reference-regions-and-currency",
    "game-industry-discount-depth-cadence-bundles-and-price-integrity",
    "game-industry-wishlist-intent-notification-cohort-and-conversion",
    "game-industry-store-funnel-traffic-conversion-refund-and-experiment",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(storePricingWishlists.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(storePricingWishlists.every((node) => node.cards.length >= 18));
  assert.ok(storePricingWishlists.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(storePricingWishlists.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(storePricingWishlists.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(storePricingWishlists.every((node) => node.learningResources.length >= 4));
  assert.ok(storePricingWishlists.every((node) => node.sources.some((source) => /store|page|player|promise|current|capsule|trailer|screenshot|visual|proof|tag|category|discover|similar|price|value|region|currency|discount|cadence|bundle|wishlist|intent|notification|cohort|conversion|funnel|traffic|refund|experiment/u.test(source.role))));
  storePricingWishlists.forEach(assertFirstLookExplainsBeforeSolving);
});

test("宣传媒体与节展从可证明定位进入活动选择、可持续公开、独立创作者、媒体关系、玩家学习与营销记忆", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const marketingMediaFestivals = nodes.filter((node) => node.domainId === "game" && node.branchId === "industry" && node.topicId === "game-industry-marketing-media-festivals");
  assert.deepEqual(marketingMediaFestivals.map((node) => node.nodeId), [
    "game-industry-positioning-message-proof-and-audience-language",
    "game-industry-campaign-goal-audience-channel-format-and-budget",
    "game-industry-development-content-devlog-trailer-and-editorial-rhythm",
    "game-industry-creators-streamers-coverage-disclosure-and-fit",
    "game-industry-press-pitch-review-embargo-assets-and-relationship",
    "game-industry-festival-showcase-demo-booth-and-player-learning",
    "game-industry-launch-calendar-attribution-limits-and-marketing-memory",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(marketingMediaFestivals.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(marketingMediaFestivals.every((node) => node.cards.length >= 18));
  assert.ok(marketingMediaFestivals.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(marketingMediaFestivals.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(marketingMediaFestivals.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(marketingMediaFestivals.every((node) => node.learningResources.length >= 4));
  assert.ok(marketingMediaFestivals.every((node) => node.sources.some((source) => /position|message|proof|audience|campaign|channel|budget|development|devlog|trailer|creator|streamer|disclosure|press|review|embargo|festival|showcase|demo|booth|launch|calendar|attribution|marketing-memory/u.test(source.role))));
  marketingMediaFestivals.forEach(assertFirstLookExplainsBeforeSolving);
});

test("社区与长期运营从目的边界进入代表性、安全审核、产品决定、更新信任、玩家疲劳与负责任日落", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const communityLiveOperations = nodes.filter((node) => node.domainId === "game" && node.branchId === "industry" && node.topicId === "game-industry-community-live-operations");
  assert.deepEqual(communityLiveOperations.map((node) => node.nodeId), [
    "game-industry-community-purpose-boundary-expectation-and-channel",
    "game-industry-playtest-core-community-access-and-representativeness",
    "game-industry-moderation-rules-tools-labor-and-escalation",
    "game-industry-feedback-roadmap-decision-rights-and-communication",
    "game-industry-update-cadence-patch-notes-and-player-trust",
    "game-industry-live-operations-events-seasons-economy-and-fatigue",
    "game-industry-maintenance-level-sunset-data-export-and-archive",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(communityLiveOperations.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(communityLiveOperations.every((node) => node.cards.length >= 18));
  assert.ok(communityLiveOperations.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(communityLiveOperations.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(communityLiveOperations.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(communityLiveOperations.every((node) => node.learningResources.length >= 4));
  assert.ok(communityLiveOperations.every((node) => node.sources.some((source) => /community|purpose|boundary|playtest|access|sample|feedback|moderation|rule|safety|decision|roadmap|update|patch|trust|live-operations|season|economy|sunset|maintenance|archive/u.test(source.role))));
  communityLiveOperations.forEach(assertFirstLookExplainsBeforeSolving);
});

test("版权分级与政策从连续权利证据进入名称资产玩家创作分级自主与动态发布边界", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const copyrightRatingPolicy = nodes.filter((node) => node.domainId === "game" && node.branchId === "industry" && node.topicId === "game-industry-copyright-rating-policy");
  assert.deepEqual(copyrightRatingPolicy.map((node) => node.nodeId), [
    "game-industry-copyright-authorship-chain-of-title-and-work-for-hire",
    "game-industry-trademark-title-brand-domain-and-clearance",
    "game-industry-music-voice-font-image-code-and-third-party-licenses",
    "game-industry-ugc-mod-terms-license-moderation-and-removal",
    "game-industry-age-rating-content-descriptors-regions-and-updates",
    "game-industry-privacy-consumer-protection-children-and-refunds",
    "game-industry-territory-platform-policy-ai-disclosure-and-legal-review",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(copyrightRatingPolicy.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(copyrightRatingPolicy.every((node) => node.cards.length >= 18));
  assert.ok(copyrightRatingPolicy.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(copyrightRatingPolicy.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(copyrightRatingPolicy.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(copyrightRatingPolicy.every((node) => node.learningResources.length >= 4));
  assert.ok(copyrightRatingPolicy.every((node) => node.sources.some((source) => /copyright|author|chain|work-for-hire|trademark|clearance|license|music|voice|font|image|code|ugc|mod|terms|moderation|rating|content-descriptor|privacy|consumer|children|refund|territory|platform-policy|ai|disclosure|legal-review/u.test(source.role))));
  copyrightRatingPolicy.forEach(assertFirstLookExplainsBeforeSolving);
});

test("独立工作室经营从最小治理进入现金组合净产能后台韧性与创始人连续性", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes, warnings } = await readDomainKnowledgeNodes(vaultRoot);
  const studioOperations = nodes.filter((node) => node.domainId === "game" && node.branchId === "industry" && node.topicId === "game-industry-independent-studio-operations");
  assert.deepEqual(studioOperations.map((node) => node.nodeId), [
    "game-industry-studio-entity-ownership-roles-and-governance",
    "game-industry-runway-cashflow-revenue-timing-and-scenarios",
    "game-industry-product-portfolio-sequels-prototypes-and-option-value",
    "game-industry-hiring-employment-contractors-outsourcing-and-capacity",
    "game-industry-accounting-tax-contract-admin-and-operational-controls",
    "game-industry-risk-reserves-insurance-security-and-business-continuity",
    "game-industry-founder-health-succession-shutdown-and-creative-continuity",
  ]);
  assert.deepEqual(warnings.filter((warning) => warning.source.includes("70_专题研究/游戏/知识节点")), []);
  assert.ok(studioOperations.reduce((total, node) => total + node.cards.length, 0) >= 126);
  assert.ok(studioOperations.every((node) => node.cards.length >= 18));
  assert.ok(studioOperations.reduce((total, node) => total + node.learningResources.length, 0) >= 28);
  assert.ok(studioOperations.every((node) => node.cards[0].paragraphs.length >= 3));
  assert.ok(studioOperations.every((node) => node.cards.at(-1).id.endsWith("-learning-path")));
  assert.ok(studioOperations.every((node) => node.learningResources.length >= 4));
  assert.ok(studioOperations.every((node) => node.sources.some((source) => /studio|entity|governance|runway|cashflow|portfolio|prototype|hiring|employee|contractor|outsourcing|accounting|tax|admin|risk|reserve|insurance|security|continuity|founder|health|shutdown|succession|creative/u.test(source.role))));
  studioOperations.forEach(assertFirstLookExplainsBeforeSolving);
});

test("产业分支全部正式节点先解释对象、案例与使用场景", async () => {
  const vaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { nodes } = await readDomainKnowledgeNodes(vaultRoot);
  const industryNodes = nodes.filter((node) => node.domainId === "game" && node.branchId === "industry");
  assert.equal(industryNodes.length, 56);
  industryNodes.forEach(assertFirstLookExplainsBeforeSolving);
});

test("超过二十一张卡的节点仍能保存末页阅读位置", () => {
  const progress = normalizeDomainResearchProgress({
    lastPosition: {
      domainId: "game",
      branchId: "expression",
      nodeId: "game-expression-localization-function-context-and-performance",
      cardId: "game-expression-localization-function-context-and-performance-learning-path",
      cardIndex: 22,
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
  });
  assert.equal(progress.lastPosition?.cardIndex, 22);
  assert.equal(progress.lastPositions.game?.cardIndex, 22);
});

test("超过六百条旧进度不再被静默截断", () => {
  const cards = Object.fromEntries(Array.from({ length: 801 }, (_, index) => [`legacy-${index}`, { status: "overview", updatedAt: "2026-08-25" }]));
  assert.equal(Object.keys(normalizeDomainResearchProgress({ cards }).cards).length, 801);
});

test("八母题入口顺序固定且经济金融 ID 不变", () => {
  assert.deepEqual(RESEARCH_DOMAIN_IDS, ["game", "ai", "economics-finance", "language", "thought-history", "zztj", "image-management", "fitness"]);
});
