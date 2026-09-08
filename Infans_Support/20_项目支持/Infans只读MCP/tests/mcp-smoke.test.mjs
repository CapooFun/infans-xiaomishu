import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeFixture } from "./helpers.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDirectory, "../src/server.mjs");

test("MCP advertises only read-only tools and serves a search", async (t) => {
  const fixture = await makeFixture();
  t.after(fixture.cleanup);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      INFANS_VAULT_ROOT: fixture.vaultRoot,
      INFANS_MCP_STATE_DIR: fixture.stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "infans-test-client", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "get_vault_file_info",
      "get_vault_security_status",
      "list_vault_directory",
      "prepare_knowledge_learning",
      "read_vault_file",
      "search_vault",
    ],
  );
  for (const tool of listed.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.openWorldHint, false);
  }
  const security = await client.callTool({ name: "get_vault_security_status", arguments: {} });
  assert.equal(security.structuredContent.protocolVersion, "0.2.0");
  const compat = await client.callTool({name:"read_vault_file",arguments:{path:"@vault/首页.md",lineStart:1,lineCount:1}});
  assert.equal(compat.structuredContent.text,"# 首页");
  assert.equal(compat.structuredContent.source,"vault");
  const conflict=await client.callTool({name:"read_vault_file",arguments:{source:"games",path:"@vault/首页.md"}});
  assert.equal(conflict.structuredContent.error.code,"SOURCE_CONFLICT");
  const bootstrapTool = listed.tools.find((tool) => tool.name === "prepare_knowledge_learning");
  assert.match(bootstrapTool?.description ?? "", /必须先调用/u);
  const generic = await client.callTool({ name: "prepare_knowledge_learning", arguments: { query: "我想学点东西" } });
  assert.equal(generic.isError, undefined);
  assert.equal(generic.structuredContent?.route, "domain-choices");
  assert.deepEqual(generic.structuredContent?.choices?.map((choice) => choice.domainId), [
    "game", "ai", "economics-finance", "language", "thought-history", "zztj", "image-management", "fitness",
  ]);
  assert.equal(generic.structuredContent?.recentLearning?.[0]?.nodeId, "ai-representation-tokenization");

  const domain = await client.callTool({ name: "prepare_knowledge_learning", arguments: { query: "我想学人工智能" } });
  assert.equal(domain.isError, undefined);
  assert.equal(domain.structuredContent?.route, "branch-choices");
  assert.equal(domain.structuredContent?.domain?.domainId, "ai");
  assert.match(JSON.stringify(domain.structuredContent?.choices), /AI 历史、范式与数理基础/u);

  const node = await client.callTool({ name: "prepare_knowledge_learning", arguments: { query: "Token 化" } });
  assert.equal(node.isError, undefined);
  assert.equal(node.structuredContent?.route, "node-ready");
  assert.equal(node.structuredContent?.nodeCandidates?.[0]?.nodeId, "ai-representation-tokenization");
  assert.equal(node.structuredContent?.nodeCandidates?.[0]?.contentStatus, "outline");
  assert.match(JSON.stringify(node.structuredContent), /先定位唯一 nodeId/u);
  assert.match(JSON.stringify(node.structuredContent), /学习状态与正文状态分开/u);
  assert.match(JSON.stringify(node.structuredContent), /人工智能知识节点_完整框架\.md/u);
  assert.match(JSON.stringify(node.structuredContent), /用中英文切分案例说明离散表示/u);
  assert.match(JSON.stringify(node.structuredContent), /用中英文短句实际走一次切分/u);
  const result = await client.callTool({ name: "search_vault", arguments: { query: "阳台种植计划" } });
  assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result.structuredContent), /首页\.md/);
});
