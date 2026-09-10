import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(relativePath) {
  return fs.readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

test("首页和日程用自然文案，不暴露写回与来源机制", () => {
  const home = source("pages/HomePage.tsx");
  const schedule = source("pages/SchedulePage.tsx");
  const release = source("pages/schedule/ReleaseWatchView.tsx");

  for (const text of ["还没有置顶的知识地图", "平衡 · 已超过", "每日早间汇总"]) {
    assert.match(home, new RegExp(text, "u"));
  }
  assert.doesNotMatch(home, /各项主线运转正常/u);
  for (const text of ["此待办暂未关联具体项目功能", "完成勾选与优先级调整会自动保存同步", "暂无排期的长期主线事项", "主线与大作战来自待办原件"]) {
    assert.match(schedule, new RegExp(text, "u"));
  }
  assert.match(release, /当前分类暂无关注的发售计划/u);
  assert.doesNotMatch(schedule, /来源定位写回原件|限时大作战来自项目原件/u);
});

test("项目、健康与市场空状态说清楚事实，不穿西装撒谎", () => {
  const projects = source("pages/ProjectsPage.tsx");
  const life = source("pages/LifePanel.tsx");
  const mind = source("pages/MindPanel.tsx");
  const markets = source("pages/MarketsPage.tsx");
  const worldNews = source("pages/world-news-lanes.tsx");

  for (const text of ["暂无关联的 AI 施工任务", "当前没有需要你介入的未完成任务", "未设定特定门槛", "近期暂无已归档的完成记录"]) {
    assert.match(projects, new RegExp(text, "u"));
  }
  assert.match(life, /AI 草稿/u);
  assert.doesNotMatch(life, /推进中的主线事项/u);
  assert.match(mind, /不是心理诊断分/u);
  assert.match(markets, /当日简报范围内暂无重大事件/u);
  assert.match(markets, /近期暂无重要宏观与财经议程/u);
  assert.match(worldNews, /暂未获取到该篇日文官方正文，仅提供标题与原文链接/u);
  assert.doesNotMatch(markets + worldNews, /市场安静本身也是信息|抄不到|不编课文|当日全球市场整体平稳/u);
});

test("学习与知识地图回到学习者视角", () => {
  const course = source("pages/languages/CourseBoard.tsx");
  const grammar = source("pages/languages/GrammarBoard.tsx");
  const reading = source("pages/languages/ReadingBoard.tsx");
  const domain = source("pages/topics/DomainResearchView.tsx");

  for (const text of ["教材目录待收录", "暂无本节学习记录", "按教材小节系统收录"]) assert.match(course, new RegExp(text, "u"));
  assert.match(grammar, /目前暂无做错或标记薄弱的文法/u);
  assert.match(reading, /这里还没有校对完成的精读篇目/u);
  for (const text of ["暂无个人学习笔记", "你的原始认知", "学习与思考笔记", "你目前的理解与关键依据", "待探索", "未浏览", "本节点暂无预设研究问题"]) {
    assert.match(domain, new RegExp(text, "u"));
  }
  assert.doesNotMatch(course + grammar + domain, /教材可用不代表已经学过|不按课文中出现多少来推测|本人学习证据|研究问题原件尚未读取到/u);
});

test("馆藏、资产和工具箱不再把内部治理术语端上桌", () => {
  const library = source("pages/LibraryPage.tsx");
  const assets = source("pages/AssetsPage.tsx");
  const renewals = source("pages/tools/RenewalExpiryView.tsx");
  const food = source("pages/tools/FoodMapView.tsx");
  const meetings = source("pages/tools/MeetingMinutesView.tsx");
  const music = source("pages/tools/MusicPlayerView.tsx");
  const activities = source("pages/tools/LocalActivityGuide.tsx");
  const art = source("pages/tools/ArtLibraryView.tsx");
  const inbox = source("pages/tools/YingningInboxView.tsx");

  assert.match(library, /发售日待定|未找到符合当前条件的馆藏作品/u);
  for (const text of ["实际同期收益率", "历史成交记录不完整；此曲线仅供大盘走势参考", "待对齐差额", "私人资产数据仅对已受信任设备开放"]) {
    assert.match(assets, new RegExp(text, "u"));
  }
  assert.match(renewals, /金额与账户关系只在本机显示/u);
  assert.match(food, /我的收藏/u);
  assert.match(meetings, /收录已整理的正式讨论记录与决议/u);
  assert.match(music, /音频文件保存在 NAS/u);
  assert.match(activities, /攻略内容已与本地知识库同步/u);
  assert.match(art, /查看素材属性与路径/u);
  assert.match(inbox, /Mac 已安全保存/u);
  assert.doesNotMatch(renewals + food + meetings + activities + art + inbox, /S2 原件|本人收藏|读取同一份 Vault 原件|MAC 已持久化|查看 ID 与项目原件/u);
});
