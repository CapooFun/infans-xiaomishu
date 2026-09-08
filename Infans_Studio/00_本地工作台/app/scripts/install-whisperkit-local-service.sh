#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "${APP_DIR}/../../.." && pwd)"
RUNTIME_DIR="${INFANS_WHISPERKIT_RUNTIME_DIR:-${WORKSPACE_ROOT}/Infans_Support/20_项目支持/whisperkit-local}"
EXECUTABLE="${RUNTIME_DIR}/.build/release/argmax-cli"
MODEL="large-v3-v20240930_626MB"
MODEL_DIR="${RUNTIME_DIR}/Models/models/argmaxinc/whisperkit-coreml/openai_whisper-${MODEL}"
MODEL_CACHE="${RUNTIME_DIR}/Models"
LABEL="com.capoo.infans-whisperkit-local"
AGENT_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/Library/Logs/Infans"
PLIST="${AGENT_DIR}/${LABEL}.plist"
UID_VALUE="$(id -u)"

if [[ ! -x "${EXECUTABLE}" ]]; then
  echo "找不到 WhisperKit 可执行文件：${EXECUTABLE}" >&2
  echo "请先在运行目录执行 make build-local-server。" >&2
  exit 1
fi
if [[ ! -d "${MODEL_DIR}" ]]; then
  echo "找不到 WhisperKit 模型：${MODEL_DIR}" >&2
  echo "请先用 argmax-cli serve --model ${MODEL} --download-model-path ${MODEL_CACHE} 完成首次下载。" >&2
  exit 1
fi

mkdir -p "${AGENT_DIR}" "${LOG_DIR}"
TEMP_PLIST="$(mktemp "${TMPDIR:-/tmp}/infans-whisperkit-launchagent.XXXXXX")"
cleanup() {
  rm -f "${TEMP_PLIST}"
}
trap cleanup EXIT

plutil -create xml1 "${TEMP_PLIST}"
plutil -insert Label -string "${LABEL}" "${TEMP_PLIST}"
plutil -insert ProgramArguments -array "${TEMP_PLIST}"
plutil -insert ProgramArguments.0 -string "${EXECUTABLE}" "${TEMP_PLIST}"
plutil -insert ProgramArguments.1 -string "serve" "${TEMP_PLIST}"
plutil -insert ProgramArguments.2 -string "--host" "${TEMP_PLIST}"
plutil -insert ProgramArguments.3 -string "127.0.0.1" "${TEMP_PLIST}"
plutil -insert ProgramArguments.4 -string "--port" "${TEMP_PLIST}"
plutil -insert ProgramArguments.5 -string "50060" "${TEMP_PLIST}"
plutil -insert ProgramArguments.6 -string "--model" "${TEMP_PLIST}"
plutil -insert ProgramArguments.7 -string "${MODEL}" "${TEMP_PLIST}"
plutil -insert ProgramArguments.8 -string "--download-model-path" "${TEMP_PLIST}"
plutil -insert ProgramArguments.9 -string "${MODEL_CACHE}" "${TEMP_PLIST}"
plutil -insert WorkingDirectory -string "${RUNTIME_DIR}" "${TEMP_PLIST}"
plutil -insert RunAtLoad -bool true "${TEMP_PLIST}"
plutil -insert KeepAlive -bool true "${TEMP_PLIST}"
plutil -insert ThrottleInterval -integer 5 "${TEMP_PLIST}"
plutil -insert ProcessType -string Background "${TEMP_PLIST}"
plutil -insert StandardOutPath -string "${LOG_DIR}/whisperkit-local.log" "${TEMP_PLIST}"
plutil -insert StandardErrorPath -string "${LOG_DIR}/whisperkit-local.log" "${TEMP_PLIST}"
plutil -lint "${TEMP_PLIST}" >/dev/null
install -m 644 "${TEMP_PLIST}" "${PLIST}"

launchctl bootout "gui/${UID_VALUE}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_VALUE}" "${PLIST}"

for _ in {1..180}; do
  if curl --silent --fail --max-time 1 http://127.0.0.1:50060/health >/dev/null 2>&1; then
    echo "WhisperKit 本地服务已安装并就绪：http://127.0.0.1:50060"
    exit 0
  fi
  sleep 0.5
done

echo "WhisperKit 常驻项已安装，但服务未在九十秒内就绪。最近日志：" >&2
tail -n 40 "${LOG_DIR}/whisperkit-local.log" >&2 || true
exit 1
