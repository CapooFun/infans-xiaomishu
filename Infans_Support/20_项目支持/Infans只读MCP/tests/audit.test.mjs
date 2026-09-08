import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAuditLogger } from "../src/audit.mjs";
import { makeFixture } from "./helpers.mjs";

test("audit records metadata but not content or search text", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const audit = createAuditLogger({ stateDirectory: fixture.stateDirectory, now: () => new Date("2026-08-21T12:00:00.000Z") });
  await audit.record({ tool: "search_vault", path: "30_事业顺利", status: "success", bytes: 100, elapsedMs: 5, query: "private-query", content: "private-content" });
  const files = await fs.readdir(path.join(fixture.stateDirectory, "audit"));
  const text = await fs.readFile(path.join(fixture.stateDirectory, "audit", files[0]), "utf8");
  assert.match(text, /search_vault/);
  assert.doesNotMatch(text, /private-query|private-content/);
});
