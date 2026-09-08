import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = readFileSync(new URL("../scripts/install-infans-periodic-ai.sh", import.meta.url), "utf8");
const japanActivitiesPromptPath = new URL("../../../80_生活事务/日本游玩攻略/日本活动_本机定时prompt.md", import.meta.url);
const japanActivitiesPrompt = existsSync(japanActivitiesPromptPath)
  ? readFileSync(japanActivitiesPromptPath, "utf8")
  : "";

test("Japan activities stays unloaded until a scheduled model is supplied", () => {
  assert.ok(installer.includes('ACTIVITY_MODEL="${INFANS_JAPAN_ACTIVITIES_MODEL:-}"'));
  assert.equal(installer.includes('INFANS_JAPAN_ACTIVITIES_MODEL:-cursor-grok-4.6-high'), false);
  assert.match(installer, /if \[\[ -n "\$ACTIVITY_MODEL" \]\]; then\n\s+write_activity_runner\nfi/);
  assert.match(installer, /if \[\[ -n "\$ACTIVITY_MODEL" \]\]; then\n\s+write_plist_weekly "com\.capoo\.infans-japan-activities"/);
  assert.match(installer, /if \[\[ -n "\$ACTIVITY_MODEL" \]\]; then\n\s+reload "com\.capoo\.infans-japan-activities"/);
  assert.ok(installer.includes('MODEL="${ACTIVITY_MODEL}"'));
  assert.ok(installer.includes('模型：${ACTIVITY_MODEL}'));
  assert.ok(installer.includes('未设置 INFANS_JAPAN_ACTIVITIES_MODEL，已跳过'));
  assert.ok(installer.includes('write_plist_weekly "com.capoo.infans-japan-activities" "$BIN/infans_japan_activities.sh" 1 9 0'));
  assert.ok(installer.includes('ANCHOR_DAY="2026-09-07"'));
  assert.ok(installer.includes('DAYS_SINCE % 14 != 0'));
  assert.ok(installer.includes('隔周休息，跳过'));
});

test("AI schedules call the platform-neutral local role runner instead of executing cursor-agent directly", () => {
  assert.ok(installer.includes('AGENT_RUNNER="$VAULT/00_本地工作台/app/scripts/infans-agent-runner.mjs"'));
  assert.ok(installer.includes('--role "\\$ROLE_ID"'));
  assert.ok(installer.includes('"health-daily"'));
  assert.ok(installer.includes('"monthly-review"'));
  assert.ok(installer.includes('"training-review"'));
  assert.ok(installer.includes('ROLE_ID="market-brief"'));
  assert.ok(installer.includes('ROLE_ID="world-brief"'));
  assert.ok(installer.includes('ROLE_ID="ai-tools-quarterly"'));
  assert.ok(installer.includes('write_market_brief_runner'));
  assert.ok(installer.includes('write_world_brief_runner'));
  assert.ok(installer.includes('speak-world-readings.mjs'));
  assert.ok(installer.includes('check-world-brief.mjs'));
  assert.ok(installer.includes('世界资讯条数不够'));
  assert.ok(installer.includes('--role "market-brief"'));
  assert.ok(installer.includes('write_plist_daily "com.capoo.infans-world-brief" "$BIN/infans_world_brief.sh" 6 10'));
  assert.equal(installer.includes('write_plist_daily "com.capoo.infans-market-brief"'), false);
  assert.equal(installer.includes('AGENT_BIN='), false);
  assert.doesNotMatch(installer, /"\\$AGENT"\s+-p/);
});

test("AI tools quarterly report uses Cursor 4.6 High role, quarter-only launch dates and a completed-report gate", () => {
  assert.ok(installer.includes('write_ai_tools_quarterly_runner'));
  assert.ok(installer.includes('check-ai-tools-quarterly.mjs'));
  assert.ok(installer.includes('write_plist_quarterly "com.capoo.infans-ai-tools-quarterly" "$BIN/infans_ai_tools_quarterly.sh" 9 30'));
  assert.ok(installer.includes('<key>Month</key><integer>1</integer>'));
  assert.ok(installer.includes('<key>Month</key><integer>10</integer>'));
  assert.ok(installer.includes('reload "com.capoo.infans-ai-tools-quarterly"'));
  assert.ok(installer.includes('VERIFY_OUTPUT='));
});

test("market brief keeps its post-write date and embedded JSON gates behind the shared role runner", () => {
  assert.ok(installer.includes('AFTER_DATE='));
  assert.ok(installer.includes('INFANS_MARKET_BRIEF_JSON_START'));
  assert.ok(installer.includes('INFANS_WORLD_BRIEF_JSON_START'));
  assert.ok(installer.includes('if [[ "\\$AFTER_DATE" != "\\$TODAY" ]]'));
  assert.ok(installer.includes('launchctl bootout "gui/$uid/com.capoo.infans-market-brief"'));
  assert.ok(installer.includes('reload "com.capoo.infans-world-brief"'));
  assert.equal(installer.includes('reload "com.capoo.infans-market-brief"'), false);
});

test("daily release treats a completed no-upgrade decision as a normal run", () => {
  assert.ok(installer.includes('BEFORE_VERSION="\\$("\\$NODE_BIN" -p \'require("./package.json").version\''));
  assert.ok(installer.includes('log "✅ 当前版本号：V\\${BEFORE_VERSION:-未知}（无需升级）"'));
  assert.ok(installer.includes('notify_ok "已升级版本号：V\\${VERSION:-未知}"'));
  assert.ok(installer.includes('log "✅ 当前版本号：V\\${VERSION:-未知}（本次结论：不升级）"'));
  assert.equal(installer.includes('notify_fail "版本队列仍有待处理事项；Cursor 已保留原因"'), false);
  assert.ok(installer.includes('export INFANS_RELEASE_GATE_RECEIPT='));
  assert.ok(installer.includes('scripts/workbench-version.mjs verify'));
  assert.ok(installer.includes('版本文件已变化但升版复核失败'));
  assert.ok(installer.includes('已执行未升版：队列仍有未收口事项'));
});

test("晨间批次从 06:00 开始错峰，身心写者互斥且备份放在主要写入之后", () => {
  assert.equal(installer.includes('write_plist_daily "com.capoo.infans-workbench-daily-release" "$BIN/infans_workbench_daily_release.sh" 6 0'), false);
  assert.ok(installer.includes('write_plist_weekly_monday "com.capoo.infans-workbench-daily-release" "$BIN/infans_workbench_daily_release.sh" 6 0'));
  assert.ok(installer.includes('write_plist_daily "com.capoo.infans-workbench-daily-health" "$BIN/infans_workbench_daily_health.sh" 6 0'));
  assert.ok(installer.includes('write_health_runner'));
  assert.ok(installer.includes('workbench-daily-health.mjs'));
  assert.ok(installer.includes('write_plist_monthly "com.capoo.infans-monthly-review" "$BIN/infans_monthly_review.sh" 6 5'));
  assert.match(installer, /write_runner "infans_monthly_review\.sh"[\s\S]*?"monthly-review"[\s\S]*?"0"[\s\S]*?"health-report-writing"/);
  assert.ok(installer.includes('write_plist_daily "com.capoo.infans-world-brief" "$BIN/infans_world_brief.sh" 6 10'));
  assert.equal(installer.includes('write_plist_daily "com.capoo.infans-market-brief"'), false);
  assert.ok(installer.includes('write_plist_daily "com.capoo.infans-health-daily" "$BIN/infans_health_daily.sh" 6 30'));
  assert.ok(installer.includes('write_plist_weekly_monday "com.capoo.infans-training-review" "$BIN/infans_training_review.sh" 6 35'));
  assert.ok(installer.includes('write_plist_daily "com.capoo.infans-anki-snapshot" "$ANKI_SCRIPT" 7 15'));
  assert.ok(installer.includes('reschedule_existing_daily_plist "com.capoo.infans-vault-backup" 7 10'));
  assert.ok(installer.includes('已调整 ${label}：每天'));

  assert.match(installer, /MUTEX_GROUP="\$\{mutex_group\}"/);
  assert.match(installer, /MUTEX_DIR="\\\$HOME\/\.local\/state\/infans_\\\$\{MUTEX_GROUP\}\.lock"/);
  assert.match(installer, /WAITED >= 1800/);
  assert.equal((installer.match(/"health-report-writing"/g) || []).length, 2);
  assert.match(installer, /if \[\[ ! -f "\$plist" \]\]; then[\s\S]*未安装，未改动时间/);
});

test("Japan activities keeps one formal card target, permits only its audit package, and restores the old card on failure", { skip: !japanActivitiesPrompt }, () => {
  assert.ok(installer.includes('SOURCE="\\$VAULT/80_生活事务/日本游玩攻略/日本活动.md"'));
  assert.ok(installer.includes("只允许写入任务说明列出的白名单"));
  assert.ok(japanActivitiesPrompt.includes("AI定时任务运行包/japan-activities"));
  assert.ok(installer.includes('restore_old'));
  assert.ok(installer.includes('cp "\\$BACKUP" "\\$SOURCE"'));
  assert.ok(installer.includes('check-japan-activities.mjs'));
});

test("Japan activities radar prioritizes sequels and theatrical releases from personal culture originals", { skip: !japanActivitiesPrompt }, () => {
  assert.ok(japanActivitiesPrompt.includes("60_艺术馆藏/动漫与影视/文化谱系/*.md"));
  assert.ok(japanActivitiesPrompt.includes("60_艺术馆藏/游戏/文化谱系/*.md"));
  assert.match(japanActivitiesPrompt, /正统续篇、新剧场版、日本上映档期/);
  assert.match(japanActivitiesPrompt, /高关联事件优先于普通热门 ACG 展会/);
  assert.match(japanActivitiesPrompt, /作品官方网站、发行方或影院官方页/);
});

function extractInstallerFunction(source, name, nextName) {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf(`\n${nextName}() {`, start);
  assert.ok(start >= 0 && end > start, `缺少 ${name}`);
  return source.slice(start, end);
}

test("每周一 LaunchAgent 按 label 写各自日志，版本收口不得落入训练复盘", () => {
  const helper = extractInstallerFunction(installer, "write_plist_weekly_monday", "write_plist_weekly");
  assert.ok(helper.includes('${STATE}/${label#com.capoo.infans-}_launchd.log'));
  assert.equal(helper.includes("training-review_launchd.log"), false);

  const root = mkdtempSync(join(tmpdir(), "infans-weekly-monday-plist-"));
  const agents = join(root, "LaunchAgents");
  const state = join(root, "state");
  mkdirSync(agents);
  mkdirSync(state);
  execFileSync("bash", ["-c", `
    set -euo pipefail
    AGENTS=${JSON.stringify(agents)}
    STATE=${JSON.stringify(state)}
    ${helper}
    write_plist_weekly_monday "com.capoo.infans-workbench-daily-release" "/tmp/infans_workbench_daily_release.sh" 6 0
    write_plist_weekly_monday "com.capoo.infans-training-review" "/tmp/infans_training_review.sh" 6 35
  `]);

  const releasePlist = readFileSync(join(agents, "com.capoo.infans-workbench-daily-release.plist"), "utf8");
  const trainingPlist = readFileSync(join(agents, "com.capoo.infans-training-review.plist"), "utf8");
  assert.ok(releasePlist.includes(`${state}/workbench-daily-release_launchd.log`));
  assert.equal(releasePlist.includes("training-review_launchd.log"), false);
  assert.ok(trainingPlist.includes(`${state}/training-review_launchd.log`));
  assert.equal(trainingPlist.includes("workbench-daily-release_launchd.log"), false);
});

test("真实外层脚本区分无任务、未升版、复核失败和确认成功，不调用模型", (t) => {
  const root = mkdtempSync(join(tmpdir(), "release-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "00_本地工作台/app");
  const bin = join(root, "bin");
  mkdirSync(join(app, "scripts"), { recursive: true });
  mkdirSync(bin);
  const fakeAgent = join(root, "fake-agent.mjs");
  writeFileSync(fakeAgent, `import fs from 'node:fs'; if (process.env.RELEASE_TEST_MODE !== 'blocked') fs.writeFileSync('package.json', '{"version":"1.17.0"}');`);
  writeFileSync(join(app, "scripts/workbench-version.mjs"), `
    if (process.argv[2] === 'verify') { process.exit(process.env.RELEASE_TEST_MODE === 'bad-health' ? 24 : 0); }
    console.log(JSON.stringify({state: ['none','good','bad-health'].includes(process.env.RELEASE_TEST_MODE) && (process.env.RELEASE_TEST_MODE === 'none' || JSON.parse((await import('node:fs')).readFileSync('package.json')).version === '1.17.0') ? 'none' : 'ready'}, null, 2));
  `);
  const helper = extractInstallerFunction(installer, "write_release_runner", "write_ai_tools_quarterly_runner");
  execFileSync("bash", ["-c", `VAULT="$1"; BIN="$2"; AGENT_RUNNER="$3"; ${helper}\nwrite_release_runner`, "fixture", root, bin, fakeAgent]);
  const scriptPath = join(bin, "infans_workbench_daily_release.sh");
  let script = readFileSync(scriptPath, "utf8");
  script = script.replace('LOG="$HOME/.local/state/infans_workbench_daily_release.log"', `LOG=${JSON.stringify(join(root, "run.log"))}`)
    .replace('LOCK_DIR="$HOME/.local/state/infans_workbench_daily_release.lock"', `LOCK_DIR=${JSON.stringify(join(root, "run.lock"))}`)
    .replace("set -u", "set -u\nosascript() { return 0; }");
  writeFileSync(scriptPath, script);
  for (const [mode, expected] of [["none", 0], ["blocked", 23], ["bad-health", 24], ["good", 0]]) {
    writeFileSync(join(app, "package.json"), '{"version":"1.16.0"}');
    writeFileSync(join(root, "run.log"), "");
    let status = 0;
    try { execFileSync("bash", [scriptPath], { env: { ...process.env, RELEASE_TEST_MODE: mode }, stdio: "pipe" }); }
    catch (error) { status = error.status; }
    assert.equal(status, expected, mode);
    const log = readFileSync(join(root, "run.log"), "utf8");
    assert.equal(log.includes("已升级版本号"), mode === "good", mode);
    if (mode === "blocked") assert.match(log, /已执行未升版/);
    if (mode === "bad-health") assert.match(log, /复核失败/);
  }
});
