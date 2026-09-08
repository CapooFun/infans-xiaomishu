import assert from "node:assert/strict";
import test from "node:test";
import { buildTunnelInvocation } from "../src/tunnel-command.mjs";

test("builds a bounded stdio tunnel profile without credentials", () => {
  const invocation = buildTunnelInvocation("init", {
    projectRoot: "/safe/project",
    tunnelId: "tunnel_0123456789abcdef",
    tunnelClient: "/safe/tunnel-client",
  });
  assert.equal(invocation.command, "/safe/tunnel-client");
  assert.deepEqual(invocation.args.slice(0, 6), [
    "init",
    "--sample", "sample_mcp_stdio_local",
    "--profile", "infans-vault",
    "--tunnel-id",
  ]);
  assert(!JSON.stringify(invocation).match(/api[_-]?key|bearer|secret/i));
});

test("rejects malformed tunnel ids", () => {
  assert.throws(
    () => buildTunnelInvocation("init", { projectRoot: "/safe/project", tunnelId: "bad" }),
    /valid tunnel_id/,
  );
});
