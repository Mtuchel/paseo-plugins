import { z } from "zod";
import { ownerAskSchema, decisionReceiptSchema, askQuestionSchema } from "./contracts";

// Both browser and menu-bar clients operate on the existing revision-bound owner asks.
export const liveQuestionSchema = askQuestionSchema.extend({ allowEmpty: z.boolean().default(false) });
export const liveDecisionSchema = z.object({
  agentId: z.string().min(1), requestId: z.string().min(1), revision: z.string().min(1),
  title: z.string(), identifier: z.string().nullable(), issueUrl: z.string().nullable(),
  agentUrl: z.string().nullable(), source: z.string(), questions: z.array(liveQuestionSchema),
  kind: z.enum(["question", "permission"]),
  actions: z.array(z.object({ id: z.string(), label: z.string(), behavior: z.enum(["allow", "deny"]) })),
  deferredUntil: z.string().nullable(),
});
export type LiveDecision = z.infer<typeof liveDecisionSchema>;
export const decisionHostSchema = z.object({
  host: z.string(), asks: z.array(ownerAskSchema), live: z.array(liveDecisionSchema),
  history: z.array(decisionReceiptSchema), updatedAt: z.string(), error: z.string().nullable(),
});
export type DecisionHost = z.infer<typeof decisionHostSchema>;
export type DecisionView = {
  hosts: DecisionHost[];
  canonicalHost: string | null;
  unreachable: string[];
};
export type BrowserDecisionAction = {
  host: string;
  target: "owner" | "live";
  operation: "answer" | "triage";
  issueId?: string;
  agentId?: string;
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
