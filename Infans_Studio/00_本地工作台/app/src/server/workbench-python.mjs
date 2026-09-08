import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const EXTRA_PATH_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/Library/Frameworks/Python.framework/Versions/Current/bin",
  "/Library/Frameworks/Python.framework/Versions/3.12/bin",
  "/Library/Frameworks/Python.framework/Versions/3.11/bin",
  "/Library/Frameworks/Python.framework/Versions/3.10/bin",
  "/Library/Frameworks/Python.framework/Versions/3.9/bin",
  "/Library/Frameworks/Python.framework/Versions/3.8/bin",
  "/Library/Frameworks/Python.framework/Versions/3.7/bin",
];

/** @type {string | null | undefined} */
let cachedPython;

/**
 * 工作台可能从受限 PATH 启动（例如只剩 /usr/bin）。
 * 读 Excel 时补上本机常见 Python 路径，并保证 HOME 在，方便 --user 安装包。
 */
export function pythonEnv(baseEnv = process.env) {
  const parts = new Set();
  for (const dir of EXTRA_PATH_DIRS) parts.add(dir);
  for (const dir of String(baseEnv.PATH || "").split(":")) {
    if (dir) parts.add(dir);
  }
  return {
    ...baseEnv,
    PATH: [...parts].join(":"),
    HOME: baseEnv.HOME || os.homedir(),
  };
}

async function probePython(candidate, env) {
  const { stdout } = await execFileAsync(candidate, ["-c", "import sys; print(sys.executable)"], {
    env,
    timeout: 8_000,
    maxBuffer: 64 * 1024,
  });
  const resolved = String(stdout || "").trim();
  if (!resolved) throw new Error("empty python executable");
  return resolved;
}

/** 找到可用的 python3；结果会缓存。 */
export async function resolvePython3() {
  if (cachedPython !== undefined) return cachedPython;
  const env = pythonEnv();
  const candidates = [
    process.env.INFANS_PYTHON,
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
    "python3",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      cachedPython = await probePython(candidate, env);
      return cachedPython;
    } catch {
      // try next
    }
  }
  cachedPython = null;
  return null;
}

export function resetPythonCache() {
  cachedPython = undefined;
}

/** 把 Python Traceback 收成一句话。 */
export function humanizePythonError(error, options = {}) {
  const task = options.task || "跑 Python";
  const text = [
    error?.stderr,
    error?.stdout,
    error?.message,
    typeof error === "string" ? error : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (/No module named ['"]?openpyxl['"]?/i.test(text)) {
    return `读 Excel 需要 openpyxl，本机 Python 还没装上。可在终端执行：python3 -m pip install --user openpyxl`;
  }
  if (/ModuleNotFoundError|ImportError/i.test(text)) {
    const match = text.match(/No module named ['"]?([^'"\s]+)['"]?/i);
    return match
      ? `${task}失败：缺少 Python 库 ${match[1]}。`
      : `${task}失败：本机 Python 缺库。`;
  }
  if (/ENOENT|not found|找不到 python/i.test(text) || error?.code === "ENOENT") {
    return `${task}失败：本机找不到 python3。`;
  }
  const firstUseful =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("Traceback") && !line.startsWith("File ") && !line.startsWith("  ")) ||
    text.trim();
  const short = firstUseful.slice(0, 180);
  return short ? `${task}失败：${short}` : `${task}失败。`;
}

/**
 * 用本机 python3 跑一段 -c 脚本；默认期望 stdout 是 JSON。
 * @param {string} script
 * @param {string[]} [args]
 * @param {{ maxBuffer?: number, timeout?: number, env?: NodeJS.ProcessEnv, parseJson?: boolean, task?: string }} [options]
 */
export async function runPythonScript(script, args = [], options = {}) {
  const python = await resolvePython3();
  if (!python) {
    throw new Error(humanizePythonError(new Error("找不到 python3"), { task: options.task }));
  }

  try {
    const { stdout, stderr } = await execFileAsync(python, ["-c", script, ...args], {
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      timeout: options.timeout,
      env: pythonEnv(options.env || process.env),
    });
    if (stderr && /Error|Traceback/i.test(stderr) && !String(stdout || "").trim()) {
      throw Object.assign(new Error(stderr), { stderr, stdout });
    }
    if (options.parseJson === false) {
      return { stdout, stderr, python };
    }
    const text = String(stdout || "").trim();
    if (!text) {
      throw Object.assign(new Error(stderr || "Python 没有输出"), { stderr, stdout });
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${options.task || "跑 Python"}失败：返回内容不是合法 JSON。`);
    }
    throw new Error(humanizePythonError(error, { task: options.task }));
  }
}

/** 读 xlsx 用的 openpyxl 引导段：没有就 pip --user 装一次。 */
export const OPENPYXL_BOOTSTRAP = `
import sys
try:
    import openpyxl
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "-q", "--user"])
    import openpyxl
`;
