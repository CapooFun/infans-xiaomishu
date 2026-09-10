import fs from "node:fs/promises";
import path from "node:path";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";
import { HOME_PINS_PATH } from "./vault-paths.mjs";

const PINS_RELATIVE = HOME_PINS_PATH;
const MAX_IDS = 24;
const DEFAULT_RESEARCH_DOMAIN_ID = "zztj";
const RESEARCH_DOMAIN_IDS = new Set(["game", "ai", "language", "thought-history", "zztj", "image-management", "fitness", "economics-finance"]);

function emptyPins() {
  return { topicIds: [], likedCourseIds: [], researchDomainId: DEFAULT_RESEARCH_DOMAIN_ID };
}

function normalizeIds(raw, limit = MAX_IDS) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, limit);
}

function normalizePins(raw) {
  return {
    topicIds: normalizeIds(raw?.topicIds, 12),
    likedCourseIds: normalizeIds(raw?.likedCourseIds, MAX_IDS),
    researchDomainId: raw?.researchDomainId === null
      ? null
      : RESEARCH_DOMAIN_IDS.has(raw?.researchDomainId) ? raw.researchDomainId : DEFAULT_RESEARCH_DOMAIN_ID,
  };
}

export function homePinsPath(vaultRoot) {
  return path.resolve(vaultRoot, PINS_RELATIVE);
}

async function writePinsFile(absolute, pins) {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.infans-tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
  await fs.rename(temporary, absolute);
}

async function readPinsFrom(absolute) {
  try {
    const text = await fs.readFile(absolute, "utf8");
    return normalizePins(JSON.parse(text));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyPins();
    throw error;
  }
}

export async function readHomePins(vaultRoot) {
  return readPinsFrom(homePinsPath(vaultRoot));
}

/** 缺省字段保留盘上原值，避免改一类策展时冲掉其他偏好。 */
export async function writeHomePins(vaultRoot, payload = {}) {
  return withVaultFileWrite(vaultRoot, PINS_RELATIVE, async (absolute) => {
    const current = await readPinsFrom(absolute);
    const next = normalizePins({
      topicIds: payload.topicIds !== undefined ? payload.topicIds : current.topicIds,
      likedCourseIds: payload.likedCourseIds !== undefined ? payload.likedCourseIds : current.likedCourseIds,
      researchDomainId: payload.researchDomainId !== undefined ? payload.researchDomainId : current.researchDomainId,
    });
    await writePinsFile(absolute, next);
    return next;
  });
}
