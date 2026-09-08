import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createResidentModeService,
  RESIDENT_MODE_COMMAND,
  RESIDENT_MODE_TIMEOUT_SECONDS,
  residentModeArguments,
} from "../src/server/workbench-resident-mode.mjs";

class FakeChild extends EventEmitter {
  killedWith = null;

  kill(signal) {
    this.killedWith = signal;
    this.emit("exit", 0, signal);
    return true;
  }
}

test("常驻模式使用临时 caffeinate 断言并在关闭时完整撤销", async () => {
  const calls = [];
  const fakeChild = new FakeChild();
  const service = createResidentModeService({
    platform: "darwin",
    parentPid: 2468,
    now: () => new Date("2026-09-02T10:00:00.000Z"),
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => fakeChild.emit("spawn"));
      return fakeChild;
    },
  });

  assert.equal(service.read().enabled, false);
  const enabled = await service.setEnabled(true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.enabledAt, "2026-09-02T10:00:00.000Z");
  assert.deepEqual(calls, [{
    command: RESIDENT_MODE_COMMAND,
    args: ["-d", "-i", "-s", "-u", "-t", String(RESIDENT_MODE_TIMEOUT_SECONDS), "-w", "2468"],
    options: { stdio: "ignore" },
  }]);

  const disabled = await service.setEnabled(false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.enabledAt, null);
  assert.equal(fakeChild.killedWith, "SIGTERM");
});

test("常驻模式不写入永久系统设置且跟随工作台进程退出", () => {
  const args = residentModeArguments(1357);
  assert.deepEqual(args.slice(-2), ["-w", "1357"]);
  assert.equal(args.includes("pmset"), false);
  assert.equal(args.includes("defaults"), false);
});

test("非 Mac 环境明确拒绝开启", async () => {
  const service = createResidentModeService({ platform: "linux" });
  assert.equal(service.read().supported, false);
  await assert.rejects(
    () => service.setEnabled(true),
    (error) => error?.code === "RESIDENT_MODE_UNSUPPORTED" && error?.status === 501,
  );
});

test("断言进程意外退出后状态不会继续冒充已开启", async () => {
  const fakeChild = new FakeChild();
  const service = createResidentModeService({
    platform: "darwin",
    spawnProcess() {
      queueMicrotask(() => fakeChild.emit("spawn"));
      return fakeChild;
    },
  });

  await service.setEnabled(true);
  fakeChild.emit("exit", 1, null);
  const status = service.read();
  assert.equal(status.enabled, false);
  assert.match(status.error, /意外停止/u);
});

test("并发开启只创建一条系统断言", async () => {
  const fakeChild = new FakeChild();
  let spawnCount = 0;
  const service = createResidentModeService({
    platform: "darwin",
    spawnProcess() {
      spawnCount += 1;
      queueMicrotask(() => fakeChild.emit("spawn"));
      return fakeChild;
    },
  });

  const [first, second] = await Promise.all([service.setEnabled(true), service.setEnabled(true)]);
  assert.equal(spawnCount, 1);
  assert.equal(first.enabled, true);
  assert.equal(second.enabled, true);
  service.dispose();
});

test("系统设置只提供关灯和常亮开关，接口受私人设备边界保护", () => {
  const page = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const routeStart = routes.indexOf('router.use("/api/tools/resident-mode"');
  const routeEnd = routes.indexOf('router.use("/api/tools/lights-off"', routeStart);
  const residentRoute = routes.slice(routeStart, routeEnd);

  assert.ok(page.includes(">常亮</span>"));
  assert.ok(page.includes('jsonFetch<ResidentModeStatus>("/api/tools/resident-mode"'));
  assert.equal(page.includes("residentModeTask"), false);
  assert.ok(routeStart >= 0);
  assert.ok(residentRoute.includes("assertPrivateAssetAccess(request)"));
  assert.ok(residentRoute.includes('request.method === "GET"'));
  assert.ok(residentRoute.includes('request.method !== "POST"'));
  assert.ok(routes.includes("residentMode.dispose()"));
});
