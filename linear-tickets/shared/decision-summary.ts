import type { BrowserOwnerAsk, DecisionSummary, DecisionView, LiveDecision } from "./decision-inbox";

type CountRow = {
  target: "owner" | "live";
  data: BrowserOwnerAsk | LiveDecision;
  task?: { priority: string };
  live?: LiveDecision[];
};

// Shared by the API and embedded browser; native consumes the canonical server result.
export function questionBundle(data: BrowserOwnerAsk | LiveDecision) {
  return data.questions.map(question => [
    question.question, question.multiSelect, "allowEmpty" in question ? question.allowEmpty : false,
    question.options.map(option => [option.label, option.description ?? null]),
  ]);
}

export function decisionBucket(row: CountRow, now = Date.now()): "decisions" | "actions" | "review" | "waiting" {
  const data = row.data;
  if ((data.deferredUntil && Date.parse(data.deferredUntil) > now) || row.task?.priority === "waiting"
    || (row.target === "owner" && ["research", "delegated"].includes((data as BrowserOwnerAsk).disposition ?? ""))) return "waiting";
  if (data.deliveryUnknown) return "review";
  if (row.target === "live") {
    const live = data as LiveDecision;
    return (live.kind === "permission" ? live.actions.length > 0 : live.questions.length > 0) ? "decisions" : "review";
  }
  const ask = data as BrowserOwnerAsk;
  if (["advisor", "dependency"].includes(ask.attention)) return "waiting";
  if (ask.attention !== "owner") return "review";
  // The producer's mirror flag is ticket-level. Only the exact current wait's full
  // question bundle can be matched to a live round; Q2 cannot resurrect an old Q1.
  if (ask.mirrorsLiveRequest && (!ask.agentId || !row.live?.some(request => request.kind === "question"
    && request.agentId === ask.agentId && request.identifier === ask.ticketIdentifier && !request.deliveryUnknown
    && JSON.stringify(questionBundle(request)) === JSON.stringify(questionBundle(ask))))) return "review";
  // A manual label alone is not evidence of a personal action.
  if (ask.kind === "manual" && ask.extracted) return "actions";
  return ask.extracted && ask.kind === "decision" && ask.questions.length > 0 ? "decisions" : "review";
}

export function summarizeDecisions(view: DecisionView, now = Date.now()): DecisionSummary {
  const reasons: string[] = [];
  const interval = view.curation?.intervalMs ?? 15 * 60_000;
  const maxAge = interval + 30_000;
  const checked: number[] = [];
  if (!view.canonicalHost || !view.hosts.some(host => host.host === view.canonicalHost)) reasons.push("The canonical Linear collection is unavailable.");
  if (view.unreachable.length || view.reading?.length || view.canonicalReading) reasons.push("Not all decision hosts have answered.");
  if (!view.hosts.length) reasons.push("No decision snapshot has been received.");
  for (const host of view.hosts) {
    const at = Date.parse(host.updatedAt);
    if (!Number.isFinite(at) || at > now + 30_000 || now - at > maxAge) reasons.push(`${host.host}: the collection is stale or its time cannot be verified.`);
    else checked.push(at);
    if (host.error) reasons.push(`${host.host}: ${host.error}`);
  }
  if (view.curation?.error) reasons.push(`Collection failed: ${view.curation.error}`);
  if (view.curation?.running === false) reasons.push("Automatic decision collection is stopped.");
  if (view.curation?.nextRefreshAt && Date.parse(view.curation.nextRefreshAt) + 30_000 < now) reasons.push("The scheduled decision collection is overdue.");

  const tasks = view.tasks && new Map(view.tasks.map(task => [JSON.stringify([task.host, task.target, task.id, task.revision]), task]));
  const decisions = new Set<string>(), actions = new Set<string>(), unverified = new Set<string>();
  for (const host of view.hosts) {
    const rows: { target: "owner" | "live"; id: string; data: BrowserOwnerAsk | LiveDecision }[] = [
      ...(host.host === view.canonicalHost ? host.asks.map(data => ({ target: "owner" as const, id: JSON.stringify([data.issueId, data.sourceId ?? data.revision]), data })) : []),
      ...host.live.map(data => ({ target: "live" as const, id: JSON.stringify([data.agentId, data.requestId]), data })),
    ];
    for (const row of rows) {
      const identity = JSON.stringify([host.host, row.target, row.id, row.data.revision]);
      const task = tasks?.get(identity);
      if (tasks && !task) continue;
      const ask = row.data as BrowserOwnerAsk;
      if (!tasks && row.target === "owner" && host.history.some(receipt => receipt.issueId === ask.issueId && receipt.revision === ask.revision
        && ["answer", "done"].includes(receipt.action) && ["agent", "continued", "queued", "comment", "closed", "applied"].includes(receipt.delivery))) continue;
      const bucket = decisionBucket({ ...row, task, live: host.live }, now);
      if (bucket === "waiting") continue;
      if (bucket === "review") {
        // Historical/nonurgent reading is not a potential current decision. Withheld
        // source-review pages likewise never make the badge uncertain on their own.
        if (row.target === "live" || ask.attention === "owner" || ask.deliveryUnknown) unverified.add(identity);
        continue;
      }
      if (row.target === "live") {
        // Separate requests/agents are separate rounds, even if their wording matches.
        decisions.add(identity);
        continue;
      }
      if (bucket === "decisions" && ask.mirrorsLiveRequest) continue; // Exact live mirror already verified by decisionBucket.
      // agentId is a delivery destination, not reliable source authorship. Preserve
      // independent comment identities; source admission already withholds exact echoes.
      (bucket === "actions" ? actions : decisions).add(identity);
    }
  }
  const coverageComplete = reasons.length === 0;
  if (unverified.size) reasons.push(`${unverified.size} current sources need question or delivery verification.`);
  return { decisions: decisions.size, actions: actions.size, unverified: unverified.size,
    coverageComplete, complete: coverageComplete && unverified.size === 0,
    checkedAt: checked.length === view.hosts.length && checked.length ? new Date(Math.min(...checked)).toISOString() : null,
    reasons: [...new Set(reasons)] };
}
