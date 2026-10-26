import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "./child-processes";
import { locateHost, type HostLocation } from "./parked";

// A plan is approved only once every `:::question` block in it is answered (README, "Plan
// questions"). The owner's approvals from the review inbox and the Linear panel carry no answers
// (they are given on Plannotator's page, which sends them with its own Approve), so a question
// passes there only when the agent settled it with `[x]`. Which blocks count, and how they are
// read, is Plannotator's own parser (`unansweredQuestions` in its question-block module, run with
// Bun like the parked-plans host): the plugin never reads the grammar itself.

export type UnansweredQuestion = { number: number; line: number; prompt: string; status: string };

// The owner approved a plan that still has unanswered questions; nothing was recorded or sent.
export class QuestionsUnansweredError extends Error {}

// Plannotator's answer to such an approval (HTTP 422 with this code).
export const QUESTIONS_UNANSWERED_CODE = "questions_unanswered";

export function questionsUnansweredMessage(questions: readonly UnansweredQuestion[]): string {
  const listed = questions.map((q) => `Q${q.number}. ${q.prompt.replace(/\s+/g, " ").trim()}${q.status === "skipped" ? " (skipped)" : ""} (line ${q.line})`).join("; ");
  return `Answer the plan's questions in Plannotator before approving: ${listed}. Approving there sends the answers with the approval.`;
}

// Runtime-selected: the package lives in omp's plugin directory (locateHost), as for the host.
const CHECK_SOURCE = String.raw`const [pkg, file] = process.argv.slice(-2);
const questions = await import(pkg + "/generated/question-block.ts");
if (typeof questions.unansweredQuestions !== "function") process.stdout.write(JSON.stringify({ unsupported: true }));
else process.stdout.write(JSON.stringify({ unanswered: questions.unansweredQuestions(await Bun.file(file).text(), []) }));`;

// The questions an approval without answers still waits on, in document order.
export async function unansweredQuestions(plan: string, locate: () => HostLocation | null = () => locateHost()): Promise<UnansweredQuestion[]> {
  // No question block can exist without its opener; most plans have none, and need no Bun.
  if (!plan.includes(":::question")) return [];
  const found = locate();
  if (!found) throw new QuestionsUnansweredError("The plan has questions, and they cannot be checked here (needs Bun and omp's @plannotator/pi-extension). Approve it on Plannotator's page.");
  const directory = await mkdtemp(join(tmpdir(), "linear-tickets-plan-"));
  try {
    const file = join(directory, "plan.md");
    await writeFile(file, plan, { mode: 0o600 });
    const { stdout } = await execFile(found.bun, ["--eval", CHECK_SOURCE, found.plannotator, file], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout) as { unsupported?: true; unanswered?: UnansweredQuestion[] };
    if (result.unsupported || !Array.isArray(result.unanswered)) throw new QuestionsUnansweredError(`The plan has questions, and the installed Plannotator (${found.plannotator}) cannot check their answers. Approve it on Plannotator's page.`);
    return result.unanswered;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Refuses an approval while the plan has questions it would leave unanswered.
export async function requireAnsweredQuestions(plan: string, check: (plan: string) => Promise<UnansweredQuestion[]>): Promise<void> {
  const unanswered = await check(plan);
  if (unanswered.length > 0) throw new QuestionsUnansweredError(questionsUnansweredMessage(unanswered));
}
