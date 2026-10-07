# Record the authoritative responder for agent question answers

## What I'm trying to do

Understand which connection or automation actually answered an agent's question, whether the answer was submitted through the Paseo app, CLI, SDK or a plugin. A question may be visible to multiple clients while an automated deputy is also considering it. After resolution, integrations need to distinguish an answer delivered by automation from one attributable to a verified human, without inferring identity from answer text or timing.

This is a feature proposal, not an available capability or an implementation. All examples below are synthetic.

## Today's workaround

An integration can record answers it delivers through its own authenticated channel. For answers arriving through other Paseo clients, it must leave the responder unknown and exclude them from evidence that requires a verified human answer. Two components can submit exactly the same answer; matching the text or observing a nearby submission is not proof that either component supplied the applied answer.

This loses useful evidence and leaves the question history unable to explain who answered. Treating every resolution as a person's answer would be worse: a request can also be cleared by the system or resolved by the provider without an attributable submitting client.

## Where Paseo gets in the way

At public source revision `28f7528588bc4ea74d4b9394560191bc16c20b84`:

- The [submission message](https://github.com/getpaseo/paseo/blob/28f7528588bc4ea74d4b9394560191bc16c20b84/packages/protocol/src/messages.ts#L2142-L2147) carries agent ID, request ID and response; the [resolution message](https://github.com/getpaseo/paseo/blob/28f7528588bc4ea74d4b9394560191bc16c20b84/packages/protocol/src/messages.ts#L5123-L5131) carries the resolution, not responder provenance.
- The [session reply handler](https://github.com/getpaseo/paseo/blob/28f7528588bc4ea74d4b9394560191bc16c20b84/packages/server/src/server/session.ts#L5013-L5051) passes no answering origin and its modern-client confirmation echoes the submitted response. It is not a provenance receipt for the applied answer.
- [Permission application](https://github.com/getpaseo/paseo/blob/28f7528588bc4ea74d4b9394560191bc16c20b84/packages/server/src/server/agent/agent-manager.ts#L2976-L3012) rejects a concurrent in-flight submission, calls the provider, then persists state and dispatches a buffered resolution. A persistence or acknowledgment failure after application is not proof that no answer was applied; these operations are not one atomic transaction.
- [System clearing](https://github.com/getpaseo/paseo/blob/28f7528588bc4ea74d4b9394560191bc16c20b84/packages/server/src/server/agent/agent-manager.ts#L4642-L4659) also emits denied resolutions. A resolution alone does not establish a human answer.
- [Session admission](https://github.com/getpaseo/paseo/blob/28f7528588bc4ea74d4b9394560191bc16c20b84/packages/server/src/server/session-admission-auth.ts#L11-L37) grants a shared `owner` principal. That is not authentication of a named person. [Plugin socket admission](https://github.com/getpaseo/paseo/blob/28f7528588bc4ea74d4b9394560191bc16c20b84/packages/server/src/server/websocket-server.ts#L1596-L1606) binds reserved plugin client IDs to daemon-known plugins; arbitrary client labels are not comparable proof.
- The [timeline item union](https://github.com/getpaseo/paseo/blob/28f7528588bc4ea74d4b9394560191bc16c20b84/packages/protocol/src/agent-types.ts#L373-L386) has no dedicated permission-resolution variant. Retained question-answer provenance is a requested addition, not a reliable history feature already present.
- The [documented plugin lifecycle hook](https://paseo.sh/docs/plugins/reference#lifecycle-hooks), `agent.permission_resolved`, exposes `agent`, `requestId` and `resolution`, not responder identity.

## The better workflow

After a question is answered, the sender, other connected clients, plugins and retained question history should all receive the same daemon-established provenance for the answer actually applied. Maintainers should choose the API shape; the useful invariants are:

1. **Attribute the winning applied response.** Bind provenance to the particular agent/request and applied response, not merely to a submission attempt. A concurrent, rejected or late losing submission must never overwrite the winner's identity, even if both submitted identical answers.
2. **Separate component provenance from human identity.** Derive connection identity, daemon-bound plugin identity and system actions from facts the daemon can establish. Include answering-component type (app, CLI, SDK/plugin automation) only when it is verifiable; otherwise retain connection provenance with component type unknown. Caller-supplied app names, human display names, answer text and timestamps are not authoritative. A separately verified human principal may be reported if one exists; a shared `owner` admission or transport connection must not be presented as proof of a named human. Connection provenance is useful even when the human remains unknown.
3. **Keep all surfaces consistent.** Expose identical provenance in the submitting client's confirmation, live protocol updates, the plugin resolution hook and retained question history. Document the retention and restart limits. Reconnect, refetch and replay must preserve attribution for retained records, not reinterpret it or invent identity after retention expires.
4. **Represent non-human and unknown outcomes honestly.** Distinguish daemon/system clearing or denial, provider resolutions without an attributable submitting client, and legacy unknowns from a verified person's answer. Never guess or backfill responder identity from content, timing or labels.
5. **Evolve additively with capability detection.** Old clients must still be able to answer. A new daemon can retain the connection provenance it establishes for an old client while leaving unverifiable component/human identity unknown. Old records remain unknown. Consumers connected to old daemons must detect missing provenance support and remain fail-closed about human attribution, not treat every answer as the owner's.
6. **Do not fabricate certainty after partial failure.** If the provider applied an answer but persistence or acknowledgment failed, a transport error must not be reported as proof of non-application or change attribution to a later caller. Expose the known application/provenance facts, or an explicit unknown outcome where those facts cannot be established. This request does not assume atomic persistence or promise exactly-once delivery.

## Illustrative upstream acceptance scenarios

These are requested behavior/tests for a future upstream implementation, not claims that they pass today.

| Scenario | Expected outcome |
| --- | --- |
| Two connections submit the same synthetic `Option A` answer concurrently | Any confirmed applied answer is attributed to its actual winning connection; text equality never attributes it to the losing connection. |
| A late submission arrives after resolution, or a submission is rejected | It does not replace the applied response's provenance or masquerade as an applied answer. |
| An SDK caller supplies a display name claiming to be a human | That label does not create a verified human principal or authoritative component type. |
| A daemon-bound plugin competes with an app connection | The applied answer names the winning established origin. Plugin identity is daemon-derived; the app connection proves no named human by itself. |
| A CLI or app connection has shared `owner` admission but no verified human principal | Retain established connection provenance; human identity stays unknown, and unverifiable component type stays unknown. |
| The daemon clears a pending request with a denial | Report a system resolution, not a human answer. |
| The provider resolves a request without an attributable submitting client | Report provider-origin/unattributed resolution, not an inferred person's answer. |
| A client reconnects and reads retained question history, including after a supported restart | Confirmation, live event, plugin hook and retained record agree; documented retention limits apply, and missing provenance stays unknown. |
| An old client answers a new daemon; an old record is read; a new consumer connects to an old daemon | Answering remains compatible; the new daemon retains only verifiable provenance; old records stay unknown; consumers without daemon support do not infer human identity. |
| Application succeeds, then persistence or acknowledgment fails | Do not equate the failure with non-application, falsely acknowledge a later loser, or reassign provenance. If authoritative outcome cannot be recovered, report unknown rather than guess. |

## Scope and related discussions

This request is about provenance only. It does not implement owner-priority arbitration, atomic question-fingerprint comparison, exactly-once submission, automatic answering or a deputy's live-mode gate. Attribution alone does not solve those problems or authorize automation.

[Discussion #5983](https://github.com/getpaseo/paseo/discussions/5983) and [issue #5058](https://github.com/getpaseo/paseo/issues/5058) concern daemon-resolved origin for agent creation/hooks, adjacent to this request but not question-answer provenance. [Issue #4948](https://github.com/getpaseo/paseo/issues/4948) concerns message correlation across restart and explains why matching text cannot recover identity; it does not supply question responders. [Issue #3480](https://github.com/getpaseo/paseo/issues/3480) and [PR #3495](https://github.com/getpaseo/paseo/pull/3495) concern question-answer validity/delivery rather than responder identity.

<!-- Local publication record: not part of the canonical public body. -->

## Local publication record

Status: proposal only; not available. Published in Paseo's Ideas category as
[discussion #6298](https://github.com/getpaseo/paseo/discussions/6298) after independent
technical and privacy review. The canonical public body is the content above the local
publication-record marker; authenticated readback confirmed exact body parity.

Local documentation: [Deputy for agent questions](../README.md#deputy-for-agent-questions). No runtime changes, live-gate changes or rollout are delivered by this document.
