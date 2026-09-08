#!/usr/bin/env node
/**
 * 开源示例库初始化 / 绑定。
 * 新建：在同文件系统暂存目录按精确文件清单播种，成功后才落到目标并写指针。
 * 绑定：只接受带完整初始化标记的库，或 --import 的自建库。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledStudio = path.resolve(appDir, "../..");
const sourceStudio = path.resolve(process.env.INFANS_OSS_EXAMPLE_SOURCE || bundledStudio);
const repoRoot = path.resolve(bundledStudio, "..");
const args = process.argv.slice(2);
const bindOnly = args.includes("--bind");
const importExisting = args.includes("--import");
const positional = args.filter((item) => item !== "--bind" && item !== "--import");
const requested = String(process.env.INFANS_VAULT_ROOT || positional[0] || "").trim();
const target = path.resolve(requested || path.join(os.homedir(), "Infans_OpenSource"));
const pointer = path.join(appDir, ".infans-vault-root");
const READY_NAME = ".infans-opensource-ready.json";
const FAILED_NAME = ".infans-opensource-init-failed.json";
const MANIFEST_PATH = process.env.INFANS_OSS_EXAMPLE_MANIFEST || path.join(appDir, "scripts/opensource-example-manifest.json");

function looksLocalConfig(name) {
  return name.endsWith(".local") || name.endsWith(".local.json") || name === ".infans-vault-root";
}

async function loadManifest() {
  const parsed = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  const files = Array.isArray(parsed.files) ? parsed.files.map(String) : [];
  if (!files.length) throw new Error("示例清单为空。");
  for (const rel of files) {
    if (!rel || rel.startsWith("/") || rel.includes("..") || path.isAbsolute(rel)) {
      throw new Error(`示例清单含非法路径：${rel}`);
    }
  }
  return files;
}

async function resolvePlannedTarget(targetPath) {
  const abs = path.resolve(targetPath);
  const missing = [];
  let current = abs;
  while (true) {
    try {
      await fs.lstat(current);
      break;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      missing.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) throw new Error("无法解析目标祖先路径。");
      current = parent;
    }
  }
  if (!missing.length) {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) throw new Error("数据根不能是符号链接。");
    const planned = await fs.realpath(abs);
    return { ancestorReal: planned, planned };
  }
  const ancestorReal = await fs.realpath(current);
  const planned = path.join(ancestorReal, ...missing);
  if (planned !== ancestorReal && !isInside(ancestorReal, planned)) {
    throw new Error("目标相对已有祖先无法安全解析。");
  }
  return { ancestorReal, planned };
}

function isInside(parent, child) {
  const root = path.resolve(parent);
  const leaf = path.resolve(child);
  return leaf === root || leaf.startsWith(`${root}${path.sep}`);
}

async function assertSafeTarget(plannedPath) {
  const sourceReal = await fs.realpath(sourceStudio);
  const repoReal = await fs.realpath(repoRoot);
  if (plannedPath === sourceReal) throw new Error("数据根不能与源码里的 Infans_Studio 相同。");
  if (isInside(repoReal, plannedPath) || isInside(sourceReal, plannedPath)) {
    throw new Error("数据根必须在源码仓库外，不能建在候选目录里。");
  }
  if (isInside(plannedPath, sourceReal)) {
    throw new Error("数据根不能是源码目录的祖先，避免递归自拷。");
  }
}

async function isEmptyDir(dir) {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((name) => name !== ".DS_Store").length === 0;
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function sameFilesystem(a, b) {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  return sa.dev === sb.dev;
}

async function copyListedFile(src, dest) {
  const srcStat = await fs.lstat(src);
  if (srcStat.isSymbolicLink()) throw new Error(`拒绝复制符号链接：${src}`);
  if (!srcStat.isFile()) throw new Error(`示例清单项不是普通文件：${src}`);
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
}

async function seedListedFiles(destRoot, files) {
  for (const rel of files) {
    const src = path.join(sourceStudio, rel);
    const dest = path.join(destRoot, rel);
    try {
      await fs.lstat(src);
    } catch (error) {
      if (error && error.code === "ENOENT") throw new Error(`示例清单缺少源文件：${rel}`);
      throw error;
    }
    await copyListedFile(src, dest);
  }
}

async function writeReadyMarker(destRoot, files) {
  const payload = {
    schemaVersion: 1,
    status: "complete",
    createdAt: new Date().toISOString(),
    fileCount: files.length,
  };
  await fs.writeFile(path.join(destRoot, READY_NAME), `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function verifySeed(destRoot, files) {
  for (const rel of files) {
    await fs.access(path.join(destRoot, rel));
  }
  const marker = JSON.parse(await fs.readFile(path.join(destRoot, READY_NAME), "utf8"));
  if (marker.status !== "complete" || marker.fileCount !== files.length) {
    throw new Error("初始化完成标记校验失败。");
  }
}

async function readReady(dir) {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(dir, READY_NAME), "utf8"));
    return marker && marker.status === "complete";
  } catch {
    return false;
  }
}

async function looksLikeFailedInit(dir) {
  try {
    await fs.access(path.join(dir, FAILED_NAME));
    return true;
  } catch {
    return false;
  }
}

async function looksLikeSelfBuiltVault(dir) {
  try {
    await fs.access(path.join(dir, "待办事项与长期规划.md"));
    return true;
  } catch {
    return false;
  }
}

async function writePointer(targetPath) {
  const previous = await fs.readFile(pointer, "utf8").catch(() => "");
  try {
    await fs.writeFile(pointer, `${targetPath}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    if (previous) await fs.writeFile(pointer, previous, { encoding: "utf8", mode: 0o600 }).catch(() => {});
    throw error;
  }
}

function targetOccupiedError(dest) {
  const error = new Error(`目标已被其他内容占用：${path.basename(dest)}。目录里可能留下未完成的示例文件；请保留已有内容，不要整目录删除。未改指针。`);
  error.code = "TARGET_OCCUPIED";
  return error;
}

async function placeEntryExclusive(from, to) {
  const st = await fs.lstat(from);
  if (st.isDirectory()) {
    try {
      await fs.mkdir(to, { mode: st.mode & 0o777 });
    } catch (error) {
      if (error && error.code === "EEXIST") throw targetOccupiedError(to);
      throw error;
    }
    const names = await fs.readdir(from);
    for (const name of names) {
      await placeEntryExclusive(path.join(from, name), path.join(to, name));
    }
    return;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`拒绝提交非普通文件：${from}`);
  }
  try {
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error && error.code === "EEXIST") throw targetOccupiedError(to);
    throw error;
  }
  await fs.chmod(to, st.mode & 0o777).catch(() => {});
}

async function maybeWaitPlaceGate(index) {
  const gate = String(process.env.INFANS_OSS_INIT_PLACE_GATE || "").trim();
  if (!gate) return;
  const waiting = `${gate}.${index}.waiting`;
  const go = `${gate}.${index}`;
  await fs.writeFile(waiting, "waiting\n");
  const started = Date.now();
  while (true) {
    try {
      await fs.access(go);
      break;
    } catch {
      if (Date.now() - started > 15_000) throw new Error("初始化放入门超时。");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function moveDirContentsExclusive(from, to) {
  const entries = (await fs.readdir(from)).sort();
  const rest = entries.filter((name) => name !== READY_NAME);
  const ready = entries.filter((name) => name === READY_NAME);
  let topIndex = 0;
  for (const name of [...rest, ...ready]) {
    await placeEntryExclusive(path.join(from, name), path.join(to, name));
    topIndex += 1;
    await maybeWaitPlaceGate(topIndex);
  }
}

async function seedIntoTarget(targetPath, created, files) {
  const parent = path.dirname(targetPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(parent, ".infans-init-staging-"));
  try {
    if (!(await sameFilesystem(parent, staging))) {
      throw new Error("暂存目录与目标不在同一文件系统。");
    }
    await seedListedFiles(staging, files);
    await writeReadyMarker(staging, files);
    await verifySeed(staging, files);
    const commitGate = String(process.env.INFANS_OSS_INIT_COMMIT_GATE || "").trim();
    if (commitGate) {
      await fs.writeFile(`${commitGate}.waiting`, `${staging}\n`, { encoding: "utf8" });
      const started = Date.now();
      while (true) {
        try {
          await fs.access(commitGate);
          break;
        } catch {
          if (Date.now() - started > 15_000) throw new Error("初始化提交门超时。");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    }
    if (created) {
      await fs.rename(staging, targetPath);
    } else {
      await moveDirContentsExclusive(staging, targetPath);
      await fs.rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (!created) {
      await fs.writeFile(path.join(targetPath, FAILED_NAME), `${JSON.stringify({ status: "failed", at: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => {});
    }
    throw error;
  }
}

try {
  if (looksLocalConfig(path.basename(target))) {
    throw new Error("数据根不能是本机配置文件名。");
  }
  const { planned } = await resolvePlannedTarget(target);
  await assertSafeTarget(planned);

  if (bindOnly) {
    if (await looksLikeFailedInit(target)) {
      throw new Error("绑定失败：目标是一次失败的初始化半成品。请保留已有内容，不要整目录删除。未改指针。");
    }
    const ready = await readReady(target);
    if (importExisting) {
      if (!ready && !(await looksLikeSelfBuiltVault(target))) {
        throw new Error("导入失败：目标既没有完整初始化标记，也不像自建库。请保留已有内容，不要整目录删除。未改指针。");
      }
    } else if (!ready) {
      throw new Error("绑定失败：目标没有完整初始化标记。目录可能含未完成示例，请保留已有内容，不要整目录删除。自建库请加 --import。未改指针。");
    }
    await writePointer(target);
    console.log(`已绑定开源数据根：${target}`);
    console.log("没有复制或改写该目录里的文件。");
    process.exit(0);
  }

  if (importExisting) {
    throw new Error("--import 只能与 --bind 一起使用。");
  }

  const files = await loadManifest();
  const empty = await isEmptyDir(target);
  if (empty === false) {
    throw new Error("目标目录已有内容。已有库请用 pnpm bind:data，不要再次初始化。未改指针，也未改写目标。");
  }
  const created = empty === null;
  await seedIntoTarget(target, created, files);
  await writePointer(target);
  console.log(`已初始化开源数据根：${target}`);
  console.log(`启动脚本会读取 ${pointer}。不要把这个文件或运行记录提交进源码。`);
  console.log("已有库丢了指针时，用 pnpm bind:data 指向原目录，不要再跑 init:data。");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
