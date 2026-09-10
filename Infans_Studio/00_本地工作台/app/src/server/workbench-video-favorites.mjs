import fs from "node:fs/promises";
import path from "node:path";
import { VIDEO_FAVORITES_PATH } from "./vault-paths.mjs";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";
import { normalizeVideoPath, readVideoFileMetadata } from "./workbench-video.mjs";

const MAX_FAVORITES = 500;

export function videoFavoritesPath(vaultRoot) {
  return path.resolve(vaultRoot, VIDEO_FAVORITES_PATH);
}

function normalizeStoredItem(item) {
  try {
    const relativePath = normalizeVideoPath(item?.path);
    if (!relativePath) return null;
    return {
      path: relativePath,
      name: String(item?.name || path.posix.basename(relativePath)).normalize("NFC"),
      folder: String(item?.folder || (path.posix.dirname(relativePath) === "." ? "" : path.posix.dirname(relativePath))),
      addedAt: Number.isFinite(Date.parse(item?.addedAt)) ? new Date(item.addedAt).toISOString() : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

async function readStoredFavoritesFrom(absolute) {
  try {
    const raw = JSON.parse(await fs.readFile(absolute, "utf8"));
    const seen = new Set();
    const items = [];
    for (const candidate of Array.isArray(raw?.items) ? raw.items : []) {
      const item = normalizeStoredItem(candidate);
      if (!item || seen.has(item.path)) continue;
      seen.add(item.path);
      items.push(item);
      if (items.length >= MAX_FAVORITES) break;
    }
    return items;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readStoredFavorites(vaultRoot) {
  return readStoredFavoritesFrom(videoFavoritesPath(vaultRoot));
}

async function writeStoredFavoritesTo(absolute, items) {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.infans-tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, absolute);
  await fs.chmod(absolute, 0o600);
}

async function hydrateFavorite(libraryDir, stored) {
  try {
    return { ...await readVideoFileMetadata(libraryDir, stored.path), addedAt: stored.addedAt, available: true };
  } catch {
    return { kind: "video", ...stored, bytes: 0, modifiedAt: "", format: path.posix.extname(stored.path).slice(1).toUpperCase(), browserReady: false, available: false };
  }
}

async function snapshot(vaultRoot, libraryDir, items = null) {
  const stored = items || await readStoredFavorites(vaultRoot);
  return { items: await Promise.all(stored.map((item) => hydrateFavorite(libraryDir, item))) };
}

export async function readVideoFavorites(vaultRoot, libraryDir) {
  return snapshot(vaultRoot, libraryDir);
}

export async function addVideoFavorite(vaultRoot, libraryDir, relativeFile) {
  const video = await readVideoFileMetadata(libraryDir, relativeFile);
  return withVaultFileWrite(vaultRoot, VIDEO_FAVORITES_PATH, async (absolute) => {
    const current = await readStoredFavoritesFrom(absolute);
    const existing = current.find((item) => item.path === video.path);
    const addedAt = existing?.addedAt || new Date().toISOString();
    const next = [
      { path: video.path, name: video.name, folder: video.folder, addedAt },
      ...current.filter((item) => item.path !== video.path),
    ].slice(0, MAX_FAVORITES);
    await writeStoredFavoritesTo(absolute, next);
    return snapshot(vaultRoot, libraryDir, next);
  });
}

export async function removeVideoFavorite(vaultRoot, libraryDir, relativeFile) {
  const normalized = normalizeVideoPath(relativeFile);
  if (!normalized) throw new Error("视频路径不合法");
  return withVaultFileWrite(vaultRoot, VIDEO_FAVORITES_PATH, async (absolute) => {
    const current = await readStoredFavoritesFrom(absolute);
    const next = current.filter((item) => item.path !== normalized);
    await writeStoredFavoritesTo(absolute, next);
    return snapshot(vaultRoot, libraryDir, next);
  });
}
