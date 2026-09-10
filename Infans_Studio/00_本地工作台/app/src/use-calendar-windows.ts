import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { jsonFetch } from "./page-shared";
import {
  applyCalendarResponse,
  beginCalendarLoad,
  calendarQuery,
  failCalendarLoad,
  homeCalendarWindow,
  readCalendarWindow,
  type CalendarWindowId,
  type CalendarWindowSpec,
  EMPTY_CALENDAR,
  HOME_CALENDAR_BOOT,
} from "./calendar-windows";
import type { CalendarSnapshot } from "./types";

type CalendarWindowsState = { home: CalendarSnapshot; life: CalendarSnapshot };
type UseCalendarWindowsOptions = {
  home?: CalendarWindowSpec;
  life?: CalendarWindowSpec;
  onVisibleRefresh?: () => void;
};

const listeners = new Set<() => void>();
const specs: Record<CalendarWindowId, CalendarWindowSpec | null> = { home: null, life: null };
const generations: Record<CalendarWindowId, number> = { home: 0, life: 0 };
let store: CalendarWindowsState = { home: HOME_CALENDAR_BOOT, life: EMPTY_CALENDAR };
let subscriberCount = 0;
let changeSubscription: { close(): void } | null = null;
let extraVisibleRefresh: (() => void) | undefined;

function fetchCalendarSnapshot(from: string, to: string, force: boolean) {
  return jsonFetch<CalendarSnapshot>(calendarQuery(from, to, force));
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function setWindow(id: CalendarWindowId, snapshot: CalendarSnapshot) {
  if (store[id] === snapshot) return;
  store = { ...store, [id]: snapshot };
  emit();
}

function rangeFor(id: CalendarWindowId, spec: CalendarWindowSpec) {
  return id === "home" ? homeCalendarWindow() : { from: spec.from, to: spec.to };
}

async function refreshOne(id: CalendarWindowId, opts: { force?: boolean; silent?: boolean } = {}) {
  const spec = specs[id];
  if (!spec) return;
  const range = rangeFor(id, spec);
  const turn = ++generations[id];
  setWindow(id, beginCalendarLoad(store[id], opts));
  try {
    const next = await readCalendarWindow(range.from, range.to, {
      force: opts.force,
      fetch: fetchCalendarSnapshot,
      onStale: (stale) => {
        if (turn !== generations[id]) return;
        setWindow(id, { ...stale, loading: false, stale: true });
      },
    });
    if (turn !== generations[id]) return;
    setWindow(id, applyCalendarResponse(store[id], next, opts));
  } catch (error) {
    if (turn !== generations[id]) return;
    setWindow(id, failCalendarLoad(store[id], error));
  }
}

export async function refreshCalendarWindows(which: CalendarWindowId | "all" = "all", opts: { force?: boolean; silent?: boolean } = {}) {
  const ids: CalendarWindowId[] = which === "all"
    ? (["home", "life"] as const).filter((id) => specs[id]?.active)
    : [which];
  await Promise.all(ids.map((id) => refreshOne(id, opts)));
}

function startChangeSubscription() {
  if (changeSubscription || typeof EventSource === "undefined") return;
  const changes = new EventSource("/api/calendar/changes");
  const refresh = () => {
    if (document.visibilityState === "hidden") return;
    void refreshCalendarWindows("all", { silent: true });
    extraVisibleRefresh?.();
  };
  changes.onmessage = refresh;
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  changeSubscription = {
    close() {
      changes.close();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    },
  };
}

function stopChangeSubscription() {
  changeSubscription?.close();
  changeSubscription = null;
}

function registerWindow(id: CalendarWindowId, spec: CalendarWindowSpec) {
  const previous = specs[id];
  const same = previous
    && previous.from === spec.from
    && previous.to === spec.to
    && previous.active === spec.active;
  specs[id] = spec;
  if (same) return;
  if (spec.active) void refreshOne(id, { silent: Boolean(previous?.active) });
}

function unregisterWindow(id: CalendarWindowId) {
  specs[id] = null;
  generations[id] += 1;
}

export function useCalendarWindows(options: UseCalendarWindowsOptions) {
  const onVisibleRefreshRef = useRef(options.onVisibleRefresh);
  onVisibleRefreshRef.current = options.onVisibleRefresh;
  useLayoutEffect(() => {
    if (options.home) registerWindow("home", options.home);
    if (options.life) registerWindow("life", options.life);
    const owned: CalendarWindowId[] = [
      ...(options.home ? ["home"] as const : []),
      ...(options.life ? ["life"] as const : []),
    ];
    return () => { for (const id of owned) unregisterWindow(id); };
  }, [
    options.home?.from,
    options.home?.to,
    options.home?.active,
    options.life?.from,
    options.life?.to,
    options.life?.active,
  ]);
  useLayoutEffect(() => {
    if (!options.onVisibleRefresh) return;
    extraVisibleRefresh = () => onVisibleRefreshRef.current?.();
    return () => {
      extraVisibleRefresh = undefined;
    };
  }, [Boolean(options.onVisibleRefresh)]);
  useEffect(() => {
    subscriberCount += 1;
    if (subscriberCount === 1) startChangeSubscription();
    return () => {
      subscriberCount -= 1;
      if (subscriberCount === 0) stopChangeSubscription();
    };
  }, []);
  const home = useSyncExternalStore(subscribe, () => store.home);
  const life = useSyncExternalStore(subscribe, () => store.life);
  return { home, life, refresh: refreshCalendarWindows };
}
