import path from "node:path";

export const TUNNEL_PROFILE = "infans-vault";
export const KEYCHAIN_SERVICE = "infans-readonly-mcp";
export const KEYCHAIN_ACCOUNT = "openai-tunnel-runtime";

export function buildTunnelInvocation(action, options = {}) {
  const tunnelClient = options.tunnelClient || process.env.TUNNEL_CLIENT || "tunnel-client";
  const projectRoot = options.projectRoot;
  if (!projectRoot) throw new Error("projectRoot is required");
  const serverPath = path.join(projectRoot, "src", "server.mjs");

  if (action === "init") {
    const tunnelId = String(options.tunnelId || "").trim();
    if (!/^tunnel_[A-Za-z0-9_-]{8,}$/.test(tunnelId)) {
      throw new Error("A valid tunnel_id is required for init");
    }
    return {
      command: tunnelClient,
      args: [
        "init",
        "--sample", "sample_mcp_stdio_local",
        "--profile", TUNNEL_PROFILE,
        "--tunnel-id", tunnelId,
        "--mcp-command", `${process.execPath} ${serverPath}`,
      ],
    };
  }
  if (action === "doctor") {
    return { command: tunnelClient, args: ["doctor", "--profile", TUNNEL_PROFILE, "--explain"] };
  }
  if (action === "run") {
    return { command: tunnelClient, args: ["run", "--profile", TUNNEL_PROFILE] };
  }
  throw new Error("Action must be init, doctor, or run");
}
