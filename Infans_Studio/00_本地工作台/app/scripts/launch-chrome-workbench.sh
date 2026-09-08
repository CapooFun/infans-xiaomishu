#!/bin/bash
set -euo pipefail

# 浏览器回退入口；日常桌面入口是原生 小秘书.app（WKWebView）。
# 1) 若已有 Safari「添加到程序坞」的 Web App（~/Applications/小秘书.app）→ 只亮小秘书，Dock 不抢 Safari
# 2) 否则默认 open -a Safari（丝滑；日常 Chrome 易被扩展拖垮）
# 3) INFANS_WORKBENCH_BROWSER=chrome → 原专用 Chrome app 窗口 + 问问小秘书扩展

WORKBENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START_COMMAND="${WORKBENCH_DIR}/启动Infans本地工作台.command"
LOG_FILE="${WORKBENCH_DIR}/.chrome-launcher.log"
URL="http://127.0.0.1:5173"
CHROME_PROFILE="${HOME}/Library/Application Support/Infans/小秘书工作台 Chrome"
BROWSER="${INFANS_WORKBENCH_BROWSER:-auto}"
WEBAPP_NAME="小秘书"
WEBAPP_PATH="${HOME}/Applications/${WEBAPP_NAME}.app"

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

dialog_setup_webapp() {
  /usr/bin/osascript <<OSA >/dev/null 2>&1 || true
display dialog "可以把工作台做成独立 Web App，之后 Dock 只亮「${WEBAPP_NAME}」，不再亮 Safari。

步骤（一次性）：
1. 等 Safari 打开工作台
2. 菜单栏：文件 → 添加到程序坞…
3. 名称填：${WEBAPP_NAME}
4. 再次点小秘书即可

也可稍后再做；现在会先用 Safari 打开。" buttons {"知道了"} default button 1 with title "小秘书 · Dock 深度整合"
OSA
}

if [[ ! -x "${START_COMMAND}" ]]; then
  notify_failure "找不到工作台启动脚本"
  exit 1
fi

if ! INFANS_WORKBENCH_SKIP_BROWSER=1 /usr/bin/env bash "${START_COMMAND}" >>"${LOG_FILE}" 2>&1; then
  notify_failure "工作台服务启动失败，请查看 .chrome-launcher.log"
  exit 1
fi

open_safari_webapp() {
  if [[ ! -d "${WEBAPP_PATH}" ]]; then
    return 1
  fi

  local lock_dir="${HOME}/Library/Application Support/Infans/secretary-place.lockdir"
  mkdir -p "${HOME}/Library/Application Support/Infans"
  if ! mkdir "${lock_dir}" 2>/dev/null; then
    local owner_pid=""
    if [[ -r "${lock_dir}/pid" ]]; then
      IFS= read -r owner_pid <"${lock_dir}/pid" || true
    fi
    if [[ "${owner_pid}" =~ ^[0-9]+$ ]] && kill -0 "${owner_pid}" 2>/dev/null; then
      echo "secretary-launch: placement already running pid=${owner_pid}; activate existing Web App" >>"${LOG_FILE}"
      open "${WEBAPP_PATH}" >/dev/null 2>&1 || true
      return 0
    fi
    rm -f "${lock_dir}/pid" 2>/dev/null || true
    rmdir "${lock_dir}" 2>/dev/null || true
    if ! mkdir "${lock_dir}" 2>/dev/null; then
      echo "secretary-launch: cannot acquire placement lock" >>"${LOG_FILE}"
      return 1
    fi
  fi
  printf '%s\n' "$$" >"${lock_dir}/pid"
  # shellcheck disable=SC2064
  trap 'rm -f "'"${lock_dir}"'/pid" 2>/dev/null || true; rmdir "'"${lock_dir}"'" 2>/dev/null || true' EXIT

  local webapp_bid=""
  webapp_bid="$(/usr/bin/defaults read "${WEBAPP_PATH}/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"

  # 冷启动：旧全屏实例 AX 常报 wins=0，脚本空等失败，窗口却在主屏以窗口模式冒出
  echo "secretary-launch: cold quit ${webapp_bid:-webapp}" >>"${LOG_FILE}"
  if [[ -n "${webapp_bid}" ]]; then
    pkill -f "Web App.*--bundleidentifier ${webapp_bid}" >/dev/null 2>&1 || true
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if [[ -z "${webapp_bid}" ]] || ! pgrep -f "Web App.*--bundleidentifier ${webapp_bid}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
  sleep 0.35

  open "${WEBAPP_PATH}" || return 1
  sleep 0.7

  echo "secretary-launch: place begin $(date +%H:%M:%S)" >>"${LOG_FILE}"
  local jxa_log
  jxa_log="$(mktemp)"
  if /usr/bin/osascript -l JavaScript "${WORKBENCH_DIR}/app/scripts/place-secretary-webapp.jxa" \
    "${WEBAPP_PATH}" "${WEBAPP_NAME}" "${webapp_bid}" >"${jxa_log}" 2>&1 \
    && grep -q "final ok=true" "${jxa_log}"; then
    cat "${jxa_log}" >>"${LOG_FILE}"
    echo "secretary-launch: place ok $(date +%H:%M:%S)" >>"${LOG_FILE}"
    rm -f "${jxa_log}"
    rm -f "${lock_dir}/pid" 2>/dev/null || true
    rmdir "${lock_dir}" 2>/dev/null || true
    trap - EXIT
    return 0
  fi
  cat "${jxa_log}" >>"${LOG_FILE}" || true
  rm -f "${jxa_log}"

  echo "secretary-launch: place FAILED $(date +%H:%M:%S)" >>"${LOG_FILE}"
  notify_failure "副屏系统全屏未完成，请检查「梅凝启动 / 梅凝」辅助功能权限"
  /usr/bin/osascript >/dev/null 2>&1 <<'OSA' || true
display dialog "梅凝没能投到副屏全屏。

系统设置 → 隐私与安全性 → 辅助功能：
1. 将「梅凝启动」关闭后重新打开
2. 若列表中有「梅凝」，也关闭后重新打开
3. 确认副屏仍处于连接状态

完成后再点一次程序坞里的「梅凝启动」。" buttons {"打开辅助功能", "知道了"} default button 1 with title "梅凝 · 副屏全屏未完成"
if button returned of result is "打开辅助功能" then
  open location "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
end if
OSA
  rm -f "${lock_dir}/pid" 2>/dev/null || true
  rmdir "${lock_dir}" 2>/dev/null || true
  trap - EXIT
  return 1
}

open_safari() {
  if [[ ! -d "/Applications/Safari.app" ]]; then
    notify_failure "找不到 Safari"
    exit 1
  fi
  open -a Safari "${URL}"
}

open_chrome_app() {
  local chrome_bin=""
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta" \
    "${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [[ -x "${candidate}" ]]; then
      chrome_bin="${candidate}"
      break
    fi
  done

  if [[ -z "${chrome_bin}" ]]; then
    notify_failure "找不到 Google Chrome"
    exit 1
  fi

  local display_info
  display_info="$(/usr/bin/osascript -l JavaScript <<'JXA' 2>/dev/null || true
ObjC.import('AppKit');
const screens = $.NSScreen.screens;
const count = Number(screens.count);
if (count < 1) {
  console.log('0\t0\t0\t0\t0');
} else {
  const primary = screens.objectAtIndex(0);
  const screen = screens.objectAtIndex(count > 1 ? 1 : 0);
  const primaryFrame = primary.frame;
  const frame = screen.frame;
  const n = value => Math.round(Number(value));
  const chromeTop = n(primaryFrame.origin.y) + n(primaryFrame.size.height);
  const chromeY = chromeTop - (n(frame.origin.y) + n(frame.size.height));
  console.log([count, n(frame.origin.x), chromeY, n(frame.size.width), n(frame.size.height)].join('\t'));
}
JXA
)"

  local screen_count screen_x screen_y screen_width screen_height
  IFS=$'\t' read -r screen_count screen_x screen_y screen_width screen_height <<<"${display_info:-0$'\t'0$'\t'0$'\t'0$'\t'0}"

  local chrome_args=(
    "--user-data-dir=${CHROME_PROFILE}"
    --no-first-run
    --no-default-browser-check
    --disable-session-crashed-bubble
    --disable-component-extensions-with-background-pages
    --disable-features=PasswordManagerOnboarding,PasswordManagerUI,AutofillServerCommunication
    --password-store=basic
    "--load-extension=${WORKBENCH_DIR}/chrome-extension-问问小秘书"
    "--app=${URL}"
  )

  if [[ "${screen_count:-0}" =~ ^[0-9]+$ ]] && (( screen_count > 1 )); then
    chrome_args+=(
      "--window-position=${screen_x},${screen_y}"
      "--window-size=${screen_width},${screen_height}"
    )
  fi

  local pref_dir="${CHROME_PROFILE}/Default"
  local pref_file="${pref_dir}/Preferences"
  mkdir -p "${pref_dir}"
  /usr/bin/python3 - "${pref_file}" <<'PY' >/dev/null 2>&1 || true
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
data = {}
if path.exists():
    try:
        data = json.loads(path.read_text())
    except Exception:
        data = {}
data["credentials_enable_service"] = False
data["credentials_enable_autosignin"] = False
profile = data.setdefault("profile", {})
profile["password_manager_enabled"] = False
profile["password_manager_leak_detection"] = False
autofill = data.setdefault("autofill", {})
autofill["profile_enabled"] = False
autofill["credit_card_enabled"] = False
icloud_passwords_ext = "pejdijmoenmkgeppbflobdenhhabjlaj"
ext_settings = data.setdefault("extensions", {}).setdefault("settings", {})
if icloud_passwords_ext in ext_settings and isinstance(ext_settings[icloud_passwords_ext], dict):
    ext_settings[icloud_passwords_ext]["state"] = 0
path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
PY

  local existing_pids
  existing_pids="$(pgrep -f "user-data-dir=${CHROME_PROFILE}" || true)"
  if [[ -n "${existing_pids}" ]]; then
    # shellcheck disable=SC2086
    kill ${existing_pids} >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ! pgrep -f "user-data-dir=${CHROME_PROFILE}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.3
    done
    if pgrep -f "user-data-dir=${CHROME_PROFILE}" >/dev/null 2>&1; then
      # shellcheck disable=SC2086
      kill -9 ${existing_pids} >/dev/null 2>&1 || true
      sleep 0.4
    fi
  fi

  nohup "${chrome_bin}" "${chrome_args[@]}" >/dev/null 2>&1 &
}

case "${BROWSER}" in
  auto|safari|Safari|SAFARI)
    if [[ -d "${WEBAPP_PATH}" ]]; then
      if open_safari_webapp; then
        exit 0
      fi
      # Web App 存在但投屏失败时禁止再开普通 Safari 窗口到主屏。
      exit 1
    fi
    if [[ ! -f "${HOME}/Library/Application Support/Infans/secretary-webapp-hinted" ]]; then
      mkdir -p "${HOME}/Library/Application Support/Infans"
      dialog_setup_webapp
      : > "${HOME}/Library/Application Support/Infans/secretary-webapp-hinted"
    fi
    open_safari
    ;;
  webapp|WebApp|WEBAPP)
    if [[ -d "${WEBAPP_PATH}" ]]; then
      if open_safari_webapp; then
        exit 0
      fi
      exit 1
    fi
    notify_failure "尚未创建「${WEBAPP_NAME}」Web App：Safari → 文件 → 添加到程序坞"
    open_safari
    dialog_setup_webapp
    ;;
  chrome|Chrome|CHROME)
    open_chrome_app
    ;;
  *)
    notify_failure "未知浏览器：${BROWSER}（auto / safari / webapp / chrome）"
    exit 1
    ;;
esac
