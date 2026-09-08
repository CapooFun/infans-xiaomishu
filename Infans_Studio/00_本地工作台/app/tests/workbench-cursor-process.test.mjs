import assert from "node:assert/strict";
import test from "node:test";
import { cleanCursorRoutingOutput, cursorRoutingFailure, runCursorPrintInvocation } from "../src/server/workbench-cursor-process.mjs";

const notice = '> The model "cursor-grok-4.6-high" is unavailable and you have been rerouted to Auto.\n';
const fixture = (code) => ({ command: process.execPath, args: ["--input-type=module", "-e", code] });

test("已授权回退可继续生成，CLI 通知从分片对白剥离并保留来源", async () => {
  const chunks = [];
  const result = await runCursorPrintInvocation(fixture(`
    const parts = [...${JSON.stringify(notice + "正常回答") }];
    const timer = setInterval(() => { const part = parts.shift(); if (part) process.stdout.write(part); else clearInterval(timer); }, 1);
  `), { allowModelFallback: true, onStdout: (text) => chunks.push(text) });
  assert.equal(result.code, 0);
  assert.equal(result.routingFailure, null);
  assert.equal(result.stdout, "正常回答");
  assert.equal(result.routing.reportedModel, "Auto");
  assert.equal(result.routing.requestedModel, "cursor-grok-4.6-high");
  assert.ok(chunks.every((text) => !text.includes("model") && !text.includes("rerouted")));
  assert.equal(cleanCursorRoutingOutput("普通内容").text, "普通内容");
});

test("Cursor 路由警告不能当成正常回答，普通谈论模型不误判", () => {
  for (const text of [notice, `\u001b[33m${notice}\u001b[0m\n伪正常回答`, `${notice}\n\n\`\`\`json\n{"actions":[{}]}\n\`\`\``]) {
    assert.equal(cursorRoutingFailure(text)?.code, "CURSOR_MODEL_FALLBACK_REJECTED");
  }
  assert.equal(cursorRoutingFailure("Cannot use this model: missing. Available models: auto")?.code, "CURSOR_MODEL_UNAVAILABLE");
  for (const text of ["前辈，收到。", "The model is useful.", "If a model is unavailable, ask before using a fallback."]) {
    assert.equal(cursorRoutingFailure(text), null);
  }
});

test("分片回退提示在任何回答发布前中断，不采用 Auto 内容", async () => {
  const chunks = [];
  const invocation = fixture(`
    const parts = [...${JSON.stringify(notice + "不应发布的替代回答")}];
    const timer = setInterval(() => { const part = parts.shift(); if (part) process.stdout.write(part); else clearInterval(timer); }, 1);
  `);
  const result = await runCursorPrintInvocation(invocation, { onStdout: (text) => chunks.push(text) });
  assert.equal(result.routingFailure?.code, "CURSOR_MODEL_FALLBACK_REJECTED");
  assert.equal(result.signal, "SIGTERM");
  assert.deepEqual(chunks, []);
});

test("标准错误中的路由警告同样被拒绝", async () => {
  const result = await runCursorPrintInvocation(fixture(`process.stderr.write(${JSON.stringify(notice)}); setTimeout(() => {}, 10000);`));
  assert.equal(result.routingFailure?.code, "CURSOR_MODEL_FALLBACK_REJECTED");
});

test("正常中文输出及跨 UTF8 分片不被破坏", async () => {
  const chunks = [];
  const result = await runCursorPrintInvocation(fixture(`
    const bytes = Buffer.from('前辈，收到。'); let i = 0;
    const timer = setInterval(() => { if (i < bytes.length) process.stdout.write(bytes.subarray(i, ++i)); else clearInterval(timer); }, 1);
  `), { onStdout: (text) => chunks.push(text) });
  assert.equal(result.code, 0);
  assert.equal(result.routingFailure, null);
  assert.equal(result.stdout, "前辈，收到。");
  assert.equal(chunks.at(-1), result.stdout);
});

test("普通 model 开头的单行输出在进程结束时释放", async () => {
  const chunks = [];
  const result = await runCursorPrintInvocation(fixture("process.stdout.write('The model is useful.');"), { onStdout: (text) => chunks.push(text) });
  assert.equal(result.code, 0);
  assert.deepEqual(chunks, ["The model is useful."]);
});

test("预先取消不启动命令，超时可终止忽略 SIGTERM 的进程", async () => {
  const signal = AbortSignal.abort();
  const cancelled = await runCursorPrintInvocation({ command: "/nonexistent", args: [] }, { signal });
  assert.equal(cancelled.signal, "SIGTERM");
  const timedOut = await runCursorPrintInvocation(fixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"), { timeoutMs: 250, killGraceMs: 50 });
  assert.equal(timedOut.signal, "SIGTERM");
  assert.equal(timedOut.routingFailure, null);
});

test("命令启动失败正常拒绝而不留下超时计时器", async () => {
  await assert.rejects(runCursorPrintInvocation({ command: "/nonexistent-infans-cursor", args: [] }), { code: "ENOENT" });
});
