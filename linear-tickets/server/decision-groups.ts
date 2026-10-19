// Presentation grouping for the decision queue. The function is self-contained on purpose: the
// page embeds its compiled source in the inline client script with
// groupRowsByTicket.toString(), so it must not reference imports, module constants or helpers.
// Sources stay the unit of work: grouping never merges their identity or their actions.
export type DecisionRow = {
  host: string;
  target: "owner" | "live";
  revision: string;
  id: string;
  data: {
    ticketIdentifier?: string | null;
    identifier?: string | null;
    [field: string]: unknown;
  };
  backendInstanceId?: string;
  task?: unknown;
  paged?: boolean;
  [field: string]: unknown;
};

export type DecisionGroup = {
  key: string;
  ticket: string | null;
  rows: DecisionRow[];
};

export function groupRowsByTicket(rows: DecisionRow[]): DecisionGroup[] {
  const groups: DecisionGroup[] = [];
  const byKey = new Map<string, DecisionGroup>();
  for (const row of rows) {
    const value = row.target === "owner" ? row.data.ticketIdentifier : row.data.identifier;
    const ticket = typeof value === "string" && value !== "" ? value : null;
    if (ticket === null) {
      // A ticketless source is never merged, even with an identical identity key.
      groups.push({ key: JSON.stringify([row.host, row.target, row.id, row.revision]), ticket, rows: [row] });
      continue;
    }
    let group = byKey.get(ticket);
    if (!group) {
      group = { key: ticket, ticket, rows: [] };
      byKey.set(ticket, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}