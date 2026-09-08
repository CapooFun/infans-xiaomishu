#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSteamLive } from "../src/server/workbench-steam.mjs";

export function toHealthSteamEvidence(live) {
  const games = Array.isArray(live?.games) ? live.games : [];
  return {
    schemaVersion: 1,
    source: "steam-live",
    availability: live?.available ? "available" : "unavailable",
    coverage: "rolling-2-weeks",
    dailyPrecision: false,
    refreshedAt: live?.refreshedAt ?? null,
    playing: live?.playing?.name ? { name: String(live.playing.name).slice(0, 160) } : null,
    gameCount: Number(live?.gameCount) || 0,
    hours2weeks: Number(live?.hours2weeks) || 0,
    games: games.slice(0, 20).map((game) => ({
      name: String(game?.name || "未知游戏").slice(0, 160),
      hours2weeks: Number(game?.hours2weeks) || 0,
      hoursForever: Number(game?.hoursForever) || 0,
    })),
    message: live?.available ? null : String(live?.message || "Steam 近两周暂不可用").slice(0, 240),
    privacy: "输出不含 Steam Web API key、SteamID、账号资料或请求网址。",
    caveat: "近两周是滚动聚合，不提供逐日时长，也不覆盖 NS、PS、手机或非 Steam 游戏；正在运行或拥有游戏不等于本人正在享受。",
  };
}

function parseVaultRoot(argv) {
  const index = argv.indexOf("--vault-root");
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1]);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function main(argv = process.argv.slice(2)) {
  const vaultRoot = parseVaultRoot(argv);
  const live = await readSteamLive(vaultRoot, { force: argv.includes("--force") });
  process.stdout.write(`${JSON.stringify(toHealthSteamEvidence(live), null, argv.includes("--pretty") ? 2 : 0)}\n`);
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
