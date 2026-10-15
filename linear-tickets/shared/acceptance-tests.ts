// The acceptance tests a cheap-tier plan names (README, "Model tiers"): the plan's `## Model`
// section lists the test files that prove it, the implementing agent hands the strong model the
// job of writing them failing first, and the cheap model must not edit them afterwards. The plugin
// writes the plan's paths for that agent (`server/acceptance-tests.ts`); the omp extension
// (`omp/linear-tickets-plan-first.ts`) reads them and refuses a write from a session that is not on
// the strong model. Both sides share the rules below and the dependency-free fallback selector module
// (the omp extension loads these from outside the plugin's build).
//
// A guard against accidental routing, not isolation: `bash` can still write those files, and the
// `escalate_model` tool lifts the block by moving the agent to the strong model, which is the point
// — a cheap session that turns out to need the tests changed asks for the strong model.
import { fallbackSpecs, type FallbackChains } from "./model-fallbacks";

export const STRONG_MODEL_ENV = "LINEAR_TICKETS_STRONG_MODEL";

// What the plugin wrote for one implementing agent: the ticket it belongs to and the plan's test
// paths, as the planner wrote them (usually relative to the ticket's checkout).
export type AcceptanceTests = { identifier: string; paths: string[] };

const WRITE_TOOLS = new Set(["write", "edit", "ast_edit"]);
// An edit's patch text names its targets only in its headers (omp's apply_patch form).
const PATCH_HEADERS = /^\*\*\* (?:(?:Update|Add|Delete) File|Move to): (.+)$/gm;

// The file paths a write-ish tool call would write. omp names them in `path` (`write`, `edit`,
// `ast_edit`), in `paths` (an edit's patch targets) or only in an apply_patch input's headers. The
// xd:// device form is a `write` to `xd://<device>` whose `content` is that device's JSON
// arguments (the Linear write guard reads a device the same way), so the device's own write fields
// are read out of it.
export function writtenPaths(toolName: string, input: Record<string, unknown> | undefined): string[] {
  const paths = new Set<string>();
  const collect = (tool: string, call: Record<string, unknown> | undefined, depth: number): void => {
    if (!call || depth > 3) return;
    const path = typeof call.path === "string" ? call.path.trim() : "";
    if (tool === "write" && path.startsWith("xd://")) {
      let args: unknown;
      try { args = JSON.parse(typeof call.content === "string" ? call.content : ""); } catch { return; }
      if (args && typeof args === "object" && !Array.isArray(args)) collect(path.slice("xd://".length).replace(/^\/+/, ""), args as Record<string, unknown>, depth + 1);
      return;
    }
    if (!WRITE_TOOLS.has(tool)) return;
    if (path) paths.add(path);
    if (Array.isArray(call.paths)) for (const each of call.paths) if (typeof each === "string" && each.trim()) paths.add(each.trim());
    if (typeof call.input === "string") for (const match of call.input.matchAll(PATCH_HEADERS)) if (match[1]?.trim()) paths.add(match[1].trim());
  };
  collect(toolName, input, 0);
  return [...paths];
}

// Whether two paths name the same file: the plan writes `server/foo.test.ts` while the tool may
// write `/Users/x/checkout/server/foo.test.ts`, so a full path-segment suffix counts either way.
function samePath(written: string, test: string): boolean {
  const clean = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const left = clean(written);
  const right = clean(test);
  return Boolean(left) && Boolean(right) && (left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`));
}

// The protected test path a write-ish call would write, or null. `tests`: what the plugin wrote
// for this agent, null when it wrote nothing (a strong plan, `none`, or no plan at all).
export function protectedWrite(tests: AcceptanceTests | null | undefined, toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!tests?.paths.length) return null;
  for (const path of writtenPaths(toolName, input)) {
    const found = tests.paths.find((test) => samePath(path, test));
    if (found) return found;
  }
  return null;
}

// Only the owner-approved strong substitution is a capability, not every configured fallback.
// In particular, routing a strong model to Flash must not grant Flash test-writing authority.
export type StrongFallback = { chains: FallbackChains | null; thinking: string | undefined };
export function isStrongModel(current: { provider?: string; id?: string } | undefined | null, spec: string | null | undefined, fallback?: StrongFallback): boolean {
  const wanted = (spec ?? "").trim().replace(/^omp\//, "");
  if (!wanted || !current?.id) return false;
  const running = `${current.provider ?? ""}/${current.id}`;
  if (running === wanted) return true;
  return wanted === "anthropic/claude-opus-5-5"
    && running === "openai-codex/gpt-6.1-sol"
    && fallback?.thinking === "high"
    && Boolean(fallback.chains && fallbackSpecs(fallback.chains, wanted).includes("openai-codex/gpt-6.1-sol:high"));
}

// The protected path a session may not write, or null. A session on the strong model may write the
// tests (it is the model that wrote them), and so may one whose launch did not record the strong
// model: the guard exists to catch accidental routing, and a wrong refusal would stop exactly the
// work it protects.
export function blockedTestWrite(tests: AcceptanceTests | null | undefined, toolName: string, input: Record<string, unknown> | undefined, current: { provider?: string; id?: string } | undefined | null, spec: string | null | undefined, fallback?: StrongFallback): string | null {
  if (!spec || isStrongModel(current, spec, fallback)) return null;
  return protectedWrite(tests, toolName, input);
}