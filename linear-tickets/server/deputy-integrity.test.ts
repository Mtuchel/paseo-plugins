import assert from "node:assert/strict";
import test from "node:test";
import { checkVerdict } from "./deputy-evaluator";
import type { Part } from "./deputy-risk";
import { standingSources, type Source } from "./deputy-sources";

const authority = standingSources();
const engineering = authority.find(source => source.id === "standing-policy:engineering")!;
const keys = ["preservation", "ownerArtifacts", "acceptance", "gates"] as const;
const intact = Object.fromEntries(keys.map(key => [key, { state: "not-implicated", reason: "The selected action leaves this requirement intact; it claims no exception or missing prerequisite." }]));
const part: Part = { key: "Action", question: "Which exact action completes the authorized task?", options: ["Agent proceeds", "Agent investigates"], effects: {} };
const citation = { part: part.key, source: engineering.id, quote: engineering.text };
function assess(integrity: Record<string, unknown>, evidence: Source[] = [], cited: unknown[] = [citation], selected = part, actor: unknown = "agent") {
  return checkVerdict(JSON.stringify({
    risk: "low", decision: "answer", selections: { [selected.key]: selected.options[0] },
    actions: { [selected.key]: { option: selected.options[0], actor, risk: "low", effects: selected.effects[selected.options[0]] || "Bounded technical work", outcome: { scope: "technical", effects: "No consequential business workflow change" }, integrity, reason: "Routine engineering under standing authority", authority: "standing" } },
    citations: cited,
  }), [selected], [...authority, ...evidence]);
}

test("routing a security exception to its human actor is not autonomous execution", () => {
  const selected: Part = {
    key: "Queue blocked", question: "Who decides the security audit exception?",
    options: ["You handle the audit", "Agent investigates alternatives"],
    effects: { "You handle the audit": "You or the repo admin decide on the exception. The heartbeat picks up as soon as main passes." },
  };
  const cited = [{ ...citation, part: selected.key }];
  const result = assess(intact, [], cited, selected, "owner");
  assert.equal(result.ok, false, "preserving the security boundary cannot disguise human work as an agent answer");
  const repair = { ...selected, options: ["Agent investigates alternatives"], effects: { "Agent investigates alternatives": "Inspect technical alternatives without adding an audit ignore or deciding the reserved exception" } };
  assert.equal(assess(intact, [], cited, repair, "agent").ok, true);
});

for (const [name, key, state, effects] of [
  ["sole uncommitted work has only an unverified temporary patch", "preservation", "unknown", "Save a patch under /tmp, then archive the only worktree containing 19 uncommitted files"],
  ["safe ownership of pre-existing shared user work is unknown", "preservation", "unknown", "Edit and install from a dirty shared checkout containing the user's uncommitted HealthIO overlay"],
  ["technical cleanup bundles an owner-only approval artifact", "ownerArtifacts", "violated", "Retire obsolete wording tests and self-apply the owner-only approved-test-change label"],
  ["honest unproven acceptance is still incomplete", "acceptance", "violated", "Close the ticket while admitting required request-to-review and cohort evidence is unproven"],
  ["syntactic success hides required scope outside the declared gate", "gates", "violated", "Move gated acceptance coverage to ungated Also proves prose solely to pass the one-AC validator"],
] as const) {
  test(`a low-risk summary cannot override integrity: ${name}`, () => {
    const selected = { ...part, effects: { "Agent proceeds": effects } };
    const result = assess({ ...intact, [key]: { state, reason: effects } }, [], [citation], selected);
    assert.equal(result.ok, false);
    if (state === "unknown") assert.ok(!result.ok && result.abstention === "investigate");
  });
}

for (const key of keys) {
  test(`material ${key} satisfaction requires real non-standing evidence attributed to this selection`, () => {
    const proof: Source = { id: `checked:${key}`, kind: "plan", title: "Checked task evidence", revision: "verified-1", decisive: true, text: {
      preservation: "The isolated task worktree's complete 19-file change is committed at verified durable commit abc123. All tracked and formerly untracked work is recoverable; no user changes are included. Only this owned worktree will be archived.",
      ownerArtifacts: "The authenticated owner personally applied the required approval label. The agent only reports that existing approval and does not mint or apply a new owner artifact.",
      acceptance: "Every required request-to-review acceptance check is fulfilled. The recorded cohort contains the required three measured clearances, with measured values satisfying the approved bounds.",
      gates: "The reviewed gate repair is approved under the repository's technical change process. All required AC coverage remains explicitly validated and the real gate and behavioral checks pass without an exception or new owner approval entry.",
    }[key] };
    const integrity = { ...intact, [key]: { state: "satisfied", reason: proof.text, source: proof.id, quote: proof.text } };
    const proofCitation = { part: part.key, source: proof.id, quote: proof.text };
    const good = assess(integrity, [proof], [citation, proofCitation]);
    assert.ok(good.ok && good.standing);
    const expanded = { ...proof, text: `Additional task context. ${proof.text} The source remains current.` };
    const containing = assess(integrity, [expanded], [citation, { ...proofCitation, quote: expanded.text }]);
    assert.ok(containing.ok && containing.citations.some((item) => item.sourceId === proof.id && item.quote.includes(proof.text)), "a larger cited passage retains the complete verified prerequisite in the audit trail");
    assert.equal(assess(integrity, [expanded], [citation, { ...proofCitation, quote: "Additional task context." }]).ok, false, "a citation to unrelated text in the same source cannot prove the prerequisite");
    assert.equal(assess(integrity, [expanded], [citation, { ...proofCitation, quote: proof.text.slice(0, Math.floor(proof.text.length / 2)) }]).ok, false, "a partial excerpt cannot stand in for the complete material proof");
    assert.equal(assess(integrity, [proof]).ok, false, "uncited prerequisite proof is not an audit trail");
    assert.equal(assess(integrity, [{ ...proof, decisive: false }], [citation, proofCitation]).ok, false, "memory/proposals cannot prove satisfaction");
    assert.equal(assess(integrity, [], [citation, proofCitation]).ok, false, "missing task evidence cannot be invented");
    assert.equal(assess({ ...integrity, [key]: { ...integrity[key], source: engineering.id, quote: engineering.text } }).ok, false, "general technical delegation cannot prove a material prerequisite");
    assert.equal(assess({ ...integrity, [key]: { ...integrity[key], quote: "The owner approved everything." } }, [proof], [citation, proofCitation]).ok, false);
  });
}

test("every selected part needs all current integrity assessments; old or malformed assessments cannot pass", () => {
  for (const key of keys) {
    const missing = { ...intact };
    delete missing[key];
    assert.equal(assess(missing).ok, false);
    for (const invalid of [null, [], { state: "approved", reason: "Assumed" }, { state: "not-implicated", reason: "" }]) {
      assert.equal(assess({ ...intact, [key]: invalid }).ok, false);
    }
  }
});

for (const key of keys) {
  for (const state of ["unknown", "violated", "satisfied", "not-implicated"]) {
    test(`${key} requires a primitive integrity state instead of [${state}]`, () => {
      const result = assess({ ...intact, [key]: { state: [state], reason: "A JSON array is not a validated prerequisite state." } });
      assert.equal(result.ok, false, "malformed state must not grant standing authority or bypass prerequisite proof");
      assert.ok(!result.ok && result.abstention === "investigate");
    });
  }
}

test("integrity state, reason and prerequisite citations reject other malformed JSON field types", () => {
  const proof: Source = { id: "checked:prerequisite", kind: "plan", title: "Verified prerequisite evidence", revision: "verified-1", decisive: true, text: "The selected action's current material prerequisite is fulfilled with its recorded evidence." };
  const proofCitation = { part: part.key, source: proof.id, quote: proof.text };
  for (const key of keys) {
    for (const state of [null, false, true, 0, [], {}, { toString: "satisfied" }, { valueOf: "violated" }]) {
      assert.equal(assess({ ...intact, [key]: { state, reason: "The field must retain its validated primitive type." } }).ok, false);
    }
    for (const reason of [null, false, 0, [], ["Explained"], {}]) {
      assert.equal(assess({ ...intact, [key]: { state: "not-implicated", reason } }).ok, false);
    }
    for (const [source, quote] of [[[proof.id], proof.text], [proof.id, [proof.text]]]) {
      assert.equal(assess({ ...intact, [key]: { state: "satisfied", reason: "Satisfied with verified evidence", source, quote } }, [proof], [citation, proofCitation]).ok, false);
    }
  }
});

test("ordinary technical actions and nonbinding preparation need no invented approval or prerequisite proof", () => {
  for (const effects of [
    "Repair merge-buffer enumeration; preserve all existing behavior and verification gates",
    "In the task's isolated workspace, retire obsolete mock-echo tests while preserving meaningful consumer coverage; truthfully cite standing delegation, never record a personal owner decision or apply an owner-only approval label",
    "Prepare a concrete logistics@ intake proposal for later owner approval; do not connect any mailbox, change permissions or represent the design as approved",
    "Keep the ticket open and collect missing observational acceptance evidence without inventing results or declaring completion",
  ]) {
    const result = assess(intact, [], [citation], { ...part, effects: { "Agent proceeds": effects } });
    assert.ok(result.ok && result.standing, effects);
  }
});

test("a prerequisite cited only for another selected part cannot prove this part's integrity", () => {
  const proof: Source = { id: "checked:acceptance", kind: "plan", title: "Observed acceptance evidence", revision: "verified-1", decisive: true, text: "Both independent acceptance requirements are fulfilled with their recorded consumer evidence." };
  const selected = [
    { key: "First", question: "Close the first fulfilled acceptance?", options: ["Close first", "Keep open"], effects: {} },
    { key: "Second", question: "Close the second fulfilled acceptance?", options: ["Close second", "Keep open"], effects: {} },
  ];
  const response = {
    risk: "low", decision: "answer",
    selections: Object.fromEntries(selected.map(item => [item.key, item.options[0]])),
    actions: Object.fromEntries(selected.map(item => [item.key, {
      option: item.options[0], actor: "agent", risk: "low", effects: "Truthful fulfilled technical closeout", outcome: { scope: "technical", effects: "No changed business workflow" },
      integrity: { ...intact, acceptance: { state: "satisfied", reason: "Fulfilled with observed evidence", source: proof.id, quote: proof.text } }, reason: "Delegated completion", authority: "standing",
    }])),
    citations: [
      ...selected.map(item => ({ part: item.key, source: engineering.id, quote: engineering.text })),
      { part: "First", source: proof.id, quote: proof.text },
    ],
  };
  assert.equal(checkVerdict(JSON.stringify(response), selected, [...authority, proof]).ok, false);
  response.citations.push({ part: "Second", source: proof.id, quote: proof.text });
  assert.equal(checkVerdict(JSON.stringify(response), selected, [...authority, proof]).ok, true);
});

test("an exact selected preservation guard authorizes investigation without inventing present proof", () => {
  const effect = "Investigate checkout ownership; refresh only after it is proven safe and automation-owned. Otherwise leave it unchanged.";
  const selected = { ...part, effects: { "Agent proceeds": effect } };
  const guarded = { state: "guarded", reason: "Ownership remains unknown; investigation is permitted but refresh is prohibited until safe ownership is proven.", guard: { effect } };
  assert.equal(assess({ ...intact, preservation: guarded }, [], [citation], selected).ok, true);
  assert.equal(assess({ ...intact, preservation: { state: "unknown", reason: guarded.reason } }, [], [citation], selected).ok, false);
});

test("guard anchoring is local, complete and cannot impersonate prerequisite proof or owner consent", () => {
  const selected: Part = {
    ...part, question: "Investigate first; mutate only after ownership is established?",
    effects: { "Agent proceeds": "Refresh only a proven-safe automation-owned checkout.", "Agent investigates": "Inventory all shared checkouts without changing them." },
  };
  const reason = "The factual prerequisite remains unresolved and mutation is prohibited until proven.";
  for (const guard of [{ question: selected.question }, { effect: selected.effects["Agent proceeds"] }, { question: selected.question, effect: selected.effects["Agent proceeds"] }]) {
    for (const key of ["preservation", "acceptance", "gates"]) {
      assert.equal(assess({ ...intact, [key]: { state: "guarded", reason, guard } }, [], [citation], selected).ok, true);
    }
  }
  for (const guard of [undefined, null, "", [], {}, { effect: ["Refresh"] }, { effect: "" }, { effect: "proven-safe" }, { effect: selected.effects["Agent investigates"] }, { question: "Another part's question" }, { effect: selected.effects["Agent proceeds"], invented: true }]) {
    assert.equal(assess({ ...intact, preservation: { state: "guarded", reason, guard } }, [], [citation], selected).ok, false);
  }
  const guarded = { state: "guarded", reason, guard: { effect: selected.effects["Agent proceeds"] } };
  for (const extra of [{ source: engineering.id }, { quote: engineering.text }]) {
    assert.equal(assess({ ...intact, preservation: { ...guarded, ...extra } }, [], [citation], selected).ok, false);
  }
  assert.equal(assess({ ...intact, ownerArtifacts: guarded }, [], [citation], selected).ok, false);
  for (const state of ["not-implicated", "satisfied", "unknown", "violated"]) {
    assert.equal(assess({ ...intact, preservation: { ...guarded, state } }, [], [citation], selected).ok, false);
  }
  assert.equal(assess({ ...intact, preservation: guarded }, [], [citation], selected, "owner").ok, false);
  assert.equal(assess({ ...intact, preservation: guarded, gates: { state: "unknown", reason: "Required exception is unavailable" } }, [], [citation], selected).ok, false);
});
