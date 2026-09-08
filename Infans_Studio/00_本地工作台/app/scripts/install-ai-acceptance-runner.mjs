#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_VAULT_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const LABEL = "com.capoo.infans-ai-acceptance-runner";
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_ARCHIVE_COUNT = 5;

function parseArgs(argv) {
  const result = { workspace: DEFAULT_VAULT_ROOT, dryRun: false, reuseThread: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") { result.dryRun = true; continue; }
    if (arg === "--reuse-thread") { result.reuseThread = true; continue; }
    if (!new Set(["--workspace", "--thread"]).has(arg)) throw new Error(`未知参数：${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
    index += 1;
    result[arg.slice(2)] = value;
  }
  if (result.thread && result.reuseThread) throw new Error("--thread 与 --reuse-thread 不能同时使用");
  if (result.thread && !/^[0-9a-f-]{36}$/u.test(String(result.thread))) throw new Error("--thread 不是有效的 Codex 任务 ID");
  result.workspace = path.resolve(result.workspace);
  return result;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} ${args.join(" ")} 失败：${String(result.stderr || result.stdout).trim()}`);
  return result;
}

export function buildRunnerWrapper({ nodePath, dispatcherPath, workspace, logPath }) {
  return `#!/bin/bash
set -euo pipefail
umask 077

log_path=${shellQuote(logPath)}
max_log_bytes=${LOG_MAX_BYTES}
max_log_archives=${LOG_ARCHIVE_COUNT}

if [[ -L "$log_path" ]]; then
  exit 73
fi

current_log_bytes=0
if [[ -f "$log_path" ]]; then
  current_log_bytes="$(/usr/bin/wc -c < "$log_path" | /usr/bin/tr -d '[:space:]')"
fi

if [[ "$current_log_bytes" =~ ^[0-9]+$ ]] && (( current_log_bytes >= max_log_bytes )); then
  /bin/rm -f -- "$log_path.${LOG_ARCHIVE_COUNT}"
  for ((index=max_log_archives; index>=2; index--)); do
    previous_log="$log_path.$((index-1))"
    archived_log="$log_path.$index"
    if [[ -f "$previous_log" && ! -L "$previous_log" ]]; then
      /bin/mv -f -- "$previous_log" "$archived_log"
    fi
  done
  /bin/mv -f -- "$log_path" "$log_path.1"
  : > "$log_path"
fi

/usr/bin/touch "$log_path"
/bin/chmod 600 "$log_path"
exec ${shellQuote(nodePath)} ${shellQuote(dispatcherPath)} --workspace ${shellQuote(workspace)} >> "$log_path" 2>&1
`;
}

export async function ensurePrivateDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`私有目录不是安全的真实目录：${directoryPath}`);
  await fs.chmod(directoryPath, 0o700);
}

export async function ensurePrivateLog(logPath) {
  try {
    const stat = await fs.lstat(logPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`日志不是安全的普通文件：${logPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const handle = await fs.open(logPath, "a", 0o600);
  await handle.close();
  await fs.chmod(logPath, 0o600);
}

export function buildRunnerConfig({ codexPath, now = new Date() }) {
  if (!codexPath || !path.isAbsolute(codexPath)) throw new Error("Codex 本机入口必须是绝对路径");
  return {
    schemaVersion: 3,
    executorId: "agent-task-readonly-verifier",
    executorRoleId: "agent-task-readonly-verifier",
    platform: "codex-app",
    dispatchMode: "codex-exec-ephemeral-json",
    codexPath,
    leaseMs: 70 * 60_000,
    maxAttempts: 3,
    retryCooldownMs: 30 * 60_000,
    updatedAt: now.toISOString(),
  };
}

export function legacyThreadBindingNotice(options = {}) {
  return options.thread || options.reuseThread
    ? "提示：--thread / --reuse-thread 仅为旧命令兼容保留；schemaVersion 3 不再绑定长期任务窗口。"
    : null;
}

export async function install(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const userHomeDir = os.homedir();
  const nodePath = process.execPath;
  const codexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const dispatcherPath = path.join(options.workspace, "00_本地工作台/app/scripts/ai-acceptance-dispatcher.mjs");
  await Promise.all([fs.access(nodePath), fs.access(codexPath), fs.access(dispatcherPath)]);

  const localBinDir = path.join(userHomeDir, ".local/bin");
  const localStateDir = path.join(userHomeDir, "Library/Application Support/Infans");
  const logDir = path.join(userHomeDir, "Library/Logs/Infans");
  const launchAgentDir = path.join(userHomeDir, "Library/LaunchAgents");
  const wrapperPath = path.join(localBinDir, "infans_ai_acceptance_runner.sh");
  const configPath = path.join(localStateDir, "ai-acceptance-runner.json");
  const plistPath = path.join(launchAgentDir, `${LABEL}.plist`);
  const logPath = path.join(logDir, "ai-acceptance-runner.log");
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ label: LABEL, intervalSeconds: 300, nodePath, wrapperPath, configPath, plistPath, schemaVersion: 3, dispatchMode: "codex-exec-ephemeral-json", legacyThreadBindingIgnored: Boolean(options.thread || options.reuseThread) })}\n`);
    return 0;
  }
  const legacyNotice = legacyThreadBindingNotice(options);
  if (legacyNotice) process.stderr.write(`${legacyNotice}\n`);

  await Promise.all([
    fs.mkdir(localBinDir, { recursive: true }),
    ensurePrivateDirectory(localStateDir),
    ensurePrivateDirectory(logDir),
    fs.mkdir(launchAgentDir, { recursive: true }),
  ]);
  await ensurePrivateLog(logPath);
  const wrapper = buildRunnerWrapper({ nodePath, dispatcherPath, workspace: options.workspace, logPath });
  const config = buildRunnerConfig({ codexPath });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(wrapperPath)}</string></array>
  <key>WorkingDirectory</key><string>${xmlEscape(options.workspace)}</string>
  <key>StartInterval</key><integer>300</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
  await fs.writeFile(wrapperPath, wrapper, { mode: 0o700 });
  await fs.chmod(wrapperPath, 0o700);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  await fs.writeFile(plistPath, plist, { mode: 0o644 });

  runCommand("plutil", ["-lint", plistPath]);
  const domain = `gui/${process.getuid()}`;
  runCommand("launchctl", ["bootout", domain, plistPath], { allowFailure: true });
  runCommand("launchctl", ["bootstrap", domain, plistPath]);
  runCommand("launchctl", ["enable", `${domain}/${LABEL}`]);
  const status = runCommand("launchctl", ["print", `${domain}/${LABEL}`]);
  if (!status.stdout.includes("state =") || !status.stdout.includes("run interval = 300 seconds")) {
    throw new Error("自动验收 LaunchAgent 已加载，但没有读到 5 分钟调度证据");
  }
  process.stdout.write(`AI 自动验收已启用：${LABEL}，每 5 分钟轻量扫描，只在有合格任务时创建临时 Codex 执行回合。\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`AI 自动验收安装失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
