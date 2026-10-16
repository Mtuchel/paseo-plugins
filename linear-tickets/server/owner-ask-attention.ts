import type { OwnerAsk } from "../shared/contracts";
import type { ExtractedAsk } from "./owner-ask-extract";
import { assessmentReason, checkAssessment, type AskContext } from "./owner-ask-admission";

type Attention = Pick<OwnerAsk, "attention" | "attentionReason" | "blockerIdentifier">;

// Remove only Paseo's framing, not the actual ask nested inside the wait comment.
function content(source: string): string {
  return source.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[^\n]*\(Paseo\) (?:finished its turn and is waiting for you|is waiting for (?:an answer|plan approval|permission)):\s*/i, "")
    .replace(/Reply here with [“"]@paseo[^\n]*/gi, "")
    .replace(/[*_`]/g, "");
}

export function blockerIdentifier(source: string): string | null {
  const text = content(source);
  const found = new Set<string>();
  // An arbitrary ticket mention (including the task's own title) is never a dependency.
  for (const clause of text.split(/[\n.!?]+/)) {
    if (/\b(?:(?:not|no longer|never|previously|formerly)\s+(?:blocked|dependent|waiting)|(?:was|were|might be|could be|if)\s+blocked)\b/i.test(clause)) continue;
    if (/\b(?:if|unless|previously|formerly|no longer)\b/i.test(clause)) continue;
    for (const match of clause.matchAll(/\b(?:blocked\s+(?:by|on)|depends\s+on|dependent\s+on|blocker\s*:)\s*(?:ticket\s+)?([A-Z][A-Z0-9]*-\d+)\b/gi)) found.add(match[1].toUpperCase());
    // Also accept an explicit blocking subject, or a named failure followed by its consequence.
    for (const match of clause.matchAll(/\b([A-Z][A-Z0-9]*-\d+)\s*,?\s+(?:which\s+)?(?:also\s+)?blocks\b/gi)) found.add(match[1].toUpperCase());
    for (const match of clause.matchAll(/\b([A-Z][A-Z0-9]*-\d+)['’]s\s+(?:migration|deployment|deploy|build|check|job)\b[^.!?\n]{0,220}\bfailed\b[^.!?\n]{0,240}\bso\b[^.!?\n]{0,80}\bblocks\b/gi)) found.add(match[1].toUpperCase());
    for (const match of clause.matchAll(/\b(?:same|issue|failure|limit|cap|check)\s+blocks\b[^.!?\n]{0,120}\((?:filed|tracked)\s+as\s+([A-Z][A-Z0-9]*-\d+)\)/gi)) found.add(match[1].toUpperCase());
  }
  return found.size === 1 ? [...found][0] : null;
}

export function classifyAttention(source: string, value: ExtractedAsk | null, context?: AskContext): Attention {
  const blocker = blockerIdentifier(source);
  const result = (attention: Attention["attention"], attentionReason: string): Attention => ({ attention, attentionReason, blockerIdentifier: blocker });
  if (context?.duplicateOf) return result("info", `Exact echo of source ${context.duplicateOf}; original ${context.sourceId} retained for nonurgent review. No independent decision or completion is inferred.`);
  if (context?.liveRequest) return result("owner", `Exact current pending owner request at source ${context.sourceId}; extraction cannot remove live fail-open attention.`);
  const assessment = checkAssessment(value?.assessment, context);
  if (assessment) {
    const reason = assessmentReason(assessment);
    if (assessment.state === "owner") return result("owner", reason);
    if (assessment.state === "advisor" || assessment.state === "dependency") return result(assessment.state, reason);
    return result("info", `${reason} Retained for nonurgent review; no answer, authorization or ledger completion inferred.`);
  }
  if (context?.currentWait) return result("owner", `Current exact owner wait at source ${context.sourceId}; extraction pending, failed or lacks checked evidence. Original request remains visible.`);
  return result("info", `Historical source ${context?.sourceId ?? "(unidentified)"} needs nonurgent source review: current unresolved owner attention is not independently evidenced${context && !context.complete ? "; timeline is incomplete" : ""}. Extraction or a question mark alone does not establish urgency.`);
}
