import type { CalendarEvent } from "../../types";
import { roadmapDateCenterLeft, tokyoDateKey, type GanttTask, type RoadmapMonth } from "../../gantt-model.ts";

export const LIFE_EVENT_CATEGORIES = [
  { id: "leisure", label: "游玩娱乐" },
  { id: "travel", label: "出行安排" },
  { id: "other", label: "其他事务" },
] as const;

export type LifeEventCategoryId = typeof LIFE_EVENT_CATEGORIES[number]["id"];
export type LifeEventGroup = typeof LIFE_EVENT_CATEGORIES[number] & { events: CalendarEvent[] };
export type CalendarLaneId = "company" | "life";
export type CompanyEventCategoryId = "industry" | "travel";
export type CalendarEventPlacement = { laneId: "company"; categoryId: CompanyEventCategoryId } | { laneId: "life"; categoryId: LifeEventCategoryId };
export type CompanyTravelGroup = { id: string; task: GanttTask; events: CalendarEvent[] };

/** 游玩不超过三项时直接摊开；其它分类默认收起，用户仍可手动切换。 */
export function lifeCategoryDefaultOpen(group: Pick<LifeEventGroup, "id" | "events">) {
  return group.id === "leisure" && group.events.length <= 3;
}

export function lifeCategoryIsOpen(
  group: Pick<LifeEventGroup, "id" | "events">,
  expanded: Record<string, boolean>,
) {
  return expanded[group.id] ?? lifeCategoryDefaultOpen(group);
}

/** 泳道都打开、但生活分类或差旅仍收着时，一键按钮应继续显示「展开」。 */
export function ganttExpandAllShouldShow(
  allLanesCollapsed: boolean,
  lifeGroups: Array<Pick<LifeEventGroup, "id" | "events">>,
  lifeExpanded: Record<string, boolean>,
  travelGroupIds: string[],
  travelExpanded: Record<string, boolean>,
) {
  if (allLanesCollapsed) return true;
  const lifeOpen = lifeGroups.every((group) => lifeCategoryIsOpen(group, lifeExpanded));
  const travelOpen = travelGroupIds.every((id) => Boolean(travelExpanded[id]));
  return !(lifeOpen && travelOpen);
}

const INDUSTRY_PATTERN = /Tokyo Indies|Tokyo Game Dungeon|东京游戏地牢|東京ゲームダンジョン|BitSummit|TGS|もくもく|AIDD|MERGE|行业活动|行业交流|業界|开发者大会|開発者大会|游戏交流会|遊戲交流會|ゲーム交流会|游戏展|遊戲展|ゲームショウ|カンファレンス|meetup/i;
const COMPANY_TRAVEL_PATTERN = /航班|飞机|飛機|机场|機場|羽田|成田|浦东|浦東|虹桥|虹橋|新干线|新幹線|列车|列車|铁路|鉄道|酒店|旅馆|旅館|住宿|入住|退房|出差|差旅|商务旅行|商務旅行|flight|airport|hotel|check.?in|check.?out/i;
const GAME_RELEASE_PATTERN = /游戏发售/i;
const LEISURE_PATTERN = /电影|電影|映画|影院|シネマ|バルト|TOHO|PG\d{1,2}|剧场|劇場|观影|観劇|展览|展覧|美术馆|美術館|博物馆|博物館|演出|演唱会|演唱會|音乐会|音樂會|ライブ|コンサート|游乐|遊園地|乐园|樂園|公园|公園|温泉|观赛|観戦|聚餐|吃饭|吃飯|早饭|早飯|午餐|晚餐|约饭|約飯|食事|ランチ|ディナー|朋友|同学|同學|聚会|聚會|见面|見面|会面|會面|飲み会|旅行|旅游|旅遊|郊游|郊遊/i;
const PERSONAL_TRAVEL_PATTERN = /出行安排|个人出行|個人出行|接送|接人|送人|接机|接機|送机|送機|取车|取車|还车|還車|打车|打車/i;

export function calendarEventKind(event: Pick<CalendarEvent, "title">) {
  return GAME_RELEASE_PATTERN.test(event.title) ? "游戏" : "事件";
}

function isScheduleTitleTimePart(part: string) {
  const text = part.trim();
  if (!text) return true;
  if (/正式开始|到场|入场/.test(text) && /\d{1,2}:\d{2}/.test(text)) return true;
  if (/^\d{1,2}:\d{2}/.test(text) && /集合|到场|入场|正式开始/.test(text)) return true;
  if (/^正式开始/.test(text)) return true;
  if (/集合/.test(text) && /\d{1,2}:\d{2}/.test(text)) return true;
  return false;
}

function normalizeScheduleMatchText(value: string) {
  return value.toLowerCase().replace(/[\s　、,，.。:：;；+\-—_《》「」『』（）()]/gu, "");
}

/** 甘特列表只保留事项内容；到场、正式开始和钟点仍留在原标题与悬停里。 */
export function calendarEventListTitle(title: string) {
  const stripped = String(title || "").replace(/^\s*游戏发售\s*/u, "").trim();
  const parts = stripped.split(/[｜|]/u).map((part) => part.trim()).filter(Boolean);
  const kept = parts.filter((part) => !isScheduleTitleTimePart(part));
  return (kept.join("｜") || stripped || String(title || "").trim())
    .replace(/\s*\d{1,2}:\d{2}\s*/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type CalendarEventLinkCatalog = {
  playbooks?: Array<{ id: string; name: string; shareName?: string }>;
};

function playbookNameScore(title: string, playbook: { name: string; shareName?: string }) {
  const listTitle = calendarEventListTitle(title);
  const needle = normalizeScheduleMatchText(listTitle);
  const first = normalizeScheduleMatchText(listTitle.split("｜")[0] || listTitle);
  let score = 0;
  for (const label of [playbook.name, playbook.shareName]) {
    if (!label) continue;
    const hay = normalizeScheduleMatchText(label);
    const hayFirst = normalizeScheduleMatchText(label.split(/[｜|]/u)[0] || label);
    if (first.length >= 4 && (hay.includes(first) || (hayFirst.length >= 4 && first.includes(hayFirst)))) {
      score = Math.max(score, Math.min(first.length, hayFirst.length || first.length));
    } else if (needle.length >= 4 && (hay.includes(needle) || needle.includes(hay))) {
      score = Math.max(score, Math.min(needle.length, hay.length));
    }
  }
  return score;
}

/** 游戏发售进新品发售；对得上攻略的活动进本地活动。时间仍以苹果日历为原件。 */
export function calendarEventHref(title: string, catalog: CalendarEventLinkCatalog = {}): string | null {
  const raw = String(title || "").trim();
  if (!raw) return null;
  if (GAME_RELEASE_PATTERN.test(raw)) {
    const query = calendarEventListTitle(raw).replace(/[《》「」『』]/gu, "").trim();
    return `/schedule?view=releases${query ? `&q=${encodeURIComponent(query)}` : ""}`;
  }
  let best: { id: string; score: number } | null = null;
  for (const playbook of catalog.playbooks || []) {
    const score = playbookNameScore(raw, playbook);
    if (score >= 4 && (!best || score > best.score)) best = { id: playbook.id, score };
  }
  return best ? `/schedule?view=local&guide=${encodeURIComponent(best.id)}` : null;
}

export function calendarEventPlacement(event: CalendarEvent): CalendarEventPlacement {
  const text = `${event.title} ${event.calendar}`;
  if (GAME_RELEASE_PATTERN.test(text)) return { laneId: "life", categoryId: "leisure" };
  if (INDUSTRY_PATTERN.test(text)) return { laneId: "company", categoryId: "industry" };
  if (COMPANY_TRAVEL_PATTERN.test(text)) return { laneId: "company", categoryId: "travel" };
  if (LEISURE_PATTERN.test(text)) return { laneId: "life", categoryId: "leisure" };
  if (PERSONAL_TRAVEL_PATTERN.test(text)) return { laneId: "life", categoryId: "travel" };
  return { laneId: "life", categoryId: "other" };
}

export function calendarEventsByLane(events: CalendarEvent[]) {
  const lanes: Record<CalendarLaneId, CalendarEvent[]> = { company: [], life: [] };
  for (const event of events) lanes[calendarEventPlacement(event).laneId].push(event);
  return lanes;
}

function normalizeScheduleCoverKey(value: string) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

/** 例行行已经覆盖的行业活动，不再另画苹果日历副本；把例行藏起时也不要把这些副本翻出来。 */
export function calendarEventsNotCoveredByRoutines(
  events: CalendarEvent[],
  routines: Array<{ displayText?: string }>,
) {
  const routineKeys = routines
    .map((series) => normalizeScheduleCoverKey(String(series.displayText || "")))
    .filter(Boolean);
  if (!routineKeys.length) return Array.isArray(events) ? events : [];
  return (Array.isArray(events) ? events : []).filter((event) => {
    const eventTitle = normalizeScheduleCoverKey(event?.title);
    if (!eventTitle) return true;
    return !routineKeys.some((routineTitle) => eventTitle.includes(routineTitle) || routineTitle.includes(eventTitle));
  });
}

const COMPANY_TRAVEL_PARENT_PATTERN = /差旅|出差|商务旅行|商務旅行|business\s*trip/i;

/**
 * 把 Apple Calendar 中的航班／机场／住宿事件挂回同一时间窗内的差旅父项。
 * 只建立派生关系，不修改待办或日历原件；多个差旅重叠时优先匹配较短、较具体的时间窗。
 */
export function groupCompanyTravel(tasks: GanttTask[], events: CalendarEvent[]) {
  const candidates = tasks.filter((task) => task.laneId === "company"
    && task.span?.kind === "range"
    && COMPANY_TRAVEL_PARENT_PATTERN.test(`${task.text} ${task.displayText}`));
  const grouped = new Map<string, CalendarEvent[]>();
  const assignedEventKeys = new Set<string>();

  for (const event of events) {
    if (calendarEventPlacement(event).categoryId !== "travel") continue;
    const days = eventDays(event);
    const parent = candidates
      .filter((task) => task.span && days.start <= task.span.end && days.end >= task.span.start)
      .sort((left, right) => {
        const leftDays = Date.parse(`${left.span!.end}T00:00:00Z`) - Date.parse(`${left.span!.start}T00:00:00Z`);
        const rightDays = Date.parse(`${right.span!.end}T00:00:00Z`) - Date.parse(`${right.span!.start}T00:00:00Z`);
        return leftDays - rightDays || left.sourceOrder - right.sourceOrder;
      })[0];
    if (!parent) continue;
    const rows = grouped.get(parent.id) ?? [];
    rows.push(event);
    grouped.set(parent.id, rows);
    assignedEventKeys.add(eventKey(event));
  }

  const groups: CompanyTravelGroup[] = candidates.flatMap((task) => {
    const rows = grouped.get(task.id);
    return rows?.length ? [{ id: `travel:${task.id}`, task, events: rows }] : [];
  });
  const groupedTaskIds = new Set(groups.map((group) => group.task.id));
  return {
    groups,
    tasks: tasks.filter((task) => !groupedTaskIds.has(task.id)),
    events: events.filter((event) => !assignedEventKeys.has(eventKey(event))),
  };
}

/** 折叠与展开都保留真实日期位置；不同横排只改变纵向所属行。 */
export function calendarMarkerStackOffsets(events: CalendarEvent[], mode: "roadmap" | "weeks") {
  void mode;
  return events.map(() => ({ x: 0, y: 0 }));
}

export function groupLifeEvents(events: CalendarEvent[]): LifeEventGroup[] {
  const grouped = new Map<LifeEventCategoryId, CalendarEvent[]>();
  for (const event of events) {
    const placement = calendarEventPlacement(event);
    if (placement.laneId !== "life") continue;
    const id = placement.categoryId;
    const rows = grouped.get(id) ?? [];
    rows.push(event);
    grouped.set(id, rows);
  }
  return LIFE_EVENT_CATEGORIES.flatMap((category) => {
    const rows = grouped.get(category.id);
    return rows?.length ? [{ ...category, events: rows }] : [];
  });
}

export function shiftMonth(month: string, offset: number) {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function calendarRange(month: string) {
  const from = `${month}-01T00:00:00+09:00`;
  const to = `${shiftMonth(month, 6)}-01T00:00:00+09:00`;
  return { from, to, firstDay: from.slice(0, 10), lastDay: tokyoDateKey(new Date(Date.parse(to) - 1)) };
}

export const eventKey = (event: CalendarEvent) => JSON.stringify([event.calendar, event.id, event.start]);

export function lifeEvents(events: CalendarEvent[], from: string, to: string) {
  const seen = new Set<string>();
  return events.filter((event) => {
    // Holiday evidence belongs to health, not the user's itinerary. Keep recurring occurrences distinct.
    if (/生日|Birthdays|节假日|Holidays|祝日/i.test(event.calendar)) return false;
    if (!(Date.parse(event.start) < Date.parse(to) && Date.parse(event.end) > Date.parse(from))) return false;
    const key = eventKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title));
}

export function eventDays(event: CalendarEvent) {
  return { start: tokyoDateKey(event.start), end: tokyoDateKey(new Date(Date.parse(event.end) - 1)) };
}

export function eventAxisPointStyle(event: CalendarEvent, months: RoadmapMonth[], firstWeek: string, weekCount: number, mode: string) {
  const days = eventDays(event);
  const position = (key: string) => mode === "roadmap" ? roadmapDateCenterLeft(key, months)
    : ((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${firstWeek}T00:00:00Z`)) / 86400000 + 0.5) / (weekCount * 7) * 100;
  return { left: `${Math.min(100, Math.max(0, position(days.start)))}%` };
}

export function tokyoInput(instant: string) {
  return new Date(Date.parse(instant) + 9 * 3600000).toISOString().slice(0, 16);
}

export function eventTimeLabel(event: CalendarEvent) {
  const start = tokyoInput(event.start).replace("T", " ");
  const end = tokyoInput(event.end).replace("T", " ");
  const days = eventDays(event);
  return event.allDay ? `${days.start}${days.end !== days.start ? ` — ${days.end}` : ""} · 全天`
    : `${start} — ${start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end}`;
}

/** 航班行程优先显示日历标题中的当地时间；没有写时间时使用东京开始时间。 */
export function companyTravelEventLabel(event: CalendarEvent) {
  const title = event.title.trim();
  const match = title.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/u);
  if (!match || match.index === undefined) return `${tokyoInput(event.start).slice(11)} ${title}`;
  const before = title.slice(0, match.index).trimEnd();
  const after = title.slice(match.index + match[0].length).trimStart();
  const separator = /[A-Za-z0-9]$/u.test(before) && /^[A-Za-z0-9]/u.test(after) ? " " : "";
  return `${match[0]} ${before}${separator}${after}`.trim();
}
