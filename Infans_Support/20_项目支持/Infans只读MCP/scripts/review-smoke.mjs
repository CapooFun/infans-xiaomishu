import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const server=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/server.mjs');
const client=new Client({name:'review-smoke',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[server],env:{INFANS_MCP_STATE_DIR:'/private/tmp/infans-mcp-review-smoke-state'},stderr:'pipe'});
try {
 await client.connect(transport);
 const listed=await client.listTools();
 const status=await client.callTool({name:'get_vault_security_status',arguments:{}});
 console.log(JSON.stringify({tools:listed.tools.length,version:status.structuredContent?.protocolVersion,sources:status.structuredContent?.sources}));
 for (const args of [
  {source:'vault',path:'00_本地工作台/app/src/server/serve.mjs',lineStart:1,lineCount:3},
  {source:'support',path:'Infans只读MCP/src/config.mjs',lineStart:1,lineCount:3},
  {source:'games',path:'QuitToCultivate/project.godot',lineStart:1,lineCount:3},
 ]) {
  const r=await client.callTool({name:'read_vault_file',arguments:args});
  console.log(JSON.stringify({source:args.source,path:args.path,error:r.structuredContent?.error?.code,lines:r.structuredContent?.lineEnd,hash:!!r.structuredContent?.sourceHash}));
 }
 const r=await client.callTool({name:'search_vault',arguments:{source:'support',path:'Infans只读MCP/src/config.mjs',query:'TEXT_EXTENSIONS',limit:2}});
 console.log(JSON.stringify({searchMatches:r.structuredContent?.resultCount,error:r.structuredContent?.error?.code}));
} finally {await client.close();}
