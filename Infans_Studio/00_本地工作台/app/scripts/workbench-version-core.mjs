const CHANGE_HEADING_RE = /^## (\d{4}-\d{2}-\d{2}) · ([^·\n]+?) · ([^\n]+)$/gm;
const OFFICIAL_VERSION_TYPE_RE = /^V(\d+\.\d+\.\d+)$/;
const HANDOFF_PREFIX = "- 版本交接：";
const POLICY_START_MARKERS = ["<!-- WORKBENCH_DAILY_VERSION_START -->"];

const VALID_STATUS = new Set(["已验证", "已验收", "待验收", "进行中"]);
const VALID_RUNTIME = new Set(["已启用", "已隔离", "未进入运行", "不适用"]);
const VALID_BUMP = new Set(["minor", "patch", "none"]);
const BUMP_RANK = { none: 0, patch: 1, minor: 2 };

function splitField(token) {
  const index = token.indexOf("=");
  if (index < 1) return null;
  return [token.slice(0, index).trim(), token.slice(index + 1).trim()];
}

export function parseHandoffLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith(HANDOFF_PREFIX)) return null;

  const fields = {};
  for (const token of trimmed.slice(HANDOFF_PREFIX.length).split("｜")) {
    const pair = splitField(token);
    if (pair) fields[pair[0]] = pair[1];
  }

  const errors = [];
  for (const key of ["ID", "状态", "运行", "建议", "任务"]) {
    if (!fields[key]) errors.push(`缺少${key}`);
  }
  if (fields.状态 && !VALID_STATUS.has(fields.状态)) errors.push(`未知状态：${fields.状态}`);
  if (fields.运行 && !VALID_RUNTIME.has(fields.运行)) errors.push(`未知运行状态：${fields.运行}`);
  if (fields.建议 && !VALID_BUMP.has(fields.建议)) errors.push(`未知升版建议：${fields.建议}`);
  if (["已验证", "已验收", "待验收"].includes(fields.状态) && fields.运行 === "已启用" && fields.建议 !== "none" && !fields.证据) {
    errors.push("可升版任务缺少证据");
  }

  return {
    id: String(fields.ID || "").replace(/^`+|`+$/g, "").trim(),
    status: fields.状态 || "",
    runtime: fields.运行 || "",
    bump: fields.建议 || "",
    task: fields.任务 || "",
    evidence: fields.证据 || "",
    remaining: fields.遗留 || "",
    raw: trimmed,
    errors,
  };
}

/** 施工检查只校验新增或修改的交接，不把旧欠账转嫁给本次施工。 */
export function validateVersionHandoffs(changelog, { baseline = "", taskId } = {}) {
  const current = parsePendingChangeBlocks(changelog).blocks;
  const previous = new Map(parsePendingChangeBlocks(baseline).blocks.map((block) => [
    `${block.date}|${block.type}|${block.title}`, block,
  ]));
  const errors = [];
  let checked = 0;
  for (const block of current) {
    const old = previous.get(`${block.date}|${block.type}|${block.title}`);
    const handoffs = taskId ? block.handoffs.filter((item) => item.id === taskId) : block.handoffs;
    if (taskId && !handoffs.length) continue;
    if (!taskId && old?.text === block.text) continue;
    checked += 1;
    const label = `${block.date} · ${block.title}`;
    if (!handoffs.length) errors.push(`${label} 缺少版本交接`);
    for (const handoff of handoffs) {
      if (!taskId && old?.handoffs.some((item) => item.raw === handoff.raw)) continue;
      errors.push(...handoff.errors.map((error) => `${label} / ${handoff.id || "缺少ID"}：${error}`));
    }
    if (taskId) break; // 与升版判定一致：同一 ID 只核对最新交接，保留旧修订事实。
  }
  if (taskId && !checked) errors.push(`未找到本次任务的版本交接：${taskId}`);
  return { checked, errors };
}

export function parsePendingChangeBlocks(changelog) {
  const text = String(changelog || "");
  const headings = [...text.matchAll(CHANGE_HEADING_RE)].map((match) => ({
    index: match.index,
    date: match[1],
    type: match[2].trim(),
    title: match[3].trim(),
    version: OFFICIAL_VERSION_TYPE_RE.exec(match[2].trim())?.[1] || null,
  }));

  if (!headings.length) return { prefix: text, blocks: [], rest: "", currentVersion: null, currentVersionDate: null };

  const firstOfficial = headings.find((heading) => heading.version);
  const policyStart = POLICY_START_MARKERS
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
  const pendingEnd = Math.min(
    firstOfficial?.index ?? text.length,
    policyStart >= 0 ? policyStart : text.length,
  );
  const pendingHeadings = headings.filter((heading) => !heading.version && heading.index < pendingEnd);
  const prefixEnd = pendingHeadings[0]?.index ?? pendingEnd;
  const blocks = pendingHeadings.map((heading, index) => {
    const next = pendingHeadings[index + 1];
    const end = next?.index ?? pendingEnd;
    const blockText = text.slice(heading.index, end).trimEnd();
    const handoffLines = blockText.split("\n").filter((line) => line.trim().startsWith(HANDOFF_PREFIX));
    const latestById = new Map();
    for (const line of handoffLines) {
      const handoff = parseHandoffLine(line);
      const key = handoff.id || `__invalid_${latestById.size}`;
      handoff.revisionCount = (latestById.get(key)?.revisionCount || 0) + 1;
      latestById.set(key, handoff);
    }
    const handoffs = [...latestById.values()];
    return { ...heading, text: blockText, handoffs, handoff: handoffs.at(-1) || null };
  });

  return {
    prefix: text.slice(0, prefixEnd).trimEnd(),
    blocks,
    rest: text.slice(pendingEnd).trimStart(),
    currentVersion: firstOfficial?.version || null,
    currentVersionDate: firstOfficial?.date || null,
    currentReleaseWeek: firstOfficial ? text.slice(firstOfficial.index, headings.find((heading) => heading.index > firstOfficial.index)?.index ?? text.length).match(/<!-- release-week: (\d{4}-\d{2}-\d{2}) -->/)?.[1] || null : null,
  };
}

export function releaseWeek(date) {
  const day = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) throw new Error("执行日期必须是有效的 YYYY-MM-DD");
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) - 7);
  return day.toISOString().slice(0, 10);
}

export function decideDailyVersion(blocks) {
  const blockers = [];
  const eligible = [];
  const unresolvedTasks = [];
  const resolvedWithoutBump = [];
  const groups = new Map();
  const missingBlocks = [];

  for (const block of blocks) {
    const handoffs = block.handoffs || (block.handoff ? [block.handoff] : []);
    if (!handoffs.length) {
      missingBlocks.push(block);
      continue;
    }
    for (const handoff of handoffs) {
      const key = handoff.id || `__invalid_${block.index}`;
      if (!groups.has(key)) groups.set(key, { id: handoff.id, records: [] });
      groups.get(key).records.push({ block, handoff });
    }
  }

  for (const block of missingBlocks) blockers.push(`${block.date} · ${block.title} 缺少版本交接`);

  for (const group of groups.values()) {
    const latest = group.records[0];
    const bump = group.records.reduce((current, record) => (
      BUMP_RANK[record.handoff.bump] > BUMP_RANK[current] ? record.handoff.bump : current
    ), "none");
    const handoff = { ...latest.handoff, bump };
    const revisionCount = group.records.reduce((total, record) => total + (record.handoff.revisionCount || 1), 0);
    const task = { ...latest.block, handoff, records: group.records, revisionCount };
    const label = `${latest.block.date} · ${handoff.task || latest.block.title}`;

    if (handoff.errors.length) {
      blockers.push(`${label}：${handoff.errors.join("、")}`);
      continue;
    }

    if (["已隔离", "未进入运行"].includes(handoff.runtime)) {
      unresolvedTasks.push(task);
      continue;
    }
    if (handoff.status === "进行中") {
      unresolvedTasks.push(task);
      if (handoff.runtime === "已启用") blockers.push(`${label} 仍在施工但已经进入运行`);
      continue;
    }

    if (handoff.status === "待验收" && handoff.runtime !== "已启用") {
      unresolvedTasks.push(task);
      continue;
    }
    if (handoff.status === "待验收" && !handoff.evidence) {
      blockers.push(`${label} 待本人验收且缺少技术验证证据`);
      continue;
    }
    if (handoff.bump === "none") {
      resolvedWithoutBump.push(task);
      continue;
    }
    if (handoff.runtime !== "已启用") {
      blockers.push(`${label} 建议升版但尚未启用`);
      continue;
    }
    eligible.push(task);
  }

  const unresolvedBlocks = [...new Set(unresolvedTasks.flatMap((task) => task.records.map((record) => record.block)))];
  const unresolvedBlockSet = new Set(unresolvedBlocks);
  const releasableBlocks = blocks.filter((block) => !unresolvedBlockSet.has(block));
  for (const block of unresolvedBlocks) {
    const ids = new Set((block.handoffs || []).map((handoff) => handoff.id));
    const hasResolvedTask = [...eligible, ...resolvedWithoutBump]
      .some((task) => task.records.some((record) => record.block === block && ids.has(record.handoff.id)));
    if (hasResolvedTask) blockers.push(`${block.date} · ${block.title} 同时混有已完成与未完成任务，请拆成独立更新条目`);
  }

  if (blockers.length) {
    return { state: "blocked", level: null, blockers, eligible, unresolved: unresolvedTasks, unresolvedBlocks, resolvedWithoutBump, releasableBlocks };
  }
  if (!eligible.length) {
    return { state: "none", level: null, blockers, eligible, unresolved: unresolvedTasks, unresolvedBlocks, resolvedWithoutBump, releasableBlocks };
  }
  return {
    state: "ready",
    level: eligible.some((block) => block.handoff.bump === "minor") ? "minor" : "patch",
    blockers,
    eligible,
    unresolved: unresolvedTasks,
    unresolvedBlocks,
    resolvedWithoutBump,
    releasableBlocks,
  };
}

export function bumpVersion(currentVersion, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(currentVersion || ""));
  if (!match) throw new Error(`版本号格式不正确：${currentVersion}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (level === "minor") return `${major}.${minor + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`不支持的升版级别：${level}`);
}

function releaseHeading({ date, version, title, decision }) {
  const tasks = decision.eligible.map((block) => block.handoff.task);
  const taskPreview = tasks.slice(0, 10).join("、");
  const taskSuffix = tasks.length > 10 ? `等 ${tasks.length} 项` : "";
  const minorCount = decision.eligible.filter((block) => block.handoff.bump === "minor").length;
  const patchCount = decision.eligible.length - minorCount;
  return [
    `## ${date} · V${version} · ${title}`,
    "",
    `<!-- release-week: ${releaseWeek(date)} -->`,
    `- 本次稳定基线收录 ${minorCount} 项新能力、${patchCount} 项修复；代表任务：${taskPreview}${taskSuffix}。`,
    `- Cursor 每周收口自动判断为 ${decision.level}；同一归属周最多升版一次。`,
    `- 每项技术证据与本人验收边界保留在下方原更新条目；待本人主观验收不再冻结已经验证的技术稳定基线。`,
  ].join("\n");
}

export function applyDailyVersion({ packageText, changelog, date, title = "每日稳定基线" }) {
  const packageJson = JSON.parse(packageText);
  const parsed = parsePendingChangeBlocks(changelog);
  const decision = decideDailyVersion(parsed.blocks);
  if (decision.state !== "ready") {
    const reason = decision.blockers.join("；") || "没有已验证且需要升版的任务";
    throw new Error(`当前不能升版：${reason}`);
  }
  if (parsed.currentVersion && parsed.currentVersion !== packageJson.version) {
    throw new Error(`package.json 为 ${packageJson.version}，更新日志最新正式版本为 ${parsed.currentVersion}`);
  }
  if (parsed.currentVersionDate === date) {
    throw new Error(`${date} 已经形成过正式版本；同一日志归属日最多升版一次`);
  }
  if (parsed.currentReleaseWeek === releaseWeek(date)) throw new Error(`${releaseWeek(date)} 归属周已经形成过正式版本；同一归属周最多升版一次`);

  const version = bumpVersion(packageJson.version, decision.level);
  packageJson.version = version;

  const unresolvedText = decision.unresolvedBlocks.map((block) => block.text).join("\n\n");
  const releasedBlocks = decision.releasableBlocks
    .sort((a, b) => a.index - b.index)
    .map((block) => block.text)
    .join("\n\n");
  const sections = [
    parsed.prefix,
    unresolvedText,
    releaseHeading({ date, version, title, decision }),
    releasedBlocks,
    parsed.rest,
  ].filter(Boolean);

  return {
    version,
    level: decision.level,
    decision,
    packageText: `${JSON.stringify(packageJson, null, 2)}\n`,
    changelog: `${sections.join("\n\n").trimEnd()}\n`,
  };
}
