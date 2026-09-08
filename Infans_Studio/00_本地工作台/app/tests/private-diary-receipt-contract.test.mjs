import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAULT_ROOT = path.resolve(APP_ROOT, "../..");

test("附加 ChatGPT 日记对话有自动接票、误触发保护与正确写入路径", async () => {
  const [agents, protocol] = await Promise.all([
    readFile(path.join(VAULT_ROOT, "AGENTS.md"), "utf8"),
    readFile(path.join(VAULT_ROOT, "00_本地工作台/10_设计/全局能力/日记模式_上下文与交接协议.md"), "utf8"),
  ]);

  assert.match(agents, /附加对话中出现完整的“日记模式”四个字/u);
  assert.match(agents, /只有用户当次明确说“不写入／不归档／只检查”时才停止归档/u);
  assert.match(protocol, /附加聊天的任意位置出现完整的“日记模式”四个字/u);
  assert.match(protocol, /不再要求用户解释这是不是日记，也不另做复杂语义分类/u);
  assert.match(protocol, /不得只根据缓存预览、最后十轮或固定交接摘要形成正文/u);
  assert.match(protocol, /ChatGPT conversation ID/u);
  assert.match(protocol, /10_日志记录\/对话日志\/YYYY-MM-DD\.md/u);
  assert.match(protocol, /不同时把内容写进 `10_日志记录\/工作日志\/`/u);
  assert.match(protocol, /保存 Capoo 与 AI 双方的角色、顺序和实际可读取文本/u);
});
