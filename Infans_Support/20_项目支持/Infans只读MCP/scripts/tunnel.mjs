#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  buildTunnelInvocation,
} from "../src/tunnel-command.mjs";

const execFileAsync = promisify(execFile);
const action = process.argv[2];
const tunnelId = process.argv[3];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let runtimeKey;
try {
  const result = await execFileAsync("/usr/bin/security", [
    "find-generic-password",
    "-w",
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
  ]);
  runtimeKey = result.stdout.trim();
} catch {
  console.error(`未找到 macOS 通用钥匙串条目：服务 ${KEYCHAIN_SERVICE}，账号 ${KEYCHAIN_ACCOUNT}。请先由本人写入 Tunnel Runtime API Key。`);
  process.exit(2);
}

if (!runtimeKey) {
  console.error("钥匙串中的 Tunnel Runtime API Key 为空。");
  process.exit(2);
}

const invocation = buildTunnelInvocation(action, { projectRoot, tunnelId });
const child = spawn(invocation.command, invocation.args, {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, CONTROL_PLANE_API_KEY: runtimeKey },
});
child.on("error", (error) => {
  console.error(`无法启动 tunnel-client：${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
});
