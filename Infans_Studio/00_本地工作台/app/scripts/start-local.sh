#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# launchd 恢复的长期服务不会继承交互式 shell 的 PATH。Cursor Agent
# 安装在用户本地 bin 时仍必须能被 5173 的读取岗位解析到。
if [[ -d "${HOME}/.local/bin" ]]; then
  export PATH="${HOME}/.local/bin:${PATH}"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js 22.13 或经本仓库验证的后续维护版本。"
  exit 1
fi

# 相册初次索引会读大量文件元数据。Node 默认只有 4 个文件系统
# 工作线程，在网络磁盘上会把一次重建拖得很久；当前相册兜底扫描最多并发 6 路。
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"

PORT="${INFANS_PORT:-5173}"
if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || [[ "${PORT}" -lt 1 || "${PORT}" -gt 65535 ]]; then
  echo "INFANS_PORT 不合法：${PORT}"
  exit 1
fi
export INFANS_PORT="${PORT}"
URL="http://127.0.0.1:${PORT}"
APP_DIR="$(pwd)"
if [[ -z "${INFANS_VAULT_ROOT:-}" && -f .infans-vault-root ]]; then
  INFANS_VAULT_ROOT="$(sed -n '1p' .infans-vault-root | tr -d '\r')"
fi
if [[ -z "${INFANS_VAULT_ROOT:-}" ]]; then
  echo "未设置数据根。请先运行 pnpm init:data（或设置 INFANS_VAULT_ROOT），不要把运行记录写进源码目录。"
  exit 1
fi
export INFANS_VAULT_ROOT
if [[ "${INFANS_CALENDAR_OS:-}" == "1" ]]; then
  export INFANS_CALENDAR_CACHE_DIR="${INFANS_VAULT_ROOT}/00_本地工作台/派生数据/calendar-cache"
fi
SERVER_STAMP=".local-workbench-server.stamp"
ACCESS_CONFIG=".workbench-access.local"
HEALTH_SYNC_CONFIG=".health-sync.local"
CODEX_COMMAND_CONFIG=".codex-command-sync.local"

# 本机口述识别由独立 LaunchAgent 维护生命周期；工作台只连接回环地址。
# 模型和可执行文件放在知识库外的支持目录，避免把大模型混进备份。
WORKSPACE_ROOT="$(cd ../../.. && pwd)"
WHISPERKIT_RUNTIME_DIR="${INFANS_WHISPERKIT_RUNTIME_DIR:-${WORKSPACE_ROOT}/Infans_Support/20_项目支持/whisperkit-local}"
WHISPERKIT_MODEL_NAME="large-v3-v20240930_626MB"
WHISPERKIT_MODEL_DIR="${WHISPERKIT_RUNTIME_DIR}/Models/models/argmaxinc/whisperkit-coreml/openai_whisper-${WHISPERKIT_MODEL_NAME}"
if [[ -x "${WHISPERKIT_RUNTIME_DIR}/.build/release/argmax-cli" && -d "${WHISPERKIT_MODEL_DIR}" ]]; then
  export INFANS_SECRETARY_TRANSCRIPTION_PROVIDER="${INFANS_SECRETARY_TRANSCRIPTION_PROVIDER:-whisperkit}"
  export INFANS_WHISPERKIT_BASE_URL="${INFANS_WHISPERKIT_BASE_URL:-http://127.0.0.1:50060/v1}"
  export INFANS_WHISPERKIT_MODEL="${INFANS_WHISPERKIT_MODEL:-${WHISPERKIT_MODEL_NAME}}"
fi

# 远程持久写入的服务端身份白名单只从 Git 忽略的 0600 本机文件读取。
# 文件只允许一行：INFANS_TAILSCALE_WRITE_LOGINS=login@example.com[,second@example.com]
if [[ -f "${ACCESS_CONFIG}" ]]; then
  access_mode="$(stat -f '%Lp' "${ACCESS_CONFIG}")"
  if [[ "${access_mode}" != "600" ]]; then
    echo "远程写入白名单权限必须是 600：${ACCESS_CONFIG}"
    exit 1
  fi
  access_line="$(sed -n 's/^INFANS_TAILSCALE_WRITE_LOGINS=//p' "${ACCESS_CONFIG}")"
  if [[ -z "${access_line}" || "${access_line}" == *$'\n'* || ! "${access_line}" =~ ^[A-Za-z0-9._%+@,-]+$ ]]; then
    echo "远程写入白名单格式不对：${ACCESS_CONFIG}"
    exit 1
  fi
  export INFANS_TAILSCALE_WRITE_LOGINS="${access_line}"
fi

# iPhone Apple Health 同步令牌与浏览器写入白名单分开保存；只注入运行进程，不进 Git 或日志。
if [[ -f "${HEALTH_SYNC_CONFIG}" ]]; then
  health_sync_mode="$(stat -f '%Lp' "${HEALTH_SYNC_CONFIG}")"
  if [[ "${health_sync_mode}" != "600" ]]; then
    echo "Apple Health 同步配置权限必须是 600：${HEALTH_SYNC_CONFIG}"
    exit 1
  fi
  health_sync_token="$(sed -n 's/^INFANS_HEALTH_SYNC_TOKEN=//p' "${HEALTH_SYNC_CONFIG}")"
  if [[ ! "${health_sync_token}" =~ ^[A-Za-z0-9_-]{43,128}$ ]]; then
    echo "Apple Health 同步配置格式不对：${HEALTH_SYNC_CONFIG}"
    exit 1
  fi
  export INFANS_HEALTH_SYNC_TOKEN="${health_sync_token}"
fi

# Apple Watch 自然语言指令使用独立令牌；它只授权写入可审计收件箱。
if [[ -f "${CODEX_COMMAND_CONFIG}" ]]; then
  command_mode="$(stat -f '%Lp' "${CODEX_COMMAND_CONFIG}")"
  if [[ "${command_mode}" != "600" ]]; then
    echo "小秘书指令令牌权限必须是 600：${CODEX_COMMAND_CONFIG}"
    exit 1
  fi
  command_token="$(sed -n 's/^INFANS_CODEX_COMMAND_TOKEN=//p' "${CODEX_COMMAND_CONFIG}")"
  if [[ ! "${command_token}" =~ ^[A-Za-z0-9_-]{43,128}$ ]]; then
    echo "小秘书指令令牌格式不对：${CODEX_COMMAND_CONFIG}"
    exit 1
  fi
  export INFANS_CODEX_COMMAND_TOKEN="${command_token}"
fi

if [[ ! -x ./node_modules/.bin/vite ]]; then
  echo "工作台依赖尚未安装。请在 app 目录运行 pnpm install。"
  exit 1
fi

# 跑构建产物而不是 dev server：首屏传输量从约 3.0 MB 降到几百 KB。
# 只在源码比产物新时重新构建，日常启动仍是秒开。
needs_build=0
if [[ ! -f dist/index.html ]]; then
  needs_build=1
elif [[ -n "$(find src public scripts/precompress.mjs index.html vite.config.ts package.json pnpm-lock.yaml -newer dist/index.html -print -quit 2>/dev/null)" ]]; then
  needs_build=1
fi

frontend_rebuilt=0
if [[ "${needs_build}" -eq 1 ]]; then
  echo "检测到源码改动，正在构建前端产物…"
  node scripts/build-frontend.mjs
  frontend_rebuilt=1
fi

# 运行中的服务不能只看“端口健康”：版本不一致或服务端源码比运行标记新，都说明可能仍是旧代码。
# 前端先按 mtime 构建；热修不必每次升 package.json（mtime 可触发重启）；正式发版再对齐版本号。
expected_version="$(node -p "require('./package.json').version")"
expected_instance_id="$(node --input-type=module -e 'import { instanceIdFor } from "./src/workbench-instance.mjs"; process.stdout.write(instanceIdFor(process.cwd(), process.env.INFANS_VAULT_ROOT || ""));')"
server_stale=0
if [[ ! -f "${SERVER_STAMP}" ]] || [[ -n "$(find src/server src/sidebar-bookmarks.mjs src/secretary-identity.mjs src/workbench-appearance.mjs src/workbench-theme-tokens.mjs src/workbench-preferences-model.mjs package.json -newer "${SERVER_STAMP}" -print -quit 2>/dev/null)" ]]; then
  server_stale=1
fi
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  health_json="$(curl --silent --fail --max-time 2 "${URL}/api/health" 2>/dev/null || true)"
  listener_pid="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN | sed -n '1p')"
  listener_command="$(ps -p "${listener_pid}" -o command= 2>/dev/null || true)"
  listener_cwd="$(lsof -a -p "${listener_pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p')"
  # 把健康检查、命令和 cwd 交给可测的判断脚本；默认不杀未知实例。
  decision_json="$(node -e '
    const healthRaw = process.argv[1];
    let health = null;
    try { health = healthRaw ? JSON.parse(healthRaw) : null; } catch { health = null; }
    process.stdout.write(JSON.stringify({
      health,
      listenerCommand: process.argv[2] || "",
      listenerCwd: process.argv[3] || "",
      expectedAppDir: process.argv[4],
      expectedVersion: process.argv[5],
      expectedVaultRoot: process.argv[6] || "",
      expectedInstanceId: process.argv[7] || "",
      serverStale: process.argv[8] === "1",
    }));
  ' "${health_json}" "${listener_command}" "${listener_cwd}" "${APP_DIR}" "${expected_version}" "${INFANS_VAULT_ROOT}" "${expected_instance_id}" "${server_stale}" | node scripts/decide-workbench-listener.mjs)"
  decision_action="$(printf '%s' "${decision_json}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(b).action||""))}catch{}})')"
  decision_reason="$(printf '%s' "${decision_json}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(b).reason||""))}catch{}})')"
  decision_signal="$(printf '%s' "${decision_json}" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(b).signal||""))}catch{}})')"
  if [[ "${decision_action}" == "already-running" ]]; then
    echo "Infans 本地工作台已经在运行：${URL}（本实例）"
    if [[ "${frontend_rebuilt}" -eq 1 ]]; then
      echo "前端产物刚重建过：页内「立即刷新」不够，请硬刷新（浏览器 ⌘⇧R；小秘书 App 用菜单「重新加载」或重开）。"
    fi
    exit 0
  fi
  if [[ "${decision_action}" != "restart-self" || "${decision_signal}" != "TERM" ]]; then
    echo "端口 ${PORT} 已被其他程序或另一套 Infans 占用（${decision_reason:-conflict}），未发送停止信号。"
    echo "请改 INFANS_PORT 后重试，或先自行停掉占用该端口的服务。"
    exit 1
  fi
  echo "检测到本实例需要平滑重启；正在停止本目录的服务…"
  kill -TERM "${listener_pid}"
  for _ in {1..50}; do
    sleep 0.2
    health_json="$(curl --silent --fail --max-time 1 "${URL}/api/health" 2>/dev/null || true)"
    replacement_pid="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | sed -n '1p' || true)"
    recovered="$(printf '%s' "$(node -e '
      const healthRaw = process.argv[1];
      let health = null;
      try { health = healthRaw ? JSON.parse(healthRaw) : null; } catch { health = null; }
      process.stdout.write(JSON.stringify({
        mode: "recover",
        health,
        expectedAppDir: process.argv[2],
        expectedVersion: process.argv[3],
        expectedVaultRoot: process.argv[4] || "",
        expectedInstanceId: process.argv[5] || "",
        replacementPid: process.argv[6] || "",
        previousPid: process.argv[7] || "",
      }));
    ' "${health_json}" "${APP_DIR}" "${expected_version}" "${INFANS_VAULT_ROOT}" "${expected_instance_id}" "${replacement_pid}" "${listener_pid}" | node scripts/decide-workbench-listener.mjs)" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(b).recovered===true))}catch{process.stdout.write("false")}})')"
    if [[ "${recovered}" == "true" ]]; then
      touch "${SERVER_STAMP}"
      echo "Infans 本地工作台已更新并恢复运行：${URL}"
      exit 0
    fi
  done
  if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "旧服务停止后未能恢复到 V${expected_version}，请查看启动终端日志。"
    exit 1
  fi
fi

# 接通电源时保持主机不因空闲进入系统睡眠，方便本机服务持续可连；显示器仍可正常熄灭。
# -w 跟随本脚本的生命周期，这样重启循环里的每次拉起都被覆盖。
/usr/bin/caffeinate -s -w $$ &

child=""
cleanup() {
  trap - INT TERM
  if [[ -n "${child}" ]]; then kill "${child}" 2>/dev/null || true; fi
  exit 0
}
trap cleanup INT TERM

echo "正在启动 Infans 本地工作台：${URL}"

backoff=1
fast_failures=0
while true; do
  started=$(date +%s)
  touch "${SERVER_STAMP}"
  node src/server/serve.mjs &
  child=$!
  set +e
  wait "${child}"
  status=$?
  set -e
  child=""

  # 跑够一分钟说明是运行中意外退出，重置退避；秒退则大概率是配置或语法问题。
  if [[ $(( $(date +%s) - started )) -ge 60 ]]; then
    backoff=1
    fast_failures=0
  else
    fast_failures=$(( fast_failures + 1 ))
  fi

  if [[ "${fast_failures}" -ge 5 ]]; then
    echo "本地服务连续 5 次刚启动就退出（最后退出码 ${status}），已停止重试。请查看上方报错。"
    exit 1
  fi

  echo "本地服务已退出（退出码 ${status}），${backoff} 秒后重启…"
  sleep "${backoff}"
  backoff=$(( backoff * 2 > 30 ? 30 : backoff * 2 ))
done
