// The central Plannotator host (README, "Parked plans"), run with Bun by the plugin (parked.ts):
// Plannotator's plan server is TypeScript inside omp's plugin directory, which Bun imports as is.
// Every parked plan (a JSON record in LINEAR_TICKETS_PARKED) gets Plannotator's own review server,
// so the owner reviews it with the full Plannotator page although its agent was retired. Then
//   1. the PLANNOTATOR_BROWSER hook (LINEAR_TICKETS_PLANNOTATOR_OPEN) runs with the parked agent's
//      id, exactly as for an agent's review: it publishes the port in the tailnet and records an
//      `opened` event, so stable links, the inbox and the Linear panel work unchanged;
//   2. the owner's decision is recorded as a `decided` event marked `parked`, which only this host
//      and the plugin's risk policy (a parked plan approved once its advisor review is recorded)
//      write; the server stops a few seconds later (Plannotator's page reads the result first).
// A record the plugin removed stops its server. A record changed to a new `parkedAt` (the plan was
// parked again) gets a new server. Restarted hosts serve every record again, on new ports.
export const PLANNOTATOR_HOST_SOURCE = String.raw`import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PARKED = process.env.LINEAR_TICKETS_PARKED;
const EVENTS = process.env.LINEAR_TICKETS_PLANNOTATOR_EVENTS;
const OPEN = process.env.LINEAR_TICKETS_PLANNOTATOR_OPEN;
const PACKAGE = process.env.LINEAR_TICKETS_PLANNOTATOR_PACKAGE;
const SWEEP_MS = Number(process.env.LINEAR_TICKETS_PARKED_SWEEP_MS) || 2000;

// Runtime-selected: the package lives in omp's plugin directory, found by the plugin at start.
const { startPlanReviewServer } = await import(join(PACKAGE, "server", "serverPlan.ts"));
const html = readFileSync(join(PACKAGE, "plannotator.html"), "utf8");
// Record key (issue and parkedAt) -> its running server; decided keys stay until the record goes.
const served = new Map();
const decided = new Set();

function record(event) {
  mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
  const name = Date.now() + "-" + randomUUID() + ".json";
  const temporary = join(EVENTS, "." + name + ".tmp");
  writeFileSync(temporary, JSON.stringify(event), { mode: 0o600 });
  renameSync(temporary, join(EVENTS, name));
}

function parkedPlans() {
  mkdirSync(PARKED, { recursive: true, mode: 0o700 });
  const plans = new Map();
  for (const name of readdirSync(PARKED)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    try {
      const plan = JSON.parse(readFileSync(join(PARKED, name), "utf8"));
      if (typeof plan.issueId === "string" && typeof plan.agentId === "string" && typeof plan.plan === "string") plans.set(plan.issueId + "@" + plan.parkedAt, plan);
    } catch {}
  }
  return plans;
}

async function serve(key, plan) {
  const server = await startPlanReviewServer({ plan: plan.plan, htmlContent: html, origin: "pi" });
  served.set(key, server);
  server.onDecision((decision) => {
    if (decided.has(key)) return;
    decided.add(key);
    record({ type: "decided", parked: true, agentId: plan.agentId, approved: decision.approved === true, ...(typeof decision.feedback === "string" && decision.feedback.trim() ? { feedback: decision.feedback } : {}), planContent: plan.plan, at: new Date().toISOString() });
    setTimeout(() => { server.stop(); served.delete(key); }, 5000);
  });
  spawn(OPEN, [server.url], { env: { ...process.env, PASEO_AGENT_ID: plan.agentId }, stdio: "ignore" }).on("error", (error) => console.error("opening " + plan.identifier + " failed: " + error.message));
  console.log("serving " + plan.identifier + " at " + server.url);
}

async function sweep() {
  const plans = parkedPlans();
  for (const [key, server] of served) if (!plans.has(key)) { server.stop(); served.delete(key); }
  for (const key of decided) if (!plans.has(key)) decided.delete(key);
  for (const [key, plan] of plans) {
    if (served.has(key) || decided.has(key)) continue;
    try { await serve(key, plan); } catch (error) { console.error("serving " + plan.identifier + " failed: " + (error instanceof Error ? error.message : error)); }
  }
}

let busy = false;
const tick = () => {
  if (busy) return;
  busy = true;
  sweep().catch((error) => console.error("sweep failed: " + (error instanceof Error ? error.message : error))).finally(() => { busy = false; });
};
setInterval(tick, SWEEP_MS);
tick();
`;
