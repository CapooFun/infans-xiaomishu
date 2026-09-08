import fs from "node:fs/promises";
import path from "node:path";

export const GOVERNANCE_REGISTRY_PATH = "00_本地工作台/10_设计/治理规则登记表.v1.json";

const VALID_STATUSES = new Set(["current", "candidate", "compatibility", "historical"]);
const RELATION_FIELDS = ["parentIds", "implementsIds", "evidenceForIds"];

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function issue(code, message, documentId = null, pathName = null) {
  return { code, severity: "error", message, documentId, path: pathName };
}

function frontmatterValue(source, key) {
  if (!source.startsWith("---")) return "";
  const end = source.indexOf("\n---", 3);
  if (end < 0) return "";
  const match = source.slice(3, end).match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mu"));
  return match ? match[1].replace(/^['"]|['"]$/g, "").trim() : "";
}

function documentTitle(source, fallback) {
  const heading = source.match(/^#\s+(.+?)\s*$/mu)?.[1]?.trim();
  return heading || frontmatterValue(source, "title") || fallback;
}

async function readSourceMetadata(absolutePath, relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension !== ".md" && extension !== ".mdc") {
    return { title: path.basename(relativePath), description: "" };
  }
  const source = await fs.readFile(absolutePath, "utf8");
  return {
    title: documentTitle(source, path.basename(relativePath, extension)),
    description: frontmatterValue(source, "description"),
  };
}

async function listDirectFiles(root, relativeRoot, extensions, issues) {
  const absoluteRoot = path.resolve(root, relativeRoot);
  if (!insideRoot(root, absoluteRoot)) {
    issues.push(issue("DISCOVERY_PATH_ESCAPE", `发现范围越出 Vault：${relativeRoot}`, null, relativeRoot));
    return [];
  }
  try {
    const entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.posix.join(relativeRoot.replaceAll(path.sep, "/"), entry.name));
  } catch (error) {
    issues.push(issue("DISCOVERY_ROOT_MISSING", `无法读取规则发现范围：${relativeRoot}`, null, relativeRoot));
    return [];
  }
}

async function discoverFormalPaths(root, discovery, issues) {
  const found = new Set();
  for (const rule of discovery) {
    if (Array.isArray(rule.paths)) {
      for (const relativePath of rule.paths) found.add(relativePath);
      continue;
    }
    if (typeof rule.root !== "string") continue;
    const extensions = Array.isArray(rule.extensions) ? rule.extensions.map((item) => String(item).toLowerCase()) : [".md"];
    for (const relativePath of await listDirectFiles(root, rule.root, extensions, issues)) found.add(relativePath);
  }
  return found;
}

function findParentCycle(documentsById) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail) {
    if (visiting.has(id)) return [...trail, id];
    if (visited.has(id)) return null;
    visiting.add(id);
    const document = documentsById.get(id);
    for (const parentId of document?.parentIds || []) {
      if (!documentsById.has(parentId)) continue;
      const cycle = visit(parentId, [...trail, id]);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  }
  for (const id of documentsById.keys()) {
    const cycle = visit(id, []);
    if (cycle) return cycle;
  }
  return null;
}

function reverseRelations(documents) {
  const reverse = new Map(documents.map((document) => [document.id, { childIds: [], implementedByIds: [], evidenceIds: [] }]));
  for (const document of documents) {
    for (const targetId of document.parentIds) reverse.get(targetId)?.childIds.push(document.id);
    for (const targetId of document.implementsIds) reverse.get(targetId)?.implementedByIds.push(document.id);
    for (const targetId of document.evidenceForIds) reverse.get(targetId)?.evidenceIds.push(document.id);
  }
  return reverse;
}

function countBy(items, key) {
  return Object.fromEntries([...new Set(items.map((item) => item[key]))].sort().map((value) => [value, items.filter((item) => item[key] === value).length]));
}

export async function readWorkbenchGovernance(vaultRoot, options = {}) {
  const root = path.resolve(vaultRoot);
  const registryCandidate = options.registryPath || GOVERNANCE_REGISTRY_PATH;
  const registryAbsolute = path.resolve(root, registryCandidate);
  if (!insideRoot(root, registryAbsolute)) throw new Error("治理登记表必须位于 Vault 内");

  const registry = JSON.parse(await fs.readFile(registryAbsolute, "utf8"));
  const issues = [];
  if (registry.schemaVersion !== 1) issues.push(issue("UNSUPPORTED_SCHEMA", `不支持的登记表版本：${registry.schemaVersion ?? "未填写"}`));

  const profiles = registry.profiles && typeof registry.profiles === "object" ? registry.profiles : {};
  const sourceDocuments = Array.isArray(registry.documents) ? registry.documents : [];
  const ids = new Set();
  const paths = new Set();
  const authorityOwners = new Map();
  const documents = [];

  for (const sourceDocument of sourceDocuments) {
    const id = String(sourceDocument.id || "").trim();
    const relativePath = String(sourceDocument.path || "").trim();
    const profile = profiles[sourceDocument.profile];
    if (!id) issues.push(issue("MISSING_ID", `登记项缺少 id：${relativePath || "未知路径"}`, null, relativePath || null));
    else if (ids.has(id)) issues.push(issue("DUPLICATE_ID", `重复登记 id：${id}`, id, relativePath));
    else ids.add(id);
    if (!relativePath) issues.push(issue("MISSING_PATH", `登记项 ${id || "未知"} 缺少 path`, id || null));
    else if (paths.has(relativePath)) issues.push(issue("DUPLICATE_PATH", `同一路径被重复登记：${relativePath}`, id || null, relativePath));
    else paths.add(relativePath);
    if (!profile) issues.push(issue("UNKNOWN_PROFILE", `登记项 ${id || relativePath} 使用未知 profile：${sourceDocument.profile}`, id || null, relativePath || null));
    if (!VALID_STATUSES.has(sourceDocument.status)) issues.push(issue("UNKNOWN_STATUS", `登记项 ${id || relativePath} 使用未知状态：${sourceDocument.status}`, id || null, relativePath || null));

    const absolutePath = path.resolve(root, relativePath || ".");
    let metadata = { title: sourceDocument.title || path.basename(relativePath || id || "未命名"), description: "" };
    let sourceExists = false;
    if (!insideRoot(root, absolutePath)) {
      issues.push(issue("SOURCE_PATH_ESCAPE", `原件路径越出 Vault：${relativePath}`, id || null, relativePath));
    } else {
      try {
        const stat = await fs.stat(absolutePath);
        sourceExists = stat.isFile();
        if (!sourceExists) throw new Error("not a file");
        metadata = await readSourceMetadata(absolutePath, relativePath);
      } catch {
        issues.push(issue("SOURCE_MISSING", `找不到登记原件：${relativePath}`, id || null, relativePath));
      }
    }

    const authorityKey = sourceDocument.authorityKey ? String(sourceDocument.authorityKey) : null;
    if (sourceDocument.status === "current" && authorityKey) {
      if (authorityOwners.has(authorityKey)) {
        issues.push(issue("DUPLICATE_CURRENT_AUTHORITY", `现行权威键 ${authorityKey} 同时由 ${authorityOwners.get(authorityKey)} 与 ${id} 持有`, id || null, relativePath));
      } else authorityOwners.set(authorityKey, id);
    }

    documents.push({
      id,
      path: relativePath,
      title: sourceDocument.title || sourceDocument.label || metadata.title,
      description: sourceDocument.description || metadata.description || "未登记摘要。",
      responsibility: sourceDocument.responsibility || metadata.description || "按原件正文承担对应范围。",
      notResponsible: sourceDocument.notResponsible || profile?.notResponsible || "不覆盖上位规则，也不代替实现或证据。",
      layer: sourceDocument.layer || profile?.layer || "unknown",
      kind: sourceDocument.kind || profile?.kind || "未分类",
      profile: sourceDocument.profile || "",
      status: sourceDocument.status || "unknown",
      authorityKey,
      maintainers: sourceDocument.maintainers || profile?.maintainers || [],
      readers: sourceDocument.readers || profile?.readers || [],
      impacts: sourceDocument.impacts || profile?.impacts || [],
      parentIds: Array.isArray(sourceDocument.parentIds) ? sourceDocument.parentIds : [],
      implementsIds: Array.isArray(sourceDocument.implementsIds) ? sourceDocument.implementsIds : [],
      evidenceForIds: Array.isArray(sourceDocument.evidenceForIds) ? sourceDocument.evidenceForIds : [],
      placement: sourceDocument.placement || "in-place",
      reviewNote: sourceDocument.reviewNote || "",
      hiddenInDisplayMode: sourceDocument.hiddenInDisplayMode === true,
      sourceExists,
    });
  }

  const documentsById = new Map(documents.filter((document) => document.id).map((document) => [document.id, document]));
  for (const document of documents) {
    for (const field of RELATION_FIELDS) {
      for (const targetId of document[field]) {
        if (targetId === document.id) issues.push(issue("SELF_RELATION", `${document.id} 的 ${field} 指向自身`, document.id, document.path));
        else if (!documentsById.has(targetId)) issues.push(issue("UNKNOWN_RELATION_TARGET", `${document.id} 的 ${field} 指向未登记项：${targetId}`, document.id, document.path));
      }
    }
  }
  const cycle = findParentCycle(documentsById);
  if (cycle) issues.push(issue("PARENT_CYCLE", `上位规则关系形成循环：${cycle.join(" → ")}`));

  const discovered = await discoverFormalPaths(root, Array.isArray(registry.formalDiscovery) ? registry.formalDiscovery : [], issues);
  for (const relativePath of [...discovered].sort()) {
    if (!paths.has(relativePath)) issues.push(issue("UNREGISTERED_FORMAL_SOURCE", `发现未登记的正式规则原件：${relativePath}`, null, relativePath));
  }

  const reverse = reverseRelations(documents);
  const enriched = documents.map((document) => ({ ...document, ...reverse.get(document.id) }));
  const visible = options.displayMode ? enriched.filter((document) => !document.hiddenInDisplayMode) : enriched;
  const visibleIds = new Set(visible.map((document) => document.id));
  const presented = options.displayMode
    ? visible.map((document) => Object.fromEntries(Object.entries(document).map(([key, value]) => (
      ["parentIds", "childIds", "implementsIds", "implementedByIds", "evidenceForIds", "evidenceIds"].includes(key)
        ? [key, value.filter((id) => visibleIds.has(id))]
        : [key, value]
    ))))
    : visible;
  const presentedIssues = options.displayMode
    ? issues.filter((item) => !item.documentId || visibleIds.has(item.documentId))
    : issues;
  return {
    schemaVersion: registry.schemaVersion,
    title: registry.title || "治理与规则图谱",
    updatedAt: registry.updatedAt || null,
    sourcePolicy: registry.sourcePolicy || "登记表只提供派生导航；原件仍是唯一权威。",
    registryPath: path.relative(root, registryAbsolute).split(path.sep).join("/"),
    documents: presented,
    issues: presentedIssues,
    summary: {
      documents: presented.length,
      issues: presentedIssues.length,
      byStatus: countBy(presented, "status"),
      byLayer: countBy(presented, "layer"),
    },
  };
}
