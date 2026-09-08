#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKBENCH_DIR="$(cd "${APP_DIR}/.." && pwd)"
EXECUTABLE="${WORKBENCH_DIR}/小秘书.app/Contents/MacOS/小秘书"
LABEL="com.ifans.secretary.pet"
AGENT_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/Library/Logs/Infans"
PLIST="${AGENT_DIR}/${LABEL}.plist"
UID_VALUE="$(id -u)"

if [[ ! -x "${EXECUTABLE}" ]]; then
  echo "找不到可执行的小秘书.app，请先运行 build-secretary-native-app.sh。" >&2
  exit 1
fi

mkdir -p "${AGENT_DIR}" "${LOG_DIR}"
cat >"${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${EXECUTABLE}</string>
    <string>--pet-only</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/secretary-pet.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/secretary-pet.log</string>
</dict>
</plist>
PLIST

plutil -lint "${PLIST}" >/dev/null
launchctl bootout "gui/${UID_VALUE}/${LABEL}" >/dev/null 2>&1 || true
BOOTSTRAPPED=false
for ATTEMPT in 1 2 3 4 5; do
  if launchctl bootstrap "gui/${UID_VALUE}" "${PLIST}" 2>/dev/null; then
    BOOTSTRAPPED=true
    break
  fi
  sleep 0.25
done
if [[ "${BOOTSTRAPPED}" != "true" ]]; then
  echo "小秘书登录常驻项未能载入，请稍后重试。" >&2
  exit 1
fi

echo "已安装小秘书登录常驻：登录后只显示浮动宠物，不会主动打开工作台。"
