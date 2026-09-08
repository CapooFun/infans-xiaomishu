/**
 * 极简挂载路由，复刻 connect 的 `use(prefix, handler)` 语义。
 *
 * dev（挂进 Vite 的 middlewares）与生产（独立 Node 服务）共用同一份实现，
 * 避免两套 URL 匹配行为出现分歧。已有 handler 依赖前缀被剥离后的 request.url，
 * 例如 `/api/sections/health` 进入 handler 时应为 `/health`。
 */

/** 命中返回剥离前缀后的 url，未命中返回 null。 */
export function mountedUrl(url, prefix) {
  const target = String(url ?? "/");
  if (target.toLowerCase().slice(0, prefix.length) !== prefix.toLowerCase()) return null;
  const rest = target.slice(prefix.length);
  if (rest === "") return "/";
  if (rest[0] === "?") return `/${rest}`;
  if (rest[0] === "/") return rest;
  return null;
}

function sendFailure(response, error) {
  if (response.headersSent) {
    if (!response.destroyed) response.end();
    return;
  }
  response.statusCode = Number(error?.statusCode) || 500;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify({ error: error instanceof Error ? error.message : "本地服务出错" }));
}

export function createWorkbenchRouter(options = {}) {
  const layers = [];
  const onError = options.onError;

  function use(pathOrHandler, maybeHandler) {
    if (typeof pathOrHandler === "function") layers.push({ prefix: null, handler: pathOrHandler });
    else layers.push({ prefix: String(pathOrHandler), handler: maybeHandler });
    return router;
  }

  /**
   * @param done 由上游传入时（dev 挂在 Vite 下）把未命中与错误交还上游；
   *             不传时（生产）自行回 404 / 500。
   */
  function handle(request, response, done) {
    const originalUrl = request.url ?? "/";
    let index = 0;

    const finish = (error) => {
      request.url = originalUrl;
      if (typeof done === "function") return done(error);
      if (error) {
        onError?.(error, request);
        return sendFailure(response, error);
      }
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ error: "找不到该地址" }));
    };

    const step = (error) => {
      if (error) return finish(error);
      const layer = layers[index];
      index += 1;
      if (!layer) return finish();
      let rewritten = originalUrl;
      if (layer.prefix !== null) {
        const mounted = mountedUrl(originalUrl, layer.prefix);
        if (mounted === null) return step();
        rewritten = mounted;
      }
      request.url = rewritten;
      const advance = (nextError) => { request.url = originalUrl; step(nextError); };
      // handler 内部大多自带 try/catch，这里兜住漏网的抛出与 rejection，
      // 避免一个 500 让请求悬挂（旧实现里 /api/anki、/api/tools/vpn 就没有兜底）。
      try {
        const result = layer.handler(request, response, advance);
        if (result && typeof result.then === "function") {
          result.then(undefined, (reason) => { request.url = originalUrl; finish(reason); });
        }
      } catch (thrown) {
        request.url = originalUrl;
        finish(thrown);
      }
    };

    step();
  }

  const router = { use, handle };
  return router;
}
