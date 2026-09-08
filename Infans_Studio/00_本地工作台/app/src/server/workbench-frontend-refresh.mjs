import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const FRONTEND_FILES = ["index.html", "vite.config.ts", "package.json", "pnpm-lock.yaml", "scripts/precompress.mjs", "scripts/check-theme-contract.mjs", "scripts/theme-legacy-exceptions.json"];
const FRONTEND_DIRECTORIES = ["public"];
export const FRONTEND_HANDOFF_MARKER = "__infans_frontend";
export const FRONTEND_BUILD_META_NAME = "infans-frontend-build";

function pathnameOf(url) {
  return String(url ?? "/").split("?")[0].split("#")[0];
}

/** 只让真正的页面刷新触发检查，静态资源和 API 请求不进入构建路径。 */
export function isWorkbenchNavigationRequest(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const pathname = pathnameOf(request.url);
  if (pathname.startsWith("/api/") || path.extname(pathname)) return false;
  return String(request.headers?.accept ?? "").toLowerCase().includes("text/html");
}

async function newestFileMtime(absolute, options = {}) {
  let stat;
  try { stat = await fs.stat(absolute); } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return 0;

  let newest = 0;
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    if (options.exclude?.has(entry.name)) continue;
    const candidate = await newestFileMtime(path.join(absolute, entry.name));
    if (candidate > newest) newest = candidate;
  }
  return newest;
}

export async function frontendSourceMtime(appDir) {
  const candidates = await Promise.all([
    newestFileMtime(path.join(appDir, "src"), { exclude: new Set(["server"]) }),
    ...FRONTEND_DIRECTORIES.map((directory) => newestFileMtime(path.join(appDir, directory))),
    ...FRONTEND_FILES.map((file) => newestFileMtime(path.join(appDir, file))),
  ]);
  return Math.max(0, ...candidates);
}

export async function frontendBuildIsStale({ appDir, distDir }) {
  const [sourceMtime, indexMtime] = await Promise.all([
    frontendSourceMtime(appDir),
    newestFileMtime(path.join(distDir, "index.html")),
  ]);
  return indexMtime === 0 || sourceMtime > indexMtime;
}

export function frontendBuildIdFromHtml(html) {
  const meta = [...String(html ?? "").matchAll(/<meta\b[^>]*>/giu)]
    .map((match) => match[0])
    .find((tag) => /\bname=["']infans-frontend-build["']/iu.test(tag));
  const value = meta?.match(/\bcontent=["']([^"']+)["']/iu)?.[1]?.trim() ?? "";
  return /^[a-zA-Z0-9_-]{1,80}$/u.test(value) ? value : null;
}

export async function readFrontendBuildId(distDir) {
  try {
    return frontendBuildIdFromHtml(await fs.readFile(path.join(distDir, "index.html"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function runNode(script, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: options.cwd, env: options.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(script)} 构建失败（${signal ? `信号 ${signal}` : `退出码 ${code}`}）`));
    });
  });
}

function safeBuildRelativePath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return null;
  const normalized = path.posix.normalize(value);
  return normalized === ".." || normalized.startsWith("../") ? null : normalized;
}

async function previousBuildAssetPaths(distDir) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(distDir, ".vite", "manifest.json"), "utf8")); }
  catch { return []; }
  const paths = new Set();
  for (const entry of Object.values(manifest || {})) {
    if (!entry || typeof entry !== "object") continue;
    for (const value of [entry.file, ...(Array.isArray(entry.css) ? entry.css : []), ...(Array.isArray(entry.assets) ? entry.assets : [])]) {
      const relative = safeBuildRelativePath(value);
      if (relative) paths.add(relative);
    }
  }
  return [...paths];
}

async function copyBuildFileIfAbsent(sourceRoot, targetRoot, relative) {
  const source = path.join(sourceRoot, relative);
  const target = path.join(targetRoot, relative);
  try { await fs.access(target); return; } catch { /* 新构建中没有才需要保留旧文件。 */ }
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** 只保留上一代 manifest 真正引用的文件，让尚未销毁的 iOS 旧页面能安全退场。 */
export async function preservePreviousBuildAssets(previousDistDir, nextDistDir) {
  const assets = await previousBuildAssetPaths(previousDistDir);
  await Promise.all(assets.flatMap((relative) => ["", ".br", ".gz"].map((suffix) => copyBuildFileIfAbsent(previousDistDir, nextDistDir, `${relative}${suffix}`))));
  return assets;
}

/** 独立交接地址只能跳回同站普通页面，并带一次性版本参数避免 WebKit 恢复旧快照。 */
export function frontendHandoffTarget(rawTarget, rawVersion) {
  const base = new URL("http://workbench.local/");
  let target;
  try { target = new URL(String(rawTarget || "/"), base); }
  catch { target = new URL("/", base); }
  if (target.origin !== base.origin || target.pathname.startsWith("/api/") || target.pathname === "/__frontend-handoff" || path.posix.extname(target.pathname)) {
    target = new URL("/", base);
  }
  const version = String(rawVersion || Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || Date.now().toString(36);
  target.searchParams.delete(FRONTEND_HANDOFF_MARKER);
  target.searchParams.set(FRONTEND_HANDOFF_MARKER, version);
  return `${target.pathname}${target.search}${target.hash}`;
}

/** 在临时目录构建成功后再整体替换，失败时继续保留上一个可用版本。 */
export async function buildFrontendAtomically({ appDir, distDir }) {
  await runNode(path.join(appDir, "scripts/check-theme-contract.mjs"), [], { cwd: appDir, env: process.env });
  const nonce = `${process.pid}-${Date.now()}`;
  const temporaryDir = path.join(appDir, `.dist-refresh-${nonce}`);
  const backupDir = path.join(appDir, `.dist-refresh-backup-${nonce}`);
  const vite = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
  const precompress = path.join(appDir, "scripts", "precompress.mjs");

  await fs.rm(temporaryDir, { recursive: true, force: true });
  try {
    await runNode(vite, ["build", "--outDir", temporaryDir, "--emptyOutDir"], { cwd: appDir, env: process.env });
    await runNode(precompress, [], { cwd: appDir, env: { ...process.env, INFANS_DIST_DIR: temporaryDir } });
    await preservePreviousBuildAssets(distDir, temporaryDir);

    await fs.rename(distDir, backupDir).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    try {
      await fs.rename(temporaryDir, distDir);
    } catch (error) {
      await fs.rename(backupDir, distDir).catch(() => undefined);
      throw error;
    }
    await fs.rm(backupDir, { recursive: true, force: true });
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

export function createFrontendRefreshGate(options) {
  const appDir = path.resolve(options.appDir);
  const distDir = path.resolve(options.distDir);
  const build = options.build ?? (() => buildFrontendAtomically({ appDir, distDir }));
  const now = options.now ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? 30_000;
  let pendingBuild = null;
  let lastBuildError = null;
  let retryAfter = 0;

  async function refreshIfStale({ automatic = false } = {}) {
    if (pendingBuild) return pendingBuild;
    pendingBuild = (async () => {
      if (!(await frontendBuildIsStale({ appDir, distDir }))) {
        lastBuildError = null;
        retryAfter = 0;
        return false;
      }
      // 连续导航不重复启动同一个失败候选；明确的刷新操作仍可立即重试。
      if (automatic && lastBuildError && now() < retryAfter) throw lastBuildError;
      console.log("检测到前端源码比当前页面新，正在执行深度刷新…");
      try {
        await build();
      } catch (error) {
        lastBuildError = error;
        retryAfter = now() + retryDelayMs;
        console.warn("前端候选构建失败，普通导航将尝试保留的页面；自动重试暂缓。");
        throw error;
      }
      lastBuildError = null;
      retryAfter = 0;
      console.log("深度刷新完成，正在返回新版页面。");
      return true;
    })().finally(() => { pendingBuild = null; });
    return pendingBuild;
  }

  async function ensureFreshFrontend(request) {
    if (!isWorkbenchNavigationRequest(request)) return false;
    return refreshIfStale({ automatic: true });
  }

  // iPad / iPhone 的页内刷新走明确 API，避免 WebKit 把 HEAD 页面探测留在缓存里。
  ensureFreshFrontend.refreshIfStale = refreshIfStale;
  return ensureFreshFrontend;
}
