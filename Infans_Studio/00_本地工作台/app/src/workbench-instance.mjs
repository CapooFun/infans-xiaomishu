import crypto from "node:crypto";
import path from "node:path";

export const DEFAULT_WORKBENCH_PORT = 5173;

export function parseListenPort(env = process.env) {
  const raw = env.INFANS_PORT;
  if (raw == null || String(raw).trim() === "") {
    return { port: DEFAULT_WORKBENCH_PORT, raw: String(DEFAULT_WORKBENCH_PORT) };
  }
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`INFANS_PORT 不合法：${text}`);
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`INFANS_PORT 不合法：${text}`);
  }
  return { port: value, raw: text };
}

export function resolveListenPort(env = process.env) {
  return parseListenPort(env).port;
}

export function instanceIdFor(appDir, vaultRoot = "") {
  const app = path.resolve(appDir || ".");
  const vault = vaultRoot ? path.resolve(vaultRoot) : "";
  return crypto.createHash("sha256").update(`${app}\0${vault}`).digest("hex").slice(0, 16);
}

export function sameDirectory(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

/**
 * 决定启动脚本对已有监听进程做什么。禁止在归属不明时发信号。
 */
export function decideListenerAction({
  health = null,
  listenerCommand = "",
  listenerCwd = "",
  expectedAppDir,
  expectedVersion,
  expectedInstanceId,
  expectedVaultRoot = "",
  serverStale = false,
} = {}) {
  const command = String(listenerCommand || "");
  const looksLikeServe = command.includes("node src/server/serve.mjs") || command.includes("serve.mjs");
  if (!health || health.ok !== true) {
    return { action: "conflict", reason: "unknown-listener", signal: null };
  }
  if (health.instanceId && health.instanceId !== expectedInstanceId) {
    return { action: "conflict", reason: "other-instance", signal: null };
  }
  if (health.vaultRoot && expectedVaultRoot && !sameDirectory(health.vaultRoot, expectedVaultRoot)) {
    return { action: "conflict", reason: "other-data-root", signal: null };
  }
  if (listenerCwd && !sameDirectory(listenerCwd, expectedAppDir)) {
    return { action: "conflict", reason: "other-root", signal: null };
  }
  if (!looksLikeServe) {
    return { action: "conflict", reason: "foreign-command", signal: null };
  }
  if (health.version === expectedVersion && health.instanceId === expectedInstanceId && !serverStale) {
    return { action: "already-running", reason: "same-instance", signal: null };
  }
  if (health.instanceId === expectedInstanceId && sameDirectory(listenerCwd, expectedAppDir)) {
    return { action: "restart-self", reason: "same-instance-stale", signal: "TERM" };
  }
  return { action: "conflict", reason: "untrusted", signal: null };
}

export function restartLooksRecovered({
  health = null,
  expectedInstanceId,
  expectedVersion,
  expectedVaultRoot = "",
  replacementPid,
  previousPid,
} = {}) {
  if (!health || health.ok !== true) return false;
  if (!replacementPid || String(replacementPid) === String(previousPid || "")) return false;
  if (health.version !== expectedVersion) return false;
  if (health.instanceId !== expectedInstanceId) return false;
  if (expectedVaultRoot && health.vaultRoot && !sameDirectory(health.vaultRoot, expectedVaultRoot)) return false;
  return true;
}

export function workbenchBaseUrl(port = DEFAULT_WORKBENCH_PORT, host = "127.0.0.1") {
  return `http://${host}:${Number(port) || DEFAULT_WORKBENCH_PORT}`;
}
