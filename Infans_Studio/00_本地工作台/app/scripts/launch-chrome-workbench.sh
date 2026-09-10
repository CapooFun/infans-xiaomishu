#!/bin/bash
set -euo pipefail

# 浏览器回退入口；日常桌面入口是原生 小秘书.app（WKWebView），不必另开专用 Chrome。
# auto/safari → 打开 Safari；INFANS_WORKBENCH_BROWSER=chrome → 普通 Chrome 打开工作台网址。
# 本脚本不加载浏览器扩展，也不使用专用 profile。

WORKBENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START_COMMAND="${WORKBENCH_DIR}/启动Infans本地工作台.command"
LOG_FILE="${WORKBENCH_DIR}/.chrome-launcher.log"
URL="http://127.0.0.1:5173"
BROWSER="${INFANS_WORKBENCH_BROWSER:-auto}"

notify() {
  local message="$1"
  /usr/bin/osascript - "$message" <<'OSA' >/dev/null 2>&1 || true
on run argv
  display notification (item 1 of argv) with title "小秘书"
end run
OSA
}

notify_failure() {
  notify "$1"
}

if [[ ! -x "${START_COMMAND}" ]]; then
  notify_failure "找不到工作台启动脚本"
  exit 1
fi

if ! INFANS_WORKBENCH_SKIP_BROWSER=1 /usr/bin/env bash "${START_COMMAND}" >>"${LOG_FILE}" 2>&1; then
  notify_failure "工作台服务启动失败，请查看 .chrome-launcher.log"
  exit 1
fi

open_safari() {
  if [[ ! -d "/Applications/Safari.app" ]]; then
    notify_failure "找不到 Safari"
    exit 1
  fi
  open -a Safari "${URL}"
}

open_chrome_app() {
  if [[ ! -d "/Applications/Google Chrome.app" ]] && [[ ! -d "${HOME}/Applications/Google Chrome.app" ]]; then
    notify_failure "找不到 Google Chrome"
    exit 1
  fi
  open -a "Google Chrome" "${URL}"
}

case "${BROWSER}" in
  auto|safari|Safari|SAFARI)
    open_safari
    ;;
  chrome|Chrome|CHROME)
    open_chrome_app
    ;;
  *)
    notify_failure "未知浏览器：${BROWSER}（auto / safari / chrome）"
    exit 1
    ;;
esac
