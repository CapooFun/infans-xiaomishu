import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertAuthorizedWriteAccess, assertAuthorizedWriteIdentity, assertTrustedOrigin, assertLoopbackOnly, assertPrivateAssetAccess } from "../src/server/workbench-routes.mjs";
import { assertCodexCommandDeviceAccess } from "../src/server/workbench-codex-command-inbox.mjs";
import { WorkbenchWriteError } from "../src/server/workbench-errors.mjs";

const TAILSCALE_HOST = "mailbox.example.invalid";

function fakeRequest({
  host,
  origin,
  remoteAddress = "127.0.0.1",
  tailscaleLogin,
  fetchSite,
  userAgent,
  forwardedFor,
  authorization,
  contentType = "application/json",
} = {}) {
  return {
    socket: { remoteAddress },
    headers: {
      host,
      origin,
      "tailscale-user-login": tailscaleLogin,
      "sec-fetch-site": fetchSite,
      "user-agent": userAgent,
      "x-forwarded-for": forwardedFor,
      "content-type": contentType,
      authorization,
    },
  };
}

function isPrivateAccessDenied(error) {
  return error instanceof WorkbenchWriteError && error.status === 403 && error.code === "PRIVATE_ACCESS_REQUIRED";
}

function isWriteAccessDenied(error) {
  return error instanceof WorkbenchWriteError && error.status === 403 && error.code === "WRITE_ACCESS_DENIED";
}

test("Mac iPad and iPhone share the same trusted read boundary", () => {
  assert.doesNotThrow(() => assertTrustedOrigin(fakeRequest({
    host: "127.0.0.1:5173",
    origin: "http://127.0.0.1:5173",
    userAgent: "Mac Safari",
  })));
  for (const userAgent of ["iPad Safari", "iPhone Safari"]) {
    assert.doesNotThrow(() => assertTrustedOrigin(fakeRequest({
      host: TAILSCALE_HOST,
      origin: `https://${TAILSCALE_HOST}`,
      userAgent,
    })));
  }
});

test("移动聊天附件复用设备 Bearer 和私有来源门，但允许受支持的二进制正文", () => {
  const token = "x".repeat(43);
  const binary = fakeRequest({
    host: "127.0.0.1:5173",
    origin: "http://127.0.0.1:5173",
    contentType: "image/png",
    authorization: `Bearer ${token}`,
  });
  assert.throws(
    () => assertCodexCommandDeviceAccess(binary, "", token),
    (error) => error?.code === "CONTENT_TYPE_REQUIRED",
  );
  assert.doesNotThrow(() => assertCodexCommandDeviceAccess(binary, "", token, { requireJson: false }));
  assert.throws(
    () => assertCodexCommandDeviceAccess({ ...binary, headers: { ...binary.headers, origin: "http://evil.example" } }, "", token, { requireJson: false }),
    (error) => error?.code === "CODEX_COMMAND_ACCESS_DENIED",
  );
});

test("cron read and authorized rerun use the same three-device identity policy", () => {
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const runRoute = routes.slice(
    routes.indexOf('router.use("/api/tools/cron/run"'),
    routes.indexOf('router.use("/api/tools/cron"'),
  );
  const readRoute = routes.slice(
    routes.indexOf('router.use("/api/tools/cron"'),
    routes.indexOf('router.use("/api/tools/japan-activities"'),
  );

  assert.ok(runRoute.includes("assertPersistentWrite(request)"));
  assert.equal(runRoute.includes("assertLoopbackOnly(request)"), false);
  assert.ok(runRoute.includes('request.method !== "POST"'));
  assert.ok(readRoute.includes("assertTrustedOrigin(request)"));
  assert.ok(readRoute.includes("readCronMonitor(root)"));
  assert.equal(readRoute.includes("assertLoopbackOnly(request)"), false);
  assert.equal(readRoute.includes("navigator.userAgent"), false);
  assert.equal(routes.includes("资产管理仅允许本机访问"), false);
});

test("日本活动三端同权读取，感兴趣标记仍走远程身份门禁", () => {
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const activityRoute = routes.slice(
    routes.indexOf('router.use("/api/tools/japan-activities"'),
    routes.indexOf('router.use("/api/tools/renewals"'),
  );
  assert.ok(activityRoute.includes('request.method === "GET"'));
  assert.ok(activityRoute.includes("assertTrustedOrigin(request)"));
  assert.ok(activityRoute.includes('request.method === "PATCH"'));
  assert.ok(activityRoute.includes("assertPersistentWrite(request)"));
  assert.equal(activityRoute.includes("assertLoopbackOnly(request)"), false);
});

test("loopback-only actions reject spoofed Host from a non-loopback peer", () => {
  assert.throws(
    () => assertLoopbackOnly(fakeRequest({
      host: "127.0.0.1:5173",
      origin: "http://127.0.0.1:5173",
      remoteAddress: "203.0.113.9",
    })),
    (error) => error instanceof WorkbenchWriteError && error.code === "ORIGIN_REJECTED",
  );
  assert.doesNotThrow(() => assertLoopbackOnly(fakeRequest({
    host: "127.0.0.1:5173",
    origin: "http://127.0.0.1:5173",
    remoteAddress: "127.0.0.1",
  })));
});

test("loopback-only actions no longer report an asset-reading error", () => {
  assert.throws(
    () => assertLoopbackOnly(fakeRequest({ host: TAILSCALE_HOST, origin: `https://${TAILSCALE_HOST}` })),
    (error) => error instanceof WorkbenchWriteError
      && error.code === "ORIGIN_REJECTED"
      && error.message === "这个操作仅支持在 Mac 本机执行",
  );
});

test("loopback asset access remains allowed", () => {
  for (const hostname of ["127.0.0.1", "localhost"]) {
    const request = fakeRequest({ host: `${hostname}:5173`, origin: `http://${hostname}:5173` });
    assert.doesNotThrow(() => assertTrustedOrigin(request));
    assert.doesNotThrow(() => assertLoopbackOnly(request));
    assert.doesNotThrow(() => assertPrivateAssetAccess(request));
  }
});

test("a verified Tailscale Serve identity grants private asset access on any client layout", () => {
  for (const userAgent of ["Desktop Safari", "iPad Safari", "iPhone Safari"]) {
    assert.doesNotThrow(() => assertPrivateAssetAccess(fakeRequest({
      host: TAILSCALE_HOST,
      origin: `https://${TAILSCALE_HOST}`,
      tailscaleLogin: "verified-tailnet-member",
      fetchSite: "same-origin",
      userAgent,
    })));
  }
});

test("Tailscale Host without a Serve-injected identity fails closed", () => {
  assert.throws(() => assertPrivateAssetAccess(fakeRequest({
    host: TAILSCALE_HOST,
    origin: `https://${TAILSCALE_HOST}`,
  })), isPrivateAccessDenied);
});

test("Host Origin UA and ordinary proxy headers cannot forge asset access", () => {
  assert.throws(() => assertPrivateAssetAccess(fakeRequest({
    host: TAILSCALE_HOST,
    origin: `https://${TAILSCALE_HOST}`,
    userAgent: "Mobile Safari trusted-device",
    forwardedFor: "127.0.0.1",
  })), isPrivateAccessDenied);
});

test("a claimed identity from a non-loopback direct peer is rejected", () => {
  assert.throws(() => assertPrivateAssetAccess(fakeRequest({
    host: TAILSCALE_HOST,
    origin: `https://${TAILSCALE_HOST}`,
    remoteAddress: "100.64.0.90",
    tailscaleLogin: "forged-member",
  })), isPrivateAccessDenied);
});

test("cross-origin and cross-site requests are rejected even with a Serve identity", () => {
  assert.throws(() => assertPrivateAssetAccess(fakeRequest({
    host: TAILSCALE_HOST,
    origin: "https://evil.example",
    tailscaleLogin: "verified-tailnet-member",
  })), isPrivateAccessDenied);
  assert.throws(() => assertPrivateAssetAccess(fakeRequest({
    host: TAILSCALE_HOST,
    origin: `https://${TAILSCALE_HOST}`,
    fetchSite: "cross-site",
    tailscaleLogin: "verified-tailnet-member",
  })), isPrivateAccessDenied);
});

test("the legacy sslip route is never an asset authorization boundary", () => {
  assert.throws(() => assertPrivateAssetAccess(fakeRequest({
    host: "dev.example.invalid:8080",
    origin: "http://dev.example.invalid:8080",
    tailscaleLogin: "forged-member",
  })), isPrivateAccessDenied);
});

test("Mac 本机持久写入同时校验 Host、回环连接和同源", () => {
  assert.doesNotThrow(() => assertAuthorizedWriteAccess(fakeRequest({
    host: "127.0.0.1:5173",
    origin: "http://127.0.0.1:5173",
  })));
  assert.throws(() => assertAuthorizedWriteAccess(fakeRequest({
    host: "127.0.0.1:5173",
    origin: "http://127.0.0.1:5173",
    remoteAddress: "100.64.0.90",
  })), isWriteAccessDenied);
  assert.throws(() => assertAuthorizedWriteAccess(fakeRequest({
    host: "127.0.0.1:5173",
    origin: "http://evil.example",
  })), isWriteAccessDenied);
});

test("Mac iPad 和 iPhone 的远程写入只认 Serve 身份与服务端白名单", () => {
  for (const userAgent of ["Mac Safari", "iPad Safari", "iPhone Safari"]) {
    assert.doesNotThrow(() => assertAuthorizedWriteAccess(fakeRequest({
      host: TAILSCALE_HOST,
      origin: `https://${TAILSCALE_HOST}`,
      tailscaleLogin: "capoo@example.test",
      fetchSite: "same-origin",
      userAgent,
    }), ["capoo@example.test"]));
  }
  assert.throws(() => assertAuthorizedWriteAccess(fakeRequest({
    host: TAILSCALE_HOST,
    origin: `https://${TAILSCALE_HOST}`,
    tailscaleLogin: "capoo@example.test",
    fetchSite: "same-origin",
  }), []), isWriteAccessDenied);
  assert.throws(() => assertAuthorizedWriteAccess(fakeRequest({
    host: TAILSCALE_HOST,
    origin: `https://${TAILSCALE_HOST}`,
    tailscaleLogin: "someone-else@example.test",
    fetchSite: "same-origin",
  }), ["capoo@example.test"]), isWriteAccessDenied);
});

test("二进制附件和无正文同步复用同一身份门禁，不被 JSON 类型误伤", () => {
  assert.doesNotThrow(() => assertAuthorizedWriteIdentity(fakeRequest({
    host: TAILSCALE_HOST,
    origin: `https://${TAILSCALE_HOST}`,
    tailscaleLogin: "capoo@example.test",
    fetchSite: "same-origin",
    contentType: "image/png",
  }), ["capoo@example.test"]));
  assert.throws(() => assertAuthorizedWriteIdentity(fakeRequest({
    host: TAILSCALE_HOST,
    origin: `https://${TAILSCALE_HOST}`,
    tailscaleLogin: "someone-else@example.test",
    fetchSite: "same-origin",
    contentType: "image/png",
  }), ["capoo@example.test"]), isWriteAccessDenied);
});

test("持久写入都走身份门禁，语音和 AI 查询不被误当成持久写入", () => {
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  for (const route of ["/api/secretary-life-core", "/api/secretary", "/api/relationship-memory/preview", "/api/relationship-memory/commit", "/api/proactive-interactions", "/api/home-pins", "/api/sidebar-bookmarks", "/api/gantt-hidden", "/api/project-task-follows", "/api/assets/bills/import-downloads", "/api/assets/custody/import-downloads", "/api/tools/japan-activities", "/api/calendar/commit", "/api/apple-health/commit", "/api/language-reactor/commit", "/api/write/commit"]) {
    const start = routes.indexOf(`router.use("${route}"`);
    assert.notEqual(start, -1, route);
    assert.ok(routes.slice(start, start + 900).includes("assertPersistentWrite(request)"), route);
  }
  assert.doesNotMatch(routes, /\/api\/meining-(?:chats|attachments|guest-media)/);
  const secretaryChatRoute = routes.indexOf('router.use("/api/secretary-chats"');
  const secretaryAttachmentRoute = routes.indexOf('router.use("/api/secretary-attachments"');
  assert.ok(routes.slice(secretaryChatRoute, secretaryChatRoute + 1_100).includes("assertPersistentWrite(request)"));
  assert.ok(routes.slice(secretaryAttachmentRoute, secretaryAttachmentRoute + 900).includes("assertPersistentWriteIdentity(request)"));
  assert.equal(routes.includes('router.use("/api/tools/kitchen-orders"'), false);
  assert.doesNotMatch(routes, /hosted-activities|syncKitchenOrders/u);
  for (const route of ["/api/tts", "/api/ai/query"]) {
    const start = routes.indexOf(`router.use("${route}"`);
    assert.notEqual(start, -1, route);
    assert.ok(routes.slice(start, start + 700).includes("assertLocalWriteRequest(request)"), route);
  }
});

test("关系记忆和主动互动的嵌套路由先于集合路由注册", () => {
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const relationshipBase = routes.indexOf('router.use("/api/relationship-memory",');
  assert.ok(routes.indexOf('router.use("/api/relationship-memory/preview"') < relationshipBase);
  assert.ok(routes.indexOf('router.use("/api/relationship-memory/commit"') < relationshipBase);
  const proactiveBase = routes.indexOf('router.use("/api/proactive-interactions",');
  assert.ok(routes.indexOf('router.use("/api/proactive-interactions/pull"') < proactiveBase);
  assert.ok(routes.indexOf('router.use("/api/proactive-interactions/ack"') < proactiveBase);
});

test("mismatched Origin remains rejected for ordinary workbench writes", () => {
  assert.throws(
    () => assertTrustedOrigin(fakeRequest({ host: "127.0.0.1:5173", origin: "http://evil.example" })),
    (error) => error instanceof WorkbenchWriteError && error.code === "ORIGIN_REJECTED",
  );
});
