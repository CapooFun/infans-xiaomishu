#!/usr/bin/env bash
set -euo pipefail

WEBAPP="${HOME}/Applications/小秘书.app"
[[ -d "${WEBAPP}" ]] || WEBAPP="${HOME}/Applications/梅凝小秘书.app"
ICNS="$(cd "$(dirname "$0")/.." && pwd)/public/secretary-app.icns"
FALLBACK="${INFANS_APP_ICNS:-}"
ICON_SRC="${ICNS}"
[[ -f "${ICON_SRC}" ]] || ICON_SRC="${FALLBACK}"

if [[ ! -d "${WEBAPP}" ]]; then
  echo "找不到小秘书 Web App。请先 Safari：文件 → 添加到程序坞…，名称填「小秘书」。"
  exit 1
fi

/usr/bin/osascript -l JavaScript <<JXA
ObjC.import('AppKit');
const webapp = '${WEBAPP//\'/\\\'}';
const icon = '${ICON_SRC//\'/\\\'}';
const img = $.NSImage.alloc.initWithContentsOfFile(icon);
if (!img) { throw new Error('icon load fail: ' + icon); }
const ok = $.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, webapp, 0);
if (!ok) { throw new Error('setIcon failed'); }
console.log('ICON_SET_OK');
JXA

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${WEBAPP}" >/dev/null 2>&1 || true
killall Dock >/dev/null 2>&1 || true
echo "已为 Web App 挂上透明 logo。再点一次小秘书看 Dock。"
