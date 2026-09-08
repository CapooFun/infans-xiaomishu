#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkbenchGovernance } from "../src/server/workbench-governance.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultRoot = path.resolve(appDir, "../..");
const snapshot = await readWorkbenchGovernance(vaultRoot);
const forbiddenRootEntries = ["docs", "tmp", "派生数据"];
const unexpectedRootEntries = [];

for (const name of forbiddenRootEntries) {
  try {
    await fs.lstat(path.join(vaultRoot, name));
    unexpectedRootEntries.push(name);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const issueCount = snapshot.summary.issues + unexpectedRootEntries.length;
console.log(`治理登记：${snapshot.summary.documents} 项 · ${issueCount} 项异常`);
for (const item of snapshot.issues) console.error(`[${item.code}] ${item.message}`);
for (const name of unexpectedRootEntries) {
  console.error(`[VAULT_ROOT_ENTRY_FORBIDDEN] Vault 一级目录不允许出现 ${name}；请把内容放回所属模块。`);
}
if (issueCount) process.exitCode = 1;
