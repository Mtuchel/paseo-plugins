import { link, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IssueState, LinearService } from "./linear";
import type { PluginSettings, Settings } from "./settings";
import { dispatchLabels } from "./dispatch";
import { hasLabel, PLAN_LABEL, PLAN_POLICY_LABEL } from "./plan-policy";
import { planRequestsDirectory } from "./plan-requests";
// starter.ts imports this module; its trust rule (isUntrusted) comes in through `untrusted`.
import { launchTier, TIER_LABELS, type TierStore } from "./model-tiers";
import { paseoHome } from "./ticket-mcp";
import { TIERS, type Tier } from "../shared/plan-model";
import { decisionText, NO_PLAN_LABEL, parseDecision, parseRouteFacts, routeRefusals, SMALL_ROUTE_MAX_LINES, type RouteDecision, type RouteFacts } from "../shared/small-route";

// The small-ticket route (README, "Small-ticket route"; TUC-1854), the plugin's side. The omp
// tool (omp/linear-tickets-plan-first.ts) drops a `route` event; the Plannotator bridge hands it
// here, inside its journal lease (plannotator.ts), and calls `sweep` on every drain.
//
// One attempt, one commit point: the attempt is written as `pending`, the facts are checked again
// against the ticket and the owner's settings now, and the decision file `<routeId>.decision` is
// created once with link(2), so it is complete or absent and never replaced. The tool writes
// `cancelled` there when its wait ends; whichever is first decides. Only the plugin writes
// `accepted`, and only an `accepted` file activates the route: nothing that lets the agent
// implement (route record, tier, labels, mode) happens before it. An unreadable decision counts as
// not accepted.
//
// An accepted attempt is carried out step by step, each recorded in the attempt file after it went
// through (restart-safe, like plan decisions). Before every step the owner fence is checked: a
// `plan` request since the attempt was created (plan-requests.ts reports it here, also when it
// first sees an agent on a routed ticket that already carries `plan`) turns the attempt into
// `cancelled-by-owner`, whose own steps restore planning whatever ran before: no route record, no
// `no-plan`, the strong tier, the agent's `linear.plan` label. Steps of one ticket never interleave.
// An approved plan closes every open attempt of its ticket.

export const SMALL_ROUTE_POLICY = "small-route";
export const SMALL_ROUTE_REASON = "the small-ticket route";

export type RouteEvent = { type: "route"; agentId: string | null; routeId: string; expiresAt: string; facts: unknown; at: string };
// The route a ticket was implemented on: what its relaunches revalidate (starter.ts `planSetup`).
export type RouteRecord = { routeId: string; agentId: string; tier: Tier; facts: RouteFacts; at: string };
type AttemptState = "pending" | "accepted" | "done" | "closed" | "cancelled-by-owner" | "reverted";
type Attempt = {
  routeId: string;
  agentId: string;
  issueId: string;
  identifier: string;
  provider: string;
  facts: RouteFacts;
  expiresAt: string;
  state: AttemptState;
  reason?: string;
  // When the attempt was first written: owner requests from then on fence it, also one that came
  // between publishing `accepted` and a restart's recovery of the attempt.
  createdAt: string;
  acceptedAt?: string;
  steps: Record<string, unknown>;
};
// What the bridge knows of the agent that dropped the event.
// `planDecisionOpen`: the decision journal holds a decision on this agent's plan not yet carried out.
export type RouteAgent = { id: string; issueId: string | null; identifier: string; provider: string; planPolicy: string | null; planDecisionOpen: boolean };
type Deps = {
  linear: Pick<LinearService, "issueState" | "comment" | "commentById" | "addLabel" | "removeLabel" | "moveToStateNamed">;
  // starter.ts isUntrusted for this ticket's state.
  untrusted: (state: IssueState) => Promise<boolean>;
  settings: Pick<Settings, "read">;
  tiers: Pick<TierStore, "get" | "record">;
  // The model guard's immediate switch to the recorded tier.
  applyTier: (agentId: string) => Promise<unknown>;
  setMode: (agentId: string, modeId: string) => Promise<void>;
  setLabel: (agentId: string, name: string, value: string) => Promise<void>;
  // The agent is archived or deleted: steps aimed at it have nothing left to change.
  agentGone: (agentId: string) => Promise<boolean>;
  directory?: string;
  requests?: string;
  now?: () => number;
};

export function smallRouteDirectory(home = paseoHome()): string {
  return join(home, "linear-tickets", "small-route");
}

// Why the ticket may not take (or keep, on a relaunch) the small route now: the owner's settings
// and the ticket's state. Empty: it may.
export function eligibilityProblems(state: { labels: { name: string }[] }, untrusted: boolean, impact: number, settings: Pick<PluginSettings, "autoApprove" | "dispatch">): string[] {
  return [
    untrusted ? "the ticket was not written by the owner" : "",
    hasLabel(state.labels, dispatchLabels(settings.dispatch.label).attended.toLowerCase()) ? "the ticket is attended" : "",
    hasLabel(state.labels, PLAN_LABEL) ? "the owner asked for a plan" : "",
    settings.autoApprove.enabled ? "" : "auto-approval is off",
    impact > settings.autoApprove.maxImpact ? `impact ${impact} is above the auto-approval threshold ${settings.autoApprove.maxImpact}` : "",
  ].filter(Boolean);
}

async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
}

export class SmallRoutes {
  private readonly directory: string;
  private readonly requests: string;
  private readonly now: () => number;
  // Steps and cancellations of one ticket run one at a time.
  private readonly tickets = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: Deps) {
    this.directory = deps.directory ?? smallRouteDirectory();
    this.requests = deps.requests ?? planRequestsDirectory();
    this.now = deps.now ?? Date.now;
  }

  private path(kind: "attempts" | "routes" | "decisions" | "owner", name: string, suffix = ".json"): string {
    return join(this.directory, kind, `${name.replace(/[^A-Za-z0-9-]/g, "_")}${suffix}`);
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  private serial<T>(issueId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tickets.get(issueId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.tickets.set(issueId, next);
    return next;
  }

  // The route a ticket is implemented on, or null.
  async get(issueId: string): Promise<RouteRecord | null> {
    return this.readJson<RouteRecord>(this.path("routes", issueId));
  }

  // The decision that stands for an attempt: publishes this one unless one exists. null: unreadable.
  async publish(routeId: string, decision: RouteDecision): Promise<RouteDecision | null> {
    const target = this.path("decisions", routeId, ".decision");
    const directory = join(target, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${routeId}.${randomUUID()}.tmp`);
    try {
      await writeSynced(temporary, decisionText(decision, "plugin"));
      await link(temporary, target);
      const handle = await open(directory, "r").catch(() => null);
      if (handle) await handle.sync().catch(() => undefined).finally(() => handle.close());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally { await rm(temporary, { force: true }); }
    return this.decision(routeId);
  }

  private async decision(routeId: string): Promise<RouteDecision | null> {
    const raw = await readFile(this.path("decisions", routeId, ".decision"), "utf8").catch(() => null);
    return raw === null ? null : parseDecision(raw);
  }

  private async decisionExists(routeId: string): Promise<boolean> {
    return readFile(this.path("decisions", routeId, ".decision"), "utf8").then(() => true, () => false);
  }

  // A `route` event from the omp tool (the bridge's intake, inside its journal lease).
  async handle(event: RouteEvent, agent: RouteAgent): Promise<void> {
    if (!agent.issueId) return;
    const issueId = agent.issueId;
    await this.serial(issueId, async () => {
      let attempt = await this.readJson<Attempt>(this.path("attempts", event.routeId));
      if (!attempt) {
        const parsed = parseRouteFacts(event.facts);
        if ("problem" in parsed) {
          await this.publish(event.routeId, { decision: "refused", reason: `the route request was unreadable: ${parsed.problem}` });
          return;
        }
        attempt = { routeId: event.routeId, agentId: agent.id, issueId, identifier: agent.identifier, provider: agent.provider, facts: parsed.facts, expiresAt: event.expiresAt, state: "pending", createdAt: new Date(this.now()).toISOString(), steps: {} };
        await this.save(attempt);
      }
      if (attempt.state !== "pending") return;
      if (await this.decide(attempt, agent) === "accepted") await this.carryOut(attempt);
    });
  }

  private save(attempt: Attempt): Promise<void> {
    return this.writeJson(this.path("attempts", attempt.routeId), attempt);
  }

  // Revalidates a pending attempt and publishes the plugin's decision; whichever decision stands
  // settles the attempt. A late plugin never activates a route the tool gave up on.
  private async decide(attempt: Attempt, agent: RouteAgent | null): Promise<AttemptState> {
    let standing = await this.decision(attempt.routeId);
    if (!standing && !await this.decisionExists(attempt.routeId)) {
      const expired = Date.parse(attempt.expiresAt) <= this.now();
      const problems = expired ? ["the tool stopped waiting"] : await this.problems(attempt, agent);
      standing = await this.publish(attempt.routeId, !problems.length ? { decision: "accepted" } : { decision: expired ? "cancelled" : "refused", reason: problems.join("; ") });
    }
    if (standing?.decision === "accepted") {
      attempt.state = "accepted";
      attempt.acceptedAt = new Date(this.now()).toISOString();
      console.log(`[linear-tickets] ${attempt.identifier}: small-ticket route accepted (${attempt.facts.reason})`);
    } else {
      attempt.state = "closed";
      attempt.reason = standing ? `${standing.decision}: ${standing.reason}` : "unreadable decision";
      console.log(`[linear-tickets] ${attempt.identifier}: small-ticket route not taken (${attempt.reason})`);
    }
    await this.save(attempt);
    return attempt.state;
  }

  // Everything that keeps the attempt from the route right now, besides the facts' own refusals.
  private async problems(attempt: Attempt, agent: RouteAgent | null): Promise<string[]> {
    const settings = await this.deps.settings.read();
    const state = await this.deps.linear.issueState(attempt.issueId);
    const untrusted = await this.deps.untrusted(state);
    return [
      ...routeRefusals(attempt.facts),
      ...eligibilityProblems(state, untrusted, attempt.facts.impact, settings),
      !agent || agent.id !== attempt.agentId || agent.issueId !== attempt.issueId ? "the agent is not this ticket's agent" : "",
      agent && agent.planPolicy !== "required" ? "the agent is not planning" : "",
      agent && !agent.provider.startsWith("omp") ? "the small route is for omp agents only" : "",
      agent?.planDecisionOpen ? "a plan decision for this agent is still being carried out" : "",
      await this.ownerAsked(attempt) ? "the owner asked for a plan" : "",
    ].filter(Boolean);
  }

  // The owner's `plan` request (plan-requests.ts): a request file for the agent the extension has
  // not taken yet, or one recorded for the ticket since the attempt was created (before acceptance
  // the ticket's `plan` label, read fresh in `problems`, refuses too).
  private async ownerAsked(attempt: Attempt): Promise<boolean> {
    const pending = await readFile(join(this.requests, attempt.agentId), "utf8").then(() => true, () => false);
    if (pending) return true;
    const owner = await this.readJson<{ at: string }>(this.path("owner", attempt.issueId));
    return Boolean(owner && owner.at >= attempt.createdAt);
  }

  // plan-requests.ts: the owner added `plan` to the ticket. Recorded first (any instance may call
  // it); the sweep carries the cancellation out under the journal lease.
  async ownerRequested(issueId: string): Promise<void> {
    await this.writeJson(this.path("owner", issueId), { at: new Date(this.now()).toISOString() });
  }

  // Every drain: pending attempts whose event is gone, accepted ones not finished, cancellations.
  async sweep(): Promise<void> {
    const names = (await readdir(join(this.directory, "attempts")).catch(() => [] as string[])).filter((name) => name.endsWith(".json") && !name.startsWith("."));
    for (const name of names) {
      const attempt = await this.readJson<Attempt>(join(this.directory, "attempts", name));
      if (!attempt || ["closed", "reverted"].includes(attempt.state)) continue;
      await this.serial(attempt.issueId, async () => {
        const current = await this.readJson<Attempt>(join(this.directory, "attempts", name));
        if (!current) return;
        // A pending attempt is decided by its event while the tool still waits.
        if (current.state === "pending") {
          if (Date.parse(current.expiresAt) > this.now()) return;
          await this.decide(current, null);
        }
        // A route whose record is gone (a plan was approved later) or replaced has nothing left to undo.
        if (current.state === "done" && (await this.get(current.issueId))?.routeId !== current.routeId) {
          current.state = "closed";
          current.reason = "the route record was removed or replaced";
          await this.save(current);
          return;
        }
        if (current.state === "accepted" || current.state === "cancelled-by-owner" || current.state === "done") await this.carryOut(current);
      });
    }
  }

  // Whether the owner sent the ticket back to planning; recorded once, then every later call says so.
  private async fence(attempt: Attempt): Promise<boolean> {
    if (attempt.state === "cancelled-by-owner") return true;
    if (!await this.ownerAsked(attempt)) return false;
    attempt.state = "cancelled-by-owner";
    await this.save(attempt);
    console.log(`[linear-tickets] ${attempt.identifier}: the owner asked for a plan; the small-ticket route is undone`);
    return true;
  }

  private async step<T>(attempt: Attempt, name: string, work: () => Promise<T>): Promise<void> {
    if (name in attempt.steps) return;
    const value = await work();
    attempt.steps[name] = value === undefined ? true : value;
    await this.save(attempt);
  }

  // Best effort (cosmetic, or retried by another part of the plugin): recorded either way.
  private async optional(attempt: Attempt, name: string, work: () => Promise<unknown>): Promise<void> {
    await this.step(attempt, name, async () => {
      try { await work(); return true; } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        console.error(`[linear-tickets] ${attempt.identifier}: ${name} skipped: ${failure}`);
        return { skipped: failure.slice(0, 300) };
      }
    });
  }

  private async carryOut(attempt: Attempt): Promise<void> {
    if (await this.fence(attempt)) return this.undo(attempt);
    if (attempt.state === "done") return;
    const settings = await this.deps.settings.read();
    const issue = { id: attempt.issueId, identifier: attempt.identifier };
    const steps: [string, () => Promise<unknown>][] = [
      ["record", async () => {
        const state = await this.deps.linear.issueState(issue.id);
        const tier = launchTier(state.labels, await this.deps.tiers.get(issue.id), attempt.facts.tier) ?? attempt.facts.tier;
        const launch = settings.launchPreferences[attempt.provider];
        await this.deps.tiers.record(issue, { tier, source: "route", reason: tier === attempt.facts.tier ? attempt.facts.tierReason : "raised by the ticket's model label or an earlier escalation", agentId: attempt.agentId, model: launch?.model ?? null });
        await this.writeJson(this.path("routes", issue.id), { routeId: attempt.routeId, agentId: attempt.agentId, tier, facts: attempt.facts, at: attempt.acceptedAt ?? new Date(this.now()).toISOString() } satisfies RouteRecord);
        return tier;
      }],
      ["mode", () => this.onAgent(attempt, async () => {
        const preference = settings.launchPreferences[attempt.provider] ?? (settings.lastProvider ? settings.launchPreferences[settings.lastProvider] : undefined);
        if (!preference?.modeId) return "no usual mode";
        await this.deps.setMode(attempt.agentId, preference.modeId);
        return preference.modeId;
      })],
      // A resumed session reads its policy from this label (agent-env.ts): no planning again.
      ["agent-label", () => this.onAgent(attempt, () => this.deps.setLabel(attempt.agentId, PLAN_POLICY_LABEL, SMALL_ROUTE_POLICY))],
      // Write-back moves a ticket only on an agent's first turn, which was a planning one
      // (plannotator.ts CODING_STATE, the same move an approved plan makes).
      ["state", async () => {
        if (!settings.writeback.status) return;
        const moved = await this.deps.linear.moveToStateNamed(issue.id, "In Progress");
        if (moved.note) console.error(`[linear-tickets] ${attempt.identifier}: ${moved.note}`);
      }],
      ["comment", () => this.comment(attempt, settings)],
      ["label", () => this.deps.linear.addLabel(issue.id, NO_PLAN_LABEL)],
    ];
    for (const [name, work] of steps) {
      if (await this.fence(attempt)) return this.undo(attempt);
      await this.step(attempt, name, work);
    }
    const tier = attempt.steps.record as Tier;
    if (settings.writeback.status) await this.optional(attempt, "tier-label", async () => {
      await this.deps.linear.addLabel(issue.id, TIER_LABELS[tier]);
      for (const other of TIERS) if (other !== tier) await this.deps.linear.removeLabel(issue.id, TIER_LABELS[other]);
    });
    await this.optional(attempt, "tier-switch", () => this.deps.applyTier(attempt.agentId));
    attempt.state = "done";
    await this.save(attempt);
    console.log(`[linear-tickets] ${attempt.identifier}: small-ticket route carried out, implementing on the ${tier} tier`);
  }

  private async onAgent<T>(attempt: Attempt, work: () => Promise<T>): Promise<T | "agent gone"> {
    try { return await work(); } catch (error) {
      if (await this.deps.agentGone(attempt.agentId).catch(() => false)) return "agent gone";
      throw error;
    }
  }

  // The comment is created with a reserved id and looked up by it first, so a retry never posts twice.
  private async comment(attempt: Attempt, settings: PluginSettings): Promise<string> {
    const reserved = typeof attempt.steps["comment:id"] === "string" ? attempt.steps["comment:id"] as string : randomUUID();
    if (!attempt.steps["comment:id"]) { attempt.steps["comment:id"] = reserved; await this.save(attempt); }
    if (await this.deps.linear.commentById(reserved)) return reserved;
    const facts = attempt.facts;
    const body = [
      "⚡ **Small-ticket route**: no plan review for this ticket. Every condition holds:",
      `- ${facts.acceptanceCriteria} acceptance criterion${facts.acceptanceCriteria === 1 ? "" : "s"}, about ${facts.expectedChangedLines} changed lines (more than one criterion needs ${SMALL_ROUTE_MAX_LINES} or fewer)`,
      "- no database migration, no login or permission change, nothing touching money or the ERP, no contract other packages build on",
      "- no new rule, no question for the owner",
      `- impact ${facts.impact}, within the auto-approval threshold ${settings.autoApprove.maxImpact}; a revert undoes it`,
      "- written by the owner, not attended, no `plan` label (checked again by the plugin)",
      `- Tier: ${String(attempt.steps.record ?? facts.tier)} — ${facts.tierReason}`,
      `- Reach: ${facts.reach}`,
      `- Why small: ${facts.reason}`,
      "",
      "The pull request's `Reach:` and `Principles and rules:` bullets are the plan; its code review runs as usual. Add the `plan` label to send the ticket to planning.",
    ].join("\n");
    await this.deps.linear.comment(attempt.issueId, body, reserved);
    return reserved;
  }

  // The owner asked for a plan: planning again, whatever the route already did. The agent enters
  // planning through the plan request itself (plan-requests.ts, the omp extension).
  private async undo(attempt: Attempt): Promise<void> {
    if (attempt.state !== "cancelled-by-owner") {
      attempt.state = "cancelled-by-owner";
      await this.save(attempt);
    }
    const issue = { id: attempt.issueId, identifier: attempt.identifier };
    await this.step(attempt, "undo-record", async () => {
      const record = await this.get(issue.id);
      if (record?.routeId === attempt.routeId) await rm(this.path("routes", issue.id), { force: true });
      if ("record" in attempt.steps) await this.deps.tiers.record(issue, { tier: "strong", source: "route", reason: "the owner asked for a plan", agentId: attempt.agentId, model: null });
    });
    await this.step(attempt, "undo-label", () => this.deps.linear.removeLabel(issue.id, NO_PLAN_LABEL));
    await this.step(attempt, "undo-agent-label", () => this.onAgent(attempt, () => this.deps.setLabel(attempt.agentId, PLAN_POLICY_LABEL, "required")));
    await this.optional(attempt, "undo-tier-switch", () => this.deps.applyTier(attempt.agentId));
    attempt.state = "reverted";
    await this.save(attempt);
  }

  // The ticket's attempts not yet closed or reverted.
  private async openAttempts(issueId: string): Promise<Attempt[]> {
    const names = (await readdir(join(this.directory, "attempts")).catch(() => [] as string[])).filter((name) => name.endsWith(".json") && !name.startsWith("."));
    const open: Attempt[] = [];
    for (const name of names) {
      const attempt = await this.readJson<Attempt>(join(this.directory, "attempts", name));
      if (attempt?.issueId === issueId && !["closed", "reverted"].includes(attempt.state)) open.push(attempt);
    }
    return open;
  }

  // Whether the ticket is on the small route or about to be: a route record, or an attempt still
  // pending or being carried out. plan-requests.ts asks before it treats a `plan` label it sees on
  // its first look at an agent as the owner's request.
  async active(issueId: string): Promise<boolean> {
    if (await this.get(issueId)) return true;
    return (await this.openAttempts(issueId)).some((attempt) => attempt.state === "pending" || attempt.state === "accepted");
  }

  // A plan was approved for the ticket later: the route no longer applies (README, "Small-ticket
  // route"). Every open attempt is closed first, so no unfinished step of one restores the route,
  // and no undo overrides the approved plan's tier or label.
  async planApproved(issueId: string): Promise<void> {
    await this.serial(issueId, async () => {
      for (const attempt of await this.openAttempts(issueId)) {
        if (attempt.state === "pending") await this.publish(attempt.routeId, { decision: "refused", reason: "a plan was approved for the ticket" });
        attempt.state = "closed";
        attempt.reason = "a plan was approved for the ticket";
        await this.save(attempt);
      }
      if (!await this.get(issueId)) return;
      await this.deps.linear.removeLabel(issueId, NO_PLAN_LABEL);
      await rm(this.path("routes", issueId), { force: true });
    });
  }
}
