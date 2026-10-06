import { z } from "zod";

export const PipelineStage = z.enum(["queued", "preparing", "advisor", "publishing", "waiting", "ready", "auto-approved", "superseded", "cancelled", "completed"]);
export const PipelineStatus = z.enum(["normal", "attention", "failed", "unknown"]);
const link = z.string().max(2_000).url().regex(/^https?:\/\//);
export const PipelineRow = z.object({
  id: z.string().max(300), agentId: z.string().max(100), identifier: z.string().max(200), host: z.string().max(100),
  stage: PipelineStage, status: PipelineStatus,
  since: z.string().datetime(), lastProgressAt: z.string().datetime().nullable(),
  detail: z.string().max(1_400), issueUrl: link.optional(), agentUrl: link.optional(), reviewUrl: link.optional(),
});
export const PipelineHost = z.object({
  host: z.string().max(100), checkedAt: z.string().datetime().nullable(), lastArrivalAt: z.string().datetime().nullable(),
  rows: z.array(PipelineRow).max(1_000), error: z.string().max(1_400).optional(),
});
export type PipelineStage = z.infer<typeof PipelineStage>;
export type PipelineStatus = z.infer<typeof PipelineStatus>;
export type PipelineRow = z.infer<typeof PipelineRow>;
export type PipelineHost = z.infer<typeof PipelineHost>;
