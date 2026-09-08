#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultStateDirectory } from "../src/config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const vaultRoot = process.env.INFANS_VAULT_ROOT;
if (!vaultRoot) {
  throw new Error("INFANS_VAULT_ROOT must be set to your library root");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "server.mjs")],
  env: {
    INFANS_VAULT_ROOT: vaultRoot,
    INFANS_MCP_STATE_DIR: process.env.INFANS_MCP_STATE_DIR || defaultStateDirectory(),
  },
  stderr: "pipe",
});
const client = new Client({ name: "infans-smoke-client", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const rootInfo = await client.callTool({ name: "get_vault_file_info", arguments: { path: "" } });
  const search = await client.callTool({ name: "search_vault", arguments: { query: "Infans_Vault", limit: 3 } });
  console.log(JSON.stringify({
    ok: true,
    tools: tools.tools.map((tool) => tool.name),
    rootType: rootInfo.structuredContent?.type,
    searchResultCount: search.structuredContent?.resultCount,
  }, null, 2));
} finally {
  await client.close();
}
