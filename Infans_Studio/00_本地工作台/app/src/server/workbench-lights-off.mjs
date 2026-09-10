import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIGHTS_OFF_HELPER_PATH, LIGHTS_OFF_STATE_PATH } from "./vault-paths.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";

export const LIGHTS_OFF_HELPER_SOURCE = fileURLToPath(new URL("../../native/lights-off-helper.swift", import.meta.url));
export const LIGHTS_OFF_SWIFTC = "/usr/bin/swiftc";
export const LIGHTS_OFF_SWIFTC_ARGS = Object.freeze([
  "-O",
  "-parse-as-library",
  "-framework",
  "AppKit",
  "-framework",
  "CoreGraphics",
]);
export const LIGHTS_OFF_NOTE_OFF = "副屏切掉，Mac 只留一点光。";
export const LIGHTS_OFF_NOTE_ON = "副屏已切掉，Mac 只留一点光。再按一次或点按钮恢复。";

function resolvePath(root, relativePath) {
  return path.resolve(root, relativePath);
}

export const LIGHTS_OFF_TOGGLE_KEY_CODE = 53;
export const LIGHTS_OFF_TOGGLE_MODIFIERS = 1 << 20;
export const LIGHTS_OFF_ORIGINAL_BRIGHTNESS_MIN = 0.12;

export function lightsOffHelperArguments(command, statePath) {
  return [command, statePath];
}

function rememberedOriginal(existing) {
  const brightness = Number(existing?.builtinBrightness);
  const displayID = Number(existing?.builtinDisplayID);
  if (!(brightness > LIGHTS_OFF_ORIGINAL_BRIGHTNESS_MIN) || !Number.isFinite(displayID)) return {};
  return { builtinBrightness: brightness, builtinDisplayID: displayID };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLightsOffService(options = {}) {
  const platform = options.platform || process.platform;
  const root = options.root || "";
  const spawnProcess = options.spawnProcess || ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  const compileHelper = options.compileHelper;
  const now = options.now || (() => new Date());
  const readToggleChord = options.readToggleChord;
  const helperSource = options.helperSource || LIGHTS_OFF_HELPER_SOURCE;
  const helperPath = options.helperPath || resolvePath(root, LIGHTS_OFF_HELPER_PATH);
  const statePath = options.statePath || resolvePath(root, LIGHTS_OFF_STATE_PATH);
  const shouldReapHelpers = options.reapHelpers ?? !compileHelper;
  let child = null;
  let startingChild = null;
  let startPromise = null;
  let desiredEnabled = false;
  let enabledAt = null;
  let lastError = "";
  let disposed = false;
  const expectedStops = new WeakSet();

  function note() {
    if (platform !== "darwin") return "关灯模式只支持运行小秘书的 Mac。";
    if (child) return LIGHTS_OFF_NOTE_ON;
    return lastError || LIGHTS_OFF_NOTE_OFF;
  }

  function read() {
    return {
      supported: platform === "darwin",
      enabled: Boolean(child),
      enabledAt,
      error: lastError || null,
      note: note(),
    };
  }

  async function ensureHelper() {
    if (compileHelper) {
      await compileHelper();
      return helperPath;
    }
    await fs.mkdir(path.dirname(helperPath), { recursive: true });
    let sourceStat;
    let helperStat;
    try {
      sourceStat = await fs.stat(helperSource);
    } catch (error) {
      throw new WorkbenchWriteError("关灯程序源码找不到", 500, "LIGHTS_OFF_HELPER_MISSING");
    }
    try {
      helperStat = await fs.stat(helperPath);
      if (helperStat.mtimeMs >= sourceStat.mtimeMs && helperStat.size > 0) return helperPath;
    } catch {
      helperStat = null;
    }
    await new Promise((resolve, reject) => {
      const compiler = spawnProcess(LIGHTS_OFF_SWIFTC, [
        ...LIGHTS_OFF_SWIFTC_ARGS,
        "-o",
        helperPath,
        helperSource,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const errors = [];
      compiler.stderr?.on("data", (chunk) => errors.push(chunk));
      compiler.once("error", (error) => {
        reject(new WorkbenchWriteError(`关灯程序没有编译成功：${error.message}`, 500, "LIGHTS_OFF_COMPILE_FAILED"));
      });
      compiler.once("close", (code) => {
        if (code === 0) return resolve();
        const stderr = Buffer.concat(errors).toString("utf8").trim();
        reject(new WorkbenchWriteError(stderr || "关灯程序没有编译成功", 500, "LIGHTS_OFF_COMPILE_FAILED"));
      });
    });
    return helperPath;
  }

  async function writeToggleChord() {
    let existing = {};
    try {
      existing = JSON.parse(await fs.readFile(statePath, "utf8"));
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) existing = {};
    } catch {
      existing = {};
    }
    const chord = readToggleChord ? await readToggleChord() : null;
    const toggleKeyCode = Number.isInteger(chord?.keyCode) ? chord.keyCode : LIGHTS_OFF_TOGGLE_KEY_CODE;
    const toggleModifiers = Number.isInteger(chord?.modifiers) ? chord.modifiers : LIGHTS_OFF_TOGGLE_MODIFIERS;
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({
      ...rememberedOriginal(existing),
      schemaVersion: 1,
      applied: false,
      toggleKeyCode,
      toggleModifiers,
    }));
  }

  async function listHelperPids() {
    if (options.listHelperPids) return options.listHelperPids();
    if (!shouldReapHelpers) return [];
    return await new Promise((resolve) => {
      execFile("pgrep", ["-f", helperPath], { timeout: 1000 }, (error, stdout) => {
        if (error || !stdout) return resolve([]);
        resolve([...new Set(String(stdout).split(/\s+/).map((value) => Number(value)).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))]);
      });
    });
  }

  async function reapRunningHelpers(signal) {
    const pids = await listHelperPids();
    for (const pid of pids) {
      try { process.kill(pid, signal); } catch {}
    }
    return pids;
  }

  async function restoreFromState() {
    try {
      const helper = await ensureHelper();
      await new Promise((resolve) => {
        const restorer = spawnProcess(helper, lightsOffHelperArguments("off", statePath), { stdio: "ignore" });
        if (typeof restorer.exitCode === "number") return resolve();
        const timer = setTimeout(resolve, 2000);
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        restorer.once("error", finish);
        restorer.once("exit", finish);
        restorer.once("close", finish);
      });
    } catch {
      // 恢复失败时仍把开关视为已关闭，避免界面卡在关灯。
    }
  }

  async function enable() {
    if (disposed) throw new WorkbenchWriteError("关灯模式服务已经停止", 503, "LIGHTS_OFF_DISPOSED");
    if (platform !== "darwin") throw new WorkbenchWriteError("关灯模式只支持运行小秘书的 Mac", 501, "LIGHTS_OFF_UNSUPPORTED");
    desiredEnabled = true;
    if (child) return read();
    if (startPromise) {
      await startPromise;
      return read();
    }

    const helper = await ensureHelper();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    if (shouldReapHelpers) {
      await reapRunningHelpers("SIGTERM");
      await wait(400);
      await reapRunningHelpers("SIGKILL");
    }
    await writeToggleChord();
    const candidate = spawnProcess(helper, lightsOffHelperArguments("on", statePath), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    startingChild = candidate;

    startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const chunks = [];
      const errors = [];
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        startingChild = null;
        reject(new WorkbenchWriteError(message, 500, "LIGHTS_OFF_START_FAILED"));
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
      const timer = setTimeout(() => fail("关灯模式启动超时"), 8000);
      candidate.stdout?.on("data", (chunk) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).toString("utf8").includes("ready")) succeed();
      });
      candidate.stderr?.on("data", (chunk) => errors.push(chunk));
      candidate.once("spawn", () => {
        if (settled) return;
      });
      candidate.once("error", (error) => {
        fail(`关灯模式没有启动：${error instanceof Error ? error.message : "系统命令不可用"}`);
      });
      candidate.once("exit", () => {
        if (!settled) {
          const stderr = Buffer.concat(errors).toString("utf8").trim();
          fail(stderr || "关灯模式没有启动");
          return;
        }
        if (child !== candidate) return;
        child = null;
        enabledAt = null;
        if (!disposed && !expectedStops.has(candidate)) {
          lastError = "";
          void restoreFromState();
        }
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

  async function disable() {
    desiredEnabled = false;
    const active = child;
    child = null;
    enabledAt = null;
    lastError = "";
    if (active) {
      expectedStops.add(active);
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          resolve();
        };
        const termTimer = setTimeout(() => {
          try { active.kill("SIGKILL"); } catch {}
        }, 2500);
        const killTimer = setTimeout(finish, 3200);
        active.once("exit", finish);
        active.kill("SIGTERM");
      });
    }
    if (shouldReapHelpers) {
      await reapRunningHelpers("SIGTERM");
      await wait(400);
      await reapRunningHelpers("SIGKILL");
    }
    await restoreFromState();
    return read();
  }

  async function toggle() {
    return child ? disable() : enable();
  }

  async function setEnabled(enabled) {
    return enabled ? enable() : disable();
  }

  function dispose() {
    disposed = true;
    void disable();
  }

  return { read, setEnabled, toggle, dispose };
}
