import fs from "node:fs/promises";
import path from "node:path";

export const PRODUCT_FEATURE_TREE_LABEL = "产品功能树";
export const PRODUCT_FEATURE_STATUSES = Object.freeze([
  "稳定",
  "准备开发",
  "设计中",
  "开发中",
  "测试中",
  "等待验收",
  "已暂停",
]);
export const PRODUCT_FEATURE_COLUMNS = Object.freeze([
  "状态",
  "说明",
  "功能点",
  "当前进度",
  "原件",
  "ID",
]);
export const PRODUCT_FEATURE_SUMMARY_POINT_MAX_LENGTH = 48;

function cleanInline(value = "") {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, (_match, target) => String(target).split("/").at(-1) ?? target)
    .replace(/<[^>]+>/gu, "")
    .replace(/\*\*|__|~~|`/gu, "")
    .replace(/\\\|/gu, "|")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function splitMarkdownRow(line) {
  const placeholder = "\u0000PIPE\u0000";
  const protectedLine = String(line)
    .replace(/\\\|/gu, placeholder)
    .replace(/\[\[[^\]]+\]\]/gu, (link) => link.replaceAll("|", placeholder));
  return protectedLine.trim().slice(1, -1).split("|").map((cell) => cell.trim().replaceAll(placeholder, "|"));
}

function wikiLink(value = "") {
  const match = String(value).match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/u);
  if (!match) return null;
  const target = match[1].trim();
  return {
    label: cleanInline(match[2] || target),
    path: target.endsWith(".md") ? target : `${target}.md`,
  };
}

function featureSource(value = "", sourcePath = "产品功能树.md") {
  if (cleanInline(value) === "本模块") {
    return {
      label: path.basename(sourcePath, path.extname(sourcePath)),
      path: sourcePath,
    };
  }
  return wikiLink(value);
}

function parseProgress(value = "") {
  const text = cleanInline(value);
  if (!text || text === "—" || text === "无") return [];
  return text.split(/[；;]/u).map((item) => item.trim()).filter(Boolean).map((item) => {
    const match = item.match(/^(完成|当前|下一步)\s*[：:]\s*(.+)$/u);
    return match
      ? { kind: match[1] === "完成" ? "done" : match[1] === "当前" ? "current" : "next", text: match[2].trim() }
      : { kind: "next", text: item };
  });
}

function parseFeaturePoints(value = "") {
  const text = cleanInline(value);
  if (!text || text === "—" || text === "无") return [];
  return text.split(/[；;]/u).map((item) => item.trim()).filter(Boolean).map((item) => ({
    text: item.replace(/^🔒\s*/u, "").trim(),
    hiddenInDisplayMode: /^🔒/u.test(item),
  }));
}

function featureDetailHeading(raw = "") {
  const text = cleanInline(raw);
  const match = text.match(/^(.+?)\s*[｜|]\s*ID\s*[：:]\s*([a-z0-9][a-z0-9._-]*)$/iu);
  return match ? { name: match[1].trim(), id: match[2].toLowerCase() } : null;
}

function parseDetailedFeaturePoints(markdown = "", context = {}) {
  const sourcePath = context.sourcePath || "产品功能树.md";
  const sectionTitle = context.sectionTitle || "功能明细";
  const lines = String(markdown).split(/\r?\n/u);
  const details = new Map();
  const warnings = [];
  let insideDetails = false;
  let current = null;
  let stack = [];

  for (let index = 0; index < lines.length; index += 1) {
    const section = lines[index].match(/^###\s+(.+?)\s*$/u);
    if (section) {
      insideDetails = cleanInline(section[1]) === sectionTitle;
      current = null;
      stack = [];
      continue;
    }
    if (!insideDetails) continue;

    const heading = lines[index].match(/^####\s+(.+?)\s*$/u);
    if (heading) {
      const parsed = featureDetailHeading(heading[1]);
      if (!parsed) {
        warnings.push(warning("FEATURE_DETAIL_ID_MISSING", `功能明细第 ${index + 1} 行缺少稳定 ID。`, { sourcePath }));
        current = null;
        stack = [];
        continue;
      }
      if (details.has(parsed.id)) warnings.push(warning("FEATURE_DETAIL_DUPLICATE", `功能“${parsed.name}”的多层明细重复。`, { sourcePath, featureId: parsed.id }));
      current = { ...parsed, points: [] };
      details.set(parsed.id, current);
      stack = [];
      continue;
    }
    if (!current) continue;

    const item = lines[index].match(/^(\s*)-\s+(.+?)\s*$/u);
    if (!item) continue;
    const indent = item[1].replaceAll("\t", "  ").length;
    const rawText = cleanInline(item[2]);
    if (!rawText) continue;
    const point = {
      text: rawText.replace(/^🔒\s*/u, "").trim(),
      hiddenInDisplayMode: /^🔒/u.test(rawText),
      children: [],
    };
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    if (stack.length) stack.at(-1).point.children.push(point);
    else current.points.push(point);
    stack.push({ indent, point });
  }

  return { details, warnings };
}

function moduleHeading(raw = "") {
  const text = cleanInline(raw);
  const match = text.match(/^(.+?)\s*[｜|]\s*ID\s*[：:]\s*([a-z0-9][a-z0-9._-]*)$/iu);
  return match ? { name: match[1].trim(), id: match[2].toLowerCase() } : null;
}

function warning(code, message, extra = {}) {
  return { code, message, ...extra };
}

// Display-only references: never manufacture business module/feature IDs or parents.
function parsePresentationGroups(markdown, nameColumn, memberColumn, validIds, sourcePath) {
  const lines = String(markdown).split(/\r?\n/u);
  const groups = [];
  const warnings = [];
  const usedGroups = new Set();
  const usedMembers = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith("|")) continue;
    const header = splitMarkdownRow(lines[index]).map(cleanInline);
    if (!header.includes(nameColumn) || !header.includes(memberColumn) || !header.includes("ID")) continue;
    if (!lines[index + 1]?.trim().startsWith("|")) continue;
    index += 2;
    for (; index < lines.length && lines[index].trim().startsWith("|"); index += 1) {
      const row = splitMarkdownRow(lines[index]);
      const id = cleanInline(row[header.indexOf("ID")]);
      const name = cleanInline(row[header.indexOf(nameColumn)]);
      if (!name || !/^[a-z0-9][a-z0-9._-]*$/u.test(id) || usedGroups.has(id)) {
        warnings.push(warning("FEATURE_PRESENTATION_GROUP_INVALID", "Wiki 展示分组名称或 ID 无效、重复。", { sourcePath }));
        continue;
      }
      usedGroups.add(id);
      const memberIds = cleanInline(row[header.indexOf(memberColumn)]).split(/[,，、\s]+/u).filter(Boolean).filter((memberId) => {
        if (!validIds.has(memberId) || usedMembers.has(memberId)) {
          warnings.push(warning("FEATURE_PRESENTATION_MEMBER_INVALID", `展示分组引用了不存在或重复的 ID“${memberId}”。`, { sourcePath }));
          return false;
        }
        usedMembers.add(memberId);
        return true;
      });
      if (memberIds.length) groups.push({ id, name, memberIds });
    }
    index -= 1;
  }
  return { groups, warnings };
}

function parsePresentationFeatures(markdown, sourcePath) {
  const lines = String(markdown).split(/\r?\n/u);
  const features = [];
  const warnings = [];
  const ids = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith("|")) continue;
    const header = splitMarkdownRow(lines[index]).map(cleanInline);
    if (!header.includes("界面功能") || !header.includes("关联功能") || !header.includes("ID")) continue;
    index += 2;
    for (; index < lines.length && lines[index].trim().startsWith("|"); index += 1) {
      const row = splitMarkdownRow(lines[index]);
      const cell = (name) => cleanInline(row[header.indexOf(name)] || "");
      const id = cell("ID");
      const name = cell("界面功能");
      const relatedFeatureId = cell("关联功能");
      const status = cell("状态");
      let invalidMessage = "";
      if (!name) invalidMessage = "原生界面有一条细项没有名称。";
      else if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) invalidMessage = `原生界面细项“${name}”的 ID“${id || "空"}”无效。`;
      else if (ids.has(id)) invalidMessage = `原生界面细项“${name}”的 ID“${id}”重复。`;
      else if (!/^[a-z0-9][a-z0-9._-]*$/u.test(relatedFeatureId)) invalidMessage = `原生界面细项“${name}”的关联功能 ID“${relatedFeatureId || "空"}”无效。`;
      else if (!PRODUCT_FEATURE_STATUSES.includes(status)) invalidMessage = `原生界面细项“${name}”的状态“${status || "空"}”不支持，请改用${PRODUCT_FEATURE_STATUSES.join("、")}之一。`;
      if (invalidMessage) {
        warnings.push(warning("FEATURE_PRESENTATION_DETAIL_INVALID", invalidMessage, { sourcePath, ...(/^[a-z0-9][a-z0-9._-]*$/u.test(id) ? { featureId: id } : {}) }));
        continue;
      }
      ids.add(id);
      const points = parseFeaturePoints(row[header.indexOf("功能点")] || "");
      if (points.some((point) => point.text.length > PRODUCT_FEATURE_SUMMARY_POINT_MAX_LENGTH)) warnings.push(warning("FEATURE_SUMMARY_POINT_TOO_LONG", `界面细项“${name}”的功能短句过长。`, { sourcePath, featureId: id }));
      features.push({ id, name, status, description: cell("说明"), points, summaryPoints: points,
        progress: parseProgress(row[header.indexOf("当前进度")] || ""), source: featureSource(row[header.indexOf("原件")] || "本模块", sourcePath), relatedFeatureId });
    }
    index -= 1;
  }
  const detailed = parseDetailedFeaturePoints(markdown, { sourcePath, sectionTitle: "客户端功能明细" });
  warnings.push(...detailed.warnings);
  for (const detail of detailed.details.values()) {
    const feature = features.find((candidate) => candidate.id === detail.id);
    if (!feature) {
      warnings.push(warning("FEATURE_PRESENTATION_DETAIL_ORPHAN", `客户端功能明细“${detail.name}”没有对应的功能登记。`, { sourcePath, featureId: detail.id }));
      continue;
    }
    if (feature.name !== detail.name) warnings.push(warning("FEATURE_DETAIL_NAME_MISMATCH", `客户端功能 ID“${detail.id}”在功能表与明细中的名称不一致。`, { sourcePath, featureId: detail.id }));
    if (detail.points.length) feature.points = detail.points;
  }
  return { features, warnings };
}

export function parseProductFeatureTree(markdown = "", context = {}) {
  const sourcePath = context.sourcePath || "产品功能树.md";
  const lines = String(markdown).split(/\r?\n/u);
  const title = cleanInline(lines.find((line) => /^#\s+/u.test(line))?.replace(/^#\s+/u, "") || "产品功能树");
  const modules = [];
  const warnings = [];
  const ids = new Map();
  let current = null;

  const finishModule = () => {
    if (!current) return;
    if (!current.description) current.description = `${current.name}当前收录的稳定能力与新增功能。`;
    modules.push({ ...current, sourcePath });
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^##\s+(.+?)\s*$/u);
    if (heading) {
      finishModule();
      const parsed = moduleHeading(heading[1]);
      if (!parsed) {
        warnings.push(warning("FEATURE_MODULE_ID_MISSING", `功能树第 ${index + 1} 行的模块标题缺少稳定 ID。`, { sourcePath }));
        continue;
      }
      current = { ...parsed, description: "", features: [] };
      if (ids.has(parsed.id)) warnings.push(warning("FEATURE_ID_DUPLICATE", `功能树 ID“${parsed.id}”重复。`, { sourcePath, featureId: parsed.id }));
      else ids.set(parsed.id, `模块“${parsed.name}”`);
      continue;
    }
    if (!current) continue;
    if (!current.description && /^>\s*/u.test(lines[index])) {
      current.description = cleanInline(lines[index].replace(/^>\s*/u, ""));
      continue;
    }
    if (!lines[index].trim().startsWith("|") || !lines[index].trim().endsWith("|")) continue;
    const header = splitMarkdownRow(lines[index]).map(cleanInline);
    const nameColumn = header.includes("小模块") ? "小模块" : header.includes("功能") ? "功能" : null;
    if (!nameColumn || !header.includes("ID")) continue;
    const expectedHeader = [nameColumn, ...PRODUCT_FEATURE_COLUMNS];
    if (header.length !== expectedHeader.length || header.some((column, columnIndex) => column !== expectedHeader[columnIndex])) {
      warnings.push(warning("FEATURE_COLUMNS_INVALID", `模块“${current.name}”的功能表必须使用“${expectedHeader.join("／")}”七列。`, { sourcePath, featureId: current.id }));
    }
    const separator = lines[index + 1];
    if (!separator?.trim().startsWith("|")) continue;
    const columns = new Map(header.map((name, columnIndex) => [name, columnIndex]));
    index += 2;
    for (; index < lines.length; index += 1) {
      const rowLine = lines[index];
      if (!rowLine.trim().startsWith("|") || !rowLine.trim().endsWith("|")) {
        index -= 1;
        break;
      }
      const row = splitMarkdownRow(rowLine);
      const name = cleanInline(row[columns.get(nameColumn)] || "");
      const id = cleanInline(row[columns.get("ID")] || "").toLowerCase();
      if (!name || !id) {
        warnings.push(warning("FEATURE_ROW_INVALID", `模块“${current.name}”第 ${index + 1} 行缺少功能名或稳定 ID。`, { sourcePath }));
        continue;
      }
      const status = cleanInline(row[columns.get("状态")] || "稳定") || "稳定";
      if (!PRODUCT_FEATURE_STATUSES.includes(status)) warnings.push(warning("FEATURE_STATUS_INVALID", `功能“${name}”的状态“${status}”不在允许范围内。`, { sourcePath, featureId: id }));
      if (ids.has(id)) warnings.push(warning("FEATURE_ID_DUPLICATE", `功能树 ID“${id}”同时用于${ids.get(id)}和功能“${name}”。`, { sourcePath, featureId: id }));
      else ids.set(id, `功能“${name}”`);
      const summaryPoints = parseFeaturePoints(row[columns.get("功能点")] || "");
      for (const point of summaryPoints) {
        if (point.text.length > PRODUCT_FEATURE_SUMMARY_POINT_MAX_LENGTH) {
          warnings.push(warning(
            "FEATURE_SUMMARY_POINT_TOO_LONG",
            `功能“${name}”的前台功能点超过 ${PRODUCT_FEATURE_SUMMARY_POINT_MAX_LENGTH} 个字符，请把实现细节移入“功能明细”。`,
            { sourcePath, featureId: id },
          ));
        }
      }
      current.features.push({
        id,
        name,
        status,
        description: cleanInline(row[columns.get("说明")] || ""),
        summaryPoints,
        points: summaryPoints,
        progress: parseProgress(row[columns.get("当前进度")] || ""),
        source: featureSource(row[columns.get("原件")] || "", sourcePath),
      });
    }
  }
  finishModule();
  const detailsForDisplay = parsePresentationFeatures(markdown, sourcePath);
  warnings.push(...detailsForDisplay.warnings);
  // Native module originals currently have a single module; no implicit owner for multi-module files.
  if (detailsForDisplay.features.length && modules.length === 1) modules[0].presentationFeatures = detailsForDisplay.features;
  else if (detailsForDisplay.features.length) warnings.push(warning("FEATURE_PRESENTATION_OWNER_INVALID", "界面细项须登记在单一模块原件。", { sourcePath }));
  const presentation = parsePresentationGroups(markdown, "设备分组", "功能 ID", new Set(modules.flatMap((module) => [...module.features, ...(module.presentationFeatures || [])].map((feature) => feature.id))), sourcePath);
  warnings.push(...presentation.warnings);
  for (const module of modules) {
    const ownedIds = new Set([...module.features, ...(module.presentationFeatures || [])].map((feature) => feature.id));
    const featureGroups = presentation.groups.map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => ownedIds.has(id)) })).filter((group) => group.memberIds.length);
    if (featureGroups.length) module.featureGroups = featureGroups;
  }
  const detailed = parseDetailedFeaturePoints(markdown, { sourcePath });
  warnings.push(...detailed.warnings);
  const featureIndex = new Map(modules.flatMap((module) => module.features.map((feature) => [feature.id, feature])));
  for (const [id, detail] of detailed.details) {
    const feature = featureIndex.get(id);
    if (!feature) {
      warnings.push(warning("FEATURE_DETAIL_ORPHAN", `多层功能明细“${detail.name}”没有对应的小模块。`, { sourcePath, featureId: id }));
      continue;
    }
    if (feature.name !== detail.name) warnings.push(warning("FEATURE_DETAIL_NAME_MISMATCH", `小模块 ID“${id}”在功能表与多层明细中的名称不一致。`, { sourcePath, featureId: id }));
    if (detail.points.length) feature.points = detail.points;
  }
  if (!modules.length) warnings.push(warning("FEATURE_TREE_EMPTY", "产品功能树还没有可读取的模块。", { sourcePath }));
  return {
    title,
    description: cleanInline(lines.find((line) => /^>\s*/u.test(line))?.replace(/^>\s*/u, "") || ""),
    sourcePath,
    modules,
    warnings,
  };
}

export function parseProductFeatureIndex(markdown = "", context = {}) {
  const sourcePath = context.sourcePath || "产品功能树.md";
  const lines = String(markdown).split(/\r?\n/u);
  const title = cleanInline(lines.find((line) => /^#\s+/u.test(line))?.replace(/^#\s+/u, "") || "产品功能树");
  const description = cleanInline(lines.find((line) => /^>\s*/u.test(line))?.replace(/^>\s*/u, "") || "");
  const moduleRefs = [];
  const warnings = [];
  const ids = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith("|") || !lines[index].trim().endsWith("|")) continue;
    const header = splitMarkdownRow(lines[index]).map(cleanInline);
    if (!header.includes("模块") || !header.includes("ID") || !header.includes("原件")) continue;
    const separator = lines[index + 1];
    if (!separator?.trim().startsWith("|")) continue;
    const columns = new Map(header.map((name, columnIndex) => [name, columnIndex]));
    index += 2;
    for (; index < lines.length; index += 1) {
      const rowLine = lines[index];
      if (!rowLine.trim().startsWith("|") || !rowLine.trim().endsWith("|")) {
        index -= 1;
        break;
      }
      const row = splitMarkdownRow(rowLine);
      const name = cleanInline(row[columns.get("模块")] || "");
      const id = cleanInline(row[columns.get("ID")] || "").toLowerCase();
      const source = wikiLink(row[columns.get("原件")] || "");
      if (!name || !id || !source?.path) {
        warnings.push(warning("FEATURE_MODULE_REF_INVALID", `模块登记表第 ${index + 1} 行缺少模块名、稳定 ID 或原件。`, { sourcePath }));
        continue;
      }
      if (ids.has(id)) warnings.push(warning("FEATURE_ID_DUPLICATE", `模块登记表 ID“${id}”重复。`, { sourcePath, featureId: id }));
      else ids.add(id);
      moduleRefs.push({ id, name, description: cleanInline(row[columns.get("说明")] || ""), source });
    }
  }

  const presentation = parsePresentationGroups(markdown, "展示分区", "模块 ID", ids, sourcePath);
  warnings.push(...presentation.warnings);
  return { title, description, sourcePath, moduleRefs, warnings, ...(presentation.groups.length ? { presentationGroups: presentation.groups } : {}) };
}

function safeVaultPath(root, sourcePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, String(sourcePath || ""));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("FEATURE_TREE_PATH_OUTSIDE_VAULT");
  return resolved;
}

export async function readProductFeatureTree(root, sourcePath) {
  if (!sourcePath) return null;
  try {
    const markdown = await fs.readFile(safeVaultPath(root, sourcePath), "utf8");
    const index = parseProductFeatureIndex(markdown, { sourcePath });
    if (!index.moduleRefs.length) return parseProductFeatureTree(markdown, { sourcePath });

    const modules = [];
    const warnings = [...index.warnings];
    const featureIds = new Map();
    for (const ref of index.moduleRefs) {
      let moduleMarkdown;
      try {
        moduleMarkdown = await fs.readFile(safeVaultPath(root, ref.source.path), "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        warnings.push(warning("FEATURE_MODULE_FILE_MISSING", `模块“${ref.name}”登记了原件，但文件不存在。`, { sourcePath: ref.source.path, featureId: ref.id }));
        modules.push({ id: ref.id, name: ref.name, description: ref.description || "模块原件暂时缺失。", sourcePath: ref.source.path, features: [] });
        continue;
      }

      const parsed = parseProductFeatureTree(moduleMarkdown, { sourcePath: ref.source.path });
      warnings.push(...parsed.warnings);
      const module = parsed.modules.find((item) => item.id === ref.id);
      if (!module) {
        warnings.push(warning("FEATURE_MODULE_ID_MISMATCH", `模块“${ref.name}”的原件没有登记 ID“${ref.id}”。`, { sourcePath: ref.source.path, featureId: ref.id }));
        modules.push({ id: ref.id, name: ref.name, description: ref.description || "模块原件 ID 不匹配。", sourcePath: ref.source.path, features: [] });
        continue;
      }
      if (module.name !== ref.name) warnings.push(warning("FEATURE_MODULE_NAME_MISMATCH", `模块 ID“${ref.id}”在登记表与原件中的名称不一致。`, { sourcePath: ref.source.path, featureId: ref.id }));
      for (const feature of module.features) {
        if (featureIds.has(feature.id)) warnings.push(warning("FEATURE_ID_DUPLICATE", `功能 ID“${feature.id}”同时出现在${featureIds.get(feature.id)}和模块“${ref.name}”。`, { sourcePath: ref.source.path, featureId: feature.id }));
        else featureIds.set(feature.id, `模块“${ref.name}”`);
      }
      modules.push({ ...module, name: ref.name, description: module.description || ref.description, sourcePath: ref.source.path });
    }

    for (const module of modules) {
      for (const detail of module.presentationFeatures || []) {
        if (!featureIds.has(detail.relatedFeatureId)) warnings.push(warning("FEATURE_PRESENTATION_OWNER_MISSING", `界面细项“${detail.name}”的关联功能不存在。`, { sourcePath: module.sourcePath, featureId: detail.id }));
        if (featureIds.has(detail.id) && !module.features.some((feature) => feature.id === detail.id)) warnings.push(warning("FEATURE_PRESENTATION_ID_COLLISION", `界面细项 ID“${detail.id}”与其他模块的功能冲突。`, { sourcePath: module.sourcePath }));
      }
    }

    return {
      title: index.title,
      description: index.description,
      sourcePath,
      modules,
      warnings,
      ...(index.presentationGroups ? { presentationGroups: index.presentationGroups } : {}),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
