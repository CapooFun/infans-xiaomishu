import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { createWorkbenchRouter, mountedUrl } from "../src/server/workbench-router.mjs";
import { acceptedEncodings, cacheControlFor, createStaticHandler, resolveStaticPath } from "../src/server/workbench-static.mjs";

/** 不解压、不改 header 的裸请求，便于断言 Content-Encoding 与 Content-Length。 */
function rawRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method: options.method || "GET", headers: options.headers || {} }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

async function withServer(router, run) {
  const server = http.createServer((request, response) => router.handle(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("mount matching strips the prefix and respects segment boundaries", () => {
  assert.equal(mountedUrl("/api/health", "/api/health"), "/");
  assert.equal(mountedUrl("/api/health/", "/api/health"), "/");
  assert.equal(mountedUrl("/api/sections/health", "/api/sections"), "/health");
  assert.equal(mountedUrl("/api/calendar?from=a&to=b", "/api/calendar"), "/?from=a&to=b");
  // 关键边界：不能让 /api/healthz 落进 /api/health 的 handler。
  assert.equal(mountedUrl("/api/healthz", "/api/health"), null);
  assert.equal(mountedUrl("/api/summary", "/api/health"), null);
});

test("routes are matched in registration order so nested paths win", async () => {
  const router = createWorkbenchRouter();
  const seen = [];
  router.use("/api/calendar/preview", (request, response) => { seen.push(["preview", request.url]); response.end("preview"); });
  router.use("/api/calendar", (request, response) => { seen.push(["calendar", request.url]); response.end("calendar"); });

  await withServer(router, async (port) => {
    assert.equal((await rawRequest(port, "/api/calendar/preview")).body.toString(), "preview");
    assert.equal((await rawRequest(port, "/api/calendar?from=x")).body.toString(), "calendar");
  });
  assert.deepEqual(seen, [["preview", "/"], ["calendar", "/?from=x"]]);
});

test("global middleware sees the untouched url and hands control on", async () => {
  const router = createWorkbenchRouter();
  const observed = [];
  router.use((request, response, next) => { observed.push(request.url); next(); });
  router.use("/api/sections", (request, response) => response.end(request.url));

  await withServer(router, async (port) => {
    assert.equal((await rawRequest(port, "/api/sections/languages")).body.toString(), "/languages");
    const missing = await rawRequest(port, "/nope");
    assert.equal(missing.status, 404);
  });
  assert.deepEqual(observed, ["/api/sections/languages", "/nope"]);
});

test("a rejected handler answers 500 instead of hanging the request", async () => {
  const router = createWorkbenchRouter({ onError: () => {} });
  router.use("/api/anki", async () => { throw new Error("anki 未运行"); });
  router.use("/api/sync", () => { throw new Error("同步失败"); });

  await withServer(router, async (port) => {
    for (const route of ["/api/anki", "/api/sync"]) {
      const response = await rawRequest(port, route);
      assert.equal(response.status, 500);
      assert.equal(JSON.parse(response.body.toString()).error.length > 0, true);
    }
  });
});

test("accept-encoding parsing drops explicitly refused encodings", () => {
  assert.deepEqual([...acceptedEncodings("gzip, deflate, br")].sort(), ["br", "deflate", "gzip"]);
  assert.equal(acceptedEncodings("br;q=0, gzip").has("br"), false);
  assert.equal(acceptedEncodings("br;q=0, gzip").has("gzip"), true);
  assert.equal(acceptedEncodings("").size, 0);
});

test("static paths stay inside dist and directories fall back to index.html", () => {
  const dist = path.resolve("/tmp/dist-example");
  assert.equal(resolveStaticPath(dist, "/"), path.join(dist, "index.html"));
  assert.equal(resolveStaticPath(dist, "/assets/app.js?v=1"), path.join(dist, "assets/app.js"));
  assert.equal(resolveStaticPath(dist, "/../../.env"), null);
  assert.equal(resolveStaticPath(dist, "/%2e%2e%2f%2e%2e%2f.env"), null);
  assert.equal(resolveStaticPath(dist, "/a%00b"), null);
});

test("hashed assets are immutable while the shell must be revalidated", () => {
  assert.equal(cacheControlFor("/assets/index-abc123.js"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor("/index.html"), "no-cache");
  assert.equal(cacheControlFor("/theme/home.v1.avif"), "public, max-age=3600");
});

test("static layer serves the build output with the right caching and encodings", async (t) => {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-static-"));
  t.after(() => fs.rm(distDir, { recursive: true, force: true }));

  const html = `<!doctype html><html><body>${"x".repeat(2000)}</body></html>`;
  const script = `console.log(${JSON.stringify("y".repeat(2000))});`;
  await fs.writeFile(path.join(distDir, "index.html"), html);
  await fs.mkdir(path.join(distDir, "assets"));
  await fs.writeFile(path.join(distDir, "assets", "index-abc123.js"), script);
  await fs.writeFile(path.join(distDir, "assets", "index-abc123.js.br"), brotliCompressSync(Buffer.from(script)));
  await fs.mkdir(path.join(distDir, "theme"));
  await fs.writeFile(path.join(distDir, "theme", "home.v1.avif"), Buffer.from([0, 1, 2, 3]));

  const router = createWorkbenchRouter();
  router.use("/api/health", (request, response) => response.end("{}"));
  router.use(createStaticHandler({ distDir }));

  await withServer(router, async (port) => {
    const index = await rawRequest(port, "/");
    assert.equal(index.status, 200);
    assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(index.headers["cache-control"], "no-cache");

    const asset = await rawRequest(port, "/assets/index-abc123.js", { headers: { "accept-encoding": "gzip, br" } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["content-encoding"], "br");
    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(asset.headers.vary, "Accept-Encoding");
    assert.equal(Number(asset.headers["content-length"]), asset.body.length);
    assert.equal(asset.body.length < script.length, true);

    // 没有预压缩文件、或客户端不接受 br 时，必须回原文而不是发错编码。
    const plain = await rawRequest(port, "/assets/index-abc123.js", { headers: { "accept-encoding": "identity" } });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.body.toString(), script);

    const etagged = await rawRequest(port, "/assets/index-abc123.js", { headers: { "accept-encoding": "br", "if-none-match": asset.headers.etag } });
    assert.equal(etagged.status, 304);
    assert.equal(etagged.body.length, 0);

    // 前端路由要能直接刷新，但缺失的静态资源不能拿 HTML 冒充。
    const deepLink = await rawRequest(port, "/schedule");
    assert.equal(deepLink.status, 200);
    assert.equal(deepLink.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(deepLink.headers["cache-control"], "no-cache");

    const missingImage = await rawRequest(port, "/theme/absent.v1.avif");
    assert.equal(missingImage.status, 404);
    assert.equal(missingImage.headers["content-type"], "application/json; charset=utf-8");

    const image = await rawRequest(port, "/theme/home.v1.avif");
    assert.equal(image.headers["content-type"], "image/avif");
    assert.equal(image.headers["content-encoding"], undefined);

    const head = await rawRequest(port, "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(html));
    assert.equal(head.body.length, 0);

    // 未命中的 /api/* 不能掉进 SPA fallback，否则前端会把 HTML 当 JSON 解析。
    const unknownApi = await rawRequest(port, "/api/does-not-exist");
    assert.equal(unknownApi.status, 404);
    assert.equal(unknownApi.headers["content-type"], "application/json; charset=utf-8");
  });
});

test("a rebuilt navigation is marked for compatible old clients without changing the response body", async (t) => {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), "infans-static-refresh-"));
  t.after(() => fs.rm(distDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(distDir, "index.html"), "<!doctype html><title>fresh</title>");

  const router = createWorkbenchRouter();
  router.use(createStaticHandler({ distDir, prepareNavigation: async () => true }));
  await withServer(router, async (port) => {
    const response = await rawRequest(port, "/", { method: "HEAD", headers: { accept: "text/html" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers["x-infans-frontend-rebuilt"], "1");
  });
});
