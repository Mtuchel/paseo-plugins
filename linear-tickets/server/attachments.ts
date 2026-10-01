import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const ATTACHMENT_DIRECTORY = ".linear";

// Linear's own file storage. Its URLs need the API key (or a short-lived signature), so an
// agent cannot open them; everything else is an ordinary link the agent can fetch itself.
const UPLOAD_URL = /https:\/\/uploads\.linear\.app\/[A-Za-z0-9/_.-]+/g;
const EMBED = /<linear-embed[^>]*>([\s\S]*?)<\/linear-embed>/g;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\((https:\/\/uploads\.linear\.app\/[A-Za-z0-9/_.-]+)[^)\s]*\)/g;

export type UploadReference = { url: string; name: string };

function collectStrings(value: unknown, into: string[]): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, into);
  return into;
}

// Every Linear upload referenced anywhere in the ticket snapshot (description, comments,
// attachments), keyed by URL without its signature. Names come from Linear's file embeds
// or markdown link text, falling back to the upload's ID.
export function uploadReferences(context: string): UploadReference[] {
  let parsed: unknown;
  try { parsed = JSON.parse(context); } catch { return []; }
  const found = new Map<string, string>();
  for (const text of collectStrings(parsed, [])) {
    for (const [, body] of text.matchAll(EMBED)) {
      try {
        const embed: unknown = JSON.parse(body);
        if (!embed || typeof embed !== "object" || !("href" in embed) || typeof embed.href !== "string") continue;
        const url = embed.href.match(UPLOAD_URL)?.[0];
        const name = "name" in embed && typeof embed.name === "string" ? embed.name : "";
        if (url && name) found.set(url, name);
      } catch { /* Not an embed Paseo understands; the bare-URL pass still finds it. */ }
    }
    for (const [, text_, url] of text.matchAll(MARKDOWN_LINK)) if (text_.trim() && !found.has(url)) found.set(url, text_.trim());
    for (const [url] of text.matchAll(UPLOAD_URL)) if (!found.has(url)) found.set(url, url.split("/").pop() || "file");
  }
  return [...found].map(([url, name]) => ({ url, name }));
}

// A file name that stays inside the attachment directory on every platform.
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
  return cleaned || "file";
}

export type Download = (url: string) => Promise<Uint8Array>;
export type SavedAttachments = { directory: string; files: { name: string; path: string }[]; warnings: string[] };

// Downloads a ticket's Linear uploads into `<cwd>/.linear/<identifier>/` and keeps that
// directory out of git. Best-effort: a failed or oversized file becomes a warning, never
// a launch failure, and the key never reaches the agent — only the files do.
export async function saveAttachments(cwd: string, identifier: string, context: string, download: Download): Promise<SavedAttachments> {
  const references = uploadReferences(context);
  const directory = join(ATTACHMENT_DIRECTORY, safeFileName(identifier));
  const result: SavedAttachments = { directory, files: [], warnings: [] };
  if (!references.length) return result;
  if (references.length > MAX_ATTACHMENTS) result.warnings.push(`Only the first ${MAX_ATTACHMENTS} of ${references.length} Linear attachments were downloaded.`);
  await mkdir(join(cwd, directory), { recursive: true });
  await excludeFromGit(cwd).catch(() => result.warnings.push(`Could not add ${ATTACHMENT_DIRECTORY}/ to the worktree's git exclude list; do not commit it.`));
  const used = new Set<string>();
  let total = 0;
  for (const { url, name } of references.slice(0, MAX_ATTACHMENTS)) {
    let bytes: Uint8Array;
    try {
      bytes = await download(url);
    } catch (error) {
      result.warnings.push(`Could not download attachment "${name}": ${error instanceof Error ? error.message : "unknown error"}`);
      continue;
    }
    if (total + bytes.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
      result.warnings.push(`Skipped attachment "${name}": the ticket's attachments exceed ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB in total.`);
      continue;
    }
    total += bytes.byteLength;
    const base = safeFileName(name);
    let file = base;
    for (let n = 2; used.has(file.toLowerCase()); n++) file = base.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
    used.add(file.toLowerCase());
    await writeFile(join(cwd, directory, file), bytes);
    result.files.push({ name, path: join(directory, file) });
  }
  return result;
}

async function excludeFromGit(cwd: string): Promise<void> {
  let relative: string;
  try {
    relative = (await exec("git", ["-C", cwd, "rev-parse", "--git-path", "info/exclude"], { timeout: 15_000 })).stdout.trim();
  } catch {
    return; // Not a git checkout: nothing to exclude from.
  }
  if (!relative) return;
  const path = isAbsolute(relative) ? relative : join(cwd, relative);
  const entry = `${ATTACHMENT_DIRECTORY}/`;
  const current = await readFile(path, "utf8").catch(() => "");
  if (current.split("\n").some((line) => line.trim() === entry)) return;
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
}

export function attachmentNote(saved: SavedAttachments): string {
  if (!saved.files.length) return "";
  return [
    "The ticket's Linear attachments were downloaded into this workspace (their uploads.linear.app URLs need Linear credentials, so use these local copies):",
    ...saved.files.map((file) => `- ${file.name}: ${file.path}`),
    `${saved.directory}/ is excluded from git; do not commit it.`,
  ].join("\n");
}
