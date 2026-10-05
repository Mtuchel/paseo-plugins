import type { PaseoApi, PaseoClient } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { branchesRpc, cachedOverviewRpc, capacityRpc, connectRpc, countIssuesRpc, dispatchStatusRpc, agentStatusRpc, getSettingsRpc, issueContextRpc, disconnectRpc, getDefaultPromptRpc, labelPullsRpc, listIssuesRpc, launchAgentRpc, planProjectRpc, presenceRpc, projectsStatusRpc, pullRequestsRpc, searchIssuesRpc, setCapacityRpc, setDefaultPromptRpc, setPresenceRpc, setSettingsRpc, statusRpc, type CapacityState } from "./shared/contracts";
import { projectBranches } from "./server/projects";
import { LinearService } from "./server/linear";
import { Launcher } from "./server/launch";
import { Settings } from "./server/settings";
import { DEFAULT_PROMPT_TEMPLATE } from "./shared/contracts";
import { cacheScope, TicketCache } from "./server/cache";
import { Credentials } from "./server/credentials";
import { Dispatcher, dispatchLabels } from "./server/dispatch";
import { CommentRelay } from "./server/relay";
import { recordPluginComment } from "./server/agent-records";
import { paseoHome } from "./server/ticket-mcp";
import { join } from "node:path";
import { PlannotatorBridge, readReviewPlan, recordDecision, writeOpenScript } from "./server/plannotator";
import { ParkedPlans, PlannotatorHost } from "./server/parked";
import { reviewOutcome } from "./server/review-outcome";
import { Writeback } from "./server/writeback";
import { DecisionLog } from "./server/owner-decisions";
import { AgentApi, AppAuth } from "./server/agent-app";
import { AgentWebhookServer, WEBHOOK_PORT } from "./server/agent-webhook";
import { ensureFunnel, type FunnelStatus } from "./server/funnel";
import { ReviewLinks } from "./server/review-links";
import { closeInternalDaemon, internalDaemon, modelSetter, ownConnection } from "./server/connection";
import { ModelGuard } from "./server/model-guard";
import { recordStart, TIER_AGENT_LABEL, tierModel, TierStore } from "./server/model-tiers";
import { isTier } from "./shared/plan-model";
import { HealthMonitor } from "./server/health";
import { PullRequestWatch } from "./server/pr-watch";
import { PullRequestBoard } from "./server/pull-requests";
import { ManualTasks } from "./server/manual-tasks";
import { Handover } from "./server/handover";
import { NeedsYouIssues } from "./server/needs-you";
import { daemonServerId, decidePlannotatorReview, paseoAgentUrl, SessionRouter, SessionStore, stopAgentTurn } from "./server/sessions";
import { approveForLater, splitIntoSubIssues } from "./server/split";
import { planSetup, TicketStarter } from "./server/starter";
import { PLAN_TICKET_ENV } from "./server/plan-policy";
import { AgentEnvs, sessionEnv } from "./server/agent-env";
import { PlanRequests } from "./server/plan-requests";
import { PlanFollowUps } from "./server/plan-follow-ups";
import { labelDaemon, StateLabels } from "./server/state-labels";
import { LabelSync, PullRequestFiles } from "./server/label-sync";
import { ProjectFlow } from "./server/project-flow";
import { Presence } from "./server/presence";

export default function contribute(server: PluginServerContext) {
  const credentials = new Credentials();
  // The native Linear agent ("Paseo" app): sessions, webhooks through Tailscale Funnel, and the
  // handover record every agent keeps on its ticket. Without the app installed, only the
  // handover comments and the comment-based paths run. Its token also serves the reads pollers
  // repeat, so they use the app's request pool instead of the owner's key.
  const auth = new AppAuth();
  const agentApi = new AgentApi(auth);
  const linear = new LinearService(credentials, undefined, agentApi);
  linear.onOwnerComment = (commentId, issueId) => recordPluginComment(join(paseoHome(), "linear-tickets"), commentId, issueId);
  // Each ticket agent's launch environment, given back to its resumed sessions (agent-env.ts).
  const agentEnvs = new AgentEnvs();
  const launcher = new Launcher(linear, undefined, undefined, (url) => linear.downloadUpload(url), undefined, undefined, agentEnvs);
  const settings = new Settings();
  const cache = new TicketCache();
  const handover = new Handover(linear, undefined, undefined, undefined, async (agentId) => { const serverId = await daemonServerId(); return serverId ? paseoAgentUrl(serverId, agentId) : null; });
  // Present or away (README, "Present and away"): every start path asks the starter's scheduler.
  const presence = new Presence();
  // Model tiers (README, "Model tiers"): the tier each ticket implements on.
  const tiers = new TierStore();
  const starter = new TicketStarter({ linear, launcher, handover, presence, tiers });
  // The plugin itself closes the review (split, implement later): the extension's report of that
  // closing is not the owner's decision, so the bridge skips it.
  const retirePlanner = async (reviewUrl: string, agentId: string, api: PaseoApi, reason: string) => {
    plannotator.settled(agentId);
    await decidePlannotatorReview(reviewUrl, false, reason);
    await stopAgentTurn(agentId).catch(() => {});
    await api.agents.ref(agentId).archive().catch(() => {});
  };
  // Every approval path files the approved plan's follow-ups (README, "Plan follow-ups").
  const followUps = new PlanFollowUps(linear);
  // Waits on tickets already closed live in "Needs you" sub-issues; replies there (a relayed
  // comment or an @mention of the app) go to the agent that asked.
  const needsYou = new NeedsYouIssues();
  // The owner's Approve / Send back from the Linear panel or the review inbox: as on the review page.
  const decideReview = async (localUrl: string, approve: boolean, feedback: string, agentId: string) => {
    const planContent = await readReviewPlan(localUrl).catch(() => "");
    await decidePlannotatorReview(localUrl, approve, feedback);
    await recordDecision({ type: "decided", agentId, approved: approve, ...(feedback ? { feedback } : {}), planContent, at: new Date().toISOString() });
  };
  const sessions = new SessionRouter({ api: agentApi, linear, starter, handover, launcher, settings, store: new SessionStore(), needsYou,
    decideReview,
    reviewOutcome: (review) => reviewOutcome(review),
    recordOutcome: (agentId, outcome) => recordDecision({ type: "decided", agentId, ...outcome, at: new Date().toISOString() }),
    splitPlan: (link, localUrl, paseo) => splitIntoSubIssues({ linear, appUserId: async () => (await agentApi.viewer()).id, readPlan: readReviewPlan, retirePlanner, followUps }, link, localUrl, paseo),
    approveLater: (link, localUrl, paseo) => approveForLater({ linear, readPlan: readReviewPlan, retirePlanner, followUps }, link, localUrl, paseo),
    // `paseo agent reload` for crashed agents (README, "Crashed agents"); the plugin SDK has no reload.
    reloader: async () => {
      const client = await internalDaemon();
      return client ? async (agentId) => { await client.refreshAgent(agentId); } : null;
    },
  });
  const openSession = async (issueId: string, identifier: string, agentId: string) => Boolean(await auth.credentials() && await sessions.openFor(issueId, identifier, agentId));
  // Labelled projects: a planner ticket sets the work order, then tickets are handed out as slots free up.
  // A planner without a live agent, and a ticket assigned to Paseo whose start failed, is started
  // again with a new agent and thread (README, "Projects").
  const projects = new ProjectFlow({ linear, scheduler: starter.scheduler, capacity: starter.capacity, retire: async (agentId, api) => {
    await stopAgentTurn(agentId).catch(() => {});
    await api.agents.ref(agentId).archive().catch(() => {});
  }, restart: (issueId, identifier) => sessions.restartFor(issueId, identifier), accountedFor: async (issueId) => launcher.underWay(issueId) || await sessions.threadHolds(issueId) });
  const dispatcher = new Dispatcher({ linear, starter, launcher, settings, relay: new CommentRelay(linear, undefined, needsYou), afterLaunch: openSession, handOff: (issueId) => sessions.handOffGroup(issueId), projects });
  const writeback = new Writeback(linear, settings, { sessions, handover }, undefined, undefined, needsYou);
  // The owner's plan feedback and answers, for the weekly decision candidates (README, "Decision candidates").
  const decisions = new DecisionLog();
  writeback.recordDecisions(decisions);
  // Stable per-agent review links on the tailnet (:8444); tailnet-only, so no Linear app needed.
  // Its root is the review inbox, listing the peer hosts' reviews too (README, "Review inbox").
  const reviewLinks = new ReviewLinks({
    peers: async () => (await settings.read()).reviewPeers,
    decide: decideReview,
    linearWorkspace: () => linear.workspaceUrl(),
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
  plannotator.onProjectPlan(projects);
  plannotator.useFollowUps(followUps);
  plannotator.recordDecisions(decisions);
  const manualTasks = new ManualTasks({ linear, settings });
  const pullRequests = new PullRequestWatch({ handover, sessions, linear, settings, manualTasks });
  const planRequests = new PlanRequests({ linear, prompt: (agentId, text) => sessions.prompt(agentId, text) });
  const webhook = new AgentWebhookServer(async () => (await auth.credentials())?.webhookSecret ?? null, (event) => sessions.receive(event));
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
    health.start();
    pullRequests.start();
    manualTasks.start();
    stateLabels.start();
    labelSync.start();
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
  const attach = (paseo: PaseoApi) => { const first = !attached; attached = true; if (!stopped) { void reviewLinks.start(); if (first) void startHost(); } dispatcher.attach(paseo); plannotator.attach(paseo); sessions.attach(paseo); modelGuard.attach(paseo); planRequests.attach(paseo); void startAgent(); };
  const cacheIdentity = async () => {
    const connection = await credentials.read();
    return connection.key ? cacheScope(connection.key) : null;
  };
  // The daemon connection is only handed to handlers and hooks; the first one starts the
  // dispatcher and the Plannotator bridge: opening the ticket surface, or any agent or workspace activity on this host
  // (resumed agents open their sessions right after a daemon restart).
  server.on("agent.turn_started", (event, { paseo }) => { attach(paseo); return writeback.turnStarted(event, paseo); });
  server.on("agent.turn_ended", (event, { paseo }) => { attach(paseo); return writeback.turnEnded(event, paseo); });
  server.on("agent.permission_requested", (event, { paseo }) => { attach(paseo); return writeback.permissionRequested(event, paseo); });
  server.on("agent.permission_resolved", (event, { paseo }) => writeback.permissionResolved(event, paseo));
  server.on("agent.archived", (event, { paseo }) => writeback.archived(event, paseo));
  server.on("agent.created", (_event, { paseo }) => { attach(paseo); stateLabels.soon(); });
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
  server.handle(planProjectRpc, async ({ projectId }, { paseo }) => { attach(paseo); return projects.planNow(projectId, await settings.read()); });
  server.handle(presenceRpc, () => presence.state());
  server.handle(setPresenceRpc, (change) => presence.update(change));
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
  server.handle(connectRpc, ({ apiKey }) => linear.authenticate(apiKey));
  server.handle(disconnectRpc, () => linear.disconnect());
  server.handle(listIssuesRpc, async ({ cursor, stateNames, relation }) => {
    const showClosed = (await settings.read()).showClosed;
    const page = await linear.issues(cursor, stateNames, showClosed, relation);
    if (!cursor && !stateNames?.length && !relation) {
      const scope = await cacheIdentity();
      if (scope) await cache.saveIssues(scope, showClosed, page);
    }
    return page;
  });
  server.handle(countIssuesRpc, async () => {
    const showClosed = (await settings.read()).showClosed;
    const counts = await linear.countIssues(showClosed);
    const scope = await cacheIdentity();
    if (scope) await cache.saveCounts(scope, showClosed, counts);
    return counts;
  });
  server.handle(cachedOverviewRpc, async () => {
    const scope = await cacheIdentity();
    return scope ? cache.read(scope, (await settings.read()).showClosed) : null;
  });
  server.handle(searchIssuesRpc, ({ term, cursor }) => linear.searchIssues(term, cursor));
  server.handle(issueContextRpc, ({ id }) => linear.detail(id));
  server.handle(branchesRpc, ({ projectId }, { paseo }) => projectBranches(paseo, projectId));
  server.handle(getDefaultPromptRpc, async () => ({ template: (await settings.read()).template, builtin: DEFAULT_PROMPT_TEMPLATE }));
  server.handle(setDefaultPromptRpc, ({ template }) => settings.save(template).then((saved) => ({ ...saved, builtin: DEFAULT_PROMPT_TEMPLATE })));
  server.handle(getSettingsRpc, async () => ({ ...(await settings.read()), builtin: DEFAULT_PROMPT_TEMPLATE }));
  server.handle(setSettingsRpc, async (input, { paseo }) => {
    const saved = await settings.patch(input);
    attach(paseo);
    if (input.dispatch) dispatcher.wake();
    return { ...saved, builtin: DEFAULT_PROMPT_TEMPLATE };
  });
  server.handle(launchAgentRpc, async (input, { paseo }) => {
    const current = await settings.read();
    const { template, agentLinearAccess, dispatch } = current;
    const setup = await planSetup(linear, input.id, input.provider, input.modeId, dispatchLabels(dispatch.label).planner, tiers);
    const model = tierModel(current, input.provider.split("/")[0], setup.tier?.tier ?? null, { provider: input.provider, ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}) });
    const launch = { ...input, ...model, modeId: setup.modeId, instructions: [...setup.notes, input.instructions.trim()].filter(Boolean).join("\n\n") };
    const markInProgress = input.markInProgress && setup.policy !== "required";
    const result = await launcher.start(launch, paseo, { promptTemplate: template ?? undefined, markInProgress, linearAccess: agentLinearAccess, labels: setup.labels, env: setup.env });
    await recordStart(tiers, { id: input.id, identifier: setup.identifier }, setup.tier, result.agentId, model.provider);
    await openSession(input.id, input.id, result.agentId);
    return result;
  });
  server.handle(agentStatusRpc, async (_input, { paseo }) => {
    attach(paseo);
    const installed = await startAgent();
    return { installed, funnel: funnel?.active ?? false, funnelNote: funnel?.note ?? null, lastWebhookAt: webhook.lastEventAt, webhooks: webhook.events, ...sessions.readStats() };
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
  return () => { stopped = true; clearTimeout(startSoon); stopKeepingFresh(); void own?.close(); dispatcher.stop(); plannotator.stop(); plannotatorHost.stop(); sessions.stop(); webhook.stop(); reviewLinks.stop(); health.stop(); pullRequests.stop(); pullBoard.stop(); manualTasks.stop(); modelGuard.stop(); planRequests.stop(); stateLabels.stop(); labelSync.stop(); void closeInternalDaemon(); };
}
