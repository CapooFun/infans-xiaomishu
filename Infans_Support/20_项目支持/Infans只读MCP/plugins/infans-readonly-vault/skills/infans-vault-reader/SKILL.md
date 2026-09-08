---
name: infans-vault-reader
description: 使用只读 MCP 搜索和读取使用者自己配置的知识库。不用于写入、修改、删除或执行命令。
---

# Infans Vault Reader

## 路由边界

如果用户表达想学习、复习、继续上次、了解某个主题或询问学什么，改用 `infans-knowledge-learning`，并先调用 `prepare_knowledge_learning`。不要先用普通搜索生成学习目录。

普通资料查询按以下顺序处理：

1. 不知道准确文件时先调用 `search_vault`，必要时用目录参数缩小范围。
2. 根据结果读取最相关的少量文件；长文件使用 `read_vault_file` 分段读取。
3. 只需确认位置、更新时间或格式时，使用 `get_vault_file_info`。
4. 询问授权轮换或安全复查日期时，使用 `get_vault_security_status`。
