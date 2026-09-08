import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanInline, extractSection, invalidateVaultScanCache, parseHealth, parseJapanese, parseMarketBrief, parseMarketEventTopicDocument, flattenSignalTags, parseTodayTrainingPlan, parseWeekTrainingPlan, parseSessionExercises, buildCoachHints, parseTopSetLoad, parseSetVolume, deriveTrainingVolume, deriveStrengthBaselineTable, deriveProgressionAdvice, deriveMuscleBalance, deriveRecoveryLoad, parseStageStartDate, deriveMesocyclePosition, parseDiaryWorkIntensity, parseMindSignals, parseDiaryRecoveryLine, deriveRecoveryPercents, aggregateLineEnergyCandidates, parseLifeDesignLog, parseCompassDocs, parseCompassCoherence, parseOdysseyPlan, parseLifeToolbox, parseMindScales, parseRecentWellbeing, parseHealthStatusReport, parseHealthReports, parseMindDemoSignals, parseInterventionCardLibrary, recommendInterventionCards, parsePlanningItems, parseTrainingExerciseRow, parseRpeRirToken, deriveSessionIntensity, readMarketBriefByDate, readWritingById, scanVault, scanWorkbenchSection, scanWorkbenchSummary, searchVault, SOURCES, splitMarkdownRow, staleMusclesFromSessions, summarizeWorkbench, trimAppleHealthForSection, trimLanguagesForSection, WORKBENCH_VERSION } from "../src/server/workbench-data.mjs";
import { readHomePins, writeHomePins } from "../src/server/workbench-home-pins.mjs";
import { applyHiddenCalendarEvents, readGanttHidden, writeGanttHidden, todoHideKey } from "../src/server/workbench-gantt-hidden.mjs";

// 测例只用 Markdown 里的日语进度，别让本机开着的 Anki 盖掉 fixture。
process.env.INFANS_ANKI_PROGRESS = "0";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infans-workbench-"));
  const content = {
    [SOURCES.identity]: `---\ndescription: test\ntags: [test]\n---\n# 身份策展\n## 现在\n### 标题\n正在建设。\n### 简介\n这是现在的简介。\n### 当前角色\n- 日本留学\n- 独立游戏\n## 过去\n### 标题\n从现实中走来。\n### 简介\n这是过去的简介。\n### 关键线索\n- 项目运营`,
    [SOURCES.todo]: `# 待办事项与长期规划\n## 最近两天\n- [ ] **完成工作台**\n- [x] 已核对方案\n## 当前主线\n| 优先级 | 事项 | 入口 |\n|---|---|---|\n| 旗舰 | [[阳台种植计划_总览]] | [[入口]] |\n## 长期在推\n- [ ] 学日语`,
    [SOURCES.projects]: `# 事业顺利\n## 当前重点\n| 项目 | 状态 | 入口 |\n|---|---|---|\n| **阳台种植计划** | 开发中 | [[入口]] |\n| 示例助手项目 | 运营中 | [[入口]] |`,
    [SOURCES.flagship]: `# 阳台种植计划\n示例版本 **v0.1.0**\n## 当前进度（2026-07 示例）\n**已较成型**\n- 浇水记录\n- 花盆清单\n\n**正在推 / 待验收**\n- 换土最短闭环\n- 阳台遮阳\n\n**明确未做**\n- 自动浇水`,
    [SOURCES.coaching]: `# 示例助手项目\n## 现在最重要的一件事\n> **把阳台花盆换土。**`,
    [SOURCES.coachingLog]: `# 更新日志\n## 2026-07-31\n- 更新方法库\n- 整理种植计划`,
    [SOURCES.healthOverview]: `# 身心健康`,
    [SOURCES.body]: `# 三维记录\n## 围度与体重\n| 项目 | 2026-06-10 |\n|---|---:|\n| 体重（斤） | 150.8 |\n| 腰围 | 80 |`,
    [SOURCES.training]: `# 训练日志\n## 2026-06-11（周四）｜上肢\n| 动作 | 组次 | 顶组 |\n|---|---|---|\n| 杠铃卧推 | 3 | 60 kg × 12 |\n| 引体向上 | 3 | 自重 × 8 |\n## 2026-07-22（周三）｜轻量覆盖\n| 动作 | 组次 | 顶组 |\n|---|---|---|\n| 深蹲 | 3 | 60 kg × 10 |`,
    [SOURCES.trainingPlan]: `# 训练计划\n## 周安排\n| 周几 | 内容 |\n|---|---|\n| 周一 | **上肢日 A**（胸主导·平板） |\n| 周二 | **下肢日 A** |\n| 周三 | 游泳（中低强度，30–40 min）+ 举铁休息 |\n| 周四 | **上肢日 B**（胸主导·上斜 + 背） |\n| 周五 | **下肢日 B** |\n| 周六 | 游泳（中低强度，30–40 min） |\n| 周日 | 完全休息 |`,
    [SOURCES.japaneseOverview]: `# 日语总览`,
    [SOURCES.japaneseStatus]: `# 当前状态\n最近更新：2026-08-20（示例）\n## 当前阶段\n**示例词汇线：N3 高频推进中。**\n当前计划范围（N3 + N2）：已学 80 / 820。\n今日待复习 20 张。\n当前连续学习 12 天。\n- 最近 7 个完整学习日：答题 210 次，日均约 30 次；引入新卡 56 张，日均约 8 张。\n- 最近 14 个完整学习日：引入新卡 98 张，日均约 7 张。\n## 词汇线（Anki）\n| 层级 | 总数 | 已学 | 剩余 | 完成度 | 状态 |\n|---|---:|---:|---:|---:|---|\n| N3 高频 | 120 | 80 | 40 | 66.7% | 进行中 |\n## 待办决策\n- [ ] 文法复习`,
    [SOURCES.japaneseDaily]: `# 每日记录\n## 2026-06-03（周三）`,
    [SOURCES.grammarN5]: `# N5 文法\n## 一、条件表达\n> 放在一起对照。\n**N5-01 〜たら**　｜掌握度 0｜复习 —\n- 接续：普通形\n- 含义：如果\n- 例：雨が降ったら、行きません。\n- 辨析：强调条件成立之后。\n\n**N5-02 〜なら**　｜掌握度 3｜复习 2026-08-01\n- 含义：如果是`,
    [SOURCES.grammarN4]: `# N4 文法\n## 一、时间关系\n**N4-01 〜間**　｜掌握度 0｜复习 —\n- 含义：在……期间`,
    [SOURCES.grammarN3]: `# N3 文法\n## 一、原因理由\n**N3-01 〜ために**　｜掌握度 0｜复习 —\n- 含义：因为`,
    [SOURCES.grammarN2]: `# N2 文法\n## 一、逆接\n**N2-01 〜ものの**　｜掌握度 0｜复习 —\n- 含义：虽说`,
    [SOURCES.library]: `# 学习与阅读经历\n| 得到 App | 文件 | ✅ 55 门 + 2 门日期待补 |\n| 微信读书 | 文件 | ✅ 176 本 + 1 听书（已读完 62） |`,
    [SOURCES.weread]: `# 微信读书\n## 已读完（62）\n| 书名 | 作者 | 分类 | 最近阅读 |\n|---|---|---|---|\n| 门阀\\|士族史 | 李某 | 历史 | 2026-01-01 |\n## 书架其他 · 未标读完（114）\n| 书名 | 作者 | 分类 | 最近阅读 |\n|---|---|---|---|\n| 第二本 |  | 文学 | 待补 |`,
    [SOURCES.dedao]: `# 得到 App\n共 **1** 门。\n## 2026\n| 课程 | 日期 |\n|---|---|\n| 产品思维课 | 2026-01-02 |`,
    [SOURCES.paperBooks]: `# 纸质书\n## 通识\n| 书名 | 作者 | 备注 |\n|---|---|---|\n| 纸质测试书 | 作者甲 | 已读 |`,
    [SOURCES.writing]: `# 原创写作`,
    [SOURCES.learning]: `# 学习成长`,
    [SOURCES.cultureOverview]: `---\ndescription: 个人游戏文化谱系\ntags: [游戏文化]\n---\n# 个人游戏文化谱系_总览`,
    [SOURCES.cultureWow]: `---\ndescription: 示例作品甲记录\ntags: [游戏文化]\ntype: game-culture-card\n---\n# 示例作品甲\n## 本人原始判断\n> 这是虚构测试对象甲，用来验证卡片解析，不是个人评价。\n## 待本人补充\n- 示例作品甲还缺哪条结构字段？`,
    [SOURCES.cultureSouls]: `---\ndescription: 示例作品乙记录\ntags: [游戏文化]\ntype: game-culture-card\n---\n# 示例作品乙\n## 本人原始判断\n> 这是虚构测试对象乙，用来验证判断字段读取。\n## 待本人补充\n- 示例作品乙还要补什么说明？`,
    [SOURCES.cultureZelda]: `---\ndescription: 示例作品丙记录\ntags: [游戏文化]\ntype: game-culture-card\n---\n# 示例作品丙\n## 本人原始判断\n> 这是虚构测试对象丙，用来验证提示列表。\n## 待本人补充\n- 示例作品丙的下一问是什么？`,
    [SOURCES.screenOverview]: `# 我的动漫与影视\n## 动漫展示元数据\n| 作品 | 首播年 | 主类型 | 最爱 | 资料来源 |\n|---|---:|---|---|---|\n| 十二国记 | 2002 | 奇幻冒险 | — | Bangumi #1856 · 2026-08-26 |\n| 灰与幻想的格林姆迦尔 | 2016 | 奇幻冒险 | — | Bangumi #148726 · 2026-08-26 |\n| 凡人修仙传 · 动画 | 2020 | 历史修仙 | 是 | Bangumi #223147 · 2026-08-26 |\n| 猫和老鼠 | 1940 | 儿童合家欢 | — | 人工复核 · 2026-08-26 |\n## 日漫馆藏清单\n| 作品 | 状态 | 确认来源 |\n|---|---|---|\n| 十二国记 | 想看 | 本人标记 |\n| 灰与幻想的格林姆迦尔 | 正在看 | 本人确认 |\n## 国漫馆藏清单\n| 作品 | 状态 | 确认来源 |\n|---|---|---|\n| 凡人修仙传 · 动画 | 看过 | 本人确认 |\n## 其他引进动画馆藏清单\n| 作品 | 状态 | 确认来源 |\n|---|---|---|\n| 猫和老鼠 | 看过 | 本人确认 |\n## 电影馆藏清单\n| 作品 | 状态 | 确认来源 |\n|---|---|---|\n| 天空之城 | 看过 | 本人确认 |`,
    [SOURCES.screenFanren]: `---\ndescription: 示例动画记录\ntags: [动画]\ntype: screen-culture-card\nmedium: 动画\nviewing_status: 待补\n---\n# 凡人修仙传 · 动画\n## 本人原始判断\n> 示例动画卡片，用来验证馆藏解析，不是个人观感。\n## 待本人补充\n- 这条示例还缺哪项元数据？`,
    [SOURCES.screenCinemaParadiso]: `---\ndescription: 示例电影记录\ntags: [电影]\ntype: screen-culture-card\nmedium: 电影\nviewing_status: 部分观看\n---\n# 天堂电影院\n## 本人原始判断\n> 示例电影卡片，用来验证影响标记，不是个人回忆。\n## 待本人补充\n- 这条示例还要补什么状态？`,
    [SOURCES.gameResearch]: `---\ndescription: 游戏文化与设计研究\ntags: [游戏文化]\n---\n# 游戏文化研究_总览`,
    [SOURCES.gameResearchQuestions]: `---\ndescription: 首批研究问题\ntags: [游戏文化]\n---\n# 首批研究问题\n## 示例长期世界\n- 长期世界如何形成归属？\n- 哪些多人经验不能直接转为单机？\n## 示例关卡表达\n- 关卡与失败体验怎样形成统一表达？\n## 研究完成后要回答\n- 哪些判断被反例修正？`,
    [SOURCES.marketBrief]: `# 当前简报\n<!-- INFANS_MARKET_BRIEF_JSON_START -->\n\`\`\`json\n{"schemaVersion":1,"generatedAt":"2026-08-01T09:00:00+09:00","asOf":"2026-08-01","headline":"只看大事","status":"active","events":[{"id":"fed","importance":5,"category":"央行","title":"政策决定","fact":"维持利率","whyItMatters":"改变预期","marketReaction":"利率波动","impact":"利率更高更久","confidence":"中等","watchNext":["CPI"],"signal":{"targets":["美股","利率"],"bias":"偏空","urgency":"重大"},"sources":[{"title":"官方","url":"https://example.com/fed","type":"一手"}]},{"id":"ai-1","importance":4,"category":"AI热点","title":"算力开支仍高","fact":"云厂商继续扩容","whyItMatters":"牵引半导体","marketReaction":"AI股分化","impact":"景气延续","confidence":"中等","watchNext":["下季财报"],"sources":[{"title":"财报","url":"https://example.com/ai","type":"一手"}]}],"calendar":[{"date":"2026-08-07","title":"就业报告","region":"美国","importance":5,"dateConfirmed":true,"featured":true,"whyWatch":"观察就业","sourceUrl":"https://example.com/jobs"}],"note":"不构成投资建议"}\n\`\`\`\n<!-- INFANS_MARKET_BRIEF_JSON_END -->`,
    "50_世界资讯/金融/重大事件专题/test-cpi.md": `# 测试专题\n<!-- INFANS_MARKET_EVENT_TOPIC_JSON_START -->\n\`\`\`json\n{"schemaVersion":1,"id":"test-cpi","title":"CPI 测试专题","eventDate":"2026-08-20","eventTime":"21:30 JST","region":"美国","category":"通胀","status":"tracking","latestConclusion":"事实已确认，解释仍待跨市场验证。","missingEvidence":["D+3 反应"],"updatedAt":"2026-08-20T22:00:00+09:00","nodes":[{"phase":"release","status":"current","observedAt":"2026-08-20 21:35 JST","conclusion":"只记录事实与候选解释。","facts":["官方结果已发布"],"candidateJudgments":["解释 A 待验证"],"missingEvidence":["利率收盘"],"sources":[{"title":"官方","url":"https://example.com/cpi","type":"一手"},{"title":"坏链接","url":"javascript:alert(1)","type":"未知"}]}]}\n\`\`\`\n<!-- INFANS_MARKET_EVENT_TOPIC_JSON_END -->`,
    "50_世界资讯/金融/简报历史/2026-07-31.md": `# 归档\n<!-- INFANS_MARKET_BRIEF_JSON_START -->\n\`\`\`json\n{"schemaVersion":1,"generatedAt":"2026-07-31T09:00:00+09:00","asOf":"2026-07-31","headline":"安静日","status":"quiet","events":[],"calendar":[],"note":"归档"}\n\`\`\`\n<!-- INFANS_MARKET_BRIEF_JSON_END -->`,
    "60_艺术馆藏/写作/随笔/完整日期文章.md": `---\ndescription: 一篇测试文章\ndate: 2026-07-30\ntags: [随笔, 测试]\n---\n# 完整日期文章\n\n## 第一章\n\n这是完整正文。`,
    "30_事业顺利/公众号_示例手记/《近思》系列/02_意义测试.md": `---\ndescription: 公众号测试文\ndate: 2026-02-01\ntags: [示例手记, 近思]\n---\n# 意义，就是被理解的可能性（测试）\n\n这是公众号正文。`,
    "70_专题研究/人工智能/人工智能_总览.md": `---\ndescription: 人工智能\ntags: [AI]\n---\n# 人工智能`,
    "70_专题研究/游戏/游戏文化研究_总览.md": `---\ndescription: 游戏\ntags: [游戏]\n---\n# 游戏`,
    "70_专题研究/语言研究/语言研究_总览.md": `---\ndescription: 语言研究\ntags: [语言]\n---\n# 语言研究`,
    "70_专题研究/思想史/思想史_总览.md": `---\ndescription: 思想史\ntags: [思想史]\n---\n# 思想史_总览`,
    "70_专题研究/资治通鉴/资治通鉴_总览.md": `---\ndescription: 资治通鉴\ntags: [历史]\n---\n# 资治通鉴`,
    "70_专题研究/形象管理/形象管理_总览.md": `---\ndescription: 形象管理\ntags: [形象]\ntopicId: image-management\n---\n# 形象管理_总览`,
    "70_专题研究/运动健身/运动健身_总览.md": `---\ndescription: 运动健身\ntags: [健身]\n---\n# 运动健身`,
    "70_专题研究/经济与金融/经济与金融_总览.md": `---\ndescription: 经济与金融\ntags: [经济, 金融]\ntopicId: economics-finance\n---\n# 经济与金融`,
    "70_专题研究/经济与金融/知识节点/复利样板.md": `---\ndescription: 复利样板\ntags: [经济与金融]\ntype: domain-knowledge-node\ndomainId: economics-finance\nbranchId: ef-quant-data\ntopicId: ef-quant-data-01\nnodeId: economics-finance-compound-interest-sample\nstatus: formal\norder: 10\nasOf: 2026-08-25\njurisdiction: general-math\nsources:\n  - id: investor-source\n    title: Investor source\n    kind: regulator-education\n    url: https://example.com/compound\n    role: definition\n---\n# 复利样板\n\n## 一眼先懂 {#first-look}\n\n复利让收益继续参与下一期计算。\n\n## 边界 {#boundary}\n\n数学示例不是收益承诺。`,
    "55_语言学习/拉丁语/拉丁语_总览.md": `---\ndescription: 拉丁语\ntags: [语言]\n---\n# 拉丁语_总览`,
    "55_语言学习/古汉语/古汉语_总览.md": `---\ndescription: 汉语\ntags: [语言]\n---\n# 古汉语_总览`,
  };
  content[SOURCES.screenOverview] = content[SOURCES.screenOverview].replace("| 最爱 |", "| 推荐 |");
  content[SOURCES.screenFanren] = content[SOURCES.screenFanren].replace("viewing_status: 待补\n", "viewing_status: 待补\narchive_roles: [influence, recommendation]\n");
  content[SOURCES.screenCinemaParadiso] = content[SOURCES.screenCinemaParadiso].replace("viewing_status: 部分观看\n", "viewing_status: 部分观看\narchive_roles: [influence]\n");
  for (const [relative, text] of Object.entries(content)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text, "utf8");
  }
  return root;
}

test("cleans wiki links without leaking paths", () => {
  assert.equal(cleanInline("**旗舰** · [[30_事业顺利/阳台种植计划/阳台种植计划_总览|进入项目]]"), "旗舰 · 进入项目");
});

test("extracts a bounded Markdown section", () => {
  const text = "# A\n## One\nfirst\n### Child\ninside\n## Two\nsecond";
  assert.equal(extractSection(text, "One"), "first\n### Child\ninside");
});

test("extracts headings with a decorative emoji", () => {
  assert.equal(extractSection("# A\n## 🎯 现在最重要的一件事\n> 正文", "现在最重要的一件事"), "> 正文");
});

test("parses escaped table pipes without shifting columns", () => {
  assert.deepEqual(splitMarkdownRow("| 门阀\\|士族史 | 作者 |"), ["门阀|士族史", "作者"]);
});

test("parses governed planning rows without turning their detail bullets into mainlines", () => {
  const rows = parsePlanningItems(`
- [ ] 公众号：节点：2026-08-30 · 更新五年计划
- 游戏：项目进度 · 里程碑：2026-09-01 · 推出正式版
  - 这是里程碑说明，不是另一条主线
- 公司：已完成项目记录：2026-08-13 · 官网第一版
- 日语：学习阶段参考：7/1–7/31 N5 巩固（已过去）
`);
  assert.deepEqual(rows, [
    { done: false, text: "公众号：节点：2026-08-30 · 更新五年计划" },
    { done: false, text: "游戏：项目进度 · 里程碑：2026-09-01 · 推出正式版" },
    { done: true, text: "公司：已完成项目记录：2026-08-13 · 官网第一版" },
    { done: true, text: "日语：学习阶段参考：7/1–7/31 N5 巩固（已过去）" },
  ]);
});

test("builds a real read-only snapshot from allowlisted sources", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await scanVault(root);
  assert.equal(snapshot.version, WORKBENCH_VERSION);
  assert.equal(snapshot.identity.current.roles[0], "日本留学");
  assert.equal(snapshot.todo.today[0].text, "完成工作台");
  assert.equal(snapshot.todo.mainlines[0].item, "阳台种植计划_总览");
  assert.equal(snapshot.projects.items[1].name, "示例助手项目");
  assert.equal(snapshot.projects.items[1].entryPath, "入口");
  assert.equal(snapshot.health.weight, "75.4 kg");
  assert.equal(snapshot.health.latestTraining, "2026-07-22 · 轻量覆盖");
  assert.equal(snapshot.health.sessions[0].status, "未记录");
  assert.ok(snapshot.health.todayPlan?.title);
  assert.ok(Array.isArray(snapshot.health.staleMuscles));
  assert.equal(snapshot.japanese.progress.learned, 80);
  assert.equal(snapshot.japanese.queue, 20);
  assert.equal(snapshot.japanese.streak, 12);
  assert.equal(snapshot.japanese.pace7, 8);
  assert.equal(snapshot.japanese.pace14, 7);
  assert.equal(snapshot.japanese.grammar[0].total, 2);
  assert.equal(snapshot.japanese.grammar[0].groups[0].points[1].title, "〜なら");
  assert.equal(snapshot.japanese.grammar[0].mastered, 1);
  assert.equal(snapshot.projects.flagship.version, "v0.1.0");
  assert.equal(snapshot.projects.flagship.ready[0], "浇水记录");
  assert.equal(snapshot.projects.flagship.focus, "换土最短闭环");
  assert.equal(snapshot.projects.coaching.focus, "把阳台花盆换土。");
  assert.equal(snapshot.library.books, 2);
  assert.equal(snapshot.library.completedBooks, 1);
  assert.equal(snapshot.library.courses, 1);
  assert.equal(snapshot.library.games, 0);
  assert.equal(snapshot.library.animation, 4);
  assert.equal(snapshot.library.screen, 2);
  assert.equal(snapshot.library.writing.count, 2);
  assert.equal(snapshot.library.cultureArchive.cards.length, 5);
  assert.equal(snapshot.library.cultureArchive.cards[0].originalJudgment, "这是虚构测试对象甲，用来验证卡片解析，不是个人评价。");
  assert.equal(snapshot.library.cultureArchive.cards[0].prompts[0], "示例作品甲还缺哪条结构字段？");
  assert.equal(snapshot.library.cultureArchive.cards[3].medium, "动画");
  assert.equal(snapshot.library.cultureArchive.cards[4].viewingStatus, "部分观看");
  assert.deepEqual(snapshot.library.cultureArchive.screenCatalog.map((item) => [item.title, item.viewingStatus]), [
    ["十二国记", "想看"],
    ["灰与幻想的格林姆迦尔", "正在看"],
    ["凡人修仙传 · 动画", "看过"],
    ["猫和老鼠", "看过"],
    ["天空之城", "看过"],
  ]);
  assert.deepEqual(Object.keys(snapshot.library.cultureArchive.paths), ["gameOverview", "screenOverview"]);
  assert.equal(snapshot.library.domainResearch.game.title, "游戏");
  assert.equal(snapshot.library.domainResearch.game.researchLines.length, 2);
  assert.equal(snapshot.library.domainResearch.game.researchLines[0].title, "示例长期世界");
  assert.deepEqual(snapshot.library.domainResearch.game.researchLines[0].questions, ["长期世界如何形成归属？", "哪些多人经验不能直接转为单机？"]);
  assert.equal(snapshot.library.domainResearch.game.researchLines.some((line) => line.title === "研究完成后要回答"), false);
  assert.equal(snapshot.library.domainResearch.knowledgeNodes.length, 1);
  assert.equal(snapshot.library.domainResearch.knowledgeNodes[0].nodeId, "economics-finance-compound-interest-sample");
  assert.deepEqual(snapshot.library.domainResearch.knowledgeNodes[0].cards.map((card) => card.id), ["economics-finance-compound-interest-sample-first-look", "economics-finance-compound-interest-sample-boundary"]);
  assert.equal(snapshot.library.items.some((item) => item.kind === "animation" && item.title.includes("凡人修仙传")), true);
  assert.equal(snapshot.library.items.find((item) => item.title === "凡人修仙传 · 动画")?.viewingStatus, "看过");
  assert.equal(snapshot.library.items.find((item) => item.title === "凡人修仙传 · 动画")?.region, "国漫");
  assert.equal(snapshot.library.items.find((item) => item.title === "凡人修仙传 · 动画")?.releaseYear, 2020);
  assert.equal(snapshot.library.items.find((item) => item.title === "凡人修仙传 · 动画")?.primaryGenre, "历史修仙");
  assert.equal(snapshot.library.items.find((item) => item.title === "凡人修仙传 · 动画")?.recommended, true);
  assert.equal(snapshot.library.items.find((item) => item.title === "凡人修仙传 · 动画")?.influence, true);
  assert.equal(snapshot.library.items.find((item) => item.title === "天堂电影院")?.influence, true);
  assert.match(snapshot.library.items.find((item) => item.title === "凡人修仙传 · 动画")?.metadataSource ?? "", /Bangumi/);
  assert.equal(snapshot.library.items.find((item) => item.title === "十二国记")?.region, "日漫");
  assert.equal(snapshot.library.items.find((item) => item.title === "猫和老鼠")?.region, "其他引进");
  assert.equal(snapshot.library.items.find((item) => item.title === "灰与幻想的格林姆迦尔")?.viewingStatus, "正在看");
  assert.equal(snapshot.library.items.find((item) => item.title === "十二国记")?.openable, false);
  assert.equal(snapshot.library.items.find((item) => item.kind === "animation")?.reflectionPrompt, "这条示例还缺哪项元数据？");
  assert.equal(snapshot.library.items.some((item) => item.kind === "screen" && item.medium === "电影"), true);
  assert.equal(snapshot.library.items.some((item) => item.title === "门阀|士族史"), true);
  assert.equal(snapshot.library.items.some((item) => item.kind === "writing" && item.category === "示例手记"), true);
  assert.deepEqual(snapshot.market.events.map((event) => event.title), ["算力开支仍高", "政策决定"]);
  assert.equal(snapshot.market.events[0].lane, "focus");
  assert.equal(snapshot.market.calendar[0].title, "就业报告");
  assert.equal(snapshot.market.calendar[0].dateConfirmed, true);
  assert.equal(snapshot.market.calendar[0].featured, true);
  assert.equal(snapshot.market.topics.length, 1);
  assert.equal(snapshot.market.topics[0].status, "tracking");
  assert.equal(snapshot.market.topics[0].nodes[0].sources.length, 1);
  assert.equal(snapshot.market.date, "2026-08-01");
  assert.equal(snapshot.market.history.length, 2);
  assert.equal(snapshot.market.history[0].date, "2026-07-31");
  assert.equal(snapshot.market.history[1].latest, true);
  assert.equal(snapshot.market.world.ai.status, "quiet");
  assert.equal(snapshot.market.world.japan.readings.length, 0);
  assert.deepEqual(snapshot.warnings, []);
});

test("parses Steam game library into cover cards sorted by playtime", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, path.dirname(SOURCES.steamGames)), { recursive: true });
  await fs.writeFile(path.join(root, SOURCES.steamGames), JSON.stringify({
    steamid: "76561198000000000",
    persona: "示例账号",
    game_count: 2,
    played_count: 2,
    games: [
      { appid: 10, name: "Short", playtime_minutes: 60, playtime_hours: 1 },
      { appid: 20, name: "Long", playtime_minutes: 600, playtime_hours: 10 },
    ],
  }), "utf8");
  invalidateVaultScanCache();
  const snapshot = await scanVault(root, { force: true });
  assert.equal(snapshot.library.games, 2);
  const games = snapshot.library.items.filter((item) => item.kind === "game");
  assert.equal(games[0].title, "Long");
  assert.equal(games[0].status, "10 小时");
  assert.match(games[0].coverUrl, /\/apps\/20\//);
  assert.equal(games[1].title, "Short");
});

test("hand-recorded games use playtime on the card footer like Steam", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, path.dirname(SOURCES.extraGames)), { recursive: true });
  await fs.writeFile(path.join(root, SOURCES.extraGames), JSON.stringify({
    games: [
      {
        id: "pc-wow",
        platform: "PC客户端",
        medium: "客户端",
        name_zh: "魔兽世界",
        playtime_hours: 100,
        playtime_minutes: 6000,
      },
      {
        id: "ns-botw",
        platform: "NS",
        medium: "卡带",
        name_zh: "塞尔达传说 旷野之息",
        cover_url: "https://assets.example.test/botw.jpg",
        external_url: "https://www.nintendo.com/example/botw",
      },
    ],
  }), "utf8");
  invalidateVaultScanCache();
  const snapshot = await scanVault(root, { force: true });
  const games = snapshot.library.items.filter((item) => item.kind === "game");
  assert.equal(games[0].title, "魔兽世界");
  assert.equal(games[0].status, "100 小时");
  assert.equal(games[0].medium, "客户端");
  assert.equal(games[0].category, "PC客户端");
  const ns = games.find((item) => item.title.includes("旷野之息"));
  assert.equal(ns.status, "");
  assert.equal(ns.medium, "卡带");
  assert.equal(ns.coverUrl, "https://assets.example.test/botw.jpg");
  assert.equal(ns.externalUrl, "https://www.nintendo.com/example/botw");
});

test("Apple Games entries keep played evidence, official covers, and their own source", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, path.dirname(SOURCES.appleGames)), { recursive: true });
  await fs.writeFile(path.join(root, SOURCES.appleGames), JSON.stringify({
    games: [{
      id: "apple-728293409",
      platform: "iOS",
      medium: "Apple Games · Game Center",
      name_zh: "纪念碑谷",
      app_store_id: "728293409",
      note: "Game Center 有成就记录",
      cover_url: "https://is1-ssl.mzstatic.com/example.jpg",
      external_url: "https://apps.apple.com/app/id728293409",
    }],
  }), "utf8");
  invalidateVaultScanCache();
  const snapshot = await scanVault(root, { force: true });
  const game = snapshot.library.items.find((item) => item.title === "纪念碑谷");
  assert.equal(game.category, "iOS");
  assert.equal(game.coverUrl, "https://is1-ssl.mzstatic.com/example.jpg");
  assert.equal(game.externalUrl, "https://apps.apple.com/app/id728293409");
  assert.equal(game.sourcePath, SOURCES.appleGames);
  assert.ok(game.tags.includes("Apple Games"));
});

test("Steam games prefer Chinese titles and expose release date on cards", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, path.dirname(SOURCES.steamGames)), { recursive: true });
  await fs.writeFile(path.join(root, SOURCES.steamGames), JSON.stringify({
    games: [
      {
        appid: 1366540,
        name: "戴森球计划",
        name_zh: "戴森球计划",
        name_en: "Dyson Sphere Program",
        name_ja: "ダイソンスフィアプログラム",
        release_date: "2021-01-20",
        playtime_minutes: 100,
        playtime_hours: 1.7,
      },
    ],
  }), "utf8");
  invalidateVaultScanCache();
  const snapshot = await scanVault(root, { force: true });
  const game = snapshot.library.items.find((item) => item.kind === "game");
  assert.equal(game.title, "戴森球计划");
  assert.equal(game.titleEn, "Dyson Sphere Program");
  assert.equal(game.date, "2021-01-20");
  assert.match(game.description, /Dyson Sphere Program/);
});

test("summary stays small and excludes route detail payloads", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const summary = await scanWorkbenchSummary(root);
  assert.equal(summary.version, WORKBENCH_VERSION);
  assert.equal(summary.health.appleHealth, undefined);
  assert.equal(summary.japanese.grammar, undefined);
  assert.equal(summary.japanese.languageReactor, undefined);
  assert.equal(summary.japanese.pace7, 8);
  assert.equal(summary.japanese.pace14, 7);
  assert.equal(summary.japanese.ankiSource, null);
  assert.equal(summary.japanese.dailySentence, null);
  assert.equal(summary.library.items, undefined);
  assert.equal(summary.library.latestWriting.title, "完整日期文章");
  assert.ok(Array.isArray(summary.library.topics));
  assert.ok(summary.library.topics.length >= 1);
  assert.equal(summary.library.topics.find((topic) => topic.title === "形象管理")?.topicId, "image-management");
  assert.equal(summary.market.events, undefined);
  assert.equal(summary.market.topEvents[0].title, "政策决定");
  assert.deepEqual(summary.market.topEvents[0].signalTags, ["美股", "利空", "重大"]);
  assert.equal(summary.market.aiHotspots[0].title, "算力开支仍高");
  assert.equal(summary.market.aiHotspots[0].category, "AI热点");
  assert.equal(summary.market.aiHotspots[0].signalTags, undefined);
  assert.equal(summary.market.worldLanes[0].id, "japan");
  assert.equal(summary.market.worldLanes[0].href, "/markets");
  assert.equal(summary.market.worldLanes[1].id, "finance");
  assert.equal(summary.market.worldLanes[1].href, "/markets?lane=finance");
  assert.equal(summary.market.worldLanes[1].items[0].title, "算力开支仍高");
  assert.deepEqual(summary.market.worldLanes[1].items[0].tags, ["AI热点"]);
  assert.equal(summary.market.worldLanes[2].id, "ai");
  assert.equal(summary.market.worldLanes[3].id, "games");
  assert.deepEqual(flattenSignalTags({ targets: ["日元"], bias: "待验证", urgency: "重大" }, { category: "日本", importance: 4 }), ["日元", "还没出"]);
  assert.deepEqual(flattenSignalTags({ targets: ["美股"], bias: "利好" }, { category: "宏观", importance: 5 }), ["美股", "利好"]);
  assert.deepEqual(flattenSignalTags({ targets: ["油价"], bias: "偏多", urgency: "重大" }, { category: "地缘", importance: 5 }), ["油价", "利好", "重大"]);
  assert.deepEqual(flattenSignalTags({ targets: ["美股"], bias: "分化", urgency: "重大" }, { category: "宏观", importance: 5 }), ["美股", "重大"]);
  assert.deepEqual(flattenSignalTags({ targets: ["油价"], bias: "路径未定", urgency: "重大" }, { category: "地缘", importance: 5 }), ["油价", "重大"]);
  assert.deepEqual(flattenSignalTags({ targets: ["日元"], bias: "利空", urgency: "背景约束" }, { category: "日本", importance: 4 }), ["日元", "利空"]);
  assert.deepEqual(flattenSignalTags({ targets: ["AI半导体", "汇率"], bias: "利好", urgency: "今晚盯" }, { category: "科技", importance: 4 }), ["芯片", "利好", "今晚盯"]);
  assert.deepEqual(flattenSignalTags({ targets: ["宏观"], bias: "利好" }, { category: "宏观", importance: 5 }), ["利好"]);
  assert.deepEqual(flattenSignalTags({ targets: ["美股"], bias: "偏多" }, { category: "AI热点", importance: 5 }), []);
  assert.ok(summary.health.todayPlan?.weekday);
  assert.ok(Array.isArray(summary.health.staleMuscles));
  assert.deepEqual(summary.projectManagement.relationIndex.edges, []);
  assert.ok(summary.projectManagement.currentTodos.every((task) => task.details.length === 0));
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 100 * 1024);
  assert.equal(JSON.stringify(summary).includes("snapshots"), false);
});

test("section endpoints preserve existing data shapes and reject unknown sections", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const [health, languages, library, markets] = await Promise.all([
    scanWorkbenchSection(root, "health"),
    scanWorkbenchSection(root, "languages"),
    scanWorkbenchSection(root, "library"),
    scanWorkbenchSection(root, "markets"),
  ]);
  assert.equal(health.data.weight, "75.4 kg");
  assert.ok(Array.isArray(health.data.mind.recentAssessment?.entries));
  assert.equal(health.data.life.recentAssessment?.weeklyMindSnapshots, undefined);
  assert.equal(languages.data.grammar[0].groups[0].points[1].title, "〜なら");
  assert.equal(library.data.items.some((item) => item.title === "门阀|士族史"), true);
  assert.equal(markets.data.events[0].title, "算力开支仍高");
  await assert.rejects(() => scanWorkbenchSection(root, "assets"), /未知工作台分区/);
});

test("trimAppleHealthForSection keeps recent window only", () => {
  const trimmed = trimAppleHealthForSection({
    recordCount: 9,
    daily: [
      { date: "2026-05-01", steps: 1 },
      { date: "2026-07-20", steps: 2 },
      { date: "2026-08-01", steps: 3 },
    ],
    body: [
      { day: "2026-05-01", metric: "weightKg", value: 80 },
      { day: "2026-07-28", metric: "weightKg", value: 76 },
    ],
    workouts: [
      { day: "2026-04-01", type: "步行" },
      { day: "2026-07-30", type: "力量训练" },
    ],
  }, 60, new Date("2026-08-02T03:00:00Z"));
  assert.deepEqual(trimmed.daily.map((item) => item.date), ["2026-07-20", "2026-08-01"]);
  assert.deepEqual(trimmed.body.map((item) => item.day), ["2026-07-28"]);
  assert.deepEqual(trimmed.workouts.map((item) => item.day), ["2026-07-30"]);
});

test("languages section keeps only grammar progress metadata needed before detail fetch", () => {
  const trimmed = trimLanguagesForSection({
    grammar: [],
    languageReactor: null,
    exploration: {
      grammarDetail: {
        N2: { groups: [{ name: "large group", points: [{ id: "n2-001", lv: 2, correctTotal: 4, explanation: "large detail" }] }] },
      },
    },
  });
  assert.deepEqual(trimmed.exploration.grammarDetail.N2, {
    groups: [{ points: [{ id: "n2-001", lv: 2, correctTotal: 4 }] }],
  });
});

test("summary projection never mutates or leaks the full snapshot", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await scanVault(root);
  const before = JSON.stringify(snapshot);
  const summary = summarizeWorkbench(snapshot);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal("items" in summary.library, false);
  assert.equal("events" in summary.market, false);
  assert.equal("mind" in summary.health, false);
  assert.equal(Object.keys(summary.health.life).length, 1);
  assert.ok(summary.projectManagement.projects.every((project) => (project.management?.doing.length || 0) <= 3));
  assert.ok(summary.projectManagement.projects.every((project) => (project.management?.next.length || 0) <= 3));
});

test("market brief rejects non-HTTPS links and degrades cleanly", () => {
  const unsafe = parseMarketBrief(`<!-- INFANS_MARKET_BRIEF_JSON_START -->\n\`\`\`json\n{"status":"active","events":[{"title":"测试","sources":[{"title":"坏链接","url":"javascript:alert(1)"}]}],"calendar":[{"date":"2026-09-01","title":"未确认日期","importance":5,"featured":true,"sourceUrl":"https://example.com/unconfirmed"},{"date":"待定","title":"日期不具体","importance":5,"dateConfirmed":true,"featured":true,"sourceUrl":"https://example.com/tbd"},{"date":"2026-09-03","title":"非重大事件","importance":4,"dateConfirmed":true,"featured":true,"sourceUrl":"https://example.com/not-major"}]}\n\`\`\`\n<!-- INFANS_MARKET_BRIEF_JSON_END -->`);
  assert.equal(unsafe.events[0].sources.length, 0);
  assert.equal(unsafe.calendar[0].dateConfirmed, undefined);
  assert.equal(unsafe.calendar[0].featured, undefined);
  assert.equal(unsafe.calendar[1].dateConfirmed, undefined);
  assert.equal(unsafe.calendar[1].featured, undefined);
  assert.equal(unsafe.calendar[2].dateConfirmed, true);
  assert.equal(unsafe.calendar[2].featured, undefined);
  assert.equal(parseMarketBrief("# 没有结构化数据").status, "unavailable");
});

test("market brief keeps this month and next month calendar dates", () => {
  const calendar = [
    ...Array.from({ length: 6 }, (_, index) => ({
      date: `2026-09-${String(index + 4).padStart(2, "0")}`,
      title: `九月事件${index + 1}`,
      importance: 5,
      dateConfirmed: true,
      sourceUrl: "https://example.com/sep",
    })),
    ...Array.from({ length: 6 }, (_, index) => ({
      date: `2026-10-${String(index + 2).padStart(2, "0")}`,
      title: `十月事件${index + 1}`,
      importance: 5,
      dateConfirmed: true,
      featured: index === 5,
      sourceUrl: "https://example.com/oct",
    })),
  ];
  const parsed = parseMarketBrief(`<!-- INFANS_MARKET_BRIEF_JSON_START -->\n\`\`\`json\n${JSON.stringify({ status: "quiet", events: [], calendar, note: "" })}\n\`\`\`\n<!-- INFANS_MARKET_BRIEF_JSON_END -->`);
  assert.equal(parsed.calendar.length, 12);
  assert.equal(parsed.calendar[0].date, "2026-09-04");
  assert.equal(parsed.calendar.at(-1)?.date, "2026-10-07");
  assert.equal(parsed.calendar.at(-1)?.featured, true);
});

test("market event topic parser accepts marked JSON and rejects unsafe or incomplete documents", () => {
  const [topic] = parseMarketEventTopicDocument(`<!-- INFANS_MARKET_EVENT_TOPIC_JSON_START -->\n\`\`\`json\n{"schemaVersion":1,"id":"fed-test","title":"政策专题","eventDate":"2026-09-01","status":"preview","latestConclusion":"等待公布","missingEvidence":[],"nodes":[{"phase":"preview","status":"current","conclusion":"先核验","sources":[{"title":"官方","url":"https://example.com/fed"},{"title":"坏链接","url":"http://example.com"}]}]}\n\`\`\`\n<!-- INFANS_MARKET_EVENT_TOPIC_JSON_END -->`, "topic.md", "2026-08-14");
  assert.equal(topic.id, "fed-test");
  assert.equal(topic.sourcePath, "topic.md");
  assert.equal(topic.nodes[0].sources.length, 1);
  assert.match(topic.closeRule, /历史永久保留/);
  assert.deepEqual(parseMarketEventTopicDocument(`{"id":"missing-fields"}`), []);
});

test("market event topic parser reads Cursor one-event Markdown without changing its source", () => {
  const markdown = `# 美国 7 月 CPI\n\n> **沙盘演练样本**\n\n## 最新状态\n\n- **当前状态**：暂定结案\n- **一句话**：结果符合调查，后续归因仍混杂。\n- **总归因**：混杂无法分离\n\n## 事件元数据\n\n| 项 | 内容 |\n|---|---|\n| 事件编号 | \`2026-08-12-US-CPI\` |\n| 发生时间 | 2026-08-12 08:30 美东 |\n| 官方入口 | [BLS](https://example.com/cpi) |\n\n## 1. 事前预览\n\n- **节点**：\`preview\`\n- **截止**：2026-08-12 08:29 美东\n- **归因**：仅观察\n\n### 官方事实\n\n官方已确认发布时间。\n\n### 待验证\n\n- 调查截止时间。\n\n## 2. 暂定结案复盘\n\n- **节点**：\`review\`\n- **截止**：2026-08-14 20:30 日本时间\n- **专题状态**：暂定结案\n\n### 官方事实\n\n结果已经核验。\n\n### 待验证 / 下次应补\n\n1. D+3 至 D+5。\n2. 仓位类一手材料。`;
  const [topic] = parseMarketEventTopicDocument(markdown, "重大事件专题/cpi.md", "2026-08-14T20:30:00+09:00");
  assert.equal(topic.id, "2026-08-12-US-CPI");
  assert.equal(topic.status, "tracking");
  assert.equal(topic.sourceStatus, "暂定结案");
  assert.equal(topic.sample, true);
  assert.equal(topic.officialUrl, "https://example.com/cpi");
  assert.equal(topic.nodes.at(-1).phase, "closed");
  assert.equal(topic.nodes[0].evidenceBuckets[0].label, "官方事实");
  assert.deepEqual(topic.missingEvidence, ["D+3 至 D+5。", "仓位类一手材料。"]);
});

test("market event topic parser keeps completed tracking and skipped follow-up nodes visible", () => {
  const markdown = `# 美国 7 月 CPI

## 最新状态

- **当前状态**：已结案
- **一句话**：口述复盘完成，后续不再追补。

## 事件元数据

| 项 | 内容 |
|---|---|
| 事件编号 | \`2026-08-12-US-CPI\` |
| 发生时间 | 2026-08-12 08:30 美东 |

## 1. D+2 跟踪

- **节点**：\`tracking\`（本节点只覆盖到 D+2 截稿）
- **截止**：2026-08-14 20:30 日本时间
- **归因**：不再归因

### 官方事实

没有新的 CPI 修订。

## 2. 已结案复盘

- **节点**：\`review\`
- **截止**：2026-08-22
- **专题状态**：已结案

### 官方事实

口述复盘已经完成。

## 3. D+3 至 D+5（经本人复盘决定不再追补）

### D+3 · 2026-08-15

- 截止（asOf）：未补
- 归因：不再归因；缺少带截点原件，不追加判断
- 暂不判断缺项：跨市场带截点数据未补
- 结案处理：经本人决定不再追补

### D+5 · 2026-08-17

- 截止（asOf）：未补
- 归因：不再归因；缺少带截点原件，不追加判断
- 暂不判断缺项：跨市场带截点数据未补
- 结案处理：专题已结案，没有伪造数据

## 本人决策评级

- **决策评级**：S
- **评级评语**：逻辑、风控与行动一致；若量化阈值更清楚，才有机会到 SSS。
- **评级时间**：2026-08-27`;
  const [topic] = parseMarketEventTopicDocument(markdown, "重大事件专题/cpi.md", "2026-08-22");
  assert.deepEqual(topic.nodes.map((node) => node.phase), ["tracking", "closed", "d3", "d5"]);
  assert.equal(topic.nodes.find((node) => node.phase === "tracking")?.status, "recorded");
  assert.equal(topic.nodes.find((node) => node.phase === "d3")?.status, "recorded");
  assert.equal(topic.nodes.find((node) => node.phase === "d3")?.observedAt, "未补");
  assert.match(topic.nodes.find((node) => node.phase === "d5")?.conclusion ?? "", /专题已结案/);
  assert.equal(topic.decisionGrade, "S");
  assert.match(topic.decisionReview, /量化阈值/);
  assert.equal(topic.decisionReviewedAt, "2026-08-27");
});

test("market event topic parser rejects decision grades before closure", () => {
  const [topic] = parseMarketEventTopicDocument(JSON.stringify({
    schemaVersion: 1,
    id: "active-cpi",
    title: "尚未结案的 CPI",
    eventDate: "2026-09-11",
    status: "tracking",
    latestConclusion: "继续观察。",
    decisionGrade: "SSS",
    decisionReview: "不应提前显示。",
  }), "重大事件专题/active-cpi.md", "2026-09-11");
  assert.equal(topic.decisionGrade, undefined);
  assert.equal(topic.decisionReview, undefined);
});

test("reads archived market briefs by date and keeps latest as current", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const latest = await readMarketBriefByDate(root, "2026-08-01");
  assert.equal(latest.latest, true);
  assert.equal(latest.events[0].title, "算力开支仍高");
  assert.equal(latest.events[0].lane, "focus");
  assert.equal(latest.events[1].title, "政策决定");
  const archived = await readMarketBriefByDate(root, "2026-07-31");
  assert.equal(archived.latest, false);
  assert.equal(archived.status, "quiet");
  assert.equal(archived.headline, "安静日");
  assert.equal(archived.history.length, 2);
  await assert.rejects(() => readMarketBriefByDate(root, "2026-01-01"), /没有该日简报归档/);
});

test("serves a writing document by generated id with full Markdown", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await scanVault(root);
  const item = snapshot.library.items.find((entry) => entry.kind === "writing");
  const document = await readWritingById(root, item.id);
  assert.equal(document.title, "完整日期文章");
  assert.equal(document.date, "2026-07-30");
  assert.equal(document.markdown.includes("这是完整正文。"), true);
  assert.equal(document.headings.some((heading) => heading.text === "第一章"), true);
});

test("searches full writing bodies and public project overviews", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bodyResults = await searchVault(root, "完整正文");
  assert.equal(bodyResults[0].title, "完整日期文章");
  assert.equal(bodyResults[0].description.includes("完整正文"), true);
  assert.equal(bodyResults[0].sourcePath, "60_艺术馆藏/写作/随笔/完整日期文章.md");
  assert.equal(bodyResults[0].route.includes("kind=writing"), true);
  assert.equal(bodyResults[0].route.includes(`open=${bodyResults[0].id}`), true);
  const projectResults = await searchVault(root, "换土最短闭环");
  assert.equal(projectResults.some((result) => result.title === "小秘书" && result.sourcePath === SOURCES.flagship), true);
});

test("health conversion and Japanese diagnostics keep evidence boundaries", () => {
  const health = parseHealth(
    `# 三维记录\n## 围度与体重\n| 项目 | 2024-03-28 | 无日期 |\n|---|---:|---:|\n| 体重（斤） | 153 | 155 |\n| 腰围 | 87 | 86 |`,
    `## 2026-07-22（周三）｜上肢\n| 动作 | 实际完成 | 最重一组 | 备注 |\n|---|---|---|---|\n| 杠铃卧推 | 60kg × 12次 2组 | **60kg × 12次 2组** | 热身 |\n| 引体向上 | 自重 × 8次 3组 | **自重 × 8次 3组** | |`,
  );
  assert.equal(health.measurements[0].weightKg, 76.5);
  assert.equal(health.measurements.length, 1);
  assert.equal(health.strength.find((item) => item.label === "引体训练容量")?.value, "自重 × 8次 3组");
  assert.equal(health.strength.find((item) => item.label === "杠铃卧推")?.category, "推举");
  assert.equal(health.strength.find((item) => item.label === "杠铃卧推")?.value, "60kg × 12次 2组");
  assert.equal(health.undated.length, 0);
  assert.equal(health.sessions[0]?.exercises?.[0]?.rpe ?? null, null);
  const japanese = parseJapanese(`# 当前状态\n## 词汇线（Anki）\n| 层级 | 总数 | 已学 | 剩余 | 完成度 | 状态 |\n|---|---:|---:|---:|---:|---|\n| N2 高频 | 200 | 40 | 160 | 20% | 进行中 |`, "");
  assert.deepEqual(japanese.levels[0], { name: "N2 高频", total: 200, learned: 40, status: "进行中" });
  assert.equal(japanese.note.includes("不代替文法"), true);
});

test("S11 RPE column and note forms feed intensity; missing RPE invents nothing", () => {
  assert.deepEqual(parseRpeRirToken("8"), { rpe: 8, rir: null });
  assert.deepEqual(parseRpeRirToken("RPE8 RIR2"), { rpe: 8, rir: 2 });
  assert.deepEqual(parseRpeRirToken("—"), { rpe: null, rir: null });

  const fromCol = parseTrainingExerciseRow(["哑铃卧推", "20kg ×15", "20kg × 15次", "8", "末组掉次"]);
  assert.equal(fromCol.rpe, 8);
  assert.equal(fromCol.rir, null);

  const fromNote = parseTrainingExerciseRow(["深蹲", "60kg", "60kg × 8次", "RPE 7.5 · 腰酸"]);
  assert.equal(fromNote.rpe, 7.5);

  const empty = parseTrainingExerciseRow(["飞鸟", "6kg", "6kg × 25次", "—", ""]);
  assert.equal(empty.rpe, null);

  const health = parseHealth(
    `# 三维记录\n## 围度与体重\n| 项目 | 2026-08-03 |\n|---|---:|\n| 体重（斤） | 150 |`,
    `## 2026-08-03（周一）｜上肢
| 动作 | 实际完成 | 最重一组 | RPE | 备注 |
|---|---|---|---|---|
| 哑铃卧推 | 20kg ×15 | **20kg × 15次** | 8 | 主项 |
| 侧平举 | 10kg ×15 | **10kg × 15次** | — | 未记 RPE |

## 2026-07-30（周三）｜旧四列表
| 动作 | 实际完成 | 最重一组 | 备注 |
|---|---|---|---|
| 上斜卧推 | 39kg ×12 | **39kg × 12次** | RPE8 |
`,
  );
  const bench = health.sessions.find((s) => s.date === "2026-08-03")?.exercises.find((e) => e.name.includes("哑铃卧推"));
  const fly = health.sessions.find((s) => s.date === "2026-08-03")?.exercises.find((e) => e.name.includes("侧平举"));
  const incline = health.sessions.find((s) => s.date === "2026-07-30")?.exercises.find((e) => e.name.includes("上斜"));
  assert.equal(bench?.rpe, 8);
  assert.equal(fly?.rpe ?? null, null);
  assert.equal(incline?.rpe, 8);

  const intensity = deriveSessionIntensity(health.sessions);
  assert.equal(intensity.sampleCount, 2);
  assert.equal(intensity.latest?.rpe, 8);
  assert.match(intensity.latest?.basis || "", /RPE 8/);
  assert.equal(deriveSessionIntensity([{ date: "2026-08-01", exercises: [{ name: "卧推", topSet: "60kg", rpe: null }] }]).sampleCount, 0);
});

test("missing one source degrades to a warning instead of failing the snapshot", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.rm(path.join(root, SOURCES.training));
  const snapshot = await scanVault(root);
  assert.equal(snapshot.health.latestTraining, "还没有训练记录");
  assert.equal(snapshot.warnings.some((warning) => warning.source === SOURCES.training), true);
  assert.equal(snapshot.todo.today.length, 2);
});

test("snapshot never reads common sensitive or plugin paths", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".obsidian/plugins/test"), { recursive: true });
  await fs.writeFile(path.join(root, ".obsidian/plugins/test/data.json"), '{"cookies":"SECRET_COOKIE"}');
  await fs.mkdir(path.join(root, "20_个人档案/账号信息"), { recursive: true });
  await fs.writeFile(path.join(root, "20_个人档案/账号信息/密码.md"), "SECRET_PASSWORD");
  const snapshot = await scanVault(root);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("SECRET_COOKIE"), false);
  assert.equal(serialized.includes("SECRET_PASSWORD"), false);
});

test("parses weekday training plan and stale muscle reminders", () => {
  const sample = `## 周安排\n| 周几 | 内容 |\n|---|---|\n| 周一 | **上肢日 A**（胸主导·平板） |\n| 周二 | **下肢日 A** |\n| 周三 | 游泳（中低强度）+ 举铁休息 |\n| 周四 | **上肢日 B** |\n| 周五 | **下肢日 B** |\n| 周六 | 游泳 |\n| 周日 | 完全休息 |

## 上肢日 B — 胸主导（上斜）+ 背

| 示意 | 重量 × 组 × 次 | 备注 |
| :---: | :--- | :--- |
| x | **约 39 kg** | [详解](../动作图鉴.md#上斜杠铃卧推) · 主项 |
| x | **20 kg** | [详解](../动作图鉴.md#平板哑铃卧推) · 胸中 |
| x | **记档位** | [详解](../动作图鉴.md#高位下拉) · 可换引体 |
`;
  const monday = parseTodayTrainingPlan(sample, new Date("2026-08-03T12:00:00+09:00"));
  assert.equal(monday.weekday, "周一");
  assert.equal(monday.title, "上肢日 A");
  assert.deepEqual(monday.exercises, []);
  const thursday = parseTodayTrainingPlan(sample, new Date("2026-08-06T12:00:00+09:00"));
  assert.equal(thursday.title, "上肢日 B");
  assert.deepEqual(thursday.exercises, ["上斜杠铃卧推", "平板哑铃卧推", "高位下拉"]);
  assert.deepEqual(parseSessionExercises(sample, "上肢日 B"), ["上斜杠铃卧推", "平板哑铃卧推", "高位下拉"]);
  const week = parseWeekTrainingPlan(sample, new Date("2026-08-06T12:00:00+09:00"));
  assert.equal(week.length, 7);
  assert.equal(week[3]?.short, "上肢B");
  assert.equal(week[3]?.isToday, true);
  assert.equal(week[3]?.kind, "lift");
  assert.deepEqual(week[3]?.exercises, ["上斜杠铃卧推", "平板哑铃卧推", "高位下拉"]);
  assert.equal(week[2]?.kind, "swim");
  assert.equal(week[6]?.kind, "rest");
  const stale = staleMusclesFromSessions([
    { date: "2026-06-11", title: "上肢", status: "记录完整", exercises: [{ name: "杠铃卧推", topSet: "60" }, { name: "引体向上", topSet: "8" }] },
    { date: "2026-07-22", title: "腿", status: "记录完整", exercises: [{ name: "深蹲", topSet: "60" }] },
  ], "2026-08-01");
  assert.ok(stale.some((item) => item.label === "胸" && item.status === "overdue"));
  assert.ok(stale.some((item) => item.label === "股四"));

  const coreFresh = staleMusclesFromSessions([
    { date: "2026-08-04", title: "下肢 + 核心", status: "记录完整", exercises: [{ name: "悬垂举腿", topSet: "自重 × 25次" }, { name: "保加利亚分腿蹲", topSet: "12kg × 15次/侧" }] },
  ], "2026-08-05");
  assert.equal(coreFresh.some((item) => item.label === "核心"), false, "悬垂举腿应计入核心，次日不应进久未练");
});

test("buildCoachHints covers drop-set, overdue, and empty degradation", () => {
  const parsed = parseTopSetLoad("12kg ×15→12→10次/侧");
  assert.equal(parsed?.weightKg, 12);
  assert.deepEqual(parsed?.reps.slice(0, 3), [15, 12, 10]);

  const dropHints = buildCoachHints({
    sessions: [
      { date: "2026-08-04", title: "下肢", status: "记录完整", exercises: [{ name: "保加利亚分腿蹲", topSet: "12kg ×15→12→10次/侧" }] },
    ],
    staleMuscles: [],
    todayPlan: { weekday: "周二", title: "下肢日 A", detail: "腿" },
    today: "2026-08-05",
  });
  assert.equal(dropHints[0]?.tone, "info");
  assert.equal(dropHints[0]?.text.includes("下肢日 A"), true);
  assert.ok(dropHints.some((hint) => hint.text.includes("保加利亚") && hint.text.includes("12 kg")));

  const overdueHints = buildCoachHints({
    sessions: [],
    staleMuscles: [{ id: "chest", label: "胸", status: "overdue", daysSince: 14, lastDate: "2026-07-22" }],
    todayPlan: null,
    today: "2026-08-05",
  });
  assert.ok(overdueHints.some((hint) => hint.tone === "warn" && hint.text.includes("胸") && hint.basis.includes("2026-07-22")));

  assert.deepEqual(buildCoachHints({ sessions: [], staleMuscles: [], todayPlan: null }), []);
});

test("parseSetVolume and deriveTrainingVolume cover load / bodyweight / skip cases", () => {
  const normal = parseSetVolume("60kg × 12次 2组");
  assert.equal(normal?.kind, "loaded");
  assert.equal(normal?.volumeKg, 60 * 12 * 2);

  const smith = parseSetVolume("39kg(史密斯) × 12次 4组");
  assert.equal(smith?.kind, "loaded");
  assert.equal(smith?.weightKg, 39);
  assert.equal(smith?.volumeKg, 39 * 12 * 4);

  const single = parseSetVolume("16kg单手 × 10次 3组");
  assert.equal(single?.kind, "loaded");
  assert.equal(single?.weightKg, 16);
  assert.equal(single?.unilateral, true);
  assert.equal(single?.volumeKg, 16 * 10 * 3);

  const bodyweight = parseSetVolume("自重 × 8次 3组");
  assert.equal(bodyweight?.kind, "bodyweight");
  assert.equal(bodyweight?.reps, 24);

  const oral = parseSetVolume("引体共约 20 个");
  assert.equal(oral?.kind, "skip");
  assert.equal(oral?.reason, "oral-total-no-sets");

  const volume = deriveTrainingVolume([
    {
      date: "2026-08-04",
      title: "混合",
      status: "记录完整",
      exercises: [
        { name: "杠铃卧推", topSet: "60kg × 12次 2组" },
        { name: "上斜卧推", topSet: "39kg(史密斯) × 12次 4组" },
        { name: "单臂哑铃划船", topSet: "16kg单手 × 10次 3组" },
        { name: "引体向上", topSet: "自重 × 8次 3组" },
        { name: "引体向上", topSet: "引体共约 20 个" },
      ],
    },
  ]);
  assert.equal(volume.weekly.length, 1);
  assert.equal(volume.weekly[0].muscles.chest, 60 * 12 * 2 + 39 * 12 * 4);
  assert.equal(volume.weekly[0].muscles.back, 16 * 10 * 3);
  assert.equal(volume.weekly[0].bodyweightReps.back, 24);
  assert.equal(volume.weekly[0].totalTonnageKg, 60 * 12 * 2 + 39 * 12 * 4 + 16 * 10 * 3);
  const pullSeries = volume.topSetSeries.find((row) => row.name === "引体向上");
  assert.ok(pullSeries);
  assert.equal(pullSeries.points.length, 2);
  assert.equal(pullSeries.points[0].bodyweight, true);
});

test("parseMindSignals keeps empty days empty and does not invent hits", () => {
  const result = parseMindSignals([
    { date: "2026-08-04", text: "" },
    { date: "2026-08-05", text: "今天天气一般，吃了午饭，晚上早点睡。" },
    { date: "2026-08-06", text: "睡前还在想工作，下午去散步了。" },
  ]);
  // 无日志 → 无采样
  assert.equal(result.days[0].sampled, false);
  assert.equal(result.days[0].hits, null);
  // 纯流水无命中 → 同样无采样，不补零
  assert.equal(result.days[1].sampled, false);
  assert.equal(result.days[1].hits, null);
  assert.equal(result.days[1].hitTotal, 0);
  // 有命中才采样
  assert.equal(result.days[2].sampled, true);
  assert.ok(result.days[2].hitTotal >= 2);
  assert.ok(result.recovery.detachmentFail >= 1);
  assert.ok(result.recovery.relaxation >= 1);
  assert.equal(result.sampleDays, 1);
  assert.equal(result.hitDays, 1);
  // 不回传正文；无命中日不挂全 0 hits
  assert.equal(JSON.stringify(result).includes("睡前还在想"), false);
  assert.equal(result.days.filter((day) => day.sampled && day.hitTotal === 0).length, 0);
});

test("deriveRecoveryPercents keeps missing evidence unknown and averages each dimension independently", () => {
  const result = deriveRecoveryPercents([
    { date: "2026-08-04", text: "" },
    // 无命中：四项都未知，不进入任何分母
    { date: "2026-08-05", text: "今天天气一般，吃了午饭，晚上早点睡。" },
    // 收工还想着 1 → 50；放松 1 → 50
    { date: "2026-08-06", text: "睡前还在想工作，下午去散步了。" },
    // 日程被打乱 1 → 50；搞定难事 1 → 50
    { date: "2026-08-07", text: "计划全乱了，但第一次做成了。" },
  ]);
  assert.equal(result.scoredDays, 2);
  assert.deepEqual(result.sampleDays, {
    detachmentFail: 1,
    controlLoss: 1,
    mastery: 1,
    relaxation: 1,
  });
  assert.deepEqual(result.percents, {
    detachmentFail: 50,
    controlLoss: 50,
    mastery: 50,
    relaxation: 50,
  });
  // 过凌晨 2 点启发式：无「还想着」词也可扣到 50
  const late = deriveRecoveryPercents([{ date: "2026-08-08", text: "通宵改到凌晨 3 点才睡。" }]);
  assert.equal(late.percents.detachmentFail, 50);
  assert.equal(late.percents.relaxation, null);
  assert.deepEqual(late.sampleDays, {
    detachmentFail: 1,
    controlLoss: 0,
    mastery: 0,
    relaxation: 0,
  });
});

test("parseDiaryRecoveryLine and deriveRecoveryPercents prefer explicit day scores", () => {
  const line = "恢复：收工就能放下 50 · 日程未被打乱 100 · 解决过难事 0 · 有过真放松 50";
  assert.deepEqual(parseDiaryRecoveryLine(line), {
    detachmentFail: 50,
    controlLoss: 100,
    mastery: 0,
    relaxation: 50,
  });
  // 明示行优先于词表（正文有「睡前还在想」也不改 50）
  const preferred = deriveRecoveryPercents([
    { date: "2026-08-07", text: `睡前还在想工作还停不下来\n${line}` },
  ]);
  assert.equal(preferred.scoredDays, 1);
  assert.equal(preferred.percents.detachmentFail, 50);
  assert.equal(preferred.percents.controlLoss, 100);
  assert.equal(preferred.percents.mastery, 0);
  assert.equal(preferred.percents.relaxation, 50);
  assert.deepEqual(preferred.sampleDays, {
    detachmentFail: 1,
    controlLoss: 1,
    mastery: 1,
    relaxation: 1,
  });
});

test("parseDiaryRecoveryLine supports per-dimension unknown without converting it to zero", () => {
  const line = "恢复：收工就能放下 未知 · 日程未被打乱 100 · 解决过难事 100 · 有过真放松 未知";
  assert.deepEqual(parseDiaryRecoveryLine(line), {
    detachmentFail: null,
    controlLoss: 100,
    mastery: 100,
    relaxation: null,
  });
  const result = deriveRecoveryPercents([{ date: "2026-08-23", text: line }]);
  assert.equal(result.scoredDays, 1);
  assert.deepEqual(result.sampleDays, {
    detachmentFail: 0,
    controlLoss: 1,
    mastery: 1,
    relaxation: 0,
  });
  assert.deepEqual(result.percents, {
    detachmentFail: null,
    controlLoss: 100,
    mastery: 100,
    relaxation: null,
  });

  assert.deepEqual(
    parseDiaryRecoveryLine("恢复：收工后能放下 50 · 休息时间由自己 100 · 有过真放松 未知"),
    { detachmentFail: 50, controlLoss: 100, mastery: null, relaxation: null },
  );
});

test("aggregateLineEnergyCandidates needs signal+line co-occurrence", () => {
  const diaries = [
    { date: "2026-08-04", text: "今天只写了阳台种植计划，终于跑通一关，有意思。" },
    { date: "2026-08-05", text: "刷了会儿抖音，不得不回几条消息，停不下来。" },
    { date: "2026-08-06", text: "日语学习做了听力，但没有任何传感词。" },
  ];
  const signals = parseMindSignals(diaries);
  const mainlines = [
    { item: "阳台种植计划", energy: null, disposition: null, prefix: "", category: "", reason: "", lastActionDays: null },
    { item: "抖音", energy: "耗能", disposition: "少投入", prefix: "", category: "", reason: "", lastActionDays: null },
    { item: "日语学习", energy: null, disposition: null, prefix: "", category: "", reason: "", lastActionDays: null },
  ];
  const out = aggregateLineEnergyCandidates(mainlines, signals, diaries);
  const game = out.find((row) => row.item === "阳台种植计划");
  const douyin = out.find((row) => row.item === "抖音");
  const jp = out.find((row) => row.item === "日语学习");
  assert.equal(game.energyCandidate, "回能");
  assert.deepEqual(game.energyEvidenceDates, ["2026-08-04"]);
  assert.equal(douyin.energyCandidate, "耗能");
  assert.ok(douyin.energyEvidenceDates.includes("2026-08-05"));
  // 只有线名、无传感命中 → 不出候选
  assert.equal(jp.energyCandidate, null);
  assert.deepEqual(jp.energyEvidenceDates, []);
  assert.equal(JSON.stringify(out).includes("终于跑通"), false);
});

test("aggregateLineEnergyCandidates clears dates when recharge equals drain", () => {
  const diaries = [
    { date: "2026-08-04", text: "日语学习有意思，但不得不继续刷题。" },
  ];
  const signals = parseMindSignals(diaries);
  // 有意思 → autonomous；不得不 → controlled；持平
  assert.equal(signals.days[0]?.sampled, true);
  assert.ok((signals.days[0]?.hits?.autonomousMotivation || 0) >= 1);
  assert.ok((signals.days[0]?.hits?.controlledMotivation || 0) >= 1);
  const out = aggregateLineEnergyCandidates(
    [{ item: "日语学习", energy: null, disposition: null, prefix: "", category: "", reason: "", lastActionDays: null }],
    signals,
    diaries,
  );
  assert.equal(out[0].energyCandidate, null);
  assert.deepEqual(out[0].energyEvidenceDates, []);
});

test("deriveProgressionAdvice follows training-plan increase and stall rules", () => {
  const increase = deriveProgressionAdvice([
    {
      date: "2026-08-04",
      title: "上肢",
      status: "记录完整",
      exercises: [{ name: "杠铃卧推", topSet: "60kg × 8次 4组" }],
    },
  ]);
  assert.ok(increase.some((item) => item.kind === "increase" && item.exercise === "杠铃卧推"));
  const hit = increase.find((item) => item.kind === "increase");
  assert.equal(hit?.toKg, 62.5);
  assert.ok(hit?.basis.includes("2026-08-04"));
  assert.ok(hit?.basis.includes("8"));

  const stall = deriveProgressionAdvice([
    {
      date: "2026-07-21",
      title: "上肢",
      status: "记录完整",
      exercises: [{ name: "杠铃卧推", topSet: "60kg × 7次 3组" }],
    },
    {
      date: "2026-07-28",
      title: "上肢",
      status: "记录完整",
      exercises: [{ name: "杠铃卧推", topSet: "60kg × 7次 3组" }],
    },
  ]);
  assert.ok(stall.some((item) => item.kind === "deload" && item.exercise === "杠铃卧推"));
  const deload = stall.find((item) => item.kind === "deload");
  assert.equal(deload?.toKg, 54);
  assert.ok(deload?.text.includes("建议减到约"));
  assert.ok(deload?.basis.includes("7 次"));
  // 掉组未填满次数上限 → 不给出加重
  const drop = deriveProgressionAdvice([
    {
      date: "2026-08-04",
      title: "下肢",
      status: "记录完整",
      exercises: [{ name: "保加利亚分腿蹲", topSet: "12kg ×15→12→10次/侧" }],
    },
  ]);
  assert.equal(drop.some((item) => item.kind === "increase"), false);
});

test("deriveMuscleBalance returns null ratios when sample is thin", () => {
  const thin = deriveMuscleBalance([
    {
      date: "2026-08-04",
      title: "上肢",
      status: "记录完整",
      exercises: [{ name: "杠铃卧推", topSet: "60kg × 8次 4组" }],
    },
  ]);
  assert.equal(thin.pushPullRatio, null);
  assert.equal(thin.upperLowerRatio, null);
  assert.ok(thin.pushPullBasis.includes("记录太少") || thin.pushPullBasis.includes("先不算比例"));

  const rich = deriveMuscleBalance([
    {
      date: "2026-07-21",
      title: "上肢",
      status: "记录完整",
      exercises: [
        { name: "杠铃卧推", topSet: "60kg × 8次 4组" },
        { name: "坐姿划船", topSet: "40kg × 10次 4组" },
      ],
    },
    {
      date: "2026-07-28",
      title: "混合",
      status: "记录完整",
      exercises: [
        { name: "杠铃卧推", topSet: "60kg × 8次 4组" },
        { name: "坐姿划船", topSet: "40kg × 10次 4组" },
        { name: "深蹲", topSet: "60kg × 8次 3组" },
      ],
    },
  ]);
  assert.equal(typeof rich.pushPullRatio, "number");
  assert.ok(rich.pushPullRatio > 0);
  assert.ok(rich.pushPullBasis.includes("推"));

  const plateau = deriveMuscleBalance([
    { date: "2026-07-14", title: "上肢", status: "记录完整", exercises: [{ name: "杠铃卧推", topSet: "60kg × 7次 3组" }] },
    { date: "2026-07-21", title: "上肢", status: "记录完整", exercises: [{ name: "杠铃卧推", topSet: "60kg × 7次 3组" }] },
    { date: "2026-07-28", title: "上肢", status: "记录完整", exercises: [{ name: "杠铃卧推", topSet: "60kg × 7次 3组" }] },
  ]);
  assert.ok(plateau.plateauCandidates.some((item) => item.exercise === "杠铃卧推"));
  assert.ok(plateau.plateauCandidates[0].text.includes("可能卡住了"));
  assert.equal(plateau.plateauCandidates[0].text.includes("已进入平台期"), false);
});

test("deriveRecoveryLoad requires training + detachment + poor sleep together", () => {
  const today = "2026-08-05";
  const heavySessions = [
    { date: "2026-07-30", title: "上肢", status: "ok", exercises: [] },
    { date: "2026-08-01", title: "下肢", status: "ok", exercises: [] },
    { date: "2026-08-03", title: "上肢", status: "ok", exercises: [] },
    { date: "2026-08-05", title: "下肢", status: "ok", exercises: [] },
  ];
  const detachmentDiaries = [
    { date: "2026-07-28", text: "一直在想项目，睡前还在想" },
    { date: "2026-07-30", text: "停不下来，刷到几点" },
    { date: "2026-08-02", text: "一直在想明天的事" },
    { date: "2026-08-04", text: "天气不错出门走了走" },
  ];
  const mindSignals = parseMindSignals(detachmentDiaries);
  const poorSleepDays = [
    { date: "2026-07-28", energy: 2, sleep: "差", trained: false },
    { date: "2026-07-30", energy: 2, sleep: "差", trained: true },
    { date: "2026-08-02", energy: 3, sleep: "一般", trained: false },
    { date: "2026-08-04", energy: 3, sleep: "好", trained: false },
  ];

  const allThree = deriveRecoveryLoad({
    sessions: heavySessions,
    mindSignals,
    mindDays: poorSleepDays,
    today,
  });
  assert.equal(allThree.suggestDeload, true);
  assert.ok(allThree.text?.includes("减量"));
  assert.ok(allThree.basis.includes("练了") || allThree.basis.includes("训练"));
  assert.ok(allThree.basis.includes("下班停不下来") || allThree.basis.includes("脱离"));
  assert.ok(allThree.basis.includes("睡"));
  assert.equal(allThree.factors.training.elevated, true);
  assert.equal(allThree.factors.detachment.elevated, true);
  assert.equal(allThree.factors.sleep.elevated, true);

  const noTraining = deriveRecoveryLoad({
    sessions: [{ date: "2026-08-05", title: "上肢", status: "ok", exercises: [] }],
    mindSignals,
    mindDays: poorSleepDays,
    today,
  });
  assert.equal(noTraining.suggestDeload, false);
  assert.equal(noTraining.text, null);
  assert.equal(noTraining.factors.training.elevated, false);

  const noDetach = deriveRecoveryLoad({
    sessions: heavySessions,
    mindSignals: parseMindSignals([
      { date: "2026-08-01", text: "愿意继续做，搞明白了不少" },
      { date: "2026-08-03", text: "散步听了会儿，发呆一会儿" },
    ]),
    mindDays: poorSleepDays,
    today,
  });
  assert.equal(noDetach.suggestDeload, false);
  assert.equal(noDetach.factors.detachment.elevated, false);

  const noSleepSample = deriveRecoveryLoad({
    sessions: heavySessions,
    mindSignals,
    mindDays: [
      { date: "2026-08-01", energy: 3, sleep: null, trained: true },
      { date: "2026-08-03", energy: null, sleep: null, trained: true },
    ],
    today,
  });
  assert.equal(noSleepSample.suggestDeload, false);
  assert.equal(noSleepSample.factors.sleep.elevated, null);
  assert.ok(noSleepSample.basis.includes("没法看") || noSleepSample.basis.includes("没记睡眠"));

  const sleepOk = deriveRecoveryLoad({
    sessions: heavySessions,
    mindSignals,
    mindDays: [
      { date: "2026-07-28", energy: 3, sleep: "好", trained: false },
      { date: "2026-07-30", energy: 3, sleep: "一般", trained: true },
      { date: "2026-08-02", energy: 4, sleep: "好", trained: false },
    ],
    today,
  });
  assert.equal(sleepOk.suggestDeload, false);
  assert.equal(sleepOk.factors.sleep.elevated, false);
});

test("deriveMesocyclePosition from stage start date", () => {
  assert.equal(parseStageStartDate("阶段起始日：2026-07-22（当前 mesocycle）"), "2026-07-22");
  assert.equal(parseStageStartDate("无日期"), null);

  const early = deriveMesocyclePosition({ stageStart: "2026-07-22", today: "2026-08-05" });
  assert.equal(early.weekIndex, 3);
  assert.equal(early.suggestDeloadDiscuss, false);
  assert.ok(early.text.includes("第 3 周"));
  assert.ok(early.basis.includes("2026-07-22"));

  const due = deriveMesocyclePosition({ stageStart: "2026-07-22", today: "2026-08-19" });
  assert.equal(due.weekIndex, 5);
  assert.equal(due.suggestDeloadDiscuss, true);
  assert.ok(due.text.includes("减量"));

  const missing = deriveMesocyclePosition({ stageStart: null, today: "2026-08-05" });
  assert.equal(missing.weekIndex, null);
  assert.equal(missing.suggestDeloadDiscuss, false);
  assert.equal(missing.text, null);
});

test("parseDiaryWorkIntensity finds 工作强度 outside 快速记录 section", () => {
  const mind = parseDiaryWorkIntensity([
    { date: "2026-08-03", text: "## 工作台快速记录\n- **10:00** 工作强度 8/10（多线收工）" },
    { date: "2026-08-04", text: "## 工作台快速记录\n- **10:00** 今天腿累" },
    { date: "2026-08-05", text: "## 工作台快速记录\n- **10:00** 精力 3/5 · 睡眠 一般" },
    { date: "2026-08-06", text: "工作强度 10/10（满档）\n\n## 工作台快速记录\n只有旧精力 3/5 · 睡眠 一般" },
    { date: "2026-08-07", text: "工作强度 4/5（旧五级稿）" },
    { date: "2026-08-08", text: "工作强度 0/10（确认本人没干活；只有自动任务）" },
  ], [{ date: "2026-08-04", title: "腿", status: "ok", exercises: [] }], "2026-08-07");
  assert.equal(mind.days[0].workIntensity, 8);
  assert.equal(mind.days[1].workIntensity, null);
  assert.equal(mind.days[1].trained, true);
  assert.equal(mind.days[2].workIntensity, null, "旧精力行不映射为工作强度");
  assert.equal(mind.days[2].sleep, "一般");
  assert.equal(mind.days[3].workIntensity, 10, "小结里的工作强度也要认");
  assert.equal(mind.days[3].sleep, "一般");
  assert.equal(mind.days[4].workIntensity, 8, "旧 N/5 按 ×2 读成 10 级");
  assert.equal(mind.days[5].workIntensity, 0, "0 分要与缺记录区分");
  assert.equal(mind.sampleDays, 4);
});

test("parseDiaryWorkIntensity 保留训练黄点并结构化合并休息日", () => {
  const mind = parseDiaryWorkIntensity(
    [{ date: "2026-08-15", text: "工作强度 3/10" }],
    [{ date: "2026-08-15", title: "腿", status: "ok", exercises: [] }],
    "2026-08-15",
    { available: true, events: [] },
  );
  assert.equal(mind.days[0].trained, true);
  assert.equal(mind.days[0].restDay, true);
  assert.deepEqual(mind.days[0].restReasons, ["weekend"]);
});

test("parseLifeDesignLog and compass docs", () => {
  const compass = parseCompassDocs(
    `# 工作观\n## 一句话\n工作是修炼场。\n## 正文\n详细说明。`,
    `# 人生观\n## 一句话\n活得清楚。\n## 正文\n详细说明。`,
  );
  assert.equal(compass.filled, true);
  assert.equal(compass.workview.includes("修炼场"), true);
  assert.deepEqual(compass.workviewBody, ["详细说明。"]);
  assert.deepEqual(compass.lifeviewBody, ["详细说明。"]);
  assert.equal(parseCompassDocs("<!-- 待本人填写 -->", "<!-- 待本人填写 -->").filled, false);

  const life = parseLifeDesignLog(`## 2026-08

### 四格

| 格 | 油量 |
|---|---|
| 健康 | 55% |
| 工作 | 80% |
| 游戏 | 20% |
| 情感 | 35% |

- **最意外**：游戏太低
- **先加哪格**：游戏 · 每周一次无产出娱乐

### 在推进的事项

| 线 | 能量 | 处置 | 理由 |
|---|---|---|---|
| 阳台种植计划 | 回能 | 多投入 | 还在推进 |
| 抖音 | 耗能 | 少投入 | 空转 |
| 幽灵线 | 中性 | 保持 | 已不在表 |
`, [
    { item: "阳台种植计划", prefix: "游戏：", category: "月金 · 事业" },
    { item: "抖音", prefix: "抖音：", category: "月金 · 事业" },
  ], "2026-08-05");
  assert.equal(life.gauges[0].play, 20);
  assert.equal(life.gauges[0].surprise.includes("游戏"), true);
  assert.equal(life.mainlines.find((row) => row.item === "阳台种植计划")?.energy, "回能");
  assert.equal(life.mainlines.find((row) => row.item === "幽灵线")?.offMainline, true);
  assert.equal(life.coherence, null);
});

test("parseLifeDesignLog merges 公众号 name variants", () => {
  const life = parseLifeDesignLog(`## 2026-08

### 在推进的事项

| 线 | 能量 | 处置 | 理由 |
|---|---|---|---|
| 公众号《示例专栏》 | 耗能 | 停 | 尚未准备启动 |
`, [
    { item: "公众号", prefix: "公众号：", category: "月金 · 事业" },
  ], "2026-08-15");
  const publicLines = life.mainlines.filter((row) => /公众号/.test(row.item));
  assert.equal(publicLines.length, 1);
  assert.equal(publicLines[0].item, "公众号");
  assert.equal(publicLines[0].energy, "耗能");
  assert.equal(publicLines[0].offMainline, false);
});

test("parseCompassCoherence shows 说不通 edges without scores", () => {
  const coherence = parseCompassCoherence(`## 指南针一致性

| 边 | 判定 | 备注 |
|---|---|---|
| 工作观 ↔ 人生观 | 说得通 | 热情与淡泊可并存 |
| 工作观 ↔ 在推进的事项 | 说不通 | 公众号/抖音标停却仍占表 |
| 人生观 ↔ 在推进的事项 | 没想过 | |
`);
  assert.equal(coherence?.edges.length, 3);
  assert.equal(coherence?.edges.find((e) => e.id === "work_life")?.verdict, "说得通");
  assert.equal(coherence?.edges.find((e) => e.id === "work_lines")?.verdict, "说不通");
  assert.equal(coherence?.edges.find((e) => e.id === "life_lines")?.verdict, "没想过");
  assert.equal("score" in (coherence || {}), false);
  assert.equal("total" in (coherence || {}), false);
  assert.equal(parseCompassCoherence("## 2026-08\n\n### 四格\n"), null);

  const fromLog = parseLifeDesignLog(`## 指南针一致性

| 边 | 判定 | 备注 |
|---|---|---|
| 工作观 ↔ 人生观 | 说不通 | 试验边 |
| 工作观 ↔ 在推进的事项 | 没想过 | |
| 人生观 ↔ 在推进的事项 | 没想过 | |

## 2026-08

### 四格

| 格 | 油量 |
|---|---|
| 健康 | 90% |
| 工作 | 80% |
| 游戏 | 70% |
| 情感 | 35% |
`, [], "2026-08-05");
  assert.equal(fromLog.coherence?.edges.find((e) => e.id === "work_life")?.verdict, "说不通");
});

test("deriveStrengthBaselineTable takes personal best with category", () => {
  const baseline = deriveStrengthBaselineTable([
    {
      date: "2026-07-01",
      title: "上肢",
      exercises: [{ name: "杠铃卧推", topSet: "65 kg × 5" }],
    },
    {
      date: "2026-08-01",
      title: "上肢",
      exercises: [{ name: "杠铃卧推", topSet: "60 kg × 6" }, { name: "深蹲", topSet: "70 kg × 5" }],
    },
  ]);
  const bench = baseline.find((row) => row.name === "杠铃卧推");
  assert.equal(bench?.topSet, "65 kg × 5");
  assert.equal(bench?.date, "2026-07-01");
  assert.equal(bench?.category, "推举");
  assert.match(bench?.basis || "", /个人最佳/);
  const squat = baseline.find((row) => row.name === "深蹲");
  assert.equal(squat?.category, "下肢");
});

test("parseLifeDesignLog monthly self-assessment has no total score field", () => {
  const life = parseLifeDesignLog(`## 2026-08

### 四格

| 格 | 油量 |
|---|---|
| 健康 | 90% |
| 工作 | 80% |
| 游戏 | 70% |
| 情感 | 35% |

### 月度自评

#### 三需要

| 需要 | 满足 | 受挫 |
|---|---|---|
| 自主 | 高 | 低 |
| 胜任 | 中 | 中 |
| 联结 | 低 | 高 |

#### 动机质量

| 线 | 动机档 |
|---|---|
| 阳台种植计划 | 认同 |
`, [], "2026-08-05");
  assert.equal(life.monthlySelfAssessment?.month, "2026-08");
  assert.equal(life.monthlySelfAssessment?.needs.length, 3);
  assert.equal(life.monthlySelfAssessment?.motives[0]?.quality, "认同");
  assert.equal("total" in (life.monthlySelfAssessment || {}), false);
  assert.equal("score" in (life.monthlySelfAssessment || {}), false);
});

test("parseOdysseyPlan keeps three plans and null scores", () => {
  const odyssey = parseOdysseyPlan(`## 方案 A · 续走现状

> 一句话：日本语言学校 + 发行游戏

| 维度 | 分 | 备注 |
|---|---|---|
| 手头条件 | 7 | |
| 想不想干 | — | |
| 有没有把握 | 待填 | |
| 跟自己合不合 | 8 | 贴近人生观 |

## 方案 B · 若 A 不能做

> 一句话：（待填）

| 维度 | 分 | 备注 |
|---|---|---|
| 手头条件 | — | |
| 想不想干 | — | |
| 有没有把握 | — | |
| 跟自己合不合 | — | |

## 方案 C · 不计钱与舆论

> 一句话：（待填）

| 维度 | 分 | 备注 |
|---|---|---|
| 手头条件 | — | |
| 想不想干 | — | |
| 有没有把握 | — | |
| 跟自己合不合 | — | |
`);
  assert.equal(odyssey?.plans.length, 3);
  assert.equal(odyssey?.plans[0].id, "A");
  assert.match(odyssey?.plans[0].blurb || "", /日本语言学校/);
  assert.equal(odyssey?.plans[0].scores.find((s) => s.dim === "手头条件")?.score, 7);
  assert.equal(odyssey?.plans[0].scores.find((s) => s.dim === "想不想干")?.score, null);
  assert.equal(odyssey?.plans[1].scores.every((s) => s.score == null), true);
});

test("parseLifeToolbox and mind scales/demo carry 临时测试", () => {
  const md = `## 工具箱

> **临时测试**：演示

### 好时光（按线）

| 线 | 倾向 | 依据日期 | 备注 |
|---|---|---|---|
| 身心健康 | 回能 | 2026-08-04, 2026-08-05 | 练完回能 |
| 日语学习 | 耗能 | 2026-08-05 | |

### 原型

| 名称 | 类型 | 状态 | 一句话 |
|---|---|---|---|
| 地牢半日 | 体验式 | 计划中 | 验证行业活动 |

### 选择四步 · 当前大事

- **大事**：地牢去不去
- **生成**：去 / 不去
- **收窄**：先买票
- **选定**：去
- **放手**：不为露脸硬撑

### 卡住时看什么

卡住时先问缺信息还是缺睡眠。

## 量表仪表

> **临时测试**

### BPNSFS · 2026-08

| 需要 | 满足 | 受挫 | 备注 |
|---|---|---|---|
| 自主 | 7 | 3 | |
| 胜任 | 6 | 4 | |
| 联结 | 4 | 6 | |

### REQ · 2026-08

| 维度 | 分 | 备注 |
|---|---|---|
| 脱离 | 2 | |
| 放松 | 3 | |

### AAQ-II · 2026-Q3

| 项 | 值 |
|---|---|
| 总分（自参） | 24 |
| 一句话 | 能察觉卡住 |

### CBI · 2026-08

| 面 | 分 | 备注 |
|---|---|---|
| 个人倦怠 | 42 | |

## 心·演示信号

> **临时测试**

| 维度 | 次 |
|---|---|
| 下班停不下来 | 5 |
| 放松 | 3 |
| 有成就感 | 4 |
| 时间不由自己 | 6 |
`;
  const toolbox = parseLifeToolbox(md);
  assert.equal(toolbox?.tempTest, true);
  assert.equal(toolbox?.goodTimes[0].lean, "回能");
  assert.deepEqual(toolbox?.goodTimes[0].dates, ["2026-08-04", "2026-08-05"]);
  assert.equal(toolbox?.prototypes[0].name, "地牢半日");
  assert.equal(toolbox?.choiceSteps?.topic, "地牢去不去");
  assert.match(toolbox?.stuckNote || "", /缺信息/);

  const scales = parseMindScales(md);
  assert.equal(scales?.tempTest, true);
  assert.equal(scales?.bpnsfs?.rows.find((row) => row.need === "联结")?.thwarted, 6);
  assert.equal(scales?.req?.rows[0].score, 2);
  assert.equal(scales?.aaq?.score, 24);
  assert.equal(scales?.cbi?.rows[0].score, 42);

  const demo = parseMindDemoSignals(md);
  assert.equal(demo?.tempTest, true);
  assert.equal(demo?.recovery.detachmentFail, 5);
  assert.equal(demo?.recovery.controlLoss, 6);
  assert.equal(parseMindDemoSignals("## 心·演示信号\n\n| 维度 | 次 |\n|---|---:|\n| 放松 | 9 |"), null);

  const life = parseLifeDesignLog(md, [], "2026-08-06");
  assert.equal(life.toolbox?.goodTimes.length, 2);
});

test("parseRecentWellbeing keeps qualitative recent state separate from monthly scores", () => {
  const parsed = parseRecentWellbeing(`## 历史周度心理数字

| 截至周日 | 自主满足 | 自主受挫 | 胜任满足 | 胜任受挫 | 联结满足 | 联结受挫 | 可信度 | 依据 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| 2026-08-23 | 8 | 未知 | 8 | 4 | 5 | 未知 | 中 | 本周正式近期记录 |

## 当前主观睡眠

- 体感：一般
- 记录日：2026-08-28
- 来源：本人直接反馈

## 近期记录

### 2026-08-22

- 来源日：2026-08-22
- 收口：Cursor · 2026-08-23
- 来源：日志；项目
- 用户纠偏：无

#### 心理状态

| 维度 | 判断 | 置信度 | 依据 | 未知 |
|---|---|---|---|---|
| 自主 | 产品治理领域偏强 | 中高 | 直接反馈 | 整体生活未知 |
| 联结 | 暂不判断 | 低 | 无 | 关系体验未知 |

#### 人生平衡

| 判断 | 置信度 | 依据 | 未知 |
|---|---|---|---|
| 结构偏工作 | 中高 | 跨夜 | 是否心流 |

#### 好时光

| 类型 | 判断 | 置信度 | 依据 | 未知 |
|---|---|---|---|---|
| 兴趣／审美 | 喜欢音乐 | 中 | 主动试听 | 回能程度 |
`);
  assert.equal(parsed.latestDate, "2026-08-22");
  assert.equal(parsed.entries[0].mind[0].dimension, "自主");
  assert.equal(parsed.entries[0].mind[1].judgment, "暂不判断");
  assert.equal(parsed.entries[0].balance?.judgment, "结构偏工作");
  assert.equal(parsed.entries[0].goodTimes[0].dimension, "兴趣／审美");
  assert.equal("score" in parsed.entries[0].mind[0], false);
  assert.equal(parsed.weeklyMindSnapshots[0].weekEnding, "2026-08-23");
  assert.deepEqual(parsed.weeklyMindSnapshots[0].needs.map((row) => [row.need, row.met, row.thwarted]), [
    ["自主", 8, null],
    ["胜任", 8, 4],
    ["联结", 5, null],
  ]);
  assert.equal(parsed.subjectiveSleep?.rating, "一般");
  assert.equal(parsed.subjectiveSleep?.source, "本人直接反馈");
});

test("parseHealthStatusReport reads the shared daily weekly monthly contract without inventing missing blocks", () => {
  const report = parseHealthStatusReport(`---
description: 周报测试
report_kind: weekly
period_start: 2026-08-24
period_end: 2026-08-30
generated_at: 2026-08-31 06:45
status: partial
---
# 每周身心报告

## 一句话状态

这周工作从满档回落，朋友晚饭增加，但睡眠仍偏短。

## 工作负荷

- 分数：7/10
- 近7日均值：6.4/10
- 对比近28日：比个人常态高约 1 档
- 说明：前半周多线并行，后半周有课。

## 主要成果

| 成果 | 状态 | 依据 |
|---|---|---|
| 小秘书跨端入口 | 已验证 | 更新日志 |

## 节奏与打断

- 判断：夜间切换较多
- 依据：三天在收工后继续处理新问题

## 恢复观察

| 维度 | 判断 | 数值 | 依据 |
|---|---|---:|---|
| 收工后能放下 | 部分做到 | 50 | 三天夜里继续工作 |
| 休息时间由自己 | 多数做到 | 80 | 周末自排 |
| 有过真放松 | 有局部片段 | 50 | 朋友晚饭 |

## 时间精力投入

| 领域 | 数值 | 变化 | 依据 |
|---|---:|---|---|
| 工作 | 82% | 上升 | 多线推进 |
| 情感 | 70% | 上升 | 三次朋友晚饭 |

## 好时光与回能

| 内容 | 作用 | 依据 |
|---|---|---|
| 朋友晚饭 | 回能 | 本人说聊天开心 |

## 本人感受

- 摘要：身边有人了，事情也有抓手。
- 来源：对话日记

## 最值得注意

睡眠没有随负荷下降而恢复。

## 下一步只试一件事

选三天在零点前停止高认知工作。

## 可信度与未知

- 可信度：中高
- 未知：iPad 活动；NS 游戏时间

## 来源

- 日记 2026-08-24 至 2026-08-30
- 对话日记
`, "daily");
  assert.equal(report?.kind, "weekly");
  assert.equal(report?.status, "partial");
  assert.equal(report?.periodEnd, "2026-08-30");
  assert.equal(report?.workload?.score, 7);
  assert.equal(report?.workload?.average7d, 6.4);
  assert.equal(report?.achievements[0]?.status, "已验证");
  assert.equal(report?.recovery[1]?.dimension, "休息时间由自己");
  assert.equal(report?.allocation[1]?.change, "上升");
  assert.equal(report?.subjective?.source, "对话日记");
  assert.deepEqual(report?.unknowns, ["iPad 活动", "NS 游戏时间"]);
  assert.equal(report?.sources.length, 2);
});

test("parseHealthStatusReport keeps legacy daily visible but moves mastery out of recovery", () => {
  const report = parseHealthStatusReport(`---
date: 2026-09-02
---
# 当前身心日评
- 评估日：2026-09-02
- 工作强度：8/10（多线推进）
- 恢复：收工就能放下 50 · 日程未被打乱 100 · 解决过难事 100 · 有过真放松 未知
- 一句话：昨天有课，夜里还在继续改产品。
- 可执行提醒：今天先留一点收工缓冲。

依据：[[2026-09-02]] · [[训练日志]]
`);
  assert.equal(report?.kind, "daily");
  assert.equal(report?.workload?.score, 8);
  assert.equal(report?.recovery.some((row) => row.dimension.includes("解决过难事")), false);
  assert.equal(report?.achievements[0]?.text, "有解决过难事");
  assert.equal(report?.recovery[2]?.score, null);
  assert.equal(report?.notableChange, "今天先留一点收工缓冲。");
  assert.equal(report?.sources.length, 2);
});

test("parseHealthReports treats awaiting placeholders as absent", () => {
  const reports = parseHealthReports({
    daily: "# 当前身心日评\n- 一句话：有内容",
    weekly: "---\nstatus: awaiting_first_run\n---\n# 当前身心周报",
    monthly: "",
  });
  assert.equal(reports.daily?.kind, "daily");
  assert.equal(reports.weekly, null);
  assert.equal(reports.monthly, null);
});

test("intervention cards recommend only on signal hits; empty without sample", () => {
  const cards = parseInterventionCardLibrary(`## detach-boundary · 下班心理边界

- **过程**：ACT · 接触当下
- **触发信号**：\`detachmentFail\`
- **做法**：
  1. 关笔记本盖
- **依据**：恢复四维

## control-choice · 恢复一点选择感

- **过程**：SDT · 自主
- **触发信号**：\`controlLoss\`
- **做法**：
  1. 改一件不得不
- **依据**：自主
`);
  assert.equal(cards.length, 2);
  assert.deepEqual(recommendInterventionCards(cards, null), []);
  assert.deepEqual(recommendInterventionCards(cards, { sampleDays: 0, recovery: { detachmentFail: 3 } }), []);
  const picked = recommendInterventionCards(cards, {
    sampleDays: 4,
    recovery: { detachmentFail: 2, relaxation: 0, mastery: 0, controlLoss: 0 },
    motivation: {},
  });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, "detach-boundary");
  assert.match(picked[0].basis, /参考记录 2 条/);
});

test("home pins persist topic ids in workbench local file", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readHomePins(root), { topicIds: [], likedCourseIds: [], researchDomainId: "zztj" });
  const written = await writeHomePins(root, { topicIds: ["topic-a", "topic-a", " topic-b "] });
  assert.deepEqual(written, { topicIds: ["topic-a", "topic-b"], likedCourseIds: [], researchDomainId: "zztj" });
  assert.deepEqual(await readHomePins(root), { topicIds: ["topic-a", "topic-b"], likedCourseIds: [], researchDomainId: "zztj" });
  const stored = JSON.parse(await fs.readFile(path.join(root, "00_本地工作台", "派生数据", "home-pins.json"), "utf8"));
  assert.deepEqual(stored, { topicIds: ["topic-a", "topic-b"], likedCourseIds: [], researchDomainId: "zztj" });
});

test("home pins keep liked courses when only topic ids are written", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeHomePins(root, { topicIds: ["t1"], likedCourseIds: ["c1", "c2"] });
  const next = await writeHomePins(root, { topicIds: ["t2"] });
  assert.deepEqual(next, { topicIds: ["t2"], likedCourseIds: ["c1", "c2"], researchDomainId: "zztj" });
});

test("home pins keep one research domain and allow clearing it", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await writeHomePins(root, { researchDomainId: "ai" })).researchDomainId, "ai");
  assert.equal((await writeHomePins(root, { researchDomainId: "fitness" })).researchDomainId, "fitness");
  assert.equal((await writeHomePins(root, { researchDomainId: "economics-finance" })).researchDomainId, "economics-finance");
  assert.equal((await writeHomePins(root, { researchDomainId: null })).researchDomainId, null);
  assert.equal((await writeHomePins(root, { researchDomainId: "not-a-domain" })).researchDomainId, "zztj");
});

test("gantt hidden list persists locally and dedupes texts", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readGanttHidden(root), { texts: [] });
  const written = await writeGanttHidden(root, {
    texts: ["游戏：区间：9/1–9/30 试玩 Demo", "游戏：区间：9/1–9/30 试玩 Demo", " 日语：节点：12/6 · JLPT 考试 "],
  });
  assert.deepEqual(written.texts, ["游戏：区间：9/1–9/30 试玩 Demo", "日语：节点：12/6 · JLPT 考试"]);
  assert.deepEqual(await readGanttHidden(root), written);
  assert.equal(todoHideKey("A  B"), "ab");
  const stored = JSON.parse(await fs.readFile(path.join(root, "00_本地工作台", "派生数据", "gantt-hidden.json"), "utf8"));
  assert.deepEqual(stored, written);
});

test("hidden list also filters matching calendar titles without mutating the snapshot", () => {
  const snapshot = {
    available: true,
    events: [
      { id: "dinner", title: "朋友来家吃饭" },
      { id: "insurance", title: "领取失业保险金" },
    ],
  };
  const next = applyHiddenCalendarEvents(snapshot, ["领取失业保险金"]);
  assert.deepEqual(next.events.map((event) => event.id), ["dinner"]);
  assert.equal(snapshot.events.length, 2);
});

test("markets section does not require library writing corpus", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.rm(path.join(root, "60_艺术馆藏"), { recursive: true, force: true });
  const markets = await scanWorkbenchSection(root, "markets");
  assert.equal(markets.data.events[0].title, "算力开支仍高");
});

test("health section survives missing japanese sources", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.rm(path.join(root, "55_语言学习/日语"), { recursive: true, force: true });
  const health = await scanWorkbenchSection(root, "health");
  assert.equal(health.data.weight, "75.4 kg");
  assert.equal(health.data.grammar, undefined);
});

test("scanVault short TTL cache and invalidate", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  invalidateVaultScanCache();
  const first = await scanVault(root);
  const todoPath = path.join(root, SOURCES.todo);
  const original = await fs.readFile(todoPath, "utf8");
  await fs.writeFile(todoPath, original.replace("## 最近两天\n", "## 最近两天\n- [ ] 缓存探测项\n"), "utf8");
  const cached = await scanVault(root);
  assert.equal(cached.todo.today.some((item) => item.text.includes("缓存探测")), false);
  assert.equal(cached.generatedAt, first.generatedAt);
  invalidateVaultScanCache();
  const fresh = await scanVault(root, { force: true });
  assert.equal(fresh.todo.today.some((item) => item.text.includes("缓存探测")), true);
});

test("summary and snapshot omit activity stream", async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = await scanVault(root);
  const summary = await scanWorkbenchSummary(root);
  assert.equal("activity" in snapshot, false);
  assert.equal("activity" in summary, false);
});
