import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RELEASE_GATES, assertGateReceipt, assertReleaseResult, digest, gateCommand, recordGate, releaseInputs, testFailureFingerprint, validateTestDebt } from "../scripts/workbench-version-gates.mjs";

const inputs = { fingerprint: "current" };
const green = () => ({ schemaVersion: 1, fingerprint: "current", gates: Object.fromEntries(RELEASE_GATES.map((gate) => [gate, { exitCode: 0, inputsUnchanged: true }])) });

test("升版拒绝缺检查、失败、检查期间改动、旧回执及重复使用", () => {
  assert.doesNotThrow(() => assertGateReceipt(green(), inputs));
  for (const gate of RELEASE_GATES) {
    const missing = green(); delete missing.gates[gate];
    assert.throws(() => assertGateReceipt(missing, inputs), new RegExp(gate));
    const failed = green(); failed.gates[gate].exitCode = 1;
    assert.throws(() => assertGateReceipt(failed, inputs), new RegExp(gate));
    const changed = green(); changed.gates[gate].inputsUnchanged = false;
    assert.throws(() => assertGateReceipt(changed, inputs), new RegExp(gate));
  }
  assert.throws(() => assertGateReceipt({ ...green(), fingerprint: "old" }, inputs));
  assert.throws(() => assertGateReceipt({ ...green(), applied: {} }, inputs));
  const debt = green(); debt.gates.test.exitCode = 1;
  assert.doesNotThrow(() => assertGateReceipt(debt, inputs, { allowTestDebt: true }));
  debt.gates.build.exitCode = 1;
  assert.throws(() => assertGateReceipt(debt, inputs, { allowTestDebt: true }), /build/);
});

test("候选专项必须指定真实测试形式，不能用空命令或路径逃逸代替", () => {
  assert.throws(() => gateCommand("candidate", []));
  assert.throws(() => gateCommand("candidate", ["tests/../../escape.test.mjs"]));
  assert.deepEqual(gateCommand("candidate", ["tests/workbench-version.test.mjs"]).slice(1), ["--experimental-strip-types", "--test", "tests/workbench-version.test.mjs"]);
  assert.deepEqual(gateCommand("performance"), ["pnpm", "check:performance"]);
});

test("只改版本号、旧服务、假健康、仍有候选均不得显示成功", () => {
  const packageText = '{"version":"1.17.0"}';
  const changelog = "正式日志";
  const valid = {
    packageText, changelog,
    receipt: { applied: { version: "1.17.0", packageHash: digest(packageText), changelogHash: digest(changelog) } },
    inspection: { currentVersion: "1.17.0", state: "none" },
    health: { version: "1.17.0", ok: true, localOnly: true, controlledWrites: true },
  };
  assert.doesNotThrow(() => assertReleaseResult(valid));
  assert.throws(() => assertReleaseResult({ ...valid, receipt: {} }), /回执/);
  assert.throws(() => assertReleaseResult({ ...valid, changelog: "别人改了日志" }), /回执/);
  for (const state of ["ready", "blocked"]) assert.throws(() => assertReleaseResult({ ...valid, inspection: { ...valid.inspection, state } }), /队列/);
  for (const change of [{ version: "1.16.0" }, { ok: false }, { localOnly: false }, { controlledWrites: false }]) {
    assert.throws(() => assertReleaseResult({ ...valid, health: { ...valid.health, ...change } }), /健康/);
  }
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "version-gates-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "00_本地工作台/app");
  const evidence = path.join(root, "00_本地工作台/30_证据/AI定时任务运行包/workbench-daily-release");
  const changelogPath = path.join(root, "00_本地工作台/20_记录/Infans本地工作台_更新日志.md");
  await fs.mkdir(path.join(appRoot, "src"), { recursive: true });
  await fs.mkdir(path.dirname(changelogPath), { recursive: true });
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(changelogPath, "log");
  await fs.writeFile(path.join(appRoot, "src/app.js"), "old");
  return { appRoot, evidence, changelogPath, root };
}

test("命令返回值如实入回执；执行期间源码和交接改动都使回执失效", async (t) => {
  const { appRoot, evidence, changelogPath } = await fixture(t);
  const receiptPath = path.join(evidence, "first.gates.json");
  assert.equal(await recordGate({ appRoot, changelog: "log", receiptPath, gate: "build", run: async () => ({ exitCode: 3, output: "failed" }) }), 3);
  assert.equal(JSON.parse(await fs.readFile(receiptPath)).gates.build.exitCode, 3);
  await assert.rejects(recordGate({ appRoot, changelog: "log", receiptPath, gate: "check", run: async () => {
    await fs.writeFile(changelogPath, "changed");
    return { exitCode: 0, output: "" };
  } }), /发生变化/);
  assert.equal(JSON.parse(await fs.readFile(receiptPath)).gates.check.inputsUnchanged, false);
  await assert.rejects(recordGate({ appRoot, changelog: "changed", receiptPath, gate: "build" }), /新回执/);
  const before = await releaseInputs(appRoot, "changed");
  await fs.writeFile(path.join(appRoot, "src/app.js"), "new");
  assert.notEqual((await releaseInputs(appRoot, "changed")).fingerprint, before.fingerprint);
});

test("旧测试欠账必须匹配前次失败、未变路径和开放修复任务", async (t) => {
  const { root, appRoot, evidence } = await fixture(t);
  const tasksPath = path.join(root, "30_事业顺利/小秘书/项目进度与待办.md");
  await fs.mkdir(path.dirname(tasksPath), { recursive: true });
  await fs.writeFile(tasksPath, "- [ ] 公司：修复：旧测试｜ID：old-failure\n");
  const previousReceipt = path.join(evidence, "previous.gates.json");
  const current = { startedAt: "2026-09-05", files: { "tests/old.test.mjs": "same" }, gates: { test: { exitCode: 1, inputsUnchanged: true, failureFingerprint: "failure" } } };
  await fs.writeFile(previousReceipt, JSON.stringify({ ...current, startedAt: "2026-09-04" }));
  const file = path.join(evidence, "debt.json");
  const debt = { previousReceipt, repairTaskId: "old-failure", failurePaths: ["tests/old.test.mjs"], unrelatedReason: "该旧测试与本批候选及依赖无关" };
  await fs.writeFile(file, JSON.stringify(debt));
  assert.equal((await validateTestDebt(appRoot, current, file)).repairTaskId, "old-failure");
  const changed = structuredClone(current); changed.gates.test.failureFingerprint = "new regression";
  await assert.rejects(validateTestDebt(appRoot, changed, file));
  await fs.writeFile(tasksPath, "- [x] 公司：修复：旧测试｜ID：old-failure\n");
  await assert.rejects(validateTestDebt(appRoot, current, file));
});

test("测试失败指纹不包含易变耗时，但保留不同错误", () => {
  const output = "not ok 1 - example\n  ---\n  duration_ms: 1\n  error: wrong\n  stack: |-\n    at line1\n  ...\n1..1\n";
  assert.ok(testFailureFingerprint(output));
  assert.equal(testFailureFingerprint(output), testFailureFingerprint(output.replace("duration_ms: 1", "duration_ms: 20")));
  assert.notEqual(testFailureFingerprint(output), testFailureFingerprint(output.replace("wrong", "different")));
  assert.equal(testFailureFingerprint("process died"), null);
});
