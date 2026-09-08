import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { buildCodexCleanupPrompt, createCodexCleanupService, resolveWorkbenchSectionId } from "../src/server/workbench-codex-cleanup.mjs";

function fakeAppServer() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.messages = [];
  child.stdin = {
    write(raw) {
      const message = JSON.parse(String(raw).trim());
      child.messages.push(message);
      if (message.id == null) return true;
      const result = message.method === "threadSection/list"
        ? { data: [{ id: "section-work", name: "工作区" }] }
        : message.method === "thread/start"
          ? { thread: { id: "thr_cleanup_123" } }
          : message.method === "turn/start"
            ? { turn: { id: "turn_cleanup_123", status: "inProgress" } }
            : {};
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`));
      return true;
    },
    end() {},
  };
  child.kill = () => { child.killed = true; child.emit("exit", 0, "SIGTERM"); };
  child.complete = (status = "completed") => child.stdout.write(`${JSON.stringify({
    method: "turn/completed",
    params: { turn: { id: "turn_cleanup_123", status } },
  })}\n`);
  return child;
}

test("清理任务边界明确排除原件、NAS、进程终止和永久删除", () => {
  const prompt = buildCodexCleanupPrompt();
  assert.match(prompt, /Infans_Vault 原件/);
  assert.match(prompt, /已挂载 NAS/);
  assert.match(prompt, /不要结束终端、服务或普通应用进程/);
  assert.match(prompt, /不永久删除/);
  assert.match(prompt, /Codex 自己的权限请求与自动审批复核/);
});

test("工作区必须按唯一名称解析，不猜测分区 ID", () => {
  assert.equal(resolveWorkbenchSectionId({ data: [{ id: "one", name: "工作区" }] }), "one");
  assert.equal(resolveWorkbenchSectionId({ items: [{ id: "a", name: "工作区" }, { id: "b", name: "工作区" }] }), "");
  assert.equal(resolveWorkbenchSectionId({ sections: [{ id: "other", name: "观察区" }] }), "");
});

test("一键投递创建持久 Codex 任务并使用工作区沙箱与自动审批", async () => {
  const child = fakeAppServer();
  let spawnArgs = null;
  const service = createCodexCleanupService({
    root: "/tmp/infans-vault",
    spawnProcess: (_command, args) => { spawnArgs = args; return child; },
  });

  const receipt = await service.dispatch();
  assert.deepEqual(spawnArgs, ["app-server", "--stdio"]);
  assert.equal(receipt.status, "running");
  assert.equal(receipt.threadId, "thr_cleanup_123");

  const start = child.messages.find((message) => message.method === "thread/start");
  assert.equal(start.params.cwd, "/tmp/infans-vault");
  assert.equal(start.params.ephemeral, false);
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(start.params.approvalPolicy, "on-request");
  assert.equal(start.params.approvalsReviewer, "auto_review");
  assert.equal("model" in start.params, false);

  const name = child.messages.find((message) => message.method === "thread/name/set");
  assert.equal(name.params.name, "性能诊断／Codex 安全清理");
  const move = child.messages.find((message) => message.method === "thread/section/move");
  assert.deepEqual(move.params, { threadId: "thr_cleanup_123", sectionId: "section-work" });

  const duplicate = await service.dispatch();
  assert.equal(duplicate.duplicate, true);

  child.complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.read().status, "completed");
  service.dispose();
});
