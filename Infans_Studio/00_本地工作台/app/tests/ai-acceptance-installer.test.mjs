import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildRunnerConfig,
  buildRunnerWrapper,
  ensurePrivateDirectory,
  ensurePrivateLog,
  legacyThreadBindingNotice,
} from "../scripts/install-ai-acceptance-runner.mjs";

test("AI 自动验收配置使用临时执行回合且不绑定长期任务窗口", () => {
  const config = buildRunnerConfig({
    codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    now: new Date("2026-09-04T12:00:00.000Z"),
  });
  assert.equal(config.schemaVersion, 3);
  assert.equal(config.dispatchMode, "codex-exec-ephemeral-json");
  assert.equal(Object.hasOwn(config, "threadId"), false);
  assert.equal(config.updatedAt, "2026-09-04T12:00:00.000Z");
  assert.match(legacyThreadBindingNotice({ reuseThread: true }), /不再绑定长期任务窗口/u);
  assert.equal(legacyThreadBindingNotice({}), null);
});

test("AI 自动验收安装器建立 0700 日志目录与 0600 日志文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-acceptance-installer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logDir = path.join(root, "logs");
  const logPath = path.join(logDir, "runner.log");

  await ensurePrivateDirectory(logDir);
  await ensurePrivateLog(logPath);

  assert.equal((await fs.stat(logDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(logPath)).mode & 0o777, 0o600);
});

test("AI 自动验收 runner 只保留固定数量日志归档并在执行前收紧权限", () => {
  const wrapper = buildRunnerWrapper({
    nodePath: "/opt/node",
    dispatcherPath: "/vault/app/scripts/ai-acceptance-dispatcher.mjs",
    workspace: "/vault",
    logPath: "/private/logs/ai-acceptance-runner.log",
  });

  assert.match(wrapper, /max_log_bytes=5242880/);
  assert.match(wrapper, /max_log_archives=5/);
  assert.match(wrapper, /rm -f -- .*\.5/);
  assert.match(wrapper, /index>=2/);
  assert.match(wrapper, /chmod 600 "\$log_path"/);
  assert.match(wrapper, />> "\$log_path" 2>&1/);
  assert.doesNotMatch(wrapper, /\*\.log|\.log\.\*/);
});

test("AI 自动验收 runner 达到上限时实际轮转且不产生第六份归档", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-acceptance-log-rotation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, "runner.log");
  const wrapperPath = path.join(root, "runner.sh");
  await fs.writeFile(logPath, Buffer.alloc(5 * 1024 * 1024, "x"), { mode: 0o600 });
  for (let index = 1; index <= 5; index += 1) {
    await fs.writeFile(`${logPath}.${index}`, `archive-${index}\n`, { mode: 0o600 });
  }
  await fs.writeFile(wrapperPath, buildRunnerWrapper({
    nodePath: "/usr/bin/true",
    dispatcherPath: "/does/not/matter.mjs",
    workspace: "/vault",
    logPath,
  }), { mode: 0o700 });

  const result = spawnSync("/bin/bash", [wrapperPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await fs.stat(logPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(`${logPath}.1`)).size, 5 * 1024 * 1024);
  assert.equal(await fs.readFile(`${logPath}.5`, "utf8"), "archive-4\n");
  await assert.rejects(fs.access(`${logPath}.6`));
});

test("AI 自动验收安装器拒绝把符号链接当作日志文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-acceptance-log-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const targetPath = path.join(root, "target.log");
  const linkPath = path.join(root, "runner.log");
  await fs.writeFile(targetPath, "private\n", { mode: 0o600 });
  await fs.symlink(targetPath, linkPath);

  await assert.rejects(ensurePrivateLog(linkPath), /日志不是安全的普通文件/);
});
