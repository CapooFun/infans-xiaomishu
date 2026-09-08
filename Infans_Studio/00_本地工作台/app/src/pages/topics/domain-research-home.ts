import type { DomainId } from "./domain-research-catalog";

export type ResearchDomainHomeMeta = {
  id: DomainId;
  title: string;
  mark: string;
  defaultBranch: string;
  focusLabel: string;
  focusTitle: string;
  focusText: string;
  highlights: string[];
  nextLabel: string;
};

type ResearchTopicSummary = {
  title: string;
  tip?: string;
  sourcePath: string;
};

export const RESEARCH_DOMAIN_IDS = [
  "game",
  "ai",
  "economics-finance",
  "language",
  "thought-history",
  "zztj",
  "image-management",
  "fitness",
] as const satisfies readonly DomainId[];

export const RESEARCH_DOMAIN_HOME_META: Record<DomainId, ResearchDomainHomeMeta> = {
  game: {
    id: "game",
    title: "游戏",
    mark: "创作母题",
    defaultBranch: "culture",
    focusLabel: "知识地图主线",
    focusTitle: "从作品出发，理解游戏何以成为游戏",
    focusText: "把历史、玩家经验、设计、制作与产业放在同一张地图中。",
    highlights: ["游戏史与文化", "设计与体验", "叙事与视听", "制作与产业"],
    nextLabel: "继续上次位置，或从一个真正在意的作品开始",
  },
  ai: {
    id: "ai",
    title: "人工智能",
    mark: "智能系统",
    defaultBranch: "ai-history-math",
    focusLabel: "知识地图主线",
    focusTitle: "从历史范式走到生成模型、Agent 与机器人",
    focusText: "同时追问能力怎样产生、怎样评测，以及怎样进入真实产品。",
    highlights: ["搜索与推理", "生成模型", "Agent 与机器人", "安全与治理"],
    nextLabel: "继续建立原理、工程、产品与社会之间的联系",
  },
  language: {
    id: "language",
    title: "语言研究",
    mark: "长期语言线",
    defaultBranch: "language-foundations",
    focusLabel: "知识地图主线",
    focusTitle: "用共同语言学骨架连接正在学的语言",
    focusText: "将日语、汉语、拉丁语、英语和德语放进历史、心智与社会中理解。",
    highlights: ["语言学基础", "语言史与类型", "习得与心智", "具体语言"],
    nextLabel: "从共同概念进入一门语言，或反向比较多门语言",
  },
  "thought-history": {
    id: "thought-history",
    title: "思想史",
    mark: "观念的来路",
    defaultBranch: "thought-method",
    focusLabel: "知识地图主线",
    focusTitle: "追踪观念怎样回应时代，又怎样流传与变形",
    focusText: "同时看思想内容、历史处境和书籍、宗教、教育等传播机制。",
    highlights: ["思想史方法", "世界思想传统", "伦理与政治", "宗教与科学"],
    nextLabel: "选一个真正困惑的观念，回到它当时的问题现场",
  },
  zztj: {
    id: "zztj",
    title: "资治通鉴",
    mark: "熊逸讲透《资治通鉴》",
    defaultBranch: "zztj-season-5",
    focusLabel: "当前走到",
    focusTitle: "从《资治通鉴》总览读取最新进度",
    focusText: "",
    highlights: ["人物名场面", "文化语码", "传世名篇", "长线影响"],
    nextLabel: "继续课程，或从人物与文化线索横向回顾",
  },
  "image-management": {
    id: "image-management",
    title: "形象管理",
    mark: "外貌与表达",
    defaultBranch: "image-self",
    focusLabel: "知识地图主线",
    focusTitle: "把个人条件、视觉目标与日常维护连起来",
    focusText: "从皮肤、发型、妆容和穿搭，走向稳定、可复现的自我表达。",
    highlights: ["个人定位", "护理与发型", "妆容与穿搭", "体态与镜头"],
    nextLabel: "先理解自己，再把方法变成能够长期执行的方案",
  },
  fitness: {
    id: "fitness",
    title: "运动健身",
    mark: "身体能力",
    defaultBranch: "fitness-physiology",
    focusLabel: "知识地图主线",
    focusTitle: "从身体原理走到训练计划、恢复与长期习惯",
    focusText: "将力量、心肺、动作、营养和数据放在可持续的生活系统中。",
    highlights: ["运动生理", "力量与心肺", "计划与恢复", "营养与数据"],
    nextLabel: "继续理解身体，但不让设备和数字取代实际感受",
  },
  "economics-finance": {
    id: "economics-finance",
    title: "经济与金融",
    mark: "投资认知底座",
    defaultBranch: "ef-method-history",
    focusLabel: "知识地图主线",
    focusTitle: "从经济运行走到资产价格与投资决策",
    focusText: "用经济学解释环境，用会计与金融理解企业、证券、估值、组合和风险。",
    highlights: ["宏观与货币", "公司与财报", "资产与估值", "组合与风控"],
    nextLabel: "先看懂专业语言，再把判断带回真实投资项目",
  },
};

export function isResearchDomainId(value: unknown): value is DomainId {
  return typeof value === "string" && RESEARCH_DOMAIN_IDS.includes(value as DomainId);
}

export function researchDomainHomeMeta(
  domainId: DomainId,
  topics: ResearchTopicSummary[] = [],
): ResearchDomainHomeMeta {
  const meta = RESEARCH_DOMAIN_HOME_META[domainId];
  if (domainId !== "zztj") return meta;
  const topic = topics.find((item) => item.title === "资治通鉴" || item.sourcePath.endsWith("资治通鉴/资治通鉴_总览.md"));
  const tip = topic?.tip?.replace(/\s+/gu, " ").trim() ?? "";
  const progress = tip.match(/第?(\S+?)季(?:听到)?第?\s*(\d+)\s*讲(?:[ ··・:：-]+(.+))?$/u);
  if (!progress) return meta;
  return {
    ...meta,
    focusTitle: `第${progress[1]}季 · 第 ${Number(progress[2])} 讲`,
    focusText: progress[3]?.trim() ?? "",
  };
}
