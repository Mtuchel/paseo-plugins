import type { LinearService, ProjectIssue } from "./linear";

// The project flow's reads of a project's open tickets (README, "Projects"), within Linear's
// hourly complexity budget. Reading every open ticket with its labels and relations costs about
// 175 points a ticket (2026-10-07: 90,618 points for the 518 open tickets of two projects), and the
// flow polls every few minutes: that alone used about 1.8M of the app's 2M points an hour. So a
// project is read in full at most every FULL_READ_MS (or when the caller asks, after it wrote the
// order), and in between only its tickets changed since the last read, plus the current state of
// the blockers its tickets wait on (a blocker finishing changes the blocker, not the ticket).
// What a changed-only read cannot see waits for the next full read: a relation added or removed
// in Linear without the ticket itself changing, and a ticket that was deleted.
export const FULL_READ_MS = 30 * 60_000;
// Changed-only reads start this much before the last read began: Linear's clock and this host's
// may differ, and a ticket changed during the last read must not fall between the two.
export const OVERLAP_MS = 2 * 60_000;

type Snapshot = { issues: Map<string, ProjectIssue>; fullAt: number; readAt: number };

export class ProjectIssueCache {
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(
    private readonly linear: Pick<LinearService, "projectIssues" | "projectIssuesChanged" | "blockerStates">,
    private readonly now: () => number = Date.now,
  ) {}

  // The project's open tickets. `full`: read every ticket now, not only the changed ones.
  async read(projectId: string, full = false): Promise<ProjectIssue[]> {
    const startedAt = this.now();
    const last = this.snapshots.get(projectId);
    if (full || !last || startedAt - last.fullAt >= FULL_READ_MS) {
      const issues = await this.linear.projectIssues(projectId);
      this.snapshots.set(projectId, { issues: new Map(issues.map((issue) => [issue.id, issue])), fullAt: startedAt, readAt: startedAt });
      return issues;
    }
    const changes = await this.linear.projectIssuesChanged(projectId, new Date(last.readAt - OVERLAP_MS).toISOString(), [...last.issues.keys()]);
    const issues = new Map(last.issues);
    for (const id of [...changes.closed, ...changes.moved]) issues.delete(id);
    for (const issue of changes.open) issues.set(issue.id, issue);
    const closed = new Set(changes.closed);
    const left = new Set([...changes.closed, ...changes.moved]);
    const waitingOn = [...new Set([...issues.values()].flatMap((issue) => issue.blockers.filter((blocker) => !blocker.finished).map((blocker) => blocker.id)))];
    const current = new Map((waitingOn.length ? await this.linear.blockerStates(waitingOn) : []).map((blocker) => [blocker.id, blocker]));
    for (const [id, issue] of issues) {
      issues.set(id, {
        ...issue,
        // A parent counts only while it is open and in this project.
        parentId: issue.parentId && left.has(issue.parentId) ? null : issue.parentId,
        blocks: issue.blocks.filter((blocked) => !closed.has(blocked)),
        // A blocker Linear no longer returns keeps its last state until the next full read.
        blockers: issue.blockers.map((blocker) => current.get(blocker.id) ?? blocker),
      });
    }
    this.snapshots.set(projectId, { issues, fullAt: last.fullAt, readAt: startedAt });
    return [...issues.values()];
  }
}
