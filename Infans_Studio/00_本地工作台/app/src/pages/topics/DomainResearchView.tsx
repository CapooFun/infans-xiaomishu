import { useEffect, useMemo, useRef, useState } from "react";
import { PageTrail } from "../../shell/PageNavigation";
import { navigationHref } from "../../shell/page-navigation-model";
import { createPortal } from "react-dom";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Brain,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Compass,
  Cpu,
  ExternalLink,
  FileText,
  FolderTree,
  Gamepad2,
  Hammer,
  History,
  Landmark,
  Library,
  Languages,
  Link2,
  Lightbulb,
  MessageCircle,
  PenTool,
  Puzzle,
  Search,
  Shirt,
  Shuffle,
  Sparkles,
  Star,
  Store,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import type { DomainKnowledgeNode, DomainResearchSummary } from "../../types";
import {
  buildKnowledgeCards,
  buildKnowledgeExplainSeed,
  branchResearchStatusFromFormalNodes,
  knowledgeNodeId,
  learningLevelLabel,
  orderKnowledgeNodesByTopics,
  type KnowledgeCard,
  type KnowledgeCardStatus,
  type KnowledgeNodeInput,
} from "./domain-research-cards";
import {
  type DomainIconKey,
  type DomainId,
  type ResearchDomain as CatalogDomain,
  type ResearchBranch as CatalogBranch,
} from "./domain-research-catalog";
import {
  ECONOMICS_FINANCE_DOMAIN,
  FITNESS_DOMAIN,
  FULL_AI_DOMAIN,
  IMAGE_MANAGEMENT_DOMAIN,
  LANGUAGE_DOMAIN,
  THOUGHT_HISTORY_DOMAIN,
  ZZTJ_DOMAIN,
} from "./domain-research-domains";
import { RESEARCH_DOMAIN_IDS } from "./domain-research-home";
import "./domain-research.css";

type ResearchBranch = {
  id: string;
  title: string;
  cardSummary: string;
  summary: string;
  guidingQuestion: string;
  status: "正在理解" | "待探索";
  icon: LucideIcon;
  nodes: CatalogBranch["nodes"];
  formalNodes?: KnowledgeNodeInput[];
  mappedNodes?: KnowledgeNodeInput[];
  starterQuestions: string[];
};

export type ResearchDomainView = {
  id: DomainId;
  title: string;
  mark: string;
  description: string;
  mapLead: string;
  cardClass: string;
  icon: LucideIcon;
  branches: ResearchBranch[];
  researchSummary?: DomainResearchSummary;
};

export type DomainResearchPosition = {
  domainId: string;
  branchId: string;
  nodeId: string;
  cardId: string;
  cardIndex: number;
  updatedAt: string;
};

export type DomainResearchProgress = {
  schemaVersion: 1;
  cards: Record<string, { status: KnowledgeCardStatus; updatedAt: string }>;
  choices: Record<string, { choiceId: string; updatedAt: string }>;
  lastPosition: null | DomainResearchPosition;
  lastPositions: Record<string, DomainResearchPosition>;
  recentCardIds: string[];
};

export type DomainResearchProgressUpdate = {
  cardId: string;
  status?: KnowledgeCardStatus;
  choiceId?: string;
  position: {
    domainId: DomainId;
    branchId: string;
    nodeId: string;
    cardId: string;
    cardIndex: number;
  };
};

const GAME_BRANCHES: ResearchBranch[] = [
  {
    id: "culture",
    title: "游戏史、文化与批评",
    cardSummary: "从历史、类型与重要作品理解游戏怎样形成意义。",
    summary: "从游戏史、类型谱系和重要作品出发，研究媒介演化、创作者选择与整体艺术表达。",
    guidingQuestion: "游戏为何在特定时代变成现在的样子，一部作品又如何在机制、表达与文化中留下位置？",
    status: "正在理解",
    icon: BookOpen,
    nodes: [
      { id: "game-culture-history-media-evolution", title: "游戏史与媒介演化", description: "从硬件、商业环境、技术条件和玩家习惯理解电子游戏不同阶段的变化。" },
      { id: "game-culture-genre-genealogy", title: "类型谱系", description: "观察 MMO、RPG、动作冒险、魂系和开放世界等类型如何形成惯例并相互影响。" },
      { id: "game-culture-creators-studios", title: "重要创作者与公司", description: "研究关键作者、团队和公司的方法、组织能力与时代限制，不把作品只归因于个人天才。" },
      { id: "game-culture-close-reading", title: "代表作品精读", description: "把机制、空间、叙事、音乐、表演和玩家行动放在一起，理解作品为何成立。" },
      { id: "game-culture-criticism-aesthetics", title: "游戏批评与审美", description: "建立可以说明判断的语言，区分个人偏爱、艺术完成度、设计成效与历史影响。" },
      { id: "game-culture-preservation-memory", title: "保存与再发现", description: "关注旧游戏、版本、服务器、档案和玩家记忆怎样被保存，以及失去后意味着什么。" },
    ],
    starterQuestions: [
      "一部作品的历史位置应该由创新、影响、完成度还是个人经验决定？",
      "类型名称帮助理解作品的同时，会不会也遮蔽真正的差异？",
      "今天重看旧作品时，怎样同时保留时代语境与当下判断？",
    ],
  },
  {
    id: "design",
    title: "游戏设计与体验",
    cardSummary: "理解规则、关卡、叙事与体验如何协同。",
    summary: "研究机制、系统、关卡、叙事与玩家体验怎样共同工作。",
    guidingQuestion: "设计者怎样通过规则、空间和反馈创造有意义的选择，并让玩家愿意持续行动？",
    status: "正在理解",
    icon: Puzzle,
    nodes: [
      { id: "game-design-core-play", title: "行动、规则与循环", description: "从玩家能做什么、想达成什么、规则怎样限制和系统如何反馈，理解最小可玩结构怎样形成。" },
      { id: "game-design-systems-economy", title: "系统、资源与经济", description: "研究资源、成长、数值和规则怎样互相作用，形成长期选择而不是单一路径。" },
      { id: "game-design-space-world", title: "空间、关卡与世界", description: "研究空间怎样引导行动、制造节奏，并让探索与发现真正发生。" },
      { id: "game-design-interactive-narrative", title: "互动叙事与角色", description: "区分作者安排、系统事件与玩家行动，观察角色和后果如何承载情感与主题。" },
      { id: "game-design-interaction-feedback", title: "交互、反馈与手感", description: "理解操作、界面、镜头、声音和反馈怎样共同塑造可读性、控制感与身体体验。" },
      { id: "game-design-challenge-accessibility", title: "挑战、平衡与可访问性", description: "研究挑战、资源、奖励和辅助选项怎样维持选择空间，并让不同玩家能够进入作品。" },
    ],
    starterQuestions: [
      "一个设计问题应该先改规则、数值、信息还是内容？",
      "引导何时帮助玩家理解，何时会夺走发现感？",
      "设计者怎样判断玩家失败是有意义的学习，还是信息与操作出了问题？",
    ],
  },
  {
    id: "production",
    title: "游戏制作、团队与管线",
    cardSummary: "把创意变成能运行、能协作、能交付的作品。",
    summary: "理解不同工种怎样把设计变成可以运行、可以交付的作品。",
    guidingQuestion: "一个创意怎样经过验证、协作和取舍，最终成为质量可控、能够交付的游戏？",
    status: "正在理解",
    icon: Hammer,
    nodes: [
      { id: "game-production-concept-greenlight", title: "创意与立项", description: "明确作品承诺、目标玩家、核心体验和现实约束，让立项不是只有题材与愿望。" },
      { id: "game-production-prototype-preproduction", title: "原型与预制作", description: "用低成本原型验证最危险的假设，并在扩大生产前建立视觉、技术和内容基线。" },
      { id: "game-production-disciplines-collaboration", title: "策划、程序、美术与声音", description: "理解主要工种各自的判断对象、交付物与依赖，减少跨工种翻译损耗。" },
      { id: "game-production-content-pipeline", title: "内容生产管线", description: "研究资源、关卡、文本和配置如何稳定进入游戏，让重复劳动能够被工具和规范承接。" },
      { id: "game-production-project-version-management", title: "项目管理与版本", description: "用范围、里程碑、版本和风险管理维持节奏，避免进度只靠热情和加班。" },
      { id: "game-production-testing-collaboration", title: "测试与协作", description: "把试玩反馈、缺陷、决策和跨工种沟通变成可靠流程，减少返工与认知偏差。" },
      { id: "game-production-independent-development", title: "独立开发方法", description: "研究小团队和个人如何选择规模、复用能力、管理精力，并形成自己的可持续生产方式。" },
    ],
    starterQuestions: [
      "项目最危险的假设是什么，最便宜的验证方法又是什么？",
      "什么时候应该继续打磨，什么时候应该砍掉或停止？",
      "独立开发者怎样在创作完整性、个人精力和商业现实之间取舍？",
    ],
  },
  {
    id: "technology",
    title: "技术、引擎与平台",
    cardSummary: "看懂引擎、性能、网络和平台带来的边界。",
    summary: "理解引擎、图形、网络、性能与平台约束怎样影响游戏。",
    guidingQuestion: "创作者需要理解多少技术，才能做出正确选择、与工程协作，并避免被工具反过来决定作品？",
    status: "正在理解",
    icon: Cpu,
    nodes: [
      { id: "game-technology-engines-tools", title: "引擎与工具", description: "理解通用引擎、编辑器与内容管线分别解决什么问题，又会带来哪些限制。" },
      { id: "game-technology-software-architecture-data", title: "程序架构与数据", description: "理解玩法代码、状态、配置和存档如何组织，使功能能够迭代而不是越改越脆弱。" },
      { id: "game-technology-graphics-performance", title: "图形与性能", description: "建立渲染、资源、帧率和设备预算的基本认识，让视觉选择有技术依据。" },
      { id: "game-technology-animation-physics-audio", title: "动画、物理与声音", description: "理解运动、碰撞和声音系统如何共同提供可信反馈，并影响玩法与资源成本。" },
      { id: "game-technology-networking-data", title: "网络与数据", description: "理解同步、延迟、存档、服务端与数据安全怎样改变玩法和维护成本。" },
      { id: "game-technology-ai-procedural-generation", title: "AI 与程序化生成", description: "辨认 AI 和生成系统在内容、角色、测试与生产中的真实能力、成本、控制方式和风险。" },
      { id: "game-technology-cross-platform-porting", title: "跨平台与移植", description: "研究 PC、主机和移动平台在输入、性能、审核、商店与更新上的差异及移植代价。" },
    ],
    starterQuestions: [
      "哪些技术知识属于创作者的基本素养，哪些只需在项目需要时深入？",
      "工具提高效率的同时，是否正在限制内容结构或审美选择？",
      "AI 与程序化生成怎样保持可控、可编辑和可验证，而不是只增加随机内容？",
    ],
  },
  {
    id: "industry",
    title: "产业、商业、法律与发行",
    cardSummary: "理解作品怎样找到玩家并形成可持续生意。",
    summary: "理解作品怎样进入市场、找到玩家并形成可持续的生意。",
    guidingQuestion: "游戏怎样在市场中被发现、购买和长期支持，创作者又如何建立不伤害作品与玩家的生意？",
    status: "正在理解",
    icon: Store,
    nodes: [
      { id: "game-industry-market-users", title: "市场与用户", description: "理解品类、受众、竞品和愿望单等信号，避免把个人喜好直接当成市场判断。" },
      { id: "game-industry-business-models", title: "商业模式", description: "比较买断、订阅、内购与广告等模式怎样影响产品目标、设计和玩家关系。" },
      { id: "game-industry-publishers-platforms", title: "发行商与平台", description: "研究发行合作、平台规则、资源交换和控制权分配，理解不同发行路径的真实代价。" },
      { id: "game-industry-store-pricing-wishlists", title: "商店、定价与愿望单", description: "理解商店页、定价、折扣、愿望单和转化之间的关系，让市场反馈能够被正确解释。" },
      { id: "game-industry-marketing-media-festivals", title: "宣传、媒体与节展", description: "研究内容传播、创作者合作、媒体报道和线下节展怎样共同决定作品被看见的机会。" },
      { id: "game-industry-community-live-operations", title: "社区与长期运营", description: "理解测试玩家、核心社群、更新节奏和长期沟通怎样影响口碑、迭代与品牌信任。" },
      { id: "game-industry-copyright-rating-policy", title: "版权、分级与政策", description: "建立素材授权、知识产权、分级、隐私和不同地区政策的基本边界。" },
      { id: "game-industry-independent-studio-operations", title: "独立工作室经营", description: "研究现金流、团队规模、外包、产品组合和风险储备，形成能持续创作的经营结构。" },
    ],
    starterQuestions: [
      "市场信号什么时候足以改变产品，什么时候只是在诱导短期追逐？",
      "发行合作带来的资源、分成与控制权应该怎样比较？",
      "独立工作室如何为失败留出空间，而不是把一次发行变成生死赌局？",
    ],
  },
  {
    id: "players",
    title: "玩家、社群与社会",
    cardSummary: "理解游戏中的心理、身份、社群关系与社会影响。",
    summary: "研究玩家为何投入、怎样形成身份与社群，以及游戏如何进入更广泛的社会生活。",
    guidingQuestion: "玩家为何在游戏中投入时间、情感与关系，这些体验又怎样改变个人、社群和现实社会？",
    status: "正在理解",
    icon: UsersRound,
    nodes: [
      { id: "game-players-motivation-psychology", title: "玩家心理与动机", description: "理解掌握、探索、竞争、表达、关系和习惯等动机如何共同影响持续参与。" },
      { id: "game-players-identity-presence", title: "身份与沉浸", description: "研究角色扮演、化身、选择和长期投入怎样形成身份认同、代入感与个人记忆。" },
      { id: "game-players-community-relationships", title: "社群与虚拟关系", description: "理解公会、队伍、师徒、交易和共同事件如何建立信任、归属、冲突与共同历史。" },
      { id: "game-players-mods-ugc-cocreation", title: "MOD、UGC 与共创", description: "研究玩家创作如何延长作品生命、改变作者边界，并形成新的内容与治理问题。" },
      { id: "game-players-streaming-esports", title: "直播、电竞与传播", description: "理解观看、竞技、主播和平台算法怎样改变游戏的设计、影响力与公共形象。" },
      { id: "game-players-harm-ethics-inclusion", title: "成瘾、伦理与包容性", description: "研究时间投入、付费诱导、骚扰、公平和无障碍问题，区分健康参与与有害设计。" },
      { id: "game-players-serious-games-learning", title: "严肃游戏与教育", description: "观察游戏在学习、训练、治疗和公共议题中的可能性，同时警惕把游戏化当成万能工具。" },
    ],
    starterQuestions: [
      "长期投入来自作品本身、社群关系，还是玩家所处的人生阶段？",
      "设计者应如何区分高参与度与对脆弱心理的利用？",
      "玩家共创扩展作品时，作者、平台与社区分别应保留哪些权力？",
    ],
  },
];

const BRANCH_ICONS: Record<DomainIconKey, LucideIcon> = {
  book: BookOpen,
  puzzle: Puzzle,
  hammer: Hammer,
  cpu: Cpu,
  store: Store,
  users: UsersRound,
  atom: Cpu,
  brain: Brain,
  bot: UsersRound,
  wand: Sparkles,
  database: Library,
  scale: CircleHelp,
  languages: BookOpen,
  brackets: Link2,
  library: Library,
  landmark: Store,
  search: Search,
  feather: PenTool,
  history: History,
  bookmark: Bookmark,
  shirt: Shirt,
  activity: Activity,
  map: Compass,
};

function mappedKnowledgeNodes(nodes: DomainKnowledgeNode[], domainId: DomainId, branchId: string, topics: CatalogBranch["nodes"]): KnowledgeNodeInput[] {
  return orderKnowledgeNodesByTopics(
    nodes.filter((node) => node.domainId === domainId && node.branchId === branchId),
    topics.flatMap((topic) => topic.id ? [topic.id] : []),
  )
    .map((node) => ({
      id: node.nodeId,
      topicId: node.topicId,
      status: node.status,
      order: node.order,
      title: node.title,
      description: node.description,
      sourcePath: node.sourcePath,
      asOf: node.asOf,
      jurisdiction: node.jurisdiction,
      claimTypes: node.claimTypes,
      sources: node.sources,
      learningResources: node.learningResources,
      learningState: node.learningState,
      learningRecords: node.learningRecords,
      authoredCards: node.cards,
    }));
}

const LEARNING_STATE_LABELS: Record<NonNullable<KnowledgeNodeInput["learningState"]>, string> = {
  "not-started": "暂无个人学习笔记",
  "session-recorded": "已记录学习会话",
  "initial-understanding": "已有初步认识",
  "can-explain": "能独立解释",
  "can-transfer": "能迁移使用",
  "revisit-needed": "需要复习",
};

function learningStateLabel(state: KnowledgeNodeInput["learningState"]) {
  return LEARNING_STATE_LABELS[state ?? "not-started"];
}

function catalogBranches(domainId: DomainId, branches: CatalogBranch[], knowledgeNodes: DomainKnowledgeNode[]): ResearchBranch[] {
  return branches.map(({ iconKey, ...branch }) => {
    const mapped = mappedKnowledgeNodes(knowledgeNodes, domainId, branch.id, branch.nodes);
    const formalNodes = mapped.filter((node) => node.status === "formal");
    return {
      ...branch,
      status: domainId === "ai" ? branchResearchStatusFromFormalNodes(formalNodes.length) : branch.status,
      icon: BRANCH_ICONS[iconKey],
      mappedNodes: mapped,
      formalNodes,
    };
  });
}

const EXPRESSION_BRANCH: ResearchBranch = {
  id: "expression",
  title: "叙事、视觉与声音",
  cardSummary: "研究文字、空间、美术、动画与声音如何形成整体表达。",
  summary: "把互动叙事、世界观、角色、视觉语言、动画、音乐与声音设计放在玩家行动中共同理解。",
  guidingQuestion: "叙事、视觉和声音怎样与规则互相支持，让表达不是贴在玩法外面的装饰？",
  status: "正在理解",
  icon: PenTool,
  nodes: [
    { id: "game-expression-interactive-narrative-agency", title: "互动叙事与玩家能动性", description: "区分玩家位置、作者编排、系统事件与玩家讲述，理解行动怎样参与意义形成。" },
    { id: "game-expression-worldbuilding-character-text", title: "世界观、角色与文本", description: "研究设定、角色弧光、对白和文本密度怎样服务体验。" },
    { id: "game-expression-environmental-spatial-storytelling", title: "环境叙事与空间表达", description: "观察场景、动线、物件和遗迹如何在不说明时传递信息。" },
    { id: "game-expression-visual-language-art-direction", title: "视觉语言与美术方向", description: "理解形状、色彩、材质、构图和一致性怎样建立可辨认世界。" },
    { id: "game-expression-animation-performance-camera", title: "动画、表演与镜头", description: "研究动作节奏、角色表演和镜头控制怎样传递重量、情绪与信息。" },
    { id: "game-expression-music-sound-audio-space", title: "音乐、音效与声音空间", description: "理解音乐结构、交互音效、语音和空间声场怎样塑造注意与记忆。" },
  ],
  starterQuestions: ["互动怎样参与叙事？", "整体艺术方向如何跨工种保持一致？", "声音何时比画面更能引导玩家？"],
};

const GAME_BRANCH_BY_ID = new Map(GAME_BRANCHES.map((branch) => [branch.id, branch]));
const ORDERED_GAME_BRANCHES = ["culture", "players", "design", "expression", "production", "technology", "industry"].flatMap((id) => {
  if (id === "expression") return [EXPRESSION_BRANCH];
  const current = GAME_BRANCH_BY_ID.get(id);
  return current ? [current] : [];
});

function catalogDomain(domain: CatalogDomain, icon: LucideIcon, knowledgeNodes: DomainKnowledgeNode[]): ResearchDomainView {
  return { ...domain, icon, branches: catalogBranches(domain.id, domain.branches, knowledgeNodes) };
}

export function researchDomains(game: DomainResearchSummary, knowledgeNodes: DomainKnowledgeNode[] = []): ResearchDomainView[] {
  const domains: ResearchDomainView[] = [
    {
      id: "game",
      title: game.title,
      mark: "创作母题",
      description: game.description,
      mapLead: "把看到的知识放进脉络，把不懂的问题留在眼前。",
      cardClass: "domain-card-game",
      icon: Gamepad2,
      branches: ORDERED_GAME_BRANCHES.map((branch) => {
        const mapped = mappedKnowledgeNodes(knowledgeNodes, "game", branch.id, branch.nodes);
        return { ...branch, mappedNodes: mapped, formalNodes: mapped.filter((node) => node.status === "formal") };
      }),
      researchSummary: game,
    },
    catalogDomain(FULL_AI_DOMAIN, Cpu, knowledgeNodes),
    catalogDomain(ECONOMICS_FINANCE_DOMAIN, Landmark, knowledgeNodes),
    catalogDomain(LANGUAGE_DOMAIN, Languages, knowledgeNodes),
    catalogDomain(THOUGHT_HISTORY_DOMAIN, History, knowledgeNodes),
    catalogDomain(ZZTJ_DOMAIN, Bookmark, knowledgeNodes),
    catalogDomain(IMAGE_MANAGEMENT_DOMAIN, Shirt, knowledgeNodes),
    catalogDomain(FITNESS_DOMAIN, Activity, knowledgeNodes),
  ];
  const byId = new Map(domains.map((domain) => [domain.id, domain]));
  return RESEARCH_DOMAIN_IDS.flatMap((domainId) => {
    const domain = byId.get(domainId);
    return domain ? [domain] : [];
  });
}

export function findResearchDomain(game: DomainResearchSummary, domainId: DomainId, knowledgeNodes: DomainKnowledgeNode[] = []) {
  return researchDomains(game, knowledgeNodes).find((domain) => domain.id === domainId) ?? researchDomains(game, knowledgeNodes)[0];
}

export type ReaderTarget = { domainId: DomainId; branchId: string; nodeId: string; cardIndex: number };

function branchCards(branch: ResearchBranch) {
  return (branch.formalNodes ?? []).flatMap((node, nodeIndex) => buildKnowledgeCards(branch, node, nodeIndex));
}

function allDomainCards(domain: ResearchDomainView) {
  return domain.branches.flatMap((branch) => branchCards(branch));
}

export function domainReaderTargets(domain: ResearchDomainView): ReaderTarget[] {
  return domain.branches.flatMap((branch) => (branch.formalNodes ?? []).map((node, nodeIndex) => ({
    domainId: domain.id,
    branchId: branch.id,
    nodeId: knowledgeNodeId(branch.id, nodeIndex, node),
    cardIndex: 0,
  })));
}

function progressLabel(status?: KnowledgeCardStatus) {
  if (status === "overview") return "观其大略";
  if (status === "unclear") return "还不清楚";
  if (status === "deep") return "想深挖";
  return "未浏览";
}

function sourceRoleLabel(role: string) {
  return ({
    "research-question": "研究问题",
    "capoo-original-judgment": "原始认知",
    "capoo-learning-record": "学习笔记",
    "source-viewpoint": "来源观点",
    context: "背景",
    definition: "定义",
    example: "例子",
    "execution-risk": "执行风险",
  } as Record<string, string>)[role] ?? "来源";
}

function learningKindLabel(kind: string) {
  return ({ talk: "演讲", course: "课程", book: "书", paper: "论文", guide: "指南", interview: "访谈", case: "案例", tool: "工具", reference: "文档" } as Record<string, string>)[kind] ?? "资源";
}

function learningAccessLabel(access: string) {
  return ({ free: "免费", paid: "付费", mixed: "部分免费", "self-directed": "自助实践", unknown: "获取方式待核" } as Record<string, string>)[access] ?? "获取方式待核";
}

function nodeProgressLabel(progress: DomainResearchProgress, cards: KnowledgeCard[]) {
  const statuses = cards.map((card) => progress.cards[card.id]?.status).filter(Boolean);
  if (!statuses.length) return "未浏览";
  if (statuses.includes("deep")) return "想深挖";
  if (statuses.includes("unclear")) return "还不清楚";
  if (statuses.length === cards.length) return "已观其大略";
  return `看过 ${statuses.length}/${cards.length}`;
}

const RESEARCH_METHOD_STEPS = [
  { title: "认识对象", detail: "它是什么，为什么值得研究" },
  { title: "建立脉络", detail: "基本概念、历史关系与代表案例" },
  { title: "形成判断", detail: "当前理解与关键依据" },
  { title: "保留缺口", detail: "仍不清楚什么，需要主动找什么" },
  { title: "连接验证", detail: "关联哪些知识，怎样进入创作实验" },
] as const;

function ResearchTransformation() {
  return (
    <section className="research-method-section">
      <header><h3>统一研究结构</h3><small>游戏和人工智能保留完整卡片，其余母题只显示大纲</small></header>
      <ol className="research-method-grid">
        {RESEARCH_METHOD_STEPS.map((step, index) => (
          <li key={step.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.title}</strong>
            <p>{step.detail}</p>
          </li>
        ))}
      </ol>
      <p className="research-method-boundary">知识节点帮你形成和校准认识；是否提炼为创作原则、放进哪个项目实验，仍由你决定，不会自动生成项目任务。</p>
    </section>
  );
}

export function DomainResearchHome({
  game,
  knowledgeNodes,
  progress,
  focusedDomainId,
  pinnedDomainId,
  onFocus,
  onCollapse,
  onTogglePin,
  onContinue,
  onStart,
  onRandom,
}: {
  game: DomainResearchSummary;
  knowledgeNodes: DomainKnowledgeNode[];
  progress: DomainResearchProgress;
  focusedDomainId: DomainId | null;
  pinnedDomainId: DomainId | null;
  onFocus: (domainId: DomainId) => void;
  onCollapse: () => void;
  onTogglePin: (domainId: DomainId) => void;
  onContinue: (domainId: DomainId) => void;
  onStart: (domainId: DomainId) => void;
  onRandom: (domainId: DomainId) => void;
}) {
  const focusRef = useRef<HTMLElement | null>(null);
  const domains = useMemo(() => researchDomains(game, knowledgeNodes).map((domain) => {
    const cards = allDomainCards(domain);
    const counts = cards.reduce((current, card) => {
      const status = progress.cards[card.id]?.status;
      if (status) current[status] += 1;
      else current.unseen += 1;
      return current;
    }, { overview: 0, unclear: 0, deep: 0, unseen: 0 });
    const hasLastPosition = Boolean(progress.lastPositions[domain.id] ?? (progress.lastPosition?.domainId === domain.id ? progress.lastPosition : null));
    return { domain, counts, hasLastPosition, seen: cards.length - counts.unseen, total: cards.length };
  }), [game, knowledgeNodes, progress.cards, progress.lastPosition, progress.lastPositions]);
  const focused = domains.find(({ domain }) => domain.id === focusedDomainId) ?? null;
  const compactDomains = focused ? domains.filter(({ domain }) => domain.id !== focused.domain.id) : domains;

  useEffect(() => {
    if (!focusedDomainId) return;
    const frame = window.requestAnimationFrame(() => {
      focusRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedDomainId]);

  return (
    <div className="domain-research domain-research-home">
      <header className="domain-research-intro">
        <div>
          <span className="domain-eyebrow"><Compass size={15} />知识地图</span>
          <h2>先看见全貌，再走进真正关心的问题</h2>
          <p>一个大卡片代表一个准备长期理解的领域。课程会结束，领域会持续生长。</p>
        </div>
        <div className="domain-research-principle" aria-label="专题研究边界">
          <span><Library size={15} />艺术馆藏</span>
          <ChevronRight size={14} />
          <strong><Brain size={15} />专题研究</strong>
          <ChevronRight size={14} />
          <span><Hammer size={15} />事业项目</span>
        </div>
      </header>

      <section className={`domain-card-stack${focused ? " has-focus" : ""}`} aria-label="长期研究领域">
        {focused ? (() => {
          const { domain, counts, hasLastPosition } = focused;
          const DomainIcon = domain.icon;
          return (
            <article ref={focusRef} id={`domain-focus-${domain.id}`} className={`domain-card is-expanded ${domain.cardClass}`} aria-labelledby={`domain-focus-title-${domain.id}`}>
              <div className="domain-card-controls">
                <button className={`domain-pin-button${pinnedDomainId === domain.id ? " is-active" : ""}`} type="button" aria-label={pinnedDomainId === domain.id ? `取消首页置顶${domain.title}` : `将${domain.title}置顶到首页`} aria-pressed={pinnedDomainId === domain.id} onClick={() => onTogglePin(domain.id)}>
                  <Star size={17} fill={pinnedDomainId === domain.id ? "currentColor" : "none"} />
                </button>
                <button type="button" aria-label={`收起${domain.title}`} onClick={onCollapse}><X size={18} /></button>
              </div>
              <div className="domain-card-copy">
                <span className="domain-card-mark"><DomainIcon size={18} />{domain.mark}</span>
                <h3 id={`domain-focus-title-${domain.id}`}>{domain.title}</h3>
                <p>{domain.description}</p>
                <div className="domain-card-branches" aria-label={`${domain.title}领域分支`}>
                  {domain.branches.map((branch) => (
                    <span className={branch.status === "正在理解" ? "is-active" : ""} key={branch.id}>
                      <strong>{branch.title}</strong>
                      <em>{branch.cardSummary}</em>
                      <small>{branch.nodes.length} 个专题 · {branch.mappedNodes?.length ?? branch.formalNodes?.length ?? 0} 个知识节点</small>
                    </span>
                  ))}
                </div>
              </div>
              <div className="domain-card-action">
                <div className="domain-card-primary-actions">
                  <button type="button" onClick={() => onStart(domain.id)}>
                    进入专题<ChevronRight size={18} />
                  </button>
                  {hasLastPosition ? <button className="is-secondary" type="button" onClick={() => onContinue(domain.id)}><BookOpen size={16} />继续上次学习</button> : null}
                  <button className="is-secondary" type="button" onClick={() => onRandom(domain.id)}><Shuffle size={16} />随便看看</button>
                </div>
                <div className="domain-progress-counts" aria-label={`${domain.title}知识卡浏览状态`}>
                  <span><strong>{counts.overview}</strong><small>观其大略</small></span>
                  <span><strong>{counts.unclear}</strong><small>还不清楚</small></span>
                  <span><strong>{counts.deep}</strong><small>想深挖</small></span>
                  <span><strong>{counts.unseen}</strong><small>未浏览</small></span>
                </div>
                <div className="domain-card-compass" aria-hidden="true"><DomainIcon size={52} /></div>
              </div>
            </article>
          );
        })() : null}

        {focused ? <div className="domain-compact-heading"><span>其他母题</span><small>点开另一张，当前母题会自动收起</small></div> : null}
        <div className="domain-compact-grid" aria-label={focused ? "其他母题" : "全部母题"}>
          {compactDomains.map(({ domain, hasLastPosition, seen, total }) => {
            const DomainIcon = domain.icon;
            const isPinned = pinnedDomainId === domain.id;
            return (
              <article className={`domain-compact-card ${domain.cardClass}`} key={domain.id}>
                <button className="domain-compact-card-body" type="button" aria-expanded="false" aria-controls={`domain-focus-${domain.id}`} onClick={() => onFocus(domain.id)}>
                  <span className="domain-card-mark"><DomainIcon size={16} />{domain.mark}</span>
                  <div className="domain-compact-title"><span aria-hidden="true"><DomainIcon size={25} /></span><h3>{domain.title}</h3></div>
                  <p>{domain.description}</p>
                  <footer>
                    <span>{domain.branches.length} 条主干</span>
                    <span>{seen}/{total} 已浏览</span>
                    <strong>展开查看<ChevronRight size={15} /></strong>
                  </footer>
                </button>
                <button className={`domain-pin-button${isPinned ? " is-active" : ""}`} type="button" aria-label={isPinned ? `取消首页置顶${domain.title}` : `将${domain.title}置顶到首页`} aria-pressed={isPinned} onClick={() => onTogglePin(domain.id)}>
                  <Star size={16} fill={isPinned ? "currentColor" : "none"} />
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function KnowledgeCardReader({
  domain,
  branch,
  node,
  nodeIndex,
  cardIndex,
  progress,
  onMove,
  onClose,
  onSave,
  onAskSecretary,
}: {
  domain: ResearchDomainView;
  branch: ResearchBranch;
  node: ResearchBranch["nodes"][number];
  nodeIndex: number;
  cardIndex: number;
  progress: DomainResearchProgress;
  onMove: (target: ReaderTarget) => void;
  onClose: () => void;
  onSave: (update: DomainResearchProgressUpdate) => Promise<void>;
  onAskSecretary: (seedUser: string) => void;
}) {
  const [saveError, setSaveError] = useState("");
  const cards = buildKnowledgeCards(branch, node, nodeIndex);
  const safeIndex = Math.min(Math.max(0, cardIndex), cards.length - 1);
  const card = cards[safeIndex];
  const nodeId = knowledgeNodeId(branch.id, nodeIndex, node);
  const selectedChoice = progress.choices[card.id]?.choiceId;
  const currentStatus = progress.cards[card.id]?.status;
  const learningResourceCount = node.learningResources?.length ?? 0;
  const learningPathIndex = cards.findIndex((candidate) => candidate.id.endsWith("-learning-path"));
  const showLearningResources = safeIndex === learningPathIndex && learningResourceCount > 0;
  const previousLabel = safeIndex > 0 ? "上一张" : nodeIndex > 0 ? "上一节点" : "返回知识地图";
  const nextLabel = safeIndex < cards.length - 1 ? "下一张" : nodeIndex < (branch.formalNodes?.length ?? 0) - 1 ? "下一节点" : "返回知识地图";

  useEffect(() => {
    setSaveError("");
    void onSave({
      cardId: card.id,
      position: { domainId: domain.id, branchId: branch.id, nodeId, cardId: card.id, cardIndex: safeIndex },
    }).catch((error) => setSaveError(error instanceof Error ? error.message : "浏览位置没有保存"));
  }, [branch.id, card.id, domain.id, nodeId, onSave, safeIndex]);

  const moveRelative = (direction: -1 | 1) => {
    const nextCardIndex = safeIndex + direction;
    if (nextCardIndex >= 0 && nextCardIndex < cards.length) {
      onMove({ domainId: domain.id, branchId: branch.id, nodeId, cardIndex: nextCardIndex });
      return;
    }
    const nextNodeIndex = nodeIndex + direction;
    const formalNodes = branch.formalNodes ?? [];
    if (nextNodeIndex >= 0 && nextNodeIndex < formalNodes.length) {
      const nextNode = formalNodes[nextNodeIndex];
      const nextNodeId = knowledgeNodeId(branch.id, nextNodeIndex, nextNode);
      const nextCards = buildKnowledgeCards(branch, nextNode, nextNodeIndex);
      onMove({ domainId: domain.id, branchId: branch.id, nodeId: nextNodeId, cardIndex: direction > 0 ? 0 : nextCards.length - 1 });
      return;
    }
    onClose();
  };

  const saveAndAdvance = (status: KnowledgeCardStatus, choiceId?: string) => {
    setSaveError("");
    void onSave({
      cardId: card.id,
      status,
      choiceId,
      position: { domainId: domain.id, branchId: branch.id, nodeId, cardId: card.id, cardIndex: safeIndex },
    }).catch((error) => setSaveError(error instanceof Error ? error.message : "这次点按没有保存"));
    moveRelative(1);
  };

  return (
    <div className="knowledge-reader" role="dialog" aria-modal="true" aria-label={`${node.title}知识卡`}>
      <header className="knowledge-reader-topbar">
        <button type="button" onClick={onClose}><ArrowLeft size={19} /><span>返回知识地图</span></button>
        <div className="knowledge-reader-context"><span>{domain.title}</span><ChevronRight size={13} /><span>{branch.title}</span><ChevronRight size={13} /><strong>{node.title}</strong></div>
        <button className="knowledge-reader-close" type="button" aria-label="关闭知识卡" onClick={onClose}><X size={20} /></button>
      </header>

      <main className={`knowledge-reader-sheet is-${card.kind}`}>
        <div className="knowledge-reader-progress" aria-label={`第 ${safeIndex + 1} 张，共 ${cards.length} 张`}>
          <span style={{ width: `${((safeIndex + 1) / cards.length) * 100}%` }} />
        </div>
        <article>
          <div className="knowledge-reader-kicker">
            <span className="knowledge-reader-eyebrow"><Sparkles size={15} />{card.eyebrow}</span>
            <div className="knowledge-reader-kicker-meta">
              {learningResourceCount > 0 && !showLearningResources ? (
                <button
                  className="knowledge-reader-resource-jump"
                  type="button"
                  onClick={() => onMove({ domainId: domain.id, branchId: branch.id, nodeId, cardIndex: learningPathIndex })}
                  aria-label={`查看本节点 ${learningResourceCount} 项延展资源`}
                >
                  <Library size={14} />
                  <span className="knowledge-reader-resource-count">
                    {learningResourceCount}<span className="knowledge-reader-resource-label"> 项延展</span>
                  </span>
                </button>
              ) : null}
              <span className="knowledge-reader-page-number">{String(safeIndex + 1).padStart(2, "0")} / {String(cards.length).padStart(2, "0")}</span>
            </div>
          </div>
          <h2>{card.title}</h2>
          <div className="knowledge-reader-body">
            {card.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {card.bullets?.length ? <ul>{card.bullets.map((item) => <li key={item}>{item}</li>)}</ul> : null}
            {card.question ? <blockquote><span>此刻的问题</span>{card.question}</blockquote> : null}
          </div>
          {showLearningResources ? (
            <section className="knowledge-learning-shelf" aria-label="主题内垂直学习梯">
              <header><div><span>主题内垂直学习梯</span><strong>沿着当前问题继续深入</strong></div><small>{node.learningResources?.length ?? 0} 项精选资源</small></header>
              <div className="knowledge-learning-resource-list">
                {node.learningResources?.map((resource) => {
                  const content = (
                    <>
                      <div className="knowledge-learning-resource-meta"><span>{learningLevelLabel(resource.level)}</span><em>{learningKindLabel(resource.kind)}</em></div>
                      <strong>{resource.title}</strong>
                      {resource.creator ? <small className="knowledge-learning-resource-creator">{resource.creator}</small> : null}
                      <p>{resource.reason}</p>
                      {resource.focus ? <blockquote><b>带着这个问题</b>{resource.focus}</blockquote> : null}
                      {resource.use ? <div className="knowledge-learning-resource-use"><b>建议用法</b>{resource.use}</div> : null}
                      <footer>
                        {resource.duration ? <span>{resource.duration}</span> : null}
                        {resource.language ? <span>{resource.language}</span> : null}
                        <span>{learningAccessLabel(resource.access)}</span>
                        {resource.asOf ? <span>核验 {resource.asOf}</span> : null}
                        {resource.url || resource.path ? <ExternalLink size={14} /> : null}
                      </footer>
                    </>
                  );
                  if (resource.url) return <a href={resource.url} target="_blank" rel="noopener noreferrer" key={resource.id}>{content}</a>;
                  if (resource.path) return <div key={resource.id}>{content}<small className="knowledge-learning-resource-path">本地资料</small></div>;
                  return null;
                })}
              </div>
            </section>
          ) : null}
          <details className="knowledge-source-rail">
            <summary>核对来源与边界 <span>{node.sources?.length ?? 0}</span></summary>
            <div className="knowledge-source-meta">
              <span>{node.sources?.length ?? 0} 条来源</span>
              {node.asOf ? <span>核验 {node.asOf}</span> : null}
              {node.jurisdiction ? <span>{node.jurisdiction}</span> : null}
            </div>
            <div className="knowledge-source-list">
              {node.sources?.map((source) => source.role === "capoo-learning-record" ? (
                <div key={source.id}>
                  <span>{sourceRoleLabel(source.role)}</span><strong>{source.title}</strong><small>已用于合并本页正文{source.locator ? ` · ${source.locator}` : ""}</small>
                </div>
              ) : source.url ? (
                <a href={source.url} target="_blank" rel="noopener noreferrer" key={source.id}>
                  <span>{sourceRoleLabel(source.role)}</span><strong>{source.title}</strong>{source.locator ? <small>{source.locator}</small> : null}
                </a>
              ) : source.path ? (
                <div key={source.id}>
                  <span>{sourceRoleLabel(source.role)}</span><strong>{source.title}</strong><small>本地资料{source.locator ? ` · ${source.locator}` : ""}</small>
                </div>
              ) : (
                <div key={source.id}>
                  <span>{sourceRoleLabel(source.role)}</span><strong>{source.title}</strong><small>{source.path}{source.locator ? ` · ${source.locator}` : ""}</small>
                </div>
              ))}
            </div>
          </details>
          {card.kind === "choice" ? (
            <div className="knowledge-choice-list" aria-label="选择当前想法">
              {card.choices?.map((choice) => (
                <button className={selectedChoice === choice.id ? "is-selected" : ""} type="button" key={choice.id} onClick={() => saveAndAdvance("overview", choice.id)}>
                  <span>{selectedChoice === choice.id ? <Check size={17} /> : null}</span>
                  <strong>{choice.label}</strong>
                  <small>{choice.detail}</small>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          ) : null}
        </article>
      </main>

      <footer className="knowledge-reader-actions">
        <button className="knowledge-reader-previous" type="button" onClick={() => moveRelative(-1)}><ChevronLeft size={18} />{previousLabel}</button>
        <button className="knowledge-reader-secretary ai-button" type="button" onClick={(event) => { event.stopPropagation(); onAskSecretary(buildKnowledgeExplainSeed(domain.title, branch.title, node.title, card, node.sources)); }}>
          <MessageCircle size={19} /><span><strong>让秘书讲解</strong><small>打开后可继续语音问</small></span>
        </button>
        {card.kind === "choice" ? (
          <div className="knowledge-reader-choice-hint">点一个想法，自动看下一张</div>
        ) : (
          <div className="knowledge-reader-statuses" aria-label="标记当前理解状态">
            {([
              ["overview", "观其大略"],
              ["unclear", "还不清楚"],
              ["deep", "想深挖"],
            ] as const).map(([status, label]) => (
              <button className={currentStatus === status ? "is-selected" : ""} type="button" key={status} onClick={() => saveAndAdvance(status)}>
                {currentStatus === status ? <Check size={16} /> : null}{label}
              </button>
            ))}
          </div>
        )}
        <button className="knowledge-reader-next" type="button" onClick={() => moveRelative(1)}>{nextLabel}<ChevronRight size={18} /></button>
        {saveError ? <p role="status">{saveError}</p> : null}
      </footer>
    </div>
  );
}

export function DomainKnowledgeMap({
  domain,
  activeBranchId,
  activeNodeId,
  activeCardIndex,
  progress,
  onBranchChange,
  onOpenNode,
  onMoveReader,
  onCloseReader,
  onSaveProgress,
  onAskSecretary,
  onBack,
  onOpenOverview,
}: {
  domain: ResearchDomainView;
  activeBranchId: string;
  activeNodeId: string | null;
  activeCardIndex: number;
  progress: DomainResearchProgress;
  onBranchChange: (branchId: string) => void;
  onOpenNode: (target: ReaderTarget) => void;
  onMoveReader: (target: ReaderTarget) => void;
  onCloseReader: () => void;
  onSaveProgress: (update: DomainResearchProgressUpdate) => Promise<void>;
  onAskSecretary: (seedUser: string) => void;
  onBack: () => void;
  onOpenOverview: () => void;
}) {
  const researchLines = domain.researchSummary?.researchLines ?? [];
  const [selectedLineId, setSelectedLineId] = useState(researchLines[0]?.id ?? "");
  const [readingCluesCollapsed, setReadingCluesCollapsed] = useState(false);
  const activeBranch = domain.branches.find((branch) => branch.id === activeBranchId) ?? domain.branches[0];
  const selectedLine = researchLines.find((line) => line.id === selectedLineId) ?? researchLines[0] ?? null;
  const ActiveIcon = activeBranch.icon;
  const isCulture = domain.id === "game" && activeBranch.id === "culture";
  const formalNodes = activeBranch.formalNodes ?? [];
  const mappedNodes = activeBranch.mappedNodes ?? formalNodes;
  const activeNodeIndex = formalNodes.findIndex((node, index) => knowledgeNodeId(activeBranch.id, index, node) === activeNodeId);
  const activeNode = activeNodeIndex >= 0 ? formalNodes[activeNodeIndex] : null;
  const activeBranchCardEntries = formalNodes.flatMap((node, nodeIndex) => buildKnowledgeCards(activeBranch, node, nodeIndex).map((card, cardIndex) => ({
    card,
    node,
    nodeId: knowledgeNodeId(activeBranch.id, nodeIndex, node),
    nodeIndex,
    cardIndex,
  })));
  const unclearEntries = activeBranchCardEntries.filter(({ card }) => progress.cards[card.id]?.status === "unclear");
  const deepEntries = activeBranchCardEntries.filter(({ card }) => progress.cards[card.id]?.status === "deep");
  const entriesByCardId = new Map(activeBranchCardEntries.map((entry) => [entry.card.id, entry]));
  const recentEntries = progress.recentCardIds.flatMap((cardId) => {
    const entry = entriesByCardId.get(cardId);
    return entry ? [entry] : [];
  }).slice(0, 4);

  return (
    <div className={`domain-research domain-knowledge-map is-${domain.id}`}>
      <PageTrail items={[
        { label: domain.title, href: navigationHref("/topics", { domain: domain.id }), history: "replace", onSelect: () => onBranchChange(domain.branches[0].id) },
        { label: activeBranch.title, href: navigationHref("/topics", { domain: domain.id, branch: activeBranch.id }), history: "replace", onSelect: onCloseReader, siblings: domain.branches.filter((branch) => branch.id !== activeBranch.id).map((branch) => ({ label: branch.title, href: navigationHref("/topics", { domain: domain.id, branch: branch.id }), history: "replace" as const, onSelect: () => onBranchChange(branch.id) })) },
        ...(activeNode ? [{ label: activeNode.title }] : []),
      ]} />
      <header className="knowledge-map-header">
        <p>{domain.mapLead}</p>
      </header>

      <div className={`knowledge-map-layout${readingCluesCollapsed ? " is-reading-clues-collapsed" : ""}`}>
        <aside className="knowledge-map-outline" aria-label={`${domain.title}领域目录`}>
          <header><span>{domain.title}领域目录</span><FolderTree size={17} /></header>
          <nav>
            {domain.branches.map((branch) => {
              const Icon = branch.icon;
              return (
                <button className={branch.id === activeBranch.id ? "is-active" : ""} type="button" key={branch.id} onClick={() => onBranchChange(branch.id)}>
                  <Icon size={17} />
                  <span><strong>{branch.title}</strong><small>{branch.status}</small></span>
                  <ChevronRight size={15} />
                </button>
              );
            })}
          </nav>
          <div className="knowledge-map-legend">
            <span><i className="is-known" />已形成认识</span>
            <span><i className="is-learning" />正在理解</span>
            <span><i className="is-question" />存疑待证</span>
            <span><i />待探索</span>
          </div>
          <p className="knowledge-map-legend-note">状态只表示当前研究进展。课程读完、作品看过或项目做过，都不会自动变成“已形成认识”。</p>
        </aside>

        <section className="knowledge-map-content">
          <div className="knowledge-map-breadcrumb">{domain.title} / {activeBranch.title}</div>
          <header className="knowledge-map-title">
            <span><ActiveIcon size={22} /></span>
            <div><h2>{activeBranch.title}</h2><p>{activeBranch.summary}</p></div>
          </header>

          <section className="knowledge-understanding">
            <span><Lightbulb size={16} />一句话理解</span>
            <p>{isCulture ? "从真正重要的作品出发，理解游戏怎样在历史、类型、机制、表达和玩家经验中形成意义。" : activeBranch.summary}</p>
            <div className="knowledge-guiding-question"><strong>核心问题</strong><p>{activeBranch.guidingQuestion}</p></div>
          </section>

          <section className="knowledge-node-section">
            <header><h3>专题与知识节点</h3><small>纲目只负责导航；有来源的正式节点才可点读并保存进度</small></header>
            <div className="knowledge-node-grid">
              {activeBranch.nodes.map((topic, index) => {
                const topicId = knowledgeNodeId(activeBranch.id, index, topic);
                const topicNodes = mappedNodes.filter((node) => node.topicId === topicId);
                return (
                  <article className={`knowledge-topic-card${topicNodes.length ? " has-formal-nodes" : " is-outline"}`} key={topicId}>
                    <header><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{topic.title}</strong><p>{topic.description}</p></div></header>
                    {topicNodes.length ? <div className="knowledge-topic-node-list">{topicNodes.map((node) => {
                      const nodeIndex = formalNodes.indexOf(node);
                      const nodeId = knowledgeNodeId(activeBranch.id, nodeIndex, node);
                      if (node.status !== "formal") {
                        const outlineResources = node.learningResources ?? [];
                        const learningRecords = node.learningRecords ?? [];
                        return (
                        <div className={`knowledge-outline-node${outlineResources.length ? " has-key-materials" : ""}${learningRecords.length ? " has-learning-records" : ""}`} key={nodeId}>
                          <span><FileText size={15} />知识节点<em>正文待补</em></span>
                          <strong>{node.title}</strong>
                          <p>{node.description}</p>
                          <small>{outlineResources.length ? `纲目已建立 · ${outlineResources.length} 项绕不开材料已备` : "纲目已建立，内容待补"}</small>
                          {learningRecords.length ? (
                            <section className="knowledge-outline-learning" aria-label={`${node.title}的个人学习记录`}>
                              <header><MessageCircle size={14} /><strong>{learningStateLabel(node.learningState)}</strong><span>{learningRecords.length} 次</span></header>
                              {learningRecords.map((record) => (
                                <article key={record.recordId}>
                                  <span>{record.date}</span>
                                  <strong>{record.title}</strong>
                                  <p>{record.summary}</p>
                                  {record.nextStep ? <footer><b>下次继续</b>{record.nextStep}</footer> : null}
                                </article>
                              ))}
                            </section>
                          ) : null}
                          {outlineResources.length ? (
                            <details className="knowledge-outline-resources">
                              <summary><Library size={14} />查看绕不开材料</summary>
                              <div>
                                {outlineResources.map((resource) => {
                                  const body = (
                                    <>
                                      <span>{learningLevelLabel(resource.level)} · {learningKindLabel(resource.kind)}</span>
                                      <strong>{resource.title}</strong>
                                      {resource.creator ? <small>{resource.creator}</small> : null}
                                      <p>{resource.reason}</p>
                                      {resource.focus ? <blockquote><b>带着这个问题</b>{resource.focus}</blockquote> : null}
                                      <footer>{resource.duration ? <span>{resource.duration}</span> : null}{resource.language ? <span>{resource.language}</span> : null}<span>{learningAccessLabel(resource.access)}</span><ExternalLink size={13} /></footer>
                                    </>
                                  );
                                  if (resource.url) return <a href={resource.url} target="_blank" rel="noopener noreferrer" key={resource.id}>{body}</a>;
                                  if (resource.path) return <div key={resource.id}>{body}</div>;
                                  return null;
                                })}
                              </div>
                            </details>
                          ) : null}
                        </div>
                        );
                      }
                      const cards = buildKnowledgeCards(activeBranch, node, nodeIndex);
                      const label = nodeProgressLabel(progress, cards);
                      const learningResourceCount = node.learningResources?.length ?? 0;
                      const learningRecordCount = node.learningRecords?.length ?? 0;
                      return (
                        <button className={label === "未浏览" ? "is-unopened" : "is-learning"} type="button" key={nodeId} onClick={() => onOpenNode({ domainId: domain.id, branchId: activeBranch.id, nodeId, cardIndex: 0 })}>
                          <span><BookOpen size={15} />正式节点<em>{cards.length} 张{learningResourceCount ? <> · <Library size={12} />{learningResourceCount} 项延展</> : null}{learningRecordCount ? <> · <MessageCircle size={12} />{learningRecordCount} 次学习</> : null}</em></span><strong>{node.title}</strong><small>{learningRecordCount ? learningStateLabel(node.learningState) : label}<ChevronRight size={14} /></small>
                        </button>
                      );
                    })}</div> : <small className="knowledge-topic-pending">纲目已建立，内容待补</small>}
                  </article>
                );
              })}
            </div>
          </section>

          {isCulture ? (
            <section className="research-line-section">
              <header><h3>当前研究线</h3><button type="button" onClick={onOpenOverview}>打开研究资料<ChevronRight size={15} /></button></header>
              {researchLines.length ? (
                <div className="research-line-list">
                  {researchLines.map((line) => (
                    <button className={line.id === selectedLine?.id ? "is-active" : ""} type="button" key={line.id} onClick={() => setSelectedLineId(line.id)}>
                      <span><Search size={15} /></span>
                      <span className="research-line-copy"><strong>{line.title}</strong><small>{line.questions[0]}</small></span>
                      <em>{line.questions.length} 个真实问题</em>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
              ) : <p className="knowledge-map-empty">本节点暂无预设研究问题。</p>}
            </section>
          ) : null}

          <ResearchTransformation />
        </section>

        <aside className={`knowledge-map-gaps${readingCluesCollapsed ? " is-collapsed" : ""}`} aria-label="阅读线索">
          <header>
            <span className="knowledge-map-gaps-title"><CircleHelp size={19} /><h3>阅读线索</h3></span>
            <button
              className="knowledge-map-gaps-toggle"
              type="button"
              aria-expanded={!readingCluesCollapsed}
              aria-label={readingCluesCollapsed ? "展开阅读线索" : "向右折叠阅读线索"}
              title={readingCluesCollapsed ? "展开阅读线索" : "向右折叠阅读线索"}
              onClick={() => setReadingCluesCollapsed((collapsed) => !collapsed)}
            >
              {readingCluesCollapsed ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
            </button>
          </header>
          {!readingCluesCollapsed ? <><section>
            <span><CircleHelp size={16} />仍不清楚</span>
            {unclearEntries.length ? <div className="knowledge-clue-list">{unclearEntries.slice(0, 5).map((entry) => (
              <button type="button" key={entry.card.id} onClick={() => onOpenNode({ domainId: domain.id, branchId: activeBranch.id, nodeId: entry.nodeId, cardIndex: entry.cardIndex })}>
                <strong>{entry.card.title}</strong><small>{entry.node.title}</small><ChevronRight size={14} />
              </button>
            ))}</div> : <p>点过“还不清楚”的卡会自动来到这里。</p>}
          </section>
          <section>
            <span><Sparkles size={16} />想继续看</span>
            {deepEntries.length ? <div className="knowledge-clue-list">{deepEntries.slice(0, 5).map((entry) => (
              <button type="button" key={entry.card.id} onClick={() => onOpenNode({ domainId: domain.id, branchId: activeBranch.id, nodeId: entry.nodeId, cardIndex: entry.cardIndex })}>
                <strong>{entry.card.title}</strong><small>{entry.node.title}</small><ChevronRight size={14} />
              </button>
            ))}</div> : <p>觉得值得深挖时点一下，系统替你收在这里。</p>}
          </section>
          <section>
            <span><History size={16} />最近看过</span>
            {recentEntries.length ? <div className="knowledge-clue-list">{recentEntries.map((entry) => (
              <button type="button" key={entry.card.id} onClick={() => onOpenNode({ domainId: domain.id, branchId: activeBranch.id, nodeId: entry.nodeId, cardIndex: entry.cardIndex })}>
                <strong>{entry.card.title}</strong><small>{progressLabel(progress.cards[entry.card.id]?.status)}</small><ChevronRight size={14} />
              </button>
            ))}</div> : <p>浏览过的卡片会自动出现，不需要另做记录。</p>}
          </section></> : null}
        </aside>
      </div>
      {activeNode ? createPortal(
        <KnowledgeCardReader
          domain={domain}
          branch={activeBranch}
          node={activeNode}
          nodeIndex={activeNodeIndex}
          cardIndex={activeCardIndex}
          progress={progress}
          onMove={onMoveReader}
          onClose={onCloseReader}
          onSave={onSaveProgress}
          onAskSecretary={onAskSecretary}
        />,
        document.body,
      ) : null}
    </div>
  );
}

export type { DomainId } from "./domain-research-catalog";
