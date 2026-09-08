#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const mode = args[0] || "gate";
const root = path.resolve(args[args.indexOf("--vault") + 1] || process.env.INFANS_VAULT_ROOT || path.join(import.meta.dirname, "../../.."));
const force = process.env.INFANS_AI_TOOLS_QUARTERLY_FORCE === "1";
const usagePath = path.join(root, "00_本地工作台", "派生数据", "ai-tool-usage.json");
const reportDir = path.join(root, "85_收藏夹", "AI工具库", "季度报告");

function tokyoParts(now = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function previousQuarter(now = new Date()) {
  const { year, month } = tokyoParts(now);
  const current = Math.floor((month - 1) / 3) + 1;
  return current === 1 ? `${year - 1}-Q4` : `${year}-Q${current - 1}`;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function reportIsComplete(file, period) {
  let body;
  try { body = fs.readFileSync(file, "utf8"); } catch { return false; }
  return /^---\n[\s\S]*?^reportStatus:\s*complete\s*$[\s\S]*?^period:\s*['\"]?[^\n'\"]+['\"]?\s*$[\s\S]*?^---\s*$/m.test(body)
    && body.includes(`period: ${period}`)
    && /^generatedAt:\s*\S+/m.test(body)
    && /^title:\s*\S+/m.test(body)
    && /^summary:\s*\S+/m.test(body)
    && /^## 本季要看\s*$/m.test(body);
}

const period = previousQuarter();
const reportPath = path.join(reportDir, `${period}.md`);

if (mode === "target") {
  process.stdout.write(`${period}\n`);
  process.exit(0);
}

if (mode === "verify") {
  if (!reportIsComplete(reportPath, period)) {
    process.stderr.write(`季度报告未完整写入：${reportPath}\n`);
    process.exit(21);
  }
  process.stdout.write(`已核验 ${period} 季度报告\n`);
  process.exit(0);
}

const usage = readJson(usagePath);
const usedIds = Object.entries(usage?.tools || {}).filter(([, value]) => value?.everUsed).map(([id]) => id);
if (!usedIds.length) {
  process.stdout.write("没有已用过的 AI 工具，本季不调用模型\n");
  process.exit(20);
}
if (!force && reportIsComplete(reportPath, period)) {
  process.stdout.write(`${period} 报告已存在，不重复调用模型\n`);
  process.exit(20);
}
process.stdout.write(JSON.stringify({ period, reportPath, usedIds }));

