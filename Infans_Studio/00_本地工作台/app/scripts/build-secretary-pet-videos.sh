#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PET_DIR="${APP_DIR}/native/secretary-pet"
VIDEO_DIR="${PET_DIR}/video"
QA_DIR="${APP_DIR}/../30_证据/2026-08-23_银月浮动宠物"
PYTHON_BIN="${CODEX_PRIMARY_PYTHON:-python3}"
MODULE_CACHE="${TMPDIR:-/tmp}/secretary-video-swift-module-cache"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/secretary-pet-video.XXXXXX")"
ENCODER="${TEMP_ROOT}/encode-secretary-hevc-alpha"
VALIDATOR="${TEMP_ROOT}/validate-secretary-pet-video"

cleanup() {
  if [[ -d "${TEMP_ROOT}" ]]; then
    find "${TEMP_ROOT}" -depth -delete
  fi
}
trap cleanup EXIT

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "找不到工作台 Python：${PYTHON_BIN}" >&2
  exit 1
fi

xcrun swiftc \
  -O \
  -target "$(uname -m)-apple-macos12.0" \
  -module-cache-path "${MODULE_CACHE}" \
  -framework AppKit \
  -framework AVFoundation \
  -framework VideoToolbox \
  "${APP_DIR}/scripts/encode-secretary-hevc-alpha.swift" \
  -o "${ENCODER}"

xcrun swiftc \
  -O \
  -target "$(uname -m)-apple-macos12.0" \
  -module-cache-path "${MODULE_CACHE}" \
  -framework AppKit \
  -framework AVFoundation \
  "${APP_DIR}/scripts/validate-secretary-pet-video.swift" \
  -o "${VALIDATOR}"

"${PYTHON_BIN}" "${APP_DIR}/scripts/build-secretary-pet-video-frames.py" \
  --identity "${PET_DIR}/identity-source.png" \
  --talking "${PET_DIR}/talking-video-keyframes.png" \
  --output-dir "${TEMP_ROOT}/frames" \
  --qa-dir "${QA_DIR}"

mkdir -p "${TEMP_ROOT}/video"
cp "${TEMP_ROOT}/frames/video-manifest.json" "${TEMP_ROOT}/video/video-manifest.json"

for state in idle hover launching talking dragging-right dragging-left; do
  case "${state}" in
    idle) expected_frames=90 ;;
    hover) expected_frames=48 ;;
    launching) expected_frames=30 ;;
    talking) expected_frames=36 ;;
    dragging-right|dragging-left) expected_frames=24 ;;
  esac
  "${ENCODER}" \
    "${TEMP_ROOT}/frames/${state}" \
    "${TEMP_ROOT}/video/${state}.mov" \
    30
  "${VALIDATOR}" \
    "${TEMP_ROOT}/video/${state}.mov" \
    "${expected_frames}" \
    "${TEMP_ROOT}/frames/${state}/0000.png"
done

mkdir -p "${VIDEO_DIR}"
for asset in video-manifest.json idle.mov hover.mov launching.mov talking.mov dragging-right.mov dragging-left.mov; do
  cp "${TEMP_ROOT}/video/${asset}" "${VIDEO_DIR}/${asset}"
done

echo "已生成透明视频：${VIDEO_DIR}"
echo "已更新逐帧证据：${QA_DIR}"
