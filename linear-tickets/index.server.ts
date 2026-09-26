import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { branchesRpc, cachedOverviewRpc, connectRpc, countIssuesRpc, dispatchStatusRpc, agentStatusRpc, getSettingsRpc, issueContextRpc, disconnectRpc, getDefaultPromptRpc, listIssuesRpc, launchAgentRpc, searchIssuesRpc, setDefaultPromptRpc, setSettingsRpc, statusRpc } from "./shared/contracts";
import { projectBranches } from "./server/projects";
import { LinearService } from "./server/linear";
import { Launcher } from "./server/launch";
import { Settings } from "./server/settings";
import { DEFAULT_PROMPT_TEMPLATE } from "./shared/contracts";
import { cacheScope, TicketCache } from "./server/cache";
import { Credentials } from "./server/credentials";
import { Dispatcher } from "./server/dispatch";
import { CommentRelay } from "./server/relay";
import { PlannotatorBridge, readReviewPlan, recordDecision, writeOpenScript } from "./server/plannotator";
import { Writeback } from "./server/writeback";
import { AgentApi, AppAuth } from "./server/agent-app";
import { AgentWebhookServer, WEBHOOK_PORT } from "./server/agent-webhook";
import { ensureFunnel, type FunnelStatus } from "./server/funnel";
import { HealthMonitor } from "./server/health";
import { PullRequestWatch } from "./server/pr-watch";
import { Handover } from "./server/handover";
import { decidePlannotatorReview, SessionRouter, SessionStore, stopAgentTurn } from "./server/sessions";
import { splitIntoSubIssues } from "./server/split";
import { TicketStarter } from "./server/starter";

export default function contribute(server: PluginServerContext) {
  const credentials = new Credentials();
  const linear = new LinearService(credentials);
  const launcher = new Launcher(linear, undefined, undefined, (url) => linear.downloadUpload(url));
  const settings = new Settings();
  const cache = new TicketCache();
  // The native Linear agent ("Paseo" app): sessions, webhooks through Tailscale Funnel, and the
  // handover record every agent keeps on its ticket. Without the app installed, only the
  // handover comments and the comment-based paths run.
  const auth = new AppAuth();
  const handover = new Handover(linear);
  const starter = new TicketStarter({ linear, launcher, handover });
  const agentApi = new AgentApi(auth);
  const sessions = new SessionRouter({ api: agentApi, linear, starter, settings, store: new SessionStore(),
    decideReview: async (localUrl, approve, feedback, agentId) => {
      const planContent = await readReviewPlan(localUrl).catch(() => "");
      await decidePlannotatorReview(localUrl, approve, feedback);
      await recordDecision({ type: "decided", agentId, approved: approve, ...(feedback ? { feedback } : {}), planContent, at: new Date().toISOString() });
    },
    splitPlan: (link, localUrl, paseo) => splitIntoSubIssues({
      linear,
      appUserId: async () => (await agentApi.viewer()).id,
      readPlan: readReviewPlan,
      retirePlanner: async (reviewUrl, agentId, api) => {
        await decidePlannotatorReview(reviewUrl, false, "The owner split this plan into Linear sub-issues, each handled by its own agent. Stop now and do not implement anything.");
        await stopAgentTurn(agentId).catch(() => {});
        await api.agents.ref(agentId).archive().catch(() => {});
      },
    }, link, localUrl, paseo),
  });
  const openSession = async (issueId: string, identifier: string, agentId: string) => Boolean(await auth.credentials() && await sessions.openFor(issueId, identifier, agentId));
  const dispatcher = new Dispatcher({ linear, starter, settings, relay: new CommentRelay(linear), afterLaunch: openSession });
  const writeback = new Writeback(linear, settings, { sessions, handover });
  const plannotator = new PlannotatorBridge(linear, settings, undefined, sessions, undefined, handover);
  const pullRequests = new PullRequestWatch({ handover, sessions, linear, settings });
  const webhook = new AgentWebhookServer(async () => (await auth.credentials())?.webhookSecret ?? null, (event) => sessions.receive(event));
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
  // Started with the first daemon connection, not at load, so loading has no side effects.
  let agentReady: Promise<boolean> | null = null;
  const startAgent = () => agentReady ??= auth.credentials().then(async (app) => {
    health.start();
    pullRequests.start();
    if (!app) return false;
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
  const attach = (paseo: PaseoApi) => { dispatcher.attach(paseo); plannotator.attach(paseo); sessions.attach(paseo); void startAgent(); };
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
  server.on("agent.created", (_event, { paseo }) => attach(paseo));
  server.on("workspace.created", (_event, { paseo }) => attach(paseo));
  server.before("agent.session_open", async ({ request }, { paseo }) => {
    attach(paseo);
    const browser = await plannotatorHook();
    return browser ? { ...request, env: { ...request.env, PLANNOTATOR_BROWSER: browser } } : undefined;
  });
  server.handle(statusRpc, (_input, { paseo }) => { attach(paseo); return linear.status(); });
  server.handle(dispatchStatusRpc, (_input, { paseo }) => { attach(paseo); return dispatcher.snapshot(); });
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
    const { template, agentLinearAccess } = await settings.read();
    const result = await launcher.start(input, paseo, { promptTemplate: template ?? undefined, markInProgress: input.markInProgress, linearAccess: agentLinearAccess });
    await openSession(input.id, input.id, result.agentId);
    return result;
  });
  server.handle(agentStatusRpc, async (_input, { paseo }) => {
    attach(paseo);
    const installed = await startAgent();
    return { installed, funnel: funnel?.active ?? false, funnelNote: funnel?.note ?? null, lastWebhookAt: webhook.lastEventAt };
  });
  return () => { dispatcher.stop(); plannotator.stop(); sessions.stop(); webhook.stop(); health.stop(); pullRequests.stop(); };
}
