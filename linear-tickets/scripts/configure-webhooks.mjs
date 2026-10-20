import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Run once on each host after deploying its resource receiver. Never edits another integration's
// subscriptions, rotates credentials, or requests broader OAuth permissions.
const url = new URL(process.argv[2] ?? "");
if (url.protocol !== "https:") throw new Error("Provide this host's HTTPS Linear webhook URL.");
const home = process.env.PASEO_HOME?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo");
const directory = join(home, "linear-tickets");
const app = JSON.parse(await readFile(join(directory, "agent-app", "app.json"), "utf8"));
const key = process.env.LINEAR_API_KEY?.trim() || JSON.parse(await readFile(join(directory, "credentials.json"), "utf8")).apiKey;
if (!key || !app.webhookSecret || !app.clientId) throw new Error("This host needs its installed Linear app and workspace-admin API key.");
const resources = ["Issue", "Comment", "IssueLabel", "Attachment"];
const label = `Paseo reconciliation (${app.clientId})`;
async function request(query, variables = {}) {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST", headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`Linear webhook configuration refused: ${body.errors?.map((error) => error.message).join("; ") || response.status}`);
  return body.data;
}
async function pages(field, query) {
  const nodes = [];
  let after = null;
  do {
    const page = (await request(query, { after }))[field];
    nodes.push(...page.nodes);
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) throw new Error(`Incomplete ${field} page; no subscriptions changed.`);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}
const hooks = await pages("webhooks", `query reconciliationSetupHooks($after: String) {
  webhooks(first: 50, after: $after) { nodes { id label url enabled secret resourceTypes allPublicTeams teamIds team { id } } pageInfo { hasNextPage endCursor } }
}`);
const teams = await pages("teams", `query reconciliationSetupTeams($after: String) {
  teams(first: 100, after: $after) { nodes { id private } pageInfo { hasNextPage endCursor } }
}`);
const scopes = [{ allPublicTeams: true }, ...teams.filter((team) => team.private).map((team) => ({ teamId: team.id }))];
for (const scope of scopes) {
  const owned = hooks.find((hook) => hook.label === label && hook.url === url.href
    && (scope.allPublicTeams ? hook.allPublicTeams : hook.teamIds?.includes(scope.teamId) || hook.team?.id === scope.teamId));
  if (owned) {
    if (owned.enabled && owned.secret === app.webhookSecret && resources.every((type) => owned.resourceTypes.includes(type))) {
      console.log(`Already configured ${owned.id} (${scope.teamId ?? "public teams"}).`);
      continue;
    }
    const data = await request(`mutation reconciliationUpdateHook($id: String!, $input: WebhookUpdateInput!) { webhookUpdate(id: $id, input: $input) { success } }`, {
      id: owned.id, input: { enabled: true, secret: app.webhookSecret, resourceTypes: [...new Set([...owned.resourceTypes, ...resources])] },
    });
    if (!data.webhookUpdate.success) throw new Error(`Linear refused to update ${owned.id}.`);
    console.log(`Updated ${owned.id} (${scope.teamId ?? "public teams"}).`);
  } else {
    const data = await request(`mutation reconciliationCreateHook($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id } } }`, {
      input: { ...scope, enabled: true, label, url: url.href, secret: app.webhookSecret, resourceTypes: resources },
    });
    if (!data.webhookCreate.success) throw new Error("Linear refused the new subscription.");
    console.log(`Created ${data.webhookCreate.webhook.id} (${scope.teamId ?? "public teams"}).`);
  }
}
