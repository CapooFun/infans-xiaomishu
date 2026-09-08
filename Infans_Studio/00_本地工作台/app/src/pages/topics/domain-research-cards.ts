export type KnowledgeCardStatus = "overview" | "unclear" | "deep";

export function branchResearchStatusFromFormalNodes(formalNodeCount: number): "正在理解" | "待探索" {
  return formalNodeCount > 0 ? "正在理解" : "待探索";
}

const LEARNING_LEVEL_LABELS: Record<string, string> = {
  entry: "入门解释",
  core: "核心原典",
  deep: "深入系统",
  practice: "案例实践",
  extension: "延展深入",
  case: "案例精读",
  classic: "经典回看",
  current: "当前原件",
};

export function learningLevelLabel(level: string) {
  return LEARNING_LEVEL_LABELS[level] ?? "继续学习";
}

export type KnowledgeChoice = { id: string; label: string; detail: string };

export type KnowledgeCard = {
  id: string;
  kind: "overview" | "concept" | "context" | "confusion" | "choice" | "authored";
  eyebrow: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
  question?: string;
  choices?: KnowledgeChoice[];
};

export type KnowledgeNodeInput = {
  id?: string;
  topicId?: string;
  status?: "formal" | "outline";
  order?: number;
  title: string;
  description: string;
  sourcePath?: string;
  asOf?: string;
  jurisdiction?: string;
  claimTypes?: string[];
  sources?: Array<{ id: string; title: string; kind: string; role: string; locator: string; path?: string; url?: string }>;
  learningResources?: Array<{
    id: string;
    title: string;
    kind: string;
    level: string;
    reason: string;
    focus: string;
    creator: string;
    duration: string;
    language: string;
    access: string;
    use: string;
    asOf: string;
    path?: string;
    url?: string;
  }>;
  learningState?: "not-started" | "session-recorded" | "initial-understanding" | "can-explain" | "can-transfer" | "revisit-needed";
  learningRecords?: Array<{
    recordId: string;
    learningState: "session-recorded" | "initial-understanding" | "can-explain" | "can-transfer" | "revisit-needed";
    sourceConversationId: string;
    title: string;
    date: string;
    summary: string;
    nextStep: string;
    reviewedBy: string;
    acceptedByCapoo: boolean;
    sourcePath: string;
  }>;
  authoredCards?: KnowledgeCard[];
  conceptTitle?: string;
  concept?: string[];
  contextTitle?: string;
  context?: string[];
  contextBullets?: string[];
  confusionTitle?: string;
  confusion?: string[];
  choiceQuestion?: string;
  choices?: KnowledgeChoice[];
};

export type KnowledgeBranchInput = {
  id: string;
  title: string;
  summary: string;
  guidingQuestion: string;
  starterQuestions: string[];
};

export function orderKnowledgeNodesByTopics<T extends { topicId: string; order: number; nodeId: string }>(nodes: T[], topicIds: string[]) {
  const topicOrder = new Map(topicIds.map((topicId, index) => [topicId, index]));
  return [...nodes].sort((left, right) => (
    (topicOrder.get(left.topicId) ?? Number.MAX_SAFE_INTEGER) - (topicOrder.get(right.topicId) ?? Number.MAX_SAFE_INTEGER)
    || left.order - right.order
    || left.nodeId.localeCompare(right.nodeId)
  ));
}

export function knowledgeNodeId(branchId: string, nodeIndex: number, node?: KnowledgeNodeInput) {
  return node?.id || `${branchId}-${String(nodeIndex + 1).padStart(2, "0")}`;
}

export function buildKnowledgeCards(_branch: KnowledgeBranchInput, node: KnowledgeNodeInput, _nodeIndex: number): KnowledgeCard[] {
  if (!node.authoredCards?.length || node.status !== "formal" || !node.sources?.length) return [];
  return node.authoredCards;
}
export function buildKnowledgeExplainSeed(domainTitle: string, branchTitle: string, nodeTitle: string, card: KnowledgeCard, sources: KnowledgeNodeInput["sources"] = []) {
  const body = [...card.paragraphs, ...(card.bullets ?? []).map((item) => `- ${item}`)].join("\n");
  const question = card.question ? `\n这张卡留下的问题：${card.question}` : "";
  const references = sources.length ? `\n\n本节点已登记来源：\n${sources.map((source) => `- ${source.title}（${source.role}）${source.url ? `：${source.url}` : source.path ? `：${source.path}` : ""}`).join("\n")}` : "";
  return `我正在“${domainTitle}”领域的“${branchTitle} / ${nodeTitle}”里阅读下面这张知识卡：\n\n【${card.title}】\n${body}${question}${references}\n\n请先围绕当前内容给我一次详细但好懂的讲解：补足必要背景，解释关键关系，给一两个与“${domainTitle}”相关的具体例子，也指出我最容易混淆的地方。请区分来源事实、来源观点和你的推论；资料不足时直接说待核，不要补成确定事实。请联系它在“${branchTitle}”中的位置，并在必要时向上连接整个领域、向下展开一个关键细节，不要一上来考我。讲完后我会继续用文字或语音追问。`;
}
