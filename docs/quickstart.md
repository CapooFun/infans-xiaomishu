# 快速开始

本轮本地候选已在隔离环境验证：Node.js 22.17.0，lockfile 指定 pnpm 10.12.4。请安装 Node.js 22.13 或经本仓库验证的后续维护版本，并用 lockfile 匹配的 pnpm。

首次搭建时，目前作者更推荐用 **GPT 6 mini** 对着仓库根 `AGENTS.md` 往下做。不必先装某一家特定的桌面 Agent。

**不要把仓库本身当可写数据根。** 运行记录、日历缓存和聊天存档必须落在源码外的数据目录。

1. 在 `Infans_Studio/00_本地工作台/app` 运行 `pnpm install --frozen-lockfile`。
2. **新建数据根：** 运行 `pnpm init:data`。默认把示例内容拷到 `~/Infans_OpenSource`；也可 `INFANS_VAULT_ROOT=/全新空目录 pnpm init:data`。目标必须不存在或为空；已有文件会被拒绝，不会覆盖。
3. **已有数据根：** 运行 `INFANS_VAULT_ROOT=/已有目录 pnpm bind:data`。只写指针，不复制、不改写。指针丢失时用这一步，**不要再跑 init:data**。
4. 运行 `pnpm build`，再执行 `scripts/start-local.sh`（或已设置 `INFANS_VAULT_ROOT` 后的 `INFANS_HOST=127.0.0.1 INFANS_PORT=5173 pnpm start`）。
5. 浏览器打开 `http://127.0.0.1:5173`。默认可浏览工作台、改示例待办和看收件箱。聊天默认不调用模型，状态条写「模型未配置」。要把自己的 Agent 或其它模型服务接上，改 `Infans_Studio/00_本地工作台/app/src/server/workbench-ai.mjs` 里的运行时状态读取与对话流函数（源码里历史函数名仍是 `readSecretaryAiRuntimeStatus`、`streamCursor`），并在数据根 `00_本地工作台/40_数据/agent-runtime-bindings.json` 登记适配器。这不是填一条密钥就能用。
6. 公开检查用 `pnpm check:public` 与 `pnpm test:public`。完整 `pnpm check` 含私有治理断言，开源树里可能失败，不能当作公开发布门。
7. 只读 MCP 源码在 `Infans_Support/20_项目支持/Infans只读MCP`。把它指到你自己的库根，不要默认作者目录。

## 停止与重开

- 停止：在启动终端按 Ctrl+C。脚本不会去杀端口上归属不明的其他进程。
- 重开：再跑 `scripts/start-local.sh`。若本实例已在同一工程、同一数据根、同一端口运行且源码未变，会提示已经在运行。
- 同一工程换了另一个数据根，不会被当成同一个实例。
- 端口被另一套 Infans 或无关程序占用时，改 `INFANS_PORT` 后重试，并在「发给秘书」Chrome 扩展选项里填同一端口。不要手动去杀你认不出的进程。
- 非法 `INFANS_PORT` 会直接失败，不会悄悄改回 5173。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `未设置 INFANS_VAULT_ROOT` | 没跑 init/bind，或指针文件丢失 | 已有库用 `pnpm bind:data`；全新空目录才用 `pnpm init:data` |
| `目标目录已有内容` | 对已有库又跑了 init | 改用 `pnpm bind:data` |
| `端口已被其他程序或另一套 Infans 占用` | 5173 上不是本实例 | 换 `INFANS_PORT`，或自己停掉那套服务 |
| 日历是空的 | 演示默认不读操作系统日历 | 只有你明确需要时才设 `INFANS_CALENDAR_OS=1`，并使用实例缓存目录 |
| 聊天提示模型未配置 | 默认不调用模型 | 可继续浏览、改待办、看收件。接入点见上文第 5 步；不要把密钥写进仓库 |

不要把 `INFANS_VAULT_ROOT` 指到别人的私人目录。手机浏览工作台不需要安装 Node。多屏怎么摆见 `docs/workstation-screens.md`；请放你自己的桌子照片，不要拷别人家里的图。
