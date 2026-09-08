#!/usr/bin/env node
import process from "node:process";
import { readAppleHealthSourceReadiness } from "../src/server/workbench-health-readiness.mjs";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const vaultRoot = argValue("--vault");
const todayKey = argValue("--today");

if (!vaultRoot || !todayKey) {
  console.error("用法：check-health-source-readiness.mjs --vault <Vault> --today YYYY-MM-DD");
  process.exit(2);
}

try {
  const result = await readAppleHealthSourceReadiness(vaultRoot, todayKey);
  console.log(result.detail);
  process.exit(result.ready ? 0 : 20);
} catch (error) {
  console.error(`健康原料检查失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
