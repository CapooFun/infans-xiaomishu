import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,119}$/u;
const DOMAIN_IDS = new Set([
  "game",
  "ai",
  "economics-finance",
  "language",
  "thought-history",
  "zztj",
  "image-management",
  "fitness",
]);

export const DOMAIN_KNOWLEDGE_DIRECTORIES = Object.freeze([
  "70_专题研究/游戏/知识节点",
  "70_专题研究/人工智能/知识节点",
  "70_专题研究/经济与金融/知识节点",
  "70_专题研究/语言研究/知识节点",
  "70_专题研究/思想史/知识节点",
  "70_专题研究/资治通鉴/知识节点",
  "70_专题研究/形象管理/知识节点",
  "70_专题研究/运动健身/知识节点",
]);

export const DOMAIN_KNOWLEDGE_RESOURCE_CATALOGS = Object.freeze([
  "70_专题研究/人工智能/人工智能知识地图_关键材料.md",
]);

export const DOMAIN_LEARNING_RECORD_DIRECTORIES = Object.freeze([
  "70_专题研究/游戏/学习记录",
  "70_专题研究/人工智能/学习记录",
  "70_专题研究/经济与金融/学习记录",
  "70_专题研究/语言研究/学习记录",
  "70_专题研究/思想史/学习记录",
  "70_专题研究/资治通鉴/学习记录",
  "70_专题研究/形象管理/学习记录",
  "70_专题研究/运动健身/学习记录",
]);

const LEARNING_STATES = new Set([
  "session-recorded",
  "initial-understanding",
  "can-explain",
  "can-transfer",
  "revisit-needed",
]);

function id(value) {
  const normalized = String(value || "").trim();
  return ID_RE.test(normalized) ? normalized : "";
}

function text(value) {
  return String(value || "").replace(/\*\*/gu, "").replace(/\s+/gu, " ").trim();
}

function dateText(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  return text(value);
}

function relativeVaultPath(value) {
  const normalized = String(value || "").replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized.split("/").includes("..")) return "";
  return normalized;
}

function sourceUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function parseSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const sourceId = id(entry?.id);
    const title = text(entry?.title);
    const sourcePath = relativeVaultPath(entry?.path);
    const url = sourceUrl(entry?.url);
    if (!sourceId || !title || (!sourcePath && !url)) return [];
    return [{
      id: sourceId,
      title,
      kind: id(entry?.kind) || "reference",
      role: id(entry?.role) || "reference",
      locator: text(entry?.locator),
      ...(sourcePath ? { path: sourcePath } : {}),
      ...(url ? { url } : {}),
    }];
  });
}

function parseLearningResources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const resourceId = id(entry?.id);
    const title = text(entry?.title);
    const resourcePath = relativeVaultPath(entry?.path);
    const url = sourceUrl(entry?.url);
    const reason = text(entry?.reason);
    if (!resourceId || !title || !reason || (!resourcePath && !url)) return [];
    return [{
      id: resourceId,
      title,
      kind: id(entry?.kind) || "resource",
      level: id(entry?.level) || "core",
      reason,
      focus: text(entry?.focus),
      creator: text(entry?.creator),
      duration: text(entry?.duration),
      language: text(entry?.language),
      access: id(entry?.access) || "unknown",
      use: text(entry?.use),
      asOf: dateText(entry?.asOf),
      ...(resourcePath ? { path: resourcePath } : {}),
      ...(url ? { url } : {}),
    }];
  });
}

function markdownField(section, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const value = section.match(new RegExp(`^- \\*\\*${escaped}\\*\\*[：:]\\s*(.+)$`, "mu"))?.[1];
    if (value) return text(value);
  }
  return "";
}

function resourceKind(value) {
  if (/课程/u.test(value)) return "course";
  if (/教材|专著|书/u.test(value)) return "book";
  if (/论文|研究/u.test(value)) return "paper";
  if (/框架|指南|标准/u.test(value)) return "guide";
  return "resource";
}

function resourceAccess(value) {
  if (/可能需要|购买|借阅|部分/u.test(value)) return "mixed";
  if (/免费|无需登录|公开/u.test(value)) return "free";
  return "unknown";
}

export function parseDomainLearningResourceCatalog(markdown, sourcePath = "") {
  const parsed = matter(String(markdown || ""));
  if (parsed.data.type !== "domain-learning-resource-catalog") return [];
  const domainId = id(parsed.data.domainId);
  if (!DOMAIN_IDS.has(domainId)) throw new Error(`${sourcePath || "关键材料目录"}: domainId 不在八母题白名单`);
  const sections = [...parsed.content.matchAll(/^##\s+(\d+)\.\s+(.+)$/gmu)];
  const mappings = [];
  sections.forEach((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = sections[index + 1]?.index ?? parsed.content.length;
    const section = parsed.content.slice(start, end);
    const nodeId = id(section.match(/对应\s+`([a-z0-9][a-z0-9-]*)`/u)?.[1]);
    const title = markdownField(section, ["中文标题／原文标题", "中文标题/原文标题"]);
    const creator = markdownField(section, ["作者或机构"]);
    const typeAndLanguage = markdownField(section, ["类型与原始语言"]);
    const summary = markdownField(section, ["主要讲什么"]);
    const reason = markdownField(section, ["为什么在这个节点"]);
    const focus = markdownField(section, ["重点看什么", "初学者重点看什么"]);
    const duration = markdownField(section, ["建议投入时间"]);
    const accessText = markdownField(section, ["访问条件", "获取条件"]);
    const asOf = markdownField(section, ["核验日期"]);
    const url = sourceUrl(section.match(/^- \*\*原始来源链接\*\*[：:]\s*<([^>]+)>/mu)?.[1]);
    if (!nodeId || !title || !creator || !reason || !focus || !duration || !accessText || !asOf || !url) return;
    const resource = parseLearningResources([{
      id: `ai-key-material-${String(match[1]).padStart(2, "0")}`,
      title,
      kind: resourceKind(typeAndLanguage),
      level: "core",
      reason: summary ? `${summary} ${reason}` : reason,
      focus,
      creator,
      duration,
      language: text(typeAndLanguage.split("；").slice(1).join("；")) || "语言信息见原件",
      access: resourceAccess(accessText),
      use: `${focus}；按建议投入时间分段使用，不要求首轮通读。`,
      asOf,
      url,
    }])[0];
    if (resource) mappings.push({ domainId, nodeId, resource });
  });
  return mappings;
}

function paragraphBlocks(markdown) {
  const bullets = [];
  const paragraphs = [];
  for (const block of String(markdown || "").trim().split(/\n\s*\n/u)) {
    const lines = block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (lines.length && lines.every((line) => /^[-*]\s+/u.test(line))) {
      bullets.push(...lines.map((line) => text(line.replace(/^[-*]\s+/u, ""))));
      continue;
    }
    const value = text(lines.join(" "));
    if (value) paragraphs.push(value);
  }
  return { paragraphs, bullets };
}

function markdownSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const source = String(markdown || "");
  const headingMatch = new RegExp(`^##\\s+${escaped}\\s*$`, "mu").exec(source);
  if (!headingMatch) return "";
  const rest = source.slice((headingMatch.index || 0) + headingMatch[0].length);
  const nextHeading = /^##\s+/mu.exec(rest);
  return rest.slice(0, nextHeading?.index ?? rest.length).trim();
}

export function parseDomainLearningRecord(markdown, sourcePath = "") {
  const parsed = matter(String(markdown || ""));
  if (parsed.data.type !== "domain-learning-record") return null;
  const domainId = id(parsed.data.domainId);
  const nodeId = id(parsed.data.nodeId);
  const recordId = id(parsed.data.recordId);
  const learningState = id(parsed.data.learningState);
  const sourceConversationId = text(parsed.data.sourceConversationId);
  const title = text(parsed.content.match(/^#\s+(.+)$/mu)?.[1]);
  const date = dateText(parsed.data.date);
  const summary = text(parsed.data.description)
    || text(parsed.content.match(/^>\s*(.+)$/mu)?.[1]);
  const nextStep = paragraphBlocks(markdownSection(parsed.content, "下一次从哪里继续")).paragraphs[0] || "";
  const errors = [];
  if (!DOMAIN_IDS.has(domainId)) errors.push("domainId 不在八母题白名单");
  if (!nodeId) errors.push("nodeId 缺失或不合法");
  if (!recordId) errors.push("recordId 缺失或不合法");
  if (!LEARNING_STATES.has(learningState)) errors.push("learningState 不在允许状态中");
  if (!sourceConversationId) errors.push("sourceConversationId 缺失");
  if (!date) errors.push("date 缺失");
  if (!title) errors.push("缺少一级标题");
  if (!summary) errors.push("缺少 description 或入库结论");
  if (errors.length) throw new Error(`${sourcePath || recordId || "学习记录"}: ${errors.join("；")}`);
  return {
    domainId,
    nodeId,
    recordId,
    learningState,
    sourceConversationId,
    title,
    date,
    summary,
    nextStep,
    reviewedBy: text(parsed.data.reviewedBy),
    acceptedByCapoo: parsed.data.acceptedByCapoo === true,
    sourcePath,
  };
}

export function parseDomainKnowledgeNode(markdown, sourcePath = "") {
  const parsed = matter(String(markdown || ""));
  if (parsed.data.type !== "domain-knowledge-node") return null;
  const domainId = id(parsed.data.domainId);
  const branchId = id(parsed.data.branchId);
  const topicId = id(parsed.data.topicId);
  const nodeId = id(parsed.data.nodeId);
  const status = parsed.data.status === "formal" ? "formal" : parsed.data.status === "outline" ? "outline" : "";
  const title = text(parsed.content.match(/^#\s+(.+)$/mu)?.[1]);
  const sources = parseSources(parsed.data.sources);
  const learningResources = parseLearningResources(parsed.data.learningResources);
  const cards = [];
  const sectionRe = /^##\s+(.+?)\s+\{#([a-z0-9][a-z0-9-]{0,79})\}\s*$/gmu;
  const matches = [...parsed.content.matchAll(sectionRe)];
  matches.forEach((match, index) => {
    const sectionId = id(match[2]);
    const start = (match.index || 0) + match[0].length;
    const end = matches[index + 1]?.index ?? parsed.content.length;
    const body = paragraphBlocks(parsed.content.slice(start, end));
    if (!sectionId || !body.paragraphs.length) return;
    cards.push({
      id: `${nodeId}-${sectionId}`,
      kind: "authored",
      eyebrow: text(match[1]),
      title: index === 0 ? title : text(match[1]),
      paragraphs: body.paragraphs,
      ...(body.bullets.length ? { bullets: body.bullets } : {}),
    });
  });
  const errors = [];
  if (!DOMAIN_IDS.has(domainId)) errors.push("domainId 不在八母题白名单");
  if (!branchId) errors.push("branchId 缺失或不合法");
  if (!topicId) errors.push("topicId 缺失或不合法");
  if (!nodeId) errors.push("nodeId 缺失或不合法");
  if (!status) errors.push("status 只能是 formal 或 outline");
  if (!title) errors.push("缺少一级标题");
  if (status === "formal" && sources.length === 0) errors.push("formal 节点必须有来源");
  if (status === "formal" && cards.length < 2) errors.push("formal 节点至少需要两张正文卡");
  if (new Set(sources.map((source) => source.id)).size !== sources.length) errors.push("来源 ID 重复");
  if (new Set(learningResources.map((resource) => resource.id)).size !== learningResources.length) errors.push("学习资源 ID 重复");
  if (new Set(cards.map((card) => card.id)).size !== cards.length) errors.push("卡片 ID 重复");
  if (cards.some((card) => !ID_RE.test(card.id))) errors.push("组合卡片 ID 超长或不合法");
  if (errors.length) throw new Error(`${sourcePath || nodeId || "知识节点"}: ${errors.join("；")}`);
  return {
    domainId,
    branchId,
    topicId,
    nodeId,
    title,
    description: text(parsed.data.description),
    status,
    order: Number.isFinite(Number(parsed.data.order)) ? Number(parsed.data.order) : 999,
    asOf: dateText(parsed.data.asOf),
    jurisdiction: text(parsed.data.jurisdiction),
    claimTypes: Array.isArray(parsed.data.claimTypes) ? parsed.data.claimTypes.map(id).filter(Boolean) : [],
    sourcePath,
    sources,
    learningResources,
    cards,
  };
}

export function parseDomainKnowledgeCatalog(markdown, sourcePath = "") {
  const parsed = matter(String(markdown || ""));
  if (parsed.data.type !== "domain-knowledge-catalog") return [];
  const domainId = id(parsed.data.domainId);
  const asOf = dateText(parsed.data.asOf);
  if (!DOMAIN_IDS.has(domainId)) throw new Error(`${sourcePath || "知识节点目录"}: domainId 不在八母题白名单`);
  const rows = [];
  for (const line of parsed.content.split(/\r?\n/u)) {
    const match = line.match(/^\|\s*([a-z0-9][a-z0-9-]*)\s*\|\s*([a-z0-9][a-z0-9-]*)\s*\|\s*([a-z0-9][a-z0-9-]*)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/u);
    if (!match) continue;
    const [, branchId, topicId, nodeId, rawOrder, rawTitle, rawDescription] = match;
    rows.push({
      domainId,
      branchId,
      topicId,
      nodeId,
      title: text(rawTitle),
      description: text(rawDescription),
      status: "outline",
      order: Number(rawOrder),
      asOf,
      jurisdiction: "global",
      claimTypes: [],
      sourcePath,
      sources: [],
      learningResources: [],
      cards: [],
    });
  }
  if (!rows.length) throw new Error(`${sourcePath || "知识节点目录"}: 没有解析到知识节点行`);
  const duplicateIds = rows.map((node) => node.nodeId).filter((nodeId, index, all) => all.indexOf(nodeId) !== index);
  if (duplicateIds.length) throw new Error(`${sourcePath || "知识节点目录"}: 知识节点 ID 重复：${[...new Set(duplicateIds)].join("、")}`);
  return rows;
}

export async function readDomainKnowledgeNodes(vaultRoot) {
  const nodes = [];
  const warnings = [];
  for (const relativeDirectory of DOMAIN_KNOWLEDGE_DIRECTORIES) {
    const directory = path.resolve(vaultRoot, relativeDirectory);
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
      const sourcePath = path.posix.join(relativeDirectory, entry.name);
      try {
        const markdown = await fs.readFile(path.resolve(directory, entry.name), "utf8");
        const node = parseDomainKnowledgeNode(markdown, sourcePath);
        if (node) nodes.push(node);
        else nodes.push(...parseDomainKnowledgeCatalog(markdown, sourcePath));
      } catch (error) {
        warnings.push({ source: sourcePath, message: `知识节点未载入：${error.message}` });
      }
    }
  }
  const resourceMappings = [];
  for (const sourcePath of DOMAIN_KNOWLEDGE_RESOURCE_CATALOGS) {
    try {
      const markdown = await fs.readFile(path.resolve(vaultRoot, sourcePath), "utf8");
      resourceMappings.push(...parseDomainLearningResourceCatalog(markdown, sourcePath));
    } catch (error) {
      if (error?.code !== "ENOENT") warnings.push({ source: sourcePath, message: `关键材料目录未载入：${error.message}` });
    }
  }
  const uniqueNodeById = new Map();
  const uniqueNodes = [];
  for (const node of nodes.sort((a, b) => (
    a.domainId.localeCompare(b.domainId)
    || a.branchId.localeCompare(b.branchId)
    || a.order - b.order
    || a.nodeId.localeCompare(b.nodeId)
    || (a.status === b.status ? 0 : a.status === "formal" ? -1 : 1)
  ))) {
    if (uniqueNodeById.has(node.nodeId)) {
      const existing = uniqueNodeById.get(node.nodeId);
      if (existing?.status === "formal" && node.status === "outline") continue;
      warnings.push({ source: node.sourcePath, message: `知识节点 ID 重复：${node.nodeId}` });
      continue;
    }
    uniqueNodeById.set(node.nodeId, node);
    const attached = resourceMappings.filter((mapping) => mapping.domainId === node.domainId && mapping.nodeId === node.nodeId).map((mapping) => mapping.resource);
    const combinedResources = [...node.learningResources, ...attached.filter((resource) => !node.learningResources.some((existing) => existing.id === resource.id))];
    uniqueNodes.push({ ...node, learningResources: combinedResources });
  }
  const knownNodeIds = new Set(uniqueNodes.map((node) => node.nodeId));
  for (const mapping of resourceMappings) {
    if (!knownNodeIds.has(mapping.nodeId)) warnings.push({ source: "关键材料目录", message: `关键材料没有对应知识节点：${mapping.nodeId}` });
  }
  const learningRecords = [];
  const seenRecordIds = new Set();
  const seenConversationNodes = new Set();
  for (const relativeDirectory of DOMAIN_LEARNING_RECORD_DIRECTORIES) {
    const directory = path.resolve(vaultRoot, relativeDirectory);
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
      const sourcePath = path.posix.join(relativeDirectory, entry.name);
      try {
        const markdown = await fs.readFile(path.resolve(directory, entry.name), "utf8");
        const record = parseDomainLearningRecord(markdown, sourcePath);
        if (!record) continue;
        const conversationNodeKey = `${record.sourceConversationId}:${record.nodeId}`;
        if (seenRecordIds.has(record.recordId)) {
          warnings.push({ source: sourcePath, message: `学习记录 ID 重复：${record.recordId}` });
          continue;
        }
        if (seenConversationNodes.has(conversationNodeKey)) {
          warnings.push({ source: sourcePath, message: `同一对话与节点已有学习记录：${record.sourceConversationId} / ${record.nodeId}` });
          continue;
        }
        seenRecordIds.add(record.recordId);
        seenConversationNodes.add(conversationNodeKey);
        learningRecords.push(record);
      } catch (error) {
        warnings.push({ source: sourcePath, message: `学习记录未载入：${error.message}` });
      }
    }
  }
  const nodeById = new Map(uniqueNodes.map((node) => [node.nodeId, node]));
  for (const record of learningRecords) {
    const node = nodeById.get(record.nodeId);
    if (!node) {
      warnings.push({ source: record.sourcePath, message: `学习记录没有对应知识节点：${record.nodeId}` });
      continue;
    }
    if (node.domainId !== record.domainId) {
      warnings.push({ source: record.sourcePath, message: `学习记录 domainId 与节点不一致：${record.domainId} / ${node.domainId}` });
      continue;
    }
    node.learningRecords ??= [];
    node.learningRecords.push(record);
  }
  const nodesWithLearning = uniqueNodes.map((node) => {
    const records = [...(node.learningRecords ?? [])].sort((left, right) => left.date.localeCompare(right.date) || left.recordId.localeCompare(right.recordId));
    return {
      ...node,
      learningState: records.at(-1)?.learningState ?? "not-started",
      learningRecords: records,
    };
  });
  return { nodes: nodesWithLearning, warnings };
}
