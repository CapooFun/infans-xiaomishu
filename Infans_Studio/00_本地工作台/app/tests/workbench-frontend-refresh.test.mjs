import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFrontendRefreshGate,
  frontendBuildIdFromHtml,
  frontendBuildIsStale,
  frontendHandoffTarget,
  isWorkbenchNavigationRequest,
  preservePreviousBuildAssets,
} from "../src/server/workbench-frontend-refresh.mjs";

test("only browser page navigations can trigger a deep refresh", () => {
  const request = (url, accept = "text/html", method = "GET") => ({ method, url, headers: { accept } });
  assert.equal(isWorkbenchNavigationRequest(request("/")), true);
  assert.equal(isWorkbenchNavigationRequest(request("/languages?from=home")), true);
  assert.equal(isWorkbenchNavigationRequest(request("/assets/index.js", "*/*")), false);
  assert.equal(isWorkbenchNavigationRequest(request("/api/health")), false);
  assert.equal(isWorkbenchNavigationRequest(request("/", "application/json")), false);
  assert.equal(isWorkbenchNavigationRequest(request("/", "text/html", "POST")), false);
});

test("the built page exposes a stable frontend identity for suspended mobile clients", () => {
  assert.equal(frontendBuildIdFromHtml('<meta name="infans-frontend-build" content="build-42">'), "build-42");
  assert.equal(frontendBuildIdFromHtml('<meta content="build-42" name="infans-frontend-build">'), "build-42");
  assert.equal(frontendBuildIdFromHtml('<meta name="infans-frontend-build" content="bad value">'), null);
});

test("frontend freshness ignores server-only edits and notices visible source edits", async (t) => {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-refresh-"));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  const distDir = path.join(appDir, "dist");
  await fs.mkdir(path.join(appDir, "src", "server"), { recursive: true });
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(appDir, "src", "Home.tsx"), "old");
  await fs.writeFile(path.join(appDir, "src", "server", "serve.mjs"), "old");
  await fs.writeFile(path.join(distDir, "index.html"), "built");

  const now = Date.now();
  await fs.utimes(path.join(appDir, "src", "Home.tsx"), new Date(now - 4_000), new Date(now - 4_000));
  await fs.utimes(path.join(distDir, "index.html"), new Date(now - 3_000), new Date(now - 3_000));
  await fs.utimes(path.join(appDir, "src", "server", "serve.mjs"), new Date(now - 1_000), new Date(now - 1_000));
  assert.equal(await frontendBuildIsStale({ appDir, distDir }), false);

  await fs.utimes(path.join(appDir, "src", "Home.tsx"), new Date(now), new Date(now));
  assert.equal(await frontendBuildIsStale({ appDir, distDir }), true);
});

test("concurrent page refreshes share one build", async (t) => {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-refresh-lock-"));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  const distDir = path.join(appDir, "dist");
  await fs.mkdir(path.join(appDir, "src"), { recursive: true });
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(appDir, "src", "Home.tsx"), "new");
  await fs.writeFile(path.join(distDir, "index.html"), "old");
  const now = Date.now();
  await fs.utimes(path.join(distDir, "index.html"), new Date(now - 2_000), new Date(now - 2_000));
  await fs.utimes(path.join(appDir, "src", "Home.tsx"), new Date(now), new Date(now));

  let builds = 0;
  let release;
  const gate = createFrontendRefreshGate({
    appDir,
    distDir,
    build: async () => {
      builds += 1;
      await new Promise((resolve) => { release = resolve; });
    },
  });
  const request = { method: "GET", url: "/", headers: { accept: "text/html" } };
  const first = gate(request);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const second = gate.refreshIfStale();
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(builds, 1);
});

test("explicit mobile refresh keeps the cheap stale check and skips a rebuild when current", async (t) => {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-refresh-current-"));
  t.after(() => fs.rm(appDir, { recursive: true, force: true }));
  const distDir = path.join(appDir, "dist");
  await fs.mkdir(path.join(appDir, "src"), { recursive: true });
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(appDir, "src", "Home.tsx"), "old");
  await fs.writeFile(path.join(distDir, "index.html"), "current");
  const now = Date.now();
  await fs.utimes(path.join(appDir, "src", "Home.tsx"), new Date(now - 2_000), new Date(now - 2_000));
  await fs.utimes(path.join(distDir, "index.html"), new Date(now), new Date(now));

  let builds = 0;
  const gate = createFrontendRefreshGate({ appDir, distDir, build: async () => { builds += 1; } });
  assert.equal(await gate.refreshIfStale(), false);
  assert.equal(builds, 0);
});

test("handoff redirects only to a same-site page and adds a one-shot build marker", () => {
  assert.equal(
    frontendHandoffTarget("/projects?project=infans#feature", "build-42"),
    "/projects?project=infans&__infans_frontend=build-42#feature",
  );
  assert.equal(frontendHandoffTarget("https://evil.example/path", "x"), "/?__infans_frontend=x");
  assert.equal(frontendHandoffTarget("/api/health", "x"), "/?__infans_frontend=x");
  assert.equal(frontendHandoffTarget("/__frontend-handoff", "x"), "/?__infans_frontend=x");
});

test("a rebuild keeps exactly the previous manifest assets available for an old mobile page", async (t) => {
  const previous = await fs.mkdtemp(path.join(os.tmpdir(), "infans-refresh-previous-"));
  const next = await fs.mkdtemp(path.join(os.tmpdir(), "infans-refresh-next-"));
  t.after(() => Promise.all([fs.rm(previous, { recursive: true, force: true }), fs.rm(next, { recursive: true, force: true })]));
  await fs.mkdir(path.join(previous, ".vite"), { recursive: true });
  await fs.mkdir(path.join(previous, "assets"), { recursive: true });
  await fs.mkdir(path.join(next, "assets"), { recursive: true });
  await fs.writeFile(path.join(previous, ".vite", "manifest.json"), JSON.stringify({
    "src/main.tsx": { file: "assets/index-old.js", css: ["assets/index-old.css"], dynamicImports: ["src/pages/ToolsPage.tsx"] },
    "src/pages/ToolsPage.tsx": { file: "assets/tools-old.js" },
  }));
  for (const name of ["index-old.js", "index-old.js.br", "index-old.css", "tools-old.js", "orphan-older.js"]) {
    await fs.writeFile(path.join(previous, "assets", name), `old:${name}`);
  }
  await fs.writeFile(path.join(next, "assets", "index-new.js"), "new");

  const kept = await preservePreviousBuildAssets(previous, next);
  assert.deepEqual(kept.sort(), ["assets/index-old.css", "assets/index-old.js", "assets/tools-old.js"]);
  assert.equal(await fs.readFile(path.join(next, "assets", "tools-old.js"), "utf8"), "old:tools-old.js");
  assert.equal(await fs.readFile(path.join(next, "assets", "index-old.js.br"), "utf8"), "old:index-old.js.br");
  await assert.rejects(fs.access(path.join(next, "assets", "orphan-older.js")));
});
