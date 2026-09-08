import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WORLD_NEWS_CURRENT, worldNewsHistoryDir } from "../src/server/vault-paths.mjs";
import {
  parseWorldLaneBrief,
  readingAudioBasename,
  resolveReadingAudioAbsolute,
} from "../src/server/workbench-world-brief.mjs";

const vaultRoot = process.env.INFANS_VAULT_ROOT || path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function listJapanMarkdown() {
  const files = [WORLD_NEWS_CURRENT.japan];
  const historyDir = worldNewsHistoryDir("japan");
  try {
    const names = await fs.readdir(path.resolve(vaultRoot, historyDir));
    for (const name of names.filter((item) => /^20\d{2}-\d{2}-\d{2}\.md$/.test(item))) {
      files.push(`${historyDir}/${name}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return [...new Set(files)];
}

async function readSourceSidecar(absolute) {
  try {
    return (await fs.readFile(`${absolute}.source`, "utf8")).trim();
  } catch {
    return "";
  }
}

async function removeLocalAudio(absolute) {
  await fs.rm(absolute, { force: true });
  await fs.rm(`${absolute}.source`, { force: true });
}

async function tryDownloadOfficialAudio(url, dest) {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return false;
    const type = String(response.headers.get("content-type") || "");
    const looksAudio = /audio\/|mpeg|mp4|aac/i.test(type) || /\.mp3(\?|$)/i.test(url);
    if (!looksAudio) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 800 || bytes.length > 8 * 1024 * 1024) return false;
    await fs.writeFile(dest, bytes);
    await fs.writeFile(`${dest}.source`, "original\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

async function fetchOne(briefDate, reading) {
  const basename = readingAudioBasename(briefDate || reading.date, reading.id);
  const absolute = resolveReadingAudioAbsolute(vaultRoot, basename);
  if (!absolute) return { id: reading.id, skipped: "filename" };

  const existingSource = await readSourceSidecar(absolute);
  if (existingSource === "tts") {
    await removeLocalAudio(absolute);
  } else if (existingSource === "original") {
    try {
      const stat = await fs.stat(absolute);
      if (stat.isFile() && stat.size > 0) return { id: reading.id, skipped: "exists", file: basename };
    } catch {
      await removeLocalAudio(absolute);
    }
  } else {
    await removeLocalAudio(absolute);
  }

  if (!reading.audioUrl) return { id: reading.id, skipped: "no-official-audio" };
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  if (await tryDownloadOfficialAudio(reading.audioUrl, absolute)) {
    return { id: reading.id, source: "original", file: basename };
  }
  await removeLocalAudio(absolute);
  return { id: reading.id, skipped: "download-failed" };
}

async function main() {
  const summaries = [];
  for (const relative of await listJapanMarkdown()) {
    const markdown = await fs.readFile(path.resolve(vaultRoot, relative), "utf8");
    const brief = parseWorldLaneBrief(markdown, "japan");
    const date = String(brief.asOf).match(/20\d{2}-\d{2}-\d{2}/)?.[0]
      || path.basename(relative).match(/20\d{2}-\d{2}-\d{2}/)?.[0];
    if (!brief.readings.length || !date) continue;
    const items = [];
    for (const reading of brief.readings) items.push(await fetchOne(date, reading));
    summaries.push({ file: relative, date, items });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, summaries }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
