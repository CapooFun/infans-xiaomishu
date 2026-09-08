import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backupIsFresh,
  formatDailyHealthLog,
  inspectDailyHealth,
  latestBackupSuccess,
} from "../scripts/workbench-daily-health.mjs";

test("backup success uses the newest dated log line", () => {
  const log = [
    "2026-09-01 07:10:05 JST 主库 NAS 镜像成功",
    "2026-09-03 07:10:04 JST 没有变更",
    "random noise",
  ].join("\n");
  const success = latestBackupSuccess(log);
  assert.equal(success.date, "2026-09-03");
  assert.equal(backupIsFresh(success, "2026-09-05"), true);
  assert.equal(backupIsFresh(success, "2026-09-06"), false);
});

test("daily health passes when schedules exist, backup is fresh and the service is not listening", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-daily-health-ok-"));
  const agentsDir = path.join(root, "LaunchAgents");
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  await fs.mkdir(agentsDir);
  await fs.mkdir(binDir);
  await fs.mkdir(stateDir);
  for (const name of [
    "com.capoo.infans-workbench-daily-health.plist",
    "com.capoo.infans-workbench-daily-release.plist",
    "com.capoo.infans-vault-backup.plist",
  ]) {
    await fs.writeFile(path.join(agentsDir, name), "plist");
  }
  for (const name of [
    "infans_workbench_daily_health.sh",
    "infans_workbench_daily_release.sh",
    "infans_vault_backup.sh",
  ]) {
    await fs.writeFile(path.join(binDir, name), "#!/bin/bash\n");
  }
  await fs.writeFile(path.join(stateDir, "infans_vault_backup.log"), "2026-09-04 07:10:06 JST 主库 NAS 镜像成功\n");

  const result = await inspectDailyHealth({
    home: root,
    agentsDir,
    binDir,
    stateDir,
    today: "2026-09-05",
    serviceListening: false,
  });
  assert.equal(result.ok, true);
  assert.match(result.summary, /轻量检查通过/);
  assert.match(result.summary, /运行健康跳过/);
  assert.match(formatDailyHealthLog(result, new Date("2026-09-04T21:00:00Z")), /✅ 轻量检查通过/);
});

test("daily health fails closed when backup is stale or schedules are missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-daily-health-fail-"));
  const result = await inspectDailyHealth({
    home: root,
    agentsDir: path.join(root, "missing-agents"),
    binDir: path.join(root, "missing-bin"),
    stateDir: path.join(root, "missing-state"),
    today: "2026-09-05",
    serviceListening: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.summary, /轻量检查失败/);
  assert.ok(result.issues.some((item) => item.includes("LaunchAgent")));
  assert.ok(result.issues.some((item) => item.includes("备份日志")));
});

test("daily health reads /api/health only when the service is listening", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-daily-health-live-"));
  const agentsDir = path.join(root, "LaunchAgents");
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  await fs.mkdir(agentsDir);
  await fs.mkdir(binDir);
  await fs.mkdir(stateDir);
  for (const name of [
    "com.capoo.infans-workbench-daily-health.plist",
    "com.capoo.infans-workbench-daily-release.plist",
    "com.capoo.infans-vault-backup.plist",
  ]) {
    await fs.writeFile(path.join(agentsDir, name), "plist");
  }
  for (const name of [
    "infans_workbench_daily_health.sh",
    "infans_workbench_daily_release.sh",
    "infans_vault_backup.sh",
  ]) {
    await fs.writeFile(path.join(binDir, name), "#!/bin/bash\n");
  }
  await fs.writeFile(path.join(stateDir, "infans_vault_backup.log"), "2026-09-05 07:10:06 JST 没有变更\n");

  let fetched = 0;
  const live = await inspectDailyHealth({
    agentsDir,
    binDir,
    stateDir,
    today: "2026-09-05",
    serviceListening: true,
    fetchHealth: async () => {
      fetched += 1;
      return {
        ok: true,
        json: async () => ({ ok: true, version: "1.16.0", localOnly: true, controlledWrites: true }),
      };
    },
  });
  assert.equal(fetched, 1);
  assert.equal(live.ok, true);
  assert.match(live.summary, /运行健康正常：V1.16.0/);

  const broken = await inspectDailyHealth({
    agentsDir,
    binDir,
    stateDir,
    today: "2026-09-05",
    serviceListening: true,
    fetchHealth: async () => ({ ok: true, json: async () => ({ ok: false }) }),
  });
  assert.equal(broken.ok, false);
  assert.match(broken.summary, /健康接口未返回 ok/);
});
