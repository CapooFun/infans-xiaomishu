import { startTransition, useCallback, useEffect, useState } from "react";
import type { HealthSectionData, LanguagesSectionData, LibrarySectionData, MarketsSectionData, WorkbenchSectionResponse } from "./types";
import { createRequestCache } from "./request-cache-core.mjs";

export type SectionKey = "health" | "languages" | "library" | "markets";
export type SectionDataMap = {
  health: HealthSectionData;
  languages: LanguagesSectionData;
  library: LibrarySectionData;
  markets: MarketsSectionData;
};

const sectionCache = createRequestCache(async (key: SectionKey): Promise<SectionDataMap[SectionKey]> => {
  const response = await fetch(`/api/sections/${key}`);
  const body = await response.json() as WorkbenchSectionResponse<SectionDataMap[SectionKey]> & { error?: string };
  if (!response.ok) throw new Error(body.error || "页面数据读取失败");
  return body.data;
});

export async function loadSection<K extends SectionKey>(key: K, force = false): Promise<SectionDataMap[K]> {
  return sectionCache.load(key, force) as Promise<SectionDataMap[K]>;
}

export function preloadSection(key: SectionKey) {
  return loadSection(key).catch(() => undefined);
}

export function refreshSection(key: SectionKey) {
  return loadSection(key, true).catch(() => undefined);
}

export function invalidateSection(key: SectionKey) {
  sectionCache.invalidate(key);
}

export function useSectionData<K extends SectionKey>(key: K) {
  const [, render] = useState(0);
  useEffect(() => {
    // 数据到达触发的这次重渲染要走 transition：它才是真正让懒加载页面首次登场的那一步。
    // 若为同步更新，页面分包一 suspend 就会提交 fallback，React 随后按
    // FALLBACK_THROTTLE_MS 压住已就绪的内容整 300ms（实测占首次进入耗时的九成）。
    const listener = () => startTransition(() => render((value) => value + 1));
    const unsubscribe = sectionCache.subscribe(key, listener);
    void loadSection(key).catch(() => {});
    return unsubscribe;
  }, [key]);
  const retry = useCallback(() => { void loadSection(key, true).catch(() => {}); }, [key]);
  const current = sectionCache.snapshot(key);
  return { data: current.data as SectionDataMap[K] | null, error: current.error, loading: current.loading, retry };
}
