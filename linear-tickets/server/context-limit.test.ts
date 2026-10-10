import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadReferences } from "./attachments";
import { boundedContext, buildPrompt, CONTEXT_TOO_LARGE, ContextTooLargeError, MAX_CONTEXT_CHARS, normalizeIssue, ticketRelations } from "./context";
import { COMMENT_QUERY, ISSUE_DETAIL_QUERY, LinearService, type Post } from "./linear";
import { Credentials } from "./credentials";
import { tmpdir } from "node:os";
import { join } from "node:path";

const issue = (description: string) => ({
  id: "issue-1", identifier: "ENG-42", title: "Fix the sign-in flow", description, url: "https://linear.app/x/issue/ENG-42",
  labels: { nodes: [{ name: "bug" }] }, attachments: { nodes: [{ title: "Pull request", url: "https://github.com/o/r/pull/7" }] },
  relations: { nodes: [{ type: "blocks", relatedIssue: { id: "issue-2", identifier: "ENG-43", title: "Blocked work" } }] },
});
const card = (at: string) => ({ id: `card-${at}`, body: `🛠 **Paseo progress** — ENG-42\n**Phase:** Working · updated ${at}`, createdAt: at });
const said = (id: string, at: string | undefined, body = `Comment ${id}`) => ({ id, body, ...(at ? { createdAt: at } : {}) });
const serialized = (description: string, comments: unknown[], history: unknown[] = []) => JSON.stringify({ issue: issue(description), comments, ...(history.length ? { stateHistory: history } : {}) }, null, 2);
const omitted = (context: string): unknown => JSON.parse(context).omittedComments;
const ids = (context: string): string[] => JSON.parse(context).comments.map((comment: { id: string }) => comment.id);
// A description that makes the full snapshot exactly `length` characters long.
const padded = (length: number, comments: unknown[]) => "d".repeat(length - serialized("", comments).length);

test("a snapshot at or under 200,000 characters is the full ticket; one character over is trimmed with a notice", () => {
  // A real progress card runs to several hundred characters: enough room for the notice.
  const comments = [{ ...card("2026-10-01T10:00:00.000Z"), body: `${card("2026-10-01T10:00:00.000Z").body}\n**Worktree:** ${"w".repeat(900)}` }, said("c1", "2026-10-01T09:00:00.000Z")];
  for (const length of [MAX_CONTEXT_CHARS - 1, MAX_CONTEXT_CHARS]) {
    const description = padded(length, comments);
    const result = boundedContext(issue(description), comments);
    assert.equal(result.context, serialized(description, comments));
    assert.equal(result.context.length, length);
    assert.equal(result.notice, null);
    assert.equal(omitted(result.context), undefined);
  }
  const description = padded(MAX_CONTEXT_CHARS + 1, comments);
  const over = boundedContext(issue(description), comments);
  assert.deepEqual(ids(over.context), ["c1"], "the status card goes first");
  assert.equal(over.notice, "1 comment omitted (1 status card; 0 oldest comments), from 2026-10-01 10:00 UTC to 2026-10-01 10:00 UTC. Read omitted comments with the Linear comment-history tool (get_comments).");
  assert.ok(over.context.length + over.notice!.length <= MAX_CONTEXT_CHARS);
  assert.equal(JSON.parse(over.context).issue.description, description);
});

test("trimming leaves out status cards before real comments, then the oldest real ones, and keeps everything else", () => {
  // Linear's order, deliberately unsorted; two comments share a timestamp.
  const comments = [
    said("c3", "2026-10-03T00:00:00.000Z", `Newest real ${"n".repeat(20_000)}`),
    card("2026-10-04T00:00:00.000Z"),
    said("c1a", "2026-10-01T00:00:00.000Z", `Tie A ${"a".repeat(20_000)}`),
    card("2026-09-30T00:00:00.000Z"),
    said("c1b", "2026-10-01T00:00:00.000Z", `Tie B ${"b".repeat(20_000)}`),
    said("c2", "2026-10-02T00:00:00.000Z", `Middle ${"m".repeat(20_000)}`),
  ];
  const history = [{ state: "Todo", startedAt: "2026-09-30T00:00:00Z", endedAt: null }];
  // Room for the newest two real comments, not three: both cards and both tied comments go.
  const description = padded(MAX_CONTEXT_CHARS + 35_000, comments);
  const full = issue(description);
  const result = boundedContext(full, comments, history);
  assert.deepEqual(ids(result.context), ["c3", "c2"], "Linear's order of what is kept stays");
  const parsed = JSON.parse(result.context);
  assert.deepEqual(parsed.issue, full, "description, labels, links and relations stay whole");
  assert.deepEqual(parsed.stateHistory, history);
  assert.deepEqual(omitted(result.context), { count: 4, statusCards: 2, oldComments: 2, oldest: "2026-09-30T00:00:00.000Z", newest: "2026-10-04T00:00:00.000Z", undated: 0, uploads: [] });
  assert.equal(result.notice, "4 comments omitted (2 status cards; 2 oldest comments), from 2026-09-30 00:00 UTC to 2026-10-04 00:00 UTC. Read omitted comments with the Linear comment-history tool (get_comments).");
  // Any input order gives the same snapshot.
  assert.deepEqual(ids(boundedContext(full, [...comments].reverse(), history).context).sort(), ["c2", "c3"]);
  // Of two comments with the same time, the one Linear listed first counts as older.
  const tie = boundedContext(issue(padded(MAX_CONTEXT_CHARS + 15_000, comments)), comments, history);
  assert.deepEqual(ids(tie.context), ["c3", "c1b", "c2"]);
});

test("the cut is minimal and exact for escaped and non-ASCII text", () => {
  const comments = Array.from({ length: 40 }, (_, index) => said(`c${index}`, new Date(Date.UTC(2026, 0, 1, index)).toISOString(), `Zeile ${index}: "Grüße" \\ ✓\n${"ü\t\"".repeat(1_500)}`));
  const description = "Beschreibung „mit“ Umlauten\n".repeat(3_000);
  const result = boundedContext(issue(description), comments);
  assert.ok(result.notice);
  assert.ok(result.context.length + result.notice.length <= MAX_CONTEXT_CHARS);
  const kept = ids(result.context);
  assert.equal(kept.at(-1), "c39", "the newest comment stays");
  const dropped = comments.length - kept.length;
  assert.deepEqual(kept, comments.slice(dropped).map((comment) => comment.id), "the oldest go, in order");
  // Keeping one more comment would not have fit.
  const oneMore = boundedContext(issue(description), comments.slice(dropped - 1));
  assert.notEqual(oneMore.notice, null);
});

test("undated comments count as the oldest, and an omission without any date says so", () => {
  const comments = [said("u1", undefined, `Undated ${"u".repeat(30_000)}`), said("c1", "2026-10-01T00:00:00.000Z", "Newest")];
  const result = boundedContext(issue(padded(MAX_CONTEXT_CHARS + 10, comments)), comments);
  assert.deepEqual(ids(result.context), ["c1"]);
  assert.match(result.notice!, /^1 comment omitted \(0 status cards; 1 oldest comment\), date unavailable\./);
  const mixed = [said("u1", undefined, "u".repeat(30_000)), said("c0", "2026-09-01T00:00:00.000Z", "o".repeat(30_000)), said("c1", "2026-10-01T00:00:00.000Z")];
  const both = boundedContext(issue(padded(MAX_CONTEXT_CHARS + 40_000, mixed)), mixed);
  assert.match(both.notice!, /from 2026-09-01 00:00 UTC to 2026-09-01 00:00 UTC \(1 without a date\)\./);
});

test("uploads of omitted comments stay listed, so the attachment download still finds them", () => {
  const upload = "https://uploads.linear.app/abc/def/report.pdf";
  const comments = [said("c0", "2026-09-01T00:00:00.000Z", `See [report.pdf](${upload}) ${"x".repeat(30_000)}`), said("c1", "2026-10-01T00:00:00.000Z")];
  const result = boundedContext(issue(padded(MAX_CONTEXT_CHARS + 10, comments)), comments);
  assert.deepEqual(ids(result.context), ["c1"]);
  assert.deepEqual(uploadReferences(result.context), [{ url: upload, name: "report.pdf" }]);
});

test("a ticket that cannot fit fails with today's message: an oversized description, or a newest comment that is too long", () => {
  const huge = "x".repeat(MAX_CONTEXT_CHARS + 1);
  for (const comments of [[], [card("2026-10-01T00:00:00.000Z")]]) {
    assert.throws(() => boundedContext(issue(huge), comments), (error: unknown) => error instanceof ContextTooLargeError && error.message === CONTEXT_TOO_LARGE);
  }
  assert.equal(CONTEXT_TOO_LARGE, "This ticket and its comments are too large to send in one prompt (200,000 characters maximum).");
  // The newest real comment is never cut or dropped: when only it is too long, the start fails.
  const comments = [said("c0", "2026-09-01T00:00:00.000Z", "old"), said("c1", "2026-10-01T00:00:00.000Z", "y".repeat(MAX_CONTEXT_CHARS))];
  assert.throws(() => boundedContext(issue("short"), comments), ContextTooLargeError);
});

test("the ticket preview and both prompt kinds carry the omission notice from a paginated detail read", async () => {
  const pages = [
    [said("c2", "2026-10-02T00:00:00.000Z", "The newest instruction"), card("2026-10-03T00:00:00.000Z")],
    [said("c1", "2026-10-01T00:00:00.000Z", "o".repeat(60_000)), card("2026-09-30T00:00:00.000Z")],
  ];
  const description = "d".repeat(150_000);
  const post: Post = async (_key, query, variables) => {
    if (query === ISSUE_DETAIL_QUERY) return { issue: issue(description) };
    if (query === COMMENT_QUERY) {
      const page = variables.after == null ? 0 : 1;
      return { issue: { comments: { nodes: pages[page], pageInfo: { hasNextPage: page === 0, endCursor: page === 0 ? "p2" : null } } } };
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  const linear = new LinearService(new Credentials(join(tmpdir(), `paseo-context-limit-${process.pid}`), "env-key"), post);
  const detail = await linear.detail("ENG-42");
  assert.deepEqual(ids(detail.context), ["c2"]);
  const notice = "3 comments omitted (2 status cards; 1 oldest comment), from 2026-09-30 00:00 UTC to 2026-10-03 00:00 UTC. Read omitted comments with the Linear comment-history tool (get_comments).";
  assert.deepEqual(detail.warnings, [notice], "the preview shows it as a context warning");
  assert.equal(JSON.parse(detail.context).omittedComments.count, 3);
  assert.deepEqual(detail.relations, ticketRelations(issue(description)));
  for (const template of [undefined, "Do {{ticket}}.\n\n{{context}}"]) {
    const prompt = buildPrompt(detail, "", template);
    assert.ok(prompt.includes(`Context limitations:\n${notice}`), template ?? "default prompt");
    assert.ok(prompt.includes("The newest instruction"));
  }
});
