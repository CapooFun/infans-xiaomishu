import fs from "node:fs/promises";
import path from "node:path";
import { normalizeSidebarBookmarks } from "../sidebar-bookmarks.mjs";
import { SIDEBAR_BOOKMARKS_PATH } from "./vault-paths.mjs";
import { WorkbenchWriteError } from "./workbench-errors.mjs";
import { withVaultFileWrite } from "./workbench-file-write-guard.mjs";

export function sidebarBookmarksPath(vaultRoot) {
  return path.resolve(vaultRoot, SIDEBAR_BOOKMARKS_PATH);
}

export async function readSidebarBookmarks(vaultRoot) {
  try {
    return normalizeSidebarBookmarks(JSON.parse(await fs.readFile(sidebarBookmarksPath(vaultRoot), "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return normalizeSidebarBookmarks([]);
    }
    throw error;
  }
}

export async function writeSidebarBookmarks(vaultRoot, payload) {
  if (!payload || !Array.isArray(payload.items)) {
    throw new WorkbenchWriteError("书签列表格式不正确", 400, "SIDEBAR_BOOKMARKS_INVALID");
  }
  const snapshot = normalizeSidebarBookmarks(payload);
  return withVaultFileWrite(vaultRoot, SIDEBAR_BOOKMARKS_PATH, async (absolute) => {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.infans-tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, absolute);
    await fs.chmod(absolute, 0o600);
    return snapshot;
  });
}
