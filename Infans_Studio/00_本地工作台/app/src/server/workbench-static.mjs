import fs from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
  [".txt", "text/plain; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".avif", "image/avif"],
  [".webp", "image/webp"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
]);

/** 只对文本类产物做预压缩协商；AVIF / WebP / 字体本身已压缩。 */
export const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".svg", ".webmanifest", ".txt"]);

/** 解析 Accept-Encoding，忽略 q=0 的编码。 */
export function acceptedEncodings(header) {
  const accepted = new Set();
  for (const part of String(header ?? "").split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const quality = params.map((item) => item.trim().match(/^q=([\d.]+)$/i)?.[1]).find(Boolean);
    if (quality !== undefined && Number(quality) === 0) continue;
    accepted.add(name);
  }
  return accepted;
}

/**
 * 把请求 url 解析成 dist 内的绝对路径，越界或非法一律返回 null。
 * 目录请求补 index.html，便于 `/` 直接命中首页。
 */
export function resolveStaticPath(distDir, url) {
  const raw = String(url ?? "/").split("?")[0].split("#")[0];
  let pathname;
  try { pathname = decodeURIComponent(raw); } catch { return null; }
  if (pathname.includes("\0")) return null;
  if (pathname.endsWith("/")) pathname = `${pathname}index.html`;
  const root = path.resolve(distDir);
  const absolute = path.resolve(root, `.${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute;
}

/** 哈希文件名的产物可长期不变；index.html 必须每次校验，否则发版后打不开新 chunk。 */
export function cacheControlFor(pathname) {
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (pathname === "/" || pathname.endsWith(".html")) return "no-cache";
  return "public, max-age=3600";
}

async function statFile(absolute) {
  try {
    const stat = await fs.stat(absolute);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

/** 优先 br、其次 gzip，都没有就发原文件。 */
async function negotiate(absolute, extension, accepted) {
  if (COMPRESSIBLE.has(extension)) {
    for (const [encoding, suffix] of [["br", ".br"], ["gzip", ".gz"]]) {
      if (!accepted.has(encoding)) continue;
      const candidate = `${absolute}${suffix}`;
      const stat = await statFile(candidate);
      if (stat) return { file: candidate, stat, encoding };
    }
  }
  const stat = await statFile(absolute);
  return stat ? { file: absolute, stat, encoding: null } : null;
}

export function createStaticHandler(options = {}) {
  const distDir = path.resolve(options.distDir);
  const indexFile = path.join(distDir, "index.html");
  const prepareNavigation = options.prepareNavigation;

  return async function serveStatic(request, response, next) {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    const pathname = String(request.url ?? "/").split("?")[0];
    if (pathname.startsWith("/api/")) return next();

    let frontendRebuilt = false;
    try {
      frontendRebuilt = prepareNavigation ? await prepareNavigation(request) : false;
    } catch (error) {
      // 候选失败不能让仍然完整保留的上一版页面失去普通导航入口。
      // 首次启动没有可用页面时如实失败，不能把构建失败伪装成成功。
      if (!(await statFile(indexFile))) throw error;
      response.setHeader("X-Infans-Frontend-State", "previous-build");
    }
    if (frontendRebuilt) response.setHeader("X-Infans-Frontend-Rebuilt", "1");

    const absolute = resolveStaticPath(distDir, request.url);
    if (!absolute) return next();

    let target = absolute;
    let cachePath = pathname;
    if (!(await statFile(target))) {
      // SPA fallback：/schedule、/markets/assets 这类前端路由要能直接刷新。
      // 带扩展名的缺失资源仍回 404，不要拿 HTML 冒充图片或 chunk。
      if (path.extname(pathname)) return next();
      target = indexFile;
      cachePath = "/index.html";
    }

    const extension = path.extname(target).toLowerCase();
    const chosen = await negotiate(target, extension, acceptedEncodings(request.headers["accept-encoding"]));
    if (!chosen) return next();

    const etag = `W/"${chosen.stat.size.toString(16)}-${Math.trunc(chosen.stat.mtimeMs).toString(16)}${chosen.encoding ? `-${chosen.encoding}` : ""}"`;
    // 上游中间件已为版本化 AVIF 定过策略（含缓存幽灵的 no-store 兜底），不要覆盖。
    if (!response.getHeader("Cache-Control")) response.setHeader("Cache-Control", cacheControlFor(cachePath));
    response.setHeader("Content-Type", CONTENT_TYPES.get(extension) || "application/octet-stream");
    response.setHeader("ETag", etag);
    response.setHeader("Last-Modified", new Date(chosen.stat.mtimeMs).toUTCString());
    if (COMPRESSIBLE.has(extension)) response.setHeader("Vary", "Accept-Encoding");
    if (chosen.encoding) response.setHeader("Content-Encoding", chosen.encoding);

    if (request.headers["if-none-match"] === etag) {
      response.statusCode = 304;
      response.removeHeader("Content-Type");
      return response.end();
    }

    response.statusCode = 200;
    response.setHeader("Content-Length", chosen.stat.size);
    if (request.method === "HEAD") return response.end();
    response.end(await fs.readFile(chosen.file));
  };
}
