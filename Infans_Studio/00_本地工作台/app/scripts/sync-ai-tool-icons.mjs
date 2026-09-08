import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const vaultRoot = path.resolve(appDir, "../..");
const catalogPaths = [
  path.join(vaultRoot, "85_收藏夹/AI工具库/AI工具目录.json"),
  path.join(vaultRoot, "85_收藏夹/网页收藏/网页收藏目录.json"),
];
const outputDir = path.join(appDir, "public/ai-tools/icons");
const manifestPath = path.join(outputDir, "manifest.json");
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Infans-AI-Tool-Icon-Sync/1.0";

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map((match) => [match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? match[4] ?? "")]));
}

function iconCandidates(html, pageUrl) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const ranked = links.flatMap((attrs) => {
    const rel = String(attrs.rel || "").toLowerCase();
    if (!attrs.href || !rel.includes("icon")) return [];
    const sizes = String(attrs.sizes || "");
    const size = Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/g)].map((match) => Math.min(Number(match[1]), Number(match[2]))));
    const rank = (rel.includes("apple-touch-icon") ? 3_000 : 2_000) + size + (String(attrs.type || "").includes("svg") ? 600 : 0);
    try {
      return [{ url: new URL(attrs.href, pageUrl).toString(), rank }];
    } catch {
      return [];
    }
  });
  return [...new Map(ranked.sort((a, b) => b.rank - a.rank).map((item) => [item.url, item])).values()];
}

async function fetchWithTimeout(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": USER_AGENT, Accept: options.accept || "*/*" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function officialCandidates(tool) {
  const pageUrl = new URL(tool.url);
  const candidates = [];
  try {
    const response = await fetchWithTimeout(pageUrl, { accept: "text/html,application/xhtml+xml" });
    const html = await response.text();
    candidates.push(...iconCandidates(html.slice(0, 1_500_000), response.url));
  } catch (error) {
    process.stderr.write(`page ${tool.id}: ${error.message}\n`);
  }
  candidates.push({ url: new URL("/favicon.ico", pageUrl.origin).toString(), rank: 1_000 });
  candidates.push({ url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(pageUrl.hostname)}&sz=256`, rank: 0 });
  return [...new Map(candidates.map((item) => [item.url, item])).values()];
}

async function normalizedPng(source) {
  const response = await fetchWithTimeout(source, { accept: "image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8" });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/html")) throw new Error("HTML response");
  const input = Buffer.from(await response.arrayBuffer());
  if (input.length < 64 || input.length > 8_000_000) throw new Error(`invalid size ${input.length}`);
  const image = sharp(input, { density: 384, failOn: "warning" });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error("missing dimensions");
  return image
    .resize(128, 128, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, withoutEnlargement: false })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function syncTool(tool) {
  const failures = [];
  for (const candidate of await officialCandidates(tool)) {
    try {
      const png = await normalizedPng(candidate.url);
      await fs.writeFile(path.join(outputDir, `${tool.id}.png`), png);
      return { id: tool.id, name: tool.name, sourceUrl: candidate.url, fallback: candidate.rank === 0 };
    } catch (error) {
      failures.push(`${candidate.url}: ${error.message}`);
    }
  }
  const cachedPath = path.join(outputDir, `${tool.id}.png`);
  try {
    const cached = await sharp(cachedPath).metadata();
    if (cached.width === 128 && cached.height === 128) {
      return { id: tool.id, name: tool.name, sourceUrl: `local-cache:${tool.id}.png`, fallback: true };
    }
  } catch {
    // A missing or broken cache should still fail loudly below.
  }
  throw new Error(`${tool.id}: ${failures.join(" | ")}`);
}

await fs.mkdir(outputDir, { recursive: true });
const catalogs = await Promise.all(catalogPaths.map(async (catalogPath) => JSON.parse(await fs.readFile(catalogPath, "utf8"))));
const tools = catalogs.flatMap((catalog) => [
  ...(Array.isArray(catalog.tools) ? catalog.tools : []),
  ...(Array.isArray(catalog.bookmarks) ? catalog.bookmarks : []),
]);
const entries = [];
const errors = [];

for (let index = 0; index < tools.length; index += 6) {
  const batch = await Promise.allSettled(tools.slice(index, index + 6).map(syncTool));
  for (const result of batch) {
    if (result.status === "fulfilled") entries.push(result.value);
    else errors.push(result.reason?.message || String(result.reason));
  }
  process.stdout.write(`icons ${Math.min(index + 6, tools.length)}/${tools.length}\n`);
}

entries.sort((a, b) => a.id.localeCompare(b.id));
await fs.writeFile(manifestPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  catalogCount: tools.length,
  iconCount: entries.length,
  entries,
}, null, 2)}\n`);

if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`wrote ${entries.length} local icons\n`);
}
