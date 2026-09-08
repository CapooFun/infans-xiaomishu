---
description: 小秘书 NAS 24 小时信箱的独立容器发布、健康检查与回滚说明
tags: [小秘书, NAS, 信箱, 部署]
sensitivity: S1
---

# 小秘书 NAS 信箱

仅部署信箱协议，不复制 Vault 或完整工作台。服务默认只监听 NAS 回环 `8789`，由既有私有 HTTPS/Tunnel 映射；Bearer token 只存于远端权限收紧的 `secrets/secretary_mailbox_token`。

先运行 `package-release.sh <version>`，将产物传到 NAS 临时目录，再在管理权限下运行 `deploy.sh <archive> <version>`。部署后检查容器健康和 `curl http://127.0.0.1:8789/healthz`；异常运行 `rollback.sh`。数据独立位于 `data/`，切换前快照位于 `backups/`，不得放入 NAS 备份镜像目录。
