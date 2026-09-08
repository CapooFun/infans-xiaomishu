import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { scanWorkbenchSection, scanWorkbenchSummary } from "../src/server/workbench-data.mjs";

const cwd = process.cwd();
const dist = path.join(cwd, "dist");
const strict = process.argv.includes("--strict");
const notices = [];
const integrityFailures = [];
const manifest = JSON.parse(await fs.readFile(path.join(dist, ".vite/manifest.json"), "utf8"));
const entry = Object.entries(manifest).find(([, value]) => value.isEntry);
if (!entry) throw new Error("性能预算：未找到主入口 manifest");

const initialKeys = new Set();
function collectInitial(key) {
  if (initialKeys.has(key)) return;
  const item = manifest[key];
  if (!item) throw new Error(`性能预算：manifest 缺少 ${key}`);
  initialKeys.add(key);
  for (const imported of item.imports || []) collectInitial(imported);
}
collectInitial(entry[0]);

let initialGzip = 0;
for (const key of initialKeys) {
  const item = manifest[key];
  if (!item.file.endsWith(".js")) continue;
  initialGzip += gzipSync(await fs.readFile(path.join(dist, item.file))).byteLength;
}

const jsFiles = (await fs.readdir(path.join(dist, "assets"))).filter((name) => name.endsWith(".js"));
let largestJsChunk = 0;
for (const name of jsFiles) {
  const bytes = (await fs.stat(path.join(dist, "assets", name))).size;
  largestJsChunk = Math.max(largestJsChunk, bytes);
  if (bytes > 500 * 1024) notices.push(`${name} 为 ${bytes} B，超过 500 KB`);
}

const themeDir = path.join(cwd, "public/theme");
const avifFiles = (await fs.readdir(themeDir)).filter((name) => name.endsWith(".v1.avif"));
const themeSource = await fs.readFile(path.join(cwd, "src/workbench-theme.ts"), "utf8");
const referencedAvifs = new Set(
  [...themeSource.matchAll(/\/theme\/([^?"']+\.v1\.avif)/g)].map((match) => match[1]),
);
const missingAvifs = [...referencedAvifs].filter((name) => !avifFiles.includes(name));
if (missingAvifs.length) integrityFailures.push(`主题配置引用了不存在的 AVIF：${missingAvifs.join(", ")}`);
let avifTotal = 0;
for (const name of avifFiles) {
  const bytes = (await fs.stat(path.join(themeDir, name))).size;
  avifTotal += bytes;
  if (bytes > 250 * 1024) notices.push(`${name} 为 ${bytes} B，超过 250 KB`);
}
const jpegSceneFallbacks = (await fs.readdir(themeDir)).filter((name) =>
  (name.endsWith(".jpg") || name.endsWith(".jpeg")) && !name.startsWith("chat-")
);
if (jpegSceneFallbacks.length) notices.push(`场景仍有 JPEG fallback：${jpegSceneFallbacks.join(", ")}`);

const vaultRoot = path.resolve(cwd, "../..");
const summary = await scanWorkbenchSummary(vaultRoot);
const summaryBytes = Buffer.byteLength(JSON.stringify(summary));

// 分区预算：health 实测 ~48KB；languages 含课程进度与文法概要，仍必须远低于原 296KB。
// library 是艺术馆藏与专题知识地图的现行共用分区，包含数百个完整知识节点；后续拆按需接口前单独设预算。
// markets 仍是小分区。
const sectionBudgets = [
  ["health", 120 * 1024],
  ["languages", 160 * 1024],
  ["library", 6 * 1024 * 1024],
  ["markets", 40 * 1024],
];
const sectionSizes = [];
for (const [section, budget] of sectionBudgets) {
  const bytes = Buffer.byteLength(JSON.stringify(await scanWorkbenchSection(vaultRoot, section)));
  sectionSizes.push([section, bytes, budget]);
}

const checks = [
  ["摘要", summaryBytes, 100 * 1024],
  ["初始 JS gzip", initialGzip, 200 * 1024],
  ["AVIF 总量", avifTotal, 1.8 * 1024 * 1024],
  ...sectionSizes.map(([section, bytes, budget]) => [`分区 ${section}`, bytes, budget]),
];
for (const [label, actual, budget] of checks) {
  if (actual > budget) notices.push(`${label} ${actual} B，超过 ${Math.round(budget)} B`);
}

const sectionSummary = sectionSizes.map(([section, bytes]) => `${section} ${bytes} B`).join("；");
const measurements = `摘要 ${summaryBytes} B；初始 JS gzip ${initialGzip} B；最大 JS chunk ${largestJsChunk} B；AVIF ${avifTotal} B（配置引用 ${referencedAvifs.size} 张，目录 ${avifFiles.length} 张）；${sectionSummary}。`;
console.log(`性能预算实测：${measurements}`);
if (integrityFailures.length) {
  throw new Error(`性能资源完整性未通过（${integrityFailures.length} 项）：\n- ${integrityFailures.join("\n- ")}`);
}
if (notices.length) {
  const detail = `性能预算提醒（${notices.length} 项）：\n- ${notices.join("\n- ")}`;
  if (strict) throw new Error(`${detail}\n严格模式已启用，因此本次检查失败。`);
  console.warn(detail);
  console.log("性能预算提醒已记录：当前为观察模式，不阻断构建或版本收口。感到卡顿或主动做性能专项时，再运行 pnpm check:performance:strict。");
} else {
  console.log(`性能预算通过：全部检查均在预算内（${strict ? "严格模式" : "观察模式"}）。`);
}
