import path from "node:path";
import { createWorkbenchRouter } from "./workbench-router.mjs";
import { registerWorkbenchRoutes, vaultRoot } from "./workbench-routes.mjs";

/**
 * dev 用薄壳：把本机 API 挂进 Vite 的 middlewares。
 *
 * 路由实现全在 workbench-routes.mjs，生产由 src/server/serve.mjs 装同一份，
 * 所以 dev 与生产的接口行为一致，不会出现「dev 能跑、打包后 404」。
 */
export function workbenchDataPlugin() {
  return {
    name: "infans-workbench-local-actions",
    apply: "serve",
    configureServer(server) {
      const router = createWorkbenchRouter();
      const routes = registerWorkbenchRoutes(router, { root: vaultRoot(), publicDir: path.join(process.cwd(), "public") });
      server.httpServer?.once("close", () => routes.dispose());
      server.middlewares.use((request, response, next) => router.handle(request, response, next));
    },
  };
}
