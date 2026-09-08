#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
config_path=".codex-command-sync.local"
copy_token=0
if [[ "${1:-}" == "--copy-token" ]]; then copy_token=1; fi

if [[ -f "${config_path}" ]]; then
  token="$(sed -n 's/^INFANS_CODEX_COMMAND_TOKEN=//p' "${config_path}")"
else
  token="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
  temporary_path="$(mktemp "${TMPDIR:-/tmp}/infans-codex-command.XXXXXX")"
  printf 'INFANS_CODEX_COMMAND_TOKEN=%s\n' "${token}" > "${temporary_path}"
  chmod 600 "${temporary_path}"
  mv "${temporary_path}" "${config_path}"
fi

if [[ ! "${token}" =~ ^[A-Za-z0-9_-]{43,128}$ ]]; then
  echo "现有小秘书指令令牌格式不对，请先检查 ${config_path}"
  exit 1
fi
chmod 600 "${config_path}"

if [[ "${copy_token}" -eq 1 ]]; then
  printf 'INFANS_CODEX_COMMAND_TOKEN=%s' "${token}" | pbcopy
  echo "小秘书指令令牌已复制到剪贴板；请在 iPhone 的“告诉银月”分区导入。"
else
  echo "小秘书指令令牌已准备好。需要配对 iPhone 时加 --copy-token。"
fi
