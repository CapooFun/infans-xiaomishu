#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

read -r -s -p "请输入新的资产页口令（至少 10 个字符）: " asset_password
echo
read -r -s -p "请再次输入: " asset_password_confirm
echo

if [[ "${asset_password}" != "${asset_password_confirm}" ]]; then
  unset asset_password asset_password_confirm
  echo "两次输入不一致，未修改。" >&2
  exit 1
fi
if [[ ${#asset_password} -lt 10 ]]; then
  unset asset_password asset_password_confirm
  echo "口令至少需要 10 个字符，未修改。" >&2
  exit 1
fi

asset_hash="$({ printf '%s' "${asset_password}"; } | node --input-type=module -e '
  import { hashAssetPassword } from "./src/server/workbench-assets.mjs";
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  process.stdout.write(hashAssetPassword(value));
')"
unset asset_password asset_password_confirm

ASSET_HASH="${asset_hash}" node --input-type=module -e '
  import { writeAssetPasswordHash } from "./src/server/workbench-assets.mjs";
  writeAssetPasswordHash(process.env.ASSET_HASH);
'
unset asset_hash

echo "资产页口令已更新；旧的资产会话将在重启工作台后失效。"
