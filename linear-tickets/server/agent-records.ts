import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UUID } from "./linear";

// What ticket agents and the plugin wrote to Linear, kept in the plugin's state directory
// (`$PASEO_HOME/linear-tickets`) so the comment relay can tell those comments from the owner's own
// and route the owner's replies (README, "Replies from Linear"):
// - `agent-issues/<ticket>/<issue id>.json`: the issues the agent of <ticket> filed (create_issue);
// - `agent-comments/<ticket>/<comment id>.json`: the comments it posted (add_comment, set_status
//   reasons); one on another issue starts a thread whose replies go to that agent;
// - `agent-comments/plugin/<comment id>.json`: comments the plugin wrote with the key because the
//   Paseo app was set up but not usable, so they show the owner as their author.
// The ticket tool server (ticket-mcp-source.ts) writes the first two in this format.
export type FiledIssue = { id: string; identifier: string; createdAt: string };
export type PostedComment = { id: string; issueId: string; identifier: string | null; createdAt: string };

const PLUGIN = "plugin";
// Long enough for any relay pause, and for the weekly decision candidates (owner-decisions.ts),
// which look back up to 28 days and must not take one of these for the owner's own comment.
export const PLUGIN_RECORD_MS = 35 * 24 * 60 * 60 * 1000;

async function records(directory: string): Promise<{ name: string; value: Record<string, unknown> }[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const found = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => ({ name, value: await readFile(join(directory, name), "utf8").then(JSON.parse, () => null) })));
  return found.filter((entry): entry is { name: string; value: Record<string, unknown> } => Boolean(entry.value) && typeof entry.value === "object");
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export async function filedIssues(directory: string, ticket: string): Promise<FiledIssue[]> {
  if (!UUID.test(ticket)) return [];
  return (await records(join(directory, "agent-issues", ticket))).map((entry) => entry.value)
    .filter((value) => text(value.id) && text(value.identifier) && text(value.createdAt))
    .map((value) => ({ id: value.id as string, identifier: value.identifier as string, createdAt: value.createdAt as string }));
}

export async function postedComments(directory: string, ticket: string): Promise<PostedComment[]> {
  if (!UUID.test(ticket)) return [];
  return (await records(join(directory, "agent-comments", ticket))).map((entry) => entry.value)
    .filter((value) => text(value.id) && text(value.issueId) && text(value.createdAt))
    .map((value) => ({ id: value.id as string, issueId: value.issueId as string, identifier: text(value.identifier) ? value.identifier : null, createdAt: value.createdAt as string }));
}

// The ids of the plugin's key-written comments; records older than PLUGIN_RECORD_MS are removed.
export async function pluginComments(directory: string, now = Date.now()): Promise<string[]> {
  const folder = join(directory, "agent-comments", PLUGIN);
  const ids: string[] = [];
  for (const { name, value } of await records(folder)) {
    if (!text(value.id)) continue;
    if (!text(value.createdAt) || now - Date.parse(value.createdAt) > PLUGIN_RECORD_MS) await rm(join(folder, name), { force: true });
    else ids.push(value.id);
  }
  return ids;
}

// Every comment id recorded here: the ticket agents' (every ticket) and the plugin's.
export async function recordedComments(directory: string, now = Date.now()): Promise<Set<string>> {
  const ids = new Set<string>(await pluginComments(directory, now));
  for (const ticket of await readdir(join(directory, "agent-comments")).catch(() => [] as string[])) {
    for (const comment of await postedComments(directory, ticket)) ids.add(comment.id);
  }
  return ids;
}

// When the oldest comment record still kept was written (ticket agents' and the plugin's), or null
// without one: the weekly decision candidates count the owner's comments only from there.
export async function oldestRecord(directory: string): Promise<string | null> {
  let oldest: number | null = null;
  for (const folder of await readdir(join(directory, "agent-comments")).catch(() => [] as string[])) {
    for (const { value } of await records(join(directory, "agent-comments", folder))) {
      const at = text(value.createdAt) ? Date.parse(value.createdAt) : Number.NaN;
      if (!Number.isNaN(at) && (oldest === null || at < oldest)) oldest = at;
    }
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

// The deputy's evidence (deputy-sources.ts) reads the same records strictly: a record it cannot
// list, read, parse or use throws instead of vanishing, because a vanished record would let the
// plugin's own writing pass as the owner's own words. The tolerant readers above stay for the
// weekly review display and the comment relay, where a lost record is missing context rather than
// misattributed authority. Nothing here is pruned or aged out: a record that is still kept proves
// who wrote a comment, however old it is.
async function recordFolders(directory: string): Promise<string[]> {
  const root = join(directory, "agent-comments");
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; // No record was ever written on this host.
    throw error;
  });
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.name !== PLUGIN && !UUID.test(entry.name)) continue; // Neither the plugin's nor an agent's record folder: ignore it.
    // A known record folder that is no longer a folder (a file, a symlink) has lost the records
    // under it: reading it as absent would let the plugin's own writing pass as the owner's own.
    if (!entry.isDirectory()) throw new Error(`the comment record folder ${entry.name} is not a folder`);
    folders.push(join(root, entry.name));
  }
  return folders;
}

// Every record kept in one folder, or a throw: the format always carries the comment id and the
// timestamp it was written at, so a record missing either one is damage, not an absent record.
async function strictRecords(folder: string): Promise<{ id: string; at: number }[]> {
  return Promise.all((await readdir(folder)).filter((name) => name.endsWith(".json")).map(async (name) => {
    const raw = await readFile(join(folder, name), "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`the comment record ${name} is not valid JSON`);
    }
    const entry = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const at = text(entry.createdAt) ? Date.parse(entry.createdAt) : Number.NaN;
    if (!text(entry.id) || Number.isNaN(at)) throw new Error(`the comment record ${name} has no comment id or no readable timestamp`);
    return { id: entry.id, at };
  }));
}

// The provenance of the plugin's own writing, read strictly, for the deputy's evidence: the ids of
// every recorded comment and when the oldest kept record was written, from one snapshot over the
// records together (two reads could tear: one seeing a record the other does not).
export type RecordProvenance = { recorded: string[]; recordsFrom: string | null };
export async function strictRecordProvenance(directory: string): Promise<RecordProvenance> {
  const ids = new Set<string>();
  let oldest: number | null = null;
  for (const folder of await recordFolders(directory)) for (const record of await strictRecords(folder)) {
    ids.add(record.id);
    if (oldest === null || record.at < oldest) oldest = record.at;
  }
  return { recorded: [...ids].sort(), recordsFrom: oldest === null ? null : new Date(oldest).toISOString() };
}

export async function recordPluginComment(directory: string, id: string, issueId: string, now = new Date()): Promise<void> {
  const folder = join(directory, "agent-comments", PLUGIN);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${id.replace(/[^A-Za-z0-9-]/g, "")}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ id, issueId, createdAt: now.toISOString() }), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
