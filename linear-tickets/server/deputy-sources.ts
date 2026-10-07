import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LinearService } from "./linear";
import type { Citation, CitationKind, DecisionLog, LogEntry } from "./owner-decisions";
import { normalize } from "./owner-decisions";

// Knowledge second (README, "Deputy for agent questions"): the recorded knowledge a question may be
// decided from, read in the owner's order of authority, each source cut into short sections of
// which only those that share words with the question are shown to the evaluator. A source the
// deputy cannot read when it should exist makes it abstain: it never answers from less than the
// owner would expect it to have read.
//
// 1. the ticket's approved plan (its "Plan:" document, approved in Plannotator, on a plan-ready ticket);
// 2. `docs/principles/` (approved.md, decisions.md, decision-queue.md) at one `origin/main` commit;
// 3. the plugin README, the launch template and the agent repository's AGENTS.md;
// 4. earlier owner answers the plugin itself delivered for the authenticated owner;
// 5. Hindsight recall.
// Open proposals (the decision queue), rejected or superseded decisions and memories can only
// block an answer (`decisive: false`); recall rank is not authority.

export type Source = { id: string; kind: CitationKind; title: string; revision: string; url?: string; text: string; decisive: boolean };
export type Snapshot = { sources: Source[]; abstain: string | null };

export type PlanDocument = { url: string; content: string };
export type Principles = { commit: string; files: Record<string, string> };
export type RuleDocument = { id: string; title: string; text: string; url?: string };
export type Memory = { id: string; text: string; at?: string };

// Each reader throws when its source exists but cannot be read; null/empty means there is none.
export type SourceReaders = {
  plan(issueId: string, identifier: string): Promise<PlanDocument | null>;
  principles(repository: string): Promise<Principles>;
  rules(cwd: string): Promise<RuleDocument[]>;
  ownerAnswers(): Promise<LogEntry[]>;
  recall(query: string): Promise<Memory[]>;
};

export type Question = { id: string; issueId: string; identifier: string; cwd: string; text: string; planApproved: boolean };

const SECTION_CHARS = 2_400;
const TOTAL_CHARS = 40_000;
const PER_SOURCE = { plan: 6, principles: 6, queue: 3, rules: 6, answers: 5, memories: 5 };
const STOP = new Set("about above after again agent also because been before being below between both but can cannot could does doing down during each from further have having here how into its itself just more most must need only other over same should some such than that their them then there these they this those through under until very want what when where which while will with would your yours yourself the and for are was were not you our out any all".split(" "));

export const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) ?? []).filter((word) => !STOP.has(word)));
}

// Markdown sections (a heading, its level, and what follows until the next heading of any level),
// long ones cut at paragraph boundaries; `continued` marks the cut-off rest of the one before.
export type Section = { heading: string; level: number; body: string; continued: boolean };
// With `headings`, a heading with no text of its own is kept (empty body): a register entry may
// open with subsections only.
export function sections(text: string, headings = false): Section[] {
  const found: Section[] = [];
  let heading = "";
  let level = 0;
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (body || heading) {
      let rest = body;
      let continued = false;
      while (rest.length > SECTION_CHARS) {
        const cut = rest.lastIndexOf("\n\n", SECTION_CHARS);
        const at = cut > SECTION_CHARS / 3 ? cut : SECTION_CHARS;
        found.push({ heading, level, body: rest.slice(0, at).trim(), continued });
        continued = true;
        rest = rest.slice(at).trim();
      }
      if (rest || (headings && !continued)) found.push({ heading, level, body: rest, continued });
    }
    lines = [];
  };
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,4}\s+\S/.test(line)) {
      flush();
      level = /^#+/.exec(line)?.[0].length ?? 1;
      heading = line.replace(/^#+\s+/, "").trim();
      continue;
    }
    lines.push(line);
  }
  flush();
  return headings ? found : found.filter((section) => section.body);
}

// Per section of a register file: its entry (`P-`/`D-`/`Q-`/`E-<n>`, from its heading down to the
// next heading of the same or a higher level) and whether that whole entry binds. An outcome of
// rejected, superseded, withdrawn or deferred anywhere in the entry makes every excerpt of it
// (subsections and cut continuations too) non-binding. Ids are unique: the entry's first excerpt
// carries the bare id, later ones `<id>#<section>`.
export function registerEntries(text: string): { id: string; binding: boolean }[] {
  const all = sections(text, true);
  const owner: (number | null)[] = [];
  let open: { index: number; level: number } | null = null;
  all.forEach((section, index) => {
    if (open && !section.continued && section.level <= open.level) open = null;
    if (!open && !section.continued && /^[PDQE]-\d+\b/.test(section.heading)) open = { index, level: section.level };
    owner.push(open ? open.index : null);
  });
  const binding = new Map<number, boolean>();
  owner.forEach((start, index) => { if (start !== null) binding.set(start, (binding.get(start) ?? true) && !NOT_BINDING.test(all[index].body)); });
  // Numbered like `sections(text)`, which leaves out heading-only sections.
  const found: { id: string; binding: boolean }[] = [];
  const named = new Set<number>();
  all.forEach((section, index) => {
    if (!section.body) return;
    const start = owner[index];
    const position = found.length;
    if (start === null) { found.push({ id: `#${position}`, binding: !NOT_BINDING.test(section.body) }); return; }
    const id = /^([PDQE]-\d+)\b/.exec(all[start].heading)?.[1] ?? `#${position}`;
    found.push({ id: named.has(start) ? `${id}#${position}` : id, binding: binding.get(start) ?? true });
    named.add(start);
  });
  return found;
}

// The sections sharing the most words with the question, at most `limit`, in document order.
function relevant(text: string, question: Set<string>, limit: number): { index: number; heading: string; body: string }[] {
  const scored = sections(text).map((section, index) => {
    const words = terms(`${section.heading}\n${section.body}`);
    let score = 0;
    for (const word of question) if (words.has(word)) score++;
    return { index, ...section, score };
  });
  return scored.filter((section) => section.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).sort((a, b) => a.index - b.index);
}

const APPROVED_PLAN = /^> \*\*Approved\*\* in Plannotator/;
const NOT_BINDING = /^-\s*Outcome:\s*(?:rejected|superseded|withdrawn|deferred)\b/im;

export async function gatherSources(readers: SourceReaders, question: Question, principlesRepository: string | null): Promise<Snapshot> {
  const words = terms(question.text);
  const sources: Source[] = [];
  const add = (source: Source) => sources.push({ ...source, text: source.text.slice(0, SECTION_CHARS) });

  // 1. The approved plan.
  if (question.planApproved) {
    let plan: PlanDocument | null;
    try {
      plan = await readers.plan(question.issueId, question.identifier);
    } catch (error) {
      return { sources: [], abstain: `the ticket's approved plan could not be read (${error instanceof Error ? error.message : error})` };
    }
    // A plan-ready ticket whose plan document is missing, empty or not marked approved leaves the
    // deputy without the plan's constraints: it abstains rather than decide from less.
    if (!plan || !APPROVED_PLAN.test(plan.content.trim())) return { sources: [], abstain: plan ? "the ticket's plan document is not marked approved" : "the ticket has no plan document to check the answer against" };
    const revision = hash(plan.content);
    for (const section of relevant(plan.content, words, PER_SOURCE.plan)) {
      add({ id: `plan#${section.index}`, kind: "plan", title: `Plan: ${question.identifier} — ${section.heading || "start"}`, revision, url: plan.url, text: section.body, decisive: true });
    }
  }

  // 2. The principles register at one commit.
  if (!principlesRepository) return { sources, abstain: "no principles repository is configured (deputy.principlesRepository)" };
  let principles: Principles;
  try {
    principles = await readers.principles(principlesRepository);
  } catch (error) {
    return { sources, abstain: `docs/principles on origin/main could not be read (${error instanceof Error ? error.message : error})` };
  }
  for (const [file, content] of Object.entries(principles.files)) {
    const queue = file === "decision-queue.md";
    const entries = registerEntries(content);
    for (const section of relevant(content, words, queue ? PER_SOURCE.queue : PER_SOURCE.principles)) {
      const entry = entries[section.index];
      add({ id: `principles:${file}:${entry.id}`, kind: "principles", title: `docs/principles/${file} — ${section.heading || "start"}${queue ? " (open proposal, not binding)" : ""}`, revision: principles.commit, text: section.body, decisive: !queue && entry.binding });
    }
  }

  // 3. The plugin's rules, the launch template and the repository's instructions.
  let rules: RuleDocument[];
  try {
    rules = await readers.rules(question.cwd);
  } catch (error) {
    return { sources, abstain: `the plugin rules or the repository instructions could not be read (${error instanceof Error ? error.message : error})` };
  }
  for (const document of rules) {
    const revision = hash(document.text);
    for (const section of relevant(document.text, words, PER_SOURCE.rules)) {
      add({ id: `rules:${document.id}#${section.index}`, kind: "rules", title: `${document.title} — ${section.heading || "start"}`, revision, ...(document.url ? { url: document.url } : {}), text: section.body, decisive: true });
    }
  }

  // 4. Owner answers the plugin delivered for the authenticated owner, with their questions.
  const entries = await readers.ownerAnswers();
  const asked = new Map(entries.flatMap((entry) => entry.kind === "question" ? [[entry.id, entry] as const] : []));
  const answered = entries.flatMap((entry) => {
    const asking = entry.kind === "owner-answer" && entry.userId && entry.id !== question.id ? asked.get(entry.id) : undefined;
    if (!asking || entry.kind !== "owner-answer") return [];
    const body = asking.questions.map((item) => [`Question: ${item.question}`, item.options.length ? `Options: ${item.options.join(" / ")}` : "", `Owner answered: ${entry.answers[item.key] || "(nothing)"}`].filter(Boolean).join("\n")).join("\n\n");
    return [{ entry, asking, body }];
  });
  const scored = answered.map((found) => {
    const own = terms(found.body);
    let score = 0;
    for (const word of words) if (own.has(word)) score++;
    return { ...found, score };
  }).filter((found) => found.score > 0).sort((a, b) => b.score - a.score).slice(0, PER_SOURCE.answers);
  for (const { entry, asking, body } of scored) {
    add({ id: `owner-answer:${entry.id}`, kind: "owner-answer", title: `Owner answer on ${asking.identifier}, ${entry.at.slice(0, 10)} (${entry.via})`, revision: entry.at, text: body, decisive: true });
  }

  // 5. Recall: context that can only block.
  let memories: Memory[];
  try {
    memories = await readers.recall(question.text);
  } catch (error) {
    return { sources, abstain: `Hindsight recall is unavailable (${error instanceof Error ? error.message : error})` };
  }
  for (const memory of memories.slice(0, PER_SOURCE.memories)) {
    add({ id: `memory:${memory.id}`, kind: "memory", title: `Remembered${memory.at ? ` (${memory.at.slice(0, 10)})` : ""}, not binding`, revision: memory.id, text: memory.text, decisive: false });
  }

  let total = 0;
  const kept = sources.filter((source) => (total += source.text.length) <= TOTAL_CHARS);
  return { sources: kept, abstain: null };
}

// A citation the evaluator returned, checked against the snapshot it was given: the source must
// exist and be able to decide, and the quote must be in it verbatim (whitespace aside).
export function verifyCitation(sources: Source[], sourceId: unknown, quote: unknown): Citation | string {
  if (typeof sourceId !== "string" || typeof quote !== "string") return "a citation has no source id or quote";
  const source = sources.find((known) => known.id === sourceId);
  if (!source) return `the citation names an unknown source ${JSON.stringify(sourceId).slice(0, 80)}`;
  if (!source.decisive) return `${source.id} cannot decide an answer (${source.kind === "memory" ? "a memory" : "an open proposal or a decision that is not binding"})`;
  const wanted = normalize(quote);
  if (wanted.length < 12) return `the quote from ${source.id} is too short to decide anything`;
  if (!normalize(source.text).includes(wanted)) return `the quote is not verbatim in ${source.id}`;
  return { sourceId: source.id, kind: source.kind, title: source.title, revision: source.revision, quote: wanted, ...(source.url ? { url: source.url } : {}) };
}

// ---------------------------------------------------------------------------------------------
// The host's readers

const run = promisify(execFile);
// One fetch per repository at most every 10 minutes: every question reads the same commit.
const FETCH_EVERY_MS = 10 * 60 * 1000;
const fetchedAt = new Map<string, number>();

export async function readPrinciples(repository: string, now = Date.now()): Promise<Principles> {
  if (now - (fetchedAt.get(repository) ?? 0) >= FETCH_EVERY_MS) {
    await run("git", ["-C", repository, "fetch", "--quiet", "origin", "main"], { timeout: 60_000 });
    fetchedAt.set(repository, now);
  }
  const commit = (await run("git", ["-C", repository, "rev-parse", "origin/main"], { timeout: 10_000 })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("origin/main does not resolve to a commit");
  const files: Record<string, string> = {};
  for (const file of ["approved.md", "decisions.md", "decision-queue.md"]) {
    files[file] = (await run("git", ["-C", repository, "show", `${commit}:docs/principles/${file}`], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })).stdout;
  }
  if (!files["approved.md"].trim() || !files["decisions.md"].trim()) throw new Error("the principles register is empty");
  return { commit: commit.slice(0, 12), files };
}

// The plugin directory Paseo loads (its config names it), for the README the agents follow.
export async function pluginReadme(home: string): Promise<RuleDocument> {
  const config: unknown = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  const plugins = config && typeof config === "object" && "plugins" in config && config.plugins && typeof config.plugins === "object" ? Object.entries(config.plugins) : [];
  const entry = plugins.find(([id]) => id === "linear-tickets")?.[1];
  const path = entry && typeof entry === "object" && "path" in entry && typeof entry.path === "string" ? entry.path : null;
  if (!path) throw new Error("the linear-tickets plugin directory is not in the Paseo config");
  return { id: "plugin-readme", title: "linear-tickets README", text: await readFile(join(path, "README.md"), "utf8") };
}

// The agent repository's root AGENTS.md; none is fine, an unreadable one is not.
export async function repositoryInstructions(cwd: string): Promise<RuleDocument | null> {
  const root = (await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 })).stdout.trim();
  const text = await readFile(join(root, "AGENTS.md"), "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  return text ? { id: "agents-md", title: `AGENTS.md (${root})`, text } : null;
}

export type RecallAccess = { url: string; bank: string; token: string };

// Host-local Hindsight access: `deputy/recall.json` ({ url, bank, token }, private to the daemon
// user), else omp's configured `hindsight.apiUrl` with bank `omp` and HINDSIGHT_API_TOKEN. The
// token never leaves this host: not in settings, prompts, citations or reports.
export async function recallAccess(directory: string, env = process.env): Promise<RecallAccess | null> {
  const stored: unknown = await readFile(join(directory, "recall.json"), "utf8").then((content) => JSON.parse(content), () => null);
  if (stored && typeof stored === "object" && "url" in stored && "token" in stored && typeof stored.url === "string" && typeof stored.token === "string" && stored.token) {
    return { url: stored.url.replace(/\/+$/, ""), bank: "bank" in stored && typeof stored.bank === "string" && stored.bank ? stored.bank : "omp", token: stored.token };
  }
  const token = env.HINDSIGHT_API_TOKEN;
  if (!token) return null;
  const config = await readFile(join(homedir(), ".omp", "agent", "config.yml"), "utf8").catch(() => "");
  const url = /^hindsight:\s*\n(?:[ \t]+.*\n)*?[ \t]+apiUrl:\s*["']?([^"'\s]+)/m.exec(config)?.[1];
  return url ? { url: url.replace(/\/+$/, ""), bank: "omp", token } : null;
}

export async function recall(access: RecallAccess | null, query: string): Promise<Memory[]> {
  if (!access) throw new Error("no Hindsight access is configured on this host");
  const response = await fetch(`${access.url}/v1/default/banks/${encodeURIComponent(access.bank)}/memories/recall`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ query: query.slice(0, 800), max_tokens: 1_500 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Hindsight answered HTTP ${response.status}`);
  const body: unknown = await response.json();
  const results = body && typeof body === "object" && "results" in body && Array.isArray(body.results) ? body.results : [];
  return results.flatMap((item: unknown) => item && typeof item === "object" && "id" in item && "text" in item && typeof item.id === "string" && typeof item.text === "string"
    ? [{ id: item.id, text: item.text, ...("occurred_start" in item && typeof item.occurred_start === "string" ? { at: item.occurred_start } : {}) }]
    : []);
}

// The readers on this host: the ticket's "Plan:" document, the principles register, the plugin
// README, the effective launch template (custom or built-in) and the agent repository's
// AGENTS.md, the decision log and Hindsight recall.
export function hostReaders(deps: { linear: Pick<LinearService, "issueDocument">; log: Pick<DecisionLog, "entries">; home: string; directory: string; template: () => Promise<string> }): SourceReaders {
  return {
    plan: (issueId, identifier) => deps.linear.issueDocument(issueId, `Plan: ${identifier}`),
    principles: (repository) => readPrinciples(repository),
    rules: async (cwd) => {
      const instructions = await repositoryInstructions(cwd);
      const template: RuleDocument = { id: "launch-template", title: "Launch template (the prompt every ticket agent starts with)", text: await deps.template() };
      return [await pluginReadme(deps.home), template, ...(instructions ? [instructions] : [])];
    },
    ownerAnswers: () => deps.log.entries(),
    recall: async (query) => recall(await recallAccess(deps.directory), query),
  };
}
