import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { questionsOf } from "./relay";

export const TECHNICAL_CONTINUATION_TEMPLATE = "read-only-investigation-v2";
// Complete executable text is code-owned. Model explanations are audit data only.
export const TECHNICAL_CONTINUATION = [
  "Automated deputy technical instruction, not personal owner approval and not selection or approval of any offered option or bundled release.",
  "Under current standing technical authority only, gather missing evidence through a concrete relevant read-only investigation or independent review of existing material. Use only already available authorized access; do not claim an independent reviewer or review occurred without evidence.",
  "Preserve every actual owner hold, stop, cancellation, owner-only approval requirement, acceptance criterion and verification/release gate. If a hold prohibits this investigation or review, do not perform it; retain that boundary and report the blocker.",
  "This instruction itself authorizes no writes or repairs, pushes, approval artifacts or PASS/review markers, paid worker runs or new spend, private uploads, publication, enqueue, merge, deployment, access changes or external commitments. Do not invent business/tax facts, approve an unknown plan or release, or mark work or acceptance complete.",
  "These limits describe this investigation, not a permanent ticket-wide owner hold. Reconcile each later action against its own evidenced authority and current gates. Existing standing delegation may cover known technical work; a later authenticated owner answer may cover a specifically scoped action. Neither releases unrelated safety holds, staging exclusions or acceptance requirements. Do not seek a new owner click merely to replace this automated instruction, and do not infer authority for unknown effects.",
  "Report the evidence actually gathered and distinguish properly scoped technical work from retained business/owner decisions. Do not repeat the same bundled question without gathering new evidence; if no useful permitted read-only step exists, report that prerequisite or owner boundary without implying approval. Any later write or delivery requires its own properly scoped authority and gates.",
].join("\n\n");

export type TechnicalContinuation = { template: typeof TECHNICAL_CONTINUATION_TEMPLATE; step: string; whyNoSafeOption: string };

// This is the actual 0.11.4 OmpQuestionUi ask mapping, not generic select/editor.
// The adapter consumes a custom response over a second, unobserved editor hop.
export function supportsTechnicalContinuation(request: AgentPermissionRequest): boolean {
  if (request.kind !== "question" || request.provider !== "omp" || request.name !== "OMP ask"
    || request.metadata?.ompAsk !== true || request.metadata.answerHeader !== "Response") return false;
  if (!Array.isArray(request.input?.questions) || request.input.questions.length !== 1) return false;
  const parts = questionsOf(request);
  if (parts.length !== 1) return false;
  const part = parts[0];
  if (part.header !== "Response" || !("allowOther" in part) || part.allowOther !== true
    || !("multiSelect" in part) || part.multiSelect !== false
    || ("multiple" in part && part.multiple !== false)) return false;
  const labels = part.options?.map(option => option.label);
  const metadataLabels = request.metadata.optionLabels;
  return Boolean(labels?.length && labels.every(label => typeof label === "string" && label.trim()
    && label !== TECHNICAL_CONTINUATION && label !== "Other (type your own)")
    && new Set(labels).size === labels.length && Array.isArray(metadataLabels)
    && metadataLabels.length === labels.length && metadataLabels.every((label, index) => label === labels[index]));
}
