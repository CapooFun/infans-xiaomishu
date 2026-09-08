import assert from "node:assert/strict";
import test from "node:test";
import { createSecretaryLifeCoreService } from "../src/server/workbench-secretary-life-core.mjs";

test("开源版生命核心不可写", async () => {
  const service = createSecretaryLifeCoreService();
  assert.equal((await service.read()).excluded, true);
  await assert.rejects(() => service.write({}), { status: 404 });
});
