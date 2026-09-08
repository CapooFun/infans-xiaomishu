import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildLocalDevice,
  buildNasDevice,
  createDeviceDutyMonitor,
  parseLocalProbe,
  parseNasProbe,
  parseTerminalProbe,
} from "../src/server/workbench-device-duty.mjs";

test("Mac 探针只解析进程名与资源计数，并按差值计算写盘归属", () => {
  const first = parseLocalProbe([
    "meta\t8\t16000000000\t8000000000\t8000000000\t100\t20\t80\t800",
    "proc\t12\tExample Worker\t1000000000\t2000\t4000\t800000000",
  ].join("\n"));
  const second = parseLocalProbe([
    "meta\t8\t16000000000\t8200000000\t7800000000\t150\t30\t100\t820",
    "proc\t12\tExample Worker\t3000000000\t3000\t104898560\t900000000",
  ].join("\n"));
  const device = buildLocalDevice(second, first, 10);
  assert.equal(device.cpuPercent, 80);
  assert.equal(device.topProcesses[0].name, "Example Worker");
  assert.equal(device.topProcesses[0].cpuPercent, 20);
  assert.equal(device.topProcesses[0].writeBytesPerSecond, 10489456);
  assert.equal(JSON.stringify(device).includes("command arguments"), false);
});

test("NAS 只读输出可解析 CPU、内存、磁盘、温度和安全进程名", () => {
  const first = parseNasProbe([
    "cpu\tcpu 100 20 40 840 0 0 0 0",
    "mem\t8000000000\t4000000000",
    "disk\t1000\t3000",
    "temp\t51000",
    "fan\t980",
    "proc\t91\tsynoscgi\t2.5\t1.2\t120000",
  ].join("\n"));
  const second = parseNasProbe([
    "cpu\tcpu 120 20 50 910 0 0 0 0",
    "mem\t8000000000\t3200000000",
    "disk\t11000\t23000",
    "temp\t53000",
    "fan\t1000",
    "proc\t91\tsynoscgi\t3.5\t1.4\t140000",
  ].join("\n"));
  const device = buildNasDevice(second, first, 10);
  assert.equal(Math.round(device.cpuPercent), 30);
  assert.equal(device.diskWriteBytesPerSecond, 2000);
  assert.equal(device.temperatureC, 53);
  assert.equal(device.fanRpm, 1000);
  assert.equal(device.topProcesses[0].name, "synoscgi");
});

test("终端按 TTY 会话计数，不读取命令参数与工作目录", () => {
  const terminals = parseTerminalProbe([
    "  100     1 ??       01:02:03 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "  110   100 ttys001  00:42:10 /bin/zsh",
    "  120   110 ttys001  00:00:08 /usr/bin/python3",
    "  130   100 ttys002  00:05:00 /bin/zsh",
  ].join("\n"));
  assert.equal(terminals.count, 2);
  assert.equal(terminals.sessions[0].source, "终端");
  assert.equal(terminals.sessions[0].activeCommand, "python3");
  assert.equal(terminals.sessions[0].busy, true);
  assert.equal(JSON.stringify(terminals).includes("/Users/"), false);
});

test("值守先加密采样，连续两次忙碌才留下异常段，历史只在内存", async () => {
  let time = Date.parse("2026-09-05T00:00:00Z");
  let tick = 0;
  const local = () => ({
    logicalCpu: 8,
    memoryTotalBytes: 16_000_000_000,
    memoryUsedBytes: 15_200_000_000,
    cpuTicks: [100 + tick * 30, 0, 100 + tick * 30, 800 + tick * 40],
    processes: [{ pid: 7, name: "busy", cpuTimeNs: tick * 8_000_000_000, readBytes: 0, writeBytes: tick * 900_000_000, memoryBytes: 2_000_000_000 }],
  });
  const nas = () => ({ cpuTicks: [10 + tick, 0, 10 + tick, 80 + tick * 8], memoryTotalBytes: 8_000_000_000, memoryAvailableBytes: 4_000_000_000, diskReadBytes: 0, diskWriteBytes: 0, load: 0, temperatureC: 45, fanRpm: null, processes: [] });
  const monitor = createDeviceDutyMonitor({
    now: () => time,
    sampleLocal: async () => local(),
    sampleNas: async () => nas(),
    sampleTerminals: async () => ({ available: true, count: 1, sessions: [{ id: "ttys001", tty: "ttys001", source: "终端", shell: "zsh", activeCommand: null, busy: false, elapsedSeconds: 60 }], error: null }),
  });
  await monitor.refresh();
  assert.equal(monitor.read().events.length, 0);
  tick += 1;
  time += 10_000;
  await monitor.refresh();
  const snapshot = monitor.read();
  assert.equal(snapshot.mode, "watch");
  assert.equal(snapshot.sampleIntervalSeconds, 10);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.storage, "memory-only");
  assert.equal(snapshot.terminals.count, 1);
  assert.equal(snapshot.events[0].suspects[0], "busy");
  monitor.stop();
});

test("性能诊断只挂在异常雷达顶部，并随服务生命周期停止", () => {
  const toolsPage = readFileSync(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const cronStart = toolsPage.indexOf("function CronMonitorView");
  const panel = toolsPage.indexOf("<DeviceDutyPanel active={active} />");
  assert.ok(cronStart >= 0 && panel > cronStart);
  assert.equal(toolsPage.slice(0, cronStart).includes("<DeviceDutyPanel active={active} />"), false);
  assert.match(routes, /router\.use\("\/api\/tools\/device-duty"/);
  assert.ok(routes.indexOf('router.use("/api/tools/device-duty/codex-cleanup"') < routes.indexOf('router.use("/api/tools/device-duty",'));
  assert.match(routes, /deviceDuty\.start\(\)/);
  assert.match(routes, /deviceDuty\.stop\(\)/);
});
