import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { tokyoDateKey } from "../tokyo-time.mjs";
import { readNativeCalendar, readNativeCalendarStatus } from "./workbench-calendar-native.mjs";

const execFileAsync = promisify(execFile);
const TTL = 10 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE = "calendar-window.json";

const calendarReadsInFlight = new Map();
const cacheGenerations = new Map();
let activeCacheDir = null;

export { tokyoDateKey };

/** 已确认：展示全部可编辑普通日历；仅排除生日 / 节假日类系统日历与只读订阅。 */
export const BLOCKED_CALENDAR_PATTERN = /生日|Birthdays|节假日|Holidays|祝日/i;
const HOLIDAY_CALENDAR_PATTERN = /节假日|Holidays|祝日/i;

/** 提醒事项列表可能出现在 Calendar 可读集合中，但不能用 Event 创建写入。 */
export const REMINDER_CALENDAR_PATTERN = /计划的提醒|Scheduled Reminders|^Reminders$|提醒事项/i;

export function isEditableWorkCalendar(name, writable = true) {
  return Boolean(writable) && !BLOCKED_CALENDAR_PATTERN.test(String(name || ""));
}

export function isCreatableEventCalendar(name) {
  const text = String(name || "");
  return isEditableWorkCalendar(text, true) && !REMINDER_CALENDAR_PATTERN.test(text);
}

export function creatableEventCalendars(names = []) {
  return [...new Set(names.map((name) => String(name || "").trim()).filter(isCreatableEventCalendar))];
}

export function preferredEventCalendar(names = []) {
  const list = creatableEventCalendars(names);
  return list.find((name) => name === "个人") || list[0] || "个人";
}

export function resolveCreatableEventCalendar(requested, names = []) {
  const list = creatableEventCalendars(names);
  const wanted = String(requested || "").trim();
  if (wanted && isCreatableEventCalendar(wanted) && (!list.length || list.includes(wanted))) return wanted;
  return preferredEventCalendar(list.length ? list : names);
}

export function osCalendarEnabled(env = process.env) {
  return env.INFANS_CALENDAR_OS === "1";
}

export function instanceCalendarCacheDir(vaultRoot) {
  return path.join(vaultRoot, "00_本地工作台", "派生数据", "calendar-cache");
}

export function defaultCalendarCacheDir() {
  throw new Error("操作系统日历必须使用实例缓存目录，禁止回落到共享 HOME 缓存");
}

function cacheFilePath(cacheDir) {
  return path.join(cacheDir, CACHE_FILE);
}

function windowKey(from, to) {
  return `${from.toISOString()}|${to.toISOString()}`;
}

function normalizeReadOptions(optionsOrRunner) {
  if (typeof optionsOrRunner === "function") return { reader: optionsOrRunner };
  return optionsOrRunner && typeof optionsOrRunner === "object" ? optionsOrRunner : {};
}

async function runJxa(script, args = [], options = {}) {
  return execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, "--", ...args], { timeout: 90000, maxBuffer: 1024 * 1024, ...options });
}

function calendarFailureSnapshot(error) {
  const message = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
  const denied = /not authorized|不允许|拒绝|1743|permission/i.test(message);
  return {
    available: false,
    permission: denied ? "denied" : "unknown",
    calendars: [],
    events: [],
    message: denied ? "请在系统设置的日历权限中允许小秘书读取日程。" : "暂时读不到苹果日历。",
  };
}

async function performCalendarRead(from, to, reader) {
  if (process.platform !== "darwin") return { available: false, permission: "unknown", backend: "eventkit", calendars: [], events: [], message: "苹果日历仅能在 macOS 使用" };
  try {
    const data = await reader(from, to);
    return { ...data, events: [...(data.events ?? [])].sort((a, b) => a.start.localeCompare(b.start)) };
  } catch (error) {
    return { ...calendarFailureSnapshot(error), backend: "eventkit", message: error.message || "暂时读不到原生日历。" };
  }
}

export async function readDiskCalendarSnapshot(cacheDir) {
  if (!cacheDir) throw new Error("操作系统日历必须使用实例缓存目录");
  try {
    const raw = await fs.readFile(cacheFilePath(cacheDir), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    if (!parsed?.value || typeof parsed.value !== "object") return null;
    if (!parsed.from || !parsed.to || !parsed.generatedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDiskCalendarSnapshot(cacheDir, from, to, value, generatedAt = new Date()) {
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const payload = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    from: from.toISOString(),
    to: to.toISOString(),
    backend: value.backend ?? "eventkit",
    generatedAt: generatedAt.toISOString(),
    value,
  };
  const target = cacheFilePath(cacheDir);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function decorateSnapshot(value, { stale, refreshedAt }) {
  return {
    ...value,
    source: "Calendar",
    backend: value.backend ?? "eventkit",
    refreshedAt: refreshedAt ?? value.refreshedAt ?? new Date().toISOString(),
    stale: Boolean(stale),
  };
}

async function persistSuccessfulRead(from, to, raw, cacheDir, generatedAt = new Date()) {
  const refreshedAt = generatedAt.toISOString();
  const value = decorateSnapshot({ ...raw, refreshedAt }, { stale: false, refreshedAt });
  await writeDiskCalendarSnapshot(cacheDir, from, to, value, generatedAt);
  return value;
}

async function syncCalendarRead(from, to, reader, cacheDir, generatedAt = new Date()) {
  const generation = cacheGenerations.get(cacheDir) ?? 0;
  const key = `${cacheDir}\n${generation}\n${windowKey(from, to)}`;
  if (calendarReadsInFlight.has(key)) return calendarReadsInFlight.get(key);

  const promise = performCalendarRead(from, to, reader)
    .then(async (raw) => {
      if (!raw.available) return decorateSnapshot(raw, { stale: false, refreshedAt: generatedAt.toISOString() });
      if ((cacheGenerations.get(cacheDir) ?? 0) !== generation) return decorateSnapshot(raw, { stale: true, refreshedAt: generatedAt.toISOString() });
      return persistSuccessfulRead(from, to, raw, cacheDir, generatedAt);
    })
    .finally(() => {
      if (calendarReadsInFlight.get(key) === promise) calendarReadsInFlight.delete(key);
    });
  calendarReadsInFlight.set(key, promise);
  return promise;
}

async function waitForOptionalCalendar(read, maxWaitMs, now) {
  const unavailable = decorateSnapshot({
    ...calendarFailureSnapshot(null),
    message: "日历仍在读取，暂不计入日历补充信息。",
  }, { stale: true, refreshedAt: now.toISOString() });
  let timer;
  try {
    // 不取消共享读取：后台成功后仍保存快照，下次读取可直接使用。
    return await Promise.race([
      read.catch(() => unavailable),
      new Promise((resolve) => { timer = setTimeout(() => resolve(unavailable), maxWaitMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cache first; native change revision invalidates freshness without erasing the last success. */
export async function readAppleCalendar(from, to, optionsOrRunner) {
  const options = normalizeReadOptions(optionsOrRunner);
  const osEnabled = options.osEnabled ?? osCalendarEnabled();
  if (!osEnabled) {
    return {
      available: false,
      permission: "disabled",
      backend: "none",
      calendars: [],
      events: [],
      message: "未启用操作系统日历。",
    };
  }
  if (!(from instanceof Date) || !(to instanceof Date) || !Number.isFinite(+from) || !Number.isFinite(+to)
    || to <= from || to - from > 366 * 86400000) throw new Error("日历读取日期范围无效");
  const cacheDir = options.cacheDir;
  if (!cacheDir) throw new Error("操作系统日历必须使用实例缓存目录");
  const reader = options.reader ?? ((start, end) => readNativeCalendar(start, end, { cacheDir }));
  const force = Boolean(options.force);
  const now = options.now instanceof Date ? options.now : new Date();
  activeCacheDir = cacheDir;
  const disk = await readDiskCalendarSnapshot(cacheDir);
  const nativeStatus = options.reader ? null : await readNativeCalendarStatus(cacheDir);
  if (nativeStatus?.permission === "denied") return {
    available: false, permission: "denied", backend: "eventkit", calendars: [], events: [],
    message: "请在系统设置的日历权限中允许小秘书读取日程。",
  };
  let readFrom = from;
  let readTo = to;
  if (!options.reader) {
    // All regular consumers share a window: health history, today's appointments and upcoming weeks.
    const anchor = Date.parse(`${tokyoDateKey(now)}T00:00:00+09:00`);
    const start = Math.min(+from, anchor - 31 * 86400000);
    const end = Math.max(+to, anchor + 90 * 86400000);
    if (end - start <= 366 * 86400000) { readFrom = new Date(start); readTo = new Date(end); }
  }
  if (!force && disk?.value?.available) {
    const coversWindow = new Date(disk.from) <= from && new Date(disk.to) >= to;
    const sameDay = tokyoDateKey(disk.generatedAt) === tokyoDateKey(now);
    const currentBackend = disk.value.backend === "eventkit";
    const sameRevision = options.reader || (nativeStatus && disk.value.revision === nativeStatus.revision);
    if (sameDay && coversWindow && currentBackend && sameRevision && !disk.invalidated) {
      return decorateSnapshot(disk.value, { stale: false, refreshedAt: disk.value.refreshedAt ?? disk.generatedAt });
    }
    void syncCalendarRead(readFrom, readTo, reader, cacheDir, now).catch(() => {});
    return decorateSnapshot(disk.value, { stale: true, refreshedAt: disk.value.refreshedAt ?? disk.generatedAt });
  }
  const read = syncCalendarRead(readFrom, readTo, reader, cacheDir, now);
  if (!force && Number.isFinite(options.maxWaitMs) && options.maxWaitMs >= 0) {
    return waitForOptionalCalendar(read, options.maxWaitMs, now);
  }
  return read;
}

export async function readCachedCalendarNames(cacheDir) {
  if (!cacheDir) throw new Error("操作系统日历必须使用实例缓存目录");
  const disk = await readDiskCalendarSnapshot(cacheDir);
  const names = Array.isArray(disk?.value?.calendars) ? disk.value.calendars.map((name) => String(name)) : [];
  return names.filter(Boolean);
}

/** 仅返回可创建 Event 的日历名，供 AI / 写入路径使用。 */
export async function readCachedCreatableCalendarNames(cacheDir) {
  if (!cacheDir) throw new Error("操作系统日历必须使用实例缓存目录");
  return creatableEventCalendars(await readCachedCalendarNames(cacheDir));
}

export async function invalidateAppleCalendarCache(cacheDir) {
  if (!cacheDir) throw new Error("操作系统日历必须使用实例缓存目录");
  cacheGenerations.set(cacheDir, (cacheGenerations.get(cacheDir) ?? 0) + 1);
  const disk = await readDiskCalendarSnapshot(cacheDir);
  if (!disk) return;
  const target = cacheFilePath(cacheDir);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ ...disk, invalidated: true })}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

function normalizeCalendarAction(action) {
  if (!action || !["create", "update", "delete"].includes(action.kind)) throw new Error("不支持的日历操作");
  const result = { kind: action.kind, id: String(action.id ?? ""), calendar: String(action.calendar ?? "").trim(), title: String(action.title ?? "").trim(), start: String(action.start ?? ""), end: String(action.end ?? ""), allDay: Boolean(action.allDay) };
  if (result.kind !== "delete") {
    if (!result.calendar || !result.title || !result.start || !result.end) throw new Error("日历、标题和起止时间不能为空");
    if (result.title.length > 180) throw new Error("日程标题过长");
    if (!(new Date(result.start) < new Date(result.end))) throw new Error("结束时间必须晚于开始时间");
  }
  if (result.kind === "create" && REMINDER_CALENDAR_PATTERN.test(result.calendar)) {
    throw new Error("「计划的提醒事项」不能创建日历事件；请改用「个人」等普通日历。");
  }
  if (result.kind === "create" && !isCreatableEventCalendar(result.calendar)) {
    throw new Error(`日历「${result.calendar}」不支持创建事件`);
  }
  if (result.kind !== "create" && !result.id) throw new Error("缺日程编号");
  if (result.kind !== "create") {
    const expected = action.expected;
    if (!expected || expected.id !== result.id || !expected.calendar || !expected.title
      || !Number.isFinite(Date.parse(expected.start)) || !Number.isFinite(Date.parse(expected.end))) throw new Error("缺少原日程快照，请刷新后重试");
    if (!expected.editable || expected.recurring || result.id.startsWith("eventkit:") || !isCreatableEventCalendar(expected.calendar)) throw new Error("此日程只读，不能修改或删除");
    if (result.calendar && result.calendar !== expected.calendar) throw new Error("暂不支持跨日历移动");
    result.calendar = expected.calendar;
    result.expected = { id: expected.id, calendar: expected.calendar, title: expected.title, start: expected.start, end: expected.end, allDay: Boolean(expected.allDay) };
  }
  return result;
}

function mutationScript(action) {
  const payload = JSON.stringify(action);
  return String.raw`
  function run() {
    const p = ${payload};
    const app = Application('/System/Applications/Calendar.app');
    if (p.kind === 'create') {
      const matches = app.calendars.whose({name: p.calendar})();
      if (!matches || !matches.length) throw new Error('找不到目标日历');
      if (matches.length !== 1) throw new Error('日历名称不唯一，请先核对来源');
      const c = matches[0];
      const duplicates = c.events.whose({summary:p.title})();
      for (let i=0;i<duplicates.length;i++) {
        const e = duplicates[i];
        if (+e.startDate() === +new Date(p.start) && +e.endDate() === +new Date(p.end) && e.alldayEvent() === p.allDay)
          return JSON.stringify({ok:true, id:e.uid(), existing:true});
      }
      const e = app.Event({ summary: p.title, startDate: new Date(p.start), endDate: new Date(p.end), alldayEvent: p.allDay });
      c.events.push(e); return JSON.stringify({ok:true, id:e.uid()});
    }
    const all = app.calendars.whose({name:p.expected.calendar})();
    if (all.length !== 1) throw new Error('日历名称不唯一或来源已变，请先刷新');
    for (let i=0;i<all.length;i++) {
      let found = all[i].events.whose({uid:p.id})();
      // EventKit external identifiers are not necessarily Calendar.app UIDs (verified on iCloud).
      // The native identity is checked immediately before this script. Resolve its exact snapshot,
      // never the title alone; ambiguity fails closed and no other event is touched.
      if (!found.length) found = all[i].events.whose({summary:p.expected.title})().filter(function(e) {
        return +e.startDate() === +new Date(p.expected.start) && +e.endDate() === +new Date(p.expected.end)
          && e.alldayEvent() === p.expected.allDay;
      });
      if (!found.length) continue;
      if (found.length !== 1) throw new Error('日程编号不唯一，请先刷新');
      const e = found[0];
      if (e.recurrence()) throw new Error('重复日程请在苹果日历中修改');
      if (e.summary() !== p.expected.title || +e.startDate() !== +new Date(p.expected.start)
        || +e.endDate() !== +new Date(p.expected.end) || e.alldayEvent() !== p.expected.allDay)
        throw new Error('日程已在别处修改，请刷新后重新预览');
      if (p.kind === 'delete') { app.delete(e); return JSON.stringify({ok:true}); }
      e.summary = p.title; e.startDate = new Date(p.start); e.endDate = new Date(p.end); e.alldayEvent = p.allDay;
      return JSON.stringify({ok:true, id:e.uid()});
    }
    throw new Error('没有找到日程');
  }`;
}

function tidyCalendarWriteError(error, action) {
  const message = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
  if (/计划的提醒|1728|不能获取对象|找不到目标日历/i.test(message)) {
    return new Error(`无法写入日历「${action?.calendar || ""}」。请改用「个人」等普通事件日历（当前不支持提醒事项列表）。`);
  }
  if (/重复日程/i.test(message)) return new Error("重复日程请在苹果日历中修改");
  if (/没有找到日程/i.test(message)) return new Error("没有找到日程");
  if (/日程已在别处修改/i.test(message)) return new Error("日程已在别处修改，请刷新后重新预览");
  if (/不唯一|来源已变/i.test(message)) return new Error("日程或日历来源不唯一，请刷新核对后再操作");
  return new Error("没写进苹果日历");
}

export function createCalendarWriteService(options = {}) {
  const pending = new Map();
  const now = options.now ?? (() => Date.now());
  const runner = options.runner ?? runJxa;
  const osEnabled = options.osEnabled ?? osCalendarEnabled();
  const cacheDir = options.cacheDir;
  if (osEnabled && !cacheDir) throw new Error("操作系统日历必须使用实例缓存目录");
  const readCurrent = options.readCurrent ?? ((expected) => readNativeCalendar(new Date(Date.parse(expected.start) - 1000), new Date(Date.parse(expected.end) + 1000), { cacheDir }));
  let writeQueue = Promise.resolve();
  return {
    preview(raw) {
      if (!osEnabled) throw new Error("未启用操作系统日历。");
      const action = normalizeCalendarAction(raw);
      const token = crypto.randomUUID();
      pending.set(token, { action, expires: now() + TTL });
      const format = (value) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Tokyo", hour12: false });
      const when = action.start ? `${format(action.start)} → ${format(action.end)}（东京时间）${action.allDay ? " · 全天，结束为次日零点" : ""}` : action.id;
      const original = action.expected;
      return { token, kind: `calendar:${action.kind}`, targetPath: `苹果日历 · ${action.calendar || "现有日程"}`, summary: action.kind === "create" ? "新建日程" : action.kind === "update" ? "修改日程" : "删除日程", before: original ? `${original.title}\n${format(original.start)} → ${format(original.end)}（东京时间）` : "尚未创建", after: action.kind === "delete" ? "删除此单次行程；小秘书无法撤销。" : `${action.title}\n${when}`, expiresAt: new Date(now() + TTL).toISOString() };
    },
    async commit(token) {
      if (!osEnabled) throw new Error("未启用操作系统日历。");
      const item = pending.get(token); pending.delete(token);
      if (!item || item.expires < now()) throw new Error("日历预览已过期");
      const write = writeQueue.then(async () => {
        if (item.expires < now()) throw new Error("日历预览已过期");
        try {
          const expected = item.action.expected;
          if (expected) {
            const snapshot = await readCurrent(expected);
            if (!snapshot.available || snapshot.permission !== "granted" || snapshot.stale) throw new Error("日历未连接，无法核对原日程");
            const matches = snapshot.events.filter((event) => event.id === expected.id && event.calendar === expected.calendar && Date.parse(event.start) === Date.parse(expected.start));
            if (matches.length !== 1) throw new Error("日程已在别处修改，请刷新后重新预览");
            const current = matches[0];
            if (!current.editable || current.recurring || current.title !== expected.title || Date.parse(current.end) !== Date.parse(expected.end) || current.allDay !== expected.allDay)
              throw new Error("日程已在别处修改，请刷新后重新预览");
          }
          const { stdout } = await runner(mutationScript(item.action));
          await invalidateAppleCalendarCache(cacheDir);
          return { ...JSON.parse(stdout.trim() || "{}"), ...(expected ? { sourceId: expected.id } : {}) };
        } catch (error) { throw tidyCalendarWriteError(error, item.action); }
      });
      writeQueue = write.catch(() => {});
      return write;
    },
  };
}
