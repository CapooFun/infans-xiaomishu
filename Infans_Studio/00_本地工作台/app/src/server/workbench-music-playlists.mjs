import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MUSIC_PLAYLISTS_PATH } from "./vault-paths.mjs";
import { normalizeMusicPath, readMusicFileMetadata } from "./workbench-music.mjs";

const MAX_PLAYLISTS = 100;
const MAX_TRACKS = 2000;

function playlistError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function musicPlaylistsPath(vaultRoot) {
  return path.resolve(vaultRoot, MUSIC_PLAYLISTS_PATH);
}

function normalizeName(value) {
  const name = String(value || "").trim().normalize("NFC");
  if (!name || name.length > 40) throw playlistError("歌单名称需要是 1 至 40 个字");
  return name;
}

function normalizePlaylist(raw) {
  if (!raw || typeof raw !== "object" || !String(raw.id || "").startsWith("playlist-")) return null;
  let name;
  try { name = normalizeName(raw.name); } catch { return null; }
  const seen = new Set();
  const paths = [];
  for (const candidate of Array.isArray(raw.paths) ? raw.paths : []) {
    try {
      const relative = normalizeMusicPath(candidate);
      if (!relative || seen.has(relative)) continue;
      seen.add(relative);
      paths.push(relative);
      if (paths.length >= MAX_TRACKS) break;
    } catch { /* 忽略损坏的旧条目 */ }
  }
  return {
    id: String(raw.id),
    name,
    paths,
    createdAt: Number.isFinite(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : new Date(0).toISOString(),
    updatedAt: Number.isFinite(Date.parse(raw.updatedAt)) ? new Date(raw.updatedAt).toISOString() : new Date(0).toISOString(),
  };
}

async function readStored(vaultRoot) {
  try {
    const raw = JSON.parse(await fs.readFile(musicPlaylistsPath(vaultRoot), "utf8"));
    return (Array.isArray(raw?.playlists) ? raw.playlists : []).map(normalizePlaylist).filter(Boolean).slice(0, MAX_PLAYLISTS);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeStored(vaultRoot, playlists) {
  const absolute = musicPlaylistsPath(vaultRoot);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.infans-tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ version: 1, playlists }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, absolute);
  await fs.chmod(absolute, 0o600);
}

async function hydratePath(libraryDir, relativePath) {
  try {
    return { ...await readMusicFileMetadata(libraryDir, relativePath), available: true };
  } catch {
    const folder = path.posix.dirname(relativePath);
    const name = path.posix.basename(relativePath).normalize("NFC");
    return {
      kind: "track", id: relativePath, name,
      title: path.posix.basename(name, path.posix.extname(name)).replace(/^\s*\d{1,4}\s*[-_.、）)]\s*/, ""),
      path: relativePath, folder: folder === "." ? "" : folder, bytes: 0, modifiedAt: "",
      format: path.posix.extname(name).slice(1).toUpperCase(), browserReady: false, duration: 0, available: false,
    };
  }
}

async function snapshot(libraryDir, playlists) {
  return { playlists: await Promise.all(playlists.map(async (playlist) => ({
    id: playlist.id, name: playlist.name, createdAt: playlist.createdAt, updatedAt: playlist.updatedAt,
    tracks: await Promise.all(playlist.paths.map((relative) => hydratePath(libraryDir, relative))),
  }))) };
}

export async function readMusicPlaylists(vaultRoot, libraryDir) {
  return snapshot(libraryDir, await readStored(vaultRoot));
}

export async function createMusicPlaylist(vaultRoot, libraryDir, value) {
  const current = await readStored(vaultRoot);
  if (current.length >= MAX_PLAYLISTS) throw playlistError("歌单数量已到上限");
  const name = normalizeName(value);
  if (current.some((playlist) => playlist.name === name)) throw playlistError("已经有同名歌单");
  const now = new Date().toISOString();
  const next = [...current, { id: `playlist-${randomUUID()}`, name, paths: [], createdAt: now, updatedAt: now }];
  await writeStored(vaultRoot, next);
  return snapshot(libraryDir, next);
}

export async function updateMusicPlaylist(vaultRoot, libraryDir, body) {
  const current = await readStored(vaultRoot);
  const index = current.findIndex((playlist) => playlist.id === body?.playlistId);
  if (index < 0) throw playlistError("找不到这个歌单", 404);
  const playlist = { ...current[index], paths: [...current[index].paths], updatedAt: new Date().toISOString() };
  if (body.action === "add") {
    const track = await readMusicFileMetadata(libraryDir, body.path);
    if (!playlist.paths.includes(track.path)) playlist.paths.push(track.path);
    if (playlist.paths.length > MAX_TRACKS) throw playlistError("这个歌单的歌曲太多了");
  } else if (body.action === "remove") {
    const relative = normalizeMusicPath(body.path);
    playlist.paths = playlist.paths.filter((item) => item !== relative);
  } else if (body.action === "move") {
    const relative = normalizeMusicPath(body.path);
    const from = playlist.paths.indexOf(relative);
    if (from < 0) throw playlistError("这首歌不在歌单里", 404);
    const requested = Number(body.toIndex);
    if (!Number.isInteger(requested)) throw playlistError("排序位置不合法");
    const to = Math.max(0, Math.min(requested, playlist.paths.length - 1));
    playlist.paths.splice(from, 1);
    playlist.paths.splice(to, 0, relative);
  } else if (body.action === "rename") {
    playlist.name = normalizeName(body.name);
    if (current.some((item, itemIndex) => itemIndex !== index && item.name === playlist.name)) throw playlistError("已经有同名歌单");
  } else {
    throw playlistError("这个歌单操作不受支持");
  }
  const next = current.with(index, playlist);
  await writeStored(vaultRoot, next);
  return snapshot(libraryDir, next);
}

export async function deleteMusicPlaylist(vaultRoot, libraryDir, playlistId) {
  const current = await readStored(vaultRoot);
  const next = current.filter((playlist) => playlist.id !== playlistId);
  if (next.length === current.length) throw playlistError("找不到这个歌单", 404);
  await writeStored(vaultRoot, next);
  return snapshot(libraryDir, next);
}
