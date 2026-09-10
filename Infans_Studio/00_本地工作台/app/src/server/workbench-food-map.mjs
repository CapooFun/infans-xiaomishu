import fs from "node:fs/promises";
import path from "node:path";
import { FOOD_MAP_CATALOG_PATH, FOOD_MAP_STATE_PATH } from "./vault-paths.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";

const PLACE_ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/u;
const LIST_STATES = new Set(["explore", "favorite", "blacklist", "archived"]);
const CATEGORIES = new Set(["meal", "snack", "dessert", "night"]);
const PROFILE_MATCHES = new Set(["high", "likely", "interest", "neutral"]);
const IMAGE_KINDS = new Set(["official", "venue-photo", "reference"]);
const MAX_NOTE_LENGTH = 220;

function cleanText(value, limit = 180) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function cleanHttpsUrl(value) {
  return /^https:\/\//u.test(String(value || "")) ? String(value) : "";
}

function parseCatalogJson(markdown) {
  const match = String(markdown || "").match(/```json\s*\n([\s\S]*?)\n```/u);
  if (!match) throw new Error("美食地图原件缺少 JSON 数据块");
  return JSON.parse(match[1]);
}

function normalizePlace(value, media = {}) {
  const id = cleanText(value?.id, 80);
  const name = cleanText(value?.name, 120);
  const latitude = Number(value?.latitude);
  const longitude = Number(value?.longitude);
  if (!PLACE_ID_RE.test(id) || !name || !CATEGORIES.has(value?.category)) return null;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  const initialState = LIST_STATES.has(value?.initialState) ? value.initialState : "explore";
  return {
    id,
    name,
    area: cleanText(value?.area, 80),
    station: cleanText(value?.station, 80),
    category: value.category,
    tags: Array.isArray(value?.tags) ? value.tags.map((item) => cleanText(item, 36)).filter(Boolean).slice(0, 6) : [],
    latitude,
    longitude,
    address: cleanText(value?.address, 220),
    profileMatch: PROFILE_MATCHES.has(value?.profileMatch) ? value.profileMatch : "neutral",
    reason: cleanText(value?.reason, 240),
    imageUrl: cleanHttpsUrl(media?.imageUrl),
    imageAlt: cleanText(media?.imageAlt, 180),
    imageKind: IMAGE_KINDS.has(media?.imageKind) ? media.imageKind : "venue-photo",
    imageSourceLabel: cleanText(media?.imageSourceLabel, 100),
    imageSourceUrl: cleanHttpsUrl(media?.imageSourceUrl),
    menuHighlights: Array.isArray(media?.menuHighlights) ? media.menuHighlights.map((item) => ({
      name: cleanText(item?.name, 80),
      price: cleanText(item?.price, 30) || null,
      note: cleanText(item?.note, 120) || null,
    })).filter((item) => item.name).slice(0, 4) : [],
    menuSourceLabel: cleanText(media?.menuSourceLabel, 100),
    menuUrl: cleanHttpsUrl(media?.menuUrl),
    sourceType: value?.sourceType === "official-research" ? "official-research" : "google-saved-food",
    sourceLabel: cleanText(value?.sourceLabel, 100),
    sourceUrl: /^https:\/\//u.test(String(value?.sourceUrl || "")) ? String(value.sourceUrl) : "",
    verifiedAt: /^\d{4}-\d{2}-\d{2}$/u.test(String(value?.verifiedAt || "")) ? String(value.verifiedAt) : null,
    initialState,
    closed: value?.closed === true,
  };
}

function emptyState() {
  return { schemaVersion: 1, updatedAt: null, items: {} };
}

function normalizeState(value) {
  const items = {};
  if (value?.items && typeof value.items === "object" && !Array.isArray(value.items)) {
    for (const [rawId, rawItem] of Object.entries(value.items)) {
      const id = cleanText(rawId, 80);
      if (!PLACE_ID_RE.test(id) || !rawItem || typeof rawItem !== "object") continue;
      const listState = LIST_STATES.has(rawItem.listState) ? rawItem.listState : "explore";
      items[id] = {
        listState,
        followed: (listState === "explore" || listState === "favorite") && rawItem.followed === true,
        note: cleanText(rawItem.note, MAX_NOTE_LENGTH) || null,
        updatedAt: Number.isFinite(Date.parse(rawItem.updatedAt)) ? new Date(rawItem.updatedAt).toISOString() : null,
      };
    }
  }
  return {
    schemaVersion: 1,
    updatedAt: Number.isFinite(Date.parse(value?.updatedAt)) ? new Date(value.updatedAt).toISOString() : null,
    items,
  };
}

export function foodMapCatalogPath(vaultRoot) {
  return path.resolve(vaultRoot, FOOD_MAP_CATALOG_PATH);
}

export function foodMapStatePath(vaultRoot) {
  return path.resolve(vaultRoot, FOOD_MAP_STATE_PATH);
}

export async function readFoodMapCatalog(vaultRoot) {
  const markdown = await fs.readFile(foodMapCatalogPath(vaultRoot), "utf8");
  const parsed = parseCatalogJson(markdown);
  const seen = new Set();
  const places = [];
  for (const row of Array.isArray(parsed?.places) ? parsed.places : []) {
    const media = parsed?.placeMedia && typeof parsed.placeMedia === "object" && !Array.isArray(parsed.placeMedia)
      ? parsed.placeMedia[row?.id]
      : null;
    const place = normalizePlace(row, media);
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    places.push(place);
  }
  return {
    updatedAt: Number.isFinite(Date.parse(parsed?.updatedAt)) ? new Date(parsed.updatedAt).toISOString() : null,
    tasteProfile: {
      sweetness: cleanText(parsed?.tasteProfile?.sweetness, 60),
      favorites: Array.isArray(parsed?.tasteProfile?.favorites) ? parsed.tasteProfile.favorites.map((item) => cleanText(item, 40)).filter(Boolean).slice(0, 8) : [],
      currentInterests: Array.isArray(parsed?.tasteProfile?.currentInterests) ? parsed.tasteProfile.currentInterests.map((item) => cleanText(item, 40)).filter(Boolean).slice(0, 8) : [],
    },
    places,
  };
}

async function readStateFrom(absolute) {
  try {
    return normalizeState(JSON.parse(await fs.readFile(absolute, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function readFoodMapState(vaultRoot) {
  return readStateFrom(foodMapStatePath(vaultRoot));
}

function mapSearchUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.name} ${place.address}`)}`;
}

function navigationUrl(place) {
  return `https://www.google.com/maps/dir/?api=1&destination=${place.latitude},${place.longitude}&travelmode=transit`;
}

export async function readFoodMap(vaultRoot) {
  const [catalog, state] = await Promise.all([readFoodMapCatalog(vaultRoot), readFoodMapState(vaultRoot)]);
  const places = catalog.places.map((place) => {
    const saved = state.items[place.id];
    const listState = saved?.listState || place.initialState;
    const followed = (listState === "explore" || listState === "favorite") && saved?.followed === true;
    return {
      ...place,
      listState,
      followed,
      note: saved?.note || null,
      stateUpdatedAt: saved?.updatedAt || null,
      mapUrl: mapSearchUrl(place),
      navigationUrl: navigationUrl(place),
    };
  });
  return {
    schemaVersion: 1,
    updatedAt: catalog.updatedAt,
    stateUpdatedAt: state.updatedAt,
    tasteProfile: catalog.tasteProfile,
    categories: [
      { id: "all", label: "全部" },
      { id: "meal", label: "正餐" },
      { id: "snack", label: "小吃·面食" },
      { id: "dessert", label: "咖啡·甜点" },
      { id: "night", label: "酒吧·夜食" },
    ],
    places,
  };
}

async function writeStateFile(absolute, state) {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.infans-tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, absolute);
    await fs.chmod(absolute, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** 只保存本人对稳定地点 ID 的选择；店名、坐标和来源继续实时读取美食地图原件。 */
export async function writeFoodMapPlaceState(vaultRoot, payload = {}) {
  const id = cleanText(payload?.id, 80);
  if (!PLACE_ID_RE.test(id)) throw new WorkbenchWriteError("这个美食卡片没有可用的稳定编号", 400, "INVALID_FOOD_MAP_PLACE_ID");
  const hasListState = Object.prototype.hasOwnProperty.call(payload, "listState");
  const hasFollowed = Object.prototype.hasOwnProperty.call(payload, "followed");
  const hasNote = Object.prototype.hasOwnProperty.call(payload, "note");
  if (!hasListState && !hasFollowed && !hasNote) throw new WorkbenchWriteError("没有需要保存的美食状态", 400, "EMPTY_FOOD_MAP_UPDATE");
  if (hasListState && !LIST_STATES.has(payload.listState)) throw new WorkbenchWriteError("美食卡片状态不正确", 400, "INVALID_FOOD_MAP_LIST_STATE");
  if (hasFollowed && typeof payload.followed !== "boolean") throw new WorkbenchWriteError("关注状态不正确", 400, "INVALID_FOOD_MAP_FOLLOW_STATE");
  if (hasNote && typeof payload.note !== "string") throw new WorkbenchWriteError("个人备注格式不正确", 400, "INVALID_FOOD_MAP_NOTE");

  const operation = withVaultFileWrite(vaultRoot, FOOD_MAP_STATE_PATH, async (absolute) => {
    const catalog = await readFoodMapCatalog(vaultRoot);
    const place = catalog.places.find((item) => item.id === id);
    if (!place) throw new WorkbenchWriteError("这张美食卡片已经不在当前原件中", 409, "FOOD_MAP_PLACE_NOT_FOUND");
    const current = await readStateFrom(absolute);
    const previous = current.items[id] || {
      listState: place.initialState,
      followed: false,
      note: null,
      updatedAt: null,
    };
    const listState = hasListState ? payload.listState : previous.listState;
    const nextItem = {
      listState,
      followed: (listState === "explore" || listState === "favorite") && (hasFollowed ? payload.followed : previous.followed),
      note: hasNote ? (cleanText(payload.note, MAX_NOTE_LENGTH) || null) : previous.note,
      updatedAt: new Date().toISOString(),
    };
    const next = normalizeState({
      schemaVersion: 1,
      updatedAt: nextItem.updatedAt,
      items: { ...current.items, [id]: nextItem },
    });
    await writeStateFile(absolute, next);
    return readFoodMap(vaultRoot);
  });
  return operation;
}
