import assert from "node:assert/strict";
import test from "node:test";
import { createRelationshipMemoryService } from "../src/server/workbench-relationship-memory.mjs";

test("开源版不含私人关系记忆", async () => {
  const service = createRelationshipMemoryService();
  assert.deepEqual(await service.read(), { items: [], excluded: true });
  await assert.rejects(() => service.write({}), (error) => error?.status === 404 && error?.code === "RELATIONSHIP_EXCLUDED");
  await assert.rejects(() => service.preview({}), (error) => error?.status === 404 && error?.code === "RELATIONSHIP_EXCLUDED");
  await assert.rejects(() => service.commit("token"), (error) => error?.status === 404 && error?.code === "RELATIONSHIP_EXCLUDED");
});
