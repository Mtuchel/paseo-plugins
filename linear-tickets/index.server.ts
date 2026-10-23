import type { PaseoApi, PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { randomUUID } from "node:crypto";
import { branchesRpc, cachedOverviewRpc, capacityRpc, connectRpc, countIssuesRpc, dispatchStatusRpc, agentStatusRpc, focusRpc, getSettingsRpc, issueContextRpc, disconnectRpc, getDefaultPromptRpc, labelPullsRpc, listIssuesRpc, launchAgentRpc, planProjectRpc, presenceRpc, projectsStatusRpc, pullRequestsRpc, searchIssuesRpc, setCapacityRpc, setDefaultPromptRpc, setFocusRpc, setPresenceRpc, setSettingsRpc, skipPlanRpc, statusRpc, answerAskRpc, ownerAsksRpc, triageAskRpc, type CapacityState } from "./shared/contracts";
import { deputyStatusRpc, parentsStatusRpc, reconcileDeputyRpc } from "./shared/contracts";
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
import { stopChildProcessHelper } from "./server/child-processes";
import { reviewOutcome } from "./server/review-outcome";
import { Writeback } from "./server/writeback";
import { DecisionLog } from "./server/owner-decisions";
import { Deputy, DEPUTY_DIRECTORY } from "./server/deputy";
import { PermissionReplies } from "./server/permission-replies";
import { evaluateWithOmp } from "./server/deputy-evaluator";
import { hostReaders, recallAccess } from "./server/deputy-sources";
import { AgentApi, AppAuth } from "./server/agent-app";
import { AgentWebhookServer, WEBHOOK_PORT } from "./server/agent-webhook";
import { WebhookCoverage } from "./server/webhook-coverage";
import { ensureFunnel, type FunnelStatus } from "./server/funnel";
import { ReviewLinks } from "./server/review-links";
import { RepairExclusion } from "./server/repair-exclusion";
import { ResponsibilityCheck, ResponsibilityStore } from "./server/responsibility";
import { ensureBackendSecret } from "./server/inbox-transport";
import { tailnetOrigin } from "./server/tailscale";
import { BrowserDecisionInbox } from "./server/decision-inbox";
import { BoardInbox } from "./server/board-inbox";
import { collectBoardFacts } from "./server/board-facts";
import { boardIssues, boardPulls } from "./server/board-sources";
import { MergeStatus } from "./server/merge-status";
import { mergeStatusRpc } from "./shared/merge-status";
import { closeInternalDaemon, internalDaemon, modelSetter, ownConnection } from "./server/connection";
import { ModelGuard } from "./server/model-guard";
import { recordStart, TIER_AGENT_LABEL, tierModel, TierStore } from "./server/model-tiers";
import { AcceptanceTestsStore } from "./server/acceptance-tests";
import { readTier } from "./shared/plan-model";
import { GreptileOutage } from "./server/greptile-outage";
import { HealthMonitor } from "./server/health";
import { KnownStates } from "./server/known-states";
import { PullRequestWatch } from "./server/pr-watch";
import { DoneTickets, RetiredLabels, Steward, StewardStore } from "./server/steward";
import { PullRequestBoard } from "./server/pull-requests";
import { ManualTasks } from "./server/manual-tasks";
import { Handover } from "./server/handover";
import { closeAnswered, NeedsYouIssues } from "./server/needs-you";
import { OWNER_ASK_DIRECTORY, OwnerAsks, ownerAsksPage } from "./server/owner-asks";
import { QueuedLabels } from "./server/queued-labels";
import { extractWithOmp } from "./server/owner-ask-extract";
import { daemonServerId, decidePlannotatorReview, paseoAgentUrl, SessionRouter, SessionStore, setAgentLabel, setAgentMode, stopAgentTurn, type HostOwnership } from "./server/sessions";
import { ParentStore } from "./server/parents";
import { SmallRoutes } from "./server/small-route";
import { LimitResumeStore, UsageReader } from "./server/limit-resume";
import { isUntrusted, planSetup, QUESTIONS_NOTE, TicketStarter } from "./server/starter";
import { ShardAssignor } from "./server/worktree-shards";
import { AgentEnvs } from "./server/agent-env";
import { PlanRequests } from "./server/plan-requests";
import { PlanFollowUps } from "./server/plan-follow-ups";
import { labelDaemon, StateLabels } from "./server/state-labels";
import { LabelSync, PullRequestFiles } from "./server/label-sync";
import { ProjectFlow, ProjectStore } from "./server/project-flow";
import { ProjectIssueCache } from "./server/project-issues";
import { Presence } from "./server/presence";
import { Focus } from "./server/focus";
import { rateBudget, withPriority } from "./server/rate-budget";
import { hostname } from "node:os";
import { readActivationSecret, type ActivationSink } from "./server/activation";
import { activationEndpoints } from "./server/activation-endpoints";
import { PeerAppUser } from "./server/peer-identity";
import { ActivationIntake } from "./server/activation-intake";
import { DrainRouter } from "./server/drain";
import { ticketOwnership, ticketOwners } from "./server/activation-guard";
import { loadProbe, startLoadProbe } from "./server/load-probe";
import { sessionOpenGuard, sessionPrepare } from "./server/session-open";
import { ReviewDeletions } from "./server/review-deletions";
import { ReviewIssueInfos } from "./server/review-issue-info";
import { PlanPipeline } from "./server/plan-pipeline";
import { pipelineOwnerEvidence } from "./server/plan-pipeline-source";
import { Watchdog, WatchdogStore } from "./server/watchdog";
import { asCaller, linearUsage, usageLines } from "./server/linear-usage";
import { githubUsage } from "./server/github-usage";
import { LinearBroker } from "./server/linear-broker";
import { upgradeTicketMcpScripts } from "./server/ticket-mcp";
import { PlanningSmoke } from "./server/planning-smoke";

export default function contribute(server: PluginServerContext) {
  void linearUsage.start();
  // README "GitHub usage": the gh wrapper for the repo scripts, and the day files' retention.
  githubUsage.start();
  const broker = new LinearBroker();
  const brokerReady = upgradeTicketMcpScripts().then(async (upgrade) => {
    if (upgrade.unrecognized.length) console.error("[linear-tickets] Unrecognized saved MCP paths remain unprotected:", upgrade.unrecognized.join(", "));
    if (upgrade.manifest) console.log("[linear-tickets] Saved MCP restoration manifest:", upgrade.manifest);
    await broker.start();
  }).catch(() => { console.error("[linear-tickets] Linear broker initialization failed; agent tools fail closed."); });
  const credentials = new Credentials();
  const coverage = new WebhookCoverage(credentials);
  // The native Linear agent ("Paseo" app): sessions, webhooks through Tailscale Funnel, and the
  // handover record every agent keeps on its ticket. Without the app installed, only the
  // handover comments and the comment-based paths run. Its token also serves the reads pollers
  // repeat, so they use the app's request pool instead of the owner's key.
  const auth = new AppAuth();
  const agentApi = new AgentApi(auth);
  const linear = new LinearService(credentials, undefined, agentApi);
  const deletions = new ReviewDeletions();
  // Keeps the responsibility check's repair apart from every other effect on the same ticket
  // (repair-exclusion.ts, README "Responsibility check"): closed until the decision journal is
  // owned and loaded, closed again and drained at shutdown before the journal's lease moves on.
  const exclusion = new RepairExclusion({ open: false });
  deletions.useExclusion(exclusion);
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
  launcher.useExclusion(exclusion);
  // Present or away (README, "Present and away"): every start path asks the starter's scheduler.
  const presence = new Presence();
  // Model tiers (README, "Model tiers"): the tier each ticket implements on.
  const tiers = new TierStore();
  // The acceptance tests a cheap-tier plan protects for its implementing agent (README, "Model
  // tiers"): written by the plugin at the plan's approval and at every start, read by the omp
  // extension, which refuses that agent's edits to them.
  const acceptanceTests = new AcceptanceTestsStore();
  // Focus mode (README, "Focus mode"): while on, every start path admits only the tickets in focus.
  // Its phases also read the parked plans and the peer's claims (both built below).
  const focus = new Focus({ linear, settings, parked: { all: () => parking.plans.all() }, intake: { claimedTickets: (): Promise<Set<string> | null> => intake.claimedTickets() } });
  // The small-ticket route (README, "Small-ticket route"): the bridge carries attempts out, the
  // starter relaunches on a recorded route. The model guard is built further down; it is only
  // called once the plugin runs.
  const smallRoutes = new SmallRoutes({
    linear, settings, tiers, setMode: setAgentMode, setLabel: setAgentLabel,
    untrusted: async (state) => isUntrusted(state, await linear.viewerId(), await linear.trustedAppIds()),
    applyTier: (agentId) => modelGuard.apply(agentId),
    agentGone: async (agentId) => {
      const found = attachedPaseo ? await attachedPaseo.agents.ref(agentId).refresh() : undefined;
      return found === null || Boolean(found?.agent.archivedAt);
    },
  });
  // Parked plans are built below with the Plannotator host; read only once the plugin runs.
  const waitingPlans = { has: (issueId: string) => parking.plans.has(issueId) };
  // Finished tickets (README, "Who starts next"): the slot count leaves out an agent of a Done or
  // Canceled ticket quiet for more than an hour. Fed by the steward's reads and by every state the
  // plugin writes, so a ticket Paseo reopens counts its agent again at once.
  const doneTickets = new DoneTickets();
  linear.onStateWritten((issueId, state) => doneTickets.written(issueId, state.type, Date.now()));
  const starter = new TicketStarter({ linear, launcher, handover, presence, tiers, acceptanceTests, routes: smallRoutes, deletions, shards, focus, parked: waitingPlans, doneTickets,
    repairs: { exclusion, parked: { get: (issueId) => parking.plans.get(issueId) } } });
  // The decision journal (README, "Decision journal"): every owner decision on a plan is written
  // here first and carried out by the bridge's worker; the inbox lists what is being applied.
  const decisionJournal = new DecisionJournal();
  decisionJournal.useExclusion(exclusion);
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
  const parents = new ParentStore();
  // The silent-agent watchdog's durable state (README, "Silent and stuck agents").
  const watchdogStore = new WatchdogStore();
  // Which host owns a ticket's automatic work, read only (SessionRouter.whileIdle, see
  // ticketOwnership): assigned once the activation routers exist below.
  let ticketOwner: (issueId: string) => Promise<HostOwnership> = async () => "unknown";
  const usage = new UsageReader();
  const sessions = new SessionRouter({ api: agentApi, linear, starter, handover, launcher, settings, store: sessionStore, parents, needsYou, route, deletions, watchdog: watchdogStore, replies,
    limitResumes: new LimitResumeStore(), usage,
    webhookCovered: () => coverage.coversAgentSessions(),
    owner: (issueId) => ticketOwner(issueId),
    parentResumeWait: (issueId) => steward ? steward.parentResumeWait(issueId) : Promise.resolve("Parent verification authority is unavailable"),
    recoveryWait: (issueId) => pullRequests.recoveryWait(issueId, issueId),
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
    } });
  const writeback = new Writeback(linear, settings, { sessions, handover }, undefined, undefined, needsYou);
  // The before-merge manual tasks of a ticket (manual-tasks.ts), read by the steward's facts.
  const manualTasks = new ManualTasks({ linear, settings });
  // The steward's pass runs inside the pull request watch's poll (see below); the watch is built
  // after it, so its readers are reached lazily, when the first pass runs.
  let steward: Steward | null = null;
  steward = new Steward({
    store: new StewardStore(),
    linear, sessions, starter, launcher, handover, writeback,
    watchdog: watchdogStore, manualTasks, needsYou, settings,
    // Which host owns a ticket's automatic work (activation-guard.ts ticketOwnership).
    owner: (issueId) => ticketOwner(issueId),
    // Cached PR facts for classification; completion separately checks the current,
    // full PR inventory across every attached, recorded and worktree repository.
    pulls: (urls) => pullRequests.pullStates(urls),
    completionPulls: (issueId, identifier, urls) => pullRequests.completionPulls(issueId, identifier, urls),
    // A successor start reads its open pull requests fresh, so a closed or landed one starts
    // nothing (pr-watch.ts freshOpenPulls).
    freshOpenPulls: (urls) => pullRequests.freshOpenPulls(urls),
    recoveryWait: (issueId, identifier, urls) => pullRequests.recoveryWait(issueId, identifier, urls),
    intake, doneTickets, labels: new RetiredLabels(), deletions, focus, planned: waitingPlans,
    // The responsibility check (README, "Responsibility check"), built below with the review stores.
    responsibility: { due: (now) => responsibility.due(now), holds: (issue) => responsibility.holds(issue), run: (input) => responsibility.run(input) },
  });
  const relay = new CommentRelay(linear, undefined, needsYou, route, replies, { covered: () => coverage.covers("Comment") });
  const dispatcher = new Dispatcher({ linear, starter, launcher, settings, route, relay, afterLaunch: openSession, handOff: (issueId, openChildren) => sessions.handOffGroup(issueId, openChildren), projects, steward, focus, parked: waitingPlans });
  // The owner's plan feedback and answers, for the weekly decision candidates (README, "Decision candidates").
  const decisions = new DecisionLog();
  writeback.recordDecisions(decisions);
  // The deputy for agent questions (README, "Deputy for agent questions"); off unless set otherwise.
  const deputyDirectory = DEPUTY_DIRECTORY();
  const deputy = new Deputy({
    settings, log: decisions, linear, sessions,
    ready: async () => {
      if (!attachedPaseo) throw new Error("No daemon connection for owner-question restoration.");
      replies.attach(attachedPaseo);
      await restoreOwnerHolds();
    },
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
    issues: () => linear.ownerAskIssues(true),
    needsYou,
    handover,
    remoteAgent: async (issueId) => (await settings.read()).activation.mode === "local" && Boolean(await intake.claimFor(issueId)),
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
    continueTicket: async (issueId, identifier, lead, decision) => {
      const result = await sessions.restartFor(issueId, identifier, { lead, decisionId: decision.id, intent: decision.intent, retryHint: "answer from the menu bar or assign Paseo again" });
      switch (result.kind) {
        case "started": return { kind: "started", agentId: result.agentId };
        case "failed": return { kind: "failed", reason: result.error.message };
        case "deferred": return { kind: "deferred", reason: result.reason };
        case "forwarded": return { kind: "forwarded", peer: result.peer };
        case "live": return { kind: "live" };
        case "skipped": return { kind: "skipped" };
      }
    },
    queueAnswer: async (issueId, identifier, text, from, reason) => { await sessions.queueAnswer(issueId, identifier, text, from, reason); },
  });
  // The wait line in Linear (README, "Wait line label"): tickets waiting here for an agent slot,
  // and queued threads waiting to start (their answer or comment included), carry `<trigger>-queued`.
  const queuedLabels = new QueuedLabels({
    linear,
    label: async () => dispatchLabels((await settings.read()).dispatch.label).queued,
    waiting: async () => {
      const threads = (await sessionStore.all()).filter((link) => link.queued && !link.agentId && !link.closed && !link.remote);
      return [...new Set([...starter.scheduler.waitingIds(), ...threads.map((link) => link.issueId)])];
    },
    admitted: () => starter.scheduler.admittedIds(),
  });
  const mergeStatus = new MergeStatus({
    linear, teamKeys: async () => (await settings.read()).dispatch.teamKeys,
    paseo: () => attachedPaseo, handover, parked: { all: () => parking.plans.all() }, sessions: sessionStore,
    waiting: () => starter.scheduler.waitingIds(),
    agentUrl: async (agentId) => {
      const serverId = await daemonServerId();
      return serverId ? paseoAgentUrl(serverId, agentId) : null;
    },
  });
  const browserDecisions = new BrowserDecisionInbox({
    ownerAsks,
    mergeStatus: async () => asCaller("merge-status", () => mergeStatus.feed()),
    paseo: () => attachedPaseo,
    replies,
    host: hostName,
    backendInstanceId: () => reviewLinks.seam?.instanceId,
    peers: async () => (await settings.read()).reviewPeers,
    canonicalPeer: async () => {
      const { activation } = await settings.read();
      return activation.mode === "remote" ? activation.peer : null;
    },
    agentUrl: async (agentId) => {
      const serverId = await daemonServerId();
      return serverId ? paseoAgentUrl(serverId, agentId) : null;
    },
    // The steward's flow summary for the page's Flow section (README, "Ticket steward").
    flow: async () => {
      const snapshot = await steward!.snapshot();
      return { at: snapshot.lastPassAt, counts: snapshot.counts, oldest: snapshot.oldest, error: snapshot.lastError, tickets: snapshot.tickets, control: snapshot.control };
    },
  });
  // The factory board (/board): this host's live facts, its peers' answers, and the two shared
  // sources, derived into one view (shared/board.ts, server/board.ts).
  const board = new BoardInbox({
    facts: () => collectBoardFacts({
      host: hostname().split(".")[0].toLowerCase(),
      home: join(paseoHome(), "linear-tickets"),
      paseo: () => attachedPaseo,
      maxRunning: async () => (await settings.read()).dispatch.maxRunning ?? null,
    }),
    peers: async () => (await settings.read()).reviewPeers,
    issues: () => boardIssues(linear, settings),
    pulls: (repos) => boardPulls(repos),
  });
  const activationRoutes = activationEndpoints({ settings, intake, drain, appUserId: () => linear.appUserId() });
  // Stable per-agent review links on the tailnet (:8444); tailnet-only, so no Linear app needed.
  // Its root is the review inbox, listing the peer hosts' reviews too (README, "Review inbox").
  // The checked backend listens on 127.0.0.1:47834 only; the persistent frontdoor
  // (inbox-frontdoor.ts, README "Inbox transport") owns 47832 and :8444 and reads the two private
  // routes the `inbox` seam adds (`decisions` plus this server's own inbox view), forwarding the
  // browser's mutations with the instance they were displayed from.
  const reviewLinks: ReviewLinks = new ReviewLinks({
    peers: async () => (await settings.read()).reviewPeers,
    inbox: { decisions: () => browserDecisions.view() },
    origin: () => tailnetOrigin(),
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
    routes: async (request) => await activationRoutes(request) ?? await browserDecisions.route(request) ?? await board.route(request),
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
  reviewLinks.useExclusion(exclusion);
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
  parking.plans.useExclusion(exclusion);
  const plannotator = new PlannotatorBridge(linear, settings, undefined, sessions, undefined, handover, undefined, reviewLinks, undefined, undefined, parking);
  plannotator.useJournal(decisionJournal);
  // Every ticket, every ten minutes, in the steward's pass: who is responsible for its next step,
  // and the one repair it makes, restoring a lost plan review (README, "Responsibility check").
  const responsibility = new ResponsibilityCheck({
    store: new ResponsibilityStore(hostName), reviews: reviewLinks, journal: decisionJournal, parked: parking.plans, deletions, exclusion,
    workspaceUrl: () => linear.workspaceUrl(),
  });
  plannotator.useDeletions(deletions);
  plannotator.observeDeliveryFailures((event, error, attempts) => pipeline.recordDeliveryError(event, error, attempts));
  plannotator.onProjectPlan(projects);
  plannotator.useFollowUps(followUps);
  plannotator.recordDecisions(decisions);
  plannotator.useSmallRoutes(smallRoutes);
  const watchdog: Watchdog = new Watchdog({ store: watchdogStore, sessions, linear, settings, handover, needsYou, manualTasks,
    // The exhausted cycle's terminal step is the steward's escalation (README, "Ticket steward").
    escalate: (issueId, identifier, reason) => steward!.escalateExhausted(issueId, identifier, reason) });
  // The ticket states crash recovery last saw, fed by every state the plugin writes (README, "Crashed agents").
  const knownStates = new KnownStates();
  linear.onStateWritten((issueId, state) => { void knownStates.observe(issueId, state, Date.now()); });
  // The ticket steward (README, "Ticket steward"): one level-triggered reconciler over every
  // in-scope open ticket of the dispatch teams. It runs at the end of every pull request poll (and
  // in the dispatch poll with the label-repair cadence); the watch that runs it is built first,
  // with a lazy reference to it, because the steward reads the watch's own state: the pull request
  // records it keeps, and its stack check. Built here so the project flow's start paths and the
  // dispatcher can reach it.
  const pullRequests: PullRequestWatch = new PullRequestWatch({ handover, sessions, linear, settings, manualTasks, watchdog, knownStates, outage: new GreptileOutage(linear, settings),
    // Which tickets this host's pull request watch may work on (README, "Several hosts"): the same
    // claims rule SessionRouter reads per ticket, once for a whole poll (activation-guard.ts).
    owner: ticketOwners({ settings, drain, intake }),
    // The steward's pass, at the end of every poll (steward.ts).
    steward: { pass: async () => {
      const current = steward, paseo = attachedPaseo;
      if (current && paseo) await loadProbe.time("steward", async () => current.tick(paseo, await settings.read()));
    }, stop: () => steward?.stop() } });
  const planRequests = new PlanRequests({ linear, prompt: (agentId, text) => sessions.prompt(agentId, text), routes: smallRoutes });
  let commentWake: NodeJS.Timeout | null = null;
  const wakeComments = () => {
    if (commentWake) return;
    commentWake = setTimeout(() => {
      commentWake = null;
      if (stopped || !attachedPaseo) return;
      void settings.read().then(async (value) => {
        if (value.writeback.mentions) await relay.poll(attachedPaseo!);
      }).catch((error: unknown) => console.error("[linear-tickets] comment webhook reconciliation failed:", error));
    }, 200);
    commentWake.unref?.();
  };
  const webhook = new AgentWebhookServer(
    async () => (await auth.credentials())?.webhookSecret ?? null,
    (event) => { coverage.noteAgentSession(); asCaller("session-webhook", () => sessions.receive(event)); },
    WEBHOOK_PORT,
    (event) => {
      if (event.type === "Issue") {
        // Deliveries can arrive out of order; read the current state instead of caching an old payload.
        stateLabels.issueChanged(event.data.id);
        if (event.action !== "update" || !event.updatedFrom
          || ["title", "description", "projectId", "parentId", "labelIds"].some((key) => key in event.updatedFrom!)) labelSync.issueChanged(event.data.id);
      } else if (event.type === "Comment") {
        const issue = event.data.issue;
        const id = typeof event.data.issueId === "string" ? event.data.issueId
          : issue && typeof issue === "object" && "id" in issue && typeof issue.id === "string" ? issue.id : null;
        if (id) { relay.issueChanged(id); wakeComments(); }
      } else if (event.type === "IssueLabel") labelSync.catalogChanged();
      else if (event.type === "Attachment") {
        if (typeof event.data.issueId === "string") labelSync.issueChanged(event.data.issueId);
      }
    },
  );
  // Each ticket workspace shows its ticket's Linear state as a workspace label ("Linear: In Review").
  const stateLabels = new StateLabels({ linear, covered: () => coverage.covers("Issue"), daemon: async () => { const client = await internalDaemon(); return client ? labelDaemon(client) : null; } });
  linear.onStateWritten((issueId, state) => stateLabels.noteState(issueId, state));
  // Label groups kept current on every issue of some teams ("Area", "Type"), from label-rules.json.
  const labelSync = new LabelSync({ linear, pullRequests: new PullRequestFiles(), covered: () => coverage.covers("Issue") && coverage.covers("IssueLabel") && coverage.covers("Attachment") });
  // The Paseo Agents menu bar's pull request view: polled only while the app asks (README, "Pull request view").
  const pullBoard = new PullRequestBoard();
  let funnel: FunnelStatus | null = null;
  let transportReady = false;
  const refreshCoverage = async () => {
    const app = await auth.credentials();
    if (!app || !funnel?.active || !funnel.url) {
      transportReady = false;
      coverage.setTransport(false);
      return;
    }
    const url = funnel.url;
    try {
      const response = await fetch(`http://127.0.0.1:${WEBHOOK_PORT}/`, { method: "POST", body: "{}", signal: AbortSignal.timeout(5_000) });
      if (response.status !== 401) throw new Error(`The local receiver answered HTTP ${response.status} instead of refusing an unsigned request.`);
      await coverage.refresh(url, app.webhookSecret).catch((error: unknown) => {
        console.error("[linear-tickets] workspace webhook coverage could not be verified; retaining fast reconciliation:", error);
      });
      coverage.setTransport(true);
      if (!transportReady) {
        sessions.reconcile();
        relay.recover();
        wakeComments();
        void stateLabels.recover();
        void labelSync.sync();
      }
      transportReady = true;
    } catch (error) {
      transportReady = false;
      coverage.setTransport(false);
      throw error;
    }
  };
  const health = new HealthMonitor(linear, settings, [
    { name: "Linear API key", run: () => linear.ping() },
    { name: "Paseo Linear app", run: async () => { if (await auth.credentials()) await agentApi.viewer(); } },
    { name: "Tailscale Funnel", run: async () => {
      if (!await auth.credentials()) return;
      funnel = await ensureFunnel(WEBHOOK_PORT);
      if (!funnel.active) throw new Error(funnel.note ?? "Funnel is off; Linear webhooks cannot reach this Mac.");
    } },
    { name: "Webhook receiver", run: refreshCoverage },
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
    asCaller("queued-labels", () => queuedLabels.start());
    if (!app) return false;
    stopKeepingFresh = auth.keepFresh();
    await webhook.start();
    funnel = await ensureFunnel(WEBHOOK_PORT);
    if (!funnel.active) console.error(`[linear-tickets] Linear agent webhooks are not public: ${funnel.note}`);
    await refreshCoverage();
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
  // (Plannotator restores its pre-planning model on approval), the cheap model on the cheap tier.
  const modelGuard = new ModelGuard(settings, modelSetter, async (change) => {
    const link = await sessions.sessionFor(change.agentId);
    if (link) await sessions.say(link.sessionId, "thought", change.tier === "cheap" ? `Switched to the ${change.tier} model tier: ${change.to} (was ${change.from}).` : `Model restored to ${change.to} (it had switched to ${change.from}).`);
  }, async (agent) => {
    const issueId = agent.labels["linear.issueId"];
    const label = agent.labels[TIER_AGENT_LABEL];
    return (issueId ? await tiers.forAgent(issueId, agent.id) : null) ?? readTier(label);
  });
  plannotator.useTiers({ store: tiers, apply: (agentId) => modelGuard.apply(agentId), replan: (agent, message) => planRequests.send(agent, message), tests: acceptanceTests });
  // The central Plannotator host starts once, after the hook it runs for each parked review exists.
  const startHost = async () => { if (await plannotatorHook() && !stopped) await plannotatorHost.start(); };
  let holdSeed: Promise<void> | null = null;
  let controlTimer: NodeJS.Timeout | undefined;
  let watchdogRun: Promise<void> | null = null;
  let stewardRun: Promise<void> | null = null;
  const controlTick = () => {
    if (stopped || !attachedPaseo) return;
    // Separate single flights: a slow PR inventory or a diagnostic admission cannot gate liveness.
    watchdogRun ??= asCaller("watchdog", () => loadProbe.time("watchdog", () => pullRequests.watchdogPass()))
      .catch((error: unknown) => console.error("[linear-tickets] watchdog control pass failed:", error))
      .finally(() => { watchdogRun = null; });
    stewardRun ??= asCaller("steward", () => loadProbe.time("steward", async () => steward!.tick(attachedPaseo!, await settings.read())))
      .catch((error: unknown) => console.error("[linear-tickets] steward control pass failed:", error))
      .finally(() => { stewardRun = null; });
  };
  const restoreOwnerHolds = (): Promise<void> => {
    if (!holdSeed) {
      const seed = sessions.seedHolds();
      holdSeed = seed;
      void seed.catch(() => { if (holdSeed === seed) holdSeed = null; });
    }
    return holdSeed;
  };
  let recoveredReplyEffects = false;
  // The load probe (README, "Diagnostics"): from the plugin's load until its unload, so the first
  // hooks are measured too, including those that arrive before any daemon connection.
  const probe = startLoadProbe();
  const attach = (paseo: PaseoApi) => {
    const first = !attached;
    attached = true;
    attachedPaseo = paseo;
    replies.attach(paseo);
    const ready = restoreOwnerHolds();
    void ready.then(() => {
      if (stopped) return;
      browserDecisions.start();
      if (!controlTimer) {
        controlTimer = setInterval(controlTick, 60_000);
        controlTimer.unref?.();
        controlTick();
      }
      asCaller("deputy", () => deputy.attach(paseo));
      asCaller("session-sweep", () => sessions.attach(paseo));
      if (!recoveredReplyEffects) asCaller("session-sweep", () => {
        recoveredReplyEffects = true;
        void replies.recoverEffects().catch((error: unknown) => console.error(`[linear-tickets] recovering permission reply effects failed: ${error instanceof Error ? error.message : error}`));
      });
    }).catch((error: unknown) => console.error(`[linear-tickets] restoring owner question holds failed: ${error instanceof Error ? error.message : error}`));
    if (!stopped) {
      // The checked backend and the inbox frontdoor's private credential before the listener: a
      // frontdoor that started first waits for the file rather than talking to an unauthenticated
      // backend. `ready` is only reported once the listener actually answers.
      asCaller("review-links", () => {
        void ensureBackendSecret().catch((error: unknown) => console.error(`[linear-tickets] creating the inbox backend credential failed: ${error instanceof Error ? error.message : error}`))
          .then(() => reviewLinks.start())
          .then(() => { if (reviewLinks.listeningPort !== null) reviewLinks.seam?.ready(); });
      });
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
    return ready;
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
  server.before("agent.session_open", sessionOpenGuard({ settings, drain, attach, ready: () => drain.readyNow(), known: (agentId) => sessionStore.agentTicket(agentId) }));
  server.on("agent.turn_started", (event, { paseo }) => { attach(paseo); return asCaller("writeback.turn-started", () => loadProbe.time("turn_started", () => writeback.turnStarted(event, paseo), "hook")); });
  server.on("agent.turn_ended", (event, { paseo }) => { attach(paseo); return asCaller("writeback.turn-ended", () => loadProbe.time("turn_ended", () => writeback.turnEnded(event, paseo), "hook")); });
  server.on("agent.permission_requested", (event, { paseo }) => { attach(paseo); return asCaller("writeback.permission-requested", () => writeback.permissionRequested(event, paseo)); });
  server.on("agent.permission_resolved", (event, { paseo }) => asCaller("writeback.permission-resolved", () => writeback.permissionResolved(event, paseo)));
  server.on("agent.archived", (event, { paseo }) => asCaller("writeback.archived", () => writeback.archived(event, paseo)));
  server.on("agent.created", (_event, { paseo }) => { attach(paseo); asCaller("state-labels", () => stateLabels.soon()); wakeComments(); });
  server.on("workspace.created", (_event, { paseo }) => { attach(paseo); asCaller("state-labels", () => stateLabels.soon()); wakeComments(); });
  server.before("agent.session_open", sessionPrepare({ attach, plannotator: plannotatorHook, envs: agentEnvs }));
  server.handle(statusRpc, (_input, { paseo }) => { attach(paseo); return linear.status(); });
  server.handle(dispatchStatusRpc, async (_input, { paseo }) => {
    attach(paseo);
    // The steward's flow summary rides the dispatch status (README, "Ticket steward"); a failure to
    // read it is named here instead of hiding the dispatch state.
    const status = await dispatcher.snapshot();
    try {
      const snapshot = await steward!.snapshot();
      return { ...status, steward: { enabled: snapshot.enabled, lastPassAt: snapshot.lastPassAt, lastError: snapshot.lastError, counts: snapshot.counts, oldest: snapshot.oldest, control: snapshot.control } };
    } catch (error) {
      return { ...status, steward: { enabled: false, lastPassAt: null, lastError: `the steward's state could not be read: ${error instanceof Error ? error.message : error}`, counts: {}, oldest: [], control: null } };
    }
  });
  server.handle(parentsStatusRpc, async () => ({ parents: await parents.all() }));
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
    return { maxRunning, ...starter.capacity.limit(maxRunning), ...await starter.scheduler.observedCounts(paseo) };
  };
  server.handle(capacityRpc, (_input, { paseo }) => loadProbe.time("capacity", () => capacityState(paseo), "hook"));
  server.handle(setCapacityRpc, ({ lease }, { paseo }) => loadProbe.time("capacity.set", () => {
    starter.capacity.set(lease);
    return capacityState(paseo);
  }, "hook"));
  server.handle(pullRequestsRpc, ({ repository }) => pullBoard.read(repository));
  server.handle(labelPullsRpc, ({ repository, label, numbers }) => pullBoard.label(repository, label, numbers));
  // The owner's asks (README, "Owner asks"): read from cache at once (never waiting for the
  // model), answered through the same paths an "@paseo" reply takes.
  server.handle(ownerAsksRpc, async (_input, { paseo }) => { attach(paseo); return ownerAsksPage(await ownerAsks.snapshot(paseo)); });
  server.handle(mergeStatusRpc, async (_input, { paseo }) => { attach(paseo); return asCaller("merge-status", () => mergeStatus.snapshot()); });
  server.handle(answerAskRpc, async (input, { paseo }) => { attach(paseo); return asCaller("owner-asks", () => ownerAsks.answer(input, paseo)); });
  server.handle(triageAskRpc, async (input, { paseo }) => { attach(paseo); return asCaller("owner-asks", () => ownerAsks.triage(input, paseo)); });
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
      deputy: { ...saved.deputy, recallConfigured: Boolean(await recallAccess(deputyDirectory).catch(() => null)), live: { ready: !blockers.length, blockers, standingPolicyReady: saved.deputy.standingPolicy !== null && !(await deputy.liveBlockers(saved, true)).length } },
      builtin: DEFAULT_PROMPT_TEMPLATE,
    };
  };
  server.handle(getSettingsRpc, async () => settingsView(await settings.read()));
  server.handle(deputyStatusRpc, (input) => deputy.status(input));
  server.handle(reconcileDeputyRpc, async (_input, { paseo }) => {
    await attach(paseo);
    return deputy.reconcile();
  });
  server.handle(setSettingsRpc, async (input, { paseo }) => {
    const saved = await settings.patch(input);
    const ready = attach(paseo);
    if (input.dispatch) dispatcher.wake();
    const policyChanged = input.deputy !== undefined || input.template !== undefined;
    const revoked = policyChanged ? await deputy.settingsChanged() : [];
    if (input.deputy?.standingPolicy !== undefined) {
      // An explicit host-owner settings write, not an inferred model/identity
      // claim. Dispatch requires both this audit and the revision-bound setting.
      await decisions.append({ kind: "deputy-activation", id: `settings:${randomUUID()}`, key: randomUUID(), at: new Date().toISOString(), policy: saved.deputy.standingPolicy, via: "settings-rpc", mode: saved.deputy.mode });
    }
    if (policyChanged) {
      await ready;
      await deputy.recheckPolicy(revoked, Boolean(input.deputy?.standingPolicy));
    }
    return settingsView(saved);
  });
  server.handle(launchAgentRpc, async (input, { paseo }) => {
    const current = await settings.read();
    // The sidebar starts an agent here and now; a draining host starts none, so it refuses
    // instead of forwarding a launch whose workspace the owner picked on this host.
    if (current.activation.mode === "remote") throw new Error(`This host forwards new Linear work to ${current.activation.peer ?? "the peer host"}; the agent starts there. Assign Paseo or add the trigger label on the ticket.`);
    const { template, agentLinearAccess } = current;
    const setup = await planSetup(linear, input.id, input.provider, input.modeId, { tiers, routes: smallRoutes, settings: current });
    const model = tierModel(current, input.provider.split("/")[0], setup.tier?.tier ?? null, { provider: input.provider, ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}) });
    const launch = { ...input, ...model, modeId: setup.modeId, instructions: [...setup.notes, QUESTIONS_NOTE, input.instructions.trim()].filter(Boolean).join("\n\n") };
    const markInProgress = input.markInProgress && setup.policy !== "required";
    // The owner's own start ends any steward incident of the ticket first (README, "Ticket
    // steward"), so a failure of it is a new round with fresh retries.
    await steward!.ownerRetried(input.id);
    const result = await launcher.start(launch, paseo, { promptTemplate: template ?? undefined, markInProgress, linearAccess: agentLinearAccess, labels: setup.labels, env: setup.env });
    await recordStart(tiers, { id: input.id, identifier: setup.identifier }, setup.tier, result.agentId, model.provider);
    // Like every other start path (starter.ts): the approved plan's acceptance tests are protected
    // for the agent that implements them.
    if (setup.tests.length) {
      await acceptanceTests.save(result.agentId, { identifier: setup.identifier, paths: setup.tests })
        .catch((error: unknown) => console.error(`[linear-tickets] ${setup.identifier}: saving the plan's acceptance tests failed: ${error instanceof Error ? error.message : error}`));
    }
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
    clearTimeout(commentWake ?? undefined);
    coverage.setTransport(false);
    clearInterval(controlTimer);
    watchdog.stop();
    steward?.stop();
    // No new effect or repair is admitted from here on; the admitted ones finish before the
    // bridge releases the decision journal's lease (below).
    exclusion.closeAdmission();
    // The checked inbox backend stops admitting before anything it uses closes: a mutation the
    // frontdoor forwards from here on is refused, never rebound to the replacement plugin.
    reviewLinks.seam?.draining();
    browserDecisions.stop();
    // The bridge stops admitting decisions and lets every admitted one finish (each call is
    // bounded) before anything it uses closes; only then does the journal's lease move on.
    await exclusion.drain();
    await plannotator.stop();
    await replies.stop();
    clearTimeout(startSoon);
    clearInterval(usageTimer);
    probe.stop();
    planningSmoke.stop();
    stopKeepingFresh();
    void own?.close();
    dispatcher.stop(); plannotatorHost.stop(); sessions.stop();
    webhook.stop(); reviewLinks.stop(); pipeline.stop(); health.stop();
    const stoppedPullRequests = pullRequests.stop();
    pullBoard.stop(); manualTasks.stop(); modelGuard.stop(); planRequests.stop();
    stateLabels.stop(); labelSync.stop(); drain.stop(); intake.stop(); deputy.stop();
    ownerAsks.stop(); queuedLabels.stop();
    void closeInternalDaemon();
    await stoppedPullRequests;
    await Promise.allSettled([watchdogRun, stewardRun]);
    await brokerReady;
    await broker.stop();
    await linearUsage.stop();
    githubUsage.stop();
    // Last: every waiting child process call above is finished. The children the helper started
    // keep running, as they did when the plugin exited (README, "Plugin child processes").
    stopChildProcessHelper();
  };
}
