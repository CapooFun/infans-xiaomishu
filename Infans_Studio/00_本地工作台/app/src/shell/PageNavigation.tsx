import { createContext, useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { navigateWithPositionRestore, shouldSoftNavigate } from "../page-shared";
import { isInternalNavigationHref, visibleTrailIndices } from "./page-navigation-model";
import "./page-navigation.css";

export type TrailItem = { label: string; href?: string; onSelect?: () => void; history?: "replace"; siblings?: TrailItem[] };
type Entry = { route: string; items: TrailItem[] };
const Scope = createContext({ route: "", active: false });
// A tiny, transient presentation registry. Only the topbar subscribes: changing
// a breadcrumb never rerenders the app or eagerly imports a page's data bundle.
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let revision = 0;
const publish = () => { revision += 1; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => revision;

export function PageNavigationScope({ route, active, children }: { route: string; active: boolean; children: ReactNode }) {
  return <Scope.Provider value={{ route, active }}>{children}</Scope.Provider>;
}

export function usePageNavigationActive() {
  return useContext(Scope).active;
}

/** Register actual page state, including in-page ancestors with existing actions. */
export function PageTrail({ items }: { items: TrailItem[] }) {
  const scope = useContext(Scope);
  const id = useId();
  useLayoutEffect(() => {
    if (!scope.active) return;
    entries.set(id, { route: scope.route, items });
    publish();
    return () => { entries.delete(id); publish(); };
  }, [id, items, scope.active, scope.route]);
  return null;
}

function follow(event: MouseEvent<HTMLAnchorElement>, item: TrailItem) {
  if (!shouldSoftNavigate(event)) return;
  event.preventDefault();
  if (item.onSelect) {
    const previous = { url: window.location.href, state: window.history.state };
    item.onSelect();
    // Older panels use replaceState for selection. A deliberate breadcrumb jump
    // still deserves a history entry so browser Back returns to the detail.
    if (item.history === "replace" && window.location.href !== previous.url) {
      const next = { url: window.location.href, state: window.history.state };
      window.history.replaceState(previous.state, "", previous.url);
      window.history.pushState(next.state, "", next.url);
    }
  }
  else if (item.href && isInternalNavigationHref(item.href)) navigateWithPositionRestore(item.href);
}

function TrailTarget({ item, current = false }: { item: TrailItem; current?: boolean }) {
  if (current) return <h1 className="path-current" aria-current="page" title={item.label}>{item.label}</h1>;
  if (item.href && isInternalNavigationHref(item.href)) return <a href={item.href} onClick={(event) => follow(event, item)} title={item.label}>{item.label}</a>;
  if (item.onSelect) return <button type="button" onClick={item.onSelect} title={item.label}>{item.label}</button>;
  return <span title={item.label}>{item.label}</span>;
}

function TrailMenu({ label, items, ellipsis = false }: { label: string; items: TrailItem[]; ellipsis?: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute("open"); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <details ref={ref} className={`path-menu${ellipsis ? " is-overflow" : ""}`} onToggle={(event) => setOpen(event.currentTarget.open)} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
  }}>
    <summary aria-label={label} title={label}>{ellipsis ? <MoreHorizontal size={18} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}</summary>
    <div className="path-menu-panel" onClick={(event) => {
      if ((event.target as HTMLElement).closest("a,button")) { ref.current?.removeAttribute("open"); ref.current?.querySelector("summary")?.focus(); }
    }}>{items.map((item, index) => <div key={`${item.href || item.label}:${index}`}><TrailTarget item={item} /></div>)}</div>
  </details>;
}

function PathRow({ items, compact }: { items: TrailItem[]; compact: boolean }) {
  const indices = visibleTrailIndices(items.length, compact);
  return <ol className={`path-row ${compact ? "is-compact" : "is-wide"}`}>
    {indices.map((index, position) => {
      const previous = indices[position - 1] ?? -1;
      const hidden = items.slice(previous + 1, index);
      const item = items[index];
      return <li key={`${item.label}:${index}`} className={`${index === 0 ? "is-root" : "is-segment"}${index === items.length - 1 ? " is-current" : ""}`}>
        {position > 0 ? <ChevronRight className="path-divider" size={16} aria-hidden="true" /> : null}
        {hidden.length ? <><TrailMenu label="展开中间层级" items={hidden} ellipsis /><ChevronRight className="path-divider" size={16} aria-hidden="true" /></> : null}
        <TrailTarget item={item} current={index === items.length - 1} />
        {item.siblings?.length ? <TrailMenu label={`切换${item.label}同级页面`} items={item.siblings} /> : null}
      </li>;
    })}
  </ol>;
}

export function PageNavigation({ route, title, annotation }: { route: string; title: string; annotation?: string }) {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const detail = [...entries.values()].filter((entry) => entry.route === route).sort((a, b) => b.items.length - a.items.length)[0]?.items || [];
  const items: TrailItem[] = [{ label: title, href: route }, ...detail];
  return <div className={`page-heading page-navigation${detail.length ? " has-trail" : ""}`}>
    {detail.length ? <nav aria-label="页面位置" key={items.map((item) => item.label).join("/")}>
      <PathRow items={items} compact={false} /><PathRow items={items} compact />
    </nav> : <div className="page-heading-title"><h1>{title}</h1></div>}
    {annotation ? <small className="path-annotation">{annotation}</small> : null}
  </div>;
}
