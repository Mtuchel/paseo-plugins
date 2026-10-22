import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { askHash, checkExtraction, extractionPrompt, extractWithOmp, MAX_DESCRIPTION_CHARS, MAX_LABEL_CHARS, MAX_OPTIONS, MAX_QUESTIONS, MAX_SOURCE_CHARS, SYSTEM_PROMPT, type ExtractInput } from "./owner-ask-extract";
import type { OmpRun } from "./omp-runner";

const answer = (value: unknown): string => JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(value) }] } });
// checkExtraction reads the model's text; the envelope above is what the runner's stdout carries.
const payload = (value: unknown): string => JSON.stringify(value);

test("a good extraction is accepted, its options cleaned of anything that is not a choice", () => {
  const raw = [
    "Here is the JSON:",
    "```json",
    JSON.stringify({
      kind: "decision",
      summary: "  The agent asks   who takes TUC-1562. ",
      questions: [{
        question: "Who takes TUC-1562?",
        multiSelect: false,
        options: [
          { label: "Agent does it", description: "I plan it and send the plan for approval." },
          { label: "You or the team" },
          { label: "Reply here with “@paseo <your answer>”" },
          { label: "Needs input" },
          { label: "Q2" },
          { label: "agent does it" },
        ],
      }],
    }),
    "```",
  ].join("\n");
  const checked = checkExtraction(raw);
  assert.ok(checked.ok, checked.ok ? "" : checked.reason);
  assert.equal(checked.value.kind, "decision");
  assert.equal(checked.value.summary, "The agent asks who takes TUC-1562.");
  assert.deepEqual(checked.value.questions, [{
    key: "q1",
    question: "Who takes TUC-1562?",
    options: [
      { label: "Agent does it", description: "I plan it and send the plan for approval." },
      { label: "You or the team", description: "" },
    ],
    multiSelect: false,
  }]);
});

test("a manual ask keeps its summary and has no questions; a decision with nothing to decide becomes info", () => {
  const manual = checkExtraction(payload({ kind: "manual", summary: "Rotate the Telegram token with BotFather.", questions: [] }));
  assert.ok(manual.ok);
  assert.deepEqual(manual.value, { kind: "manual", summary: "Rotate the Telegram token with BotFather.", questions: [] });
  const empty = checkExtraction(payload({ kind: "decision", summary: "An update about the deploy.", questions: [] }));
  assert.ok(empty.ok);
  assert.equal(empty.value.kind, "info");
});

test("junk is rejected: not an object, an unknown kind, no summary, a question without text, an empty label, or too many entries", () => {
  const cases: [string, string][] = [
    ["not JSON at all", "the extraction did not return a JSON object"],
    [JSON.stringify([{ kind: "decision" }]), "the extraction did not return a JSON object"],
    [payload({ kind: "question", summary: "Which one?" }), "the extraction named the kind \"question\""],
    [payload({ kind: "manual" }), "the extraction returned no summary"],
    [payload({ kind: "decision", summary: "Pick one", questions: "one" }), "the extraction's questions are not a list"],
    [payload({ kind: "decision", summary: "Pick one", questions: [{ question: "  ", options: [] }] }), "a question has no text"],
    [payload({ kind: "decision", summary: "Pick one", questions: [{ question: "Which?", options: [{ label: "" }] }] }), "an option has an empty label"],
    [payload({ kind: "decision", summary: "Pick one", questions: [{ question: "Which?", options: [{ label: 3 }] }] }), "an option has no label"],
    [payload({ kind: "decision", summary: "Pick one", questions: [{ question: "Which?", options: "yes" }] }), "a question's options are not a list"],
    [payload({ kind: "decision", summary: "Pick one", questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, index) => ({ question: `Q${index}?`, options: [] })) }), `the extraction returned ${MAX_QUESTIONS + 1} questions (at most ${MAX_QUESTIONS})`],
  ];
  for (const [raw, reason] of cases) assert.deepEqual(checkExtraction(raw), { ok: false, reason }, raw.slice(0, 60));
});

test("an unshowable choice set keeps the question and its source instead of dropping the ask", () => {
  // The label is the owner's authorization: it is never shortened. The question still reaches the
  // owner (free text) instead of the whole ask staying unextracted, which was the 2026-10-22 drop.
  const label = "Approve " + "the reversible staging step ".repeat(12) + "but never production";
  assert.ok(label.length > MAX_LABEL_CHARS);
  const long = checkExtraction(payload({ kind: "decision", summary: "Choose scope",
    questions: [{ question: "Which scope?", options: [{ label, description: "" }, { label: "B. Wait", description: "" }] }] }), `Which scope?\nA. ${label}\nB. Wait`);
  assert.ok(long.ok, long.ok ? "" : long.reason);
  assert.deepEqual(long.value.questions, [{ key: "q1", question: "Which scope?", options: [], multiSelect: false }]);
  const many = checkExtraction(payload({ kind: "decision", summary: "Choose scope",
    questions: [{ question: "Which scope?", options: Array.from({ length: MAX_OPTIONS + 1 }, (_, index) => ({ label: `Option ${index}` })) }] }), "Which scope?");
  assert.ok(many.ok, many.ok ? "" : many.reason);
  assert.deepEqual(many.value.questions[0].options, []);
});

test("an over-long tradeoff is omitted, not the question, so the ask still reaches the owner", () => {
  const tradeoff = "limits exposure to staging and never touches production ".repeat(8).trim();
  assert.ok(tradeoff.length > MAX_DESCRIPTION_CHARS);
  const source = `Which scope?\nA. Stage only — ${tradeoff}\nB. Wait — No release today.`;
  const checked = checkExtraction(payload({ kind: "decision", summary: "Choose scope",
    questions: [{ question: "Which scope?", options: [
      { label: "A. Stage only", description: tradeoff },
      { label: "B. Wait", description: "No release today." },
    ] }] }), source);
  assert.ok(checked.ok, checked.ok ? "" : checked.reason);
  assert.deepEqual(checked.value.questions[0].options, [
    { label: "A. Stage only", description: "" },
    { label: "B. Wait", description: "No release today." },
  ]);
  // A short description that is not quoted is still a refusal: the option would misrepresent it.
  assert.equal(checkExtraction(payload({ kind: "decision", summary: "Choose scope",
    questions: [{ question: "Which scope?", options: [{ label: "B. Wait", description: "Owner already approved it." }] }] }), source).ok, false);
});

test("rendered text of a source link or entity still counts as the exact quote", () => {
  const source = "**Choose:** [Plan](https://linear.app/x) &amp; the [ADR](https://example.com/adr) — stage only.";
  const checked = checkExtraction(payload({ kind: "decision", summary: "Choose",
    questions: [{ question: "Stage only?", options: [{ label: "Choose: Plan & the ADR", description: "" }] }] }), source);
  assert.ok(checked.ok, checked.ok ? "" : checked.reason);
  assert.deepEqual(checked.value.questions[0].options, [{ label: "Choose: Plan & the ADR", description: "" }]);
});

test("the prompt carries the ask as data and is capped at the source limit", () => {
  const input: ExtractInput = { identifier: "TUC-1616", title: "Needs you: who takes TUC-1562?", ticket: "TUC-1453", kind: "needs-you", text: "x".repeat(MAX_SOURCE_CHARS + 500) };
  const prompt = extractionPrompt(input);
  assert.match(prompt, /ASK — the "Needs you" sub-issue TUC-1616 of the closed ticket TUC-1453/);
  assert.match(prompt, /Title: Needs you: who takes TUC-1562\?/);
  assert.match(SYSTEM_PROMPT, /at most 200 characters/);
  assert.match(SYSTEM_PROMPT, /at most 300 characters/);
  assert.match(SYSTEM_PROMPT, /return that question with options empty/);
  assert.ok(prompt.length < MAX_SOURCE_CHARS + 500);
  assert.ok(!prompt.includes("x".repeat(MAX_SOURCE_CHARS + 1)));
  assert.match(extractionPrompt({ ...input, kind: "manual" }), /manual task TUC-1616/);
  assert.match(extractionPrompt({ ...input, kind: "ticket", ticket: null }), /Linear ticket TUC-1616/);
});

test("the isolated call's answer is validated; a tool event or a timeout is a refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "owner-ask-extract-"));
  const input: ExtractInput = { identifier: "TUC-1784", title: "Telegram bot: rotate token", ticket: null, kind: "manual", text: "## Steps\n1. Rotate the token with BotFather." };
  const good: OmpRun = { code: 0, stdout: answer({ kind: "manual", summary: "Rotate the Telegram token with BotFather.", questions: [] }), timedOut: false, overflow: false };
  const extracted = await extractWithOmp(input, "omp/test", directory, async () => good);
  assert.deepEqual(extracted, { ok: true, value: { kind: "manual", summary: "Rotate the Telegram token with BotFather.", questions: [] } });
  const tool: OmpRun = { code: 0, stdout: `${JSON.stringify({ type: "tool_call" })}\n`, timedOut: false, overflow: false };
  assert.deepEqual(await extractWithOmp(input, "omp/test", directory, async () => tool), { ok: false, reason: "the extraction emitted a tool event (tool_call); it must have no tools" });
  const slow: OmpRun = { code: null, stdout: "", timedOut: true, overflow: false };
  assert.deepEqual(await extractWithOmp(input, "omp/test", directory, async () => slow), { ok: false, reason: "the extraction did not answer in time" });
  const junk: OmpRun = { code: 0, stdout: answer({ kind: "decision", summary: "" }), timedOut: false, overflow: false };
  assert.deepEqual(await extractWithOmp(input, "omp/test", directory, async () => junk), { ok: false, reason: "the extraction returned no summary" });
});

test("one hash per ask text keys the cache", () => {
  assert.equal(askHash("the same ask"), askHash("the same ask"));
  assert.notEqual(askHash("the same ask"), askHash("the same ask "));
  assert.match(askHash("x"), /^[0-9a-f]{32}$/);
});

test("lettered choices retain sourced tradeoffs and recommendation; invented authorization is rejected", () => {
  const source = "Which scope?\nA. Stage only (Recommended) — Limits exposure.\nB. Wait — No release today.";
  const options = [{ label: "A. Stage only (Recommended)", description: "Limits exposure." }, { label: "B. Wait", description: "No release today." }];
  const original = { kind: "decision", summary: "Choose scope", questions: [{ question: "Which scope?", options, multiSelect: false }] };
  const checked = checkExtraction(payload(original), source);
  assert.ok(checked.ok);
  assert.deepEqual(checked.value.questions[0].options, options);
  for (const option of [
    { label: "C. Agent deploys production", description: "" },
    { label: "B. Wait (Recommended)", description: "No release today." },
    { label: "Stage only (Recommended)", description: "Limits exposure." },
    { label: "B. Wait", description: "Owner already approved the rollout." },
  ]) {
    assert.equal(checkExtraction(payload({ ...original, questions: [{ ...original.questions[0], options: [option] }] }), source).ok, false);
  }
});
