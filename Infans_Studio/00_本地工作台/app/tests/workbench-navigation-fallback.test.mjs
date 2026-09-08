import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFrontendRefreshGate } from "../src/server/workbench-frontend-refresh.mjs";
import { createStaticHandler } from "../src/server/workbench-static.mjs";
import { createWorkbenchRouter } from "../src/server/workbench-router.mjs";

async function fixture(t, hasPrevious = true) {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-navigation-fallback-"));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  const distDir = path.join(appDir, "dist");
  await fs.mkdir(path.join(appDir, "src"), { recursive: true });
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(appDir, "src", "App.tsx"), "candidate");
  if (hasPrevious) {
    await fs.writeFile(path.join(distDir, "index.html"), "<html>previous usable page</html>");
    await fs.utimes(path.join(distDir, "index.html"), new Date(0), new Date(0));
  }
  return { appDir, distDir };
}

function request(router, url = "/", headers = {}) {
  return new Promise((resolve) => {
    const responseHeaders = {};
    const response = {
      statusCode: 200,
      setHeader(key, value) { responseHeaders[key] = value; },
      getHeader(key) { return responseHeaders[key]; },
      removeHeader(key) { delete responseHeaders[key]; },
      end(body) { resolve({ status: this.statusCode, body: String(body ?? ""), headers: responseHeaders }); },
    };
    router.handle({ method: "GET", url, headers: { accept: "text/html", ...headers } }, response);
  });
}

test("failed candidates preserve ordinary SPA navigation, with retry backoff and explicit retry", async (t) => {
  const dirs = await fixture(t);
  let clock = 1_000;
  let builds = 0;
  let fail = true;
  const gate = createFrontendRefreshGate({ ...dirs, now: () => clock, retryDelayMs: 100,
    build: async () => {
      builds++;
      if (fail) throw new Error("candidate failed");
      await fs.writeFile(path.join(dirs.distDir, "index.html"), "<html>new usable page</html>");
    },
  });
  const router = createWorkbenchRouter();
  router.use(createStaticHandler({ distDir: dirs.distDir, prepareNavigation: gate }));
  const first = await request(router, "/projects");
  assert.equal(first.status, 200);
  assert.equal(first.body, "<html>previous usable page</html>");
  assert.equal(first.headers["X-Infans-Frontend-State"], "previous-build");
  assert.equal(first.headers["X-Infans-Frontend-Rebuilt"], undefined);
  assert.equal((await request(router)).status, 200);
  assert.equal(builds, 1);
  await assert.rejects(gate.refreshIfStale(), /candidate failed/);
  assert.equal(builds, 2, "explicit refresh reports failure and bypasses automatic backoff");
  clock += 101;
  fail = false;
  const recovered = await request(router);
  assert.equal(builds, 3);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body, "<html>new usable page</html>");
  assert.equal(recovered.headers["X-Infans-Frontend-Rebuilt"], "1");
  assert.equal(recovered.headers["X-Infans-Frontend-State"], undefined);
});

test("a failed first build stays an error when no previous index exists", async (t) => {
  const dirs = await fixture(t, false);
  const gate = createFrontendRefreshGate({ ...dirs, build: async () => { throw new Error("first build failed"); } });
  const router = createWorkbenchRouter();
  router.use(createStaticHandler({ distDir: dirs.distDir, prepareNavigation: gate }));
  assert.equal((await request(router)).status, 500);
});

test("an external successful build clears backoff without rebuilding, and missing chunks stay missing", async (t) => {
  const dirs = await fixture(t);
  let builds = 0;
  const gate = createFrontendRefreshGate({ ...dirs, build: async () => { builds++; throw new Error("bad candidate"); } });
  const router = createWorkbenchRouter();
  router.use(createStaticHandler({ distDir: dirs.distDir, prepareNavigation: gate }));
  await request(router);
  await fs.writeFile(path.join(dirs.distDir, "index.html"), "externally built");
  const fresh = await request(router);
  assert.equal(fresh.body, "externally built");
  assert.equal(fresh.headers["X-Infans-Frontend-State"], undefined);
  assert.equal(builds, 1);
  assert.equal((await request(router, "/assets/missing.js")).status, 404);
});
