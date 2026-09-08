import { existsSync } from "node:fs";
import path from "node:path";

/** 开源示例库里的虚构示意根目录。不指向作者 NAS，也不进私有工作台活动数据。 */
export const PUBLIC_DEMO_RELATIVE = path.posix.join("00_本地工作台", "examples", "public-demo");

export function publicDemoPath(vaultRoot, ...parts) {
  return path.join(vaultRoot, ...PUBLIC_DEMO_RELATIVE.split("/"), ...parts);
}

export function resolvePublicMediaLibraryDir(vaultRoot, _envValue, kind) {
  // 开源版不读环境变量、不跟本机或 NAS 盘。只有仓库里相对路径的示意目录可以挂上。
  const dir = publicDemoPath(vaultRoot, kind);
  return existsSync(dir) ? dir : "";
}

/** 示例库放了这份标记时，不要去接本机 Anki 或作者真题包。 */
export function isPublicLanguageDemo(vaultRoot) {
  if (!vaultRoot) return false;
  return existsSync(path.join(vaultRoot, "55_语言学习", "日语", "练习记录与进度", "public-demo.json"));
}
