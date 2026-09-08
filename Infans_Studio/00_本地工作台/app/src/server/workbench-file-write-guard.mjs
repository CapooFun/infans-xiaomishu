import fs from "node:fs/promises";
import path from "node:path";
import { WorkbenchWriteError } from "./workbench-errors.mjs";

// Shared by all cooperating write services and service instances in this process.
// External editors/processes do not participate in this queue.
const pendingWrites = new Map();

/** Resolve the Vault root, then reject links at every component below it. */
export async function resolveWritableVaultPath(vaultRoot, relativePath) {
  const root = await fs.realpath(path.resolve(vaultRoot));
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new WorkbenchWriteError("写入路径越出 Vault", 403, "PATH_OUTSIDE_VAULT");
  }
  const components = path.relative(root, target).split(path.sep);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    const candidate = path.join(current, components[index]);
    let stat;
    try { stat = await fs.lstat(candidate); }
    catch (error) {
      // New files/directories are allowed; no descendant can exist yet.
      if (error?.code === "ENOENT") return path.join(current, ...components.slice(index));
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new WorkbenchWriteError("写入路径不能经过符号链接，请使用 Vault 内原件路径", 403, "PATH_SYMLINK_FORBIDDEN");
    }
    // realpath also normalizes existing names on case-insensitive volumes.
    current = await fs.realpath(candidate);
    if (!current.startsWith(`${root}${path.sep}`)) {
      throw new WorkbenchWriteError("写入路径越出 Vault", 403, "PATH_OUTSIDE_VAULT");
    }
  }
  return current;
}

/** Serialize check + replacement, revalidating paths after waiting for the queue. */
export async function withVaultFileWrite(vaultRoot, relativePath, write) {
  const target = await resolveWritableVaultPath(vaultRoot, relativePath);
  // Conservatively share queues for case/normalization aliases on Mac/Windows,
  // including not-yet-created files. Extra serialization on a case-sensitive
  // volume is safe; separate queues for the same physical name are not.
  const key = ["darwin", "win32"].includes(process.platform) ? target.normalize("NFC").toLowerCase() : target;
  const previous = pendingWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const currentTarget = await resolveWritableVaultPath(vaultRoot, relativePath);
    if (currentTarget !== target) {
      throw new WorkbenchWriteError("写入根目录已变化，请重新生成预览", 409, "WRITE_PATH_CHANGED");
    }
    return write(target);
  });
  pendingWrites.set(key, pending);
  try { return await pending; }
  finally {
    if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
  }
}
