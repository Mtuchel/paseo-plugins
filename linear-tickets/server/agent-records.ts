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
