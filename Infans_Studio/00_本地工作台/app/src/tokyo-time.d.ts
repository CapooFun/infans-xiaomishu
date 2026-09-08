export function tokyoDateKey(value?: Date | string): string;
export function tokyoDay(value?: Date | string | null): string | null;
export const NEAR_TERM_CALENDAR_DAYS: number;
export function addTokyoCalendarDays(dateKey: string, days: number): string;
export function nearTermTokyoDateKeys(from?: Date | string, days?: number): string[];
export function isNearTermTokyoInstant(value: Date | string, from?: Date | string, days?: number): boolean;
