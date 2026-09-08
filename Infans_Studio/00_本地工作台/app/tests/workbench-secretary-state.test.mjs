import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSecretaryStateService } from "../src/server/workbench-secretary-state.mjs";

test("跨端当前秘书默认是银月并以 600 权限原子持久化", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-secretary-state-"));
  const service = createSecretaryStateService(root);
  const initial = await service.read();
  assert.equal(initial.activeSecretaryId, "yinyue");
  assert.equal(initial.profile.name, "银月");
  assert.equal(initial.updatedAt, null);

  const saved = await service.write("梅凝", new Date("2026-08-29T12:34:56Z"));
  assert.equal(saved.activeSecretaryId, "meining");
  assert.equal(saved.profile.notificationTitle, "梅凝");
  assert.equal((await fs.stat(service.statePath)).mode & 0o777, 0o600);

  const reloaded = createSecretaryStateService(root);
  assert.equal((await reloaded.read()).activeSecretaryId, "meining");
});

test("未知人物不能成为当前秘书，坏文件安全回退银月", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-secretary-state-invalid-"));
  const service = createSecretaryStateService(root);
  await assert.rejects(() => service.write("未知访客"), /不能成为当前秘书/u);
  await fs.mkdir(path.dirname(service.statePath), { recursive: true });
  await fs.writeFile(service.statePath, "{bad json", "utf8");
  assert.equal((await service.read()).activeSecretaryId, "yinyue");
});
