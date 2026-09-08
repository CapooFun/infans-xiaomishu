#!/usr/bin/env node
/**
 * 为 dist 里的文本产物预生成 .br / .gz。
 *
 * 静态层只做「文件存在就发」的协商，不在请求路径上现场压缩，
 * 首屏因此既省带宽又不吃 CPU。构建期一次性完成，成本不进运行时。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";
import { COMPRESSIBLE } from "../src/server/workbench-static.mjs";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const defaultDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const distDir = path.resolve(process.env.INFANS_DIST_DIR || defaultDistDir);
const MIN_BYTES = 1024;

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(absolute);
    else if (entry.isFile()) yield absolute;
  }
}

const results = [];
for await (const file of walk(distDir)) {
  const extension = path.extname(file).toLowerCase();
  if (!COMPRESSIBLE.has(extension)) continue;
  const raw = await fs.readFile(file);
  if (raw.length < MIN_BYTES) continue;

  const [brotli, gzipped] = await Promise.all([
    brotliAsync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
    gzipAsync(raw, { level: 9 }),
  ]);

  // 压不动就不留文件，免得静态层发出比原文更大的响应。
  if (brotli.length < raw.length) await fs.writeFile(`${file}.br`, brotli); else await fs.rm(`${file}.br`, { force: true });
  if (gzipped.length < raw.length) await fs.writeFile(`${file}.gz`, gzipped); else await fs.rm(`${file}.gz`, { force: true });

  results.push({ name: path.relative(distDir, file), raw: raw.length, brotli: brotli.length });
}

const rawTotal = results.reduce((sum, item) => sum + item.raw, 0);
const brotliTotal = results.reduce((sum, item) => sum + item.brotli, 0);
console.log(`预压缩 ${results.length} 个文件：${(rawTotal / 1024).toFixed(0)} KB → br ${(brotliTotal / 1024).toFixed(0)} KB`);
for (const item of results.sort((a, b) => b.brotli - a.brotli).slice(0, 5)) {
  console.log(`  ${item.name}  ${(item.raw / 1024).toFixed(0)} KB → ${(item.brotli / 1024).toFixed(0)} KB`);
}
