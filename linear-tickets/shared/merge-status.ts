import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const mergeBlockerSchema = z.object({
  identifier: z.string(), title: z.string(), issueUrl: z.string(), status: z.string(),
  phase: z.enum(["waiting-approval", "queued", "working", "waiting-input", "review", "failed", "unknown"]),
  nextAction: z.string(), agentId: z.string().nullable(), agentUrl: z.string().nullable(),
}).strict();
export const mergeStatusSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }).nullable(),
  error: z.string().nullable(), blockers: z.array(mergeBlockerSchema),
}).strict();
export type MergeBlocker = z.infer<typeof mergeBlockerSchema>;
export type MergeStatusSnapshot = z.infer<typeof mergeStatusSchema>;
export const mergeStatusRpc = defineRpc({ name: "linear.merge-status", input: z.object({}), output: mergeStatusSchema });
