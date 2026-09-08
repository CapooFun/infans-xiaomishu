#!/bin/bash
set -euo pipefail

LABEL="com.ifans.secretary.pet"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_VALUE="$(id -u)"

launchctl bootout "gui/${UID_VALUE}/${LABEL}" >/dev/null 2>&1 || true
rm -f "${PLIST}"

echo "已移除小秘书登录常驻；小秘书.app 与宠物资源仍然保留。"
