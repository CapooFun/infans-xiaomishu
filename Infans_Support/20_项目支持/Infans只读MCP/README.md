# Infans 只读 MCP（开源候选）

按配置读取你指定的知识库根目录。没有写入、删除、移动或命令执行能力。

设置 `INFANS_VAULT_ROOT` 指向你的库。支持库和游戏目录只有在你显式设置 `INFANS_SUPPORT_ROOT`、`INFANS_GAMES_ROOT` 时才会挂载。不要把默认路径理解成作者的家目录布局。

```bash
npm install
INFANS_VAULT_ROOT=/path/to/your/library npm start
```

状态目录用 `INFANS_MCP_STATE_DIR`，必须在库根之外。配置样例见 `.env.example`。
