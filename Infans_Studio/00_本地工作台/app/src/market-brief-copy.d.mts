export const BRIEF_HEADLINE_MAX_CHARS: 32;
export function displayBriefHeadline(headline: unknown, maxChars?: number): string;
export function canonicalEventLane(value: unknown, category?: unknown): "focus" | "world";
export function sortBriefEventsByLane<T extends { lane?: string }>(events: T[] | null | undefined): T[];
