import fs from "node:fs/promises";
import path from "node:path";

export const PROJECT_HUB_SCHEMA_VERSION = 1;
export const PROJECT_HUB_MANIFEST_PATH = ".infans/project-hub.v1.json";

export const PROJECT_HUB_STATUSES = Object.freeze([
  "planned",
  "active",
  "blocked",
  "testing",
  "waiting_acceptance",
  "paused",
  "stable",
  "done",
]);

export const PROJECT_HUB_STATUS_LABELS = Object.freeze({
  planned: "准备中",
  active: "推进中",
  blocked: "有阻塞",
  testing: "测试中",
  waiting_acceptance: "等待验收",
  paused: "已暂停",
  stable: "稳定",
  done: "已完成",
});

const DEFAULT_EXTERNAL_PROJECT_SOURCES = Object.freeze({});

const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/u;
const WINDOWS_ABSOLUTE_RE = /^[a-z]:[\\/]/iu;
const DENIED_SEGMENTS = new Set([
  ".git",
  ".cache",
  ".next",
  ".godot",
  ".import",
  "node_modules",
  "cache",
  "caches",
  "coverage",
  "dist",
  "build",
  "logs",
  "log",
  "tmp",
  "temp",
]);
const DENIED_FILE_RE = /(^|[._-])(credential|credentials|secret|secrets|token|tokens|password|passwd|private[-_]?key)([._-]|$)/iu;
const DENIED_EXTENSION_RE = /\.(?:log|pem|key|p12|pfx|keystore)$/iu;
const ALLOWED_SOURCE_EXTENSION_RE = /\.(?:md|markdown|json|ya?ml)$/iu;

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeId(value) {
  const id = cleanText(value).toLowerCase();
  return SAFE_ID_RE.test(id) ? id : null;
}

function normalizeStatus(value, context, warnings) {
  const status = cleanText(value);
  if (PROJECT_HUB_STATUSES.includes(status)) return status;
  warnings.push(issue("PROJECT_HUB_STATUS_INVALID", `${context}的状态不在薄契约允许范围内，已按“准备中”显示。`));
  return "planned";
}

function displaySource(source, externalProjectId) {
  if (!source) return null;
  return {
    label: cleanText(source.label) || "项目原件",
    path: source.path,
    externalProjectId,
  };
}

function parseSource(value, context, warnings) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(issue("PROJECT_HUB_SOURCE_INVALID", `${context}的原件引用不是对象，已忽略。`));
    return null;
  }
  const sourcePath = cleanText(value.path);
  if (!sourcePath) {
    warnings.push(issue("PROJECT_HUB_SOURCE_PATH_MISSING", `${context}的原件引用缺少相对路径，已忽略。`));
    return null;
  }
  return { path: sourcePath, label: cleanText(value.label) || "项目原件" };
}

function addUniqueId(index, id, context, errors) {
  if (!id) {
    errors.push(issue("PROJECT_HUB_ID_INVALID", `${context}缺少合法稳定 ID。`));
    return false;
  }
  if (index.has(id)) {
    errors.push(issue("PROJECT_HUB_ID_DUPLICATE", `稳定 ID“${id}”重复，分别用于${index.get(id)}和${context}。`, { itemId: id }));
    return false;
  }
  index.set(id, context);
  return true;
}

function parseFeatureNode(value, context, indexes, errors, warnings, externalProjectId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(issue("PROJECT_HUB_FEATURE_INVALID", `${context}不是对象。`));
    return null;
  }
  const id = safeId(value.id);
  const name = cleanText(value.name);
  if (!addUniqueId(indexes.allIds, id, context, errors) || !name) {
    if (!name) errors.push(issue("PROJECT_HUB_NAME_MISSING", `${context}缺少名称。`));
    return null;
  }
  indexes.featureIds.add(id);
  const children = Array.isArray(value.children)
    ? value.children.map((child, index) => parseFeatureNode(child, `${context}的第 ${index + 1} 个子功能`, indexes, errors, warnings, externalProjectId)).filter(Boolean)
    : [];
  return {
    id,
    name,
    status: normalizeStatus(value.status, context, warnings),
    description: cleanText(value.summary),
    hiddenInDisplayMode: value.hiddenInDisplayMode === true,
    source: displaySource(parseSource(value.source, context, warnings), externalProjectId),
    children,
  };
}

/**
 * 解析独立清单，不读取或猜测任何设计正文。正文标题、章节、篇幅和文风不属于契约。
 */
export function parseProjectHubManifest(input, context = {}) {
  const externalProjectId = safeId(context.projectId);
  const errors = [];
  const warnings = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { hub: null, errors: [issue("PROJECT_HUB_MANIFEST_INVALID", "项目清单不是 JSON 对象。")], warnings };
  }
  if (input.schemaVersion !== PROJECT_HUB_SCHEMA_VERSION) {
    return {
      hub: null,
      errors: [issue("PROJECT_HUB_VERSION_UNSUPPORTED", `项目清单版本“${String(input.schemaVersion ?? "缺失")}”不受支持；当前只读取 v${PROJECT_HUB_SCHEMA_VERSION}。`)],
      warnings,
    };
  }
  const project = input.project;
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    return { hub: null, errors: [issue("PROJECT_HUB_PROJECT_MISSING", "项目清单缺少 project 对象。")], warnings };
  }
  const projectId = safeId(project.id);
  if (!projectId) errors.push(issue("PROJECT_HUB_PROJECT_ID_INVALID", "项目清单缺少合法项目 ID。"));
  if (externalProjectId && projectId && projectId !== externalProjectId) {
    errors.push(issue("PROJECT_HUB_PROJECT_ID_MISMATCH", `项目清单登记为“${projectId}”，与服务器白名单项目不一致。`));
  }
  const projectName = cleanText(project.name);
  if (!projectName) errors.push(issue("PROJECT_HUB_PROJECT_NAME_MISSING", "项目清单缺少项目名称。"));
  const defaultView = project.defaultView == null ? "home" : cleanText(project.defaultView);
  if (project.defaultView == null) warnings.push(issue("PROJECT_HUB_DEFAULT_VIEW_MISSING", "项目清单未写 defaultView，外部项目已按项目主页打开。"));
  if (!["home", "featureTree"].includes(defaultView)) errors.push(issue("PROJECT_HUB_DEFAULT_VIEW_INVALID", "defaultView 只能是 home 或 featureTree。"));

  const indexes = {
    allIds: new Map(),
    worklineIds: new Set(),
    treeIds: new Set(),
    moduleIds: new Set(),
    featureIds: new Set(),
  };
  const worklines = Array.isArray(input.worklines) ? input.worklines.map((value, index) => {
    const contextLabel = `第 ${index + 1} 条工作线`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(issue("PROJECT_HUB_WORKLINE_INVALID", `${contextLabel}不是对象。`));
      return null;
    }
    const id = safeId(value.id);
    const name = cleanText(value.name);
    if (!addUniqueId(indexes.allIds, id, contextLabel, errors) || !name) {
      if (!name) errors.push(issue("PROJECT_HUB_NAME_MISSING", `${contextLabel}缺少名称。`));
      return null;
    }
    indexes.worklineIds.add(id);
    const view = value.view == null ? { kind: "overview" } : value.view;
    let normalizedView = { kind: "overview" };
    if (!view || typeof view !== "object" || Array.isArray(view) || !["overview", "featureTree"].includes(view.kind)) {
      warnings.push(issue("PROJECT_HUB_WORKLINE_VIEW_INVALID", `工作线“${name}”的子看板类型无效，已保留为普通工作线。`, { itemId: id }));
    } else if (view.kind === "featureTree") {
      const treeId = safeId(view.treeId);
      if (!treeId) warnings.push(issue("PROJECT_HUB_WORKLINE_TREE_ID_MISSING", `工作线“${name}”缺少功能树 ID，已保留为普通工作线。`, { itemId: id }));
      else normalizedView = { kind: "featureTree", treeId };
    }
    return {
      id,
      name,
      status: normalizeStatus(value.status, contextLabel, warnings),
      summary: cleanText(value.summary),
      hiddenInDisplayMode: value.hiddenInDisplayMode === true,
      source: displaySource(parseSource(value.source, contextLabel, warnings), externalProjectId || projectId),
      view: normalizedView,
    };
  }).filter(Boolean) : [];
  if (!Array.isArray(input.worklines)) errors.push(issue("PROJECT_HUB_WORKLINES_MISSING", "项目清单缺少 worklines 数组。"));
  if (!worklines.length) errors.push(issue("PROJECT_HUB_WORKLINES_EMPTY", "项目清单至少需要一条工作线。"));

  const featureTrees = Array.isArray(input.featureTrees) ? input.featureTrees.map((value, index) => {
    const contextLabel = `第 ${index + 1} 棵功能树`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(issue("PROJECT_HUB_FEATURE_TREE_INVALID", `${contextLabel}不是对象。`));
      return null;
    }
    const id = safeId(value.id);
    const worklineId = safeId(value.worklineId);
    const name = cleanText(value.name);
    if (!addUniqueId(indexes.allIds, id, contextLabel, errors) || !name) {
      if (!name) errors.push(issue("PROJECT_HUB_NAME_MISSING", `${contextLabel}缺少名称。`));
      return null;
    }
    indexes.treeIds.add(id);
    if (!worklineId || !indexes.worklineIds.has(worklineId)) {
      errors.push(issue("PROJECT_HUB_WORKLINE_REFERENCE_INVALID", `功能树“${name}”引用了不存在的工作线。`, { itemId: id }));
    }
    const modules = Array.isArray(value.modules) ? value.modules.map((moduleValue, moduleIndex) => {
      const moduleContext = `功能树“${name}”的第 ${moduleIndex + 1} 个模块`;
      if (!moduleValue || typeof moduleValue !== "object" || Array.isArray(moduleValue)) {
        errors.push(issue("PROJECT_HUB_MODULE_INVALID", `${moduleContext}不是对象。`));
        return null;
      }
      const moduleId = safeId(moduleValue.id);
      const moduleName = cleanText(moduleValue.name);
      if (!addUniqueId(indexes.allIds, moduleId, moduleContext, errors) || !moduleName) {
        if (!moduleName) errors.push(issue("PROJECT_HUB_NAME_MISSING", `${moduleContext}缺少名称。`));
        return null;
      }
      indexes.moduleIds.add(moduleId);
      const features = Array.isArray(moduleValue.features)
        ? moduleValue.features.map((feature, featureIndex) => parseFeatureNode(feature, `模块“${moduleName}”的第 ${featureIndex + 1} 个功能`, indexes, errors, warnings, externalProjectId || projectId)).filter(Boolean)
        : [];
      return {
        id: moduleId,
        name: moduleName,
        status: normalizeStatus(moduleValue.status, moduleContext, warnings),
        description: cleanText(moduleValue.summary),
        hiddenInDisplayMode: moduleValue.hiddenInDisplayMode === true,
        source: displaySource(parseSource(moduleValue.source, moduleContext, warnings), externalProjectId || projectId),
        features,
      };
    }).filter(Boolean) : [];
    if (!Array.isArray(value.modules)) errors.push(issue("PROJECT_HUB_MODULES_MISSING", `功能树“${name}”缺少 modules 数组。`, { itemId: id }));
    return {
      id,
      worklineId,
      title: name,
      description: cleanText(value.summary),
      source: displaySource(parseSource(value.source, contextLabel, warnings), externalProjectId || projectId),
      modules,
      warnings: [],
    };
  }).filter(Boolean) : [];

  for (const workline of worklines) {
    if (workline.view.kind === "featureTree" && !indexes.treeIds.has(workline.view.treeId)) {
      warnings.push(issue("PROJECT_HUB_FEATURE_TREE_REFERENCE_INVALID", `工作线“${workline.name}”引用的功能树不存在，已保留为普通工作线。`, { itemId: workline.id }));
      workline.view = { kind: "overview" };
    }
  }

  const taskLinks = Array.isArray(input.taskLinks) ? input.taskLinks.flatMap((value, index) => {
    const taskId = safeId(value?.taskId);
    const worklineId = safeId(value?.worklineId);
    const moduleId = value?.moduleId == null ? null : safeId(value.moduleId);
    const featureId = value?.featureId == null ? null : safeId(value.featureId);
    if (!taskId || !worklineId || !indexes.worklineIds.has(worklineId) || (moduleId && !indexes.moduleIds.has(moduleId)) || (featureId && !indexes.featureIds.has(featureId))) {
      warnings.push(issue("PROJECT_HUB_TASK_LINK_INVALID", `第 ${index + 1} 条任务关联含无效 ID，已忽略。`));
      return [];
    }
    return [{ taskId, worklineId, moduleId, featureId }];
  }) : [];
  const recentLinks = Array.isArray(input.recentLinks) ? input.recentLinks.flatMap((value, index) => {
    const recentId = safeId(value?.recentId);
    const worklineId = safeId(value?.worklineId);
    const moduleId = value?.moduleId == null ? null : safeId(value.moduleId);
    const featureId = value?.featureId == null ? null : safeId(value.featureId);
    if (!recentId || !worklineId || !indexes.worklineIds.has(worklineId) || (moduleId && !indexes.moduleIds.has(moduleId)) || (featureId && !indexes.featureIds.has(featureId))) {
      warnings.push(issue("PROJECT_HUB_RECENT_LINK_INVALID", `第 ${index + 1} 条近期完成关联含无效 ID，已忽略。`));
      return [];
    }
    return [{ recentId, worklineId, moduleId, featureId }];
  }) : [];

  if (errors.length) return { hub: null, errors, warnings };
  return {
    hub: {
      schemaVersion: PROJECT_HUB_SCHEMA_VERSION,
      project: {
        id: projectId,
        name: projectName,
        status: normalizeStatus(project.status, "项目", warnings),
        summary: cleanText(project.summary),
        defaultView,
      },
      worklines,
      featureTrees,
      taskLinks,
      recentLinks,
      warnings,
    },
    errors,
    warnings,
  };
}

export function validateExternalProjectRelativePath(relativePath, options = {}) {
  const value = cleanText(relativePath);
  if (!value || path.isAbsolute(value) || WINDOWS_ABSOLUTE_RE.test(value)) throw new Error("EXTERNAL_PROJECT_PATH_ABSOLUTE");
  if (value.includes("\\")) throw new Error("EXTERNAL_PROJECT_PATH_BACKSLASH");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("EXTERNAL_PROJECT_PATH_TRAVERSAL");
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (lower === ".env" || lower.startsWith(".env.")) throw new Error("EXTERNAL_PROJECT_PATH_ENV");
    if (DENIED_SEGMENTS.has(lower)) throw new Error("EXTERNAL_PROJECT_PATH_DENIED_SEGMENT");
  }
  const basename = segments.at(-1);
  if (DENIED_FILE_RE.test(basename) || DENIED_EXTENSION_RE.test(basename)) throw new Error("EXTERNAL_PROJECT_PATH_CREDENTIAL");
  if (options.manifest === true && value !== PROJECT_HUB_MANIFEST_PATH) throw new Error("EXTERNAL_PROJECT_MANIFEST_NOT_WHITELISTED");
  if (options.source === true && !ALLOWED_SOURCE_EXTENSION_RE.test(basename)) throw new Error("EXTERNAL_PROJECT_SOURCE_TYPE_DENIED");
  return value;
}

async function resolveInsideRegisteredRoot(root, relativePath, options = {}) {
  const safeRelativePath = validateExternalProjectRelativePath(relativePath, options);
  const realRoot = await fs.realpath(root);
  const candidate = path.resolve(realRoot, safeRelativePath);
  if (!candidate.startsWith(`${realRoot}${path.sep}`)) throw new Error("EXTERNAL_PROJECT_PATH_OUTSIDE_ROOT");
  const realCandidate = await fs.realpath(candidate);
  if (!realCandidate.startsWith(`${realRoot}${path.sep}`)) throw new Error("EXTERNAL_PROJECT_SYMLINK_ESCAPE");
  return realCandidate;
}

function publicWarning(code, message, projectId) {
  return issue(code, message, { projectId });
}

async function validateManifestSources(root, hub, projectId) {
  const warnings = [];
  const featureEntries = (feature) => [
    { item: feature, context: `功能“${feature.name}”` },
    ...feature.children.flatMap(featureEntries),
  ];
  const entries = [
    ...hub.worklines.map((item) => ({ item, context: `工作线“${item.name}”` })),
    ...hub.featureTrees.flatMap((tree) => [
      { item: tree, context: `功能树“${tree.title}”` },
      ...tree.modules.flatMap((module) => [
        { item: module, context: `模块“${module.name}”` },
        ...module.features.flatMap(featureEntries),
      ]),
    ]),
  ];
  await Promise.all(entries.map(async ({ item, context }) => {
    const source = item.source;
    if (!source) return;
    const rawSource = findRawSource(hub, item.id);
    if (!rawSource?.path) return;
    try {
      await resolveInsideRegisteredRoot(root, rawSource.path, { source: true });
    } catch (error) {
      item.source = null;
      warnings.push(publicWarning("EXTERNAL_PROJECT_SOURCE_UNAVAILABLE", `${context}的原件引用不可用，页面已隐藏该入口。`, projectId));
    }
  }));
  return warnings;
}

function collectRawSources(input) {
  const map = new Map();
  const add = (item) => {
    const id = safeId(item?.id);
    if (id && item?.source && typeof item.source === "object") map.set(id, item.source);
  };
  for (const workline of input.worklines || []) add(workline);
  for (const tree of input.featureTrees || []) {
    add(tree);
    for (const module of tree.modules || []) {
      add(module);
      const visit = (feature) => {
        add(feature);
        for (const child of feature.children || []) visit(child);
      };
      for (const feature of module.features || []) visit(feature);
    }
  }
  return map;
}

function findRawSource(hub, id) {
  return hub.__rawSources?.get(id) || null;
}

export function externalProjectSourceIds(sources = DEFAULT_EXTERNAL_PROJECT_SOURCES) {
  return Object.keys(sources);
}

export async function readExternalProjectHub(projectId, options = {}) {
  const sources = options.sources || DEFAULT_EXTERNAL_PROJECT_SOURCES;
  const registered = sources[projectId];
  if (!registered) return { registered: false, hub: null, warnings: [], errors: [] };
  try {
    const manifestPath = await resolveInsideRegisteredRoot(registered.root, PROJECT_HUB_MANIFEST_PATH, { manifest: true });
    const raw = await fs.readFile(manifestPath, "utf8");
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return {
        registered: true,
        hub: null,
        warnings: [],
        errors: [publicWarning("PROJECT_HUB_JSON_INVALID", "外部项目清单不是有效 JSON，该项目已暂时退回原有项目页。", projectId)],
      };
    }
    const parsed = parseProjectHubManifest(input, { projectId });
    if (!parsed.hub) return { registered: true, ...parsed };
    Object.defineProperty(parsed.hub, "__rawSources", { value: collectRawSources(input), enumerable: false });
    const sourceWarnings = await validateManifestSources(registered.root, parsed.hub, projectId);
    return {
      registered: true,
      hub: parsed.hub,
      warnings: [...parsed.warnings, ...sourceWarnings],
      errors: parsed.errors,
    };
  } catch (error) {
    const code = error?.code === "ENOENT" ? "EXTERNAL_PROJECT_HUB_MISSING" : "EXTERNAL_PROJECT_HUB_UNAVAILABLE";
    return {
      registered: true,
      hub: null,
      warnings: [publicWarning(code, "外部项目资料当前不可用，该项目已暂时退回原有项目页。", projectId)],
      errors: [],
    };
  }
}
