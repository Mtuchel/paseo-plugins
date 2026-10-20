import type { Credentials } from "./credentials";
import { postGraphQL, type Post } from "./linear";
import type { ResourceWebhook } from "./agent-webhook";

const RECONCILE_MS = 5 * 60 * 1000;
const COVERAGE_MAX_AGE_MS = 2 * RECONCILE_MS;
type Resource = ResourceWebhook["type"];
type Hook = { enabled: boolean; url: string | null; secret: string | null; resourceTypes: string[]; allPublicTeams: boolean; teamIds: string[] | null; team: { id: string } | null };
type Team = { id: string; private: boolean };

// Coverage is explicit: an enabled workspace subscription, the matching signing secret,
// every visible team's scope, and a healthy public receiver. Quiet traffic is not failure.
export class WebhookCoverage {
  private checkedAt: number | null = null;
  private transportAt: number | null = null;
  private readonly teams = new Map<string, boolean>();
  private agentSessionSeen = false;
  private hooks: Hook[] = [];

  constructor(private readonly credentials: Pick<Credentials, "read">, private readonly post: Post = postGraphQL, private readonly now = () => Date.now()) {}

  noteAgentSession(): void { this.agentSessionSeen = true; }

  coversAgentSessions(): boolean {
    return this.transportHealthy() && this.agentSessionSeen;
  }
  setTransport(healthy: boolean): void { this.transportAt = healthy ? this.now() : null; }

  private transportHealthy(): boolean {
    return this.transportAt !== null && this.now() - this.transportAt < COVERAGE_MAX_AGE_MS;
  }

  covers(resource: Resource, teamId?: string): boolean {
    if (!this.transportHealthy() || this.checkedAt === null || this.now() - this.checkedAt >= COVERAGE_MAX_AGE_MS) return false;
    const covered = (id: string) => this.hooks.some((hook) => hook.resourceTypes.includes(resource)
      && (hook.teamIds?.includes(id) || hook.team?.id === id || (hook.allPublicTeams && this.teams.get(id) === false)));
    return teamId ? this.teams.has(teamId) && covered(teamId) : this.teams.size > 0 && [...this.teams.keys()].every(covered);
  }

  async refresh(url: string | null, secret: string): Promise<void> {
    this.checkedAt = null;
    const { key } = await this.credentials.read();
    if (!key || !url) return;
    const hooks: Hook[] = [];
    let after: string | null = null;
    do {
      const data = await this.post(key, `query reconciliationWebhooks($after: String) {
        webhooks(first: 50, after: $after) { nodes { enabled url secret resourceTypes allPublicTeams teamIds team { id } } pageInfo { hasNextPage endCursor } }
      }`, { after });
      const page = data.webhooks as { nodes: Hook[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      hooks.push(...page.nodes.filter((hook) => hook.enabled && hook.url === url && hook.secret === secret));
      if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) throw new Error("Linear returned an incomplete webhook page.");
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    const teams: Team[] = [];
    do {
      const data = await this.post(key, `query reconciliationTeams($after: String) {
        teams(first: 100, after: $after) { nodes { id private } pageInfo { hasNextPage endCursor } }
      }`, { after });
      const page = data.teams as { nodes: Team[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      teams.push(...page.nodes);
      if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) throw new Error("Linear returned an incomplete team page.");
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    this.hooks = hooks;
    this.teams.clear();
    for (const team of teams) this.teams.set(team.id, team.private);
    this.checkedAt = this.now();
  }
}
