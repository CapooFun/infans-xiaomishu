import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ProductFeaturePresentationGroup } from "../types";
import { groupFeaturePresentation } from "../product-feature-presentation";

function DeviceSection({ name, selected, forceOpen, children }: { name: string; selected: boolean; forceOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(selected);
  // A deep link/feature selection should reveal its parent; ordinary rerenders retain user choice.
  useEffect(() => { if (selected) setOpen(true); }, [selected]);
  return <details className="project-feature-device" open={forceOpen || open} onToggle={(event) => { if (!forceOpen) setOpen(event.currentTarget.open); }}>
    <summary><ChevronRight size={14} aria-hidden /><span>{name}</span></summary>
    <div className="project-feature-device-items">{children}</div>
  </details>;
}

/** Only lays out references. The accounting/relationship tree is never rebuilt here. */
export function FeatureWikiSections<T extends { id: string }>({ items, groups, children, devices = false, selectedId, forceOpen = false }: {
  items: T[];
  groups?: ProductFeaturePresentationGroup[];
  children: (item: T) => ReactNode;
  devices?: boolean;
  selectedId?: string;
  forceOpen?: boolean;
}) {
  return groupFeaturePresentation(items, groups).map((section) => {
    const content = section.items.map(children);
    if (!section.name) return <div key={section.id} className="project-feature-ungrouped">{content}</div>;
    if (devices) return <DeviceSection key={section.id} name={section.name} selected={section.items.some((item) => item.id === selectedId)} forceOpen={forceOpen}>{content}</DeviceSection>;
    return <section key={section.id} className="project-feature-domain" aria-label={section.name}>
      <h3>{section.name}</h3>
      <div>{content}</div>
    </section>;
  });
}
