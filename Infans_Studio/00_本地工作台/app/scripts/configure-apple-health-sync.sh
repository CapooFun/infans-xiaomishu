#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

config_path=".health-sync.local"
temporary_path="${config_path}.tmp"

read_existing_token() {
  [[ -f "${config_path}" ]] || return 1
  [[ "$(stat -f '%Lp' "${config_path}")" == "600" ]] || {
    echo "Apple Health 同步配置权限必须是 600：${config_path}"
    exit 1
  }
  token="$(sed -n 's/^INFANS_HEALTH_SYNC_TOKEN=//p' "${config_path}")"
  [[ "${token}" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || {
    echo "Apple Health 同步配置格式不对：${config_path}"
    exit 1
  }
}

if [[ "${1:-}" == "--show-token" || "${1:-}" == "--copy-token" ]]; then
  if ! read_existing_token; then
    echo "还没有 Apple Health 同步令牌，请先运行：scripts/configure-apple-health-sync.sh"
    exit 1
  fi
  if [[ "${1:-}" == "--copy-token" ]]; then
    printf '%s' "${token}" | pbcopy
    echo "Apple Health 配对令牌已复制到 Mac 剪贴板；请立即粘贴到 iPhone App。"
    exit 0
  fi
  echo "仅用于配对 iPhone，粘贴后请不要保留在备忘录或聊天中："
  printf '%s\n' "${token}"
  exit 0
fi

if [[ -f "${config_path}" && "${1:-}" != "--rotate" ]]; then
  read_existing_token
  echo "Apple Health 私人同步令牌已存在，未覆盖：${config_path}"
  echo "需要给 iPhone 配对时运行：scripts/configure-apple-health-sync.sh --copy-token"
  exit 0
fi

token="$(node --input-type=module -e 'import crypto from "node:crypto"; process.stdout.write(crypto.randomBytes(32).toString("base64url"))')"

umask 077
trap 'rm -f "${temporary_path}"' EXIT
printf 'INFANS_HEALTH_SYNC_TOKEN=%s\n' "${token}" > "${temporary_path}"
chmod 600 "${temporary_path}"
mv "${temporary_path}" "${config_path}"
trap - EXIT

echo "Apple Health 私人同步令牌已生成：${config_path}（权限 600）"
echo "需要给 iPhone 配对时运行：scripts/configure-apple-health-sync.sh --copy-token"
