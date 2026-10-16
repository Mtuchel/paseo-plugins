import { z } from "zod";
import { ownerAskSchema, decisionReceiptSchema, askQuestionSchema } from "./contracts";

// Browser and menu-bar clients share source identity and revision-bound owner asks.
export const browserOwnerAskSchema = ownerAskSchema.extend({
  deliveryUnknown: z.boolean().optional(),
});
export type BrowserOwnerAsk = z.infer<typeof browserOwnerAskSchema>;
// A source only needs nonurgent reading: nothing is answered, researched, delegated or deferred,
// and its delivery is not unknown. The feeds carry a count of these instead of the sources
// themselves; the canonical host pages them out on demand (server/decision-inbox.ts), so no
// source is ever dropped from the inbox.
export function isSourceReview(ask: BrowserOwnerAsk): boolean {
  return ask.attention === "info" && !ask.deliveryUnknown && !ask.disposition && !ask.deferredUntil;
}
export const liveQuestionSchema = askQuestionSchema.extend({ allowEmpty: z.boolean().default(false) });
export const liveDecisionSchema = z.object({
  agentId: z.string().min(1), requestId: z.string().min(1), revision: z.string().min(1),
  title: z.string(), identifier: z.string().nullable(), issueUrl: z.string().nullable(),
  agentUrl: z.string().nullable(), source: z.string(), questions: z.array(liveQuestionSchema),
  kind: z.enum(["question", "permission"]),
  actions: z.array(z.object({ id: z.string(), label: z.string(), behavior: z.enum(["allow", "deny"]) })),
  deferredUntil: z.string().nullable(),
  deliveryUnknown: z.boolean().optional(),
});
export type LiveDecision = z.infer<typeof liveDecisionSchema>;
// The ticket steward's flow summary (steward.ts StewardSnapshot): what each in-scope open ticket
// of the dispatch teams is waiting for, for the inbox page's Flow section. `at`: the pass it is
// from; null before the first pass or while the steward is off. Absent from a host that does not
// run the steward.
export const recoveryTicketSchema = z.object({
  identifier: z.string(), situation: z.string(), since: z.string(), reason: z.string(),
  nextAction: z.string().nullable().optional(),
  waitReason: z.string().nullable().optional(),
  nextCheckAt: z.string().nullable().optional(),
  responsibleGeneration: z.string().nullable().optional(),
  lastVerifiedAdvancementAt: z.string().nullable().optional(),
});
export const stewardFlowSchema = z.object({
  at: z.string().nullable(),
  counts: z.record(z.string(), z.number().int()),
  oldest: z.array(z.object({ identifier: z.string(), situation: z.string(), since: z.string() })),
  error: z.string().nullable(),
  tickets: z.array(recoveryTicketSchema).optional(),
  // Every recovery ticket the steward tracks, while `tickets` may carry only the referenced ones
  // (the peer feed, server/decision-inbox.ts): the inbox page reads the rest from their host.
  ticketCount: z.number().int().nonnegative().optional(),
  control: z.object({
    passStartedAt: z.string().nullable(), overduePassMs: z.number(),
    maxUnattendedMs: z.number(), recoveryOutcomes: z.record(z.string(), z.number()),
  }).optional(),
});
export type StewardFlow = z.infer<typeof stewardFlowSchema>;
// One host's full recovery evidence (server/decision-inbox.ts): the on-demand counterpart of the
// reference-only `flow.tickets` a peer feed ships.
export const recoveryTicketPageSchema = z.object({ host: z.string().min(1), tickets: z.array(recoveryTicketSchema) }).strict();
export type RecoveryTicketPage = z.infer<typeof recoveryTicketPageSchema>;
export const decisionHostSchema = z.object({
  host: z.string(), asks: z.array(browserOwnerAskSchema), live: z.array(liveDecisionSchema),
  backendInstanceId: z.string().uuid().optional(),
  // How many of this host's canonical owner sources are withheld from `asks` as source reviews
  // (isSourceReview). Optional: a peer from before the split answers without it, and a host
  // without an owner snapshot yet has nothing to count.
  sourceReviews: z.number().int().nonnegative().optional(),
  history: z.array(decisionReceiptSchema), updatedAt: z.string(), error: z.string().nullable(),
  flow: stewardFlowSchema.nullable().default(null),
});
export type DecisionHost = z.infer<typeof decisionHostSchema>;
// One page of withheld source reviews (server/decision-inbox.ts): `total` counts every review
// matching the query, `asks` is the bounded `offset`-long slice. Paging keeps one answer far below
// the frontdoor's 16 MiB cap that shipping every source exceeded.
export const SOURCE_REVIEW_PAGE_LIMIT = 50;
export const SOURCE_REVIEW_PAGE_MAX = 100;
export const sourceReviewPageSchema = z.object({
  host: z.string().min(1),
  backendInstanceId: z.string().uuid().optional(),
  updatedAt: z.string(),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  asks: z.array(browserOwnerAskSchema),
});
export type SourceReviewPage = z.infer<typeof sourceReviewPageSchema>;
export type CuratedDecision = {
  host: string;
  target: "owner" | "live";
  // Owner: [issueId, sourceId], live: [agentId, requestId].
  id: string;
  revision: string;
  priority: "owner" | "review" | "waiting";
  reason: string;
  blockedWork: string;
  flow?: z.infer<typeof recoveryTicketSchema>;
};
export type CurationStatus = {
  intervalMs: number;
  running: boolean;
  refreshing: boolean;
  lastRefreshAt: string | null;
  nextRefreshAt: string | null;
  error: string | null;
};
export type DecisionView = {
  hosts: DecisionHost[];
  canonicalHost: string | null;
  unreachable: string[];
  // Configured hosts in `unreachable` whose first read is still under way (no current snapshot
  // yet, no failure either); `canonicalReading` when the canonical owner-ask host is one of them.
  reading?: string[];
  canonicalReading?: boolean;
  tasks?: CuratedDecision[];
  curation?: CurationStatus;
};
export type BrowserDecisionAction = {
  host: string;
  backendInstanceId?: string;
  target: "owner" | "live";
  operation: "answer" | "triage";
  issueId?: string;
  agentId?: string;
  sourceId?: string;
  requestId?: string;
  revision: string;
  answers?: Record<string, string>;
  note?: string;
  done?: boolean;
  action?: "research" | "delegate" | "defer" | "reopen";
  until?: string;
  actionId?: string;
  behavior?: "allow" | "deny";
};
