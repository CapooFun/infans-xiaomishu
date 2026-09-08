#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseWorldLaneBrief } from "../src/server/workbench-world-brief.mjs";

const MIN_EVENTS = Object.freeze({
  ai: 4,
  games: 4,
  japan: 5,
});

const LABELS = Object.freeze({
  ai: "AI",
  games: "游戏",
  japan: "日本",
});

const HEADLINE_PROCESS_TALK = /昨天.{0,24}仍有效|留下来凑满|凑满\d+[条篇]|官方页还在/;

function rawBriefHeadline(markdown) {
  try {
    const raw = String(markdown).match(/<!-- INFANS_WORLD_BRIEF_JSON_START -->\s*```json\s*([\s\S]*?)\s*```/)?.[1];
    return String(JSON.parse(raw || "{}").headline || "");
  } catch {
    return "";
  }
}

function defaultBriefPath(lane) {
  const names = { ai: "AI", games: "游戏", japan: "日本" };
  return path.resolve(import.meta.dirname, `../../20_记录/世界资讯/${names[lane]}/当前.md`);
}

export async function inspectWorldBriefCounts(paths = {}) {
  const result = {};
  for (const lane of Object.keys(MIN_EVENTS)) {
    const filePath = paths[lane] || defaultBriefPath(lane);
    const markdown = await fs.readFile(filePath, "utf8");
    if (!markdown.includes("INFANS_WORLD_BRIEF_JSON_START")) {
      const error = new Error(`${LABELS[lane]}栏缺少嵌入 JSON`);
      error.exitCode = 3;
      throw error;
    }
    const brief = parseWorldLaneBrief(markdown, lane);
    const headline = rawBriefHeadline(markdown);
    if (HEADLINE_PROCESS_TALK.test(headline)) {
      const error = new Error(`${LABELS[lane]}栏头条写成了写稿过程，不要写「昨天仍有效」「凑满几条」这类话`);
      error.exitCode = 4;
      throw error;
    }
    result[lane] = {
      path: filePath,
      count: brief.events.length,
      min: MIN_EVENTS[lane],
      status: brief.status,
    };
  }
  return result;
}

async function main() {
  const paths = {
    ai: process.argv[2],
    games: process.argv[3],
    japan: process.argv[4],
  };
  try {
    const counts = await inspectWorldBriefCounts(paths);
    const short = Object.entries(counts).filter(([, item]) => item.count < item.min);
    if (short.length) {
      const detail = short.map(([lane, item]) => `${LABELS[lane]} ${item.count}/${item.min}`).join("，");
      process.stderr.write(`世界资讯条数不够：${detail}。不够格才允许少写，须在运行包写清打开过的官网。\n`);
      process.exit(4);
    }
    process.stdout.write(`通过：AI ${counts.ai.count} · 游戏 ${counts.games.count} · 日本 ${counts.japan.count}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(Number(error?.exitCode) || 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
