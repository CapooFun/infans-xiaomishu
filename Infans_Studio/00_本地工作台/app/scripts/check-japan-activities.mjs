#!/usr/bin/env node
import path from "node:path";

import { readLocalActivities } from "../src/server/workbench-local-activities.mjs";

const vaultRoot = path.resolve(process.env.INFANS_VAULT_ROOT || path.join(import.meta.dirname, "../../.."));
const expectedDay = process.argv[2] || "";

try {
  const snapshot = await readLocalActivities(vaultRoot, { today: expectedDay || undefined });
  if (!snapshot.activities.length) throw new Error("未来活动列表为空");
  if (expectedDay && !snapshot.updatedAt.startsWith(expectedDay)) throw new Error("updatedAt 不是今天");
  if (expectedDay && snapshot.activities.some((item) => !item.verifiedAt.startsWith(expectedDay))) {
    throw new Error("有活动未在今天重新核验");
  }
  process.stdout.write(`通过：${snapshot.activities.length} 张未过期活动卡\n`);
} catch (error) {
  process.stderr.write(`失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
