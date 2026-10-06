import type { CatalogLabel } from "./linear";

export type AreaLabels = (labels: readonly { id: string }[]) => string[];

// Resolve group membership by ids, never by the issue label's spelling or a prefix.
export function areaLabels(catalog: readonly CatalogLabel[]): AreaLabels {
  const groups = new Set<string>();
  for (const label of catalog) {
    if (label.isGroup && label.name.trim().toLowerCase() === "area") groups.add(label.id);
  }
  const names = new Map<string, string>();
  for (const label of catalog) {
    if (!label.isGroup && label.parentId && groups.has(label.parentId)) names.set(label.id, label.name);
  }
  return (labels) => {
    const found = new Set<string>();
    for (const { id } of labels) {
      const name = names.get(id);
      if (name) found.add(name);
    }
    return [...found].sort();
  };
}
