// OMP retry.fallbackChains selectors shared by usage recovery, model drift and the acceptance-test
// guard. Roles are not selectors; exact and prefix selectors combine, without transitive fallback.
export type FallbackChains = Record<string, string[]>;

export function normalizeModel(model: string): string {
  return model.trim().replace(/^omp\//, "").split(/\s+·\s+/)[0].replace(/:[^/:]+$/, "");
}

// Keep the target's thinking suffix: matching a model for usage is not evidence that a session
// has the approved reasoning capability. A provider/* target carries across the source model id.
export function fallbackSpecs(chains: FallbackChains, model: string): string[] {
  const first = normalizeModel(model);
  if (!first.includes("/")) return [];
  const result = new Set<string>();
  for (const [key, entries] of Object.entries(chains)) {
    if (!key.includes("/")) continue;
    const match = normalizeModel(key);
    if (match !== first && !(match.endsWith("*") && first.startsWith(match.slice(0, -1)))) continue;
    for (const entry of entries) {
      let next = entry.trim().replace(/^omp\//, "");
      const suffix = /:[^/:]+$/.exec(next)?.[0] ?? "";
      const target = normalizeModel(next);
      if (target.endsWith("/*")) next = target.slice(0, -1) + first.slice(first.indexOf("/") + 1) + suffix;
      if (next.includes("/") && !next.includes("*")) result.add(next);
    }
  }
  return [...result];
}

export function candidates(chains: FallbackChains, model: string): string[] {
  const first = normalizeModel(model);
  return first.includes("/") ? [...new Set([first, ...fallbackSpecs(chains, model).map(normalizeModel)])] : [];
}
