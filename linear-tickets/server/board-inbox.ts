import type { BoardHostFacts, BoardIssue, BoardOpenPull } from "../shared/board";
import { BoardHostFacts as BoardHostFactsSchema } from "../shared/board";
import type { ActivationRoute } from "./activation";
import { deriveBoard } from "./board";

// The factory board's live reads (shared/board.ts). Every host answers /api/board/local with its
// own facts; the host that serves /api/board adds its peers' answers, Linear and GitHub and draws
// the view. Peer reads are bounded; a source that fails leaves the board up without it.

export type BoardInboxDeps = {
  facts: () => Promise<BoardHostFacts>;
  peers: () => Promise<string[]>;
  issues: () => Promise<BoardIssue[]>;
  pulls: (repos: string[]) => Promise<BoardOpenPull[]>;
  now?: () => number;
};

// A page load fetches twice (the board and its host's section), so the local facts answer from
// memory between reads; Linear and GitHub are read far less often than the page is polled.
const FACTS_TTL_MS = 30_000;
const SOURCES_TTL_MS = 120_000;
// How old an answer may get while its next read is still under way; past this a read waits.
const STALE_MS = 5 * 60_000;
const PEER_TIMEOUT_MS = 8_000;
const json = (status: number, value: unknown) => ({ status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(value) });
const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);
function peerOrigin(peer: string): string {
  const url = new URL(peer);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Board peers must be HTTP(S) origins without credentials, paths or query strings.");
  return url.origin;
}
// The repositories a host's watched pull requests name: pr-watch.json's open URLs are the only
// place the board learns which repositories to ask GitHub about.
function reposOf(hosts: BoardHostFacts[]): string[] {
  const repos = new Set<string>();
  for (const host of hosts) for (const pull of host.pulls) {
    const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+(?:[?#]|$)/i.exec(pull.url);
    if (match) repos.add(`${match[1]}/${match[2]}`);
  }
  return [...repos].sort();
}

// One value, read by one flight at a time. A read younger than `fresh` ms is answered from memory;
// an older one starts the next read but is still answered from memory while younger than `stale`
// ms: a busy daemon's facts or a slow GitHub listing can take longer than the frontdoor and the
// peers wait (facts were seen at 17-80 s on server087), and every value carries when it was read.
// A failed read is not kept.
class Refreshing<T> {
  private last: { value: T; at: number } | null = null;
  private flight: Promise<{ value: T; at: number }> | null = null;
  constructor(private readonly read: () => Promise<T>, private readonly now: () => number, private readonly fresh: number, private readonly stale: number) {}

  async get(): Promise<{ value: T; at: number }> {
    const last = this.last;
    const age = last ? this.now() - last.at : Infinity;
    if (last && age < this.fresh) return last;
    if (!this.flight) {
      const flight = this.read().then((value) => (this.last = { value, at: this.now() }));
      this.flight = flight;
      void flight.then(() => {}, () => {}).finally(() => { if (this.flight === flight) this.flight = null; });
    }
    return last && age < this.stale ? last : this.flight;
  }
}

export class BoardInbox {
  private readonly now: () => number;
  private readonly ownFacts: Refreshing<BoardHostFacts>;
  // Linear and GitHub: an unreadable source is kept as null (unavailable) like a read one, so a
  // failing source is not retried on every page poll.
  private readonly issues: Refreshing<BoardIssue[] | null>;
  private readonly pulls: Refreshing<BoardOpenPull[] | null>;
  private repos: string[] = [];

  constructor(private readonly deps: BoardInboxDeps) {
    this.now = deps.now ?? Date.now;
    this.ownFacts = new Refreshing(deps.facts, this.now, FACTS_TTL_MS, STALE_MS);
    this.issues = new Refreshing(() => deps.issues().catch(() => null), this.now, SOURCES_TTL_MS, STALE_MS);
    this.pulls = new Refreshing(() => deps.pulls(this.repos).catch(() => null), this.now, SOURCES_TTL_MS, STALE_MS);
  }

  readonly route: ActivationRoute = async ({ method, path }) => {
    if (path !== "/api/board" && path !== "/api/board/local") return null;
    if (method !== "GET") return json(405, { error: "Use GET for the board." });
    let own: BoardHostFacts;
    try { own = (await this.ownFacts.get()).value; }
    catch (error) { return json(503, { error: reasonOf(error) }); }
    if (path === "/api/board/local") return json(200, own);
    const [peers, issues] = await Promise.all([this.peers(), this.issues.get()]);
    // A peer that calls itself this host is this host seen through another origin: it adds nothing.
    const hosts = [own, ...peers.facts.filter((host) => host.host !== own.host)];
    this.repos = reposOf(hosts);
    const pulls = await this.pulls.get();
    return json(200, deriveBoard({
      now: new Date(this.now()), hosts, unreachable: peers.unreachable,
      issues: issues.value, issuesAt: issues.value ? new Date(issues.at).toISOString() : null,
      pulls: pulls.value, pullsAt: pulls.value ? new Date(pulls.at).toISOString() : null,
    }));
  };

  // Every configured peer's facts, read in parallel: a peer that does not answer, answers a
  // non-2xx, or returns something that is not board facts is named as unreachable.
  private async peers(): Promise<{ facts: BoardHostFacts[]; unreachable: string[] }> {
    const configured = [...new Set(await this.deps.peers())];
    const reads = await Promise.all(configured.map(async (peer) => {
      let origin: string;
      try { origin = peerOrigin(peer); } catch { return { origin: peer, facts: null }; }
      try { return { origin, facts: await this.readPeer(origin) }; } catch { return { origin, facts: null }; }
    }));
    return {
      facts: reads.map((read) => read.facts).filter((facts): facts is BoardHostFacts => facts !== null),
      unreachable: reads.filter((read) => read.facts === null).map((read) => read.origin),
    };
  }

  private async readPeer(origin: string): Promise<BoardHostFacts> {
    const response = await fetch(`${origin}/api/board/local`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = BoardHostFactsSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`The peer ${origin} returned invalid board facts.`);
    return parsed.data;
  }
}