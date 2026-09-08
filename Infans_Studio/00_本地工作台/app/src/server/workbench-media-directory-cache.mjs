import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE = "nas-media-directories.json";
const MEMORY_FRESH_MS = 30_000;
const MAX_ENTRIES = 160;

const memoryRecords = new Map();
const inFlight = new Map();
const stores = new Map();
const writeQueues = new Map();

export function defaultMediaDirectoryCacheDir() {
  return path.join(os.homedir(), "Library", "Caches", "com.infans.digitalsecretary");
}

function cacheFilePath(cacheDir) {
  return path.join(cacheDir, CACHE_FILE);
}

function cacheKey(kind, libraryDir, relativeDir) {
  return JSON.stringify([kind, path.resolve(libraryDir), relativeDir]);
}

function emptyStore() {
  return { schemaVersion: CACHE_SCHEMA_VERSION, updatedAt: null, entries: {} };
}

async function readStore(cacheDir) {
  const filePath = cacheFilePath(cacheDir);
  if (stores.has(filePath)) return stores.get(filePath);
  let store = emptyStore();
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (parsed?.schemaVersion === CACHE_SCHEMA_VERSION && parsed.entries && typeof parsed.entries === "object") store = parsed;
  } catch {
    // 首次使用或损坏时从空缓存重建。
  }
  stores.set(filePath, store);
  return store;
}

function trimEntries(entries) {
  const rows = Object.entries(entries);
  if (rows.length <= MAX_ENTRIES) return entries;
  return Object.fromEntries(rows
    .sort((left, right) => String(right[1]?.lastAccessedAt || "").localeCompare(String(left[1]?.lastAccessedAt || "")))
    .slice(0, MAX_ENTRIES));
}

async function persistStore(cacheDir, store) {
  const filePath = cacheFilePath(cacheDir);
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const payload = { ...store, schemaVersion: CACHE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), entries: trimEntries(store.entries) };
    store.updatedAt = payload.updatedAt;
    store.entries = payload.entries;
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, filePath);
      await fs.chmod(filePath, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
  writeQueues.set(filePath, next);
  await next;
}

function decorate(record, { stale = false, warning = "", source = "memory" } = {}) {
  return {
    ...record.value,
    stale,
    cacheWarning: warning,
    cache: {
      source,
      checkedAt: record.checkedAt,
      refreshedAt: record.refreshedAt,
    },
  };
}

async function writeRecord(cacheDir, key, record) {
  const store = await readStore(cacheDir);
  store.entries[key] = record;
  await persistStore(cacheDir, store);
}

async function loadDiskRecord(cacheDir, key) {
  const store = await readStore(cacheDir);
  const record = store.entries[key];
  if (!record?.value || typeof record.value !== "object") return null;
  return record;
}

function refreshRecord({ key, cacheDir, current, force, probe, readFresh, now }) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = Promise.resolve().then(async () => {
    const signature = await probe();
    if (!force && current && current.signature === signature) {
      const checkedAt = new Date(now()).toISOString();
      const next = { ...current, checkedAt, lastAccessedAt: checkedAt };
      memoryRecords.set(key, next);
      void writeRecord(cacheDir, key, next).catch(() => undefined);
      return decorate(next, { source: "validated" });
    }
    const value = await readFresh();
    const refreshedAt = new Date(now()).toISOString();
    const next = { signature, checkedAt: refreshedAt, refreshedAt, lastAccessedAt: refreshedAt, value };
    memoryRecords.set(key, next);
    await writeRecord(cacheDir, key, next).catch(() => undefined);
    return decorate(next, { source: "scan" });
  }).finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

export async function readMediaDirectoryCached({
  kind,
  libraryDir,
  relativeDir = "",
  force = false,
  cacheDir = defaultMediaDirectoryCacheDir(),
  probe,
  readFresh,
  now = Date.now,
}) {
  const key = cacheKey(kind, libraryDir, relativeDir);
  let current = memoryRecords.get(key) || null;
  let source = "memory";
  if (!current) {
    current = await loadDiskRecord(cacheDir, key);
    source = "disk";
    if (current) memoryRecords.set(key, current);
  }
  const age = current ? now() - Date.parse(current.checkedAt || current.refreshedAt || 0) : Number.POSITIVE_INFINITY;
  if (current && !force && Number.isFinite(age) && age < MEMORY_FRESH_MS) {
    current.lastAccessedAt = new Date(now()).toISOString();
    return decorate(current, { source });
  }
  if (current && !force) {
    void refreshRecord({ key, cacheDir, current, force: false, probe, readFresh, now }).catch(() => undefined);
    return decorate(current, { stale: true, source });
  }
  try {
    return await refreshRecord({ key, cacheDir, current, force, probe, readFresh, now });
  } catch (error) {
    if (!current) throw error;
    return decorate(current, {
      stale: true,
      warning: error instanceof Error ? error.message : "NAS 暂时不可用，正在显示上次成功结果",
      source,
    });
  }
}

export function resetMediaDirectoryCacheForTests() {
  memoryRecords.clear();
  inFlight.clear();
  stores.clear();
  writeQueues.clear();
}
