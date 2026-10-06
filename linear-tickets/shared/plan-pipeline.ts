import { z } from "zod";

export const PipelineStage = z.enum(["queued", "preparing", "advisor", "publishing", "waiting", "ready", "auto-approved", "superseded", "cancelled", "completed"]);
export const PipelineStatus = z.enum(["normal", "attention", "failed", "unknown"]);
export const PipelineRow = z.object({
  id: z.string(), agentId: z.string(), identifier: z.string(), host: z.string(),
  stage: PipelineStage, status: PipelineStatus,
  since: z.string().datetime(), lastProgressAt: z.string().datetime().nullable(),
  detail: z.string(), issueUrl: z.string().optional(), agentUrl: z.string().optional(), reviewUrl: z.string().optional(),
});
export const PipelineHost = z.object({
  host: z.string(), checkedAt: z.string().datetime().nullable(), lastArrivalAt: z.string().datetime().nullable(),
  rows: z.array(PipelineRow), error: z.string().optional(),
});
export type PipelineStage = z.infer<typeof PipelineStage>;
export type PipelineStatus = z.infer<typeof PipelineStatus>;
export type PipelineRow = z.infer<typeof PipelineRow>;
export type PipelineHost = z.infer<typeof PipelineHost>;
