import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createLightsOffService,
  LIGHTS_OFF_HELPER_SOURCE,
  LIGHTS_OFF_NOTE_OFF,
  LIGHTS_OFF_SWIFTC_ARGS,
  lightsOffHelperArguments,
} from "../src/server/workbench-lights-off.mjs";

class FakeChild extends EventEmitter {
  killedWith = null;
  exitCode = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  kill(signal) {
    this.killedWith = signal;
    this.exitCode = 0;
    this.emit("exit", 0, signal);
    this.emit("close", 0, signal);
    return true;
  }
}

test("关灯模式开启后保持助手进程，关闭时发 SIGTERM 恢复", async () => {
  const calls = [];
  const fakeChild = new FakeChild();
  const service = createLightsOffService({
    platform: "darwin",
    root: "/tmp/infans-lights-off",
    helperPath: "/tmp/infans-lights-off-helper",
    statePath: "/tmp/infans-lights-off-state.json",
    compileHelper: async () => {},
    now: () => new Date("2026-09-07T12:00:00.000Z"),
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => fakeChild.stdout.emit("data", Buffer.from("ready\n")));
      return fakeChild;
    },
  });

  assert.equal(service.read().enabled, false);
  assert.equal(service.read().note, LIGHTS_OFF_NOTE_OFF);
  const enabled = await service.setEnabled(true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.enabledAt, "2026-09-07T12:00:00.000Z");
  assert.deepEqual(calls, [{
    command: "/tmp/infans-lights-off-helper",
    args: lightsOffHelperArguments("on", "/tmp/infans-lights-off-state.json"),
    options: { stdio: ["ignore", "pipe", "pipe"] },
  }]);

  const disabled = await service.setEnabled(false);
  assert.equal(disabled.enabled, false);
  assert.equal(fakeChild.killedWith, "SIGTERM");
});

test("非 Mac 环境明确拒绝开启关灯模式", async () => {
  const service = createLightsOffService({ platform: "linux" });
  assert.equal(service.read().supported, false);
  await assert.rejects(
    () => service.setEnabled(true),
    (error) => error?.code === "LIGHTS_OFF_UNSUPPORTED" && error?.status === 501,
  );
});

test("关灯助手进程意外退出后状态不会继续冒充已开启", async () => {
  const fakeChild = new FakeChild();
  const service = createLightsOffService({
    platform: "darwin",
    helperPath: "/tmp/infans-lights-off-helper",
    statePath: "/tmp/infans-lights-off-state.json",
    compileHelper: async () => {},
    spawnProcess() {
      queueMicrotask(() => fakeChild.stdout.emit("data", Buffer.from("ready\n")));
      return fakeChild;
    },
  });

  await service.setEnabled(true);
  fakeChild.emit("exit", 1, null);
  const status = service.read();
  assert.equal(status.enabled, false);
  assert.equal(status.error, null);
});

test("关灯接口再按一次是切换，不先猜当前状态", async () => {
  const fakeChild = new FakeChild();
  const service = createLightsOffService({
    platform: "darwin",
    helperPath: "/tmp/infans-lights-off-helper",
    statePath: "/tmp/infans-lights-off-state.json",
    compileHelper: async () => {},
    spawnProcess() {
      queueMicrotask(() => fakeChild.stdout.emit("data", Buffer.from("ready\n")));
      return fakeChild;
    },
  });

  const enabled = await service.toggle();
  assert.equal(enabled.enabled, true);
  const disabled = await service.toggle();
  assert.equal(disabled.enabled, false);
  assert.equal(fakeChild.killedWith, "SIGTERM");
});

test("系统设置用关灯和常亮两个小开关，不含展示", () => {
  const page = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/workbench-personalization.css", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../native/lights-off-helper.swift", import.meta.url), "utf8");
  const lightsOffIndex = page.indexOf(">关灯</span>");
  const residentIndex = page.indexOf(">常亮</span>");
  const routeStart = routes.indexOf('router.use("/api/tools/lights-off"');
  const routeEnd = routes.indexOf('router.use("/api/display-mode/passkey/status"', routeStart);
  const lightsRoute = routes.slice(routeStart, routeEnd);

  assert.ok(lightsOffIndex > 0 && lightsOffIndex < residentIndex);
  assert.equal(page.includes(">展示</span>"), false);
  assert.match(page, /开源版不含展示模式/u);
  assert.match(page, /isMacDesktopBrowser/u);
  assert.match(page, /macRuntime \? \(/u);
  assert.equal(page.includes("settings-mode-chip"), false);
  assert.ok(page.includes('className="settings-mode-switch"'));
  assert.ok(page.includes("settings-mode-switch-track"));
  assert.match(styles, /grid-template-columns:repeat\(auto-fit,minmax\(0,1fr\)\)/u);
  assert.match(styles, /\.settings-mode-switches \{[^}]*border-radius:18px/u);
  assert.equal(page.includes("settings-toggle-row"), false);
  assert.match(page, /toggle: true/u);
  assert.ok(routeStart >= 0);
  assert.ok(lightsRoute.includes("assertPrivateAssetAccess(request)"));
  assert.ok(lightsRoute.includes("body?.toggle === true"));
  assert.ok(routes.includes("lightsOff.dispose()"));
  assert.match(helper, /CGShieldingWindowLevel/u);
  assert.match(helper, /builtinTarget: Float = 0\.07/u);
  assert.match(helper, /addLocalMonitorForEvents/u);
  assert.match(helper, /class ShieldWindow/u);
  assert.match(helper, /builtinCanDim/u);
  assert.match(helper, /handleInterrupt/u);
  assert.match(helper, /captureOriginal/u);
  assert.match(helper, /dimThreshold/u);
  assert.equal(helper.includes("withTimeInterval: 20"), false);
  assert.equal(helper.includes("?? CGMainDisplayID()"), false);
  assert.equal(LIGHTS_OFF_HELPER_SOURCE.endsWith("lights-off-helper.swift"), true);
  assert.deepEqual(LIGHTS_OFF_SWIFTC_ARGS.slice(-4), ["-framework", "AppKit", "-framework", "CoreGraphics"]);
});
