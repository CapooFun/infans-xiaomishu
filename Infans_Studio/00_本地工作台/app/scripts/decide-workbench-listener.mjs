#!/usr/bin/env node
/**
 * 启动脚本用的纯判断入口。禁止在归属不明时发信号。
 */
import { createRequire } from "node:module";
import { decideListenerAction, instanceIdFor, restartLooksRecovered } from "../src/workbench-instance.mjs";

const require = createRequire(import.meta.url);
const packageVersion = require("../package.json").version;

async function readStdinJson() {
  const chunks = [];
  if (process.stdin.isTTY) return {};
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const input = await readStdinJson();
const expectedAppDir = String(input.expectedAppDir || process.cwd());
const expectedVaultRoot = String(input.expectedVaultRoot || process.env.INFANS_VAULT_ROOT || "");
const expectedInstanceId = input.expectedInstanceId || instanceIdFor(expectedAppDir, expectedVaultRoot);

if (input.mode === "recover") {
  const recovered = restartLooksRecovered({
    health: input.health && typeof input.health === "object" ? input.health : null,
    expectedInstanceId,
    expectedVersion: input.expectedVersion || packageVersion,
    expectedVaultRoot,
    replacementPid: input.replacementPid || "",
    previousPid: input.previousPid || "",
  });
  process.stdout.write(`${JSON.stringify({ recovered })}\n`);
} else {
  const result = decideListenerAction({
    health: input.health && typeof input.health === "object" ? input.health : null,
    listenerCommand: input.listenerCommand || "",
    listenerCwd: input.listenerCwd || "",
    expectedAppDir,
    expectedVersion: input.expectedVersion || packageVersion,
    expectedInstanceId,
    expectedVaultRoot,
    serverStale: Boolean(input.serverStale),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
