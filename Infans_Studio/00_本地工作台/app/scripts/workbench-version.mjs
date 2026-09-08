#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { applyDailyVersion, decideDailyVersion, parsePendingChangeBlocks, validateVersionHandoffs } from "./workbench-version-core.mjs";
import { assertGateReceipt, assertReleaseResult, checkedReceiptPath, digest, readReleaseHealth, recordGate, releaseInputs, validateTestDebt, writeReceipt } from "./workbench-version-gates.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(appRoot, "package.json");
const changelogPath = path.resolve(appRoot, "../20_记录/Infans本地工作台_更新日志.md");
const lockPath = path.join(appRoot, ".workbench-version.lock");

function tokyoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

async function readState() {
  const [packageText, changelog] = await Promise.all([
    fs.readFile(packagePath, "utf8"),
    fs.readFile(changelogPath, "utf8"),
  ]);
  return { packageText, changelog };
}

function printInspection(packageText, changelog) {
  const packageJson = JSON.parse(packageText);
  const parsed = parsePendingChangeBlocks(changelog);
  const decision = decideDailyVersion(parsed.blocks);
  const result = {
    currentVersion: packageJson.version,
    changelogVersion: parsed.currentVersion,
    state: decision.state,
    level: decision.level,
    pendingHeadings: parsed.blocks.length,
    logicalTasks: decision.eligible.length + decision.unresolved.length + decision.resolvedWithoutBump.length,
    mergedTaskGroups: [...decision.eligible, ...decision.unresolved, ...decision.resolvedWithoutBump]
      .filter((task) => task.revisionCount > 1).length,
    eligible: decision.eligible.map((block) => block.handoff.task),
    unresolved: decision.unresolved.map((block) => block.handoff.task),
    blockers: decision.blockers,
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`小秘书当前版本：V${result.currentVersion}`);
  console.log(`版本收口判断：${result.state}${result.level ? `（${result.level}）` : ""}`);
  console.log(`待清点：${result.pendingHeadings} 个更新标题，归并为 ${result.logicalTasks} 个稳定任务 ID（${result.mergedTaskGroups} 组有重复交接）`);
  if (result.eligible.length) console.log(`可收录：${result.eligible.join("、")}`);
  if (result.unresolved.length) console.log(`继续保留进行中：${result.unresolved.join("、")}`);
  for (const blocker of result.blockers) console.log(`阻塞：${blocker}`);
}

async function writeAtomically(target, content) {
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, target);
}

const command = process.argv[2] || "inspect";
if (command === "inspect") {
  const { packageText, changelog } = await readState();
  printInspection(packageText, changelog);
} else if (command === "handoff-check") {
  const { changelog } = await readState();
  const taskId = argument("--task", process.env.INFANS_VERSION_TASK_ID);
  // HEAD 只用于识别新增交接，历史错误不会被本次检查重新认领。
  const baseline = taskId ? "" : execFileSync("git", ["show", "HEAD:00_本地工作台/20_记录/Infans本地工作台_更新日志.md"], { cwd: appRoot, encoding: "utf8" });
  const result = validateVersionHandoffs(changelog, { baseline, taskId });
  for (const error of result.errors) console.error(error);
  console.log(`版本交接校验：检查 ${result.checked} 个条目，${result.errors.length} 个格式问题。状态只填 已验证/已验收/待验收/进行中；运行只填 已启用/已隔离/未进入运行/不适用，说明写入遗留。`);
  process.exitCode = result.errors.length ? 1 : 0;
} else if (command === "gate") {
  const receiptPath = await checkedReceiptPath(appRoot, argument("--receipt", process.env.INFANS_RELEASE_GATE_RECEIPT));
  const { changelog } = await readState();
  process.exitCode = await recordGate({ appRoot, changelog, receiptPath, gate: argument("--gate"), tests: argument("--tests").split(",").filter(Boolean) });
} else if (command === "verify") {
  let receiptPath = await checkedReceiptPath(appRoot, argument("--receipt", process.env.INFANS_RELEASE_GATE_RECEIPT));
  let receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (receipt.finalReceipt) {
    receiptPath = await checkedReceiptPath(appRoot, receipt.finalReceipt);
    receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  }
  const state = await readState();
  const inputs = await releaseInputs(appRoot, state.changelog);
  const currentFiles = { ...inputs.files, "package.json": receipt.files?.["package.json"] };
  if (JSON.stringify(currentFiles) !== JSON.stringify(receipt.files)) throw new Error("升版检查后工程发生变化，请重新收口；本次不能显示成功");
  const [distStat, packageStat] = await Promise.all([fs.stat(path.join(appRoot, "dist/index.html")), fs.stat(packagePath)]);
  if (distStat.mtimeMs < packageStat.mtimeMs) throw new Error("版本文件更新后尚未完成生产构建");
  const parsed = parsePendingChangeBlocks(state.changelog);
  const inspection = { currentVersion: parsed.currentVersion, ...decideDailyVersion(parsed.blocks) };
  const health = await readReleaseHealth();
  assertReleaseResult({ receipt, ...state, inspection, health });
  receipt.verifiedAt = new Date().toISOString();
  await writeReceipt(receiptPath, receipt);
  console.log(`程序复核通过：V${health.version}，本轮门禁、正式版本头、最终队列与运行健康一致`);
} else if (command === "apply") {
  // 先读取真实命令回执；没有回执时，即使交接写了“已验证”也不能改版本。
  const receiptPath = await checkedReceiptPath(appRoot, argument("--receipt", process.env.INFANS_RELEASE_GATE_RECEIPT));
  let lock;
  try {
    lock = await fs.open(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("另一个小秘书升版流程正在运行；本次没有改文件");
    throw error;
  }

  try {
    const state = await readState();
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    const inputs = await releaseInputs(appRoot, state.changelog);
    const testDebt = await validateTestDebt(appRoot, receipt, argument("--test-debt"));
    assertGateReceipt(receipt, inputs, { allowTestDebt: Boolean(testDebt) });
    const result = applyDailyVersion({
      ...state,
      date: argument("--date", tokyoDate()),
      title: argument("--title", "每日稳定基线"),
    });
    const rechecked = await readState();
    if (rechecked.packageText !== state.packageText || rechecked.changelog !== state.changelog) throw new Error("升版前原件发生变化，请重新检查");
    await writeAtomically(packagePath, result.packageText);
    try {
      await writeAtomically(changelogPath, result.changelog);
    } catch (error) {
      await writeAtomically(packagePath, state.packageText);
      throw error;
    }
    receipt.testDebt = testDebt;
    receipt.applied = { version: result.version, packageHash: digest(result.packageText), changelogHash: digest(result.changelog), appliedAt: new Date().toISOString() };
    await writeReceipt(receiptPath, receipt);
    if (process.env.INFANS_RELEASE_GATE_RECEIPT) {
      const initialPath = await checkedReceiptPath(appRoot, process.env.INFANS_RELEASE_GATE_RECEIPT);
      if (initialPath !== receiptPath) {
        const initial = await fs.readFile(initialPath, "utf8").then(JSON.parse).catch((error) => {
          if (error.code === "ENOENT") return {};
          throw error;
        });
        await writeReceipt(initialPath, { ...initial, finalReceipt: receiptPath });
      }
    }
    console.log(`版本文件已从 V${JSON.parse(state.packageText).version} 更新到 V${result.version}（${result.level}）；尚未确认升版成功，请重建重启后运行 pnpm version:verify`);
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
} else {
  throw new Error("用法：pnpm version:handoff-check / version:gate / version:inspect / version:auto / version:verify");
}
