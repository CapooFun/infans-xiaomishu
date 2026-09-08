import assert from "node:assert/strict";
import test from "node:test";
import { parseSubscriptionOutput, runSubscriptionFallback, subscriptionArguments, subscriptionEnvironment, withSubscriptionFallback } from "../src/server/workbench-subscription-fallback.mjs";

const invocation = { command: "/synthetic/codex", model: "gpt-5.6-sol", args: ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--cd", "/vault", "--model", "gpt-5.6-sol", "private prompt"] };
const events = [
  { type: "thread.started", thread_id: "isolated-fixture" },
  { type: "item.completed", item: { type: "agent_message", text: "订阅合成回复" } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } },
].map(JSON.stringify).join("\n");

test("订阅兜底环境不继承 API 凭据或任意插件密钥", () => {
  const env = subscriptionEnvironment({ HOME: "/test", PATH: "/bin", CODEX_HOME: "/auth", OPENAI_API_KEY: "fixture", CODEX_API_KEY: "fixture", SECRET_PLUGIN_KEY: "fixture" });
  assert.deepEqual(Object.keys(env).sort(), ["CODEX_HOME", "HOME", "PATH"]);
});

test("兜底强制 ChatGPT 认证、只读、关闭工具与持久会话，prompt 不入 argv", () => {
  const args = subscriptionArguments(invocation, "/tmp/isolated");
  assert.equal(args.at(-1), "-");
  assert.equal(args.includes("private prompt"), false);
  assert.equal(args[args.indexOf("--cd") + 1], "/tmp/isolated");
  for (const value of ['forced_login_method="chatgpt"', 'model_provider="openai"', 'features.shell_tool=false', 'features.plugins=false', 'features.apps=false', 'web_search="disabled"']) assert.ok(args.includes(value));
  assert.ok(args.includes("read-only"));
});

test("只取完整最终回答，缺失完成事件、错误或工具事件均拒绝", () => {
  assert.equal(parseSubscriptionOutput(events).answer, "订阅合成回复");
  for (const text of ["not-json", JSON.stringify({ type: "turn.failed" }), events.replace(/\n[^\n]+$/, ""), JSON.stringify({ type: "item.started", item: { type: "command_execution" } }) + "\n" + events]) {
    assert.throws(() => parseSubscriptionOutput(text));
  }
});

test("仅放行主动禁用工具宿主的已知启动提示，不放行其它错误", () => {
  const warning = { type: "item.completed", item: { type: "error", message: "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`." } };
  assert.equal(parseSubscriptionOutput(JSON.stringify(warning) + "\n" + events).answer, "订阅合成回复");
  warning.item.message = "An unrelated failure";
  assert.throws(() => parseSubscriptionOutput(JSON.stringify(warning) + "\n" + events), /返回错误/);
});

test("Cursor 正常及 Auto 回退成功时都不消耗订阅", async () => {
  for (const routing of [null, { reportedModel: "Auto" }]) {
    let calls = 0;
    const result = await withSubscriptionFallback(async () => ({ code: 0, stdout: "正常回复", routing }), async () => { calls++; });
    assert.equal(result.stdout, "正常回复"); assert.equal(calls, 0);
  }
});

test("连接失败、超时、空回复只兜底一次，取消不兜底", async () => {
  for (const first of [{ code: 1, stdout: "" }, { code: 0, signal: "SIGTERM", stdout: "partial" }, { code: 0, stdout: "" }]) {
    let calls = 0;
    const result = await withSubscriptionFallback(async () => first, async () => { calls++; return { code: 0, stdout: "订阅回复", generation: { backend: "codex-subscription" } }; });
    assert.equal(calls, 1); assert.equal(result.stdout, "订阅回复");
  }
  let calls = 0;
  await withSubscriptionFallback(async () => ({ code: 1 }), async () => { calls++; }, { signal: AbortSignal.abort() });
  assert.equal(calls, 0);
  await assert.rejects(withSubscriptionFallback(async () => { throw new Error("connection"); }, async () => { throw new Error("额度不足"); }), /额度不足/);
});

test("无订阅登录时不生成、不暗中改用 API", async () => {
  let calls = 0;
  await assert.rejects(runSubscriptionFallback(invocation, "private prompt", { run: async () => { calls++; return { code: 0, stdout: "Logged in using an API key", stderr: "" }; } }), /不会转用付费 API/);
  assert.equal(calls, 1);
});

test("成功兜底复用官方登录，经 stdin 传入上下文并返回可审计来源", async () => {
  let calls = 0;
  const result = await runSubscriptionFallback(invocation, "private prompt", { run: async (_invocation, options) => {
    calls++;
    if (calls === 1) return { code: 0, stdout: "", stderr: "Logged in using ChatGPT" };
    assert.equal(options.input, "private prompt");
    assert.ok(!_invocation.args.includes("private prompt"));
    return { code: 0, signal: null, stdout: events };
  } });
  assert.equal(calls, 2); assert.equal(result.stdout, "订阅合成回复");
  assert.equal(result.generation.authentication, "chatgpt");
});
