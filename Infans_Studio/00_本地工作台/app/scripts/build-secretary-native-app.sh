#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKBENCH_DIR="$(cd "${APP_DIR}/.." && pwd)"
SOURCE="${APP_DIR}/native/SecretaryApp.swift"
CODEX_SHORTCUT_SOURCE="${APP_DIR}/native/CodexShortcutController.swift"
CALENDAR_SOURCE="${APP_DIR}/native/CalendarReaderService.swift"
PET_ASSET_DIR="${APP_DIR}/native/secretary-pet"
PET_VIDEO_DIR="${PET_ASSET_DIR}/video"
ICON_SOURCE="${APP_DIR}/native/secretary-app-icon.icns"
APP_BUNDLE="${WORKBENCH_DIR}/小秘书.app"
INFO_PLIST="${APP_BUNDLE}/Contents/Info.plist"
BUNDLE_ID="com.ifans.secretary.workbench"
ARCH="$(uname -m)"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/secretary-native-build.XXXXXX")"
TEMP_EXECUTABLE="${TEMP_ROOT}/build/小秘书"
STAGED_APP="${TEMP_ROOT}/小秘书.app"
STAGED_CONTENTS="${STAGED_APP}/Contents"
STAGED_RESOURCES="${STAGED_CONTENTS}/Resources"
PREVIOUS_APP="${TEMP_ROOT}/previous-小秘书.app"
MODULE_CACHE="${TMPDIR:-/tmp}/secretary-swift-module-cache"

cleanup() {
  local cleanup_status=$?
  if [[ ! -d "${APP_BUNDLE}" && -d "${PREVIOUS_APP}" ]]; then
    mv "${PREVIOUS_APP}" "${APP_BUNDLE}"
  fi
  rm -rf "${TEMP_ROOT}"
  return ${cleanup_status}
}
trap cleanup EXIT

resolve_signing_identity() {
  if [[ -n "${INFANS_SECRETARY_CODESIGN_IDENTITY:-}" ]]; then
    printf '%s\n' "${INFANS_SECRETARY_CODESIGN_IDENTITY}"
    return 0
  fi

  /usr/bin/security find-identity -v -p codesigning 2>/dev/null \
    | /usr/bin/awk '
      /Developer ID Application:/ { print $2; found = 1; exit }
      /Apple Development:/ && candidate == "" { candidate = $2 }
      END { if (!found && candidate != "") print candidate }
    '
}

SIGNING_IDENTITY="$(resolve_signing_identity)"
if [[ -z "${SIGNING_IDENTITY}" ]]; then
  cat >&2 <<'EOF'
没有找到可用的 Mac 代码签名身份，已停止构建；旧的小秘书.app 不会被覆盖。
请在 Xcode → Settings → Apple Accounts → Personal Team → Manage Certificates 中创建 Apple Development 证书，然后重试。
EOF
  exit 1
fi

if [[ ! -f "${SOURCE}" || ! -f "${CODEX_SHORTCUT_SOURCE}" || ! -f "${ICON_SOURCE}" || ! -f "${INFO_PLIST}" ]]; then
  echo "找不到小秘书原生 App 源码、图标或 Info.plist。" >&2
  exit 1
fi

for asset in \
  secretary-pet-atlas.png \
  animation-manifest.json \
  video/video-manifest.json \
  video/idle.mov \
  video/hover.mov \
  video/launching.mov \
  video/talking.mov \
  video/dragging-right.mov \
  video/dragging-left.mov; do
  if [[ ! -f "${PET_ASSET_DIR}/${asset}" ]]; then
    echo "找不到浮动宠物资源：${PET_ASSET_DIR}/${asset}" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "${TEMP_EXECUTABLE}")" "${STAGED_CONTENTS}/MacOS" "${STAGED_RESOURCES}/secretary-pet-video"

xcrun swiftc \
  -O \
  -target "${ARCH}-apple-macos12.0" \
  -module-cache-path "${MODULE_CACHE}" \
  -framework AppKit \
  -framework ApplicationServices \
  -framework AVFoundation \
  -framework QuartzCore \
  -framework Speech \
  -framework WebKit \
  -framework EventKit \
  "${SOURCE}" \
  "${CODEX_SHORTCUT_SOURCE}" \
  "${CALENDAR_SOURCE}" \
  -o "${TEMP_EXECUTABLE}"

chmod 755 "${TEMP_EXECUTABLE}"
cp "${INFO_PLIST}" "${STAGED_CONTENTS}/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :NSCalendarsFullAccessUsageDescription 小秘书需要直接读取日程并及时显示变化；写入仍只按你确认的操作执行。' "${STAGED_CONTENTS}/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :NSCalendarsUsageDescription string 小秘书需要读取你的近期日程。' "${STAGED_CONTENTS}/Info.plist" 2>/dev/null || true
cp "${TEMP_EXECUTABLE}" "${STAGED_CONTENTS}/MacOS/小秘书"
cp "${PET_ASSET_DIR}/secretary-pet-atlas.png" "${STAGED_RESOURCES}/secretary-pet-atlas.png"
cp "${PET_ASSET_DIR}/animation-manifest.json" "${STAGED_RESOURCES}/animation-manifest.json"
cp "${ICON_SOURCE}" "${STAGED_RESOURCES}/小秘书.icns"
for asset in video-manifest.json idle.mov hover.mov launching.mov talking.mov dragging-right.mov dragging-left.mov; do
  cp "${PET_VIDEO_DIR}/${asset}" "${STAGED_RESOURCES}/secretary-pet-video/${asset}"
done

if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${STAGED_CONTENTS}/Info.plist")" != "${BUNDLE_ID}" ]]; then
  echo "小秘书 Bundle ID 不是稳定值 ${BUNDLE_ID}，已停止构建。" >&2
  exit 1
fi

/usr/bin/codesign \
  --force \
  --sign "${SIGNING_IDENTITY}" \
  --identifier "${BUNDLE_ID}" \
  --timestamp=none \
  "${STAGED_APP}"

/usr/bin/codesign --verify --deep --strict --verbose=2 "${STAGED_APP}"
SIGNATURE_INFO="$(/usr/bin/codesign -dvvv --requirements - "${STAGED_APP}" 2>&1)"
if ! grep -Fq "Identifier=${BUNDLE_ID}" <<<"${SIGNATURE_INFO}" \
  || grep -Fq "Signature=adhoc" <<<"${SIGNATURE_INFO}" \
  || grep -Fq "TeamIdentifier=not set" <<<"${SIGNATURE_INFO}" \
  || grep -Fq "designated => cdhash" <<<"${SIGNATURE_INFO}"; then
  echo "小秘书签名没有形成稳定代码身份，已停止替换现有 App。" >&2
  printf '%s\n' "${SIGNATURE_INFO}" >&2
  exit 1
fi

# 可变聊天数据不能放在被签名封存的 .app 包内。
# 先无损复制到包外运行目录；只有签名验证通过后才替换旧 App。
node "${APP_DIR}/scripts/migrate-secretary-runtime-data.mjs" --workbench "${WORKBENCH_DIR}"

mv "${APP_BUNDLE}" "${PREVIOUS_APP}"
mv "${STAGED_APP}" "${APP_BUNDLE}"
rm -rf "${PREVIOUS_APP}"

echo "已构建并稳定签名：${APP_BUNDLE}"
echo "签名身份：${SIGNING_IDENTITY}"
