import { z } from "zod";
import { ownerAskSchema, decisionReceiptSchema, askQuestionSchema } from "./contracts";

// Browser and menu-bar clients share source identity and revision-bound owner asks.
export const browserOwnerAskSchema = ownerAskSchema.extend({
  deliveryUnknown: z.boolean().optional(),
});
export type BrowserOwnerAsk = z.infer<typeof browserOwnerAskSchema>;
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
  control: z.object({
    passStartedAt: z.string().nullable(), overduePassMs: z.number(),
    maxUnattendedMs: z.number(), recoveryOutcomes: z.record(z.string(), z.number()),
  }).optional(),
});
export type StewardFlow = z.infer<typeof stewardFlowSchema>;
export const decisionHostSchema = z.object({
  host: z.string(), asks: z.array(browserOwnerAskSchema), live: z.array(liveDecisionSchema),
  backendInstanceId: z.string().uuid().optional(),
  history: z.array(decisionReceiptSchema), updatedAt: z.string(), error: z.string().nullable(),
  flow: stewardFlowSchema.nullable().default(null),
});
export type DecisionHost = z.infer<typeof decisionHostSchema>;
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
