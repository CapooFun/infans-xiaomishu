#!/bin/bash
# 安装 Infans 周期性 AI 定时（每日轻量检查 / 每周版本收口 / 身心日评 / 月度总结 / 训练复盘 / 日本活动 / AI 工具季报）
# 统一形态：launchd → ~/.local/bin/*.sh → 本地岗位入口 → 当前 Agent 适配器；每日轻量检查不调用模型
set -euo pipefail

VAULT="${INFANS_VAULT_ROOT:-$HOME/Infans_Studio}"
BIN="$HOME/.local/bin"
STATE="$HOME/.local/state"
AGENTS="$HOME/Library/LaunchAgents"
AGENT_RUNNER="$VAULT/00_本地工作台/app/scripts/infans-agent-runner.mjs"
ACTIVITY_MODEL="${INFANS_JAPAN_ACTIVITIES_MODEL:-}"

mkdir -p "$BIN" "$STATE" "$AGENTS" \
  "$VAULT/40_身心健康/状态报告/身心日评历史" \
  "$VAULT/10_日志记录/月度回顾"

uid="$(id -u)"

write_runner() {
  local name="$1"
  local title="$2"
  local role_id="$3"
  local stamp_file="$4"   # file whose date: frontmatter we check; empty = skip date check
  local health_gate="${5:-0}"
  local mutex_group="${6:-}"
  local out="$BIN/$name"

  cat > "$out" <<EOF
#!/bin/bash
# Infans · ${title}（launchd → 本地岗位入口）
set -u
export PATH="${HOME}/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH"
export LANG="\${LANG:-en_US.UTF-8}"
export LC_ALL="\${LC_ALL:-en_US.UTF-8}"

VAULT="${VAULT}"
AGENT_RUNNER="${AGENT_RUNNER}"
ROLE_ID="${role_id}"
LOG="\$HOME/.local/state/${name%.sh}.log"
LOCK_DIR="\$HOME/.local/state/${name%.sh}.lock"
MUTEX_GROUP="${mutex_group}"
MUTEX_DIR="\$HOME/.local/state/infans_\${MUTEX_GROUP}.lock"
MUTEX_HELD=0
TODAY="\$(TZ=Asia/Tokyo date '+%Y-%m-%d')"
STAMP="\$(TZ=Asia/Tokyo date '+%F %T %Z')"
STAMP_FILE="${stamp_file}"
HEALTH_GATE_ENABLED="${health_gate}"
HEALTH_GATE="\$VAULT/00_本地工作台/app/scripts/check-health-source-readiness.mjs"

mkdir -p "\$(dirname "\$LOG")"

log() { echo "\$STAMP \$*" >> "\$LOG"; }
notify() {
  log "❌ \$1"
  osascript -e "display notification \\"\$1\\" with title \\"Infans ${title}\\" sound name \\"Basso\\"" 2>/dev/null || true
}

notify_ok() {
  log "✅ \$1"
  osascript -e "display notification \\"\$1\\" with title \\"Infans ${title}\\" sound name \\"Glass\\"" 2>/dev/null || true
}

cleanup() {
  rmdir "\$LOCK_DIR" 2>/dev/null || true
  if [[ "\$MUTEX_HELD" == "1" ]]; then rmdir "\$MUTEX_DIR" 2>/dev/null || true; fi
}

if ! mkdir "\$LOCK_DIR" 2>/dev/null; then
  log "已有实例在跑，跳过"
  exit 0
fi
trap cleanup EXIT

if [[ -n "\$MUTEX_GROUP" ]]; then
  WAITED=0
  until mkdir "\$MUTEX_DIR" 2>/dev/null; do
    if (( WAITED >= 1800 )); then notify "等待同类报告写入超过 30 分钟"; exit 75; fi
    sleep 5
    WAITED=\$((WAITED + 5))
  done
  MUTEX_HELD=1
  if (( WAITED > 0 )); then log "等待同类报告 \${WAITED} 秒后继续"; fi
fi

if [[ ! -d "\$VAULT" ]]; then notify "Vault 目录不存在"; exit 1; fi
if [[ ! -f "\$AGENT_RUNNER" ]]; then notify "缺少本地 Agent 岗位入口"; exit 1; fi
NODE_BIN="\$(command -v node || true)"
if [[ -z "\$NODE_BIN" ]]; then notify "找不到 Node.js"; exit 1; fi
if [[ "\$HEALTH_GATE_ENABLED" == "1" ]]; then
  if [[ ! -f "\$HEALTH_GATE" ]]; then notify "缺少 Apple Health 原料门"; exit 1; fi
  GATE_OUTPUT="\$("\$NODE_BIN" "\$HEALTH_GATE" --vault "\$VAULT" --today "\$TODAY" 2>&1)"
  GATE_RC=\$?
  if [[ "\$GATE_RC" -eq 20 ]]; then
    log "⏸ \$GATE_OUTPUT"
    osascript -e "display notification \"\$GATE_OUTPUT\" with title \"Infans ${title}\"" 2>/dev/null || true
    exit 0
  fi
  if [[ "\$GATE_RC" -ne 0 ]]; then notify "\$GATE_OUTPUT"; exit "\$GATE_RC"; fi
  log "原料门通过：\$GATE_OUTPUT"
fi

log "开始 role=\${ROLE_ID}"
set +e
"\$NODE_BIN" "\$AGENT_RUNNER" \\
  --role "\$ROLE_ID" \\
  --workspace "\$VAULT" >> "\$LOG" 2>&1
AGENT_RC=\$?
set -e

if [[ "\$AGENT_RC" -ne 0 ]]; then
  notify "Agent 岗位退出码 \${AGENT_RC}"
  exit "\$AGENT_RC"
fi

if [[ -n "\$STAMP_FILE" && -f "\$STAMP_FILE" ]]; then
  AFTER_DATE=\$(awk '
    BEGIN { in_fm=0 }
    /^---[[:space:]]*\$/ { if (++in_fm==1) next; if (in_fm==2) exit }
    in_fm==1 && /^date:[[:space:]]*/ {
      sub(/^date:[[:space:]]*/, "")
      gsub(/[[:space:]]/, "")
      print
      exit
    }
  ' "\$STAMP_FILE")
  log "stamp_file date=\${AFTER_DATE:-空}"
fi

notify_ok "已跑完 \${TODAY}"
exit 0
EOF
  chmod +x "$out"
  echo "写入 $out"
}

write_health_runner() {
  local out="$BIN/infans_workbench_daily_health.sh"
  cat > "$out" <<EOF
#!/bin/bash
# Infans · 小秘书每日轻量检查（launchd → 不调用模型）
set -u
export PATH="${HOME}/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH"
export LANG="\${LANG:-en_US.UTF-8}"
export LC_ALL="\${LC_ALL:-en_US.UTF-8}"

VAULT="${VAULT}"
APP="\$VAULT/00_本地工作台/app"
HEALTH_SCRIPT="\$APP/scripts/workbench-daily-health.mjs"
LOG="\$HOME/.local/state/infans_workbench_daily_health.log"
LOCK_DIR="\$HOME/.local/state/infans_workbench_daily_health.lock"
STAMP="\$(TZ=Asia/Tokyo date '+%F %T %Z')"
UID_NUM="\$(id -u)"

mkdir -p "\$(dirname "\$LOG")"
log() { echo "\$STAMP \$*" >> "\$LOG"; }
notify_fail() {
  log "❌ \$1"
  osascript -e "display notification \"\$1\" with title \"Infans 小秘书每日检查\" sound name \"Basso\"" 2>/dev/null || true
}
notify_ok() {
  log "✅ \$1"
}

if ! mkdir "\$LOCK_DIR" 2>/dev/null; then log "已有实例在跑，跳过"; exit 0; fi
trap 'rmdir "\$LOCK_DIR" 2>/dev/null || true' EXIT

NODE_BIN="\$(command -v node || true)"
if [[ -z "\$NODE_BIN" ]]; then notify_fail "找不到 Node.js"; exit 1; fi
if [[ ! -f "\$HEALTH_SCRIPT" ]]; then notify_fail "缺少每日轻量检查脚本"; exit 1; fi

cd "\$APP" || exit 1
set +e
OUTPUT="\$("\$NODE_BIN" "\$HEALTH_SCRIPT" 2>&1)"
RC=\$?
set -e
if [[ -n "\$OUTPUT" ]]; then echo "\$OUTPUT" >> "\$LOG"; fi
if [[ "\$RC" -ne 0 ]]; then
  notify_fail "每日轻量检查失败"
  exit "\$RC"
fi

for label in com.capoo.infans-workbench-daily-health com.capoo.infans-workbench-daily-release com.capoo.infans-vault-backup; do
  if ! launchctl print "gui/\$UID_NUM/\$label" >/dev/null 2>&1; then
    notify_fail "LaunchAgent 未加载：\$label"
    exit 1
  fi
done

notify_ok "轻量检查通过"
exit 0
EOF
  chmod +x "$out"
  echo "写入 $out"
}

write_release_runner() {
  local out="$BIN/infans_workbench_daily_release.sh"
  cat > "$out" <<EOF
#!/bin/bash
# Infans · 小秘书每周完整版本收口（launchd → Cursor 主 Agent 岗位）
set -u
export PATH="${HOME}/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH"
export LANG="\${LANG:-en_US.UTF-8}"
export LC_ALL="\${LC_ALL:-en_US.UTF-8}"

VAULT="${VAULT}"
APP="\$VAULT/00_本地工作台/app"
AGENT_RUNNER="${AGENT_RUNNER}"
ROLE_ID="workbench-daily-release"
LOG="\$HOME/.local/state/infans_workbench_daily_release.log"
LOCK_DIR="\$HOME/.local/state/infans_workbench_daily_release.lock"
STAMP="\$(TZ=Asia/Tokyo date '+%F %T %Z')"

mkdir -p "\$(dirname "\$LOG")"
log() { echo "\$STAMP \$*" >> "\$LOG"; }
notify_fail() {
  log "❌ \$1"
  osascript -e "display notification \"\$1\" with title \"Infans 小秘书版本收口\" sound name \"Basso\"" 2>/dev/null || true
}

notify_ok() {
  log "✅ \$1"
  osascript -e "display notification \"\$1\" with title \"Infans 小秘书版本收口\" sound name \"Glass\"" 2>/dev/null || true
}

if ! mkdir "\$LOCK_DIR" 2>/dev/null; then log "已有实例在跑，跳过"; exit 0; fi
trap 'rmdir "\$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ ! -d "\$APP" ]]; then notify_fail "小秘书工程目录不存在"; exit 1; fi
if [[ ! -f "\$AGENT_RUNNER" ]]; then notify_fail "缺少本地 Agent 岗位入口"; exit 1; fi
NODE_BIN="\$(command -v node || true)"
if [[ -z "\$NODE_BIN" ]]; then notify_fail "找不到 Node.js"; exit 1; fi

cd "\$APP" || exit 1
BEFORE_VERSION="\$("\$NODE_BIN" -p 'require("./package.json").version' 2>/dev/null || true)"
INSPECTION="\$("\$NODE_BIN" scripts/workbench-version.mjs inspect --json 2>&1)"
INSPECT_RC=\$?
if [[ "\$INSPECT_RC" -ne 0 ]]; then notify_fail "版本队列检查失败"; log "\$INSPECTION"; exit "\$INSPECT_RC"; fi
if grep -q '"state": "none"' <<< "\$INSPECTION"; then
  log "✅ 当前版本号：V\${BEFORE_VERSION:-未知}（无需升级）"
  exit 0
fi

export INFANS_RELEASE_GATE_RECEIPT="\$VAULT/00_本地工作台/30_证据/AI定时任务运行包/workbench-daily-release/workbench-release-\$(date +%Y%m%dT%H%M%S)-\$\$.gates.json"
log "开始 role=\${ROLE_ID}"
set +e
"\$NODE_BIN" "\$AGENT_RUNNER" --role "\$ROLE_ID" --workspace "\$VAULT" >> "\$LOG" 2>&1
AGENT_RC=\$?
set -e
if [[ "\$AGENT_RC" -ne 0 ]]; then notify_fail "Cursor 主 Agent 退出码 \${AGENT_RC}"; exit "\$AGENT_RC"; fi

AFTER_RC=0
AFTER="\$("\$NODE_BIN" scripts/workbench-version.mjs inspect --json 2>&1)" || AFTER_RC=\$?
if [[ "\$AFTER_RC" -ne 0 ]]; then notify_fail "收口后队列复查失败"; log "\$AFTER"; exit "\$AFTER_RC"; fi
VERSION="\$("\$NODE_BIN" -p 'require("./package.json").version' 2>/dev/null || true)"
if [[ "\$VERSION" != "\$BEFORE_VERSION" ]]; then
  VERIFY_RC=0
  VERIFY_OUTPUT="\$("\$NODE_BIN" scripts/workbench-version.mjs verify 2>&1)" || VERIFY_RC=\$?
  log "\$VERIFY_OUTPUT"
  if [[ "\$VERIFY_RC" -ne 0 ]]; then notify_fail "版本文件已变化但升版复核失败；不能报告升级成功"; exit "\$VERIFY_RC"; fi
  notify_ok "已升级版本号：V\${VERSION:-未知}"
  exit 0
fi

if ! grep -q '"state": "none"' <<< "\$AFTER"; then
  log "\$AFTER"
  notify_fail "已执行未升版：队列仍有未收口事项，具体原因见本轮运行包与上方队列"
  exit 23
fi
log "✅ 当前版本号：V\${VERSION:-未知}（本次结论：不升级）"
exit 0
EOF
  chmod +x "$out"
  echo "写入 $out"
}

write_ai_tools_quarterly_runner() {
  local out="$BIN/infans_ai_tools_quarterly.sh"
  cat > "$out" <<EOF
#!/bin/bash
# Infans · AI 工具季度迭代报告（launchd → 本地岗位入口）
set -u
export PATH="${HOME}/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH"
export LANG="\${LANG:-en_US.UTF-8}"
export LC_ALL="\${LC_ALL:-en_US.UTF-8}"

VAULT="${VAULT}"
AGENT_RUNNER="${AGENT_RUNNER}"
ROLE_ID="ai-tools-quarterly"
GATE="\$VAULT/00_本地工作台/app/scripts/check-ai-tools-quarterly.mjs"
LOG="\$HOME/.local/state/infans_ai_tools_quarterly.log"
LOCK_DIR="\$HOME/.local/state/infans_ai_tools_quarterly.lock"
STAMP="\$(TZ=Asia/Tokyo date '+%F %T %Z')"

mkdir -p "\$(dirname "\$LOG")"
log() { echo "\$STAMP \$*" >> "\$LOG"; }
notify_fail() {
  log "❌ \$1"
  osascript -e "display notification \"\$1\" with title \"Infans AI 工具季报\" sound name \"Basso\"" 2>/dev/null || true
}
notify_ok() {
  log "✅ \$1"
  osascript -e "display notification \"\$1\" with title \"Infans AI 工具季报\" sound name \"Glass\"" 2>/dev/null || true
}

if ! mkdir "\$LOCK_DIR" 2>/dev/null; then log "已有实例在跑，跳过"; exit 0; fi
trap 'rmdir "\$LOCK_DIR" 2>/dev/null || true' EXIT

NODE_BIN="\$(command -v node || true)"
if [[ -z "\$NODE_BIN" ]]; then notify_fail "找不到 Node.js"; exit 1; fi
if [[ ! -f "\$AGENT_RUNNER" || ! -f "\$GATE" ]]; then notify_fail "缺少季报运行器或检查器"; exit 1; fi

GATE_OUTPUT="\$("\$NODE_BIN" "\$GATE" gate --vault "\$VAULT" 2>&1)"
GATE_RC=\$?
if [[ "\$GATE_RC" -eq 20 ]]; then log "⏸ \$GATE_OUTPUT"; exit 0; fi
if [[ "\$GATE_RC" -ne 0 ]]; then notify_fail "\$GATE_OUTPUT"; exit "\$GATE_RC"; fi
PERIOD="\$("\$NODE_BIN" "\$GATE" target --vault "\$VAULT")"
USER_PROMPT="目标报告周期是 \${PERIOD}。请严格执行岗位 prompt，只核对已用过的工具，完成后写入 \$VAULT/85_收藏夹/AI工具库/季度报告/\${PERIOD}.md 和本轮运行包。"

log "开始 role=\${ROLE_ID} period=\${PERIOD}"
set +e
"\$NODE_BIN" "\$AGENT_RUNNER" --role "\$ROLE_ID" --workspace "\$VAULT" --prompt "\$USER_PROMPT" >> "\$LOG" 2>&1
AGENT_RC=\$?
set -e
if [[ "\$AGENT_RC" -ne 0 ]]; then notify_fail "Cursor 岗位退出码 \${AGENT_RC}"; exit "\$AGENT_RC"; fi
VERIFY_OUTPUT="\$("\$NODE_BIN" "\$GATE" verify --vault "\$VAULT" 2>&1)"
VERIFY_RC=\$?
if [[ "\$VERIFY_RC" -ne 0 ]]; then notify_fail "\$VERIFY_OUTPUT"; exit "\$VERIFY_RC"; fi
notify_ok "\${PERIOD} 报告已写入小秘书横幅"
exit 0
EOF
  chmod +x "$out"
  echo "写入 $out"
}

write_activity_runner() {
  local out="$BIN/infans_japan_activities.sh"
  cat > "$out" <<EOF
#!/bin/bash
# Infans · 日本活动隔周一更新（launchd → 本地岗位入口）
set -u
export PATH="${HOME}/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH"
export LANG="\${LANG:-en_US.UTF-8}"
export LC_ALL="\${LC_ALL:-en_US.UTF-8}"
export INFANS_VAULT_ROOT="${VAULT}"

VAULT="${VAULT}"
SOURCE="\$VAULT/80_生活事务/日本游玩攻略/日本活动.md"
PROMPT_FILE="\$VAULT/80_生活事务/日本游玩攻略/日本活动_本机定时prompt.md"
CHECKER="\$VAULT/00_本地工作台/app/scripts/check-japan-activities.mjs"
AGENT_RUNNER="${AGENT_RUNNER}"
ROLE_ID="japan-activities"
MODEL="${ACTIVITY_MODEL}"
LOG="\$HOME/.local/state/infans_japan_activities.log"
LOCK_DIR="\$HOME/.local/state/infans_japan_activities.lock"
TODAY="\$(TZ=Asia/Tokyo date '+%Y-%m-%d')"
STAMP="\$(TZ=Asia/Tokyo date '+%F %T %Z')"
ANCHOR_DAY="2026-09-07"
BACKUP=""

mkdir -p "\$(dirname "\$LOG")"
log() { echo "\$STAMP \$*" >> "\$LOG"; }
restore_old() {
  if [[ -n "\$BACKUP" && -f "\$BACKUP" ]]; then
    cp "\$BACKUP" "\$SOURCE"
    log "已恢复旧活动卡"
  fi
}
cleanup() {
  rmdir "\$LOCK_DIR" 2>/dev/null || true
  if [[ -n "\$BACKUP" ]]; then rm -f "\$BACKUP"; fi
}

if ! mkdir "\$LOCK_DIR" 2>/dev/null; then log "已有实例在跑，跳过"; exit 0; fi
trap cleanup EXIT

if [[ -z "\$MODEL" ]]; then log "❌ 尚未确认定时模型"; exit 1; fi
if [[ ! -f "\$AGENT_RUNNER" ]]; then log "❌ 缺少本地 Agent 岗位入口"; exit 1; fi
if [[ ! -f "\$SOURCE" || ! -f "\$PROMPT_FILE" || ! -f "\$CHECKER" ]]; then log "❌ 缺少原件、prompt 或校验器"; exit 1; fi
NODE_BIN="\$(command -v node || true)"
if [[ -z "\$NODE_BIN" ]]; then log "❌ 找不到 Node.js"; exit 1; fi
if [[ "\${INFANS_JAPAN_ACTIVITIES_FORCE:-0}" != "1" ]]; then
  TODAY_EPOCH="\$(TZ=Asia/Tokyo date -j -f '%Y-%m-%d' "\$TODAY" '+%s' 2>/dev/null || true)"
  ANCHOR_EPOCH="\$(TZ=Asia/Tokyo date -j -f '%Y-%m-%d' "\$ANCHOR_DAY" '+%s' 2>/dev/null || true)"
  if [[ -z "\$TODAY_EPOCH" || -z "\$ANCHOR_EPOCH" ]]; then log "❌ 无法计算隔周日期"; exit 1; fi
  DAYS_SINCE=\$(( (TODAY_EPOCH - ANCHOR_EPOCH) / 86400 ))
  if (( DAYS_SINCE < 0 || DAYS_SINCE % 14 != 0 )); then log "隔周休息，跳过"; exit 0; fi
fi
BACKUP="\$(mktemp -t infans-japan-activities.XXXXXX)"
cp "\$SOURCE" "\$BACKUP"

USER_PROMPT="今天是日本时间 \${TODAY}。请严格执行 \${PROMPT_FILE} 的全部规则。只允许写入任务说明列出的白名单；失败则保留旧原件，用说人话的一句话汇报。"
log "开始 model=\${MODEL}"
set +e
"\$NODE_BIN" "\$AGENT_RUNNER" --role "\$ROLE_ID" --workspace "\$VAULT" --model "\$MODEL" --prompt "\$USER_PROMPT" >> "\$LOG" 2>&1
AGENT_RC=\$?
set -e
if [[ "\$AGENT_RC" -ne 0 ]]; then
  log "❌ Agent 岗位退出码 \${AGENT_RC}"
  restore_old
  exit "\$AGENT_RC"
fi

if ! node "\$CHECKER" "\$TODAY" >> "\$LOG" 2>&1; then
  log "❌ 新活动卡校验失败"
  restore_old
  exit 1
fi
log "✅ 已更新 \${TODAY}"
exit 0
EOF
  chmod +x "$out"
  echo "写入 $out"
}

write_market_brief_runner() {
  local out="$BIN/infans_market_brief.sh"
  cat > "$out" <<EOF
#!/bin/bash
# Infans · 金融市场简报（launchd → 本地岗位入口）
set -u
export PATH="${HOME}/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH"
export LANG="\${LANG:-en_US.UTF-8}"
export LC_ALL="\${LC_ALL:-en_US.UTF-8}"

VAULT="${VAULT}"
BRIEF="\$VAULT/50_世界资讯/金融/当前简报.md"
AGENT_RUNNER="${AGENT_RUNNER}"
ROLE_ID="market-brief"
LOG="\$HOME/.local/state/infans_market_brief.log"
LOCK_DIR="\$HOME/.local/state/infans_market_brief.lock"
TODAY="\$(TZ=Asia/Tokyo date '+%Y-%m-%d')"
STAMP="\$(TZ=Asia/Tokyo date '+%F %T %Z')"

mkdir -p "\$(dirname "\$LOG")"
log() { echo "\$STAMP \$*" >> "\$LOG"; }
notify() {
  log "❌ \$1"
  osascript -e "display notification \"\$1\" with title \"Infans 金融简报\" sound name \"Basso\"" 2>/dev/null || true
}
notify_ok() {
  log "✅ \$1"
  osascript -e "display notification \"\$1\" with title \"Infans 金融简报\" sound name \"Glass\"" 2>/dev/null || true
}

if ! mkdir "\$LOCK_DIR" 2>/dev/null; then log "已有实例在跑，跳过"; exit 0; fi
trap 'rmdir "\$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ ! -d "\$VAULT" ]]; then notify "Vault 目录不存在"; exit 1; fi
if [[ ! -f "\$AGENT_RUNNER" ]]; then notify "缺少本地 Agent 岗位入口"; exit 1; fi
if [[ ! -f "\$BRIEF" ]]; then notify "缺少当前简报文件"; exit 1; fi
NODE_BIN="\$(command -v node || true)"
if [[ -z "\$NODE_BIN" ]]; then notify "找不到 Node.js"; exit 1; fi

BEFORE_MTIME="\$(stat -f '%m' "\$BRIEF" 2>/dev/null || echo 0)"
BEFORE_DATE="\$(awk '
  BEGIN { in_fm=0 }
  /^---[[:space:]]*\$/ { if (++in_fm==1) next; if (in_fm==2) exit }
  in_fm==1 && /^date:[[:space:]]*/ {
    sub(/^date:[[:space:]]*/, "")
    gsub(/[[:space:]]/, "")
    print
    exit
  }
' "\$BRIEF")"

log "开始 role=\${ROLE_ID} before_date=\${BEFORE_DATE:-?} before_mtime=\${BEFORE_MTIME}"
set +e
"\$NODE_BIN" "\$AGENT_RUNNER" --role "\$ROLE_ID" --workspace "\$VAULT" >> "\$LOG" 2>&1
AGENT_RC=\$?
set -e

AFTER_MTIME="\$(stat -f '%m' "\$BRIEF" 2>/dev/null || echo 0)"
AFTER_DATE="\$(awk '
  BEGIN { in_fm=0 }
  /^---[[:space:]]*\$/ { if (++in_fm==1) next; if (in_fm==2) exit }
  in_fm==1 && /^date:[[:space:]]*/ {
    sub(/^date:[[:space:]]*/, "")
    gsub(/[[:space:]]/, "")
    print
    exit
  }
' "\$BRIEF")"

if [[ "\$AGENT_RC" -ne 0 ]]; then notify "Agent 岗位退出码 \${AGENT_RC}（详见日志）"; exit "\$AGENT_RC"; fi
if [[ "\$AFTER_DATE" != "\$TODAY" ]]; then
  notify "简报 date=\${AFTER_DATE:-空}，期望 \${TODAY}；可能未写入成功"
  exit 2
fi
if [[ "\$AFTER_MTIME" -le "\$BEFORE_MTIME" && "\$BEFORE_DATE" == "\$TODAY" ]]; then
  log "date 已是今日且 mtime 未变（可能 quiet 无改写）"
fi
if ! grep -q 'INFANS_MARKET_BRIEF_JSON_START' "\$BRIEF"; then
  notify "当前简报缺少嵌入 JSON 标记，请人工检查"
  exit 3
fi

notify_ok "已更新至 \${TODAY}（\${AFTER_DATE}）"
exit 0
EOF
  chmod +x "$out"
  echo "写入 $out"
}

write_world_brief_runner() {
  local out="$BIN/infans_world_brief.sh"
  cat > "$out" <<EOF
#!/bin/bash
# Infans · 世界资讯（launchd → 本地岗位入口）
set -u
export PATH="${HOME}/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH"
export LANG="\${LANG:-en_US.UTF-8}"
export LC_ALL="\${LC_ALL:-en_US.UTF-8}"

VAULT="${VAULT}"
AI_BRIEF="\$VAULT/50_世界资讯/AI/当前.md"
GAMES_BRIEF="\$VAULT/50_世界资讯/游戏/当前.md"
JAPAN_BRIEF="\$VAULT/50_世界资讯/日本/当前.md"
BRIEF="\$VAULT/50_世界资讯/金融/当前简报.md"
AGENT_RUNNER="${AGENT_RUNNER}"
ROLE_ID="world-brief"
LOG="\$HOME/.local/state/infans_world_brief.log"
LOCK_DIR="\$HOME/.local/state/infans_world_brief.lock"
TODAY="\$(TZ=Asia/Tokyo date '+%Y-%m-%d')"
STAMP="\$(TZ=Asia/Tokyo date '+%F %T %Z')"

mkdir -p "\$(dirname "\$LOG")" \\
  "\$VAULT/50_世界资讯/AI/历史" \\
  "\$VAULT/50_世界资讯/游戏/历史" \\
  "\$VAULT/50_世界资讯/日本/历史"
log() { echo "\$STAMP \$*" >> "\$LOG"; }
notify() {
  log "❌ \$1"
  osascript -e "display notification \"\$1\" with title \"Infans 世界资讯\" sound name \"Basso\"" 2>/dev/null || true
}
notify_ok() {
  log "✅ \$1"
  osascript -e "display notification \"\$1\" with title \"Infans 世界资讯\" sound name \"Glass\"" 2>/dev/null || true
}

read_date() {
  awk '
    BEGIN { in_fm=0 }
    /^---[[:space:]]*\$/ { if (++in_fm==1) next; if (in_fm==2) exit }
    in_fm==1 && /^date:[[:space:]]*/ {
      sub(/^date:[[:space:]]*/, "")
      gsub(/[[:space:]]/, "")
      print
      exit
    }
  ' "\$1"
}

if ! mkdir "\$LOCK_DIR" 2>/dev/null; then log "已有实例在跑，跳过"; exit 0; fi
trap 'rmdir "\$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ ! -d "\$VAULT" ]]; then notify "Vault 目录不存在"; exit 1; fi
if [[ ! -f "\$AGENT_RUNNER" ]]; then notify "缺少本地 Agent 岗位入口"; exit 1; fi
if [[ ! -f "\$AI_BRIEF" || ! -f "\$GAMES_BRIEF" || ! -f "\$JAPAN_BRIEF" ]]; then notify "缺少世界资讯当前稿"; exit 1; fi
if [[ ! -f "\$BRIEF" ]]; then notify "缺少当前简报文件"; exit 1; fi
NODE_BIN="\$(command -v node || true)"
if [[ -z "\$NODE_BIN" ]]; then notify "找不到 Node.js"; exit 1; fi

BEFORE_MTIME="\$(stat -f '%m' "\$JAPAN_BRIEF" 2>/dev/null || echo 0)"
BEFORE_DATE="\$(read_date "\$JAPAN_BRIEF")"
FINANCE_BEFORE_DATE="\$(read_date "\$BRIEF")"

log "开始四栏更新 before_japan=\${BEFORE_DATE:-?} before_finance=\${FINANCE_BEFORE_DATE:-?}"
FINANCE_RC=0
WORLD_RC=0

log "第一段 role=market-brief"
set +e
"\$NODE_BIN" "\$AGENT_RUNNER" --role "market-brief" --workspace "\$VAULT" >> "\$LOG" 2>&1
FINANCE_RC=\$?
set -e
FINANCE_DATE="\$(read_date "\$BRIEF")"
if [[ "\$FINANCE_RC" -ne 0 ]]; then
  log "金融栏岗位退出码 \${FINANCE_RC}，继续写另外三栏"
elif [[ "\$FINANCE_DATE" != "\$TODAY" ]]; then
  log "金融栏 date=\${FINANCE_DATE:-空}，期望 \${TODAY}"
  FINANCE_RC=2
elif ! grep -q 'INFANS_MARKET_BRIEF_JSON_START' "\$BRIEF"; then
  log "金融栏缺少嵌入 JSON 标记"
  FINANCE_RC=3
else
  log "金融栏已写到 \${TODAY}"
fi

log "第二段 role=\${ROLE_ID} before_date=\${BEFORE_DATE:-?} before_mtime=\${BEFORE_MTIME}"
set +e
"\$NODE_BIN" "\$AGENT_RUNNER" --role "\$ROLE_ID" --workspace "\$VAULT" >> "\$LOG" 2>&1
WORLD_RC=\$?
set -e

AFTER_MTIME="\$(stat -f '%m' "\$JAPAN_BRIEF" 2>/dev/null || echo 0)"
AFTER_DATE="\$(read_date "\$JAPAN_BRIEF")"
AI_DATE="\$(read_date "\$AI_BRIEF")"
GAMES_DATE="\$(read_date "\$GAMES_BRIEF")"

if [[ "\$WORLD_RC" -ne 0 ]]; then
  log "另外三栏岗位退出码 \${WORLD_RC}"
elif [[ "\$AFTER_DATE" != "\$TODAY" || "\$AI_DATE" != "\$TODAY" || "\$GAMES_DATE" != "\$TODAY" ]]; then
  log "另外三栏 date 不是今天（AI=\${AI_DATE:-空} 游戏=\${GAMES_DATE:-空} 日本=\${AFTER_DATE:-空}），期望 \${TODAY}"
  WORLD_RC=2
fi
if [[ "\$AFTER_MTIME" -le "\$BEFORE_MTIME" && "\$BEFORE_DATE" == "\$TODAY" ]]; then
  log "日本栏 date 已是今日且 mtime 未变（可能 quiet 无改写）"
fi
if [[ "\$WORLD_RC" -eq 0 ]]; then
  for LANE_BRIEF in "\$AI_BRIEF" "\$GAMES_BRIEF" "\$JAPAN_BRIEF"; do
    if ! grep -q 'INFANS_WORLD_BRIEF_JSON_START' "\$LANE_BRIEF"; then
      log "\$LANE_BRIEF 缺少嵌入 JSON 标记"
      WORLD_RC=3
    fi
  done
fi

CHECK="\$VAULT/00_本地工作台/app/scripts/check-world-brief.mjs"
if [[ "\$WORLD_RC" -eq 0 && -f "\$CHECK" ]]; then
  set +e
  "\$NODE_BIN" "\$CHECK" "\$AI_BRIEF" "\$GAMES_BRIEF" "\$JAPAN_BRIEF" >> "\$LOG" 2>&1
  CHECK_RC=\$?
  set -e
  if [[ "\$CHECK_RC" -ne 0 ]]; then
    log "世界资讯条数不够（AI/游戏至少 4 条，日本至少 5 条）"
    WORLD_RC=\$CHECK_RC
  fi
fi

SPEAK="\$VAULT/00_本地工作台/app/scripts/speak-world-readings.mjs"
if [[ "\$WORLD_RC" -eq 0 && -f "\$SPEAK" ]]; then
  set +e
  "\$NODE_BIN" "\$SPEAK" >> "\$LOG" 2>&1
  SPEAK_RC=\$?
  set -e
  if [[ "\$SPEAK_RC" -ne 0 ]]; then
    log "课文已写入，真人配音未取到（退出码 \${SPEAK_RC}）"
  fi
fi

if [[ "\$FINANCE_RC" -eq 0 && "\$WORLD_RC" -eq 0 ]]; then
  notify_ok "四栏已更新至 \${TODAY}"
  exit 0
fi
if [[ "\$FINANCE_RC" -ne 0 && "\$WORLD_RC" -eq 0 ]]; then
  notify "金融栏失败（\${FINANCE_RC}），另外三栏已更新"
  exit "\$FINANCE_RC"
fi
if [[ "\$FINANCE_RC" -eq 0 && "\$WORLD_RC" -ne 0 ]]; then
  notify "金融栏已更新，另外三栏失败（\${WORLD_RC}）"
  exit "\$WORLD_RC"
fi
notify "四栏都失败（金融 \${FINANCE_RC} / 另外三栏 \${WORLD_RC}）"
exit "\$WORLD_RC"
EOF
  chmod +x "$out"
  echo "写入 $out"
}

write_plist_daily() {
  local label="$1"
  local script="$2"
  local hour="$3"
  local minute="$4"
  local plist="$AGENTS/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${script}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${STATE}/${label##*.}_launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${STATE}/${label##*.}_launchd.log</string>
</dict>
</plist>
EOF
  echo "写入 $plist"
}

write_plist_monthly() {
  local label="$1"
  local script="$2"
  local hour="$3"
  local minute="$4"
  local plist="$AGENTS/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${script}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Day</key>
        <integer>1</integer>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${STATE}/monthly-review_launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${STATE}/monthly-review_launchd.log</string>
</dict>
</plist>
EOF
  echo "写入 $plist"
}

write_plist_weekly_monday() {
  local label="$1"
  local script="$2"
  local hour="$3"
  local minute="$4"
  local plist="$AGENTS/$label.plist"
  local launchd_log="${STATE}/${label#com.capoo.infans-}_launchd.log"
  # Weekday: 1 = Monday on macOS StartCalendarInterval
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${script}</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>1</integer>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${launchd_log}</string>
    <key>StandardErrorPath</key>
    <string>${launchd_log}</string>
</dict>
</plist>
EOF
  echo "写入 ${plist}（每周一 ${hour}:$(printf '%02d' "$minute")）"
}

write_plist_weekly() {
  local label="$1"
  local script="$2"
  local weekday="$3"
  local hour="$4"
  local minute="$5"
  local plist="$AGENTS/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array><string>${script}</string></array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key><integer>${weekday}</integer>
        <key>Hour</key><integer>${hour}</integer>
        <key>Minute</key><integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>${STATE}/${label##*.}_launchd.log</string>
    <key>StandardErrorPath</key><string>${STATE}/${label##*.}_launchd.log</string>
</dict>
</plist>
EOF
  echo "写入 $plist"
}

write_plist_quarterly() {
  local label="$1"
  local script="$2"
  local hour="$3"
  local minute="$4"
  local plist="$AGENTS/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key><array><string>${script}</string></array>
    <key>StartCalendarInterval</key>
    <array>
      <dict><key>Month</key><integer>1</integer><key>Day</key><integer>1</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
      <dict><key>Month</key><integer>4</integer><key>Day</key><integer>1</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
      <dict><key>Month</key><integer>7</integer><key>Day</key><integer>1</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
      <dict><key>Month</key><integer>10</integer><key>Day</key><integer>1</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
    </array>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>${STATE}/${label##*.}_launchd.log</string>
    <key>StandardErrorPath</key><string>${STATE}/${label##*.}_launchd.log</string>
</dict>
</plist>
EOF
  echo "写入 $plist"
}

if [[ "${INFANS_PERIODIC_AI_ONLY:-}" == "workbench-daily-health" ]]; then
  write_health_runner
  write_plist_daily "com.capoo.infans-workbench-daily-health" "$BIN/infans_workbench_daily_health.sh" 6 0
  launchctl bootout "gui/$uid/com.capoo.infans-workbench-daily-health" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$AGENTS/com.capoo.infans-workbench-daily-health.plist"
  echo "已单独安装并加载小秘书每日轻量检查：每天 06:00，不调用模型。"
  exit 0
fi

if [[ "${INFANS_PERIODIC_AI_ONLY:-}" == "workbench-daily-release" ]]; then
  write_release_runner
  write_plist_weekly_monday "com.capoo.infans-workbench-daily-release" "$BIN/infans_workbench_daily_release.sh" 6 0
  launchctl bootout "gui/$uid/com.capoo.infans-workbench-daily-release" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$AGENTS/com.capoo.infans-workbench-daily-release.plist"
  echo "已单独安装并加载小秘书版本收口：每周一 06:00，由 Cursor 主 Agent 执行。"
  exit 0
fi

if [[ "${INFANS_PERIODIC_AI_ONLY:-}" == "world-brief" ]]; then
  write_market_brief_runner
  write_world_brief_runner
  write_plist_daily "com.capoo.infans-world-brief" "$BIN/infans_world_brief.sh" 6 10
  launchctl bootout "gui/$uid/com.capoo.infans-market-brief" 2>/dev/null || true
  rm -f "$AGENTS/com.capoo.infans-market-brief.plist"
  launchctl bootout "gui/$uid/com.capoo.infans-world-brief" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$AGENTS/com.capoo.infans-world-brief.plist"
  echo "已单独安装并加载世界资讯：每天 06:10，先写金融再写另外三栏。"
  exit 0
fi

if [[ "${INFANS_PERIODIC_AI_ONLY:-}" == "ai-tools-quarterly" ]]; then
  write_ai_tools_quarterly_runner
  write_plist_quarterly "com.capoo.infans-ai-tools-quarterly" "$BIN/infans_ai_tools_quarterly.sh" 9 30
  launchctl bootout "gui/$uid/com.capoo.infans-ai-tools-quarterly" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$AGENTS/com.capoo.infans-ai-tools-quarterly.plist"
  echo "已单独安装并加载 AI 工具季报：每季度第一天 09:30。"
  exit 0
fi

write_runner "infans_health_daily.sh" "身心日评" \
  "health-daily" \
  "$VAULT/40_身心健康/状态报告/当前身心日评.md" \
  "0" \
  "health-report-writing"

write_runner "infans_monthly_review.sh" "月度总结" \
  "monthly-review" \
  "" \
  "0" \
  "health-report-writing"

write_runner "infans_training_review.sh" "训练复盘" \
  "training-review" \
  "" \
  "1"

write_market_brief_runner
write_world_brief_runner
write_health_runner
write_release_runner
write_ai_tools_quarterly_runner

if [[ -n "$ACTIVITY_MODEL" ]]; then
  write_activity_runner
fi

write_plist_daily "com.capoo.infans-workbench-daily-health" "$BIN/infans_workbench_daily_health.sh" 6 0
write_plist_weekly_monday "com.capoo.infans-workbench-daily-release" "$BIN/infans_workbench_daily_release.sh" 6 0
write_plist_daily "com.capoo.infans-health-daily" "$BIN/infans_health_daily.sh" 6 30
write_plist_daily "com.capoo.infans-world-brief" "$BIN/infans_world_brief.sh" 6 10
write_plist_monthly "com.capoo.infans-monthly-review" "$BIN/infans_monthly_review.sh" 6 5
write_plist_weekly_monday "com.capoo.infans-training-review" "$BIN/infans_training_review.sh" 6 35
write_plist_quarterly "com.capoo.infans-ai-tools-quarterly" "$BIN/infans_ai_tools_quarterly.sh" 9 30
if [[ -n "$ACTIVITY_MODEL" ]]; then
  write_plist_weekly "com.capoo.infans-japan-activities" "$BIN/infans_japan_activities.sh" 1 9 0
else
  echo "日本活动：未设置 INFANS_JAPAN_ACTIVITIES_MODEL，已跳过"
fi

# —— Anki 快照（非 AI：node 脚本）——
ANKI_SCRIPT="$BIN/infans_anki_snapshot.sh"
cat > "$ANKI_SCRIPT" <<EOF
#!/bin/bash
# Infans · Anki 每日快照（launchd → node）
set -u
export PATH="${HOME}/.local/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:\$PATH"
export LANG="\${LANG:-en_US.UTF-8}"
export LC_ALL="\${LC_ALL:-en_US.UTF-8}"
export INFANS_VAULT_ROOT="${VAULT}"

LOG="\$HOME/.local/state/infans_anki_snapshot.log"
LOCK_DIR="\$HOME/.local/state/infans_anki_snapshot.lock"
NODE_BIN="\$(command -v node || true)"
APP_SCRIPT="${VAULT}/00_本地工作台/app/scripts/sync-anki-snapshot.mjs"
STAMP="\$(TZ=Asia/Tokyo date '+%F %T %Z')"

mkdir -p "\$(dirname "\$LOG")"
log() { echo "\$STAMP \$*" >> "\$LOG"; }

if ! mkdir "\$LOCK_DIR" 2>/dev/null; then
  log "已有实例在跑，跳过"
  exit 0
fi
trap 'rmdir "\$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ -z "\$NODE_BIN" ]]; then
  log "❌ 找不到 node"
  exit 1
fi
if [[ ! -f "\$APP_SCRIPT" ]]; then
  log "❌ 缺少 \$APP_SCRIPT"
  exit 1
fi

log "开始 Anki 快照（脚本会先打开 Anki 再拉数据）"
set +e
"\$NODE_BIN" "\$APP_SCRIPT" >> "\$LOG" 2>&1
RC=\$?
set -e
if [[ "\$RC" -ne 0 ]]; then
  log "❌ sync-anki-snapshot 退出码 \$RC"
  exit "\$RC"
fi
log "结束"
exit 0
EOF
chmod +x "$ANKI_SCRIPT"
echo "写入 $ANKI_SCRIPT"

write_plist_daily "com.capoo.infans-anki-snapshot" "$ANKI_SCRIPT" 7 15

reload() {
  local label="$1"
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$AGENTS/$label.plist"
  echo "已加载 $label"
}

reload "com.capoo.infans-workbench-daily-health"
reload "com.capoo.infans-workbench-daily-release"
reload "com.capoo.infans-health-daily"
launchctl bootout "gui/$uid/com.capoo.infans-market-brief" 2>/dev/null || true
rm -f "$AGENTS/com.capoo.infans-market-brief.plist"
reload "com.capoo.infans-world-brief"
reload "com.capoo.infans-monthly-review"
reload "com.capoo.infans-training-review"
reload "com.capoo.infans-anki-snapshot"
reload "com.capoo.infans-ai-tools-quarterly"
if [[ -n "$ACTIVITY_MODEL" ]]; then
  reload "com.capoo.infans-japan-activities"
fi

reschedule_existing_daily_plist() {
  local label="$1"
  local hour="$2"
  local minute="$3"
  local plist="$AGENTS/$label.plist"
  local plist_buddy="/usr/libexec/PlistBuddy"
  if [[ ! -f "$plist" ]]; then
    echo "$label 未安装，未改动时间"
    return 0
  fi
  if [[ ! -x "$plist_buddy" ]]; then
    echo "缺少 PlistBuddy，未改动 $label" >&2
    return 1
  fi
  "$plist_buddy" -c "Set :StartCalendarInterval:Hour $hour" "$plist"
  "$plist_buddy" -c "Set :StartCalendarInterval:Minute $minute" "$plist"
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$plist"
  echo "已调整 ${label}：每天 $(printf '%02d:%02d' "$hour" "$minute")"
}

# 主库备份由独立安装器管理脚本正文；这里只把已安装的精确 LaunchAgent 调到晨间主要写入之后。
reschedule_existing_daily_plist "com.capoo.infans-vault-backup" 7 10

echo ""
echo "安装完成。节奏（日本时间）：每日轻量检查与 GPT 事实交班 06:00 · 每周一完整版本收口 06:00 · 月报每月 1 日 06:05 · 世界资讯 06:10（含金融） · 身心日评 06:30 · 训练复盘每周一 06:35 · 备份 07:10 · Anki 快照每天 07:15 · AI 工具季报每季度第一天 09:30。"
if [[ -n "$ACTIVITY_MODEL" ]]; then
  echo "日本活动已加载：隔周一 09:00（模型：${ACTIVITY_MODEL}）。"
else
  echo "日本活动未加载：请先设置 INFANS_JAPAN_ACTIVITIES_MODEL。"
fi
echo "手动试跑：~/.local/bin/infans_workbench_daily_health.sh（不调用模型）；完整收口：~/.local/bin/infans_workbench_daily_release.sh（无积压时不会调用 Cursor）"
echo "总览：00_本地工作台/10_设计/定时与自动化/周期性AI定时任务_总览.md"
