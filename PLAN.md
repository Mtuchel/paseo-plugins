# TUC-1323 — Shared Linear admission for ticket agents

# Part 1 — Overview

## Summary
Ticket agents will share the host's protected Linear allowance with Paseo. Agent requests pause before spending the last 5% reserved for owner decisions, and their usage becomes measured separately from other outside usage.

## Why
Agents currently spend the same allowance from separate processes without consulting Paseo. They can leave an owner approval or status change unable to proceed even when Paseo has paused its own background work.

## What changes for users
The owner running agents does nothing differently. Agent tools may report “Agent Linear work is paused to keep the last budget for owner decisions; retry after the shown time.” If the host's budget service is unavailable: “The host's Linear budget service is unavailable; no request was sent. Retry after the plugin is running.” An interrupted request whose outcome is unknown instead says “The Linear request may have completed; check the ticket before retrying a write.” The operations digest distinguishes “Plugin”, “Agent MCP” (the agents' Linear tools), and “≈ outside shared admission”. Author identities, ticket access, owner decisions and existing notifications stay the same.

## Scope
- Included: both request count and complexity allowance, for the host's app and key separately.
- Included: atomic admission across agent processes, retaining the final 5% for owner operations.
- Included: restart, unavailable-service and uncertain-request handling without bypass or automatic write replay.
- Included: measured agent callers, no duplicate counting, and status/digest separation from outside estimates.
- Included: new agents, read-only project planners, resumed sessions and existing generated agent commands on both hosts.
- Not included: query slimming, webhooks, menu-bar presentation, credential isolation or the week-long operational review; existing tickets own these.
- Assumption: this protects managed agent tools, not scripts or other Linear connections that already bypass Paseo; their spending remains an estimate.
- Assumption: on first use, one small allowance check can run before the remaining allowance is known; actual agent work waits for the result. Other connections and unexpectedly costly background work can still consume more than predicted.

## Your decisions
None. The existing reserve, identity and ticket-access policies are retained.

## Risks and rollout
A defect could pause agents unnecessarily or let them consume the owner's allowance. Each host is updated separately; existing agent-tool processes must be drained and restarted so none keeps the old bypass. After an interrupted request, the host keeps room set aside for that request even after its temporary pause ends; agents may remain paused until the uncertainty is resolved. Usage saved before a crash can be incomplete, as today. Reverting and restoring saved agent commands brings back the old behavior, including its unprotected agent spending.

# Part 2 — Implementation

## Technical context
- Starting branch `mtuchel-tuc-1323-ticket-agent-mcp-requests-share`, clean worktree, HEAD `89092cad57e76ec505318d984be767ede5074f5e`. Both prerequisite merge commits are ancestors: #108 `724c7f9` (two-dimensional admission/accounting), #109 `89092ca` (retryable approval delivery). TUC-520's implementation #41 is also merged.
- `server/rate-budget.ts:64-170` owns app/key budgets, 20% background and 5% interactive reserves, synchronous in-flight admission, and the single recovery probe. Its complexity reservation currently uses a pool-wide moving average; missing or out-of-order responses can release estimated capacity too optimistically.
- `server/linear.ts:65-90` combines daemon admission and response accounting. `server/ticket-mcp-source.ts:65-120` instead fetches Linear directly; authentication-only app/key fallback and tool-level ticket authorization already work and must remain unchanged.
- Runtime reproduction: executed the embedded MCP script under Node with fake credentials, no budget service and a loopback fake Linear. Two successive `search_issues` calls reached upstream despite responses reporting 60,000/2,000,000 points (3%) and 4,500/5,000 requests. No repository or credential files were written or read.
- `server/linear-usage.ts:231-266,373-397` is the authoritative accounting event and conservative outside-estimate sample chain. Version-1 hourly history is read by the digest; keep this format and historical records.
- `server/ticket-mcp.ts:25-55`, `server/agent-env.ts:47-62`, `server/launch.ts:349-400` and the OMP extension pin generated script paths in live and saved commands. Reloading only the plugin does not replace code already loaded in a long-lived MCP process. The session-open hook can change environment only, not native MCP config.
- No repository ADR/glossary/approved-principle registry exists. Existing policies live in `linear-tickets/README.md` (“Agent access to Linear”, “Who Linear shows as the author”, “Rate limits”) and root `AGENTS.md`.
- Upstream contract: [Linear rate limiting](https://linear.app/developers/rate-limiting.md) specifies constant refill, separate request/complexity pools and a 10,000-point maximum per query. Treat that ceiling as a conservative reservation, not measured usage.

## Approach
1. Add a daemon-owned, dependency-free local GraphQL broker over HTTP on a private Unix-domain socket under `$PASEO_HOME/linear-tickets/`. MCP uses `node:http.request({socketPath})`; no externally reachable port, redirect, credential in launch config or agent-selected upstream URL. Directory mode 0700, socket mode 0600; handle path-length/listen errors by failing closed. Refuse a second live listener; unlink only a verified stale socket owned by this process's user. Production upstream remains fixed to Linear; tests inject a fake upstream at broker construction, never through MCP environment.
2. Broker request v1: `{authorization, query, variables, tool}`. Keep app-token/key choice and token reread in MCP, including the explicit key viewer lookup for manual-task ownership. The broker derives the pool from authorization, forces `interactive` admission, allowlists tool names, derives `operationName(query)`, and uses caller `mcp:<tool>`. Clients cannot select priority, caller, point cost, or upstream. Scope checks remain in the MCP tool implementation; this is not a new permission boundary against the same OS user.
3. Extend the existing `RateBudget` reservation with per-ticket complexity cost so each MCP request reserves one request and 10,000 points synchronously before upstream execution. Track the sum of captured in-flight costs, not `inFlight * mutable average`. Daemon callers retain the existing average-cost default. Reconcile responses conservatively: an older/concurrent high remaining header cannot restore spent capacity; missing headers or an unknown network outcome retain a pessimistic debit instead of returning capacity. Owner work still deliberately may spend the reserve. No separate MCP meter and no second admission computation.
4. Broker owns the upstream send and `Ticket.done`, including after MCP disconnects. Every authentication retry is a separate admitted/measured attempt. Relay raw upstream status, payload and codes for the existing MCP `answer`/`unauthenticated` branches; local denials use a distinct envelope `{kind:'held', pool, reason, resumeAt, message}` and never look like authentication failure. Distinguish definitely-unsent validation/connect/predispatch refusals, answered upstream results, and unknown connection loss after submission. Unknown means “may have completed”, never replay or credential fallback; no receipt-query protocol.
   Separate reservation from sent-traffic accounting: provide an idempotent unsent-cancel path which releases the reservation/probe slot without counting a request. Journal-write failure, validation failure or disconnect before dispatch uses it. Begin the existing usage event only at the broker's actual upstream attempt; never call `done(null, ...)` for a request that was not attempted.
5. Recovery uses a private, serialized, atomic write-ahead journal of outstanding sends: request id, pool, send time, reserved costs and any uncertainty/fence time, never credentials/query/variables. Complete initialization before acceptance. Persist and sync intent and the directory before sending; persistence failure cancels unsent work. Definite upstream answers settle admission/accounting before marker removal; removal failure leaves conservative debt. Unknown outcomes/recovered outstanding markers fence MCP for one refill period, then reopen only with fresh valid headers and the unresolved maximum-cost reservations still subtracted from available budget. Elapsed time and fresh headers never settle unresolved debt. Persist the original fence deadline; repeated restarts neither discard debt nor restart that deadline. Definitive late outcomes settle their own marker once; otherwise retain debt, including across expiry/restart, until explicit operational reconciliation. Missing journal on first use is empty; malformed/unreadable journal fails closed until repaired/restored, not an automatic time-based debt reset. Owner traffic retains the existing path. Stop rejects new work and drains within the existing 30-second upstream deadline; timeout becomes an unknown outcome with persisted debt before usage flush.
   Cold-pool liveness: when either dimension lacks a sample, serialize one tiny `query McpBudgetProbe { viewer { id } }` through the existing interactive `RateBudget` path using that pool's current credential, before the tool's actual query. It cannot borrow owner priority or bypass a known reserve/limit/probe slot. A probe is one separately measured `mcp:budget-probe` attempt; use the 10,000-point reservation ceiling and a 60-second per-pool retry gate if headers remain unavailable. Ordinary daemon responses can satisfy bootstrap first. No repeated probe per waiting MCP client, no tool query before both samples, and no auth fallback for a local hold. Discovery on an entirely unknown pool necessarily precedes knowledge of its reserve: document this bounded one-request exception rather than claim protection against unknown/external spend.
6. Reuse version-1 caller rows: reserve `mcp:` for broker-attributed requests; daemon caller names stay unchanged. Add derived daemon/MCP source totals to status summaries and hourly usage logs (all callers, not only the top ten), retaining aggregate totals. Feed MCP responses through the same `LinearUsage.begin/done` and outside sample chain once within a running broker/graceful drain. Preserve existing best-effort usage persistence: crash cut points can lose counters/attribution; never reconstruct measured points from reservation costs or replay accounting markers. Break outside-estimate continuity on unknown outcomes/recovery and document the coverage gap. Digest derives source totals from all persisted callers: “Plugin”, “Agent MCP”, and “≈ outside shared admission”; pre-cutover outside estimates remain historical estimates.
7. Upgrade only verified private, owned, regular generated `ticket-mcp-<hash>.mjs` artifacts; never follow symlinks or rewrite user definitions/unrecognized bytes. Before overwriting, persist a private per-rollout manifest and checksum-verified previous source blobs for every affected path; ship a dependency-free restoration helper into the same private operational directory. First recognition requires original filename hash plus generated provenance; subsequent releases require manifest path/current-source digest agreement and provenance. Record each replacement durably so interrupted/repeated upgrades are resumable and legacy → broker A → broker B is recognizable. Old filenames become saved handles; new launches remain content-addressed. An unresolved saved managed path is explicitly unprotected: diagnose it, do not report host coverage until its config is corrected or it is safely recognized. Already-loaded old processes require drain/restart.

## Failure and retry behavior
- At 3% complexity, MCP reads and writes are held before send, even with ample requests. Both app and key pools independently enforce the existing reserve; no denial/outage/limit invokes key fallback.
- Concurrent MCP clients share one synchronous acquire; captured reservations remain until settlement. Reverse response ordering, missing headers and changing measured costs cannot restore another MCP request's reserved capacity. Daemon average-cost underestimates and external callers can still consume more than predicted; this is not an absolute guarantee against their spending.
- A client dies before a complete broker request: no send. It dies after dispatch: broker finishes and records once, without replay. Unknown upstream outcomes keep conservative debt; mutations are never automatically resent.
- Daemon unavailable/listener initialization failure: fail closed, not direct Linear access. On restart MCP waits for its persisted fence, retains unresolved debt, and obtains per-pool samples via ordinary traffic or the bounded interactive discovery probe. `initialize`/`tools/list` stay local and usable.
- A multi-request tool can still partially complete, as today. A local pause after a successful earlier mutation must not claim nothing happened; preserve existing recorded created-issue/manual-task state and return the later failure. General transaction/idempotence improvements are outside this ticket.

## Access rules
| Actor | Read/write scope | Enforcement |
|---|---|---|
| Ticket agent | Own/created/other issue scopes unchanged | Existing MCP `writable`, `scopeOf`, tool allowlist and created-issue records |
| Read-only project planner | Any issue reads; no write tools | Existing `exposed` filter; same interactive broker admission |
| Owner decision/status paths | Existing final-share access | Existing `withPriority('owner', ...)`; MCP can never request this priority |
| Same OS user | Existing trusted-local credential access remains | Private socket/files reduce accidental exposure; credential isolation remains TUC-680 |

## Rollout mechanics
This is live on laptop and server087. No business-data backfill or credential/configuration change.
- Before each host cutover, enumerate managed generated-script commands and live MCP children; drain their current calls. Update the clean host checkout and reload `linear-tickets` per root instructions, without restarting the daemon. The broker upgrades verified saved generated artifacts before serving traffic.
- Restart legacy long-lived MCP sessions through their provider, preserving the agent/conversation; if a provider cannot restart its MCP independently, use the existing agent refresh/session reopen after the turn drains. Require every managed script path and active MCP process to be on broker-only code before claiming that host protected. Do not interrupt unrelated agents.
- Register one after-merge manual task per inaccessible host with this verification; the agent performs reachable rollout steps itself. Do not race TUC-1291's server recovery. Rollout must wait until that host is healthy.
- Prove the live schema-validated `linear.agent-status` response, one read-only agent tool request and its `mcp:` usage delta on each host. A reload CLI success alone is not proof.
- Rollback: drain affected MCP processes; use the installed restoration helper with the selected rollout manifest to restore every affected saved path to its verified pre-rollout bytes (only where current bytes match that manifest), including paths changed by multiple upgrades. Revert the merge in a new PR, run checks, merge/reload both hosts and restart affected MCP processes. Keep usage history and safety debt. Verify the helper before claiming `revert` reversibility; a mismatched path needs explicit diagnosis, not overwriting.

## Dependencies on parallel work
Build on the merged TUC-1291 API. TUC-1324 may change daemon queries in `linear.ts`; keep its query/reader work intact and coordinate/rebase only the shared transport portion. TUC-1312 consumes the preserved hourly history separately per host. All current overlaps are detailed below; none already implements this complete ticket.

## Files to modify
- New `linear-tickets/server/linear-broker.ts` and behavioral test: private listener, upstream transport, journal/fence and lifecycle.
- `linear-tickets/server/rate-budget.ts`, `rate-budget.test.ts`: captured cost reservations and conservative reconciliation.
- `linear-tickets/server/ticket-mcp-source.ts`, `ticket-mcp.ts`, `ticket-mcp.test.ts`: broker client, tool context, safe generated-artifact upgrade/restore manifests and installed recovery helper, no direct-fetch override.
- `linear-tickets/index.server.ts`, `server/plugin.test.ts`: startup/drain and status contract proof.
- `linear-tickets/server/linear-usage.ts`, `linear-usage.test.ts`, `shared/contracts.ts`: derived source totals and accounting documentation.
- `linear-tickets/server/plan-advisor.test.ts`: migrate its actual OMP MCP fixture to broker-backed fake Linear; keep the extension's behavior unchanged.
- `linear-tickets/ops/paseo-ops-digest.py`, `ops/test_paseo_ops_digest.py`, `linear-tickets/README.md`: source-separated rendering, historical compatibility and operational instructions.

## Reuse
`RateBudget.acquire`, `poolOf`, `RESERVES`, `RateLimitedError`; `LinearUsage.begin`, `operationName`, `summary`, `snapshot`, atomic persistence; MCP `answer`, `unauthenticated`, `appToken`, `apiKey`, `writable`, `scopeOf`; `writeTicketMcpScript` private-file checks; `fakeLinear`/`runServer` stdio harness; digest `budget_callers`, `budget_outside`, `budget_spender`, v1 fixtures. Reuse Node HTTP listener lifecycle patterns, not the public webhook receiver or review proxy route.

## Steps
- [ ] Step 1: extend the authoritative reservation primitive and implement broker journal/fence, fixed upstream and drain lifecycle; inspect LSP references before exported signature changes.
- [ ] Step 2: route every MCP upstream attempt through the broker, attach per-tool context, preserve auth/scope logic, and cover generated saved commands plus existing test fixtures.
- [ ] Step 3: derive status/digest source totals through the single counter; update README claims and source-separated behavioral fixtures.
- [ ] Step 4: exercise the real stdio multi-process smoke, run repository checks on final head, obtain independent Sol code review, fix findings and rerun affected verification.
- [ ] Step 5: parent creates focused verified commits, pushes a draft PR, links it in Linear and moves to In Review; after final checks/review, mark ready and `gh pr merge --squash --delete-branch` without admin and never with `do-not-merge`. Rebase on current `origin/main` if needed, then repeat final checks. Roll out reachable hosts/register inaccessible manual tasks, post final evidence and close the ticket once merged.

## Verification
- **AC-1 — Ticket-agent tools:** real stdio MCP `get_issue` and `add_comment` at 3% points/ample requests are locally held with zero attempted upstream tool requests; an owner decision still sends and succeeds. Test app and key independently, also request-poor/points-rich and boundary just above 5% plus reserved cost. Existing authentication rejection/token rotation works; reserve, RATELIMITED, HTTP 403 and outage never cause key fallback.
- **AC-2 — Read-only project planners:** actual `--read-only` MCP searches/reads use the broker and pause at the same reserve; write tool remains unmounted and no write reaches upstream.
- **AC-3 — Shared admission and owner paths:** multiple real MCP processes compete near the reserve while a daemon request shares `RateBudget`; delayed/reversed replies admit only affordable upper-bound MCP costs. Exercise cost changes, missing headers, limited probes and both pools; owner priority remains available and lower priority cannot steal its probe. A daemon response exceeding its average proves reservations stay captured, while documenting that daemon underestimates/external spend are not fully bounded. Cold app/key hosts, including app-installed/key-idle and read-only planner configurations, each bootstrap once under concurrent clients, account discovery separately, and never send a tool before valid samples; known holds never bypass into discovery or fallback.
- **AC-4 — Saved commands and runtime lifecycle:** execute saved commands through legacy → broker A → broker B → manifest-driven rollback; interrupted upgrades resume, all affected saved paths restore, modified/unrecognized files and symlink targets stay untouched, and unrecognized managed paths prevent a protected-host claim. Exercise missing/stale/live socket, reload, MCP death before/after dispatch, mutation completion with lost broker response, crash after intent/response, corrupt journal and failed persistence. Observe no replay/fallback, second restart during a persisted fence, unresolved debt still deducted after expiry, definitive delayed settlement once, and bounded shutdown on unanswered upstream work.
- **AC-5 — Status/shared accounting:** schema-validated status source subtotals sum to recorded totals, with `mcp:<tool>`/operation rows outside the top ten. Successful, limited and unmetered attempts count once within the running broker/graceful drain; local denials do not count sent traffic. Crash after response/before settlement and after marker removal/before history flush demonstrates the documented best-effort gap, with no invented measurements or double-counted reconstruction. Alternating daemon/MCP samples exclude measured MCP from outside spend; concurrent/unknown/recovered samples invalidate continuity. Existing v1 history reloads unchanged.
  Add a pre-send journal-failure case proving zero upstream attempts, zero sent/unmetered usage and fully released unsent reservations; cancel/settle duplicate calls cannot count twice.
- **AC-6 — Operations digest/export:** Python behavioral fixtures render daemon, MCP and estimated outside separately; source totals sum correctly, a limited hour names its actual top MCP caller when appropriate, retained pre-cutover hours are not relabeled as measured MCP, and unreadable usage keeps prior items without a new notification policy.
- **AC-7 — Permissions/identity:** existing own/created/unrelated issue scope regressions, read-only tool filter, app author and authentication-only fallback all pass through the real broker-backed transport. No new write capability, credential in launch config, owner-priority selector or client-selectable upstream exists.
- **AC-8 — Help/operational docs:** review README against exercised low-budget, startup, uncertainty and cutover scenarios; remove obsolete daemon-only/MCP-unmetered claims and document the remaining outside callers, historical coverage and both-host rollout/rollback.
- **AC-9 — Seed/test data:** all broker/MCP integration scenarios use isolated temporary homes, fake keys/tokens and loopback fake upstreams; full suite has no real credential/API dependency, including the OMP extension fixture.
- **AC-10 — Both host installations:** after rollout, `paseo plugin ls` reports running; live status schema passes and a read-only ticket/planner tool increases only the intended pool's `mcp:` counter once. Inventory confirms no active legacy direct-fetch MCP code remains. Keep hosts' app pools separate; register inaccessible-host verification as an after-merge manual task.
- **AC-11 — Hourly usage logs:** actual `usageLines()` output separately labels plugin and agent MCP requests/points while retaining aggregate totals and per-tool/operation top callers; source sums use all callers and no credential/query/variables appear.
- Required final-head merge gate, from `linear-tickets/`: `npm ci`, `npm run typecheck`, `npm test` (JS/TS plus Python). No installs/tests during planning. Also run a throwaway real-stdio multi-process smoke against fake Linear covering the 3% hold, owner pass, disconnect and reload; remove scaffolding after evidence. Local tests alone do not prove host rollout.

## Overlapping tickets
Global searches: `Linear budget`, `MCP`, `reserve`, `ticket-mcp-source`; read full descriptions of each relevant candidate, including In Progress work. No complete duplicate found.
- **TUC-1291 (Done):** same budget/counter/status/digest foundations; reuse merged #108/#109 and retain owner-priority semantics, not its obsolete separate-MCP limitation.
- **TUC-520 (In Progress, implementation #41 merged):** same MCP script, tool access and provider injection; preserve its shipped authorization/identity and extension path, do not redo it.
- **TUC-680 (Triage):** same credential files/guard; leave intentional direct-credential bypass isolation to it. This ticket removes only the managed MCP budget bypass.
- **TUC-1324 (Planning):** shared daemon transport and measured counter, but query slimming is separate; leave its reader changes untouched and rebase compatible seam changes.
- **TUC-1310 (Todo):** consumes status budget; keep existing fields and add source totals compatibly, leave menu-bar UI to it.
- **TUC-1312 (Todo, blocked by this):** same persisted usage/digest; implement MCP distinction here, leave laptop aggregation to it.
- **TUC-1314 (Todo):** uses hourly history to review a week; preserve history/coverage and leave longitudinal assessment to it.
- **TUC-1311 (Todo):** same budget callers and future polls; retain admission API, leave webhook replacement to it.
All real overlaps already have related/dependency links to TUC-1323. Planning-mode markdown-only restriction blocked the start comment; repeat it after approval. Do not duplicate existing relations or file existing follow-ups again.

## Reach
- Changes: shared per-host Linear admission and measured agent-tool consumption.
- Ticket agents across workspaces/providers: include — AC-1
- Read-only project-planner role: include — AC-2
- Shared admission and daemon owner paths: include — AC-3
- Saved generated commands and runtime restart: include — AC-4
- Shared status contract and accounting: include — AC-5
- Ops digest export: include — AC-6
- Permissions and author identity: include — AC-7
- Help/operational README: include — AC-8
- Seed and test data: include — AC-9
- Laptop and server087 installations: include — AC-10
- Hourly usage logs: include — AC-11
- Existing Linear records/backfill: n/a — no business records/schema change; preserve hourly usage history.
- PDFs/business exports/labels and German labels: n/a — no business presentation change.
- EDI, Business Central, customer/supplier mail: n/a — no integration changes.
- Notifications: n/a — existing owner/agent notifications and non-attention digest policy unchanged.
- Other repositories including tuchel-platform/timefold: n/a — tools apply to their agents through this plugin; no repository code changes.
- Work instructions/training outside software: n/a — no business workflow changes; operational rollout is documented here.
- Menu bar/laptop digest aggregation/week-long assessment: n/a — existing TUC-1310/TUC-1312/TUC-1314 own these distinct presentation/assessment surfaces.

## Principles and rules
- Applies: none apply — no numbered approved principles/ADRs in this repository; retain TUC-1291's approved reserve and README identity/access policies.
- Exceptions: none
- New rule: none — closes the explicitly requested MCP gap in the existing reserve policy, without creating a broader governance rule.

## Model
- Tier: strong — authoritative admission shared by multiple call sites, an IPC interface, concurrent external requests and crash recovery need judgment at integration boundaries.
- Strong steps: none — the parent implements the coupled reservation/broker/cutover boundary on the strong tier; settled digest/fixture slices may use cheap workers with exact scope, never inherited strong routing.

## Risk and impact
- Areas: Agent tooling
- Processes: agent Linear lookup/update → shared allowance admission → status and operations digest; owner approval/status paths retain their reserve
- Impact: 0 — agent tooling only; worst plausible failure pauses agents or starves tooling decisions, not business records or external business effects
- Reversibility: revert — manifest-driven restoration of every changed saved script plus revert/reload/restart restores the prior transport; no business data backfill
- Feature flag: no — every managed MCP call must share admission; the existing Agent access to Linear setting still disables those tools, not just this protection
- Migration: no
- Auth: no
- New rule: no — applies the existing owner-reserve and identity/scope policies to MCP callers
- Failure mode: agents pause unnecessarily, spend owner allowance or lose usage attribution; detected by fake upstream counts, owner-path checks, journal/restart tests and live source counters
- Advisor rating: impact 0, reversibility revert
- Recommendation: auto — technical enforcement of the approved budget policy; no business choice, production data fix, external account or spend change

## Advisor review
GPT-6 Astra (`omp/openai-codex/gpt-6-astra`, medium). Rounds: 3 (two substantive reviews and final-text confirmation). Agreement reached in round 2; no disputed points. Adopted all six must-change points: three transport outcomes; persistent unresolved debt beyond fence expiry; best-effort crash accounting; repeatable artifact manifests and executable restoration; bounded per-pool bootstrap; hourly logs with AC-11. Also adopted serialized/synced journal updates, bounded shutdown and the mixed daemon/external-spend qualification. The advisor independently rated impact 0 / revert, with no auth change or new rule. Operational reconciliation must never treat elapsed time or fresh headers as grounds to discard unresolved debt.
