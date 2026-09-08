#!/usr/bin/env node
/**
 * 每日 Anki 快照：必要时先打开 Anki → AnkiConnect → 派生数据/anki-snapshot.json
 * 连不上则保留旧快照，不冲掉。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncAnkiSnapshot } from "../src/server/workbench-anki.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = process.env.INFANS_VAULT_ROOT || path.resolve(__dirname, "../../..");

const result = await syncAnkiSnapshot(vaultRoot);
const stamp = new Date().toISOString();
if (result.launchedAnki) {
  console.log(`${stamp} 已先打开 Anki 桌面端`);
}
if (result.keptOld) {
  console.log(`${stamp} ⏭ ${result.message}`);
} else if (result.syncedAt) {
  console.log(`${stamp} ✅ ${result.message}`);
} else {
  console.log(`${stamp} ⚠ ${result.message}`);
}
process.exit(0);
