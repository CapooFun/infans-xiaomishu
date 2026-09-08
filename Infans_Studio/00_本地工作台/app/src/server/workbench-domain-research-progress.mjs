import fs from "node:fs/promises";
import path from "node:path";
import { DOMAIN_RESEARCH_PROGRESS_PATH } from "./vault-paths.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,119}$/u;
const CARD_STATUSES = new Set(["overview", "unclear", "deep"]);
const MAX_RECENT = 30;
let writeQueue = Promise.resolve();

function emptyProgress() {
  return { schemaVersion: 1, cards: {}, choices: {}, lastPosition: null, lastPositions: {}, recentCardIds: [] };
}

function validId(value) {
  const id = String(value || "").trim();
  return ID_RE.test(id) ? id : "";
}

function normalizePosition(raw) {
  const domainId = validId(raw?.domainId);
  const branchId = validId(raw?.branchId);
  const nodeId = validId(raw?.nodeId);
  const cardId = validId(raw?.cardId);
  const cardIndex = Number(raw?.cardIndex);
  if (!domainId || !branchId || !nodeId || !cardId || !Number.isSafeInteger(cardIndex) || cardIndex < 0) return null;
  return { domainId, branchId, nodeId, cardId, cardIndex, updatedAt: String(raw?.updatedAt || "") };
}

export function normalizeDomainResearchProgress(raw) {
  const cards = {};
  for (const [rawId, value] of Object.entries(raw?.cards || {})) {
    const id = validId(rawId);
    if (!id || !CARD_STATUSES.has(value?.status)) continue;
    cards[id] = { status: value.status, updatedAt: String(value.updatedAt || "") };
  }
  const choices = {};
  for (const [rawId, rawChoice] of Object.entries(raw?.choices || {})) {
    const id = validId(rawId);
    const choiceId = validId(rawChoice?.choiceId ?? rawChoice);
    if (id && choiceId) choices[id] = { choiceId, updatedAt: String(rawChoice?.updatedAt || "") };
  }
  const recentCardIds = Array.isArray(raw?.recentCardIds)
    ? [...new Set(raw.recentCardIds.map(validId).filter(Boolean))].slice(0, MAX_RECENT)
    : [];
  const lastPosition = normalizePosition(raw?.lastPosition);
  const lastPositions = {};
  for (const [rawDomainId, rawPosition] of Object.entries(raw?.lastPositions || {})) {
    const domainId = validId(rawDomainId);
    const position = normalizePosition(rawPosition);
    if (domainId && position?.domainId === domainId) lastPositions[domainId] = position;
  }
  if (lastPosition && !lastPositions[lastPosition.domainId]) lastPositions[lastPosition.domainId] = lastPosition;
  return { schemaVersion: 1, cards, choices, lastPosition, lastPositions, recentCardIds };
}

export function domainResearchProgressPath(vaultRoot) {
  return path.resolve(vaultRoot, DOMAIN_RESEARCH_PROGRESS_PATH);
}

async function writeProgressFile(absolute, payload) {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.infans-tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, absolute);
    await fs.chmod(absolute, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readDomainResearchProgress(vaultRoot) {
  try {
    const text = await fs.readFile(domainResearchProgressPath(vaultRoot), "utf8");
    return normalizeDomainResearchProgress(JSON.parse(text));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyProgress();
    throw error;
  }
}

/** 单次点按只更新当前卡；知识正文与本人判断原件不写入此派生文件。 */
export async function writeDomainResearchProgress(vaultRoot, payload = {}, options = {}) {
  const cardId = validId(payload.cardId);
  if (!cardId) throw new WorkbenchWriteError("知识卡编号不正确", 400, "INVALID_DOMAIN_CARD_ID");
  const status = payload.status === undefined ? undefined : String(payload.status);
  if (status !== undefined && !CARD_STATUSES.has(status)) throw new WorkbenchWriteError("知识卡状态不正确", 400, "INVALID_DOMAIN_CARD_STATUS");
  const choiceId = payload.choiceId === undefined ? undefined : validId(payload.choiceId);
  if (payload.choiceId !== undefined && !choiceId) throw new WorkbenchWriteError("判断选项不正确", 400, "INVALID_DOMAIN_CHOICE_ID");
  const position = normalizePosition(payload.position);
  if (!position || position.cardId !== cardId) throw new WorkbenchWriteError("浏览位置不正确", 400, "INVALID_DOMAIN_POSITION");
  const now = options.now?.() ?? new Date();
  const updatedAt = now.toISOString();
  const operation = writeQueue.then(async () => {
    const current = await readDomainResearchProgress(vaultRoot);
    const next = normalizeDomainResearchProgress(current);
    if (status !== undefined) next.cards[cardId] = { status, updatedAt };
    if (choiceId !== undefined) next.choices[cardId] = { choiceId, updatedAt };
    next.lastPosition = { ...position, updatedAt };
    next.lastPositions[position.domainId] = { ...position, updatedAt };
    next.recentCardIds = [cardId, ...next.recentCardIds.filter((id) => id !== cardId)].slice(0, MAX_RECENT);
    await writeProgressFile(domainResearchProgressPath(vaultRoot), next);
    return next;
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}
