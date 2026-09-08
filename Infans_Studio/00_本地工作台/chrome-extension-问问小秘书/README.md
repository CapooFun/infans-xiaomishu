---
description: 小秘书 Chrome 原生右键Chrome 原生右键扩展的安装与维护说明
tags: [本地工作台, 梅凝, Chrome扩展]
---

# 问问小秘书 · Chrome 扩展

选中任意网页文字 → 原生右键 → **问问小秘书** → 本机工作台侧栏自动提问。

工作台**页内**另有不依赖扩展的右键菜单「问问小秘书 / 复制」（见 [[Infans本地工作台_项目设计]] §4.12）；本扩展主要服务**外站选区**，并在梅凝 Chrome 里提供与系统菜单一致的体验。

## 安装（可选 · 小秘书专用 Chrome）

日常入口是原生 `小秘书.app`。只有显式运行浏览器回退脚本时才会走专用 Chrome：

[`launch-chrome-workbench.sh`](../app/scripts/launch-chrome-workbench.sh)：

- 启动前先结束同 profile（`~/Library/Application Support/Infans/小秘书工作台 Chrome`）旧进程，否则会忽略新的启动参数；
- 已去掉 `--disable-extensions`；
- 用 `--load-extension` 加载本目录。

Safari 下请用工作台**页内**右键「问问小秘书」。外站选区仍需上述 Chrome 模式。

若原生菜单仍未出现：

1. 打开 `chrome://extensions`（专用 profile）
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选本目录
4. 确认扩展已启用

## 行为

- 优先 `POST http://127.0.0.1:5173/api/ai/ask-selection`
- 成功后聚焦已打开的工作台窗口（不整页刷新，靠前端轮询消费 pending）
- 服务未起时：深链 hash 携带选区，工作台启动后解析

不上架 Chrome Web Store；勿在其它日常 Chrome profile 乱装（入队口仅本机 `127.0.0.1`）。
