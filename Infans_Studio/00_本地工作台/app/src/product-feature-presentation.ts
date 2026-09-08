import type { ProductFeatureModule, ProductFeaturePresentationGroup } from "./types";

/** Used only by the Wiki. Accounting and project relations keep the unmodified canonical array. */
export function withFeaturePresentation(modules: ProductFeatureModule[]): ProductFeatureModule[] {
  return modules.map((module) => {
    if (!module.presentationFeatures?.length) return module;
    const replacements = new Map(module.presentationFeatures.map((feature) => [feature.id, feature]));
    const existing = new Set(module.features.map((feature) => feature.id));
    return { ...module, features: [
      ...module.features.map((feature) => replacements.get(feature.id) || feature),
      ...module.presentationFeatures.filter((feature) => !existing.has(feature.id)),
    ] };
  });
}

/** Partition visible objects without cloning/reparenting them or altering accounting data. */
export function groupFeaturePresentation<T extends { id: string }>(items: T[], groups: ProductFeaturePresentationGroup[] = []) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const used = new Set<string>();
  const sections: Array<{ id: string; name: string; items: T[] }> = [];
  for (const group of groups) {
    const members: T[] = [];
    for (const id of group.memberIds) {
      const item = byId.get(id);
      if (!item || used.has(id)) continue;
      used.add(id);
      members.push(item);
    }
    if (members.length) sections.push({ id: group.id, name: group.name, items: members });
  }
  const remaining = items.filter((item) => !used.has(item.id));
  if (remaining.length) sections.push({ id: "ungrouped", name: "", items: remaining });
  return sections;
}
