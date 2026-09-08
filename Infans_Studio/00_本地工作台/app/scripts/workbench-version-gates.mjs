import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export const RELEASE_GATES = ["candidate", "check", "test", "build", "performance", "diff"];
export const digest = (value) => createHash("sha256").update(value).digest("hex");

// 只核对本轮检查期间的工程变化，不保存发布快照或冻结日常开发。
export async function releaseInputs(appRoot, changelog) {
  const files = {};
  async function visit(relative, metadataOnly = false) {
    const absolute = path.join(appRoot, relative);
    const stat = await fs.lstat(absolute).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      files[relative] = digest(await fs.readlink(absolute));
    } else if (stat.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) await visit(`${relative}/${name}`, metadataOnly);
    } else if (stat.isFile()) {
      files[relative] = metadataOnly ? digest(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`) : digest(await fs.readFile(absolute));
    }
  }
  for (const root of ["src", "scripts", "tests", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.node.json", "package.json", "pnpm-lock.yaml"]) await visit(root);
  await visit("public", true);
  return { fingerprint: digest(JSON.stringify({ files, changelog: digest(changelog) })), files };
}

export async function writeReceipt(file, receipt) {
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

export async function checkedReceiptPath(appRoot, supplied) {
  if (!supplied) throw new Error("缺少本轮门禁回执；使用定时岗位注入的 INFANS_RELEASE_GATE_RECEIPT，或 --receipt 指定证据目录中的新 .gates.json 文件");
  const root = await fs.realpath(path.resolve(appRoot, "../30_证据/AI定时任务运行包/workbench-daily-release"));
  const absolute = path.resolve(appRoot, supplied);
  if (await fs.realpath(path.dirname(absolute)) !== root || !absolute.endsWith(".gates.json")) {
    throw new Error("门禁回执只能位于既有 workbench-daily-release 证据目录，文件名以 .gates.json 结尾");
  }
  const stat = await fs.lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw new Error("门禁回执不得为符号链接");
  return absolute;
}

export function gateCommand(gate, tests = []) {
  if (!RELEASE_GATES.includes(gate)) throw new Error(`未知门禁：${gate}`);
  if (gate === "candidate") {
    if (!tests.length || tests.some((file) => !/^tests\/[\w./-]+\.test\.mjs$/.test(file) || file.includes(".."))) {
      throw new Error("candidate 必须通过 --tests 指定本批 tests/*.test.mjs（多个文件用逗号分隔）");
    }
    return [process.execPath, "--experimental-strip-types", "--test", ...tests];
  }
  if (gate === "diff") return ["git", "diff", "--check"];
  return ["pnpm", gate === "performance" ? "check:performance" : gate];
}

export async function executeGate(command, appRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd: appRoot, env: { ...process.env, INFANS_VERSION_TASK_ID: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ exitCode: code ?? 1, signal, output }));
  });
}

export function testFailureFingerprint(output) {
  // 保留失败名称与错误正文，剔除耗时及堆栈，方便与前一轮实测对照。
  const failures = [...output.matchAll(/^not ok [\s\S]*?(?=^(?:ok |not ok |# Subtest:|1\.\.))/gm)]
    .map((match) => match[0].replace(/^not ok \d+ /, "not ok ")
      .replace(/^\s*(?:duration_ms|location):.*\n/gm, "")
      .replace(/\n\s+stack: [\s\S]*$/, "").trim());
  return failures.length ? digest(JSON.stringify(failures)) : null;
}

export async function recordGate({ appRoot, changelog, receiptPath, gate, tests, run = executeGate }) {
  const inputs = await releaseInputs(appRoot, changelog);
  let receipt = await fs.readFile(receiptPath, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (receipt?.applied) throw new Error("本回执已用于一次升版；下一批必须使用新回执");
  if (receipt && receipt.fingerprint !== inputs.fingerprint) {
    throw new Error("工程或交接已经变化；请使用新回执重新运行本批门禁，旧证据保留");
  }
  receipt ??= { schemaVersion: 1, startedAt: new Date().toISOString(), ...inputs, gates: {} };
  const command = gateCommand(gate, tests);
  const result = await run(command, appRoot);
  const currentChangelog = await fs.readFile(path.resolve(appRoot, "../20_记录/Infans本地工作台_更新日志.md"), "utf8");
  const after = await releaseInputs(appRoot, currentChangelog);
  receipt.gates[gate] = {
    command, exitCode: result.exitCode, finishedAt: new Date().toISOString(),
    inputsUnchanged: inputs.fingerprint === after.fingerprint,
    failureFingerprint: gate === "test" && result.exitCode !== 0 ? testFailureFingerprint(result.output) : null,
  };
  await writeReceipt(receiptPath, receipt);
  if (after.fingerprint !== inputs.fingerprint) throw new Error("检查期间工程或交接发生变化，本回执不能用于升版");
  return result.exitCode;
}

export function assertGateReceipt(receipt, inputs, { allowTestDebt = false } = {}) {
  if (receipt?.schemaVersion !== 1 || receipt.applied || receipt.fingerprint !== inputs.fingerprint) {
    throw new Error("门禁回执缺失、已使用或不对应当前工程与交接");
  }
  for (const gate of RELEASE_GATES) {
    const result = receipt.gates?.[gate];
    if (!result || !result.inputsUnchanged || (result.exitCode !== 0 && !(gate === "test" && allowTestDebt))) {
      throw new Error(`门禁尚未通过：${gate}`);
    }
  }
}

/** 旧测试欠账的业务无关性仍由收口者负责说明；程序核实前次失败和独立任务。 */
export async function validateTestDebt(appRoot, receipt, file) {
  if (!file) return null;
  const debt = JSON.parse(await fs.readFile(file, "utf8"));
  const previousPath = await checkedReceiptPath(appRoot, debt.previousReceipt);
  const previous = JSON.parse(await fs.readFile(previousPath, "utf8"));
  const currentTest = receipt.gates?.test;
  const previousTest = previous.gates?.test;
  const tasks = await fs.readFile(path.resolve(appRoot, "../../30_事业顺利/小秘书/项目进度与待办.md"), "utf8");
  const taskLine = tasks.split("\n").find((line) => line.startsWith("- [ ]") && line.split("｜").some((field) => field.trim() === `ID：${debt.repairTaskId}`));
  if (!currentTest?.failureFingerprint || currentTest.exitCode === 0 || previousTest?.exitCode === 0
      || !previousTest?.inputsUnchanged || previousTest?.failureFingerprint !== currentTest.failureFingerprint
      || !(previous.startedAt < receipt.startedAt) || !taskLine || !debt.unrelatedReason?.trim()
      || !Array.isArray(debt.failurePaths) || !debt.failurePaths.length
      || debt.failurePaths.some((file) => !receipt.files[file] || receipt.files[file] !== previous.files?.[file])) {
    throw new Error("旧测试欠账缺少前次相同失败指纹、开放修复任务或未变的失败／依赖路径及无关性说明");
  }
  return debt;
}

export function assertReleaseResult({ receipt, packageText, changelog, inspection, health }) {
  const version = JSON.parse(packageText).version;
  if (!receipt?.applied || receipt.applied.version !== version
      || receipt.applied.packageHash !== digest(packageText) || receipt.applied.changelogHash !== digest(changelog)) {
    throw new Error("版本号变化缺少本轮程序门禁与升版写入回执");
  }
  if (inspection.currentVersion !== version || inspection.state !== "none") throw new Error("正式版本头不一致或升版后队列仍有待处理事项");
  if (health?.version !== version || health.ok !== true || health.localOnly !== true || health.controlledWrites !== true) {
    throw new Error("运行版本或健康检查未通过，不能报告升版成功");
  }
}

export async function readReleaseHealth() {
  const response = await fetch("http://127.0.0.1:5173/api/health", { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error(`运行健康读取失败：HTTP ${response.status}`);
  return response.json();
}
