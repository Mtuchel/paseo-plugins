import type { GroupChild, IssueGroup } from "./linear";

// Group children keep their own dispatcher/admission gates. Finishing them makes the parent
// eligible for verification, never an automatic Done/Canceled transition.

// `members`: the sub-issues the group waits for. The owner's own sub-issues (manual tasks and
// "Needs you" questions, recognised by their labels) are not members.
// `handOut`: open members not with Paseo yet and assigned to nobody or to the owner.
// `others`: open members assigned or delegated to someone else; they are waited for, never taken.
export type GroupProgress = {
  members: GroupChild[];
  handOut: GroupChild[];
  others: GroupChild[];
  finished: boolean;
  ownerTasks: GroupChild[];
};

export function groupProgress(group: IssueGroup, ownerId: string, appId: string, ownLabels: string[]): GroupProgress {
  // Linear's general `finished` also accepts merged-In-Review; parent readiness must not.
  const children = group.children.map((child) => ({ ...child, finished: ["completed", "canceled", "duplicate"].includes(child.statusType) }));
  const ownerTasks = children.filter((child) => child.labels.some((name) => ownLabels.includes(name)));
  const members = children.filter((child) => !ownerTasks.includes(child));
  const open = members.filter((child) => !child.finished);
  const handOut = open.filter((child) => !child.delegateId && (!child.assigneeId || child.assigneeId === ownerId));
  const others = open.filter((child) => child.delegateId !== appId && !handOut.includes(child));
  const finished = members.length > 0 && open.length === 0;
  return { members, handOut, others, finished, ownerTasks };
}

// Whether a ticket is handed to Paseo as a group rather than worked on by one agent.
export function isGroup(progress: GroupProgress): boolean {
  return progress.members.some((child) => !child.finished);
}

// What each sub-issue waits for, as the parent's panel shows it. `agents`: sub-issues with a
// Paseo thread: "working" once an agent started, "queued" while the thread waits, "group" when
// the sub-issue is a group itself.
export function groupStatus(identifier: string, progress: GroupProgress, appId: string, agents: Map<string, "working" | "queued" | "group">, parentBlockers: string[]): string {
  const withPaseo = new Set(progress.members.filter((child) => child.delegateId === appId).map((child) => child.id));
  const done = progress.members.filter((child) => child.finished).length;
  const lines = progress.members.map((child) => {
    if (child.finished) return `- ${child.identifier}: ${child.status}`;
    if (progress.others.includes(child)) return `- ${child.identifier}: assigned to someone else; ${identifier} waits for it`;
    if (!withPaseo.has(child.id)) return `- ${child.identifier}: not handed out yet`;
    const blockers = child.blockers.filter((blocker) => !blocker.finished);
    if (agents.get(child.id) === "working") return `- ${child.identifier}: agent started`;
    if (agents.get(child.id) === "group") return `- ${child.identifier}: works through its own sub-issues`;
    if (blockers.length) {
      const names = blockers.map((blocker) => blocker.delegateId === appId || withPaseo.has(blocker.id) ? blocker.identifier : `${blocker.identifier} (not with Paseo, nobody is working on it here)`);
      return `- ${child.identifier}: waits for ${names.join(", ")}`;
    }
    return `- ${child.identifier}: ${agents.get(child.id) === "queued" ? "waiting for a free agent slot" : "starting"}`;
  });
  const head = parentBlockers.length
    ? `${identifier} is blocked by ${parentBlockers.join(", ")}; its sub-issues are handed out once that is finished.`
    : `${done} of ${progress.members.length} sub-issues finished. ${identifier} requires verification after they finish.`;
  return [head, ...lines].join("\n");
}
