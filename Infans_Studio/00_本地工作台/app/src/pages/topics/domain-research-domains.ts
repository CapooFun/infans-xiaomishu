import type { KnowledgeNodeInput } from "./domain-research-cards";
import {
  type DomainIconKey,
  type ResearchBranch,
  type ResearchDomain,
} from "./domain-research-catalog";

type BranchSeed = {
  id: string;
  title: string;
  summary: string;
  nodes: Array<string | KnowledgeNodeInput>;
  iconKey?: DomainIconKey;
  active?: boolean;
};

function isKnowledgeNode(value: string | KnowledgeNodeInput): value is KnowledgeNodeInput {
  return typeof value !== "string";
}

function branch({ id, title, summary, nodes, iconKey = "book", active = false }: BranchSeed): ResearchBranch {
  const normalized = nodes.map((entry) => isKnowledgeNode(entry) ? entry : ({
    title: entry,
    description: `从基本概念、历史条件、代表案例和常见误解四个角度，建立对“${entry}”的可调用认识。`,
  }));
  return {
    id,
    title,
    cardSummary: summary,
    summary,
    guidingQuestion: `这一主干怎样改变我们理解${title}时的判断，并与其他分支发生联系？`,
    status: active ? "正在理解" : "待探索",
    iconKey,
    nodes: normalized,
    starterQuestions: [
      `${title}最核心的问题是什么？`,
      `哪些经典案例最能说明${title}？`,
      `${title}常见的理解缺口是什么？`,
    ],
  };
}

function topic(id: string, title: string, description: string): KnowledgeNodeInput {
  return { id, title, description };
}

export const FULL_AI_DOMAIN: ResearchDomain = {
  id: "ai",
  title: "人工智能",
  mark: "智能系统",
  description: "既研究人工智能的经典学科全貌，也持续深入生成模型、Agent、编程协作和真正会进入生活与事业的产品能力。",
  mapLead: "从历史范式和搜索推理一路走到生成模型、Agent、工程、产品与治理。",
  cardClass: "domain-card-ai",
  branches: [
    branch({ id: "ai-history-math", title: "AI 历史、范式与数理基础", summary: "从智能判准、学科史与数学工具理解不同 AI 路线为何兴起、受挫又重组。", nodes: [
      topic("ai-history-math-01", "AI 的历史与主要范式", "追踪智能判准、符号主义、连接主义、统计学习与基础模型的历史关系。"),
      topic("ai-history-math-02", "线性代数、概率与优化", "把向量、概率、信息与优化放回 AI 模型实际计算中。"),
      topic("ai-history-math-03", "机器学习与神经网络的历史形成", "保留旧 ID，研究学习机器和神经网络从早期设想到统计学习的演变。"),
      topic("ai-history-math-04", "Transformer 与注意力的历史位置", "保留旧 ID，判断 Transformer 改变了什么、继承了什么，又没有解决什么。"),
      topic("ai-history-math-05", "计算、认知与理性基础", "区分可计算性、认知建模、像人思考与理性行动等不同研究目标。"),
    ], iconKey: "history", active: true }),
    branch({ id: "ai-search-planning", title: "搜索、规划与优化", summary: "理解状态空间、约束、对手与序列决策怎样把目标变成可计算行动。", nodes: [
      topic("ai-search-planning-01", "状态空间与启发式搜索", "研究问题表示、无信息搜索、启发式与 A* 的正确性边界。"),
      topic("ai-search-planning-02", "约束满足与组合优化", "理解变量、取值域、约束传播、回溯与近似优化。"),
      topic("ai-search-planning-03", "博弈搜索与决策", "研究极小化极大、剪枝、不完全信息与对手建模。"),
      topic("ai-search-planning-04", "规划、强化学习与控制", "把经典规划、马尔可夫决策、强化学习与反馈控制拆开比较。"),
      topic("ai-search-planning-05", "连续优化与元启发式", "理解梯度、局部搜索、随机优化与多目标取舍。"),
    ], iconKey: "map" }),
    branch({ id: "ai-knowledge-reasoning", title: "知识表示、逻辑与概率推理", summary: "研究机器怎样表达事实、关系、时间、行动、不确定性与因果。", nodes: [
      topic("ai-knowledge-reasoning-01", "逻辑、规则与知识图谱", "区分命题与一阶逻辑、规则系统、本体和知识图谱。"),
      topic("ai-knowledge-reasoning-02", "概率图模型与贝叶斯推断", "理解条件独立、贝叶斯网络、时序模型和近似推断。"),
      topic("ai-knowledge-reasoning-03", "因果推断与反事实", "区分相关、干预和反事实，并认识因果假设的来源。"),
      topic("ai-knowledge-reasoning-04", "符号系统与神经模型的结合", "研究神经符号方法在哪些任务中互补、怎样验证。"),
      topic("ai-knowledge-reasoning-05", "时间、行动与常识推理", "处理变化、默认规则、例外和常识知识的表示难题。"),
    ], iconKey: "brackets" }),
    branch({ id: "ai-learning-generative", title: "机器学习、深度学习与生成模型", summary: "从统计学习目标进入深度网络、强化学习和不同生成模型家族。", nodes: [
      topic("ai-learning-generative-06", "监督、无监督与自监督学习", "区分标签来源、学习目标、表示和适用任务。"),
      topic("ai-learning-generative-10", "线性模型与分类基础", "从线性回归和逻辑回归理解目标、假设、概率与决策边界。"),
      topic("ai-learning-generative-11", "决策树与集成学习", "理解树怎样切分特征，以及 Bagging、随机森林和 Boosting 怎样组合弱模型。"),
      topic("ai-learning-generative-12", "间隔、核方法与支持向量机", "从最大间隔进入支持向量、软间隔与核技巧。"),
      topic("ai-learning-generative-13", "统计学习、泛化与模型选择", "区分经验风险、泛化误差、偏差方差、交叉验证、校准和数据处理泄漏。"),
      topic("ai-learning-generative-07", "深度网络、优化与泛化", "理解反向传播、梯度优化、正则化、过拟合和分布外失效。"),
      topic("ai-learning-generative-08", "生成模型家族", "比较自回归、变分、自对抗、扩散和流模型的建模对象。"),
      topic("ai-learning-generative-09", "强化学习与序列决策", "理解价值、策略、探索、信用分配和离线强化学习。"),
      topic("ai-learning-generative-01", "预训练、微调与后训练", "区分通用表征、任务适配、偏好塑形与安全约束。"),
      topic("ai-learning-generative-02", "Token、向量与上下文", "理解离散输入怎样进入向量计算，以及上下文为何不等于长期记忆。"),
      topic("ai-learning-generative-03", "概率生成与采样", "理解似然、解码、采样和生成质量之间的关系。"),
      topic("ai-learning-generative-04", "语言模型的理解与生成机制", "保留旧 ID，聚焦语言模型内部表示与生成边界，不替代 NLP 主干。"),
      topic("ai-learning-generative-05", "学习系统中的推理、规划与搜索", "保留旧 ID，研究推理时计算、搜索和外部验证怎样进入学习系统。"),
    ], iconKey: "atom", active: true }),
    branch({ id: "ai-multimodal", title: "语言、视觉、语音与多模态", summary: "理解语言、图像、声音、视频等信号怎样表示、识别、生成与对齐。", nodes: [
      topic("ai-multimodal-01", "自然语言处理", "覆盖语言建模、句法语义、检索、翻译、问答与文本生成。"),
      topic("ai-multimodal-02", "计算机视觉", "覆盖图像表征、识别、检测、分割、三维与视频理解。"),
      topic("ai-multimodal-03", "语音识别与生成", "理解声学信号、语音识别、说话人、合成与韵律。"),
      topic("ai-multimodal-04", "多模态理解与生成", "研究跨模态表示、条件生成、工具使用和信息损失。"),
      topic("ai-multimodal-05", "跨模态对齐与世界模型", "区分表示对齐、感知融合、预测模型和具身世界模型。"),
      topic("ai-multimodal-06", "感知评测与数据偏差", "判断数据集、标注、指标和真实环境差异怎样塑造感知能力。"),
    ], iconKey: "wand", active: true }),
    branch({ id: "ai-agents-robotics", title: "Agent、认知系统与机器人", summary: "从理性 Agent 和认知架构进入工具系统、多智能体与具身行动。", nodes: [
      topic("ai-agents-robotics-07", "理性 Agent 与认知架构", "比较反射、目标、效用、学习 Agent 与经典认知架构。"),
      topic("ai-agents-robotics-06", "机器人感知、控制与具身智能", "连接传感、定位、运动规划、控制、操纵和现实反馈。"),
      topic("ai-agents-robotics-08", "多智能体系统与协作博弈", "研究通信、协调、机制设计、涌现和集体失效。"),
      topic("ai-agents-robotics-01", "提示、上下文与任务契约", "研究目标、材料、约束、完成标准和上下文寿命。"),
      topic("ai-agents-robotics-02", "工具调用与 MCP", "区分模型决策、工具契约、权限、执行和结果验证。"),
      topic("ai-agents-robotics-03", "记忆、状态与身份", "区分对话历史、任务状态、长期记忆与权威原件。"),
      topic("ai-agents-robotics-04", "工作流与多 Agent 协作", "研究分解、依赖、并行、交接、审查和协作失效。"),
      topic("ai-agents-robotics-05", "可靠性、权限与可观测性", "让行动可发现、可解释、可恢复，并受最小权限约束。"),
    ], iconKey: "bot", active: true }),
    branch({ id: "ai-engineering", title: "数据、训练、评测与 AI 工程", summary: "把数据、实验、训练、评测、部署、监控和维护连成可复现系统。", nodes: [
      topic("ai-engineering-01", "数据获取与治理", "处理数据来源、许可、质量、标注、版本、隐私和代表性。"),
      topic("ai-engineering-02", "规模、算力与训练", "理解分布式训练、扩展规律、能耗、硬件和训练稳定性。"),
      topic("ai-engineering-03", "对齐、安全与反馈", "区分监督反馈、偏好优化、红队和运行时安全控制。"),
      topic("ai-engineering-04", "推理优化与部署", "研究压缩、量化、缓存、服务、端侧部署、延迟和成本。"),
      topic("ai-engineering-05", "开源、开放权重与生态", "区分开放源代码、开放权重、数据透明度、许可和可复现性。"),
      topic("ai-engineering-06", "评测、基准与实验设计", "把任务定义、数据切分、指标、人工评审和统计不确定性连起来。"),
      topic("ai-engineering-07", "MLOps、监控与生命周期", "管理模型注册、数据漂移、灰度、回滚、观测和退役。"),
      topic("ai-engineering-08", "鲁棒性、隐私与机器学习安全", "覆盖对抗样本、数据投毒、提示注入、隐私攻击和防护边界。"),
    ], iconKey: "database" }),
    branch({ id: "ai-products", title: "产品、人机协作与行业应用", summary: "研究能力怎样进入真实任务、界面、组织和行业责任。", nodes: [
      topic("ai-products-01", "学习与知识工作", "把解释、检索、写作、复习和本人理解证据分开。"),
      topic("ai-products-02", "软件开发与代码协作", "研究需求、生成、审查、测试、运行和责任交接。"),
      topic("ai-products-03", "内容、视觉与创意协作", "区分探索、生成、编辑、作者控制、来源与成品责任。"),
      topic("ai-products-04", "组织流程与自动化", "判断任务是否值得自动化，以及例外、升级和人工接管如何设计。"),
      topic("ai-products-05", "人机界面与协作体验", "研究可见状态、可控性、解释、信任校准和认知负担。"),
      topic("ai-products-06", "行业应用与专业责任", "比较医疗、教育、科研、金融、制造、公共服务等领域的证据门槛。"),
      topic("ai-products-07", "采用、组织变革与价值评估", "把局部能力、流程改变、成本、技能、责任和长期价值连起来。"),
    ], iconKey: "puzzle", active: true }),
    branch({ id: "ai-society", title: "安全、伦理、治理与产业", summary: "处理风险、权利、规则、劳动、基础设施与产业权力。", nodes: [
      topic("ai-society-01", "芯片、云与产业链", "理解算力、半导体、云平台、能源和供应约束。"),
      topic("ai-society-02", "商业模式与平台权力", "分析模型、数据、分发、锁定、议价和生态控制。"),
      topic("ai-society-03", "版权、隐私与数据权利", "区分训练、输入、输出、个人数据和不同法域权利。"),
      topic("ai-society-04", "偏见、公平与责任", "从群体、指标、情境、伤害和申诉理解公平取舍。"),
      topic("ai-society-05", "劳动、教育与人的意义", "研究任务重组、技能变化、监控、不平等和人的主体性。"),
      topic("ai-society-06", "AI 安全、失控与滥用", "区分事故、对抗、滥用、系统性风险和长期风险论证。"),
      topic("ai-society-07", "标准、法规与公共治理", "理解风险框架、标准、监管、审计和跨法域差异。"),
      topic("ai-society-08", "科研共同体、产业结构与地缘政治", "观察研究开放性、资本、国家能力、人才和国际竞争。"),
    ], iconKey: "scale" }),
  ],
};

export const LANGUAGE_DOMAIN: ResearchDomain = {
  id: "language",
  title: "语言研究",
  mark: "长期语言线",
  description: "用语言学共同骨架连接日语、古日语、汉语、古汉语、拉丁语、英语和德语，让每门语言既能实用，也能进入历史与文化深处。",
  mapLead: "共同基础负责联想，具体语言负责长期积累；练习和考试事实仍留在语言学习原件。",
  cardClass: "domain-card-language",
  branches: [
    branch({ id: "language-foundations", title: "语言学共同基础", summary: "语音、音系、形态、句法、语义和语用的共同工具箱。", nodes: ["语音与发音机制", "音系与音变", "形态与构词", "句法与语序", "语义与概念", "语用与会话"], iconKey: "languages", active: true }),
    branch({ id: "language-history-typology", title: "语言史、类型与比较", summary: "观察语言怎样分化、接触、演变并形成不同结构。", nodes: ["历史语言学与比较法", "语言类型学", "语系、谱系与区域扩散", "语法化、借词与语言接触"], iconKey: "history" }),
    branch({ id: "language-mind-learning", title: "语言、心智与习得", summary: "研究理解、产生、记忆和获得语言的机制。", nodes: ["第一语言习得", "第二语言习得", "心理语言学", "记忆、输入、输出与反馈"], iconKey: "brain", active: true }),
    branch({ id: "language-society", title: "语言、社会、文化与使用", summary: "理解身份、权力、礼貌、方言和真实场景中的语言选择。", nodes: ["社会语言学", "语域、礼貌与身份", "方言、标准语与语言政策", "话语、修辞与文化语码"], iconKey: "users" }),
    branch({ id: "language-text-tools", title: "文字、文献、语料、词典与翻译", summary: "连接书写系统、古典文献、检索工具和跨语言解释。", nodes: ["文字系统与正字法", "文献学、版本与校勘", "语料库与数字人文", "词典、注释与检索", "翻译理论与实践"], iconKey: "library" }),
    branch({ id: "language-japanese", title: "日语（含古日语）", summary: "从现代实用能力进入语史、文体、敬语和古典日语。", nodes: ["现代日语语音与文字", "语法、敬语与语用", "词汇、汉字与外来语", "日语史与古日语", "文学、媒体与真实语料"], iconKey: "bookmark", active: true }),
    branch({ id: "language-chinese", title: "汉语（含古汉语）", summary: "连接现代汉语、方言、文字训诂、文言句法与典籍阅读。", nodes: ["现代汉语与方言", "汉字形音义", "训诂、音韵与校勘", "古汉语词汇与句法", "经史子集与文体", "古典表达的现代转化"], iconKey: "feather", active: true }),
    branch({ id: "language-latin", title: "拉丁语", summary: "从屈折语法和精读进入罗马文化、教会传统与欧洲学术语汇。", nodes: ["语音、重音与拼写", "名词变格与动词变位", "句法与长句分析", "古典拉丁语文献", "中世纪与新拉丁语"], iconKey: "landmark", active: true }),
    branch({ id: "language-english", title: "英语", summary: "把高阶实用英语与英语史、语体、写作和专业阅读相连接。", nodes: ["英语语音与听辨", "核心语法与语体", "词源、构词与英语史", "学术与专业阅读", "写作、修辞与口语表达"], iconKey: "book" }),
    branch({ id: "language-german", title: "德语", summary: "建立德语结构基础，并连接哲学、文学与现代社会语境。", nodes: ["语音、拼写与复合词", "格、性与词序", "动词系统与从句", "哲学与学术德语", "文学、历史与当代语境"], iconKey: "brackets" }),
  ],
};

export const THOUGHT_HISTORY_DOMAIN: ResearchDomain = {
  id: "thought-history",
  title: "思想史",
  mark: "观念的来路",
  description: "不只收集哲学家和观点，而是研究观念怎样回应时代问题，又怎样经由制度、书籍、宗教、教育与公共讨论流传和变形。",
  mapLead: "同时追踪思想内容、历史处境和传播机制，避免把人物压缩成一句名言。",
  cardClass: "domain-card-thought",
  branches: [
    branch({ id: "thought-method", title: "思想史方法与史学理论", summary: "学习语境、概念、文本、接受史和比较研究的方法。", nodes: ["语境主义与问题意识", "概念史与关键词", "文本、作者与读者", "接受史、谱系与比较史"], iconKey: "search", active: true }),
    branch({ id: "thought-traditions", title: "世界思想传统与文明脉络", summary: "比较中国、印度、希腊罗马、犹太基督教、伊斯兰与现代传统。", nodes: ["中国思想传统", "印度思想传统", "希腊罗马传统", "犹太与基督教传统", "伊斯兰思想传统", "近现代全球思想交流"], iconKey: "map", active: true }),
    branch({ id: "thought-mind", title: "存在、知识、心灵、语言与行动", summary: "追踪哲学最持久的问题及其历史变体。", nodes: ["存在与形而上学", "知识、怀疑与真理", "心灵、自我与意识", "语言、意义与解释", "行动、自由与责任"], iconKey: "brain" }),
    branch({ id: "thought-society", title: "伦理、政治、法律、经济与社会思想", summary: "研究共同生活的正当性、秩序、权力、财富与制度。", nodes: ["德性、义务与幸福", "国家、权力与合法性", "法律、权利与正义", "经济、劳动与财产", "社会、阶级与性别"], iconKey: "scale", active: true }),
    branch({ id: "thought-religion", title: "宗教、神学与精神传统", summary: "理解信仰、仪式、救赎与世俗化如何塑造思想世界。", nodes: ["神、超越与终极关怀", "经典、教义与解释", "仪式、修行与共同体", "宗教改革、启蒙与世俗化"], iconKey: "landmark" }),
    branch({ id: "thought-science", title: "科学、技术、逻辑、数学与知识史", summary: "研究知识标准、证据形式与技术条件的历史变化。", nodes: ["逻辑与论证传统", "数学观念与证明", "自然哲学与现代科学", "技术、媒介与知识制度", "医学、身体与生命观"], iconKey: "atom" }),
    branch({ id: "thought-aesthetics", title: "艺术、文学与审美思想", summary: "追踪美、模仿、表现、形式、作者和大众文化等观念。", nodes: ["美与审美判断", "模仿、再现与真实", "形式、风格与媒介", "作者、天才与创作", "大众文化与文化工业"], iconKey: "feather" }),
    branch({ id: "thought-circulation", title: "教育、书籍、翻译、传播与公共领域", summary: "研究思想如何被保存、教学、翻译、争论并变成公共常识。", nodes: ["学校、学院与知识共同体", "书籍、目录与出版", "翻译、注释与跨文化误读", "报刊、沙龙与公共领域", "广播、网络与平台传播"], iconKey: "library" }),
  ],
};

export const ZZTJ_DOMAIN: ResearchDomain = {
  id: "zztj",
  title: "资治通鉴",
  mark: "熊逸讲透《资治通鉴》",
  description: "以《熊逸讲透资治通鉴》的课程顺序为主干，把每一讲放回季与历史段落，同时横向珍藏鲜活人物、文化语码、传世名篇和长线影响。",
  mapLead: "纵向跟随课程，横向回顾可反复调用的人物与文化线索；两套索引指向同一知识节点。",
  cardClass: "domain-card-zztj",
  branches: [
    branch({ id: "zztj-season-1", title: "熊逸讲透 · 第一季", summary: "从三家分晋起步，在战国秩序、人性与政治论辩中建立《通鉴》的阅读方法。", nodes: ["为什么从前 403 年开始", "智伯、晋阳之战与三家分晋", "豫让与私忠", "第一段‘臣光曰’与名分", "战国游士、变法与兼并", "秦统一前的制度与人物"], iconKey: "history", active: true }),
    branch({ id: "zztj-season-2", title: "熊逸讲透 · 第二季", summary: "沿课程第二季继续理解秦汉之际的制度、人物选择和历史解释。", nodes: ["课程第二季导论", "秦政、官僚与帝国治理", "楚汉人物与联盟", "汉初制度与政治选择", "功臣、诸侯与中央权力", "课程中的名篇与文化线索"], iconKey: "history", active: true }),
    branch({ id: "zztj-season-3", title: "熊逸讲透 · 第三季", summary: "在汉帝国发展中追踪皇权、制度、边疆、财政与人物命运。", nodes: ["课程第三季导论", "文景政治与制度积累", "汉武帝与国家扩张", "财政、战争与边疆", "宫廷、士人与舆论", "课程中的人物名场面"], iconKey: "history", active: true }),
    branch({ id: "zztj-season-4", title: "熊逸讲透 · 第四季", summary: "继续沿讲次观察制度成熟后的权力结构、文化生产和政治代价。", nodes: ["课程第四季导论", "皇权与官僚系统", "儒学、经术与政治语言", "外戚、宦官与宫廷网络", "史家判断与后世影响", "课程中的文化语码"], iconKey: "history", active: true }),
    branch({ id: "zztj-season-5", title: "熊逸讲透 · 第五季", summary: "当前进行中的西汉余绪，从赵充国、石显等人物继续理解帝国晚期问题。", nodes: ["400 毫米等降水线的千年难题", "赵充国为什么是资治典范", "赵充国的用兵风格与进攻节奏", "汉宣帝与将帅关系", "石显如何巩固权势", "第五季后续讲次待随课程生长"], iconKey: "bookmark", active: true }),
    branch({ id: "zztj-cross-index", title: "人物名场面与长线索引", summary: "把分散讲次中的鲜活人物、文化语码、名篇和深远线索重新串起来。", nodes: ["苏秦：二顷田与六国相印", "李斯：《谏逐客书》", "司马相如：文化语码", "刘向：目录学与知识秩序", "豫让：漆身吞炭与刺衣"], iconKey: "bookmark", active: true }),
  ],
};

export const IMAGE_MANAGEMENT_DOMAIN: ResearchDomain = {
  id: "image-management",
  title: "形象管理",
  mark: "外貌与表达",
  description: "把面容、发型、妆容、穿搭、体态和场合放在同一套视觉表达系统中；它研究如何呈现自己，不承担训练与健康本身。",
  mapLead: "先理解个人条件和视觉目标，再用可重复的护理、穿搭与场合方案逐步校准。",
  cardClass: "domain-card-image",
  branches: [
    branch({ id: "image-self", title: "面部、身体特征与个人定位", summary: "从真实比例、色彩和气质建立稳定自我认识。", nodes: ["面部结构与比例", "肤色、发色与个人色彩", "身体比例与轮廓", "气质、身份与形象目标"], iconKey: "search", active: true }),
    branch({ id: "image-skin", title: "皮肤、毛发与基础护理", summary: "建立清洁、保湿、防晒、胡须和身体护理的稳定底座。", nodes: ["皮肤屏障与清洁", "保湿、防晒与功效成分", "胡须、眉毛与体毛", "手足、口腔与细节护理"], iconKey: "activity" }),
    branch({ id: "image-hair", title: "发型、发质与头部轮廓", summary: "理解剪裁、长度、纹理、打理与面部轮廓的关系。", nodes: ["头脸比例与发型选择", "剪裁、层次与轮廓", "洗护、吹整与造型", "发色、烫染与长期维护"], iconKey: "feather" }),
    branch({ id: "image-makeup", title: "妆容与面部修饰", summary: "以自然、可复现和适合场合为目标理解底妆与结构修饰。", nodes: ["底妆与肤色校正", "眉眼结构与精神度", "轮廓、光影与修容", "唇色、质感与男性自然妆"], iconKey: "wand", active: true }),
    branch({ id: "image-clothes", title: "服装、版型与搭配", summary: "从版型、比例、材质和色彩建立可持续衣橱。", nodes: ["版型与身体比例", "色彩与层次", "材质、纹理与季节", "基础款、风格款与胶囊衣橱"], iconKey: "shirt", active: true }),
    branch({ id: "image-accessories", title: "鞋履、配饰、香气与细节", summary: "用少量高识别度细节完成整体而不是堆砌单品。", nodes: ["鞋型与场合", "包、眼镜与首饰", "香水与气味边界", "材质维护与整洁度"], iconKey: "bookmark" }),
    branch({ id: "image-posture", title: "体态、表情、镜头与呈现", summary: "研究站姿、动作、表情、拍摄和线上形象怎样共同传递状态。", nodes: ["站姿、坐姿与动态体态", "表情、眼神与亲和力", "镜头、光线与构图", "头像、视频与线上形象"], iconKey: "users" }),
    branch({ id: "image-systems", title: "场合规范、衣橱系统与长期管理", summary: "把日常、工作、社交和正式场合变成可快速调用的方案。", nodes: ["场合、礼仪与着装规范", "采购、预算与衣橱盘点", "试穿、搭配与照片复盘", "季节维护与形象迭代"], iconKey: "library" }),
  ],
};

export const FITNESS_DOMAIN: ResearchDomain = {
  id: "fitness",
  title: "运动健身",
  mark: "身体能力",
  description: "研究身体怎样适应训练、如何提高力量与耐力、怎样恢复并长期保持健康；外貌结果可以关联形象管理，但训练事实和身体数据仍有自己的主家。",
  mapLead: "从生理基础、动作能力、训练设计一路看到恢复、营养、风险和长期习惯。",
  cardClass: "domain-card-fitness",
  branches: [
    branch({ id: "fitness-physiology", title: "解剖、生理与运动适应", summary: "理解肌肉、关节、神经和能量系统怎样响应训练。", nodes: ["功能解剖与关节运动", "神经肌肉系统", "心肺与循环系统", "训练刺激、恢复与适应"], iconKey: "activity", active: true }),
    branch({ id: "fitness-strength", title: "力量、肌肥大与爆发力", summary: "理解负荷、容量、强度和动作速度怎样塑造不同能力。", nodes: ["最大力量与技术", "肌肥大与训练容量", "爆发力、速度与功率", "力量曲线与器械选择"], iconKey: "hammer", active: true }),
    branch({ id: "fitness-cardio", title: "心肺、耐力与能量系统", summary: "连接低强度基础、阈值、间歇和专项耐力。", nodes: ["有氧基础与线粒体适应", "乳酸阈与持续能力", "高强度间歇", "配速、心率与耐力计划"], iconKey: "activity" }),
    branch({ id: "fitness-skill", title: "动作模式、技术与运动技能", summary: "研究蹲、髋、推、拉、旋转、步态和专项技能学习。", nodes: ["蹲与髋铰链", "水平与垂直推拉", "步态、跑跳与落地", "动作学习、反馈与变式"], iconKey: "map", active: true }),
    branch({ id: "fitness-mobility", title: "灵活性、稳定性与活动度", summary: "区分可动范围、控制能力和真正影响动作的问题。", nodes: ["柔韧性与活动度", "核心与关节稳定", "呼吸、胸廓与骨盆", "热身、拉伸与动作准备"], iconKey: "activity" }),
    branch({ id: "fitness-programming", title: "训练计划、周期化与负荷管理", summary: "把目标、频率、动作、强度、容量和进阶组织成可执行计划。", nodes: ["目标与需求分析", "训练频率与分化", "强度、容量与进阶", "周期化、减量与调整"], iconKey: "map", active: true }),
    branch({ id: "fitness-recovery", title: "恢复、睡眠、疲劳与压力", summary: "识别可恢复负荷，并用睡眠、节奏和主观状态调整训练。", nodes: ["睡眠与昼夜节律", "局部与全身疲劳", "压力、情绪与训练准备度", "主动恢复与休息安排"], iconKey: "history" }),
    branch({ id: "fitness-nutrition", title: "营养、体重与身体组成", summary: "理解能量平衡、宏微量营养和增减脂的真实边界。", nodes: ["能量平衡与体重趋势", "蛋白质、碳水与脂肪", "水分、微量营养与补剂", "增肌、减脂与饮食依从性"], iconKey: "database" }),
    branch({ id: "fitness-injury", title: "损伤风险、疼痛与重返训练", summary: "在医学边界内理解风险、负荷、疼痛和逐步恢复。", nodes: ["损伤风险与负荷变化", "疼痛的多因素模型", "急性处理与就医边界", "康复、回归与再发预防"], iconKey: "scale" }),
    branch({ id: "fitness-testing", title: "测试、数据、设备与评估", summary: "用少量可靠指标观察趋势，不让设备替代身体判断。", nodes: ["力量与耐力测试", "围度、体重与身体组成", "心率、睡眠与可穿戴设备", "数据误差、趋势与复盘"], iconKey: "search" }),
    branch({ id: "fitness-habits", title: "行为习惯、长期健康与审美目标", summary: "把运动变成可以长期维持的生活系统，并协调能力、健康与外形。", nodes: ["动机、环境与习惯设计", "久坐、日常活动与步数", "生命周期与长期健康", "审美目标、身体意象与可持续性"], iconKey: "users" }),
  ],
};

export const ECONOMICS_FINANCE_DOMAIN: ResearchDomain = {
  id: "economics-finance",
  title: "经济与金融",
  mark: "投资认知底座",
  description: "用经济学解释世界怎样运转，用金融学理解现金流、价格与风险，再把会计、市场、资产类别和投资决策连接成一张可以长期扩展的地图。",
  mapLead: "从稀缺、激励和周期进入企业、证券、估值与组合。开源版只保留大纲，详细卡片留给使用者自己的库。",
  cardClass: "domain-card-finance",
  branches: [
    branch({ id: "ef-method-history", title: "经济学方法、思想与经济史", summary: "先理解经济学怎样提问、抽象、解释制度与历史变化。", nodes: ["稀缺、选择与机会成本", "边际分析、激励与均衡", "模型、假设与反事实", "经济思想、制度与历史路径"], iconKey: "history", active: true }),
    branch({ id: "ef-quant-data", title: "数量方法与金融数据", summary: "掌握复利、概率、统计、回归和回测，读懂数字而不被数字欺骗。", nodes: ["货币时间价值、复利与贴现", "概率、分布与统计描述", "相关、回归与因果", "时间序列、回测与数据偏差"], iconKey: "database", active: true }),
    branch({ id: "ef-micro-industry", title: "微观经济与产业组织", summary: "从供需、企业行为、竞争结构与信息问题理解行业和公司。", nodes: ["供给、需求与价格弹性", "消费者、企业与边际决策", "竞争结构、护城河与产业组织", "外部性、信息不对称与委托代理"], iconKey: "puzzle" }),
    branch({ id: "ef-macro-cycle", title: "宏观经济、政策与周期", summary: "读懂增长、通胀、就业、财政货币政策和经济周期的共同语言。", nodes: ["GDP、通胀、就业与实际增长", "经济周期与领先、同步、滞后指标", "货币政策、财政政策与传导", "生产率、长期增长与公共债务"], iconKey: "activity", active: true }),
    branch({ id: "ef-international", title: "国际经济、汇率与地缘", summary: "理解贸易、资本流动、汇率制度和地缘冲击怎样进入资产价格。", nodes: ["国际收支、经常账户与资本流动", "汇率、购买力平价与利率平价", "贸易、关税、供应链与产业政策", "地缘政治、制裁与国家风险"], iconKey: "map" }),
    branch({ id: "ef-money-banking", title: "货币、银行与金融体系", summary: "看懂货币创造、利率传导、银行资产负债表和系统性风险。", nodes: ["货币、信用与中央银行", "利率、收益率曲线与金融条件", "商业银行资产负债表与盈利", "影子银行、流动性与系统性风险"], iconKey: "landmark", active: true }),
    branch({ id: "ef-accounting-corporate", title: "会计、财报与公司金融", summary: "从三张报表进入盈利质量、资本配置、治理与企业融资决策。", nodes: ["三张财务报表与权责发生制", "财务比率、盈利质量与会计判断", "资本结构、融资与资本成本", "公司治理、营运资本与并购"], iconKey: "library", active: true }),
    branch({ id: "ef-market-trading", title: "市场结构、交易与结算", summary: "理解证券怎样发行、撮合、成交、清算、托管，以及交易成本从何而来。", nodes: ["一级市场、二级市场、交易所与场外市场", "订单簿、买卖价差、做市与流动性", "市价、限价、止损、滑点与执行", "清算、结算、托管、保证金与卖空"], iconKey: "store", active: true }),
    branch({ id: "ef-equity-research", title: "股票、行业与公司研究", summary: "从股东权利、商业模式和行业结构形成可检验的公司判断。", nodes: ["股票权利、市值、流通盘与每股指标", "行业生命周期与竞争格局", "商业模式、单位经济与护城河", "公司研究、财报电话会、催化剂与风险"], iconKey: "search", active: true }),
    branch({ id: "ef-fixed-income", title: "固定收益与信用", summary: "掌握债券价格、收益率、久期、信用利差与结构化产品。", nodes: ["债券价格、票息、到期收益率与总回报", "久期、凸性与利率风险", "信用评级、信用利差、违约与回收", "国债、公司债、可转债与证券化"], iconKey: "bookmark" }),
    branch({ id: "ef-funds-alternatives", title: "基金、指数与另类资产", summary: "理解 ETF、指数构建、房地产、商品、私募与加密资产。", nodes: ["共同基金、ETF、净值与跟踪误差", "指数构建、权重、再平衡与被动投资", "房地产、REIT、商品与基础设施", "私募股权、风险投资、对冲基金与加密资产"], iconKey: "library" }),
    branch({ id: "ef-derivatives", title: "衍生品、杠杆与对冲", summary: "理解远期、期货、期权、互换怎样定价、放大风险并管理暴露。", nodes: ["远期、期货、基差与套期保值", "期权、内在价值、隐含波动率与 Greeks", "互换、利率与信用衍生品", "杠杆、保证金、强平、套利与对手风险"], iconKey: "brackets" }),
    branch({ id: "ef-valuation-pricing", title: "估值与资产定价", summary: "把现金流、贴现率、风险溢价和市场价格放进同一套判断。", nodes: ["DCF、自由现金流与终值", "相对估值与估值倍数", "CAPM、Beta、因子与风险溢价", "安全边际、情景、敏感性与逆向估值"], iconKey: "scale", active: true }),
    branch({ id: "ef-portfolio-risk", title: "投资组合、财富与风险管理", summary: "从单项判断上升到配置、分散、再平衡和整体目标。", nodes: ["收益、波动、回撤与风险调整表现", "分散、相关性与有效前沿", "资产配置、再平衡与投资政策书", "VaR、压力测试、流动性与尾部风险"], iconKey: "map", active: true }),
    branch({ id: "ef-behavior-process", title: "行为金融、投资方法与复盘", summary: "识别偏差、市场机制与策略差异，把投资变成可校准的决策过程。", nodes: ["认知偏差、情绪与群体行为", "市场有效性、异常与价格发现", "价值、成长、质量、动量与主动被动", "投资论点、基准率、决策日志与归因"], iconKey: "brain", active: true }),
    branch({ id: "ef-law-tax-ethics", title: "法规、税务、伦理与投资者保护", summary: "理解披露、市场滥用、利益冲突、税务口径、费用和常见骗局。", nodes: ["证券监管、信息披露与市场滥用", "适当性、受托责任、利益冲突与职业伦理", "资本利得、股息、预扣税与账户税务", "招股书、费用、诈骗与投资者自我保护"], iconKey: "scale" }),
  ],
};
