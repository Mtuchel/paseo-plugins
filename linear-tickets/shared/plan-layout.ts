// The plan's layout as Plannotator's planning instructions require it (README, "Plan-first"). The
// owner's template (phases.planning.instructions in the global plannotator.json) names its part
// headings in backticks, e.g. `# Part 1 — Overview` and `# Part 2 — Implementation`; the omp
// extension reads the template when a review is recorded and refuses a plan without those parts,
// in order, with the sections other tooling requires after the last part. A template that names no
// parts asks for none. The check does not depend on the agent having received the instructions:
// on 2026-10-07 omp dropped them for some sessions, and their plans reached the owner unnoticed.
// No imports: Paseo's shared bundle refuses Node modules, and the omp extension imports it from
// outside the plugin's build.

// The sections the record gate itself requires (shared/plan-risk.ts, plan-sections.ts,
// plan-model.ts, plan-advisor.ts); the template puts them after the last part.
export const TOOLING_SECTIONS = ["Reach", "Principles and rules", "Model", "Risk and impact", "Advisor review"] as const;

const DASHES = /\s*[—–-]+\s*/g;
// Headings compare with any dash and spacing around it: `# Part 1 - Overview` is the same part.
const normal = (heading: string): string => heading.trim().replace(DASHES, " — ").replace(/\s+/g, " ").toLowerCase();

// The part headings the instructions require, in their order. [] when they name none.
export function requiredParts(instructions: string): string[] {
  const parts = new Map<number, string>();
  for (const match of instructions.matchAll(/`(#\s+Part\s+(\d+)\s*[—–-]+\s*[^`\n]+?)\s*`/g)) {
    const number = Number(match[2]);
    if (!parts.has(number)) parts.set(number, match[1].trim());
  }
  return [...parts.entries()].sort(([a], [b]) => a - b).map(([, heading]) => heading);
}

// Line index of each level-1 or level-2 heading, outside fenced code blocks.
function headings(plan: string): { level: number; text: string; line: number }[] {
  const found: { level: number; text: string; line: number }[] = [];
  let fenced = false;
  plan.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const match = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) found.push({ level: match[1].length, text: match[2], line: index });
  });
  return found;
}

// Why the plan does not follow the required parts, or null when it does (or none are required).
export function layoutProblem(plan: string, parts: readonly string[]): string | null {
  if (parts.length === 0) return null;
  const found = headings(plan);
  const lines: number[] = [];
  const missing: string[] = [];
  for (const part of parts) {
    const want = normal(part.replace(/^#\s+/, ""));
    const hit = found.find((heading) => heading.level === 1 && normal(heading.text) === want);
    if (hit) lines.push(hit.line);
    else missing.push(part);
  }
  if (missing.length) return `The plan has no ${missing.map((part) => `"${part}"`).join(" and no ")} heading.`;
  if (lines.some((line, index) => index > 0 && line < lines[index - 1])) return `The plan's parts are out of order: ${parts.map((part) => `"${part}"`).join(", then ")}.`;
  const last = lines[lines.length - 1];
  const early = TOOLING_SECTIONS.filter((name) => found.some((heading) => heading.level === 2 && heading.line < last && normal(heading.text).startsWith(normal(name))));
  if (early.length) return `${early.map((name) => `"## ${name}"`).join(", ")} must come after "${parts[parts.length - 1]}": sections other tooling requires go after the last part.`;
  return null;
}
