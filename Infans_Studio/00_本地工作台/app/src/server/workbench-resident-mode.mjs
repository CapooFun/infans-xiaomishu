import { spawn } from "node:child_process";
import { WorkbenchWriteError } from "./workbench-errors.mjs";

export const RESIDENT_MODE_COMMAND = "/usr/bin/caffeinate";
export const RESIDENT_MODE_TIMEOUT_SECONDS = 2_147_483_647;

export function residentModeArguments(parentPid = process.pid) {
  return [
    "-d",
    "-i",
    "-s",
    "-u",
    "-t",
    String(RESIDENT_MODE_TIMEOUT_SECONDS),
    "-w",
    String(parentPid),
  ];
}

export function createResidentModeService(options = {}) {
  const platform = options.platform || process.platform;
  const parentPid = options.parentPid || process.pid;
  const spawnProcess = options.spawnProcess || ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const now = options.now || (() => new Date());
  let child = null;
  let startingChild = null;
  let startPromise = null;
  let desiredEnabled = false;
  let enabledAt = null;
  let lastError = "";
  let disposed = false;
  const expectedStops = new WeakSet();

  function read() {
    const supported = platform === "darwin";
    return {
      supported,
      enabled: Boolean(child),
      enabledAt,
      error: lastError || null,
      note: !supported
        ? "常驻模式只支持运行小秘书的 Mac。"
        : child
          ? "Mac 会保持唤醒，屏幕不会因闲置自动锁定；手动锁屏仍会立即生效。"
          : "需要离开但仍要让 Codex 工作时再开启。",
    };
  }

  async function enable() {
    if (disposed) throw new WorkbenchWriteError("常驻模式服务已经停止", 503, "RESIDENT_MODE_DISPOSED");
    if (platform !== "darwin") throw new WorkbenchWriteError("常驻模式只支持运行小秘书的 Mac", 501, "RESIDENT_MODE_UNSUPPORTED");
    desiredEnabled = true;
    if (child) return read();
    if (startPromise) {
      await startPromise;
      return read();
    }

    const candidate = spawnProcess(RESIDENT_MODE_COMMAND, residentModeArguments(parentPid), {
      stdio: "ignore",
    });
    startingChild = candidate;

    startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        if (!desiredEnabled || disposed) {
          expectedStops.add(candidate);
          candidate.kill("SIGTERM");
          resolve();
          return;
        }
        child = candidate;
        enabledAt = now().toISOString();
        lastError = "";
        resolve();
      };
      const onError = (error) => {
        if (!settled) {
          settled = true;
          startingChild = null;
          reject(new WorkbenchWriteError(`常驻模式没有启动：${error instanceof Error ? error.message : "系统命令不可用"}`, 500, "RESIDENT_MODE_START_FAILED"));
          return;
        }
        if (child === candidate) {
          child = null;
          enabledAt = null;
          lastError = "常驻模式意外停止，请重新开启。";
        }
      };
      candidate.once("spawn", onSpawn);
      candidate.once("error", onError);
      candidate.once("exit", () => {
        if (!settled) {
          settled = true;
          reject(new WorkbenchWriteError("常驻模式没有启动", 500, "RESIDENT_MODE_START_FAILED"));
          return;
        }
        if (child !== candidate) return;
        child = null;
        enabledAt = null;
        if (!disposed && !expectedStops.has(candidate)) lastError = "常驻模式意外停止，请重新开启。";
      });
    });

    try {
      await startPromise;
    } finally {
      if (startingChild === candidate) startingChild = null;
      startPromise = null;
    }

    return read();
  }

  function disable() {
    desiredEnabled = false;
    const active = child;
    child = null;
    enabledAt = null;
    lastError = "";
    if (active) {
      expectedStops.add(active);
      active.kill("SIGTERM");
    }
    return read();
  }

  async function setEnabled(enabled) {
    return enabled ? enable() : disable();
  }

  function dispose() {
    disposed = true;
    disable();
  }

  return { read, setEnabled, dispose };
}
