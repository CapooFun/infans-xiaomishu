/**
 * Vault 一级目录与常用路径常量。
 * 改目录名时只改本文件；业务模块不得再散写字面量路径。
 *
 * 十进制结构（2026-08-03 架构升级）：
 * 00_本地工作台 / 01_中转站 / 10_日志记录 / 20_个人档案 / 30_事业顺利 /
 * 40_身心健康 / 50_世界资讯 / 55_语言学习 / 60_艺术馆藏 / 70_专题研究 /
 * 80_生活事务 / 85_收藏夹 / 90_使用说明 / 99_归档
 */
import path from "node:path";

export const DIR_WORKBENCH = "00_本地工作台";
export const DIR_INBOX = "01_中转站";
export const DIR_LOG = "10_日志记录";
export const DIR_PROFILE = "20_个人档案";
export const DIR_CAREER = "30_事业顺利";
export const DIR_HEALTH = "40_身心健康";
export const DIR_WORLD_NEWS = "50_世界资讯";
export const DIR_LANG = "55_语言学习";
export const DIR_LIBRARY = "60_艺术馆藏";
export const DIR_TOPICS = "70_专题研究";
export const DIR_LIFE = "80_生活事务";
export const DIR_BOOKMARKS = "85_收藏夹";
export const DIR_RULES = "90_使用说明";
export const DIR_ARCHIVE = "99_归档";

export const TODO_PATH = "待办事项与长期规划.md";

export const WORKBENCH_IDENTITY = path.posix.join(DIR_WORKBENCH, "10_设计", "人格与陪伴", "身份策展.md");
export const WORKBENCH_DERIVED_DIR = path.posix.join(DIR_WORKBENCH, "派生数据");
export const ACTIVE_SECRETARY_STATE_PATH = path.posix.join(WORKBENCH_DERIVED_DIR, "active-secretary.json");
export const WORKBENCH_PREFERENCES_PATH = path.posix.join(WORKBENCH_DERIVED_DIR, "workbench-preferences.json");
export const COMPUTER_SHORTCUTS_PATH = path.posix.join(WORKBENCH_DERIVED_DIR, "computer-shortcuts.json");
export const LIGHTS_OFF_STATE_PATH = path.posix.join(WORKBENCH_DERIVED_DIR, "lights-off-state.json");
export const LIGHTS_OFF_HELPER_PATH = path.posix.join(WORKBENCH_DERIVED_DIR, "lights-off-helper");
export const SECRETARY_LIFE_CORE_DESIGN_DIR = path.posix.join(DIR_WORKBENCH, "10_设计", "人格与陪伴");
export const YINYUE_PUBLIC_PROFILE_PATH = path.posix.join(DIR_WORKBENCH, "10_设计", "人格与陪伴", "银月公开工作设定.md");
export const MEINING_PUBLIC_PROFILE_PATH = path.posix.join(DIR_WORKBENCH, "10_设计", "人格与陪伴", "梅凝公开工作设定.md");
export const PROTECTED_RELATIONSHIP_MEMORY_PATHS = Object.freeze([
  YINYUE_PUBLIC_PROFILE_PATH,
  MEINING_PUBLIC_PROFILE_PATH,
]);
export const WORKBENCH_APP_PREFIX = path.posix.join(DIR_WORKBENCH, "app");
export const WORKBENCH_SECRETARY_APP_PREFIX = path.posix.join(DIR_WORKBENCH, "小秘书.app");
export const SECRETARY_RUNTIME_DIR = path.posix.join(WORKBENCH_DERIVED_DIR, "secretary-runtime");
export const SECRETARY_CHARACTER_PHOTOS_DIR = path.posix.join(SECRETARY_RUNTIME_DIR, "character-photos");
export const SECRETARY_CHAT_DIR = path.posix.join(SECRETARY_RUNTIME_DIR, "chats");
export const SECRETARY_ATTACHMENTS_DIR = path.posix.join(SECRETARY_RUNTIME_DIR, "attachments");
export const SECRETARY_INTAKE_DIR = path.posix.join(SECRETARY_RUNTIME_DIR, "intake-inbox");
export const HOME_PINS_PATH = path.posix.join(DIR_WORKBENCH, "派生数据", "home-pins.json");
export const SIDEBAR_BOOKMARKS_PATH = path.posix.join(DIR_WORKBENCH, "派生数据", "sidebar-bookmarks.json");
export const GANTT_HIDDEN_PATH = path.posix.join(DIR_WORKBENCH, "派生数据", "gantt-hidden.json");
export const PROJECT_TASK_FOLLOWS_PATH = path.posix.join(DIR_WORKBENCH, "派生数据", "project-task-follows.json");
export const FOOD_MAP_STATE_PATH = path.posix.join(DIR_WORKBENCH, "派生数据", "food-map-state.json");
export const DOMAIN_RESEARCH_PROGRESS_PATH = path.posix.join(DIR_WORKBENCH, "派生数据", "domain-research-progress.json");
export const VIDEO_FAVORITES_PATH = path.posix.join(DIR_WORKBENCH, "派生数据", "video-favorites.json");
export const MUSIC_PLAYLISTS_PATH = path.posix.join(DIR_WORKBENCH, "派生数据", "music-playlists.json");
export const WORLD_NEWS_FAVORITES_PATH = path.posix.join(DIR_WORKBENCH, "派生数据", "world-news-favorites.json");
export const APPLE_HEALTH_DERIVED = path.posix.join(DIR_WORKBENCH, "派生数据", "apple-health.json");
export const ANKI_SNAPSHOT_DERIVED = path.posix.join(DIR_WORKBENCH, "派生数据", "anki-snapshot.json");
export const LANGUAGE_REACTOR_DERIVED = path.posix.join(DIR_WORKBENCH, "派生数据", "language-reactor.json");
export const JAPANESE_KNOWLEDGE_CARDS_DIR = path.posix.join(DIR_LANG, "日语", "收藏", "知识卡片");
export const JAPANESE_KNOWLEDGE_CARDS_INDEX = path.posix.join(DIR_LANG, "日语", "收藏", "知识卡片", "README.md");
export const JAPANESE_COLLECTION_INDEX = path.posix.join(DIR_LANG, "日语", "收藏卡片_总览.md");
export const JAPANESE_LITERATURE_READING_DIR = path.posix.join(DIR_LANG, "日语", "阅读");
export const GAME_ANALYTICS_DERIVED = path.posix.join(DIR_WORKBENCH, "派生数据", "game-analytics.json");
export const AI_TOOL_USAGE_DERIVED = path.posix.join(DIR_WORKBENCH, "派生数据", "ai-tool-usage.json");
export const AI_TOOL_LIBRARY_DIR = path.posix.join(DIR_BOOKMARKS, "AI工具库");
export const AI_TOOL_CATALOG_PATH = path.posix.join(AI_TOOL_LIBRARY_DIR, "AI工具目录.json");
export const AI_TOOL_QUARTERLY_REPORT_DIR = path.posix.join(AI_TOOL_LIBRARY_DIR, "季度报告");
export const WEB_BOOKMARK_USAGE_DERIVED = path.posix.join(DIR_WORKBENCH, "派生数据", "web-bookmark-usage.json");
export const AGENT_OBSERVABILITY_CURSOR_BATCHES = path.posix.join(WORKBENCH_DERIVED_DIR, "agent-observability-cursor-batches.jsonl");
export const AGENT_OBSERVABILITY_CURSOR_ACCOUNT = path.posix.join(WORKBENCH_DERIVED_DIR, "agent-observability-cursor-account.jsonl");
export const WEB_BOOKMARK_LIBRARY_DIR = path.posix.join(DIR_BOOKMARKS, "网页收藏");
export const WEB_BOOKMARK_CATALOG_PATH = path.posix.join(WEB_BOOKMARK_LIBRARY_DIR, "网页收藏目录.json");
export const FOOD_MAP_CATALOG_PATH = path.posix.join(DIR_LIFE, "日本生活", "美食地图", "美食地图_总览.md");

/** 可选的本机音乐库；公开版不默认指向任何私人支持目录。 */
export const FANREN_MUSIC_SUPPORT_PATH = path.posix.join("10_学习资料", "音乐");
export function fanrenMusicSupportDir(_vaultRoot) {
  return "";
}

/** 支持库中的正式课件；工作台只读扫描课件清单与同目录成品。 */
export const COURSE_LIBRARY_SUPPORT_PATH = path.posix.join("10_学习资料");
export function courseLibrarySupportDir(vaultRoot) {
  const supportRoot = process.env.INFANS_SUPPORT_ROOT || path.resolve(vaultRoot, "..", "Infans_Support");
  return path.resolve(supportRoot, COURSE_LIBRARY_SUPPORT_PATH);
}

/** 支持库中的私人动漫封面；工作台按清单白名单只读，不把图片复制进 Vault。 */
export const ANIME_COVERS_SUPPORT_PATH = path.posix.join("10_学习资料", "艺术馆藏", "动漫封面");
export function animeCoversSupportDir(vaultRoot) {
  const supportRoot = process.env.INFANS_SUPPORT_ROOT || path.resolve(vaultRoot, "..", "Infans_Support");
  return path.resolve(supportRoot, ANIME_COVERS_SUPPORT_PATH);
}

/** 公开活动站的发布白名单快照；小秘书只读清单，不读取公开站源码里的内部路径。 */
export const KOU_NO_TSUDOI_SUPPORT_PATH = path.posix.join("20_项目支持", "活动站点_示例");
export function kouNoTsudoiPublicSnapshot(_vaultRoot) {
  return "";
}

export const DIARY_DIR = path.posix.join(DIR_LOG, "工作日志");
export const PRIVATE_DIALOGUE_DIARY_DIR = path.posix.join(DIR_LOG, "对话日志");
/** 日记模式只读协议、人工确认偏好与非权威对话日志。 */
export const DIARY_MODE_PROTOCOL_PATH = path.posix.join(DIR_WORKBENCH, "10_设计", "全局能力", "日记模式_上下文与交接协议.md");
export const DIARY_MODE_PREFERENCES_PATH = path.posix.join(DIR_WORKBENCH, "20_记录", "协作记忆", "日记模式_聊天偏好.md");
export const DIALOGUE_DIARY_DIR = PRIVATE_DIALOGUE_DIARY_DIR;
export const MEETING_MINUTES_DIR = path.posix.join(DIR_LOG, "会议纪要");
/** 协作记录第四页只读的非权威参考方案；现行架构与规则仍留在所属原件。 */
export const TECHNICAL_DISCUSSIONS_DIR = path.posix.join(DIR_BOOKMARKS, "技术讨论");
export const CURRENT_WELLBEING_DAILY_PATH = path.posix.join(DIR_HEALTH, "状态报告", "当前身心日评.md");
export const CURRENT_WELLBEING_WEEKLY_PATH = path.posix.join(DIR_HEALTH, "状态报告", "当前身心周报.md");
export const CURRENT_WELLBEING_MONTHLY_PATH = path.posix.join(DIR_HEALTH, "状态报告", "当前身心月报.md");
export const MOBILE_GPT_LIVE_MCP_RUNBOOK_PATH = path.posix.join(DIR_RULES, "10_规则手册", "手机GPT_Live与Infans只读MCP_运行手册.md");

export const AVATAR_PATH = path.posix.join(DIR_PROFILE, "基础信息", "头像", "辛多雷徽记.jpg");
/** 抖音出镜身份头像（侧栏点头像可切换）。 */
export const AVATAR_CREATOR_PATH = path.posix.join(DIR_PROFILE, "基础信息", "头像", "豆包头像.PNG");
export const ASSET_SOURCE = path.posix.join(DIR_PROFILE, "个人资产", "个人资产记录.md");
/** 个人投资逐笔账本；首期以 A 股样本验证账户、证券、成交与持仓对账。 */
export const A_SHARE_INVESTMENT_LEDGER = path.posix.join(DIR_PROFILE, "个人资产", "A股投资账本.md");
/** 已由本人确认的跨账户交易事实；代持表之后发生的成交从这里增量接入投资看板。 */
export const PERSONAL_TRADE_MEMO = path.posix.join(DIR_PROFILE, "个人资产", "个人交易备忘.md");
/** Steam Web API Key 与 SteamID 落点；只给服务端代查，不把钥匙塞进前端。 */
export const GAME_ACCOUNTS = path.posix.join(DIR_PROFILE, "账号信息", "游戏账号.md");
/** 委托代持表示例目录与默认文件。 */
export const SUNXIANG_HOLDINGS_DIR = path.posix.join(DIR_PROFILE, "个人资产");
export const SUNXIANG_HOLDINGS_FILE = path.posix.join(SUNXIANG_HOLDINGS_DIR, "委托代持_示例账户.xlsx");
/** 微信支付导出原件目录（xlsx）；工作台只读解析，不改原件。 */
export const WECHAT_BILLS_DIR = path.posix.join(DIR_LIFE, "生活账单");
/** 固定 / 大事开销备忘（JSON）；支出页只读展示。 */
export const FIXED_EXPENSES_FILE = path.posix.join(WECHAT_BILLS_DIR, "固定开销.json");
/** 日本活动官方来源介绍卡；定时任务只能覆盖这一份白名单原件。 */
export const JAPAN_ACTIVITIES_SOURCE = path.posix.join(DIR_LIFE, "日本游玩攻略", "日本活动.md");
/** 续费／到期管理元数据；不复制金额或完整账号。 */
export const RENEWAL_EXPIRY_SOURCE = path.posix.join(DIR_LIFE, "日常杂务", "续费到期.md");
/** 工行收入备忘（截图分类）；收入页只读展示。 */
export const BANK_INCOME_MEMO_FILE = path.posix.join(WECHAT_BILLS_DIR, "工行收入备忘.json");

export const CAREER_OVERVIEW = path.posix.join(DIR_CAREER, "事业顺利_总览.md");
export const FLAGSHIP_OVERVIEW = path.posix.join(DIR_CAREER, "小秘书", "小秘书_总览.md");
export const COACHING_OVERVIEW = path.posix.join(DIR_CAREER, "阳台种植计划", "阳台种植计划_总览.md");
export const COACHING_LOG = path.posix.join(DIR_CAREER, "阳台种植计划", "项目进度与待办.md");
export const MARKET_BRIEF = path.posix.join(DIR_WORLD_NEWS, "金融", "当前简报.md");
export const MARKET_BRIEF_HISTORY_DIR = path.posix.join(DIR_WORLD_NEWS, "金融", "简报历史");
export const WORLD_NEWS_DIR = path.posix.join(DIR_WORLD_NEWS);
export const WORLD_NEWS_LANES = Object.freeze({
  ai: path.posix.join(WORLD_NEWS_DIR, "AI"),
  games: path.posix.join(WORLD_NEWS_DIR, "游戏"),
  japan: path.posix.join(WORLD_NEWS_DIR, "日本"),
});
export const WORLD_NEWS_CURRENT = Object.freeze({
  ai: path.posix.join(WORLD_NEWS_LANES.ai, "当前.md"),
  games: path.posix.join(WORLD_NEWS_LANES.games, "当前.md"),
  japan: path.posix.join(WORLD_NEWS_LANES.japan, "当前.md"),
});
export function worldNewsHistoryDir(lane) {
  const base = WORLD_NEWS_LANES[lane];
  return base ? path.posix.join(base, "历史") : "";
}
export const WORLD_READING_AUDIO_DIR = path.posix.join(WORKBENCH_DERIVED_DIR, "世界资讯朗读");
/** Cursor 可写的一事一档专题目录；工作台只读，不把 Markdown 正文直接交给前端。 */
export const MARKET_EVENT_TOPICS_DIR = path.posix.join(DIR_WORLD_NEWS, "金融", "重大事件专题");

export const HEALTH_OVERVIEW = path.posix.join(DIR_HEALTH, "身心健康_总览.md");
export const BODY_RECORD = path.posix.join(DIR_HEALTH, "体魄", "三维记录.md");
export const TRAINING_LOG = path.posix.join(DIR_HEALTH, "体魄", "训练日志.md");
export const TRAINING_REVIEW = path.posix.join(DIR_HEALTH, "体魄", "训练复盘.md");
export const TRAINING_PLAN = path.posix.join(DIR_HEALTH, "体魄", "训练计划.md");
export const APPLE_HEALTH_SUMMARY = path.posix.join(DIR_HEALTH, "体魄", "Apple健康导入摘要.md");
export const WORKVIEW_DOC = path.posix.join(DIR_HEALTH, "平衡", "工作观.md");
export const LIFEVIEW_DOC = path.posix.join(DIR_HEALTH, "平衡", "人生观.md");
export const LIFE_DESIGN_LOG = path.posix.join(DIR_HEALTH, "平衡", "人生设计校准.md");
export const RECENT_WELLBEING_LOG = path.posix.join(DIR_HEALTH, "心理", "当前心理与人生平衡.md");
export const ODYSSEY_PLAN = path.posix.join(DIR_HEALTH, "平衡", "奥德赛计划.md");
export const INTERVENTION_CARDS = path.posix.join(DIR_HEALTH, "90_历史", "干预卡库.md");
export const EXERCISES_DATASET_DIR = path.posix.join(DIR_HEALTH, "exercises-dataset");
export const COACH_ROLE_DOC = path.posix.join(DIR_HEALTH, "体魄", "身心健康教练_角色设定.md");

export const JP_OVERVIEW = path.posix.join(DIR_LANG, "日语", "日语_总览.md");
export const JP_N2_DIR = path.posix.join(DIR_LANG, "日语", "练习记录与进度");
export const JP_STATUS = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "current_status.md");
export const JP_DAILY = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "daily_log.md");
export const JP_GRAMMAR_N5 = path.posix.join(DIR_LANG, "日语", "文法", "JLPT", "N5.md");
export const JP_GRAMMAR_N4 = path.posix.join(DIR_LANG, "日语", "文法", "JLPT", "N4.md");
export const JP_GRAMMAR_N3 = path.posix.join(DIR_LANG, "日语", "文法", "JLPT", "N3.md");
export const JP_GRAMMAR_N2 = path.posix.join(DIR_LANG, "日语", "文法", "JLPT", "N2.md");
export const JP_EXPLORATION_PROGRESS = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "探索进度.md");
export const JP_MISTAKES = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "错题集.md");
export const JP_EXAM_SKILL = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "考官skill.md");
export const JP_MISTAKE_STATE = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "错题状态.json");
export const JP_SPECIAL_HISTORY_DIR = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "专项题历史");
export const JP_SPECIAL_MASTERY = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "专项掌握.json");
export const JP_MOCK_SNAPSHOT = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "探索全卷快照.json");
export const JP_READING_MILEAGE = path.posix.join(DIR_LANG, "日语", "练习记录与进度", "阅读练习里程.json");
export const LANGUAGE_REACTOR_SOURCE = path.posix.join(DIR_LANG, "日语", "收藏", "沉浸语料", "Language Reactor收藏.md");
export const LATIN_OVERVIEW = path.posix.join(DIR_LANG, "拉丁语", "拉丁语_总览.md");
export const CLASSICAL_CN_OVERVIEW = path.posix.join(DIR_LANG, "古汉语", "古汉语_总览.md");

export const LIBRARY_OVERVIEW = path.posix.join(DIR_LIBRARY, "书籍", "书架_总览.md");
export const WEREAD_PATH = path.posix.join(DIR_LIBRARY, "书籍", "微信读书.md");
export const PAPER_BOOKS = path.posix.join(DIR_LIBRARY, "书籍", "纸质书.md");
export const BOOK_COVERS_JSON = path.posix.join(DIR_LIBRARY, "书籍", "书架封面.json");
export const BOOK_COVERS_DIR = path.posix.join(DIR_LIBRARY, "书籍", "封面");
export const WRITING_OVERVIEW = path.posix.join(DIR_LIBRARY, "写作", "原创写作_总览.md");
export const WRITING_DIR = path.posix.join(DIR_LIBRARY, "写作");
/** 示例公众号正文目录——艺术馆藏「写作」一并展示。 */
export const WECHAT_OFFICIAL_DIR = path.posix.join(DIR_CAREER, "公众号_示例手记");
export const GAMES_OVERVIEW = path.posix.join(DIR_LIBRARY, "游戏", "我的游戏_总览.md");
export const STEAM_LIBRARY_JSON = path.posix.join(DIR_LIBRARY, "游戏", "steam_库.json");
export const EXTRA_GAMES_JSON = path.posix.join(DIR_LIBRARY, "游戏", "非Steam游戏.json");
export const APPLE_GAMES_JSON = path.posix.join(DIR_LIBRARY, "游戏", "apple_games_库.json");
export const GAME_COVERS_DIR = path.posix.join(DIR_LIBRARY, "游戏", "封面");
export const GAME_CULTURE_OVERVIEW = path.posix.join(DIR_LIBRARY, "游戏", "个人游戏文化谱系_总览.md");
export const GAME_CULTURE_WOW = path.posix.join(DIR_LIBRARY, "游戏", "文化谱系", "魔兽世界_TBC时期.md");
export const GAME_CULTURE_SOULS = path.posix.join(DIR_LIBRARY, "游戏", "文化谱系", "魂系作品_黑暗之魂与血源诅咒.md");
export const GAME_CULTURE_ZELDA = path.posix.join(DIR_LIBRARY, "游戏", "文化谱系", "塞尔达传说系列.md");
export const GAME_CULTURE_SOURCES = Object.freeze([GAME_CULTURE_WOW, GAME_CULTURE_SOULS, GAME_CULTURE_ZELDA]);
export const SCREEN_OVERVIEW = path.posix.join(DIR_LIBRARY, "动漫与影视", "我的影像_总览.md");
export const SCREEN_CULTURE_FANREN = path.posix.join(DIR_LIBRARY, "动漫与影视", "文化谱系", "凡人修仙传_动画.md");
export const SCREEN_CULTURE_FMA = path.posix.join(DIR_LIBRARY, "动漫与影视", "文化谱系", "钢之炼金术师.md");
export const SCREEN_CULTURE_MADOKA = path.posix.join(DIR_LIBRARY, "动漫与影视", "文化谱系", "魔法少女小圆.md");
export const SCREEN_CULTURE_CODE_GEASS = path.posix.join(DIR_LIBRARY, "动漫与影视", "文化谱系", "叛逆的鲁路修.md");
export const SCREEN_CULTURE_EAGLE = path.posix.join(DIR_LIBRARY, "动漫与影视", "文化谱系", "东成西就.md");
export const SCREEN_CULTURE_CINEMA_PARADISO = path.posix.join(DIR_LIBRARY, "动漫与影视", "文化谱系", "天堂电影院.md");
export const SCREEN_CULTURE_SOURCES = Object.freeze([
  SCREEN_CULTURE_FANREN,
  SCREEN_CULTURE_FMA,
  SCREEN_CULTURE_MADOKA,
  SCREEN_CULTURE_CODE_GEASS,
  SCREEN_CULTURE_EAGLE,
  SCREEN_CULTURE_CINEMA_PARADISO,
]);
export const CULTURE_DOCUMENT_SOURCES = Object.freeze([...GAME_CULTURE_SOURCES, ...SCREEN_CULTURE_SOURCES]);

export const TOPICS_OVERVIEW = path.posix.join(DIR_TOPICS, "专题研究_总览.md");
export const GAME_RESEARCH_OVERVIEW = path.posix.join(DIR_TOPICS, "游戏", "游戏文化研究_总览.md");
export const GAME_RESEARCH_QUESTIONS = path.posix.join(DIR_TOPICS, "游戏", "首批研究问题.md");
export const DEDAO_DIR = path.posix.join(DIR_TOPICS, "课程资料", "得到");
export const DEDAO_ARCHIVE = path.posix.join(DIR_TOPICS, "课程资料", "得到", "得到课程档案.md");
export const DEDAO_COVERS_JSON = path.posix.join(DIR_TOPICS, "课程资料", "得到", "得到课程封面.json");
export const DEDAO_COVERS_DIR = path.posix.join(DIR_TOPICS, "课程资料", "得到", "封面");

export const TOPIC_SOURCES = Object.freeze([
  GAME_RESEARCH_OVERVIEW,
  path.posix.join(DIR_TOPICS, "人工智能", "人工智能_总览.md"),
  path.posix.join(DIR_TOPICS, "经济与金融", "经济与金融_总览.md"),
  path.posix.join(DIR_TOPICS, "语言研究", "语言研究_总览.md"),
  path.posix.join(DIR_TOPICS, "思想史", "思想史_总览.md"),
  path.posix.join(DIR_TOPICS, "资治通鉴", "资治通鉴_总览.md"),
  path.posix.join(DIR_TOPICS, "形象管理", "形象管理_总览.md"),
  path.posix.join(DIR_TOPICS, "运动健身", "运动健身_总览.md"),
]);

/** 代码改动强制二次确认：匹配工作台 app/ 与已签名的 小秘书.app/。 */
export function isWorkbenchCodePath(relativePath) {
  const normalized = String(relativePath ?? "").replace(/\\/g, "/");
  const app = `${DIR_WORKBENCH}/app`;
  const secretaryApp = `${DIR_WORKBENCH}/小秘书.app`;
  return normalized === app
    || normalized.startsWith(`${app}/`)
    || normalized === secretaryApp
    || normalized.startsWith(`${secretaryApp}/`);
}

export function diaryPathForDay(day) {
  return path.posix.join(DIARY_DIR, `${day}.md`);
}

export function exerciseMediaPath(folder, stem, ext) {
  return path.posix.join(EXERCISES_DATASET_DIR, folder, `${stem}.${ext}`);
}

/** 日语课程原件与结构化课件的唯一位置。 */
export const COURSE_GRAMMAR_ROOT = path.posix.join(DIR_LANG, "日语", "课程", "できる日本語");
export const COURSE_MATERIALS_ROOT = path.posix.join(COURSE_GRAMMAR_ROOT, "结构化教材");
