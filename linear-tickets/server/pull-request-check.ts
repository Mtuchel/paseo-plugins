import { ghJson, namesTicket, othersPullRequest, PullRequestNotFoundError } from "./pr-watch";

// The parts of a pull request that name its ticket.
export type PullRequestText = { title: string | null; body: string | null; headRefName: string | null };
export type PullRequestView = (url: string) => Promise<PullRequestText>;
export type PullRequestVerdict = { link: true } | { link: false; reason: string };
export type PullRequestCheck = (url: string, identifier: string) => Promise<PullRequestVerdict>;

const defaultView: PullRequestView = (url) => ghJson<PullRequestText>(["pr", "view", url, "--json", "title,body,headRefName"]);

// Whether a pull request URL from an agent's shell output is that ticket's pull request: gh
// resolves it with this host's credentials, its title, description or head branch names the
// ticket, and neither its title nor its `Linear:` line names another ticket instead (a TUC-630
// pull request whose description lists TUC-935 as related work is TUC-630's, not TUC-935's).
// Test fixtures (no such repository or pull request) and real pull requests of other tickets are
// not. Any other gh failure (network, auth, throttling, timeout) throws a message the write-back
// retries ("Could not reach GitHub"), so a real pull request is never dropped by an outage.
export async function ticketPullRequest(url: string, identifier: string, view: PullRequestView = defaultView): Promise<PullRequestVerdict> {
  let pullRequest: PullRequestText;
  try {
    pullRequest = await view(url);
  } catch (error) {
    if (error instanceof PullRequestNotFoundError) return { link: false, reason: "no such pull request" };
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    if (/Could not resolve to a Repository/i.test(stderr)) return { link: false, reason: "no such repository, or this host's gh cannot see it" };
    const message = stderr.split("\n")[0] || (error instanceof Error ? error.message : String(error));
    throw new Error(`Could not reach GitHub to check ${url}: ${message}`);
  }
  const other = othersPullRequest(identifier, pullRequest.title ?? "", pullRequest.body);
  if (other) return { link: false, reason: `the pull request is ${other.ticket}'s: its ${other.place} names ${other.ticket}, not ${identifier}` };
  const named = namesTicket(identifier);
  if ([pullRequest.title, pullRequest.body, pullRequest.headRefName].some((text) => named.test(text ?? ""))) return { link: true };
  return { link: false, reason: `the pull request does not name ${identifier} in its title, description or branch` };
}
