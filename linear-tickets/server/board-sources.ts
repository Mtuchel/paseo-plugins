import type { BoardIssue, BoardOpenPull } from "../shared/board";
import type { LinearService } from "./linear";
import { ghJson } from "./pr-watch";
import type { Settings } from "./settings";

// The factory board's two shared sources. Linear lists the dispatch label's tickets; GitHub lists
// the open pull requests of the repositories the hosts' watched pull requests name. Both throw on
// failure: the board's reader turns that into "this source is unavailable", not an empty board.

export async function boardIssues(linear: Pick<LinearService, "boardIssues">, settings: Pick<Settings, "read">): Promise<BoardIssue[]> {
  const { dispatch } = await settings.read();
  return linear.boardIssues({ label: dispatch.label, teamKeys: dispatch.teamKeys });
}

// What `gh pr list --json` answers, before the defects of someone else's JSON are trusted.
type GhPull = { number?: unknown; url?: unknown; title?: unknown; headRefName?: unknown; isDraft?: unknown; labels?: unknown; mergeStateStatus?: unknown; updatedAt?: unknown };

export async function boardPulls(repos: string[]): Promise<BoardOpenPull[]> {
  const lists = await Promise.all([...new Set(repos)].map((repo) => ghJson<GhPull[]>([
    "pr", "list", "-R", repo, "--state", "open", "--limit", "300",
    "--json", "number,url,title,headRefName,isDraft,labels,mergeStateStatus,updatedAt",
  ])));
  const pulls: BoardOpenPull[] = [];
  for (const pull of lists.flat()) {
    if (!pull || typeof pull !== "object") continue;
    const { number, url, title, headRefName, isDraft, labels, mergeStateStatus, updatedAt } = pull;
    if (typeof number !== "number" || typeof url !== "string" || typeof headRefName !== "string" || typeof updatedAt !== "string") continue;
    const names = Array.isArray(labels) ? labels.map((label) => label && typeof label === "object" && "name" in label ? String(label.name) : "") : [];
    pulls.push({
      url, number, title: typeof title === "string" ? title : "", branch: headRefName,
      draft: isDraft === true, conflict: mergeStateStatus === "DIRTY", doNotMerge: names.includes("do-not-merge"), updatedAt,
    });
  }
  return pulls;
}