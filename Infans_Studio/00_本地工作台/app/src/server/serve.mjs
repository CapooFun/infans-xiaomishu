#!/usr/bin/env node
/**
 * Infans 本地工作台的生产运行时。
 *
 * 从前工作台直接跑 `vite dev`，浏览器要拉未压缩、未 tree-shake 的模块图
 * （实测冷缓存约 3.0 MB，其中 lucide-react 单文件 1.1 MB）；同时任何
 * src/server/*.mjs 的语法错误都会让 Vite 重启失败、把 API 一起打死。
 *
 * 现在改为：前端走 `vite build` 产物 + 预压缩静态层，API 在本进程内，
 * 与 Vite 完全解耦。默认端口 5173，可用 INFANS_PORT 改；启动脚本必须与此一致。
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkbenchRouter } from "./workbench-router.mjs";
import { assertTrustedOrigin, registerWorkbenchRoutes, vaultRoot } from "./workbench-routes.mjs";
import { WORKBENCH_VERSION } from "./workbench-data.mjs";
import { createStaticHandler } from "./workbench-static.mjs";
import { createFrontendRefreshGate, frontendHandoffTarget, readFrontendBuildId } from "./workbench-frontend-refresh.mjs";
import { instanceIdFor, resolveListenPort } from "../workbench-instance.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = path.join(appDir, "dist");
const host = process.env.INFANS_HOST || "127.0.0.1";
let port;
try {
  port = resolveListenPort();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

async function assertBuilt() {
  try {
    await fs.access(path.join(distDir, "index.html"));
  } catch {
    console.error("找不到 dist/index.html。请先在 app 目录运行 pnpm build，或直接用 scripts/start-local.sh 启动。");
    process.exit(1);
  }
}

await assertBuilt();

let vault;
try {
  vault = vaultRoot(appDir);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const router = createWorkbenchRouter({
  onError: (error, request) => console.error(`[api] ${request.method} ${request.url} 失败：${error instanceof Error ? error.message : error}`),
});
const prepareNavigation = createFrontendRefreshGate({ appDir, distDir });
const routes = registerWorkbenchRoutes(router, {
  root: vault,
  publicDir: path.join(appDir, "public"),
  instanceId: instanceIdFor(appDir, vault),
  vaultRoot: vault,
});
router.use("/api/frontend-refresh", async (request, response) => {
  if (request.method !== "POST") {
    response.statusCode = 405;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    return response.end(JSON.stringify({ error: "只允许刷新请求" }));
  }
  assertTrustedOrigin(request);
  const rebuilt = await prepareNavigation.refreshIfStale();
  const buildId = await readFrontendBuildId(distDir);
  const body = Buffer.from(JSON.stringify({ ok: true, rebuilt, buildId }));
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", body.length);
  response.end(body);
});
router.use("/__frontend-handoff", (request, response) => {
  if (request.method !== "GET") {
    response.statusCode = 405;
    response.setHeader("Cache-Control", "no-store");
    return response.end();
  }
  const url = new URL(request.url || "/", "http://workbench.local");
  response.statusCode = 302;
  response.setHeader("Location", frontendHandoffTarget(url.searchParams.get("to"), url.searchParams.get("v")));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", "0");
  response.end();
});
router.use(createStaticHandler({ distDir, prepareNavigation }));

const server = http.createServer((request, response) => router.handle(request, response));

server.listen(port, host, () => {
  console.log(`Infans 本地工作台 v${WORKBENCH_VERSION} 已启动：http://${host}:${port}`);
});

server.on("error", (error) => {
  console.error(`本地服务无法监听 ${host}:${port}：${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`收到 ${signal}，正在停止本地服务…`);
  routes.dispose();
  server.close(() => process.exit(0));
  // 保活连接不该拖着不退出。
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
