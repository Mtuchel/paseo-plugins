// What a plan names, for comparing plans with each other and with pull requests (README, "Overlap
// check"). Files: backticked tokens and markdown link targets that contain a "/" or end in a code
// extension, as repo-relative paths ("server/x.ts", not "./server/x.ts:12"). Planners are told to
// name files that way; other spellings are not recognised.

const CODE_EXTENSIONS: Record<string, true> = {
  ts: true, tsx: true, js: true, jsx: true, mjs: true, cjs: true, json: true, md: true, mdx: true, py: true, go: true, rs: true,
  java: true, kt: true, swift: true, rb: true, php: true, css: true, scss: true, html: true, vue: true, svelte: true, yml: true,
  yaml: true, toml: true, sql: true, sh: true, prisma: true, graphql: true, proto: true,
};
const PATH = /^[\w@.+-]+(?:\/[\w@.+-]+)*\/?$/;

export type PlanFootprint = { files: string[] };

export function planFootprint(plan: string): PlanFootprint {
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const file = filePath(raw);
    if (file && !seen.has(file)) { seen.add(file); files.push(file); }
  };
  for (const match of plan.matchAll(/`([^`\n]+)`/g)) add(match[1]);
  for (const match of plan.matchAll(/\]\(([^)\s]+)\)/g)) add(match[1]);
  return { files };
}

// The repo-relative path a token names, or null when it names no file.
function filePath(raw: string): string | null {
  let token = raw.trim();
  if (!token || token.includes("://") || token.startsWith("#")) return null;
  token = token.replace(/#L\d+(?:-L?\d+)?$/, "").replace(/:\d+(?:[-:]\d+)*$/, "").replace(/^(?:\.\/)+/, "");
  if (!token || token.startsWith("/") || token.startsWith("..") || !PATH.test(token)) return null;
  const extension = /\.([A-Za-z0-9]+)$/.exec(token)?.[1]?.toLowerCase() ?? "";
  if (Object.hasOwn(CODE_EXTENSIONS, extension) && token.length > extension.length + 1) return token;
  // "and/or", "TUC-1/TUC-2": two plain words or ticket keys around a slash are no path; nor is a
  // ticket branch ("mtuchel/tuc-597-retire-n8n", "origin/mtuchel/tuc-597-retire-n8n").
  if (!token.includes("/") || /^[A-Za-z]+\/[A-Za-z]+$/.test(token) || /^[A-Z][A-Z0-9]*-\d+(?:\/[A-Z][A-Z0-9]*-\d+)+$/.test(token) || /^(?:origin\/)?[\w.-]+\/[A-Za-z][A-Za-z0-9]*-\d+-[\w.-]+$/.test(token)) return null;
  return token;
}
