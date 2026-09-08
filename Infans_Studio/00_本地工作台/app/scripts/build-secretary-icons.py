#!/usr/bin/env python3
"""按各端指定源图生成小秘书图标，网页与原生可独立更新。"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image


APP_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = APP_DIR / "native" / "secretary-app-icon-yinyue-v2.png"


def save_square(source: Image.Image, size: int, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    resized = source.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(destination, format="PNG", optimize=True)


def replace_once(text: str, pattern: str, replacement: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1)
    if count != 1:
        raise RuntimeError(f"未找到唯一图标引用：{pattern}")
    return updated


def update_web_references(version: str) -> None:
    manifest_path = APP_DIR / "public" / "site.webmanifest"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["icons"] = [
        {
            "src": f"/secretary-icon-192.png?v={version}",
            "sizes": "192x192",
            "type": "image/png",
            "purpose": "any",
        },
        {
            "src": f"/secretary-icon-512.png?v={version}",
            "sizes": "512x512",
            "type": "image/png",
            "purpose": "any",
        },
    ]
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    index_path = APP_DIR / "index.html"
    index = index_path.read_text(encoding="utf-8")
    index = replace_once(
        index,
        r'<link rel="manifest" href="[^"]+" />',
        f'<link rel="manifest" href="/site.webmanifest?v={version}" />',
    )
    index = replace_once(
        index,
        r'<link rel="icon" type="image/png" sizes="32x32" href="[^"]+" />',
        f'<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v={version}" />',
    )
    index = replace_once(
        index,
        r'<link rel="icon" type="image/png" sizes="16x16" href="[^"]+" />',
        f'<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png?v={version}" />',
    )
    index = replace_once(
        index,
        r'<link rel="apple-touch-icon"(?: sizes="[^"]+")? href="[^"]+" />',
        f'<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v={version}" />',
    )
    index_path.write_text(index, encoding="utf-8")


def build_icons(source_path: Path, target: str) -> dict[str, object]:
    if not source_path.is_file():
        raise FileNotFoundError(f"图标源图不存在：{source_path}")

    source_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    version = source_hash[:12]
    native_dir = APP_DIR / "native"
    public_dir = APP_DIR / "public"
    master_path = native_dir / "secretary-app-icon-yinyue-v2.png"

    if target == "native" and source_path.resolve() != master_path.resolve():
        shutil.copy2(source_path, master_path)

    with Image.open(source_path) as opened:
        source = opened.convert("RGBA")
        if source.width != source.height:
            raise ValueError(f"图标源图必须为正方形：{source.width}x{source.height}")

        png_targets = {
            native_dir / "secretary-app-icon.png": 1024,
            public_dir / "apple-touch-icon.png": 180,
            public_dir / "secretary-icon-192.png": 192,
            public_dir / "secretary-icon-512.png": 512,
            public_dir / "favicon-32.png": 32,
            public_dir / "favicon-16.png": 16,
        }
        png_targets = {path: size for path, size in png_targets.items()
                       if (path.parent == native_dir) == (target == "native")}
        for destination, size in png_targets.items():
            save_square(source, size, destination)

        iconset_sizes = {
            "icon_16x16.png": 16,
            "icon_16x16@2x.png": 32,
            "icon_32x32.png": 32,
            "icon_32x32@2x.png": 64,
            "icon_128x128.png": 128,
            "icon_128x128@2x.png": 256,
            "icon_256x256.png": 256,
            "icon_256x256@2x.png": 512,
            "icon_512x512.png": 512,
            "icon_512x512@2x.png": 1024,
        }
        with tempfile.TemporaryDirectory(prefix="secretary-icon-") as temporary:
            temporary_dir = Path(temporary)
            iconset_dir = temporary_dir / "AppIcon.iconset"
            iconset_dir.mkdir()
            for filename, size in iconset_sizes.items():
                save_square(source, size, iconset_dir / filename)
            icns_path = temporary_dir / "secretary-app-icon.icns"
            subprocess.run(
                ["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)],
                check=True,
            )
            destination = native_dir / "secretary-app-icon.icns" if target == "native" else public_dir / "secretary-app.icns"
            shutil.copy2(icns_path, destination)

    if target == "web":
        update_web_references(version)
    return {
        "source": str(source_path),
        "target": target,
        "sourceSha256": source_hash,
        "cacheVersion": version,
        "webIcons": [180, 192, 512, 32, 16] if target == "web" else [],
        "nativeIcns": target == "native",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--target", choices=["all", "native", "web"], default="all")
    args = parser.parse_args()
    results = []
    if args.target in ("all", "native"):
        results.append(build_icons(args.source.resolve(), "native"))
    if args.target in ("all", "web"):
        config = json.loads((APP_DIR / "scripts/secretary-webapp-icon.json").read_text())
        web_source = (APP_DIR.parents[1] / config["source"]).resolve()
        if hashlib.sha256(web_source.read_bytes()).hexdigest() != config["sha256"]:
            raise ValueError("网页图标源图摘要已变化，请核对本人指定素材")
        results.append(build_icons(web_source, "web"))
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
