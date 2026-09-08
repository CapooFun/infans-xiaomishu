import type { CSSProperties, ReactNode } from "react";
import { Database, ArrowUpRight } from "lucide-react";
import { tokyoDateKey as tokyoDateKeyShared, nearTermTokyoDateKeys as nearTermTokyoDateKeysShared, isNearTermTokyoInstant as isNearTermTokyoInstantShared, addTokyoCalendarDays as addTokyoCalendarDaysShared, NEAR_TERM_CALENDAR_DAYS } from "./tokyo-time.mjs";
import { markActiveWorkbenchNavigation } from "./workbench-position-memory.ts";
export { NEAR_TERM_CALENDAR_DAYS };

export function navigate(path: string) {
  markActiveWorkbenchNavigation();
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** 返回已有页面状态时保留位置恢复；适用于从待办跳出后的显式返回入口。 */
export function navigateWithPositionRestore(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** 普通左键走 SPA；Cmd/Ctrl/中键/新标签留给浏览器。 */
export function shouldSoftNavigate(event: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function softNavigate(event: { preventDefault(): void; defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, path: string) {
  if (!shouldSoftNavigate(event)) return;
  event.preventDefault();
  navigate(path);
}

export async function jsonFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || "请求失败"), { status: response.status, code: body.code });
  return body;
}

/** 展示用卡：无按钮语义、不可点整卡。 */
export function Card({ children, className = "", id }: { children: ReactNode; className?: string; id?: string }) {
  return <section className={`museum-card ${className}`} id={id}>{children}</section>;
}

/** 整卡跳转：真链接（可 Cmd/Ctrl/中键开新标签）；内部按钮可单独 focus。 */
export function CardLink({
  children,
  className = "",
  href,
  external = false,
  label,
}: {
  children: ReactNode;
  className?: string;
  href: string;
  external?: boolean;
  label?: string;
}) {
  return (
    <section className={`museum-card interactive-card card-link ${className}`}>
      <a
        className="card-stretch-link"
        href={href}
        aria-label={label}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        onClick={external ? undefined : (event) => softNavigate(event, href)}
      />
      {children}
    </section>
  );
}

/** 整卡动作（非路由）：保留按钮语义，给打开浮层等用。 */
export function CardButton({
  children,
  className = "",
  onClick,
  label,
}: {
  children: ReactNode;
  className?: string;
  onClick: () => void;
  label?: string;
}) {
  return (
    <section
      className={`museum-card interactive-card ${className}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </section>
  );
}

export function Kicker({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`kicker${className ? ` ${className}` : ""}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty"><Database size={17}/><span>{children}</span></div>; }
export function ProgressRing({ value, label }: { value: number | null; label?: string }) {
  const progress = value == null ? 0 : Math.max(0, Math.min(100, value));
  return <div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as CSSProperties}><div><strong>{value == null ? "—" : `${value.toFixed(0)}%`}</strong>{label ? <span>{value == null ? "未同步" : label}</span> : null}</div></div>;
}
export function obsidianHref(source: string) { return `obsidian://open?vault=Infans_Vault&file=${encodeURIComponent(source.replace(/\.md$/, ""))}`; }
/** 只用于后台编辑、全库维护或故障备用；前台内容必须另有小秘书内部阅读路径。 */
export function SourceLink({ path, label = "在 Obsidian 编辑" }: { path: string; label?: string }) { return <a className="source-link" href={obsidianHref(path)}>{label}<ArrowUpRight size={13}/></a>; }
export function ExternalSourceDisclosure({
  sources,
  label = "核对来源",
}: {
  sources: Array<{ label: string; url: string }>;
  label?: string;
}) {
  if (!sources.length) return null;
  return <details className="external-source-disclosure">
    <summary>{label}<span>{sources.length}</span></summary>
    <nav aria-label={label}>{sources.map((source) => <a key={`${source.url}:${source.label}`} href={source.url} target="_blank" rel="noopener noreferrer">{source.label}<ArrowUpRight size={11} aria-hidden="true" /></a>)}</nav>
  </details>;
}
export function fmtDate(value?: string | null, long = false) { if (!value) return "未标日期"; const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return new Intl.DateTimeFormat("zh-CN", long ? { year: "numeric", month: "long", day: "numeric" } : { month: "short", day: "numeric" }).format(date); }
export function fmtTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
export function fmtCny(value: number, compact = false) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 2 }).format(value); }
export function fmtCurrency(value: number, currency: string) { try { return new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: currency === "JPY" ? 0 : 2 }).format(value); } catch { return `${currency} ${value.toLocaleString("zh-CN")}`; } }
export function fmtBytes(value: number) { const units = ["B", "KB", "MB", "GB", "TB"]; let size = Math.max(0, value); let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`; }
export function fmtRate(value: number) { return `${fmtBytes(value)}/s`; }
export function fmtDateTime(value?: string | null) { if (!value) return "尚无记录"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "尚无记录" : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
export function tokyoDateKey(value: Date | string) { return tokyoDateKeyShared(new Date(value)); }
export function nearTermTokyoDateKeys(from: Date | string = new Date(), days = NEAR_TERM_CALENDAR_DAYS) { return nearTermTokyoDateKeysShared(new Date(from), days); }
export function isNearTermTokyoInstant(value: Date | string, from: Date | string = new Date(), days = NEAR_TERM_CALENDAR_DAYS) { return isNearTermTokyoInstantShared(value, new Date(from), days); }
export function addTokyoCalendarDays(dateKey: string, days: number) { return addTokyoCalendarDaysShared(dateKey, days); }
export function formatNearTermEventWhen(start: string, allDay: boolean, todayKey = tokyoDateKey(new Date())) {
  const key = tokyoDateKey(start);
  const time = allDay ? "全天" : fmtTime(start);
  if (key === todayKey) return time;
  if (key === addTokyoCalendarDays(todayKey, 1)) return `明天 ${time}`;
  return `${key.slice(5).replace("-", "/")} ${time}`;
}
