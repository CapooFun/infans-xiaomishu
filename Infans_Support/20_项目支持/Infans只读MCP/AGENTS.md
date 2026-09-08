# Infans 只读 MCP

本工程只提供经使用者配置的知识库、支持库独立工程与游戏项目的读取能力。

## 红线

- 不增加任何写入、移动、删除、执行命令或任意网络转发工具。
- 不读取已配置来源以外的路径，不跟随逃出当前来源根的软链接。
- 不返回 `.git`、凭据文件、外部 AI 全量备份、缓存、依赖或运行日志。
- 不在源码、测试、日志、提交或聊天中记录真实 Token、API Key 或私钥。
- MCP 工具保持 `readOnlyHint: true`、`destructiveHint: false`、`openWorldHint: false`。
- 修改读取范围、排除项、认证边界或工具 schema 前，先更新知识库中的权威设计并经使用者确认。
- AI 未经使用者明确授权不得 commit、push 或发布。

## 验证

每次改动至少运行：

```bash
npm test
```
