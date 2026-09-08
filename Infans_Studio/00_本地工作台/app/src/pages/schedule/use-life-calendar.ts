import { useCallback, useEffect, useRef, useState } from "react";
import { jsonFetch } from "../../page-shared";
import type { CalendarSnapshot } from "../../types";

const empty: CalendarSnapshot = { available: false, permission: "unknown", calendars: [], events: [] };

export function useLifeCalendar(from: string, to: string, active: boolean, revision: string) {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>(empty);
  const generation = useRef(0);
  const refresh = useCallback(async (force = false): Promise<CalendarSnapshot | null> => {
    const turn = ++generation.current;
    setSnapshot((old) => ({ ...old, loading: true }));
    try {
      const params = new URLSearchParams({ from, to, ...(force ? { force: "1" } : {}) });
      let next = await jsonFetch<CalendarSnapshot>(`/api/calendar?${params}`);
      if (turn !== generation.current) return null;
      // A disk cache can cover a different range; never call that an empty current window.
      if (next.available && next.stale && !force) {
        setSnapshot({ ...next, loading: true });
        params.set("force", "1");
        next = await jsonFetch<CalendarSnapshot>(`/api/calendar?${params}`);
      }
      if (turn !== generation.current) return null;
      setSnapshot((old) => next.permission === "denied" || next.available ? { ...next, loading: false }
        : old.available ? { ...old, loading: false, stale: true, message: next.message || "暂时未连接，显示上次快照" } : { ...next, loading: false });
      return next;
    } catch (error) {
      if (turn === generation.current) setSnapshot((old) => ({ ...old, loading: false, stale: true, message: error instanceof Error ? error.message : "日历读取失败" }));
      return null;
    }
  }, [from, to]);
  useEffect(() => {
    if (active) void refresh();
    return () => { generation.current += 1; };
    // The shell owns the single calendar SSE/focus subscription.
  }, [active, refresh, revision]);
  return { snapshot, refresh };
}
