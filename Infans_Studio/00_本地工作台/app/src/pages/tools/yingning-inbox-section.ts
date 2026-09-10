// 秘书收件箱分类：网址与本次会话记忆，避免侧栏书签回来总停在照片。

export const INBOX_SECTIONS = ["photos", "bookmarks", "files", "projects", "trash"] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];
export const INBOX_DEFAULT_SECTION: InboxSection = "photos";
export const INBOX_SECTION_STORAGE_KEY = "infans.inbox.section";
export const INBOX_PATH = "/tools/inbox";

export const INBOX_SECTION_LABELS: Record<InboxSection, string> = {
  photos: "照片",
  bookmarks: "书签",
  files: "文件",
  projects: "项目收件",
  trash: "回收站",
};

type InboxSectionCounts = {
  photos: number;
  bookmarks: number;
  files: number;
  projects: number;
  trash: number;
};

export function parseInboxSection(value: unknown): InboxSection | null {
  return INBOX_SECTIONS.includes(value as InboxSection) ? (value as InboxSection) : null;
}

export function inboxSectionQueryValue(section: InboxSection): string | null {
  return section === INBOX_DEFAULT_SECTION ? null : section;
}

export function inboxSearchForSection(section: InboxSection, search = ""): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const encoded = inboxSectionQueryValue(section);
  if (encoded) params.set("section", encoded);
  else params.delete("section");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function inboxLocationForSection(pathname: string, search: string, section: InboxSection): string {
  const path = pathname.replace(/\/$/u, "") || "/";
  if (path !== INBOX_PATH) return `${pathname}${search}`;
  return `${INBOX_PATH}${inboxSearchForSection(section, search)}`;
}

export function resolveInboxSection(search: string, remembered: string | null | undefined = null): InboxSection {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return parseInboxSection(params.get("section")) ?? parseInboxSection(remembered) ?? INBOX_DEFAULT_SECTION;
}

export function readRememberedInboxSection(storage: { getItem(key: string): string | null } | null | undefined): InboxSection | null {
  if (!storage) return null;
  try {
    return parseInboxSection(storage.getItem(INBOX_SECTION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeRememberedInboxSection(section: InboxSection, storage: { setItem(key: string, value: string): void } | null | undefined): void {
  if (!storage) return;
  try {
    storage.setItem(INBOX_SECTION_STORAGE_KEY, section);
  } catch {
    // 无痕或禁用存储时只靠网址。
  }
}

export function fallbackInboxSection(section: InboxSection, counts: InboxSectionCounts): InboxSection {
  const hasPhotos = counts.photos > 0;
  const hasFiles = counts.files > 0;
  const hasBookmarks = counts.bookmarks > 0;
  const hasProjects = counts.projects > 0;
  const hasTrash = counts.trash > 0;
  const firstAvailable = (): InboxSection => {
    if (hasPhotos) return "photos";
    if (hasFiles) return "files";
    if (hasBookmarks) return "bookmarks";
    if (hasProjects) return "projects";
    if (hasTrash) return "trash";
    return section;
  };
  if (section === "trash") return section;
  if (section === "projects") return hasProjects ? section : firstAvailable();
  if (section === "photos" && !hasPhotos) {
    if (hasFiles) return "files";
    if (hasBookmarks) return "bookmarks";
    if (hasProjects) return "projects";
    if (hasTrash) return "trash";
  }
  if (section === "files" && !hasFiles) {
    if (hasPhotos) return "photos";
    if (hasBookmarks) return "bookmarks";
    if (hasProjects) return "projects";
    if (hasTrash) return "trash";
  }
  if (section === "bookmarks" && !hasBookmarks) {
    if (hasPhotos) return "photos";
    if (hasFiles) return "files";
    if (hasProjects) return "projects";
    if (hasTrash) return "trash";
  }
  return section;
}
