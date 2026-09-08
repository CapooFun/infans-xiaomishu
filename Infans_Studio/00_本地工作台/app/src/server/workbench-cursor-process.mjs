import { spawn } from "node:child_process";

function plainText(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

// CLI notices are transport metadata, not character dialogue. Callers without
// explicit fallback authorization still fail closed.
export function cursorRoutingFailure(value) {
  const text = plainText(value);
  if (/(?:^|\n)\s*(?:>\s*)?(?:the\s+)?model\b[^\n]{0,300}\bunavailable\b[^\n]{0,200}\b(?:rerouted|redirected|fallback|falling back)\b/i.test(text)) {
    return {
      code: "CURSOR_MODEL_FALLBACK_REJECTED",
      message: "指定的 Cursor 模型暂不可用；已拒绝自动回退的回复，请确认模型选择后再试。",
    };
  }
  if (/(?:^|\n)\s*(?:error:\s*)?Cannot use this model:/i.test(text)) {
    return { code: "CURSOR_MODEL_UNAVAILABLE", message: "指定的 Cursor 模型当前不可用，请确认模型选择后再试。" };
  }
  return null;
}

export function cleanCursorRoutingOutput(value) {
  let routing = null;
  const text = plainText(value).replace(/(^|\n)[ \t]*(?:>[ \t]*)?((?:the\s+)?model\b[^\n]{0,300}\bunavailable\b[^\n]{0,200}\b(?:rerouted|redirected|fallback|falling back)\b[^\n]*)/gi, (_line, prefix, notice) => {
    const requested = notice.match(/model\s+["']([^"']+)["']/i)?.[1];
    const selected = notice.match(/(?:rerouted|redirected|falling back)\s+to\s+([^\s.]+)/i)?.[1];
    routing = { requestedModel: requested || "unknown", reportedModel: selected || "unknown", automaticFallback: true };
    return prefix;
  }).trimStart();
  return { text, routing };
}

function pendingRoutingNotice(value) {
  const first = plainText(value).trimStart().replace(/^>\s*/, "").toLowerCase();
  if (first.includes("\n")) return false;
  return !first || ["the model ", "model ", "cannot use this model:"].some(
    (prefix) => prefix.startsWith(first) || first.startsWith(prefix),
  );
}

export function runCursorPrintInvocation(invocation, {
  signal, onStdout, timeoutMs = 180_000, killGraceMs = 2_000,
  allowModelFallback = false, input, env = process.env,
} = {}) {
  if (signal?.aborted) return Promise.resolve({ code: null, signal: "SIGTERM", stdout: "", stderr: "", routingFailure: null });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let routingFailure = null;
    let stopping = false;
    let killTimer;
    const child = spawn(invocation.command, invocation.args, {
      env: { ...env, NO_OPEN_BROWSER: "1" },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    if (input !== undefined) {
      child.stdin.on("error", () => {}); // Early process exit is handled below.
      child.stdin.end(input);
    }
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    };
    const timeout = setTimeout(stop, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
    };
    signal?.addEventListener("abort", stop, { once: true });
    const checkRouting = () => {
      const failure = cursorRoutingFailure(stdout) || cursorRoutingFailure(stderr);
      if (!(allowModelFallback && failure?.code === "CURSOR_MODEL_FALLBACK_REJECTED")) routingFailure ||= failure;
      if (routingFailure) stop();
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      checkRouting();
      // A notice can be split across arbitrary pipe chunks. Hold its prefix
      // until it is classified, so it never becomes a partial chat bubble.
      if (!routingFailure && !pendingRoutingNotice(stdout)) {
        onStdout?.(allowModelFallback ? cleanCursorRoutingOutput(stdout).text : stdout);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); checkRouting(); });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code, exitSignal) => {
      cleanup();
      const cleaned = allowModelFallback ? cleanCursorRoutingOutput(stdout) : { text: stdout, routing: null };
      const routing = cleaned.routing || (allowModelFallback ? cleanCursorRoutingOutput(stderr).routing : null);
      if (!routingFailure && pendingRoutingNotice(stdout) && cleaned.text) onStdout?.(cleaned.text);
      resolve({ code, signal: stopping ? "SIGTERM" : exitSignal, stdout: cleaned.text, stderr, routingFailure, routing });
    });
  });
}
