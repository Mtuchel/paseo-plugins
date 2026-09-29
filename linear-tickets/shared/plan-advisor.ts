// Plan advisor (README, "Plan advisor"): every ticket plan gets a second opinion from GPT-6 Astra
// before the owner reviews it. Shared by the server (launch instructions) and the omp extension
// (omp/linear-tickets-plan-first.ts), which blocks plan submission until the advice is recorded.
// Dependency-free: the extension imports it from outside the plugin's build.

export const ADVISOR_PROVIDER = "omp/openai-codex/gpt-6-astra";
// The model id Paseo reports for an omp agent started with ADVISOR_PROVIDER.
export const ADVISOR_MODEL = "openai-codex/gpt-6-astra";
export const ADVISOR_THINKING = "medium";
export const ADVISOR_MAX_ROUNDS = 3;
export const ADVISOR_SECTION = "Advisor review";
export const RECORD_ADVICE_TOOL = "record_plan_advice";

// The steps the planner follows. `contextPath`: the saved ticket prompt when known (the extension
// knows it); undefined points at the environment variable (launch instructions, written before the
// save); null means the launch could not save it. `omp`: the planner has the extension's record
// tool and submission gate.
export function advisorSteps(options: { contextPath?: string | null; omp: boolean }): string {
  const context = options.contextPath
    ? `saved at \`${options.contextPath}\``
    : options.contextPath === null
      ? "which could not be saved to a file (paste it into its prompt),"
      : "saved at the file named by the `LINEAR_TICKETS_CONTEXT` environment variable";
  const steps = [
    `Plan advisor: before the owner sees your plan, a GPT-6 Astra advisor reviews it with the same ticket context, and you settle its points together.`,
    `1. Create the advisor with the Paseo \`create_agent\` tool: provider \`${ADVISOR_PROVIDER}\`, thinkingOptionId \`${ADVISOR_THINKING}\`, modeId \`full\`, in your own workspace (the default). Tell it that it is a read-only plan advisor (no edits, commits, pushes or comments) and give it: the ticket exactly as you received it, ${context} to read first; the absolute path of your plan file; what you learned while investigating (relevant files, constraints, options you rejected and why); and the question whether this is the right plan for the ticket (scope, approach, risks, missing steps, acceptance criteria, tests), answered as must-change points and suggestions, or agreement.`,
    `2. Adopt each point into the plan or answer it with a reason. Send your changes and answers to the same advisor with \`send_agent_prompt\` (it keeps its context) until you agree, at most ${ADVISOR_MAX_ROUNDS} rounds.`,
    `3. End the plan with a \`## ${ADVISOR_SECTION}\` section: the advisor's model, the number of rounds, what changed because of it, and every point you still disagree on with both positions, so the owner decides.`,
    options.omp
      ? `4. Call \`${RECORD_ADVICE_TOOL}\` with the plan file, the advisor's agent id and the verdict, then submit the plan without editing it again. If the advisor cannot be created, state in the \`## ${ADVISOR_SECTION}\` section that it was unavailable and why, and call \`${RECORD_ADVICE_TOOL}\` with verdict \`unavailable\` and that same reason.`
      : `If the advisor cannot be created, explain why in the \`## ${ADVISOR_SECTION}\` section.`,
  ];
  return steps.join("\n");
}
