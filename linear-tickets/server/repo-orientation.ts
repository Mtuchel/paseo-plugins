import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import type { TicketDetail } from "../shared/contracts";
import { record } from "./context";

const exec = promisify(execFile);

// Ticket agents used to find the domain guides (nested AGENTS.md) by hand and explore code in
// their own context (TUC-371). The launch prompt now lists the checkout's guides, the ones the
// ticket names first, and tells the agent to delegate broad exploration to scouts.
export const MAX_LISTED_GUIDES = 40;
const HEADING_BYTES = 1024;
const HEADING_CHARS = 120;
const GIT_TIMEOUT_MS = 5_000;
export const GUIDES_HEADER = "Domain guides in this repository — read the ones that apply before changing code in that area:";

type Match = "named" | "possible" | null;
type Guide = { path: string; dir: string; match: Match };
type Ticket = { text: string; labels: string[] };

// TUC-480 spot-check: 2 of 10 scout reports carried a wrong detail the parent would have acted on.
const SCOUT_RULES = "in this same workspace, following your harness's delegation rules: give them this workspace's absolute path and do not create another worktree for exploration. Ask them to cite the file and line behind each claim, and check every claim you act on in that file before relying on it. Read the files you will change yourself.";

export function scoutNote(provider: string): string {
  const key = provider.split("/")[0];
  if (key === "omp") return `After brief inline scoping, delegate broad exploration of unfamiliar code to read-only scout subagents (the \`task\` tool with the \`scout\` agent) ${SCOUT_RULES}`;
  if (key === "claude") return `After brief inline scoping, delegate broad exploration of unfamiliar code to read-only subagents (the Task tool with the Explore subagent) ${SCOUT_RULES}`;
  return `If your harness offers read-only exploration subagents, then after brief inline scoping delegate broad exploration of unfamiliar code to them ${SCOUT_RULES}`;
}

// Only the ticket's own words: title, description, labels and comments (not related tickets).
export function ticketWords(detail: Pick<TicketDetail, "issue" | "context">): Ticket {
  let comments: string[] = [];
  try {
    const parsed = record(JSON.parse(detail.context));
    comments = (Array.isArray(parsed.comments) ? parsed.comments : []).map((comment) => record(comment).body).filter((body): body is string => typeof body === "string");
  } catch { /* a raw context string has no comments to read */ }
  return { text: [detail.issue.title, detail.issue.description, ...comments].join("\n"), labels: detail.issue.labels };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A path counts when it is not part of a longer path segment: `domains/sales/x.ts` and
// `domains/sales` match the sales guide, `domains/sales-reports` does not.
function mentionsPath(text: string, path: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}_.-])${escape(path)}(?=$|[^\\p{L}\\p{N}_.-])`, "u").test(text);
}

// An area name as a whole word, `-` and space interchangeable; `batch-service` is not `batch`.
function mentionsName(text: string, name: string): boolean {
  const words = name.split("-").map(escape).join("[- ]");
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${words}(?=$|[^\\p{L}\\p{N}_-])`, "iu").test(text);
}

export function matchGuides(paths: string[], ticket: Ticket): Guide[] {
  const guides: Guide[] = paths.map((path) => ({ path, dir: posix.dirname(path), match: null }));
  const siblings = new Map<string, number>();
  for (const { dir } of guides) siblings.set(posix.dirname(dir), (siblings.get(posix.dirname(dir)) ?? 0) + 1);
  const labels = new Set(ticket.labels.map((label) => label.trim().toLowerCase().replace(/\s+/g, "-")));
  for (const guide of guides) {
    const segments = guide.dir.split("/");
    const short = segments.slice(-2).join("/");
    const name = segments[segments.length - 1];
    // Names only identify guides that are one of a set (the domains/* folders); `domain` or
    // `email-classifier` alone are too generic.
    const collection = (siblings.get(posix.dirname(guide.dir)) ?? 0) >= 2;
    if (mentionsPath(ticket.text, guide.dir) || mentionsPath(ticket.text, short) || (collection && labels.has(name.toLowerCase()))) guide.match = "named";
    else if (collection && mentionsName(ticket.text, name)) guide.match = "possible";
  }
  // A named nested guide (procurement/handlers/email-classifier) also names the guides above it.
  for (const named of guides.filter((guide) => guide.match === "named")) {
    for (const guide of guides) if (named.dir.startsWith(`${guide.dir}/`)) guide.match = "named";
  }
  return guides;
}

// Matches always stay; the rest fill up to MAX_LISTED_GUIDES in path order.
export function selectGuides(guides: Guide[]): { listed: Guide[]; omitted: number } {
  const byPath = (a: Guide, b: Guide) => a.path.localeCompare(b.path);
  const named = guides.filter((guide) => guide.match === "named").sort(byPath);
  const possible = guides.filter((guide) => guide.match === "possible").sort(byPath);
  const rest = guides.filter((guide) => !guide.match).sort(byPath);
  const listed = [...named, ...possible, ...rest.slice(0, Math.max(0, MAX_LISTED_GUIDES - named.length - possible.length))];
  return { listed, omitted: guides.length - listed.length };
}

// The first `# ` line within the first KB; the file is never read whole.
async function heading(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADING_BYTES);
    const { bytesRead } = await file.read(buffer, 0, HEADING_BYTES, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n").find((entry) => entry.startsWith("# "));
    return line ? line.slice(2).trim().slice(0, HEADING_CHARS) : "";
  } finally {
    await file.close();
  }
}

export async function guidePaths(cwd: string): Promise<string[]> {
  const { stdout } = await exec("git", ["-C", cwd, "ls-files", "-z", "--", ":(glob)**/AGENTS.md"], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\0").filter((path) => path && path !== "AGENTS.md");
}

// Never throws: a launch without the guide list is still a launch. Emits only repository paths
// and headings, never ticket text.
export async function repoOrientation(input: { cwd: string | null; git: boolean; provider: string; detail: Pick<TicketDetail, "issue" | "context"> }): Promise<{ note: string; warnings: string[] }> {
  const scout = scoutNote(input.provider);
  if (!input.git || !input.cwd) return { note: scout, warnings: [] };
  let paths: string[];
  try {
    paths = await guidePaths(input.cwd);
  } catch (error) {
    return { note: scout, warnings: [`Could not list the repository's domain guides for the launch prompt: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`] };
  }
  if (!paths.length) return { note: scout, warnings: [] };
  const { listed, omitted } = selectGuides(matchGuides(paths, ticketWords(input.detail)));
  const unreadable: string[] = [];
  const lines = await Promise.all(listed.map(async (guide) => {
    const title = await heading(join(input.cwd!, guide.path)).catch(() => { unreadable.push(guide.path); return ""; });
    const marker = guide.match === "named" ? "named in this ticket: " : guide.match === "possible" ? "possible match: " : "";
    return `- ${marker}\`${guide.path}\`${title ? ` — ${title}` : ""}`;
  }));
  if (omitted) lines.push(`- ${omitted} more guides not listed: \`git ls-files '*AGENTS.md'\``);
  const warnings = unreadable.length ? [`Could not read ${unreadable.length} domain guide${unreadable.length === 1 ? "" : "s"} for the launch prompt: ${unreadable.sort().join(", ")}`] : [];
  return { note: [[GUIDES_HEADER, ...lines].join("\n"), scout].join("\n\n"), warnings };
}
