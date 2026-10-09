import type { PaseoApi, PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { branchesRpc, cachedOverviewRpc, capacityRpc, connectRpc, countIssuesRpc, dispatchStatusRpc, agentStatusRpc, focusRpc, getSettingsRpc, issueContextRpc, disconnectRpc, getDefaultPromptRpc, labelPullsRpc, listIssuesRpc, launchAgentRpc, planProjectRpc, presenceRpc, projectsStatusRpc, pullRequestsRpc, searchIssuesRpc, setCapacityRpc, setDefaultPromptRpc, setFocusRpc, setPresenceRpc, setSettingsRpc, skipPlanRpc, statusRpc, answerAskRpc, ownerAsksRpc, type CapacityState } from "./shared/contracts";
import { projectBranches } from "./server/projects";
import { LinearService } from "./server/linear";
import { Launcher } from "./server/launch";
import { Settings, DEFAULT_CHEAP_MODELS, type PluginSettings } from "./server/settings";
import { DEFAULT_PROMPT_TEMPLATE } from "./shared/contracts";
import { cacheScope, TicketCache } from "./server/cache";
import { Credentials } from "./server/credentials";
import { Dispatcher, dispatchLabels } from "./server/dispatch";
import { CommentRelay, deliverToAgent } from "./server/relay";
import { recordPluginComment } from "./server/agent-records";
import { paseoHome } from "./server/ticket-mcp";
import { join } from "node:path";
import { PlannotatorBridge, writeOpenScript, type OwnerOrigin } from "./server/plannotator";
import { DecisionJournal } from "./server/decision-journal";
import { ParkedPlans, PlannotatorHost } from "./server/parked";
import { reviewOutcome } from "./server/review-outcome";
import { Writeback } from "./server/writeback";
import { DecisionLog } from "./server/owner-decisions";
import { Deputy, DEPUTY_DIRECTORY } from "./server/deputy";
import { PermissionReplies } from "./server/permission-replies";
import { evaluateWithOmp } from "./server/deputy-evaluator";
import { hostReaders, recallAccess } from "./server/deputy-sources";
import { AgentApi, AppAuth } from "./server/agent-app";
import { AgentWebhookServer, WEBHOOK_PORT } from "./server/agent-webhook";
import { ensureFunnel, type FunnelStatus } from "./server/funnel";
import { ReviewLinks } from "./server/review-links";
import { closeInternalDaemon, internalDaemon, modelSetter, ownConnection } from "./server/connection";
import { ModelGuard } from "./server/model-guard";
import { recordStart, TIER_AGENT_LABEL, tierModel, TierStore } from "./server/model-tiers";
import { isTier } from "./shared/plan-model";
import { GreptileOutage } from "./server/greptile-outage";
import { HealthMonitor } from "./server/health";
import { KnownStates } from "./server/known-states";
import { PullRequestWatch } from "./server/pr-watch";
import { PullRequestBoard } from "./server/pull-requests";
import { ManualTasks } from "./server/manual-tasks";
import { Handover } from "./server/handover";
import { closeAnswered, NeedsYouIssues } from "./server/needs-you";
import { OWNER_ASK_DIRECTORY, OwnerAsks } from "./server/owner-asks";
import { extractWithOmp } from "./server/owner-ask-extract";
import { daemonServerId, decidePlannotatorReview, paseoAgentUrl, restartOrThrow, SessionRouter, SessionStore, stopAgentTurn, type HostOwnership } from "./server/sessions";
import { LimitResumeStore, UsageReader } from "./server/limit-resume";
import { planSetup, TicketStarter } from "./server/starter";
import { ShardAssignor } from "./server/worktree-shards";
import { PLAN_TICKET_ENV } from "./server/plan-policy";
import { AgentEnvs, sessionEnv } from "./server/agent-env";
import { PlanRequests } from "./server/plan-requests";
import { PlanFollowUps } from "./server/plan-follow-ups";
import { labelDaemon, StateLabels } from "./server/state-labels";
import { LabelSync, PullRequestFiles } from "./server/label-sync";
import { ProjectFlow, ProjectStore } from "./server/project-flow";
import { ProjectIssueCache } from "./server/project-issues";
import { LabelRepair } from "./server/label-repair";
import { Presence } from "./server/presence";
import { Focus } from "./server/focus";
import { rateBudget, withPriority } from "./server/rate-budget";
import { hostname } from "node:os";
import { readActivationSecret, type ActivationSink } from "./server/activation";
import { activationEndpoints } from "./server/activation-endpoints";
import { PeerAppUser } from "./server/peer-identity";
import { ActivationIntake } from "./server/activation-intake";
import { DrainRouter } from "./server/drain";
import { resumeGuard, ticketOwnership, ticketOwners } from "./server/activation-guard";
import { ReviewDeletions } from "./server/review-deletions";
import { ReviewIssueInfos } from "./server/review-issue-info";
import { PlanPipeline } from "./server/plan-pipeline";
import { pipelineOwnerEvidence } from "./server/plan-pipeline-source";
import { Watchdog, WatchdogStore } from "./server/watchdog";
import { asCaller, linearUsage, usageLines } from "./server/linear-usage";
import { LinearBroker } from "./server/linear-broker";
import { upgradeTicketMcpScripts } from "./server/ticket-mcp";
import { PlanningSmoke } from "./server/planning-smoke";

export default function contribute(server: PluginServerContext) {
  void linearUsage.start();
  const broker = new LinearBroker();
  const brokerReady = upgradeTicketMcpScripts().then(async (upgrade) => {
    if (upgrade.unrecognized.length) console.error("[linear-tickets] Unrecognized saved MCP paths remain unprotected:", upgrade.unrecognized.join(", "));
    if (upgrade.manifest) console.log("[linear-tickets] Saved MCP restoration manifest:", upgrade.manifest);
    await broker.start();
  }).catch(() => { console.error("[linear-tickets] Linear broker initialization failed; agent tools fail closed."); });
  const credentials = new Credentials();
  // The native Linear agent ("Paseo" app): sessions, webhooks through Tailscale Funnel, and the
  // handover record every agent keeps on its ticket. Without the app installed, only the
  // handover comments and the comment-based paths run. Its token also serves the reads pollers
  // repeat, so they use the app's request pool instead of the owner's key.
  const auth = new AppAuth();
  const agentApi = new AgentApi(auth);
  const linear = new LinearService(credentials, undefined, agentApi);
  const deletions = new ReviewDeletions();
  const issueInfos = new ReviewIssueInfos(linear);
  linear.onOwnerComment = (commentId, issueId) => recordPluginComment(join(paseoHome(), "linear-tickets"), commentId, issueId);
  // Each ticket agent's launch environment, given back to its resumed sessions (agent-env.ts).
  const agentEnvs = new AgentEnvs();
  // Every start path passes this before it creates a root (README, "Draining a host"): the
  // automatic paths forward or defer first (sessions.ts, dispatch.ts); this keeps a path that did
  // not -- the sidebar included -- from falling back to a local start while this host drains or
  // while the peer still owns the ticket. Assigned once the routers exist.
  let activationGuard: (issueId: string) => Promise<string | null> = async () => null;
  const settings = new Settings();
  // The peer host's Paseo app wrote its agents' tickets; they are trusted like this host's app's
  // (starter.ts isUntrusted, README "Several hosts").
  const peerAppUser = new PeerAppUser({ settings });
  linear.peerAppUser = () => peerAppUser.id();
  const cache = new TicketCache();
  const handover = new Handover(linear, undefined, undefined, undefined, async (agentId) => { const serverId = await daemonServerId(); return serverId ? paseoAgentUrl(serverId, agentId) : null; });
  // Which of a repository's clones a ticket's work belongs to (README, "Worktree shards"); off
  // until this host's settings turn it on, so every launch keeps its mapped project.
  const shards = new ShardAssignor({ settings: () => settings.read(), handover });
  const launcher = new Launcher(linear, undefined, undefined, (url) => linear.downloadUpload(url), undefined, undefined, agentEnvs, (issueId) => activationGuard(issueId), shards);
  launcher.useDeletions(deletions);
  // Present or away (README, "Present and away"): every start path asks the starter's scheduler.
  const presence = new Presence();
  // Model tiers (README, "Model tiers"): the tier each ticket implements on.
  const tiers = new TierStore();
  // Focus mode (README, "Focus mode"): while on, every start path admits only the tickets in focus.
  const focus = new Focus({ linear, settings });
  const starter = new TicketStarter({ linear, launcher, handover, presence, tiers, deletions, shards, focus });
  // The decision journal (README, "Decision journal"): every owner decision on a plan is written
  // here first and carried out by the bridge's worker; the inbox lists what is being applied.
  const decisionJournal = new DecisionJournal();
  // Every approval path files the approved plan's follow-ups (README, "Plan follow-ups").
  const followUps = new PlanFollowUps(linear);
  // Waits on tickets already closed live in "Needs you" sub-issues; replies there (a relayed
  // comment or an @mention of the app) go to the agent that asked.
  const needsYou = new NeedsYouIssues();
  const replies = new PermissionReplies();
  // The owner's Approve / Send back from the Linear panel or the review inbox: journaled for its
  // review, then sent to Plannotator as on the review page (plannotator.ts, decideOwner).
  const decideReview = (localUrl: string, approve: boolean, feedback: string, agentId: string, origin: OwnerOrigin): Promise<void> =>
    plannotator.decideOwner(localUrl, approve, feedback, agentId, origin);
  // Activation routing (README, "Draining a host"): every automatic start path calls `take`
  // before it starts. Remote mode forwards to the peer through the drain router; local mode
  // answers the peer's activations and defers the tickets it still claims. The two routers are
  // built below, once the session router exists; `take` only runs after this function returns.
  let attachedPaseo: PaseoApi | null = null;
  const route: ActivationSink = { take: async (request) => ((await settings.read()).activation.mode === "remote" ? drain.take(request) : intake.take(request)) };
  const sessionStore = new SessionStore();
  // The silent-agent watchdog's durable state (README, "Silent and stuck agents").
  const watchdogStore = new WatchdogStore();
  // Which host owns a ticket's automatic work, read only (SessionRouter.whileIdle, see
  // ticketOwnership): assigned once the activation routers exist below.
  let ticketOwner: (issueId: string) => Promise<HostOwnership> = async () => "unknown";
  const usage = new UsageReader();
  const sessions = new SessionRouter({ api: agentApi, linear, starter, handover, launcher, settings, store: sessionStore, needsYou, route, deletions, watchdog: watchdogStore, replies,
    limitResumes: new LimitResumeStore(), usage,
    owner: (issueId) => ticketOwner(issueId),
    decideReview,
    decidePlan: (link, mode): Promise<string | null> => plannotator.decidePanel(link, mode),
    reviewOutcome: (review) => reviewOutcome(review),
    recordOutcome: (agentId, outcome, review): Promise<void> => plannotator.recovered(agentId, review, outcome),
    // `paseo agent reload` for crashed agents (README, "Crashed agents"); the plugin SDK has no reload.
    reloader: async () => {
      const client = await internalDaemon();
      return client ? async (agentId) => { await client.refreshAgent(agentId); } : null;
    },
  });
  const hostName = hostname().replace(/\.local$/, "");
  const pipeline = new PlanPipeline({
    host: hostName, sessions: () => sessionStore.all(), parked: () => parking.plans.all(),
    owners: (issueIds) => pipelineOwnerEvidence(paseoHome(), issueIds),
  });
  let pipelineServerId: string | null = null;
  void daemonServerId().then((id) => { pipelineServerId = id; });
  const drain = new DrainRouter({ settings, paseo: () => attachedPaseo, sessionFor: (agentId) => sessions.sessionFor(agentId), host: hostName, replies,
    ticketState: async (issueId) => { const state = await linear.issueState(issueId).catch(() => null); return state ? { statusType: state.statusType } : null; },
    watchdog: { history: (issueId, now) => watchdogStore.history(issueId, now), transferred: (issueId, identifier) => watchdogStore.transferred(issueId, identifier) },
    handover: { resumeSnapshot: (issueId) => handover.resumeSnapshot(issueId) } });
  const intake = new ActivationIntake({ settings, paseo: () => attachedPaseo, linear: () => linear, starter: () => starter, launcher: () => launcher, sessions: () => sessions, sessionFor: (agentId) => sessions.sessionFor(agentId), host: hostName, watchdog: watchdogStore, replies });
  activationGuard = async (issueId) => {
    const { mode, peer } = (await settings.read()).activation;
    // A guard that cannot read its own state refuses: it starts nothing on a guess, and the
    // sidebar says why.
    if (mode === "remote") {
      try {
        if (await drain.ownerFor(issueId)) return null;
      } catch {
        return "This host could not confirm whether the ticket still runs here (its state is unreadable), so it started nothing. Try again in a minute.";
      }
      return `This host forwards new Linear work to ${peer ?? "the peer host"}; assign Paseo or add the trigger label and it starts there.`;
    }
    try {
      const claim = await intake.claimFor(issueId);
      return claim ? `This ticket is still running on ${claim.host}; new work for it goes there.` : null;
    } catch {
      return "This host could not read which tickets still run elsewhere, so it started nothing. Try again in a minute.";
    }
  };
  ticketOwner = ticketOwnership({ settings, drain, intake });
  const openSession = async (issueId: string, identifier: string, agentId: string) => Boolean(await auth.credentials() && await sessions.openFor(issueId, identifier, agentId));
  // Labelled projects: a planner run sets the work order, then tickets are handed out as slots free up.
  // A run without a live agent, and a ticket assigned to Paseo whose start failed, is started again
  // (README, "Projects").
  const projectStore = new ProjectStore();
  // Project tickets are read in full every 30 minutes and only as changed in between (project-issues.ts).
  const projectIssues = new ProjectIssueCache(linear);
  const projects = new ProjectFlow({ linear, settings, projectIssues: (projectId, full) => projectIssues.read(projectId, full), scheduler: starter.scheduler, capacity: starter.capacity, store: projectStore, usage, tiers, focus,
    startPlanner: (input, paseo, current) => launcher.startPlanner(input, paseo, current),
    retire: async (agentId, api) => {
      await stopAgentTurn(agentId).catch(() => {});
      await api.agents.ref(agentId).archive().catch(() => {});
    }, restart: async (issueId, identifier) => restartOrThrow(await sessions.restartFor(issueId, identifier)), accountedFor: async (issueId) => launcher.underWay(issueId) || await sessions.threadHolds(issueId) });
  // Stale `-running` and `-failed` labels are reconciled, and their tickets started again (README,
  // "Repairing stale running and failed labels"); its records share projects.json with the projects.
  const labelRepair = new LabelRepair({ linear, store: projectStore, launcher, intake, deletions, restart: (issueId, identifier, options) => sessions.restartFor(issueId, identifier, options) });
  const relay = new CommentRelay(linear, undefined, needsYou, route, replies);
  const dispatcher = new Dispatcher({ linear, starter, launcher, settings, route, relay, afterLaunch: openSession, handOff: (issueId) => sessions.handOffGroup(issueId), projects, repairs: labelRepair, focus });
  const writeback = new Writeback(linear, settings, { sessions, handover }, undefined, undefined, needsYou);
  // The owner's plan feedback and answers, for the weekly decision candidates (README, "Decision candidates").
  const decisions = new DecisionLog();
  writeback.recordDecisions(decisions);
  // The deputy for agent questions (README, "Deputy for agent questions"); off unless set otherwise.
  const deputyDirectory = DEPUTY_DIRECTORY();
  const deputy = new Deputy({
    settings, log: decisions, linear, sessions,
    readers: hostReaders({ linear, log: decisions, home: paseoHome(), directory: deputyDirectory, template: async () => (await settings.read()).template ?? DEFAULT_PROMPT_TEMPLATE }),
    evaluate: (input, model) => evaluateWithOmp(input, model, deputyDirectory),
    directory: deputyDirectory,
    arbiter: () => replies.available(),
  });
  writeback.recordDeputy(deputy);
  relay.recordDeputy(deputy);
  sessions.recordDeputy(deputy);
  replies.recordEffects({
    ownerAnswered: (agentId, request, response, activity, at) => deputy.ownerAnswered(agentId, request, response, activity, at),
    correctLate: (agentId, requestId, text, activity) => deputy.correctLate(agentId, requestId, text, activity),
    needsYou: async (agentId, issueId) => {
      for (const entry of await needsYou.all()) {
        if (entry.agentId === agentId && (!issueId || entry.id === issueId)) await closeAnswered(needsYou, linear, entry.id);
      }
    },
  });
  // The owner's asks (README, "Owner asks"): the Paseo Agents menu bar app's cards for everything
  // waiting in Linear's "Needs input" state, extracted by one isolated model call each and
  // answered through the same paths an owner's "@paseo" reply takes.
  const ownerAsks = new OwnerAsks({
    linear,
    needsYou,
    handover,
    labels: async () => dispatchLabels((await settings.read()).dispatch.label),
    // The contract's model: the deputy's when set, else the cheap tier's omp model. Settings hold
    // Paseo provider ids ("omp/deepseek/deepseek-flash"); the isolated OMP call takes omp's own
    // "provider/model" form.
    resolveModel: async () => {
      const saved = await settings.read();
      return (saved.deputy.model ?? saved.cheapModels.omp?.model ?? DEFAULT_CHEAP_MODELS.omp.model).replace(/^omp\//, "");
    },
    extract: (input, model) => extractWithOmp(input, model, OWNER_ASK_DIRECTORY()),
    deliver: (paseo, agentId, message, origin) => deliverToAgent(paseo, agentId, message, origin, replies),
    continueTicket: async (issueId, identifier, lead) => {
      const result = await sessions.restartFor(issueId, identifier, { lead, retryHint: "answer from the menu bar or assign Paseo again" });
      switch (result.kind) {
        case "started": return { kind: "started", agentId: result.agentId };
        case "failed": return { kind: "failed", reason: result.error.message };
        case "deferred": return { kind: "deferred", reason: result.reason };
        case "forwarded": return { kind: "forwarded", peer: result.peer };
        case "live": return { kind: "live" };
        case "skipped": return { kind: "skipped" };
      }
    },
  });
  // Stable per-agent review links on the tailnet (:8444); tailnet-only, so no Linear app needed.
  // Its root is the review inbox, listing the peer hosts' reviews too (README, "Review inbox").
  const reviewLinks = new ReviewLinks({
    peers: async () => (await settings.read()).reviewPeers,
    decide: decideReview,
    decisions: { applying: () => decisionJournal.applying(), resolve: (entryId, action): Promise<void> => plannotator.resolve(entryId, action) },
    linearWorkspace: () => linear.workspaceUrl(),
    pipeline: async (open, decided) => {
      const snapshot = await pipeline.snapshot(open, decided);
      if (pipelineServerId) for (const row of snapshot.rows) {
        if (row.agentId) row.agentUrl = paseoAgentUrl(pipelineServerId, row.agentId);
      }
      return snapshot;
    },
    // Draining a host: /activation, /activation/claims, /activation/deliver and
    // /activation/health ride this tailnet service (activation-endpoints.ts).
    routes: activationEndpoints({ settings, intake, drain, appUserId: () => linear.appUserId() }),
    deletions,
    issueInfo: (identifier, options) => issueInfos.forIdentifier(identifier, options),
    issueLink: async (agentId) => {
      const link = await sessions.sessionFor(agentId);
      const agent = (await attachedPaseo?.agents.ref(agentId).refresh())?.agent;
      if (agent) {
        const issueId = agent.labels?.["linear.issueId"];
        const identifier = agent.labels?.["linear.identifier"];
        if (!issueId || !identifier || agent.labels?.["paseo.parent-agent-id"]) return null;
        if (link && (link.issueId !== issueId || link.identifier !== identifier)) return null;
        return { issueId, identifier };
      }
      return link ? { issueId: link.issueId, identifier: link.identifier } : null;
    },
    prepareDelete: async (issueId) => {
      await launcher.settledFor(issueId);
      await sessions.settleTicket(issueId);
      await plannotator.drain();
    },
    deleteIssue: (issueId) => linear.deleteIssue(issueId),
    cleanupIssue: async (issueId, agentId) => {
      await parking.plans.remove(issueId);
      await sessions.deleteTicket(issueId, agentId);
    },
  });
  // Plans that need the owner are parked and served by one central Plannotator host, so their
  // agents are retired instead of holding a slot until the owner decides (README, "Parked plans").
  const plannotatorHost = new PlannotatorHost();
  const parking = {
    plans: new ParkedPlans(),
    available: () => plannotatorHost.available(),
    retire: async (reviewUrl: string | null, agentId: string, api: PaseoApi, reason: string) => {
      if (reviewUrl) await decidePlannotatorReview(reviewUrl, false, reason).catch((error: unknown) => console.error(`[linear-tickets] closing the parked plan's own review failed: ${error instanceof Error ? error.message : error}`));
      await stopAgentTurn(agentId).catch(() => {});
      await api.agents.ref(agentId).archive().catch(() => {});
    },
  };
  const plannotator = new PlannotatorBridge(linear, settings, undefined, sessions, undefined, handover, undefined, reviewLinks, undefined, undefined, parking);
  plannotator.useJournal(decisionJournal);
  plannotator.useDeletions(deletions);
  plannotator.observeDeliveryFailures((event, error, attempts) => pipeline.recordDeliveryError(event, error, attempts));
  plannotator.onProjectPlan(projects);
  plannotator.useFollowUps(followUps);
  plannotator.recordDecisions(decisions);
  const manualTasks = new ManualTasks({ linear, settings });
  const watchdog = new Watchdog({ store: watchdogStore, sessions, linear, settings, handover, needsYou, manualTasks });
  // The ticket states crash recovery last saw, fed by every state the plugin writes (README, "Crashed agents").
  const knownStates = new KnownStates();
  linear.onStateWritten((issueId, state) => { void knownStates.observe(issueId, state, Date.now()); });
  const pullRequests = new PullRequestWatch({ handover, sessions, linear, settings, manualTasks, watchdog, knownStates, outage: new GreptileOutage(linear, settings),
    // Which tickets this host's pull request watch may work on (README, "Several hosts"): the same
    // claims rule SessionRouter reads per ticket, once for a whole poll (activation-guard.ts).
    owner: ticketOwners({ settings, drain, intake }),
    // The waits the plugin recorded for the owner, checked in every poll: a wait whose ending event
    // was lost would hold its ticket in Needs input forever. The tickets this host handed to the
    // peer keep their waits (the peer's plugin ends them).
    ownerWaits: { reconcileWaiting: async () => { if (attachedPaseo) await writeback.reconcileWaiting(attachedPaseo, { handedOver: () => watchdogStore.handedOver() }); } } });
  const planRequests = new PlanRequests({ linear, prompt: (agentId, text) => sessions.prompt(agentId, text) });
  const webhook = new AgentWebhookServer(async () => (await auth.credentials())?.webhookSecret ?? null, (event) => asCaller("session-webhook", () => sessions.receive(event)));
  // Each ticket workspace shows its ticket's Linear state as a workspace label ("Linear: In Review").
  const stateLabels = new StateLabels({ linear, daemon: async () => { const client = await internalDaemon(); return client ? labelDaemon(client) : null; } });
  linear.onStateWritten((issueId, state) => stateLabels.noteState(issueId, state));
  // Label groups kept current on every issue of some teams ("Area", "Type"), from label-rules.json.
  const labelSync = new LabelSync({ linear, pullRequests: new PullRequestFiles() });
  // The Paseo Agents menu bar's pull request view: polled only while the app asks (README, "Pull request view").
  const pullBoard = new PullRequestBoard();
  let funnel: FunnelStatus | null = null;
  const health = new HealthMonitor(linear, settings, [
    { name: "Linear API key", run: () => linear.ping() },
    { name: "Paseo Linear app", run: async () => { if (await auth.credentials()) await agentApi.viewer(); } },
    { name: "Tailscale Funnel", run: async () => {
      if (!await auth.credentials()) return;
      funnel = await ensureFunnel(WEBHOOK_PORT);
      if (!funnel.active) throw new Error(funnel.note ?? "Funnel is off; Linear webhooks cannot reach this Mac.");
    } },
    { name: "Webhook receiver", run: async () => {
      if (!await auth.credentials()) return;
      const response = await fetch(`http://127.0.0.1:${WEBHOOK_PORT}/`, { method: "POST", body: "{}", signal: AbortSignal.timeout(5_000) });
      if (response.status !== 401) throw new Error(`The local receiver answered HTTP ${response.status} instead of refusing an unsigned request.`);
    } },
  ]);
  // Started shortly after load (so a reload never leaves Linear's webhooks unanswered) or with the
  // first daemon connection, whichever comes first. Events wait for the connection before they
  // are handled; a new session is still acknowledged at once.
  let stopped = false;
  let agentReady: Promise<boolean> | null = null;
  // Refreshes the app token in the background while the plugin runs, so the agents' linear_ticket
  // servers, which only read token.json, keep writing as Paseo.
  let stopKeepingFresh = () => {};
  const startAgent = () => agentReady ??= auth.credentials().then(async (app) => {
    if (stopped) return false;
    asCaller("health", () => health.start());
    asCaller("pr-watch", () => pullRequests.start());
    asCaller("manual-tasks", () => manualTasks.start());
    asCaller("state-labels", () => stateLabels.start());
    asCaller("label-sync", () => labelSync.start());
    if (!app) return false;
    stopKeepingFresh = auth.keepFresh();
    await webhook.start();
    funnel = await ensureFunnel(WEBHOOK_PORT);
    if (!funnel.active) console.error(`[linear-tickets] Linear agent webhooks are not public: ${funnel.note}`);
    return true;
  }).catch((error: unknown) => {
    console.error(`[linear-tickets] starting the Linear agent receiver failed: ${error instanceof Error ? error.message : error}`);
    return false;
  });
  // Every agent session gets the Plannotator hook, so plan reviews show up in Paseo and Linear.
  // Written on the first session open, not at load, so loading the plugin has no side effects.
  let plannotatorBrowser: Promise<string | null> | null = null;
  const plannotatorHook = () => plannotatorBrowser ??= writeOpenScript().catch((error: unknown) => {
    console.error(`[linear-tickets] writing the Plannotator hook failed: ${error instanceof Error ? error.message : error}`);
    return null;
  });
  let attached = false;
  // Ticket agents run their tier's model: the launch model while planning and on the strong tier
  // (Plannotator restores its pre-planning model on approval), the cheap or standard model on those tiers.
  const modelGuard = new ModelGuard(settings, modelSetter, async (change) => {
    const link = await sessions.sessionFor(change.agentId);
    if (link) await sessions.say(link.sessionId, "thought", change.tier === "cheap" || change.tier === "standard" ? `Switched to the ${change.tier} model tier: ${change.to} (was ${change.from}).` : `Model restored to ${change.to} (it had switched to ${change.from}).`);
  }, async (agent) => {
    const issueId = agent.labels["linear.issueId"];
    const label = agent.labels[TIER_AGENT_LABEL];
    return (issueId ? await tiers.forAgent(issueId, agent.id) : null) ?? (isTier(label) ? label : null);
  });
  plannotator.useTiers({ store: tiers, apply: (agentId) => modelGuard.apply(agentId), replan: (agent, message) => planRequests.send(agent, message) });
  // The central Plannotator host starts once, after the hook it runs for each parked review exists.
  const startHost = async () => { if (await plannotatorHook() && !stopped) await plannotatorHost.start(); };
  let holdSeed: Promise<void> | null = null;
  const attach = (paseo: PaseoApi) => {
    const first = !attached;
    attached = true;
    attachedPaseo = paseo;
    replies.attach(paseo);
    holdSeed ??= sessions.seedHolds();
    void holdSeed.then(() => {
      if (stopped) return;
      asCaller("deputy", () => deputy.attach(paseo));
      asCaller("session-sweep", () => sessions.attach(paseo));
      if (first) asCaller("session-sweep", () => { void replies.recoverEffects().catch((error: unknown) => console.error(`[linear-tickets] recovering permission reply effects failed: ${error instanceof Error ? error.message : error}`)); });
    }).catch((error: unknown) => console.error(`[linear-tickets] restoring owner question holds failed: ${error instanceof Error ? error.message : error}`));
    if (!stopped) {
      asCaller("review-links", () => { void reviewLinks.start(); });
      asCaller("drain", () => drain.start());
      asCaller("intake", () => intake.start());
      if (first) asCaller("parked-plans", () => { void startHost(); });
    }
    asCaller("plan-pipeline", () => pipeline.attach(paseo));
    asCaller("dispatch", () => dispatcher.attach(paseo));
    asCaller("plan-decisions", () => plannotator.attach(paseo));
    asCaller("model-guard", () => modelGuard.attach(paseo));
    asCaller("plan-requests", () => planRequests.attach(paseo));
    void startAgent();
  };
  const cacheIdentity = async () => {
    const connection = await credentials.read();
    return connection.key ? cacheScope(connection.key) : null;
  };
  // The daemon connection is only handed to handlers and hooks; the first one starts the
  // dispatcher and the Plannotator bridge: opening the ticket surface, or any agent or workspace activity on this host
  // (resumed agents open their sessions right after a daemon restart).
  //
  // The resume guard goes first: a heartbeat, a schedule or an internal actor may not wake a
  // ticket root that this host no longer owns, and the env hook below then only ever runs for the
  // opens this one lets through.
  server.before("agent.session_open", resumeGuard({ settings, drain, attach, ready: () => drain.readyNow(), known: (agentId) => sessionStore.agentTicket(agentId) }));
  server.on("agent.turn_started", (event, { paseo }) => { attach(paseo); return asCaller("writeback.turn-started", () => writeback.turnStarted(event, paseo)); });
  server.on("agent.turn_ended", (event, { paseo }) => { attach(paseo); return asCaller("writeback.turn-ended", () => writeback.turnEnded(event, paseo)); });
  server.on("agent.permission_requested", (event, { paseo }) => { attach(paseo); return asCaller("writeback.permission-requested", () => writeback.permissionRequested(event, paseo)); });
  server.on("agent.permission_resolved", (event, { paseo }) => asCaller("writeback.permission-resolved", () => writeback.permissionResolved(event, paseo)));
  server.on("agent.archived", (event, { paseo }) => asCaller("writeback.archived", () => writeback.archived(event, paseo)));
  server.on("agent.created", (_event, { paseo }) => { attach(paseo); asCaller("state-labels", () => stateLabels.soon()); });
  server.on("workspace.created", (_event, { paseo }) => attach(paseo));
  server.before("agent.session_open", async ({ request }, { paseo }) => {
    attach(paseo);
    const browser = await plannotatorHook();
    // A new ticket agent gets its plan policy and ticket environment with its create request; a
    // resumed one (daemon restart, reload) gets them back from its labels and its saved launch
    // environment, so the omp extension keeps the same rules and tools (agent-env.ts).
    const labels = request.env[PLAN_TICKET_ENV] ? undefined : await paseo.agents.ref(request.agentId).refresh()
      .then((found) => found?.agent.labels, () => undefined);
    const saved = labels ? await agentEnvs.read(request.agentId) : {};
    const env = { ...(browser ? { PLANNOTATOR_BROWSER: browser } : {}), ...sessionEnv(request.env, labels, saved) };
    return Object.keys(env).length ? { ...request, env: { ...request.env, ...env } } : undefined;
  });
  server.handle(statusRpc, (_input, { paseo }) => { attach(paseo); return linear.status(); });
  server.handle(dispatchStatusRpc, (_input, { paseo }) => { attach(paseo); return dispatcher.snapshot(); });
  server.handle(projectsStatusRpc, (_input, { paseo }) => { attach(paseo); return projects.status(); });
  server.handle(planProjectRpc, async ({ projectId }, { paseo }) => { attach(paseo); return asCaller("project-flow", async () => projects.planNow(projectId, await settings.read(), paseo, true)); });
  server.handle(skipPlanRpc, async ({ projectId }, { paseo }) => { attach(paseo); return asCaller("project-flow", async () => projects.skipPlan(projectId, await settings.read(), paseo)); });
  server.handle(presenceRpc, () => presence.state());
  server.handle(setPresenceRpc, (change) => presence.update(change));
  server.handle(focusRpc, (_input, { paseo }) => { attach(paseo); return asCaller("focus", () => focus.status(paseo)); });
  server.handle(setFocusRpc, async ({ active }, { paseo }) => {
    attach(paseo);
    if (active) return asCaller("focus", () => focus.enable(paseo));
    const status = await focus.disable();
    // What waited for focus starts at this poll, not the next one.
    dispatcher.wake();
    return status;
  });
  // Memory lease (README, "Memory lease"): the menu bar app's RAM cap on new starts.
  const capacityState = async (paseo: PaseoApi): Promise<CapacityState> => {
    const { maxRunning } = (await settings.read()).dispatch;
    return { maxRunning, ...starter.capacity.limit(maxRunning), ...await starter.scheduler.counts(paseo) };
  };
  server.handle(capacityRpc, (_input, { paseo }) => capacityState(paseo));
  server.handle(setCapacityRpc, ({ lease }, { paseo }) => {
    starter.capacity.set(lease);
    return capacityState(paseo);
  });
  server.handle(pullRequestsRpc, ({ repository }) => pullBoard.read(repository));
  server.handle(labelPullsRpc, ({ repository, label, numbers }) => pullBoard.label(repository, label, numbers));
  // The owner's asks (README, "Owner asks"): read from cache at once (never waiting for the
  // model), answered through the same paths an "@paseo" reply takes.
  server.handle(ownerAsksRpc, async (_input, { paseo }) => { attach(paseo); return ownerAsks.snapshot(paseo); });
  server.handle(answerAskRpc, async (input, { paseo }) => { attach(paseo); return asCaller("owner-asks", () => ownerAsks.answer(input, paseo)); });
  server.handle(connectRpc, ({ apiKey }) => asCaller("sidebar", () => linear.authenticate(apiKey)));
  server.handle(disconnectRpc, () => linear.disconnect());
  server.handle(listIssuesRpc, async ({ cursor, stateNames, relation }) => {
    const showClosed = (await settings.read()).showClosed;
    const page = await asCaller("sidebar", () => linear.issues(cursor, stateNames, showClosed, relation));
    if (!cursor && !stateNames?.length && !relation) {
      const scope = await cacheIdentity();
      if (scope) await cache.saveIssues(scope, showClosed, page);
    }
    return page;
  });
  server.handle(countIssuesRpc, async () => {
    const showClosed = (await settings.read()).showClosed;
    const counts = await asCaller("sidebar", () => linear.countIssues(showClosed));
    const scope = await cacheIdentity();
    if (scope) await cache.saveCounts(scope, showClosed, counts);
    return counts;
  });
  server.handle(cachedOverviewRpc, async () => {
    const scope = await cacheIdentity();
    return scope ? cache.read(scope, (await settings.read()).showClosed) : null;
  });
  server.handle(searchIssuesRpc, ({ term, cursor }) => asCaller("sidebar", () => linear.searchIssues(term, cursor)));
  server.handle(issueContextRpc, ({ id }) => asCaller("sidebar", () => linear.detail(id)));
  server.handle(branchesRpc, ({ projectId }, { paseo }) => projectBranches(paseo, projectId));
  server.handle(getDefaultPromptRpc, async () => ({ template: (await settings.read()).template, builtin: DEFAULT_PROMPT_TEMPLATE }));
  server.handle(setDefaultPromptRpc, ({ template }) => settings.save(template).then((saved) => ({ ...saved, builtin: DEFAULT_PROMPT_TEMPLATE })));
  // The settings screen sees the routing mode and whether a secret is stored; the secret itself
  // never leaves the host (README, "Draining a host"). Neither does the deputy's recall token.
  const settingsView = async (saved: PluginSettings) => {
    const blockers = await deputy.liveBlockers(saved);
    return {
      ...saved,
      activation: { ...saved.activation, secretConfigured: Boolean(await readActivationSecret()) },
      deputy: { ...saved.deputy, recallConfigured: Boolean(await recallAccess(deputyDirectory)), live: { ready: !blockers.length, blockers } },
      builtin: DEFAULT_PROMPT_TEMPLATE,
    };
  };
  server.handle(getSettingsRpc, async () => settingsView(await settings.read()));
  server.handle(setSettingsRpc, async (input, { paseo }) => {
    const saved = await settings.patch(input);
    attach(paseo);
    if (input.dispatch) dispatcher.wake();
    if (input.deputy) await deputy.settingsChanged();
    return settingsView(saved);
  });
  server.handle(launchAgentRpc, async (input, { paseo }) => {
    const current = await settings.read();
    // The sidebar starts an agent here and now; a draining host starts none, so it refuses
    // instead of forwarding a launch whose workspace the owner picked on this host.
    if (current.activation.mode === "remote") throw new Error(`This host forwards new Linear work to ${current.activation.peer ?? "the peer host"}; the agent starts there. Assign Paseo or add the trigger label on the ticket.`);
    const { template, agentLinearAccess } = current;
    const setup = await planSetup(linear, input.id, input.provider, input.modeId, tiers);
    const model = tierModel(current, input.provider.split("/")[0], setup.tier?.tier ?? null, { provider: input.provider, ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}) });
    const launch = { ...input, ...model, modeId: setup.modeId, instructions: [...setup.notes, input.instructions.trim()].filter(Boolean).join("\n\n") };
    const markInProgress = input.markInProgress && setup.policy !== "required";
    // The owner's own start ends any label-repair incident of the ticket first (README, "Repairing
    // stale running and failed labels"), so a failure of it is a new incident with fresh retries.
    await labelRepair.ownerRetried(input.id);
    const result = await launcher.start(launch, paseo, { promptTemplate: template ?? undefined, markInProgress, linearAccess: agentLinearAccess, labels: setup.labels, env: setup.env });
    await recordStart(tiers, { id: input.id, identifier: setup.identifier }, setup.tier, result.agentId, model.provider);
    // Started by hand while focus is on: in flight now, so its successors start too.
    await focus.include(input.id, setup.identifier);
    await openSession(input.id, input.id, result.agentId);
    return result;
  });
  server.handle(agentStatusRpc, async (_input, { paseo }) => {
    attach(paseo);
    const installed = await startAgent();
    return { installed, funnel: funnel?.active ?? false, funnelNote: funnel?.note ?? null, lastWebhookAt: webhook.lastEventAt, webhooks: webhook.events, ...sessions.readStats(), usage: linearUsage.snapshot(), budget: { pools: rateBudget.snapshot(), hours: linearUsage.summary() } };
  });
  // No hook within a few seconds of loading (typically a reload): use the plugin's own connection.
  let own: PaseoClient | null = null;
  const startSoon = setTimeout(() => {
    void startAgent();
    if (attached) return;
    void ownConnection().then((client) => {
      if (!client) return;
      if (stopped || attached) { void client.close(); return; }
      own = client;
      attach(client);
    });
  }, 3_000);
  startSoon.unref?.();
  const usageTimer = setInterval(() => { for (const line of usageLines(linearUsage.snapshot())) console.log(line); }, 60 * 60 * 1000);
  usageTimer.unref?.();
  // Whether fresh ticket agents still plan with Plannotator's framing (README, "Planning smoke
  // check"): first run two minutes after load, then every 15 minutes when an input changed.
  const planningSmoke = new PlanningSmoke();
  planningSmoke.start();
  return async () => {
    stopped = true;
    // The bridge stops admitting decisions and lets every admitted one finish (each call is
    // bounded) before anything it uses closes; only then does the journal's lease move on.
    await plannotator.stop();
    replies.stop();
    clearTimeout(startSoon);
    clearInterval(usageTimer);
    planningSmoke.stop();
    stopKeepingFresh();
    void own?.close();
    dispatcher.stop(); plannotatorHost.stop(); sessions.stop();
    webhook.stop(); reviewLinks.stop(); pipeline.stop(); health.stop();
    const stoppedPullRequests = pullRequests.stop();
    pullBoard.stop(); manualTasks.stop(); modelGuard.stop(); planRequests.stop();
    stateLabels.stop(); labelSync.stop(); drain.stop(); intake.stop(); deputy.stop();
    ownerAsks.stop();
    void closeInternalDaemon();
    await stoppedPullRequests;
    await brokerReady;
    await broker.stop();
    await linearUsage.stop();
  };
}
