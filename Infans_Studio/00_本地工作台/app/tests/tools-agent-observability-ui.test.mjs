import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("Token管理位于秘书系统的系统设置之后", async () => {
  const source = await fs.readFile(new URL("../src/pages/ToolsPage.tsx", import.meta.url), "utf8");
  const settings = source.indexOf('id: "settings"');
  const observability = source.indexOf('id: "agent-observability"');
  assert.ok(settings >= 0 && observability > settings);
  assert.equal(source.includes('id: "vpn"'), false);
  assert.match(source, /<AgentObservabilityView active=\{active\} \/>/u);
});

test("任务账册保留任务链、摘要归属、缓存，并与 Codex 共用战报表", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/AgentObservabilityView.tsx", import.meta.url), "utf8");
  assert.match(source, /task\.selfUsage/u);
  assert.match(source, /task\.childUsage/u);
  assert.match(source, /task\.totalUsage/u);
  assert.match(source, /task\.projectMatches\.map/u);
  assert.match(source, /每个任务窗口，连同它带出来的子任务/u);
  assert.match(source, /taskKindLabel\(task\)/u);
  assert.match(source, /task\.reference/u);
  assert.match(source, /目前只确认到项目/u);
  assert.match(source, /attributionBasisLabel/u);
  assert.match(source, /clientSnapshotCache/u);
  assert.match(source, /infans-agent-observability-period/u);
  assert.match(source, /readStoredPeriod/u);
  assert.match(source, /writeStoredPeriod\(period\.id\)/u);
  assert.match(source, /useState<PeriodOption>\(readStoredPeriod\)/u);
  assert.doesNotMatch(source, /useState<PeriodOption>\(DEFAULT_PERIOD\)/u);
  assert.match(source, /useState\(10\)/u);
  assert.match(source, /FeatureProjectCard/u);
  assert.match(source, /AnomalyPulse/u);
  assert.match(source, /哪些任务突然变胖了/u);
  assert.match(source, /青绿是窗口自身，琥珀黄是子任务/u);
  assert.match(source, /RecentTaskUsage/u);
  assert.match(source, /最近 10 个任务用了多少 Token/u);
  assert.match(source, /最近 10 个任务 Token 消耗，可在框内滚动/u);
  assert.match(source, /recentTasksByAgent/u);
  assert.match(source, /筛选近期任务智能体/u);
  assert.match(source, /\["all", "codex", "cursor"\]/u);
  assert.match(source, /left\.projectId === "other"/u);
  assert.match(source, /<ExternalUsageSummary items=\{data\.externalDetails \|\| \[\]\} account=\{data\.externalAccount\} period=\{period\.label\} \/>/u);
  assert.match(source, /useState<TrendSource>\("all"\)/u);
  assert.match(source, /aria-pressed=\{trendSource === agent\.id\}/u);
  assert.match(source, /toggleTrendSource\(agent\.id\)/u);
  assert.match(source, /trendSource === "external"/u);
  assert.match(source, /<TrendFigure data=\{selectedTrend\} source=\{trendSource\} \/>/u);
  assert.match(source, /selectTrendPeaks/u);
  assert.match(source, /points\.length <= 7 \? 2 : points\.length <= 30 \? 3 : 5/u);
  assert.match(source, /peak\.row\.day\.slice\(5\)/u);
  assert.match(source, /当前密钥累计/u);
  assert.match(source, /接入后本地实账/u);
  assert.match(source, /接入前历史未归属/u);
  assert.match(source, /不追踪聊天窗口/u);
  assert.match(source, /costUsd/u);
  assert.doesNotMatch(source, /CursorAccountLedger/u);
  assert.doesNotMatch(source, /导入 Usage CSV/u);
  assert.match(source, /智能体列区分 Codex／Cursor/u);
  assert.match(source, /按真实窗口计/u);
  assert.doesNotMatch(source, /Cursor 仅收录有标题的对话与稳定调度/u);
  assert.match(source, /account-history/u);
  assert.match(source, /本次用量/u);
  assert.match(source, /isSingleRunGauge/u);
  assert.match(source, /ao-input-cached/u);
  assert.match(source, /ao-usage-legend is-cache/u);
  assert.match(source, /ao-recent-track is-cache/u);
  assert.match(source, /Cursor 无子任务时条分新输入与缓存/u);
  assert.match(source, /source === "cursor" \? <>/u);
  assert.match(source, /未提供/u);
  assert.doesNotMatch(source, /Cursor 账户计价|Cursor 归属|<dt>Cursor 账户<\/dt>|<dt>Cursor 批次<\/dt>|<dt>外部实付<\/dt>/u);
  assert.match(source, /compact\(summary\?\.reasoningTokens\)/u);
  assert.doesNotMatch(source, /已知 \$\{compact\(summary\?\.reasoningTokens\)\}/u);
  assert.doesNotMatch(source, /¥实付|Cursor 实付/u);
  assert.doesNotMatch(source, /ao-account-banner/u);
  assert.match(source, /has-usage/u);
  assert.match(source, /Token 未提供/u);
  assert.match(source, /次事件 · \$\{agent\.runCount \|\| 0\} 次调度/u);
  assert.doesNotMatch(source, /按模型与日并入此表/u);
  assert.match(source, /linearGradient id="ao-trend-stroke"/u);
  assert.match(source, /item\.nodeKind === "project"/u);
  assert.match(source, /item\.nodeKind === "feature"/u);
  assert.match(source, /String\.fromCharCode\(65 \+ index\)/u);
  assert.match(source, /String\(index \+ 1\)\.padStart\(2, "0"\)/u);
  assert.match(source, /仅在细项之间比较/u);
  assert.match(source, /定时值班/u);
  assert.match(source, /Codex 心跳/u);
  assert.match(source, /触发来源未记录/u);
  assert.match(source, /projectId === "personal-life-operations"/u);
  assert.match(source, /scheduled-automation/u);
  assert.match(source, /24 小时/u);
  assert.match(source, /hours=24/u);
  assert.match(source, /days=3/u);
  assert.match(source, /未提供/u);
});

test("Cursor 账户历史在刷新账册时自动同步，不把日／模型聚合写进战报", async () => {
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  const server = await fs.readFile(new URL("../src/server/workbench-agent-observability.mjs", import.meta.url), "utf8");
  assert.match(routes, /source === "local-session"/u);
  assert.match(routes, /syncCursorAccountFromLocalSession/u);
  assert.match(routes, /assertLoopbackOnly\(request\)/u);
  assert.match(server, /maybeSyncCursorAccount\(root, options\)/u);
  assert.match(server, /cursorConversationTasksFromAccount\(/u);
  assert.match(server, /importCursorAccountEvents\(/u);
  assert.doesNotMatch(server, /function cursorAccountTasks\(/u);
  assert.match(server, /cursorCardTrend = cursorAccountUsage \? cursorAccountTrend : cursorScheduleTrend/u);
  assert.match(server, /!String\(task\.id\)\.startsWith\("cursor-account:"\)/u);
});

test("功能累计使用两列可折叠项目卡并把约十行限制在卡内滚动", async () => {
  const styles = await fs.readFile(new URL("../src/pages/tools/agent-observability.css", import.meta.url), "utf8");
  assert.match(styles, /\.ao-project-ledger\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(styles, /\.ao-project-card \.ao-feature-list\{[^}]*max-height:550px;[^}]*overflow-y:auto/u);
  assert.match(styles, /@media\(max-width:900px\)[\s\S]*?\.ao-project-ledger\{grid-template-columns:1fr/u);
  assert.match(styles, /\.ao-anomaly-grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
});

test("近期任务按时间显示十项并把约五行限制在框内滚动", async () => {
  const server = await fs.readFile(new URL("../src/server/workbench-agent-observability.mjs", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../src/pages/tools/agent-observability.css", import.meta.url), "utf8");
  assert.match(server, /\.slice\(0, 10\)/u);
  assert.match(styles, /\.ao-recent-list\{[^}]*max-height:294px[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/u);
  assert.match(styles, /\.ao-recent-filters/u);
  assert.match(styles, /\.ao-input-cached\{background:var\(--chart-violet\)/u);
  assert.doesNotMatch(styles, /\.ao-input-cached\{background:var\(--usage-secondary\)/u);
  assert.match(styles, /\.ao-usage-legend\.is-cache span\+span i\{background:var\(--chart-violet\)/u);
  assert.match(styles, /\.ao-recent-track\.is-cache i:last-child\{background:var\(--chart-violet\)/u);
  assert.match(styles, /\.ao-task-gauge-child\{background:var\(--usage-secondary\)/u);
});

test("区块说明采用稳定双栏并在窄屏自然回到标题下方", async () => {
  const styles = await fs.readFile(new URL("../src/pages/tools/agent-observability.css", import.meta.url), "utf8");
  assert.match(styles, /\.ao-section>header\{[^}]*display:grid;[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(250px,440px\);[^}]*align-items:center/u);
  assert.match(styles, /\.ao-section>header p\{[^}]*padding-left:14px;[^}]*border-left:1px solid var\(--line-strong\);[^}]*text-align:left/u);
  assert.match(styles, /@media\(max-width:900px\)\{\.ao-section>header\{[^}]*grid-template-columns:1fr/u);
});

test("OpenRouter 对账在手机上改为单列", async () => {
  const styles = await fs.readFile(new URL("../src/pages/tools/agent-observability.css", import.meta.url), "utf8");
  assert.match(styles, /\.ao-external-reconcile\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/u);
  assert.match(styles, /@media\(max-width:700px\)\{\.ao-external-reconcile\{grid-template-columns:1fr/u);
});

test("项目级账项与功能细项使用不同序号和比较基准", async () => {
  const styles = await fs.readFile(new URL("../src/pages/tools/agent-observability.css", import.meta.url), "utf8");
  assert.match(styles, /\.ao-project-summary article\{[^}]*grid-template-columns:28px minmax\(0,1fr\) auto/u);
  assert.match(styles, /\.ao-project-card\.is-wide\{grid-column:1\/-1\}/u);
});

test("日常使用是独立双栏，生活事务不用开发术语，值班保留明细与窄屏滚动", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/AgentObservabilityView.tsx", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../src/pages/tools/agent-observability.css", import.meta.url), "utf8");
  assert.ok(source.indexOf('id="ao-daily-title"') < source.indexOf('id="ao-development-title"'));
  assert.ok(source.indexOf('<RecentTaskUsage ') < source.indexOf('id="ao-daily-title"'));
  assert.ok(source.indexOf('id="ao-daily-title"') < source.indexOf('<AnomalyPulse '));
  assert.equal(source.match(/className="ao-section ao-daily-ledger"/gu)?.length, 1);
  assert.match(source, /<PersonalLifeCard/u);
  assert.match(source, /近期生活事务/u);
  assert.match(source, /值班用量已包含在所属项目中，不另加一次/u);
  const dailyCards = source.slice(source.indexOf("function ScheduledTaskCard"), source.indexOf("function FeatureProjectCard"));
  assert.doesNotMatch(dailyCards, /功能细项|项目级账项|ao-project-letter|is-wide/u);
  assert.match(dailyCards, /aria-controls="ao-duty-body"/u);
  assert.match(dailyCards, /ledger\.measuredRunCount \?/u);
  assert.match(dailyCards, /entries\.some\(\(entry\) => entry\.measuredTaskCount > 0\)/u);
  assert.match(styles, /\.ao-daily-grid\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
  assert.match(styles, /\.ao-duty-list\{[^}]*max-height:304px;overflow-y:auto/u);
  assert.match(styles, /@media\(max-width:900px\)\{\.ao-daily-grid\{grid-template-columns:1fr/u);
});

test("近期生活事务逐项显示当前周期任务链用量，未知不补零，时间在标题下方", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/AgentObservabilityView.tsx", import.meta.url), "utf8");
  const styles = await fs.readFile(new URL("../src/pages/tools/agent-observability.css", import.meta.url), "utf8");
  const recent = source.slice(source.indexOf('<div className="ao-life-recent">'), source.indexOf("function FeatureProjectCard"));
  assert.match(recent, /所选周期内的整件事用量，含子任务/u);
  assert.match(recent, /className="ao-life-task-main"[\s\S]*<strong[\s\S]*<time/u);
  assert.match(recent, /className="ao-life-task-usage"/u);
  assert.match(recent, /!task\.totalUsage \|\| task\.totalUsage\.fieldStatus\?\.totalTokens === "unknown" \? "Token 未知"/u);
  assert.match(recent, /usageField\(task\.totalUsage, "totalTokens"\)/u);
  assert.doesNotMatch(recent, /task\.selfUsage|task\.childUsage/u);
  assert.match(styles, /\.ao-life-recent li\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/u);
  assert.match(styles, /\.ao-life-task-main\{[^}]*display:grid/u);
  assert.doesNotMatch(styles, /\.ao-life-recent li\{[^}]*grid-template-columns:1fr/u);
});

test("缓存先展示，后台仅在当前页面更新，慢请求不能覆盖新周期", async () => {
  const source = await fs.readFile(new URL("../src/pages/tools/AgentObservabilityView.tsx", import.meta.url), "utf8");
  const routes = await fs.readFile(new URL("../src/server/workbench-routes.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(!force && cached\) setData\(cached\)/u);
  assert.match(source, /requestId === requestSequence\.current/u);
  assert.match(source, /!active \|\| loading \|\| error \|\| data\?\.cacheStatus !== "refreshing"/u);
  assert.match(source, /window\.clearTimeout\(timer\)/u);
  const route = routes.slice(routes.indexOf('router.use("/api/tools/agent-observability",'), routes.indexOf('router.use("/api/tools/agent-observability",') + 1000);
  assert.match(route, /readExternalStatus: \(\) => openRouterStatus\(\{ probe: true \}\)/u);
  assert.doesNotMatch(route, /await Promise\.all/u);
});
