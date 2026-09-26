import type { PluginServerContext } from "@getpaseo/plugin/server";
import { branchesRpc, cachedOverviewRpc, connectRpc, countIssuesRpc, dispatchStatusRpc, getSettingsRpc, issueContextRpc, disconnectRpc, getDefaultPromptRpc, listIssuesRpc, launchAgentRpc, searchIssuesRpc, setDefaultPromptRpc, setSettingsRpc, statusRpc } from "./shared/contracts";
import { projectBranches } from "./server/projects";
import { LinearService } from "./server/linear";
import { Launcher } from "./server/launch";
import { Settings } from "./server/settings";
import { DEFAULT_PROMPT_TEMPLATE } from "./shared/contracts";
import { cacheScope, TicketCache } from "./server/cache";
import { Credentials } from "./server/credentials";
import { Dispatcher } from "./server/dispatch";
import { Writeback } from "./server/writeback";

export default function contribute(server: PluginServerContext) {
  const credentials = new Credentials();
  const linear = new LinearService(credentials);
  const launcher = new Launcher(linear);
  const settings = new Settings();
  const cache = new TicketCache();
  const dispatcher = new Dispatcher({ linear, launcher, settings });
  const writeback = new Writeback(linear, settings);
  const cacheIdentity = async () => {
    const connection = await credentials.read();
    return connection.key ? cacheScope(connection.key) : null;
  };
  // The daemon connection is only handed to handlers and hooks; the first one starts the
  // dispatcher: opening the ticket surface, or any agent or workspace activity on this host
  // (resumed agents open their sessions right after a daemon restart).
  server.on("agent.turn_started", (event, { paseo }) => { dispatcher.attach(paseo); return writeback.turnStarted(event, paseo); });
  server.on("agent.turn_ended", (event, { paseo }) => { dispatcher.attach(paseo); return writeback.turnEnded(event, paseo); });
  server.on("agent.permission_requested", (event, { paseo }) => writeback.permissionRequested(event, paseo));
  server.on("agent.permission_resolved", (event, { paseo }) => writeback.permissionResolved(event, paseo));
  server.on("agent.archived", (event, { paseo }) => writeback.archived(event, paseo));
  server.on("agent.created", (_event, { paseo }) => dispatcher.attach(paseo));
  server.on("workspace.created", (_event, { paseo }) => dispatcher.attach(paseo));
  server.before("agent.session_open", (_input, { paseo }) => { dispatcher.attach(paseo); });
  server.handle(statusRpc, (_input, { paseo }) => { dispatcher.attach(paseo); return linear.status(); });
  server.handle(dispatchStatusRpc, (_input, { paseo }) => { dispatcher.attach(paseo); return dispatcher.snapshot(); });
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
    dispatcher.attach(paseo);
    if (input.dispatch) dispatcher.wake();
    return { ...saved, builtin: DEFAULT_PROMPT_TEMPLATE };
  });
  server.handle(launchAgentRpc, async (input, { paseo }) => {
    const { template, agentLinearAccess } = await settings.read();
    return launcher.start(input, paseo, { promptTemplate: template ?? undefined, markInProgress: input.markInProgress, linearAccess: agentLinearAccess });
  });
  return () => { dispatcher.stop(); };
}
