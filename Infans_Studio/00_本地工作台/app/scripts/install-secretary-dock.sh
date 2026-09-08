#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKBENCH_DIR="$(cd "${APP_DIR}/.." && pwd)"
APP_BUNDLE="${WORKBENCH_DIR}/小秘书.app"
APP_BUNDLE="${APP_BUNDLE}" /usr/bin/python3 <<'PY'
import os
import plistlib
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote

app_path = Path(os.environ["APP_BUNDLE"]).resolve()
app_url = "file://" + quote(str(app_path)) + "/"
domain = "com.apple.dock"
data = plistlib.loads(subprocess.check_output(["defaults", "export", domain, "-"]))
apps = data.get("persistent-apps", [])

obsolete_ids = {"com.ifans.secretary.workbench"}
obsolete_names = {"小秘书.app"}

def keep(tile):
    tile_data = tile.get("tile-data", {})
    bundle_id = tile_data.get("bundle-identifier", "")
    raw_url = tile_data.get("file-data", {}).get("_CFURLString", "")
    return bundle_id not in obsolete_ids and not any(
        name in raw_url for name in obsolete_names
    )

data["persistent-apps"] = [tile for tile in apps if keep(tile)]
data["persistent-apps"].append(
    {
        "tile-data": {
            "bundle-identifier": "com.ifans.secretary.workbench",
            "dock-extra": False,
            "file-data": {
                "_CFURLString": app_url,
                "_CFURLStringType": 15,
            },
            "file-label": "小秘书",
            "file-type": 41,
        },
        "tile-type": "file-tile",
    }
)

with tempfile.NamedTemporaryFile(suffix=".plist", delete=False) as handle:
    temp_path = handle.name
    plistlib.dump(data, handle, fmt=plistlib.FMT_BINARY)

try:
    subprocess.run(["defaults", "import", domain, temp_path], check=True)
finally:
    Path(temp_path).unlink(missing_ok=True)
PY

/usr/bin/killall Dock >/dev/null 2>&1 || true

echo "程序坞已只保留「小秘书」原生 App。"
