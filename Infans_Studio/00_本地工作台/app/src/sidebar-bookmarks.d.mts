export type SidebarBookmark = { location: string; label: string };
export type SidebarBookmarkSnapshot = { version: 1; items: SidebarBookmark[] };

export const SIDEBAR_BOOKMARKS_VERSION: 1;
export const MAX_SIDEBAR_BOOKMARKS: 6;
export function normalizeSidebarBookmarkLocation(input: unknown, base?: string): string | null;
export function isSidebarBookmarkableLocation(input: unknown): boolean;
export function defaultSidebarBookmarkLabel(input: unknown, options?: { projectNames?: Record<string, string> }): string;
export function normalizeSidebarBookmark(value: unknown, options?: { projectNames?: Record<string, string> }): SidebarBookmark | null;
export function normalizeSidebarBookmarks(value: unknown, options?: { projectNames?: Record<string, string> }): SidebarBookmarkSnapshot;
export function isSidebarBookmarkNavigableInDisplayMode(bookmark: SidebarBookmark): boolean;
export function sidebarBookmarkRoutePath(input: unknown): string;
