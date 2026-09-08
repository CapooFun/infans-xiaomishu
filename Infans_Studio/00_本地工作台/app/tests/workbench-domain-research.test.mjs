import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const topics = readFileSync(new URL("../src/pages/TopicsPage.tsx", import.meta.url), "utf8");
const domainView = readFileSync(new URL("../src/pages/topics/DomainResearchView.tsx", import.meta.url), "utf8");
const domains = readFileSync(new URL("../src/pages/topics/domain-research-domains.ts", import.meta.url), "utf8");
const cardContent = readFileSync(new URL("../src/pages/topics/domain-research-cards.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/pages/topics/domain-research.css", import.meta.url), "utf8");
const home = readFileSync(new URL("../src/pages/HomePage.tsx", import.meta.url), "utf8");
const homeMeta = readFileSync(new URL("../src/pages/topics/domain-research-home.ts", import.meta.url), "utf8");
const positionMemory = readFileSync(new URL("../src/workbench-position-memory.ts", import.meta.url), "utf8");

test("专题研究位于艺术馆藏之前并保留稳定 topics 路由", () => {
  const navStart = main.indexOf("const NAV_ITEMS");
  const navEnd = main.indexOf("const PRIMARY_NAV_PATHS", navStart);
  const nav = main.slice(navStart, navEnd);
  assert.ok(nav.indexOf('label: "专题研究"') < nav.indexOf('label: "艺术馆藏"'));
  assert.match(nav, /path: "\/topics", label: "专题研究"/u);
  assert.match(main, /"\/topics": \{ title: "专题研究"/u);
});

test("领域研究只把知识地图作为前台入口，课程原件不再并列导航", () => {
  assert.ok(topics.includes('type TopicView = "domains" | "materials" | "archive"'));
  assert.ok(topics.includes("<DomainResearchHome"));
  assert.ok(topics.includes("<DomainKnowledgeMap"));
  assert.equal(topics.includes('aria-label="专题研究视图"'), false);
  assert.equal(domainView.includes("domain-secondary-entries"), false);
  assert.equal(topics.includes("<span>学习中</span>"), false);
  assert.equal(topics.includes("<span>已学完</span>"), false);
  assert.match(positionMemory, /"\/topics": \["tab", "domain", "branch", "node", "card", "open", "course"\]/u);
});

test("游戏领域按确认总纲铺开七个分支与统一研究结构", () => {
  for (const label of ["游戏史、文化与批评", "玩家、社群与社会", "游戏设计与体验", "叙事、视觉与声音", "游戏制作、团队与管线", "技术、引擎与平台", "产业、商业、法律与发行"]) {
    assert.ok(domainView.includes(label));
  }
  assert.ok(domainView.includes('"players"'));
  assert.ok(domainView.includes("统一研究结构"));
  assert.ok(domainView.includes("不会自动生成项目任务"));
  assert.ok(domainView.includes("正在理解"));
  assert.ok(domainView.includes("待探索"));
  assert.ok(domainView.includes("仍不清楚"));
  assert.ok(domainView.includes("想继续看"));
  assert.ok(domainView.includes("最近看过"));
  assert.ok(domainView.includes("readingCluesCollapsed"));
  assert.ok(domainView.includes("向右折叠阅读线索"));
  assert.ok(domainView.includes("展开阅读线索"));
  assert.equal(domainView.includes("添加知识"), false);
  assert.match(styles, /\.knowledge-map-layout \{[^}]*grid-template-columns:/u);
  assert.match(styles, /\.knowledge-map-layout\.is-reading-clues-collapsed \{[^}]*54px/u);
  assert.match(styles, /\.knowledge-map-gaps\.is-collapsed \{[^}]*width:54px/u);
  assert.match(styles, /\.knowledge-node-grid \{[^}]*repeat\(auto-fit,minmax\(min\(100%,360px\),1fr\)\)/u);
  assert.match(styles, /@media \(max-width:1180px\)[\s\S]*?\.knowledge-node-grid \{ grid-template-columns:1fr/u);
  assert.match(styles, /@media \(max-width:900px\)/u);
  assert.match(styles, /@media \(max-width:620px\)/u);
  for (const topicId of ["game-design-core-play", "game-design-systems-economy", "game-design-space-world", "game-design-interactive-narrative", "game-design-interaction-feedback", "game-design-challenge-accessibility"]) assert.ok(domainView.includes(topicId));
  for (const topicId of ["game-culture-history-media-evolution", "game-culture-genre-genealogy", "game-culture-creators-studios", "game-culture-close-reading", "game-culture-criticism-aesthetics", "game-culture-preservation-memory"]) assert.ok(domainView.includes(topicId));
  for (const topicId of ["game-production-concept-greenlight", "game-production-prototype-preproduction", "game-production-disciplines-collaboration", "game-production-content-pipeline", "game-production-project-version-management", "game-production-testing-collaboration", "game-production-independent-development"]) assert.ok(domainView.includes(topicId));
  for (const topicId of ["game-technology-engines-tools", "game-technology-software-architecture-data", "game-technology-graphics-performance", "game-technology-animation-physics-audio", "game-technology-networking-data", "game-technology-ai-procedural-generation", "game-technology-cross-platform-porting"]) assert.ok(domainView.includes(topicId));
  for (const topicId of ["game-industry-market-users", "game-industry-business-models", "game-industry-publishers-platforms", "game-industry-store-pricing-wishlists", "game-industry-marketing-media-festivals", "game-industry-community-live-operations", "game-industry-copyright-rating-policy", "game-industry-independent-studio-operations"]) assert.ok(domainView.includes(topicId));
  assert.match(domainView, /id: "industry",[\s\S]{0,500}status: "正在理解"/u);
});

test("八个母题都按全面和深入两个维度进入知识地图", () => {
  for (const id of ["game", "ai", "language", "thought-history", "zztj", "image-management", "fitness", "economics-finance"]) assert.ok(topics.includes(id) || domainView.includes(id) || domains.includes(id));
  for (const label of ["搜索、规划与优化", "语言研究", "思想史", "资治通鉴", "形象管理", "运动健身"]) assert.ok(domains.includes(label));
  for (const label of ["人物名场面与长线索引", "苏秦：二顷田与六国相印", "李斯：《谏逐客书》", "司马相如：文化语码", "刘向：目录学与知识秩序"]) assert.ok(domains.includes(label));
  assert.match(domainView, /domain-card-stack/u);
  assert.match(styles, /domain-card-ai/u);
  assert.match(styles, /domain-card-zztj/u);
  assert.match(styles, /domain-card-finance/u);
  for (const label of ["数量方法与金融数据", "宏观经济、政策与周期", "市场结构、交易与结算", "固定收益与信用", "衍生品、杠杆与对冲", "法规、税务、伦理与投资者保护"]) assert.ok(domains.includes(label));
  const financeMap = domains.slice(domains.indexOf("export const ECONOMICS_FINANCE_DOMAIN"));
  assert.equal(financeMap.match(/branch\(\{ id: "ef-/gu)?.length, 16);
  assert.equal(financeMap.match(/financeNode\("/gu)?.length ?? 0, 0);
  assert.match(domains, /常见的理解缺口/u);
});

test("人工智能知识地图保留完整稳定树，开源示例不带私人学习记录", () => {
  assert.match(domains, /ai-history-math-01/u);
  assert.match(domains, /ai-learning-generative-09/u);
  assert.match(domains, /ai-agents-robotics-07/u);
  assert.match(domains, /ai-society-08/u);
  assert.match(domainView, /mappedNodes/u);
  assert.match(domainView, /knowledge-outline-node/u);
  assert.match(domainView, /纲目已建立，内容待补/u);
  assert.match(domainView, /查看绕不开材料/u);
  assert.match(domainView, /outlineResources\.length/u);
  assert.match(styles, /\.knowledge-outline-node/u);
  assert.match(styles, /\.knowledge-outline-resources/u);
  assert.match(domainView, /domainId === "ai" \? branchResearchStatusFromFormalNodes\(formalNodes\.length\) : branch\.status/u);
  assert.match(cardContent, /formalNodeCount > 0 \? "正在理解" : "待探索"/u);
  const aiDomainSource = domains.slice(domains.indexOf("export const FULL_AI_DOMAIN"), domains.indexOf("export const LANGUAGE_DOMAIN"));
  const configuredBranchIds = [...aiDomainSource.matchAll(/branch\(\{ id: "([^"]+)"/gu)].map((match) => match[1]);
  const configuredTopicIds = new Set([...aiDomainSource.matchAll(/topic\("([^"]+)"/gu)].map((match) => match[1]));
  assert.equal(new Set(configuredBranchIds).size, 9);
  assert.equal(configuredTopicIds.size, 65);
});

test("母题首页使用单焦点展开与单个首页置顶", () => {
  assert.match(domainView, /focusedDomainId/u);
  assert.match(domainView, /domain-compact-grid/u);
  assert.match(domainView, /点开另一张，当前母题会自动收起/u);
  assert.match(domainView, /aria-pressed=\{pinnedDomainId === domain\.id\}/u);
  assert.match(styles, /\.domain-compact-grid \{[^}]*repeat\(3/u);
  assert.match(styles, /@media \(max-width:1180px\) \{[^}]*\.domain-compact-grid \{ grid-template-columns:repeat\(2/u);
  assert.match(styles, /@media \(max-width:620px\)[\s\S]*\.domain-compact-grid \{ grid-template-columns:1fr/u);
  assert.match(home, /researchDomainHomeMeta\(pins\.researchDomainId, data\.library\.topics\)/u);
  assert.match(home, /pinnedDomain\.defaultBranch/u);
  assert.match(homeMeta, /item\.sourcePath\.endsWith\("资治通鉴\/资治通鉴_总览\.md"\)/u);
  assert.match(homeMeta, /focusTitle: `第\$\{progress\[1\]\}季 · 第 \$\{Number\(progress\[2\]\)\} 讲`/u);
  assert.match(domainView, />\s*进入专题<ChevronRight/u);
  assert.match(domainView, />继续上次学习<\/button>/u);
  assert.match(topics, /onStart=\{\(nextDomainId\) => enterDomainAt\(nextDomainId, null\)\}/u);
  assert.doesNotMatch(domainView, /\? "继续上次" : "开始浏览"/u);
  assert.doesNotMatch(domainView, /展开并继续/u);
  for (const id of ["game", "ai", "language", "thought-history", "zztj", "image-management", "fitness", "economics-finance"]) assert.ok(homeMeta.includes(`id: ${JSON.stringify(id)}`));
});

test("iPad 点读层一屏一卡、三态直点并能把当前内容交给秘书", () => {
  assert.match(domainView, /role="dialog"/u);
  assert.match(domainView, /观其大略/u);
  assert.match(domainView, /还不清楚/u);
  assert.match(domainView, /想深挖/u);
  assert.match(domainView, /让秘书讲解/u);
  assert.match(domainView, /打开后可继续语音问/u);
  assert.match(domainView, /moveRelative\(1\)/u);
  assert.match(topics, /\/api\/domain-research-progress/u);
  assert.match(cardContent, /不要一上来考我/u);
  assert.match(cardContent, /讲完后我会继续用文字或语音追问/u);
  assert.match(styles, /\.knowledge-reader \{[^}]*position:fixed/u);
  assert.match(styles, /env\(safe-area-inset-bottom/u);
  assert.match(styles, /\.knowledge-reader-topbar \{[^}]*safe-area-inset-top[^}]*safe-area-inset-right[^}]*safe-area-inset-left/u);
  assert.match(styles, /@media \(max-width:620px\)[\s\S]*\.knowledge-reader-topbar \{[^}]*safe-area-inset-left[^}]*safe-area-inset-right/u);
  assert.match(styles, /@media \(max-width:620px\)[\s\S]*\.knowledge-reader-actions \{[^}]*safe-area-inset-right[^}]*safe-area-inset-bottom[^}]*safe-area-inset-left/u);
  assert.match(domainView, /主题内垂直学习梯/u);
  assert.match(domainView, /learningLevelLabel/u);
  assert.match(domainView, /查看本节点 \$\{learningResourceCount\} 项延展资源/u);
  assert.match(domainView, /knowledge-reader-resource-count/u);
  assert.match(domainView, /knowledge-reader-resource-label/u);
  assert.match(domainView, /target="_blank" rel="noopener noreferrer"/u);
  assert.doesNotMatch(domainView, /obsidianHref|Obsidian 资料/u);
  assert.match(domainView, /核对来源与边界/u);
  assert.match(domainView, /本地资料/u);
  assert.match(domainView, /"capoo-learning-record": "学习笔记"/u);
  assert.match(domainView, /已用于合并本页正文/u);
  assert.doesNotMatch(domainView, /obsidianHref\(record\.sourcePath\)/u);
  assert.match(domainView, /\{cards\.length\} 张/u);
  assert.match(domainView, /下一节点/u);
  assert.match(domainView, /返回知识地图/u);
  assert.match(styles, /\.knowledge-learning-shelf/u);
  assert.match(styles, /\.knowledge-reader-resource-jump \{[^}]*min-height:44px/u);
  assert.match(styles, /@media \(max-width:620px\)[\s\S]*\.knowledge-reader-resource-label \{ display:none/u);
  assert.doesNotMatch(styles, /\.knowledge-reader-resource-jump span \{ display:none/u);
});

test("开源知识地图保留学习状态壳，不附带私人学习记录", () => {
  assert.match(domainView, /knowledge-outline-learning/u);
  assert.match(domainView, /learningStateLabel\(node\.learningState\)/u);
  assert.match(styles, /\.knowledge-outline-node\.has-learning-records/u);
  assert.doesNotMatch(domainView, /没有人推着我/u);
  assert.doesNotMatch(domains, /sourceConversationId/u);
});
