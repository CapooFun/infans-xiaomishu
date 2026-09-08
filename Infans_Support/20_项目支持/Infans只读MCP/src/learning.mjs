const DOMAIN_REGISTRY = Object.freeze([
  { domainId: "game", title: "游戏", aliases: ["游戏", "电子游戏"], overviewPath: "70_领域研究/游戏/游戏文化研究_总览.md", learningRecordPath: "70_领域研究/游戏/学习记录" },
  { domainId: "ai", title: "人工智能", aliases: ["人工智能", "AI", "ai"], overviewPath: "70_领域研究/人工智能/人工智能_总览.md", learningRecordPath: "70_领域研究/人工智能/学习记录" },
  { domainId: "economics-finance", title: "经济与金融", aliases: ["经济与金融", "经济金融", "经济学", "金融"], overviewPath: "70_领域研究/经济与金融/经济与金融_总览.md", learningRecordPath: "70_领域研究/经济与金融/学习记录" },
  { domainId: "language", title: "语言研究", aliases: ["语言研究", "语言学", "日语", "汉语", "拉丁语", "英语", "德语"], overviewPath: "70_领域研究/语言研究/语言研究_总览.md", learningRecordPath: "70_领域研究/语言研究/学习记录" },
  { domainId: "thought-history", title: "思想史", aliases: ["思想史", "哲学史", "神学史"], overviewPath: "70_领域研究/思想史/思想史_总览.md", learningRecordPath: "70_领域研究/思想史/学习记录" },
  { domainId: "zztj", title: "资治通鉴", aliases: ["资治通鉴", "通鉴", "熊逸讲透"], overviewPath: "70_领域研究/资治通鉴/资治通鉴_总览.md", learningRecordPath: "70_领域研究/资治通鉴/学习记录" },
  { domainId: "image-management", title: "形象管理", aliases: ["形象管理", "穿搭", "化妆", "发型"], overviewPath: "70_领域研究/形象管理/形象管理_总览.md", learningRecordPath: "70_领域研究/形象管理/学习记录" },
  { domainId: "fitness", title: "运动健身", aliases: ["运动健身", "健身", "训练", "运动"], overviewPath: "70_领域研究/运动健身/运动健身_总览.md", learningRecordPath: "70_领域研究/运动健身/学习记录" },
]);
const GENERIC_LEARNING_RE = /^(?:我)?(?:今天)?(?:想|要|来|继续)?(?:学习|学|复习|看|聊|讲)(?:一下|一点|点)?(?:东西|知识|内容|东西儿)?(?:吧|呢|啊)?$/u;
const LEARNING_STATE_LABELS = Object.freeze({
  "session-recorded": "已记录学习会话",
  "initial-understanding": "已有初步认识",
  "can-explain": "能独立解释",
  "can-transfer": "能迁移使用",
  "revisit-needed": "需要复习",
});
function text(value) {
  return String(value ?? "").trim();
}
function markdownText(result) {
  return result?.type === "text" ? text(result.text) : "";
}
function frontmatter(markdown) {
  const match = text(markdown).match(/^---\s*\n([\s\S]*?)\n---/u);
  if (!match) return {};
  const values = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/u);
    if (field) values[field[1]] = field[2].replace(/^['"]|['"]$/gu, "");
  }
  return values;
}
function markdownSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return text(markdown).match(new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "mu"))?.[1] ?? "";
}
function numberedChoices(markdown, sourcePath) {
  const branchSection = [...text(markdown).matchAll(/^##\s+(.+领域主干|领域主干)\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/gmu)][0]?.[2] ?? "";
  return [...branchSection.matchAll(/^\s*(\d+)[.\u3001]\s+(.+?)\s*$/gmu)].map((match) => ({
    kind: "branch",
    position: Number(match[1]),
    title: text(match[2]),
    stableId: null,
    sourcePath,
  }));
}
function specialOverviewChoices(domain, markdown) {
  if (domain.domainId === "thought-history") {
    return [...markdownSection(markdown, "目前关注").matchAll(/^###\s+(.+?)\s*$/gmu)]
      .map((match, index) => ({ kind: "branch", position: index + 1, title: text(match[1]), stableId: null, sourcePath: domain.overviewPath }))
      .filter((choice) => !choice.title.includes("暂不单列"));
  }
  if (domain.domainId === "zztj") {
    return [...markdownSection(markdown, "纵向课程主轴").matchAll(/^-\s+\[\[[^\]|]+\|([^\]]+)\]\][：:]\s*(.+?)\s*$/gmu)]
      .map((match, index) => ({ kind: "branch", position: index + 1, title: text(match[1]), detail: text(match[2]), stableId: null, sourcePath: domain.overviewPath }));
  }
  if (domain.domainId === "image-management") {
    return [...markdownSection(markdown, "这里是什么").matchAll(/^-\s+\*\*(.+?)\*\*[：:]\s*(.+?)\s*$/gmu)]
      .map((match, index) => ({ kind: "branch", position: index + 1, title: text(match[1]), detail: text(match[2]), stableId: null, sourcePath: domain.overviewPath }));
  }
  return [];
}
function explicitDomain(query) {
  const normalized = text(query);
  return DOMAIN_REGISTRY.find((domain) => domain.aliases.some((alias) => normalized.includes(alias))) ?? null;
}
function learningSearchTerm(query, domain) {
  let term = text(query).replace(/^(?:我)?(?:今天)?(?:想|要|来|继续(?:上次的?)?)?(?:学习|学|复习|了解|讲讲|讲|聊聊|聊)?\s*/u, "");
  term = term.replace(/(?:一下|一点|吧|呢|啊)$/u, "").trim();
  if (domain) {
    for (const alias of domain.aliases) term = term.replaceAll(alias, "").trim();
  }
  return term || text(query);
}
function isBroadDomainRequest(query, domain) {
  let remaining = text(query);
  for (const alias of domain.aliases) remaining = remaining.replaceAll(alias, "");
  remaining = remaining.replace(/[\s，。、！？,.!?]/gu, "");
  return !remaining || GENERIC_LEARNING_RE.test(remaining) || /^(?:我)?(?:今天)?(?:想|要|来|继续)?(?:学习|学|复习|聊|讲)(?:一下|一点|点)?(?:吧|呢|啊)?$/u.test(remaining);
}
function inferDomainFromPath(filePath) {
  return DOMAIN_REGISTRY.find((domain) => filePath.startsWith(domain.overviewPath.split("/").slice(0, 2).join("/"))) ?? null;
}
function parseCatalogCandidate(excerpt, sourcePath) {
  const match = text(excerpt).match(/^\|\s*([a-z0-9][a-z0-9-]*)\s*\|\s*([a-z0-9][a-z0-9-]*)\s*\|\s*([a-z0-9][a-z0-9-]*)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/u);
  if (!match) return null;
  return {
    kind: "node",
    branchId: match[1],
    topicId: match[2],
    nodeId: match[3],
    order: Number(match[4]),
    title: text(match[5]),
    cognitiveTask: text(match[6]),
    contentStatus: "outline",
    sourcePath,
  };
}
function parseNodeCandidate(markdown, sourcePath) {
  const data = frontmatter(markdown);
  if (data.type !== "domain-knowledge-node" || !data.nodeId) return null;
  return {
    kind: "node",
    domainId: data.domainId,
    branchId: data.branchId,
    topicId: data.topicId,
    nodeId: data.nodeId,
    title: text(markdown).match(/^#\s+(.+)$/mu)?.[1]?.trim() || data.nodeId,
    cognitiveTask: data.description || "",
    contentStatus: data.status || "unknown",
    sourcePath,
  };
}
function parseLearningRecord(markdown, sourcePath) {
  const data = frontmatter(markdown);
  if (data.type !== "domain-learning-record" || !data.nodeId || !data.recordId || !data.date) return null;
  const heading = text(markdown).match(/^#\s+(.+)$/mu)?.[1]?.trim() || data.nodeId;
  const nextSection = markdownSection(markdown, "下一次从哪里继续");
  const nextStep = nextSection.split(/\r?\n/u).map((line) => line.replace(/^[-*]\s+/u, "").trim()).find(Boolean) || "回读记录确认下一步";
  return {
    domainId: data.domainId,
    nodeId: data.nodeId,
    recordId: data.recordId,
    date: data.date,
    learningState: data.learningState,
    learningStateLabel: LEARNING_STATE_LABELS[data.learningState] || data.learningState,
    title: heading,
    nextStep,
    sourcePath,
  };
}
async function recentLearning(reader, domainIds) {
  const records = [];
  for (const domain of DOMAIN_REGISTRY.filter((item) => domainIds.includes(item.domainId))) {
    try {
      const listing = await reader.list(domain.learningRecordPath, 1);
      for (const entry of listing.entries.filter((item) => item.type === "file" && item.path.endsWith(".md"))) {
        const record = parseLearningRecord(markdownText(await reader.read(entry.path, { maxChars: 12000 })), entry.path);
        if (record) records.push(record);
      }
    } catch (error) {
      if (error?.code !== "NOT_FOUND") throw error;
    }
  }
  return records.sort((left, right) => right.date.localeCompare(left.date) || right.recordId.localeCompare(left.recordId));
}
async function nodeCandidates(reader, targetMatches) {
  const candidates = [];
  const seen = new Set();
  for (const match of targetMatches.results ?? []) {
    let candidate = parseCatalogCandidate(match.excerpt, match.path);
    if (!candidate && match.path.includes("/知识节/") && match.path.endsWith(".md")) {
      candidate = parseNodeCandidate(markdownText(await reader.read(match.path, { maxChars: 12000 })), match.path);
    }
    if (!candidate || seen.has(candidate.nodeId)) continue;
    seen.add(candidate.nodeId);
    const domain = candidate.domainId ? DOMAIN_REGISTRY.find((item) => item.domainId === candidate.domainId) : inferDomainFromPath(match.path);
    candidates.push({ ...candidate, domainId: candidate.domainId || domain?.domainId || null, domainTitle: domain?.title || null });
    if (candidates.length >= 12) break;
  }
  return candidates;
}
export async function prepareKnowledgeLearning(reader, query, { protocolPath, trustPath }) {
  const requestedQuery = text(query);
  const domain = explicitDomain(requestedQuery);
  const generic = GENERIC_LEARNING_RE.test(requestedQuery.replace(/[\s，。、！？,.!?]/gu, ""));
  const targetQuery = learningSearchTerm(requestedQuery, domain);
  const [protocol, trustContract, targetMatches, catalogMatches] = await Promise.all([
    reader.read(protocolPath, { maxChars: 80000 }),
    reader.read(trustPath, { maxChars: 80000 }),
    reader.search(targetQuery, { path: "70_领域研究", limit: 30 }),
    reader.search("type: domain-knowledge-catalog", { path: "70_领域研究", limit: 20 }),
  ]);
  if (generic && !domain) {
    const recent = await recentLearning(reader, DOMAIN_REGISTRY.map((item) => item.domainId));
    return {
      mode: "knowledge-map-learning-bootstrap",
      route: "domain-choices",
      requestedQuery,
      acknowledgement: "已读取 Infans 知识地图学习协议，先从真实母题选择，不自行生成课程。",
      choices: DOMAIN_REGISTRY.map(({ aliases, learningRecordPath, ...choice }) => ({ kind: "domain", ...choice })),
      recentLearning: recent,
      requiredResponse: ["用一句话确认已读取协议", "列出 choices 中的八个真实母题", "补充 recentLearning 中的最近位置后等待选择", "不要开始教学或自拟课程"],
      protocol,
      trustContract,
    };
  }
  if (domain && isBroadDomainRequest(requestedQuery, domain)) {
    const overview = await reader.read(domain.overviewPath, { maxChars: 80000 });
    const overviewText = markdownText(overview);
    const choices = numberedChoices(overviewText, domain.overviewPath);
    const resolvedChoices = choices.length ? choices : specialOverviewChoices(domain, overviewText);
    const recent = await recentLearning(reader, [domain.domainId]);
    return {
      mode: "knowledge-map-learning-bootstrap",
      route: "branch-choices",
      requestedQuery,
      domain: { domainId: domain.domainId, title: domain.title, overviewPath: domain.overviewPath },
      acknowledgement: `已定位到「${domain.title}」真实总览，下面只展开原件中现有的下一级目录。`,
      choices: resolvedChoices,
      recentLearning: recent,
      requiredResponse: ["简短确认已定位母题", "只列出 choices 中的真实下一级目录", "说明 recentLearning 中的上次学习位置", "等待用户继续选择"],
      protocol,
      trustContract,
      domainOverview: overview,
      catalogMatches,
    };
  }
  const candidates = await nodeCandidates(reader, targetMatches);
  const inferredDomainIds = [...new Set(candidates.map((candidate) => candidate.domainId).filter(Boolean))];
  const recent = await recentLearning(reader, inferredDomainIds.length ? inferredDomainIds : DOMAIN_REGISTRY.map((item) => item.domainId));
  const route = candidates.length === 1 ? "node-ready" : candidates.length > 1 ? "node-choices" : "clarify";
  return {
    mode: "knowledge-map-learning-bootstrap",
    route,
    requestedQuery,
    acknowledgement: candidates.length === 1
      ? `已定位唯一知识节点「${candidates[0].title}」（${candidates[0].nodeId}）。`
      : candidates.length > 1
        ? "找到多个真实知识节点，需要从下列候选中选一个。"
        : "暂时没有定位到唯一知识节点，需要根据真实搜索结果做一次最小澄清。",
    nodeCandidates: candidates,
    recentLearning: recent,
    requiredResponse: route === "node-ready"
      ? ["确认节点标题、nodeId、认知任务和内容状态", "如有同 nodeId 记录，说明上次学习位置", "给出开始文字学习、生成 GPT Live 交接包或查看上下级三个选项", "不要改换到 AI 自拟课程"]
      : route === "node-choices"
        ? ["只列出 nodeCandidates 中的真实候选", "等待选定唯一 nodeId"]
        : ["根据 targetMatches 提一个最小澄清问题", "不要自己造节点或课程"],
    protocol,
    trustContract,
    catalogMatches,
    targetMatches,
  };
}
export { DOMAIN_REGISTRY, isBroadDomainRequest };
