import type { OwnerAsk } from "../shared/contracts";
import type { ExtractedAsk } from "./owner-ask-extract";
import { ownerRequest } from "./writeback";

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

export function classifyAttention(source: string, value: ExtractedAsk | null, manual: boolean): Attention {
  const blocker = blockerIdentifier(source);
  const result = (attention: Attention["attention"], attentionReason: string): Attention => ({ attention, attentionReason, blockerIdentifier: blocker });
  if (!value) return result("owner", "Extraction pending or uncertain; kept in your inbox.");
  if (manual || value.kind === "manual") return result("owner", "An explicit manual step still needs you.");
  const text = content(source);
  const advisor = /\b(?:waiting (?:on|for) (?:the |an? )?advisor|advisor[^\n.!?]{0,60}(?:pending|has(?:n't| not) (?:answered|replied))|(?:once|when|after) the advisor (?:answers|replies|responds))\b/i.test(text);
  const noInput = /\b(?:nothing (?:is )?(?:needed|required)(?: from you)? (?:yet|now|at this (?:time|point))|no (?:owner |user )?(?:input|action|decision|approval) (?:is )?(?:needed|required)(?: from you)?(?: yet| now)?|nothing (?:for you to do|needed from you yet))\b/i.test(text);
  // Future approval/status language is not a current request. Test the remaining clauses for
  // real questions/requests so "waiting for advisor; meanwhile please choose X" stays visible.
  const current = text.split(/\n|(?<=[.!?])\s+/).filter((line) => {
    if (/\?/.test(line)) return true;
    if (/\b(?:please|can you|could you|choose|decide|confirm|approve now)\b/i.test(line)) return true;
    return !/\b(?:advisor|nothing (?:is )?(?:needed|required)|no (?:owner |user )?(?:input|action|decision|approval)|once|after|later|will (?:need|require)|needs your approval|requires your approval)\b/i.test(line);
  }).join("\n");
  const request = current.split(/\n|(?<=[.!?])\s+/).find(line => /\?|\b(?:please\s+(?:choose|decide|approve|confirm|provide)|(?:choose|decide|approve|confirm)\b[^.\n]{0,80}\bnow)\b/i.test(line))
    ?? ownerRequest(text);
  if (request) return result("owner", `Source asks: ${request.trim().slice(0, 400)}`);
  if (advisor) return result("advisor", "Waiting for the advisor; no current owner request is evidenced.");
  if (noInput) return result("info", "The source explicitly says no input is needed yet.");
  if (value.questions.length || value.kind === "decision") return result("owner", "The extracted question needs an explicit answer.");
  if (blocker) return result("dependency", `Explicitly blocked by ${blocker}; decisions remain ticket-specific.`);
  return result("owner", "No conclusive waiting-only evidence; kept in your inbox.");
}
