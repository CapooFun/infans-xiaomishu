/** 日程甘特：五类型解析、大类色相、泳道归属与按日定位的周分组轴（纯函数，东京日历日）。 */

export type TodoScope = "today" | "longTerm";

export type TodoItem = {
  done: boolean;
  text: string;
  scope: TodoScope;
};

export type Mainline = {
  priority: string;
  item: string;
  entry: string;
};

export type LaneId = string;

/** 大类色相：事业月金 / 修炼玉青 / 生活雾蓝 / 其它雾灰 */
export type FamilyTone = "work" | "cultivate" | "life" | "mist";

export type TaskKind = "event" | "milestone" | "deadline" | "span" | "phase" | "gate" | "detail" | "cadence" | "intent" | "routine";

/** 轴上画法：★ 事件/节点 · ▼ 截止 · 条 区间 · 点列 例行 · 无 常驻/意向 */
export type AxisMarker = "star" | "flag" | "bar" | "diamond" | "dot" | "dots" | "none";

export type GanttLane = {
  id: LaneId;
  label: string;
  tone: FamilyTone;
  priority: string;
};

export type DateSpan = {
  start: string; // YYYY-MM-DD Tokyo calendar
  end: string;
  kind: "single" | "range";
  source: "explicit" | "none";
};

export type BarVisual = "done" | "active" | "future" | "overdue";

export type GanttTask = {
  id: string;
  text: string;
  displayText: string;
  done: boolean;
  scope: TodoScope;
  laneId: LaneId;
  kind: TaskKind;
  family: FamilyTone;
  marker: AxisMarker;
  /** Markdown 尾部元数据：用于跨改名稳定引用，不取代 React 行 id。 */
  planId: string | null;
  parentId: string | null;
  dependencyIds: string[];
  depth: number;
  childCount: number;
  /** 同一泳道内按待办原文顺序展示，方便以推进表优先级默认写入后手工微调。 */
  sourceOrder: number;
  /** 是否在周轴上画图形（常驻/意向为 false） */
  onAxis: boolean;
  span: DateSpan | null;
  visual: BarVisual;
  weekStart: number;
  weekEnd: number;
  /** 起始日在周内起点的比例（周一=0，周日=6/7）。 */
  dayOffset: number;
  /** 结束日的开区间上界比例（含当天整天，周一结束=1/7，周日结束=1）。 */
  dayEndOffset: number;
};

export type WeekDayTick = {
  key: string;
  day: number;
  /** 0=周日 … 6=周六（UTC 日历日）。 */
  weekday: number;
};

export type WeekColumn = {
  index: number;
  start: string;
  end: string;
  label: string;
  monthLabel: string | null;
  days: WeekDayTick[];
};

/** 例行活动：单行多点，挂在所属泳道内，画在日期行下方。 */
export type GanttRoutinePoint = {
  date: string;
  weekIndex: number;
  dayOffset: number;
  visual: BarVisual;
};

export type GanttRoutineSeries = {
  id: string;
  text: string;
  displayText: string;
  done: boolean;
  scope: TodoScope;
  family: FamilyTone;
  laneId: LaneId;
  points: GanttRoutinePoint[];
};

export type GanttModel = {
  lanes: GanttLane[];
  tasks: GanttTask[];
  routines: GanttRoutineSeries[];
  weeks: WeekColumn[];
  todayKey: string;
  todayOffset: number;
  todayWeekIndex: number;
};

export type RoadmapMonth = {
  key: string;
  start: string;
  end: string;
  label: string;
  yearLabel: string | null;
};

const FAMILY_BY_LANE: Record<string, FamilyTone> = {
  company: "work",
  game: "work",
  coach: "work",
  wechat: "work",
  xiaohongshu: "work",
  douyin: "work",
  japanese: "cultivate",
  topics: "cultivate",
  health: "cultivate",
  life: "life",
  other: "mist",
};

const OTHER_LANE: GanttLane = { id: "other", label: "其它", tone: "mist", priority: "" };

type LaneDef = {
  id: string;
  label: string;
  aliases: RegExp;
  prefixes: RegExp;
  keywords: RegExp;
};

export const CANONICAL_LANE_DEFS: LaneDef[] = [
  { id: "company", label: "公司事务", aliases: /公司事务/u, prefixes: /^(公司)\s*[：:]/u, keywords: /Apple Developer|企业邮箱|飞书|官网|域名|新网|广告变现|源码与发布分离|Indies|BitSummit|もくもく|Meetup|MERGE|AIDD|AI驱动|行业活动|行业交流|Tokyo Indies/u },
  { id: "game", label: "游戏事业", aliases: /游戏事业/u, prefixes: /^(游戏|经营)\s*[：:]/u, keywords: /游戏事业|Steam|Demo|发售|发行商|Play|App Store/iu },
  { id: "japanese", label: "日语学习", aliases: /日语学习/u, prefixes: /^(日语)\s*[：:]/u, keywords: /日语|JLPT|\bN2\b|\bN3\b|\bN4\b|\bN5\b|Language Reactor|文法|词汇|听力|读解/u },
  { id: "topics", label: "专题研究", aliases: /领域研究/u, prefixes: /^(专题)\s*[：:]/u, keywords: /领域研究|通鉴|专题课程|学习专题|思想史|形象管理|得到课程/u },
  { id: "health", label: "身心健康", aliases: /身心健康/u, prefixes: /^(健康)\s*[：:]/u, keywords: /训练|健身|围度|心率|体脂|卧推|深蹲|身心健康/u },
  { id: "life", label: "生活事务", aliases: /生活事务/u, prefixes: /^(生活)\s*[：:]/u, keywords: /搬家|VPN|Shadowrocket|Tailscale|生活事务/u },
  { id: "coach", label: "教练", aliases: /教练/u, prefixes: /^(教练|求职)\s*[：:]/u, keywords: /教练|求职|跟进表/u },
  { id: "wechat", label: "公众号", aliases: /公众号/u, prefixes: /^(公众号)\s*[：:]/u, keywords: /公众号/u },
  { id: "xiaohongshu", label: "小红书", aliases: /小红书/u, prefixes: /^(小红书)\s*[：:]/u, keywords: /小红书/u },
  { id: "douyin", label: "抖音", aliases: /抖音/u, prefixes: /^(抖音)\s*[：:]/u, keywords: /抖音/u },
];

const LANE_PREFIX_STRIP_RE = /^(公司|游戏|经营|日语|健康|专题|生活|教练|求职|公众号|小红书|抖音|内容|自媒体|工作台|治理)\s*[：:]\s*/u;
const KIND_LABEL_RE = /^(战略主线下的项目进度\s*·\s*发行里程碑|项目进度\s*·\s*(?:目标上线里程碑|关键里程碑|发行里程碑|里程碑|检查点)|日程（有空可去）|日程区间|日程|事件|节点|截止|区间|阶段|决策|细节|常驻|意向|例行)\s*[：:]\s*/u;
const TASK_META_RE = /[｜|]\s*(ID|父级|依赖)\s*[：:]\s*([^｜|]+)/gu;
/** 展示用：尚无具体日时的占位，如 `待排 ·`。 */
const PENDING_DATE_LABEL_RE = /^待排\s*[·•.]\s*/u;
/** 展示用：时段备注，如 `白天 ·` / `晚 ·`（真正排期仍用 M/D ·）。 */
const TIME_OF_DAY_LABEL_RE = /^(白天|晚上|傍晚|凌晨|上午|下午|晚|早)\s*[·•.]\s*/u;
/** 展示用：`8/6 晚 ·` 这类带时段的单日备注（先于单日日期剥离）。 */
const DATE_DAYPART_LABEL_RE = /^(?:\d{4}\s*[\/年.-]\s*)?\d{1,2}\s*[\/月.-]\s*\d{1,2}\s*(?:晚|早|白天|晚上)\s*[·•.]?\s*/u;
/** 展示用：`8/3 起 ·` 这类常驻起算备注。 */
const SINCE_DATE_LABEL_RE = /^(?:\d{4}\s*[\/年.-]\s*)?\d{1,2}\s*[\/月.-]\s*\d{1,2}\s*起\s*[·•.]?\s*/u;
/** 展示用：标题末尾空信息括号，如 `（工作台）`。 */
const TRAILING_META_PAREN_RE = /（(?:工作台|盯进度|本人拍板落地)）\s*$/u;
const KIND_MAP: Record<string, TaskKind> = {
  "战略主线下的项目进度 · 发行里程碑": "phase",
  "项目进度 · 目标上线里程碑": "milestone",
  "项目进度 · 关键里程碑": "milestone",
  "项目进度 · 发行里程碑": "milestone",
  "项目进度 · 里程碑": "milestone",
  "项目进度 · 检查点": "milestone",
  "日程（有空可去）": "routine",
  日程区间: "span",
  日程: "event",
  事件: "event",
  节点: "milestone",
  截止: "deadline",
  区间: "span",
  阶段: "phase",
  决策: "gate",
  细节: "detail",
  常驻: "cadence",
  意向: "intent",
  例行: "routine",
};

/** 区间：允许 `8/3–9/7`、`2026/11–2027/2`（无日则取该月 1 日）。 */
const DATE_RANGE_RE = /(?:(\d{4})\s*[\/年.-]\s*)?(\d{1,2})(?:\s*[\/月.-]\s*(\d{1,2})\s*(?:日)?)?\s*[–—\-至到~～]\s*(?:(\d{4})\s*[\/年.-]\s*)?(\d{1,2})(?:\s*[\/月.-]\s*(\d{1,2})\s*(?:日)?)?/u;
/** 单日：`8/1 ·` 或 `2027/2 ·`；必须带间隔点。 */
const DATE_SINGLE_RE = /(?:^|[^\d/])(?:(\d{4})\s*[\/年.-]\s*)?(\d{1,2})(?:\s*[\/月.-]\s*(\d{1,2})\s*(?:日)?)?\s*[·•.]\s+/u;
/** 持续事项只在甘特标出起点；今日事项由服务端按开放区间保持可见。 */
const DATE_ONGOING_START_RE = /(?:^|[^\d/])(?:(\d{4})\s*[\/年.-]\s*)?(\d{1,2})\s*[\/月.-]\s*(\d{1,2})\s*日?\s*起(?:\s*[·•.]\s*|\s+)/u;
/** 例行多点 token：`8/19 ·`；末尾允许无间隔点（`… 12/16`）。 */
const DATE_DOT_TOKEN_RE = /(?:(\d{4})\s*[\/年.-]\s*)?(\d{1,2})\s*[\/月.-]\s*(\d{1,2})(?:\s*[·•.]\s*|(?=\s*[｜|]|\s*$))/gu;
/** 展示清理专用：先移除完整 ISO 单日，避免其中的 `09-01` 被区间清理误吃。 */
const ISO_DATE_DOT_TOKEN_RE = /(?<![\d/])\d{4}\s*[\/年.-]\s*\d{1,2}\s*[\/月.-]\s*\d{1,2}(?:\s*日)?(?:\s*[·•.]\s*|(?=\s*[｜|]|\s*$))/gu;
/** 展示清理专用：带“月”的年内月份区间，例如 `2026 年 8–12 月`。 */
const CHINESE_YEAR_MONTH_RANGE_RE = /\d{4}\s*年\s*\d{1,2}\s*[–—\-至到~～]\s*\d{1,2}\s*月/gu;
/**
 * 钟点备注：`11:00` / `11:00–17:00`。
 * 若不先剥掉，区间正则会把 `00–17` 当成「0 月–17 月」，标题残留 `11::00`，并把单日事件拖成长条。
 */
const CLOCK_RANGE_RE = /\b([01]?\d|2[0-3])\s*:\s*[0-5]\d(?:\s*[–—\-至到~～]\s*([01]?\d|2[0-3])\s*:\s*[0-5]\d)?/gu;

function stripClockTimes(text: string) {
  return text.replace(CLOCK_RANGE_RE, " ");
}

function isValidCalendarParts(month: number, day: number) {
  return Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

export function tokyoDateParts(date: Date | string = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(date));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function tokyoDateKey(date: Date | string = new Date()) {
  const { year, month, day } = tokyoDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function padDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseYmd(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return { year: y, month: m, day: d };
}

export function addCalendarDays(key: string, days: number) {
  const { year, month, day } = parseYmd(key);
  const utc = Date.UTC(year, month - 1, day + days);
  const date = new Date(utc);
  return padDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function compareDateKeys(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 结束日早于「今天往前 retainDays 天」则视为过期过久，甘特不再展示。 */
export function isStalePast(endKey: string | null | undefined, todayKey: string, retainDays = 7) {
  if (!endKey) return false;
  const cutoff = addCalendarDays(todayKey, -retainDays);
  return compareDateKeys(endKey, cutoff) < 0;
}

export function startOfWeekMonday(key: string) {
  const { year, month, day } = parseYmd(key);
  const utc = Date.UTC(year, month - 1, day);
  const weekday = new Date(utc).getUTCDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  return addCalendarDays(key, offset);
}

export function endOfWeekSunday(weekStart: string) {
  return addCalendarDays(weekStart, 6);
}

function resolveYear(month: number, day: number, explicitYear: number | null, defaultYear: number, anchorKey: string) {
  if (explicitYear != null) return explicitYear;
  const candidate = padDate(defaultYear, month, day);
  if (compareDateKeys(candidate, addCalendarDays(anchorKey, -180)) < 0) return defaultYear + 1;
  return defaultYear;
}

export function parseTaskDates(text: string, todayKey = tokyoDateKey()): DateSpan | null {
  const { year: defaultYear } = parseYmd(todayKey);
  const cleaned = stripClockTimes(text);
  const ongoingStart = cleaned.match(DATE_ONGOING_START_RE);
  if (ongoingStart) {
    const month = Number(ongoingStart[2]);
    const day = Number(ongoingStart[3]);
    if (!isValidCalendarParts(month, day)) return null;
    const year = resolveYear(month, day, ongoingStart[1] ? Number(ongoingStart[1]) : null, defaultYear, todayKey);
    const key = padDate(year, month, day);
    return { start: key, end: key, kind: "single", source: "explicit" };
  }
  // 完整 ISO 单日（如 2026-09-01 ·）必须先于区间解析；否则 `09-01`
  // 会被宽松的月份区间正则误认成“9 月到次年 1 月”。真正的完整日期区间没有中间点，不会命中这里。
  const isoSingle = cleaned.match(DATE_SINGLE_RE);
  if (isoSingle?.[1] && isoSingle[3]) {
    const month = Number(isoSingle[2]);
    const day = Number(isoSingle[3]);
    if (!isValidCalendarParts(month, day)) return null;
    const key = padDate(Number(isoSingle[1]), month, day);
    return { start: key, end: key, kind: "single", source: "explicit" };
  }
  const range = cleaned.match(DATE_RANGE_RE);
  if (range) {
    const startMonth = Number(range[2]);
    const startDay = range[3] ? Number(range[3]) : 1;
    const endMonth = Number(range[5]);
    const endDay = range[6] ? Number(range[6]) : 1;
    if (isValidCalendarParts(startMonth, startDay) && isValidCalendarParts(endMonth, endDay)) {
      const startYear = resolveYear(startMonth, startDay, range[1] ? Number(range[1]) : null, defaultYear, todayKey);
      let endYear = range[4] ? Number(range[4]) : startYear;
      if (!range[4] && (endMonth < startMonth || (endMonth === startMonth && endDay < startDay))) endYear = startYear + 1;
      const start = padDate(startYear, startMonth, startDay);
      const end = padDate(endYear, endMonth, endDay);
      if (compareDateKeys(end, start) < 0) return { start: end, end: start, kind: "range", source: "explicit" };
      return { start, end, kind: "range", source: "explicit" };
    }
  }

  const single = cleaned.match(DATE_SINGLE_RE);
  if (single) {
    const month = Number(single[2]);
    const day = single[3] ? Number(single[3]) : 1;
    if (!isValidCalendarParts(month, day)) return null;
    const year = resolveYear(month, day, single[1] ? Number(single[1]) : null, defaultYear, todayKey);
    const key = padDate(year, month, day);
    return { start: key, end: key, kind: "single", source: "explicit" };
  }

  return null;
}

/** 去掉泳道 / 类型 / 象限前缀，保留日期与标题（首页摘要用）。 */
export function stripTodoMetaPrefixes(text: string) {
  return text
    .replace(LANE_PREFIX_STRIP_RE, "")
    .replace(KIND_LABEL_RE, "")
    .replace(/象限\s*[：:]\s*(重要且紧急|重要不紧急|紧急不重要|不重要且不紧急|[SABCsabc])\s*[：:]?\s*/u, " ")
    .replace(/(^|[\s：:·•])[SABCsabc]\s*[：:]\s*/gu, "$1")
    .replace(/\s+/g, " ")
    .trim() || text;
}

/** 首页待办摘要：近两日范围已由数据层限定，只保留可执行事项本身。 */
export function formatHomeTodoSummary(text: string) {
  // 首页只承担一句话行动摘要；竖线后的 ID、工作线和补充说明都属于原件备注。
  const titleOnly = text.split(/[|｜]/u, 1)[0]?.trim() || text;
  const cleaned = stripTodoMetaPrefixes(titleOnly)
    .replace(/^(?:(?:待办|验收|复验|检查|测试|开发|方案|修正|修复|优化|新增|架构|接入|迁移|返工|复盘|内容准备)\s*[：:]\s*)+/u, "");
  return stripTaskDecorators(cleaned);
}

/** 剥离泳道前缀、类型标记、钟点备注与全部日期后的展示文案。标题应已说人话；这里只清残留杂质。 */
export function stripTaskDecorators(text: string) {
  const cleaned = stripTodoMetaPrefixes(text)
    .replace(new RegExp(TASK_META_RE.source, "gu"), " ")
    .replace(PENDING_DATE_LABEL_RE, "")
    .replace(SINCE_DATE_LABEL_RE, "")
    .replace(DATE_DAYPART_LABEL_RE, "")
    .replace(CLOCK_RANGE_RE, " ")
    .replace(new RegExp(ISO_DATE_DOT_TOKEN_RE.source, "gu"), " ")
    .replace(new RegExp(CHINESE_YEAR_MONTH_RANGE_RE.source, "gu"), " ")
    .replace(DATE_RANGE_RE, "")
    .replace(new RegExp(DATE_DOT_TOKEN_RE.source, "gu"), " ")
    .replace(new RegExp(DATE_SINGLE_RE.source, "gu"), " ")
    .replace(/\s+/g, " ")
    .trim();
  // 日期剥掉后可能露出「白天 ·」等时段备注，再清一次。
  return cleaned
    .replace(TIME_OF_DAY_LABEL_RE, "")
    .replace(PENDING_DATE_LABEL_RE, "")
    .replace(SINCE_DATE_LABEL_RE, "")
    .replace(TRAILING_META_PAREN_RE, "")
    .replace(/^[·•.]\s*/u, "")
    .replace(/[｜|]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || text;
}

export function parseTaskMeta(text: string) {
  let planId: string | null = null;
  let parentId: string | null = null;
  const dependencyIds: string[] = [];
  for (const match of text.matchAll(new RegExp(TASK_META_RE.source, "gu"))) {
    const key = match[1];
    const value = match[2].trim();
    if (!value) continue;
    if (key === "ID") planId = value;
    else if (key === "父级") parentId = value;
    else if (key === "依赖") {
      for (const id of value.split(/[,，\s]+/u).map((item) => item.trim()).filter(Boolean)) {
        if (!dependencyIds.includes(id)) dependencyIds.push(id);
      }
    }
  }
  return { planId, parentId, dependencyIds };
}

/** 例行：收集文案内全部 `M/D ·` 日期点。 */
export function parseRoutineDates(text: string, todayKey = tokyoDateKey()): string[] {
  const { year: defaultYear } = parseYmd(todayKey);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(new RegExp(DATE_DOT_TOKEN_RE.source, "gu"))) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    const year = resolveYear(month, day, match[1] ? Number(match[1]) : null, defaultYear, todayKey);
    const key = padDate(year, month, day);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys.sort(compareDateKeys);
}

export function parseTaskKind(text: string): { kind: TaskKind | null; explicit: boolean } {
  const withoutLane = text.replace(LANE_PREFIX_STRIP_RE, "");
  const match = withoutLane.match(KIND_LABEL_RE);
  if (match) {
    const label = match[1].replace(/\s*·\s*/gu, " · ");
    return { kind: KIND_MAP[label] ?? null, explicit: true };
  }
  return { kind: null, explicit: false };
}

/**
 * 推断类型：显式标记优先；否则有区间→span，有 · 单日→milestone，无日期→cadence。
 * 意向仅在显式「意向：」时成立；例行仅显式「例行：」。
 */
export function resolveTaskKind(text: string, span: DateSpan | null): TaskKind {
  const parsed = parseTaskKind(text);
  if (parsed.kind) return parsed.kind;
  if (span?.kind === "range") return "span";
  if (span?.kind === "single") return "milestone";
  return "cadence";
}

export function markerForKind(kind: TaskKind): AxisMarker {
  if (kind === "deadline") return "flag";
  if (kind === "gate") return "diamond";
  if (kind === "detail") return "dot";
  if (kind === "event" || kind === "milestone") return "star";
  if (kind === "span" || kind === "phase") return "bar";
  if (kind === "routine") return "dots";
  return "none";
}

export function familyForLane(laneId: LaneId): FamilyTone {
  return FAMILY_BY_LANE[laneId] ?? "mist";
}

export function buildLanes(mainlines: Mainline[]): GanttLane[] {
  const fromDoc = mainlines.filter((row) => row.item.trim());
  if (!fromDoc.length) {
    return [
      ...CANONICAL_LANE_DEFS.map((def) => ({
        id: def.id,
        label: def.label,
        tone: familyForLane(def.id),
        priority: "",
      })),
      OTHER_LANE,
    ];
  }

  const used = new Set<string>();
  const lanes: GanttLane[] = [];
  for (const row of fromDoc) {
    const def = CANONICAL_LANE_DEFS.find((item) => item.aliases.test(row.item))
      ?? CANONICAL_LANE_DEFS.find((item) => item.label === row.item);
    const id = def?.id ?? `mainline:${row.item}`;
    if (used.has(id)) continue;
    used.add(id);
    lanes.push({
      id,
      label: (def?.label ?? row.item.replace(/^《|》$/g, "").trim()) || row.item,
      tone: familyForLane(id),
      priority: row.priority,
    });
  }
  for (const def of CANONICAL_LANE_DEFS) {
    if (used.has(def.id)) continue;
    used.add(def.id);
    lanes.push({
      id: def.id,
      label: def.label,
      tone: familyForLane(def.id),
      priority: "",
    });
  }
  return [...lanes, OTHER_LANE];
}

export function assignLane(text: string, lanes: GanttLane[]): LaneId {
  const usable = lanes.length ? lanes : [OTHER_LANE];
  const has = (id: string) => usable.some((lane) => lane.id === id);

  for (const def of CANONICAL_LANE_DEFS) {
    if (def.prefixes.test(text)) {
      if (has(def.id)) return def.id;
    }
  }
  for (const def of CANONICAL_LANE_DEFS) {
    if (def.keywords.test(text)) {
      if (has(def.id)) return def.id;
    }
  }
  return OTHER_LANE.id;
}

export function resolveVisual(done: boolean, span: DateSpan | null, todayKey: string): BarVisual {
  if (done) return "done";
  if (!span) return "active";
  if (compareDateKeys(span.end, todayKey) < 0) return "overdue";
  if (compareDateKeys(span.start, todayKey) > 0) return "future";
  return "active";
}

function weekIndexForDate(weekStarts: string[], key: string) {
  const monday = startOfWeekMonday(key);
  const exact = weekStarts.indexOf(monday);
  if (exact >= 0) return exact;
  if (!weekStarts.length) return 0;
  if (compareDateKeys(monday, weekStarts[0]) < 0) return 0;
  return weekStarts.length - 1;
}

function dayIndexInWeek(weekStart: string, key: string) {
  const { year, month, day } = parseYmd(key);
  const { year: wy, month: wm, day: wd } = parseYmd(weekStart);
  const diff = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(wy, wm - 1, wd)) / 86_400_000);
  return Math.min(6, Math.max(0, diff));
}

/** 日在周内起点比例：周一 0 … 周日 6/7。 */
function fractionInWeek(weekStart: string, key: string) {
  return dayIndexInWeek(weekStart, key) / 7;
}

/** 含当天整天的开区间上界：周一结束 1/7 … 周日结束 1。 */
function endFractionInWeek(weekStart: string, key: string) {
  return (dayIndexInWeek(weekStart, key) + 1) / 7;
}

export function buildWeekColumns(weekStarts: string[]): WeekColumn[] {
  return weekStarts.map((start, index) => {
    const end = endOfWeekSunday(start);
    const { month } = parseYmd(start);
    const prev = index > 0 ? parseYmd(weekStarts[index - 1]) : null;
    const monthLabel = !prev || prev.month !== month ? `${month}月` : null;
    const days: WeekDayTick[] = [];
    for (let i = 0; i < 7; i += 1) {
      const key = addCalendarDays(start, i);
      const parts = parseYmd(key);
      const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
      days.push({ key, day: parts.day, weekday });
    }
    return {
      index,
      start,
      end,
      label: `W${index + 1}`,
      monthLabel,
      days,
    };
  });
}

export function buildGanttModel(input: {
  today?: TodoItem[] | Array<{ done: boolean; text: string }>;
  longTerm?: TodoItem[] | Array<{ done: boolean; text: string }>;
  mainlines?: Mainline[];
  todayKey?: string;
  minWeeks?: number;
  windowStartKey?: string;
  windowEndKey?: string;
}): GanttModel {
  const todayKey = input.todayKey ?? tokyoDateKey();
  const minWeeks = input.minWeeks ?? 8;
  const lanes = buildLanes(input.mainlines ?? []);
  const rawTasks: TodoItem[] = [
    ...(input.today ?? []).map((item) => ({ done: item.done, text: item.text, scope: "today" as const })),
    ...(input.longTerm ?? []).map((item) => ({ done: item.done, text: item.text, scope: "longTerm" as const })),
  ];

  type ParsedTask = Omit<GanttTask, "weekStart" | "weekEnd" | "dayOffset" | "dayEndOffset" | "depth" | "childCount">;
  const parsed: ParsedTask[] = [];
  const routineDrafts: Array<{
    item: TodoItem;
    index: number;
    dates: string[];
    laneId: LaneId;
    family: FamilyTone;
  }> = [];

  rawTasks.forEach((item, index) => {
    if (item.done) return;
    const kindHint = parseTaskKind(item.text).kind;
    if (kindHint === "intent" || kindHint === "cadence") return;

    if (kindHint === "routine") {
      const dates = parseRoutineDates(item.text, todayKey).filter((date) => input.windowStartKey
        ? date >= input.windowStartKey && (!input.windowEndKey || date <= input.windowEndKey) : !isStalePast(date, todayKey));
      if (!dates.length) return;
      const laneId = assignLane(item.text, lanes);
      routineDrafts.push({ item, index, dates, laneId, family: familyForLane(laneId) });
      return;
    }

    const span = parseTaskDates(item.text, todayKey);
    const kind = resolveTaskKind(item.text, span);
    if (kind === "intent" || kind === "cadence") return;
    if (!span) return;
    if (input.windowStartKey ? span.end < input.windowStartKey || Boolean(input.windowEndKey && span.start > input.windowEndKey) : isStalePast(span.end, todayKey)) return;

    let effectiveKind: TaskKind = kind;
    if ((kind === "event" || kind === "milestone" || kind === "deadline" || kind === "gate" || kind === "detail") && span.kind !== "single") {
      effectiveKind = span.kind === "range" ? "span" : "cadence";
    }
    if ((kind === "span" || kind === "phase") && span.kind !== "range") {
      effectiveKind = span.kind === "single" ? "milestone" : "cadence";
    }
    // 推断后仍无日期 → 当常驻/未想清，不进甘特
    if (effectiveKind === "cadence" || markerForKind(effectiveKind) === "none") return;

    const marker = markerForKind(effectiveKind);
    const onAxis = marker !== "none";
    const laneId = assignLane(item.text, lanes);
    const family = familyForLane(laneId);
    const visual = resolveVisual(item.done, span, todayKey);
    const meta = parseTaskMeta(item.text);

    parsed.push({
      id: `${item.scope}:${index}:${item.text}`,
      text: item.text,
      displayText: stripTaskDecorators(item.text),
      done: item.done,
      scope: item.scope,
      laneId,
      kind: effectiveKind,
      family,
      marker,
      planId: meta.planId,
      parentId: meta.parentId,
      dependencyIds: meta.dependencyIds,
      sourceOrder: index,
      onAxis,
      span,
      visual,
    });
  });

  let windowStart = startOfWeekMonday(input.windowStartKey ?? todayKey);
  let farthest = addCalendarDays(windowStart, minWeeks * 7 - 1);
  for (const task of parsed) {
    if (!task.span || !task.onAxis) continue;
    if (compareDateKeys(task.span.end, farthest) > 0) farthest = task.span.end;
  }
  for (const draft of routineDrafts) {
    for (const date of draft.dates) {
      if (compareDateKeys(date, farthest) > 0) farthest = date;
    }
  }
  farthest = input.windowEndKey ?? addCalendarDays(startOfWeekMonday(farthest), 7);
  const weekStarts: string[] = [];
  for (let cursor = windowStart; compareDateKeys(cursor, farthest) <= 0; cursor = addCalendarDays(cursor, 7)) {
    weekStarts.push(cursor);
    if (weekStarts.length >= 52) break;
  }
  while (weekStarts.length < minWeeks) {
    weekStarts.push(addCalendarDays(weekStarts[weekStarts.length - 1] ?? windowStart, 7));
  }

  const weeks = buildWeekColumns(weekStarts);
  const planIds = new Set(parsed.flatMap((task) => task.planId ? [task.planId] : []));
  const childCounts = new Map<string, number>();
  for (const task of parsed) {
    if (!task.parentId || !planIds.has(task.parentId)) continue;
    childCounts.set(task.parentId, (childCounts.get(task.parentId) ?? 0) + 1);
  }
  const tasks: GanttTask[] = parsed.map((task) => {
    const depth = task.parentId && planIds.has(task.parentId) ? 1 : 0;
    const childCount = task.planId ? childCounts.get(task.planId) ?? 0 : 0;
    if (!task.span) {
      return { ...task, depth, childCount, weekStart: 0, weekEnd: 0, dayOffset: 0, dayEndOffset: 0 };
    }
    const weekStart = weekIndexForDate(weekStarts, task.span.start);
    const weekEnd = weekIndexForDate(weekStarts, task.span.end);
    const startMonday = weekStarts[weekStart] ?? windowStart;
    const endMonday = weekStarts[weekEnd] ?? windowStart;
    const dayOffset = fractionInWeek(startMonday, task.span.start);
    const dayEndOffset = endFractionInWeek(endMonday, task.span.end);
    return { ...task, depth, childCount, weekStart, weekEnd: Math.max(weekStart, weekEnd), dayOffset, dayEndOffset };
  });

  const routines: GanttRoutineSeries[] = routineDrafts.map((draft) => {
    const laneId = draft.laneId;
    const family = familyForLane(laneId);
    const points = draft.dates.map((date) => {
      const weekIndex = weekIndexForDate(weekStarts, date);
      return {
        date,
        weekIndex,
        dayOffset: fractionInWeek(weekStarts[weekIndex] ?? windowStart, date),
        visual: resolveVisual(draft.item.done, { start: date, end: date, kind: "single", source: "explicit" }, todayKey),
      };
    });
    return {
      id: `routine:${draft.item.scope}:${draft.index}:${draft.item.text}`,
      text: draft.item.text,
      displayText: stripTaskDecorators(draft.item.text),
      done: draft.item.done,
      scope: draft.item.scope,
      family,
      laneId,
      points,
    };
  });

  const todayWeekIndex = weekIndexForDate(weekStarts, todayKey);
  const todayOffset = fractionInWeek(weekStarts[todayWeekIndex] ?? windowStart, todayKey);

  const laneOrder = new Map(lanes.map((lane, index) => [lane.id, index]));
  tasks.sort((a, b) => {
    const laneDiff = (laneOrder.get(a.laneId) ?? 999) - (laneOrder.get(b.laneId) ?? 999);
    if (laneDiff) return laneDiff;
    return a.sourceOrder - b.sourceOrder;
  });

  const usedLaneIds = new Set<string>([
    ...tasks.map((task) => task.laneId),
    ...routines.map((item) => item.laneId),
  ]);
  const visibleLanes = lanes.filter((lane) => usedLaneIds.has(lane.id));

  return {
    lanes: visibleLanes,
    tasks,
    routines,
    weeks,
    todayKey,
    todayOffset,
    todayWeekIndex,
  };
}

export function tasksForLane(model: GanttModel, laneId: LaneId) {
  return model.tasks.filter((task) => task.laneId === laneId);
}

/** 区间条按日定位：起点=起始日 0:00，终点=结束日 24:00（含当天）。 */
export function barStyle(task: GanttTask, weekCount: number) {
  const weeks = Math.max(weekCount, 1);
  const daySpan = 1 / 7;
  const start = Math.max(0, Math.min(weeks, task.weekStart + task.dayOffset));
  const end = Math.max(start + daySpan, Math.min(weeks, task.weekEnd + task.dayEndOffset));
  const left = (start / weeks) * 100;
  const width = ((end - start) / weeks) * 100;
  return { left: `${left}%`, width: `${width}%` };
}

/** 单日标记落在当日中点。 */
export function milestoneStyle(task: GanttTask, weekCount: number) {
  const weeks = Math.max(weekCount, 1);
  const weekIndex = Math.max(0, Math.min(weeks - 1, task.weekStart));
  const left = ((weekIndex + task.dayOffset + 0.5 / 7) / weeks) * 100;
  return { left: `${left}%` };
}

/** 例行点定位（与里程碑同一套：当日中点）。 */
export function routinePointStyle(point: { weekIndex: number; dayOffset: number }, weekCount: number) {
  const weeks = Math.max(weekCount, 1);
  const weekIndex = Math.max(0, Math.min(weeks - 1, point.weekIndex));
  const left = ((weekIndex + point.dayOffset + 0.5 / 7) / weeks) * 100;
  return { left: `${left}%` };
}

function monthKey(key: string) {
  return key.slice(0, 7);
}

function monthStart(key: string) {
  return `${monthKey(key)}-01`;
}

function addCalendarMonths(key: string, count: number) {
  const { year, month } = parseYmd(key);
  const date = new Date(Date.UTC(year, month - 1 + count, 1));
  return padDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function daysInCalendarMonth(key: string) {
  const start = monthStart(key);
  return Math.round((Date.parse(`${addCalendarMonths(start, 1)}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/** 月度路线图：从当月到最远任务的下一月，最多 24 个月。 */
export function buildRoadmapMonths(tasks: GanttTask[], todayKey = tokyoDateKey(), minMonths = 6, endKey?: string): RoadmapMonth[] {
  const start = monthStart(todayKey);
  let farthest = addCalendarMonths(start, Math.max(1, minMonths) - 1);
  for (const task of tasks) {
    if (task.span && compareDateKeys(task.span.end, farthest) > 0) farthest = task.span.end;
  }
  const endMonth = monthStart(endKey ?? farthest);
  const months: RoadmapMonth[] = [];
  for (let cursor = start; compareDateKeys(cursor, endMonth) <= 0 && months.length < 24; cursor = addCalendarMonths(cursor, 1)) {
    const parts = parseYmd(cursor);
    const next = addCalendarMonths(cursor, 1);
    months.push({
      key: cursor.slice(0, 7),
      start: cursor,
      end: addCalendarDays(next, -1),
      label: `${parts.month}月`,
      yearLabel: parts.month === 1 || months.length === 0 ? `${parts.year}` : null,
    });
  }
  return months;
}

function roadmapPosition(key: string, months: RoadmapMonth[], includeDayEnd = false) {
  if (!months.length) return 0;
  if (compareDateKeys(key, months[0].start) < 0) return 0;
  if (compareDateKeys(key, months[months.length - 1].end) > 0) return months.length;
  const targetMonth = monthKey(key);
  const index = months.findIndex((month) => month.key === targetMonth);
  if (index < 0) return 0;
  const day = parseYmd(key).day;
  const fraction = (day - 1 + (includeDayEnd ? 1 : 0)) / daysInCalendarMonth(key);
  return Math.max(0, Math.min(months.length, index + fraction));
}

export function roadmapBarStyle(task: GanttTask, months: RoadmapMonth[]) {
  if (!task.span) return { left: "0%", width: "0%" };
  const count = Math.max(months.length, 1);
  const start = roadmapPosition(task.span.start, months);
  const end = Math.max(start + 0.02, roadmapPosition(task.span.end, months, true));
  return { left: `${(start / count) * 100}%`, width: `${((end - start) / count) * 100}%` };
}

export function roadmapPointStyle(task: GanttTask, months: RoadmapMonth[]) {
  if (!task.span) return { left: "0%" };
  return { left: `${roadmapDateCenterLeft(task.span.start, months)}%` };
}

export function roadmapDateLeft(key: string, months: RoadmapMonth[]) {
  const count = Math.max(months.length, 1);
  return (roadmapPosition(key, months) / count) * 100;
}

/** 路线图虽按月分格，点状标记仍保留真实日期，并落在当日中点。 */
export function roadmapDateCenterLeft(key: string, months: RoadmapMonth[]) {
  const count = Math.max(months.length, 1);
  const point = roadmapPosition(key, months) + 0.5 / daysInCalendarMonth(key);
  return Math.min(100, Math.max(0, (point / count) * 100));
}

export function roadmapDependencyStyle(task: GanttTask, dependency: GanttTask, months: RoadmapMonth[]) {
  if (!task.span || !dependency.span || !months.length) return null;
  const from = roadmapPosition(dependency.span.end, months, true);
  const to = roadmapPosition(task.span.start, months);
  if (to <= from) return null;
  return { left: `${(from / months.length) * 100}%`, width: `${((to - from) / months.length) * 100}%` };
}
