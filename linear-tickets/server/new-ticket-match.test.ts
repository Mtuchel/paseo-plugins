import assert from "node:assert/strict";
import { test } from "node:test";
import type { CandidateIssue } from "./linear";
import { AREA_REQUEST, COMMENT_HEADING, filedByPaseo, findings, pageNames, renderComment, sameAsReferences, similarTitle, type NewTicket } from "./new-ticket-match";
import type { OpenWork } from "./related-work";

const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
function candidate(n: number, over: Partial<CandidateIssue> = {}): CandidateIssue {
  return { id: `i${n}`, identifier: `TUC-${n}`, title: `Ticket ${n}`, description: "", updatedAt: "2026-10-14T00:00:00Z", status: "Todo", statusType: "unstarted", labels: [], pullRequests: [], planDocuments: [], ...over };
}
function ticket(over: Partial<NewTicket> = {}): NewTicket {
  return { id: "new", identifier: "TUC-900", title: "Something else entirely", description: "", areas: [], ...over };
}
const work = (open: CandidateIssue[], plans: OpenWork["plans"] = []): OpenWork => ({ open: { items: open, complete: true }, plans, unreadPlans: [] });
const noFiles = () => null;

test("AC-1: a German title with a hyphenated word matches an open ticket, and stop words never do", () => {
  assert.deepEqual(similarTitle("Gutschrift-PDF zeigt falsche USt", "Gutschrift PDF falsche USt bei Teilgutschrift")?.shared, ["gutschrift", "pdf", "falsche", "ust"]);
  // One shared word is never enough, whatever the score.
  assert.equal(similarTitle("Gutschrift", "Gutschrift drucken"), null);
  // Shared stop words count for nothing.
  assert.equal(similarTitle("Fix the bug for the order", "Fix the bug for the invoice"), null);
  assert.equal(similarTitle("Kunde wird nicht gespeichert bei Import", "Artikel wird nicht gefunden bei Suche"), null);
});

test("page names are quoted prose of 3 to 60 characters, never paths or code", () => {
  const names = pageNames('Auf der Seite „Gutschriften“ und “Offene Posten” fehlt "Summe"; «Mahnungen» auch. "ab" `"Code"` "server/a.ts" "index.html"\n```\n"Fenced"\n```');
  assert.deepEqual([...names.keys()], ["gutschriften", "offene posten", "summe", "mahnungen"]);
  assert.equal(pageNames(`"${"x".repeat(61)}"`).size, 0);
});

test("AC-1: findings name each reason, rank by reasons, and leave out the ticket itself", () => {
  const open = [
    candidate(640, { title: "Gutschrift PDF falsche USt bei Teilgutschrift", labels: ["Area: Sales"] }),
    candidate(655, { title: "Rounding", description: "Touches `server/billing/vat.ts`." }),
    candidate(656, { title: "Plan only" }),
    candidate(657, { title: "PR only", pullRequests: [pr(7)] }),
    candidate(658, { title: "Totals", description: "On the „Gutschriften“ page." }),
    candidate(659, { title: "Unrelated", labels: ["Area: Sales"] }),
    candidate(900, { id: "new", title: "Gutschrift-PDF zeigt falsche USt" }),
  ];
  const mine = ticket({ title: "Gutschrift-PDF zeigt falsche USt", description: "See `server/billing/vat.ts` and `client/credit.tsx`; page „Gutschriften“.", areas: ["Sales"] });
  const found = findings(mine, work(open, [{ identifier: "TUC-656", files: ["client/credit.tsx"] }]), (url) => (url === pr(7) ? ["o/r/server/billing/vat.ts"] : null));
  assert.deepEqual(found.map((f) => f.identifier), ["TUC-640", "TUC-655", "TUC-656", "TUC-657", "TUC-658"]);
  assert.deepEqual(found[0].areas, ["Sales"], "a shared Area is an extra reason next to the title");
  assert.deepEqual(found[1].files, { names: ["server/billing/vat.ts"], sources: ["description"] });
  assert.deepEqual(found[2].files, { names: ["client/credit.tsx"], sources: ["approved plan"] });
  assert.deepEqual(found[3].files, { names: ["server/billing/vat.ts"], sources: ["pull request"] });
  assert.deepEqual(found[4].pages, ["Gutschriften"]);
  const body = renderComment(found, false, [])!;
  assert.ok(body.startsWith(`${COMMENT_HEADING}\n\n- TUC-640 — Gutschrift PDF falsche USt bei Teilgutschrift (Todo): similar title (gutschrift, pdf, falsche, ust); same Area (Sales)\n`));
  assert.match(body, /^- TUC-656 — Plan only \(Todo\): files named in its approved plan: `client\/credit\.tsx`$/m);
  assert.match(body, /^- TUC-658 — Totals \(Todo\): same page: “Gutschriften”$/m);
});

test("AC-1: a shared Area alone is no finding, and at most 5 are listed, most reasons first", () => {
  assert.deepEqual(findings(ticket({ areas: ["Sales"] }), work([candidate(1, { labels: ["Area: Sales"] })]), noFiles), []);
  const open = Array.from({ length: 7 }, (_, n) => candidate(n + 1, { title: `Invoice export broken ${n}`, description: n === 6 ? "`a/b.ts`" : "" }));
  const found = findings(ticket({ title: "Invoice export broken", description: "`a/b.ts`" }), work(open), noFiles);
  assert.deepEqual(found.map((f) => f.identifier), ["TUC-7", "TUC-1", "TUC-2", "TUC-3", "TUC-4"]);
});

test("the comment: Area request alone, gaps only next to another part", () => {
  assert.equal(renderComment([], false, ["the plans of TUC-655 could not be read"]), null);
  assert.equal(renderComment([], true, []), AREA_REQUEST);
  assert.equal(renderComment([], true, ["the plans of TUC-655 could not be read"]), `${AREA_REQUEST}\n\nNot fully checked: the plans of TUC-655 could not be read.`);
});

test("AC-2: tickets Paseo filed are recognised by either host's app and by every marker", () => {
  const apps = ["app-laptop", "app-server"];
  const plain = { creatorId: "owner", title: "Plain", description: "Text" };
  assert.equal(filedByPaseo(plain, apps), false);
  assert.equal(filedByPaseo({ ...plain, creatorId: null }, apps), false);
  for (const creatorId of apps) assert.equal(filedByPaseo({ ...plain, creatorId }, apps), true, creatorId);
  const titles = ["Needs you: Which bucket?", "Catch up the related work of 3 approved plans", "Decision candidates, week 41", "⚠️ Paseo needs attention", "Greptile is not reviewing"];
  for (const title of titles) assert.equal(filedByPaseo({ ...plain, title }, apps), true, title);
  const descriptions = [
    "Follow-up from TUC-1's approved plan: x. Filed by Paseo in Backlog when the plan was approved.",
    "Body\n\n---\nFiled by the Paseo agent working on TUC-1.",
    "Steps\n\n---\nManual task for TUC-1, after the merge.",
    "Marker: `greptile-outage`\n\nList",
    "Marker: `ops-kind pulls: e`",
    "Marker: `decision-candidates ERP 2026-W41`",
    "Step 2 of 3 of TUC-12.\n\n**This step:** x",
  ];
  for (const description of descriptions) assert.equal(filedByPaseo({ ...plain, description }, apps), true, description);
  // Near misses stay the owner's tickets.
  assert.equal(filedByPaseo({ ...plain, title: "Greptile is not reviewing PR 4" }, apps), false);
  assert.equal(filedByPaseo({ ...plain, description: "I did step 2 of 3 of TUC-12." }, apps), false);
});

test("AC-5: same-as references need a place word, defect evidence and no other type", () => {
  const refs = (text: string, labelNames: string[] = [], identifier = "TUC-900") => sameAsReferences({ identifier, title: "Title", description: text, labelNames });
  assert.deepEqual(refs("Same as TUC-640, but on the Gutschriften page.", ["Type: Bug"]), ["TUC-640"]);
  assert.deepEqual(refs("This is the same bug as TUC-640 on another page."), ["TUC-640"]);
  assert.deepEqual(refs("Derselbe Fehler wie bei TUC-640, nur in der Maske Gutschriften."), ["TUC-640"]);
  assert.deepEqual(refs("Wie in TUC-640, aber auf der Seite Gutschriften.", ["Type: Bug"]), ["TUC-640"]);
  assert.deepEqual(refs("Same bug as TUC-640 on another page. Same issue as tuc-641 in the export dialog."), ["TUC-640", "TUC-641"]);
  // Negatives: nothing is written.
  assert.deepEqual(refs("See TUC-640 on another page.", ["Type: Bug"]), []);
  assert.deepEqual(refs("Similar to TUC-640 on another page.", ["Type: Bug"]), []);
  assert.deepEqual(refs("Make this form behave the same as TUC-640."), []);
  assert.deepEqual(refs("Same bug as TUC-640."), [], "no place word");
  assert.deepEqual(refs("Same bug as TUC-640.\nOn another page."), [], "the place word is in another sentence");
  assert.deepEqual(refs("Same bug as TUC-640 on another page.", ["Type: Feature"]), []);
  assert.deepEqual(refs("Same bug as TUC-640 on another page.", ["Type: Bug", "Type: Feature"]), []);
  assert.deepEqual(refs("Same bug as TUC-900 on another page."), [], "never the ticket itself");
});
