import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_DATA_DIR = path.join("派生数据", "secretary-runtime");
export const RUNTIME_DATA_MAPPINGS = Object.freeze([
  { legacy: path.join("小秘书.app", "对话记录"), current: path.join(RUNTIME_DATA_DIR, "chats") },
  { legacy: path.join("小秘书.app", "附件"), current: path.join(RUNTIME_DATA_DIR, "attachments") },
  { legacy: path.join("小秘书.app", "角色媒体"), current: path.join(RUNTIME_DATA_DIR, "role-media") },
]);

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function digest(file) {
  const contents = await fs.readFile(file);
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function copyTreeWithoutOverwrite(sourceRoot, targetRoot) {
  const sourceStat = await fs.lstat(sourceRoot);
  if (!sourceStat.isDirectory()) throw new Error(`旧运行数据路径不是目录：${sourceRoot}`);
  await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(targetRoot, 0o700);

  let copied = 0;
  let reused = 0;
  const visit = async (sourceDir, targetDir) => {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(sourceDir, entry.name);
      const target = path.join(targetDir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`旧运行数据含符号链接，已停止迁移：${source}`);
      if (entry.isDirectory()) {
        await fs.mkdir(target, { recursive: true, mode: 0o700 });
        await fs.chmod(target, 0o700);
        await visit(source, target);
        continue;
      }
      if (!entry.isFile()) throw new Error(`旧运行数据含不支持项，已停止迁移：${source}`);
      if (await exists(target)) {
        const [sourceHash, targetHash] = await Promise.all([digest(source), digest(target)]);
        if (sourceHash !== targetHash) throw new Error(`运行数据同名文件内容冲突，已停止迁移：${target}`);
        reused += 1;
        continue;
      }
      await fs.copyFile(source, target, constants.COPYFILE_EXCL);
      await fs.chmod(target, 0o600);
      copied += 1;
    }
  };

  await visit(sourceRoot, targetRoot);
  return { copied, reused };
}

export async function migrateSecretaryRuntimeData(workbenchDir) {
  const root = path.resolve(workbenchDir);
  const results = [];
  for (const mapping of RUNTIME_DATA_MAPPINGS) {
    const source = path.join(root, mapping.legacy);
    const target = path.join(root, mapping.current);
    if (!(await exists(source))) {
      results.push({ ...mapping, copied: 0, reused: 0, sourcePresent: false });
      continue;
    }
    const counts = await copyTreeWithoutOverwrite(source, target);
    results.push({ ...mapping, ...counts, sourcePresent: true });
  }
  return results;
}

async function main(argv) {
  const workbenchIndex = argv.indexOf("--workbench");
  const workbenchDir = workbenchIndex >= 0 ? argv[workbenchIndex + 1] : "";
  if (!workbenchDir) throw new Error("请提供 --workbench <00_本地工作台路径>");
  const results = await migrateSecretaryRuntimeData(workbenchDir);
  const copied = results.reduce((sum, item) => sum + item.copied, 0);
  const reused = results.reduce((sum, item) => sum + item.reused, 0);
  console.log(`小秘书运行数据已准备到 App 包外：新复制 ${copied} 份，核对已有 ${reused} 份。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
