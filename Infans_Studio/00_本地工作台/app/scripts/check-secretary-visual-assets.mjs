import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecretaryVisualAssetCatalog } from "../src/server/workbench-secretary-visual-assets.mjs";
import { buildSecretaryVisualAssetManifest, DEFAULT_VAULT_ROOT, inspectFormalAssetSync } from "./secretary-visual-assets.mjs";

async function main() {
  const loaded = await loadSecretaryVisualAssetCatalog(DEFAULT_VAULT_ROOT);
  if (!loaded.validation.ok) {
    throw new Error(`asset-manifest.v1.json 校验失败：${loaded.validation.errors.join("；")}`);
  }
  if (!loaded.manifest.activeLibraryPolicy?.formalOnly) {
    const rebuilt = await buildSecretaryVisualAssetManifest({
      vaultRoot: DEFAULT_VAULT_ROOT,
      snapshotDate: loaded.manifest.snapshotDate,
    });
    const checkedIn = JSON.stringify(loaded.manifest);
    const current = JSON.stringify(rebuilt);
    if (checkedIn !== current) {
      throw new Error("asset-manifest.v1.json 与当前素材事实不一致；先检查新增、删除、修改或引用变化，再显式重建账本");
    }
  }
  const sync = loaded.manifest.phase === "formal-baseline-migrated" ? await inspectFormalAssetSync({ vaultRoot: DEFAULT_VAULT_ROOT }) : null;
  if (sync && !sync.ok) throw new Error(`正式母版到运行派生发生漂移：${sync.drift} 件摘要变化，${sync.missing} 件缺失`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId: loaded.catalog.project.id,
    summary: loaded.catalog.summary,
    facets: loaded.catalog.facets,
    formalSync: sync ? { targetCount: sync.targetCount, inSync: sync.inSync, drift: sync.drift, missing: sync.missing } : null,
    warnings: loaded.validation.warnings,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
