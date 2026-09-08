import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import { runCursorPrintInvocation } from "./workbench-cursor-process.mjs";

// Reuse Codex's own ChatGPT login. Never export/copy its credentials or inherit
// API keys and plugin secrets from the long-lived workbench server.
export function subscriptionEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "SSL_CERT_FILE", "CODEX_CA_CERTIFICATE"].includes(key) || key.startsWith("LC_"),
  ));
}

export function subscriptionArguments(invocation, workspace) {
  const args = [...invocation.args];
  args[args.indexOf("--cd") + 1] = workspace;
  args.pop(); // Prompt travels over stdin, never in the process argument list.
  const settings = [
    'forced_login_method="chatgpt"', 'model_provider="openai"',
    'model_reasoning_effort="high"', 'approval_policy="never"',
    'web_search="disabled"', 'project_doc_max_bytes=0', 'mcp_servers={}',
    'history.persistence="none"',
    'developer_instructions="You are the secretary reply engine. Use only the supplied context. Do not use tools, read files, delegate, or perform actions. Return the requested answer and action proposals only; the host validates proposals and asks the user before writes."',
  ];
  for (const feature of ["apps", "plugins", "hooks", "memories", "multi_agent", "multi_agent_v2", "shell_tool", "shell_snapshot", "unified_exec", "code_mode_host", "browser_use", "computer_use", "image_generation", "skill_search", "skill_mcp_dependency_install", "sleep_tool"]) settings.push(`features.${feature}=false`);
  for (const value of settings) args.push("-c", value);
  args.push("-");
  return args;
}

export function parseSubscriptionOutput(stdout) {
  let answer = "";
  let completed = false;
  let usage = null;
  let turnStarted = false;
  for (const line of String(stdout || "").split("\n").filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("Codex 订阅回复协议不完整"); }
    if (event.type === "turn.started") turnStarted = true;
    if (event.type === "turn.failed" || event.type === "error") throw new Error("Codex 订阅通道本轮失败");
    if (["item.started", "item.completed"].includes(event.type)) {
      const kind = event.item?.type;
      // This startup warning is expected when the tool host is deliberately off.
      // Other errors and all actual tool events still fail closed.
      if (!turnStarted && kind === "error" && event.item.message === "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.") continue;
      if (kind === "error") throw new Error("Codex 订阅通道返回错误，未采用回复");
      if (kind && !["agent_message", "reasoning", "plan"].includes(kind)) throw new Error("Codex 兜底出现越界工具调用，未采用回复");
      if (event.type === "item.completed" && kind === "agent_message") answer = String(event.item.text || "");
    }
    if (event.type === "turn.completed") { completed = true; usage = event.usage || null; }
  }
  if (!completed || !answer.trim()) throw new Error("Codex 订阅通道没有完整最终回复");
  return { answer: answer.trim(), usage };
}

let active = false;
async function resolveSubscriptionCommand(command) {
  if (command !== "codex") return command;
  const candidates = [
    ...String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, "codex")),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error("未找到已安装的 Codex 订阅客户端");
}

export async function runSubscriptionFallback(invocation, prompt, { signal, run = runCursorPrintInvocation } = {}) {
  if (active) throw new Error("Codex 订阅兜底正在处理上一条消息，原消息已保留待重试");
  active = true;
  let workspace;
  try {
    const env = subscriptionEnvironment();
    invocation = { ...invocation, command: await resolveSubscriptionCommand(invocation.command) };
    const login = await run({ command: invocation.command, args: ["login", "status"] }, { env, signal, timeoutMs: 8_000 });
    if (login.code !== 0 || !/Logged in using ChatGPT/i.test(`${login.stdout}\n${login.stderr}`)) {
      throw new Error("Codex 订阅未登录或当前不是 ChatGPT 登录；不会转用付费 API");
    }
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "infans-subscription-reply-"));
    const result = await run({ ...invocation, args: subscriptionArguments(invocation, workspace) }, { env, input: prompt, signal, timeoutMs: 90_000 });
    if (signal?.aborted) throw new Error("已停止生成");
    if (result.signal || result.code !== 0) throw new Error("Codex 订阅兜底超时或不可用；原消息已保留");
    const parsed = parseSubscriptionOutput(result.stdout);
    return { code: 0, signal: null, stdout: parsed.answer, stderr: "", routingFailure: null, usage: parsed.usage,
      generation: { backend: "codex-subscription", authentication: "chatgpt", requestedModel: invocation.model, fallback: true,
        inputTokens: Number(parsed.usage?.input_tokens) || 0, outputTokens: Number(parsed.usage?.output_tokens) || 0 } };
  } finally {
    // Only remove our empty, randomly-created work directory. Never recurse.
    if (workspace) await fs.rmdir(workspace).catch(() => {});
    active = false;
  }
}

export async function withSubscriptionFallback(primary, fallback, { signal, unusable = () => false } = {}) {
  let result;
  try { result = await primary(); } catch (error) { result = { code: 1, stderr: error?.message || "Cursor 连接失败", stdout: "" }; }
  if (signal?.aborted) return result;
  if (result.code === 0 && !result.signal && !result.routingFailure && result.stdout?.trim() && !unusable(result.stdout)) return result;
  const recovered = await fallback();
  return { ...recovered, generation: { ...recovered.generation, fallbackReason: result.routingFailure?.code || (result.signal ? "CURSOR_TIMEOUT" : "CURSOR_UNAVAILABLE") } };
}
