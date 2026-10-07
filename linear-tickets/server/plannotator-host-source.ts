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
// parked again) gets a new server.
//
// The host outlives plugin reloads (the plugin adopts it through the heartbeat in
// LINEAR_TICKETS_PLANNOTATOR_HOST_STATE), so an open review page keeps its server. It exits on its
// own once the plugin's own heartbeat (LINEAR_TICKETS_PLANNOTATOR_PLUGIN_ALIVE) is older than
// LINEAR_TICKETS_PLANNOTATOR_ORPHAN_MS: the plugin was disabled or removed. When it does restart,
// each issue's review comes back on the port it had (LINEAR_TICKETS_PLANNOTATOR_PORTS), so a page
// left open reaches the new server, which asks it to reload instead of taking a decision meant for
// the old one; Plannotator's unsent annotations are kept per plan text and come back with the page.
// A plan whose decision is recorded but not yet handed on (an undelivered `decided` event) is not
// served again.
export const PLANNOTATOR_HOST_SOURCE = String.raw`import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const PARKED = process.env.LINEAR_TICKETS_PARKED;
const EVENTS = process.env.LINEAR_TICKETS_PLANNOTATOR_EVENTS;
const OPEN = process.env.LINEAR_TICKETS_PLANNOTATOR_OPEN;
const PACKAGE = process.env.LINEAR_TICKETS_PLANNOTATOR_PACKAGE;
const STATE = process.env.LINEAR_TICKETS_PLANNOTATOR_HOST_STATE;
const PORTS = process.env.LINEAR_TICKETS_PLANNOTATOR_PORTS;
const PLUGIN_ALIVE = process.env.LINEAR_TICKETS_PLANNOTATOR_PLUGIN_ALIVE;
const VERSION = process.env.LINEAR_TICKETS_PLANNOTATOR_HOST_VERSION || "";
const SWEEP_MS = Number(process.env.LINEAR_TICKETS_PARKED_SWEEP_MS) || 2000;
const ORPHAN_MS = Number(process.env.LINEAR_TICKETS_PLANNOTATOR_ORPHAN_MS) || 600000;
const RANGE = /^(\d{1,5})-(\d{1,5})$/.exec(process.env.LINEAR_TICKETS_PLANNOTATOR_PORT_RANGE || "28600-28699");
const FIRST_PORT = Number(RANGE?.[1] ?? 28600);
const LAST_PORT = Math.max(FIRST_PORT, Number(RANGE?.[2] ?? 28699));
const STARTED = Date.now();

// Runtime-selected: the package lives in omp's plugin directory, found by the plugin at start.
const { startPlanReviewServer } = await import(join(PACKAGE, "server", "serverPlan.ts"));
const html = readFileSync(join(PACKAGE, "plannotator.html"), "utf8");
// Record key (issue and parkedAt) -> its running server; decided keys stay until the record goes.
const served = new Map();
const decided = new Set();

function writeAtomic(path, text) {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

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

// The parked decisions still waiting in the event queue (Linear refused them so far). Event files
// are written once (renamed into place), so each is read once.
const decisions = new Map();
function pendingDecisions() {
  let names = [];
  try { names = readdirSync(EVENTS).filter((name) => name.endsWith(".json") && !name.startsWith(".")); } catch {}
  const present = new Set(names);
  for (const name of decisions.keys()) if (!present.has(name)) decisions.delete(name);
  for (const name of names) {
    if (decisions.has(name)) continue;
    let found = null;
    try {
      const event = JSON.parse(readFileSync(join(EVENTS, name), "utf8"));
      if (event && event.type === "decided" && event.parked === true && typeof event.agentId === "string") found = { agentId: event.agentId, at: String(event.at ?? "") };
    } catch {}
    decisions.set(name, found);
  }
  return [...decisions.values()].filter(Boolean);
}

// Issue -> port, kept while the issue is parked. New issues take the next free port of the range
// in turn, so a port freed by a decided plan is not handed straight to the next one.
function readPorts() {
  try {
    const stored = JSON.parse(readFileSync(PORTS, "utf8"));
    if (stored && typeof stored.ports === "object" && stored.ports) return { next: Number(stored.next) || FIRST_PORT, ports: stored.ports };
  } catch {}
  return { next: FIRST_PORT, ports: {} };
}
let ports = readPorts();
const savePorts = () => { try { writeAtomic(PORTS, JSON.stringify(ports)); } catch (error) { console.error("saving review ports failed: " + (error instanceof Error ? error.message : error)); } };

// Something already answers on the port (another program, or a server not yet closed).
function answers(port) {
  const { promise, resolve } = Promise.withResolvers();
  const socket = connect({ port, host: "127.0.0.1" });
  const done = (result) => { socket.destroy(); resolve(result); };
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  socket.setTimeout(1000, () => done(false));
  return promise;
}

async function portFor(issueId, avoid) {
  const kept = ports.ports[issueId];
  if (Number.isInteger(kept) && !avoid.has(kept) && !await answers(kept)) return kept;
  const taken = new Set(Object.entries(ports.ports).filter(([id]) => id !== issueId).map(([, port]) => port));
  const span = LAST_PORT - FIRST_PORT + 1;
  const start = Math.min(Math.max(ports.next, FIRST_PORT), LAST_PORT) - FIRST_PORT;
  for (let step = 0; step < span; step++) {
    const port = FIRST_PORT + (start + step) % span;
    if (taken.has(port) || avoid.has(port) || await answers(port)) continue;
    ports = { next: port === LAST_PORT ? FIRST_PORT : port + 1, ports: { ...ports.ports, [issueId]: port } };
    savePorts();
    return port;
  }
  return 0;
}

// Plannotator takes its port from PLANNOTATOR_PORT; servers start one at a time (sweep awaits
// each), so setting it around one start is safe. 0: a random port (the range is exhausted).
async function startOn(port, plan) {
  const previous = process.env.PLANNOTATOR_PORT;
  if (port) process.env.PLANNOTATOR_PORT = String(port); else delete process.env.PLANNOTATOR_PORT;
  try {
    return await startPlanReviewServer({ plan: plan.plan, htmlContent: html, origin: "pi" });
  } finally {
    if (previous === undefined) delete process.env.PLANNOTATOR_PORT; else process.env.PLANNOTATOR_PORT = previous;
  }
}

async function serve(key, plan) {
  const avoid = new Set();
  let server = null;
  while (!server) {
    const port = await portFor(plan.issueId, avoid);
    try { server = await startOn(port, plan); } catch (error) {
      if (!port || !/in use/i.test(error instanceof Error ? error.message : String(error))) throw error;
      console.error("port " + port + " for " + plan.identifier + " is taken; trying another");
      avoid.add(port);
    }
  }
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

function heartbeat() {
  if (!STATE) return;
  try { writeAtomic(STATE, JSON.stringify({ pid: process.pid, version: VERSION, at: new Date().toISOString() })); } catch (error) { console.error("heartbeat failed: " + (error instanceof Error ? error.message : error)); }
}

function orphaned() {
  if (!PLUGIN_ALIVE) return false;
  let seen = STARTED;
  try { seen = Math.max(seen, statSync(PLUGIN_ALIVE).mtimeMs); } catch {}
  return Date.now() - seen > ORPHAN_MS;
}

function shutdown() {
  for (const server of served.values()) server.stop();
  process.exit(0);
}

async function sweep() {
  if (orphaned()) {
    console.log("the plugin has been gone for " + Math.round(ORPHAN_MS / 60000) + " minutes; stopping");
    shutdown();
  }
  heartbeat();
  const plans = parkedPlans();
  const pending = pendingDecisions();
  for (const [key, server] of served) if (!plans.has(key)) { server.stop(); served.delete(key); }
  for (const key of decided) if (!plans.has(key)) decided.delete(key);
  const issues = new Set([...plans.values()].map((plan) => plan.issueId));
  if (Object.keys(ports.ports).some((issueId) => !issues.has(issueId))) {
    ports = { next: ports.next, ports: Object.fromEntries(Object.entries(ports.ports).filter(([issueId]) => issues.has(issueId))) };
    savePorts();
  }
  for (const [key, plan] of plans) {
    if (served.has(key) || decided.has(key)) continue;
    if (pending.some((decision) => decision.agentId === plan.agentId && decision.at >= String(plan.parkedAt ?? ""))) { decided.add(key); continue; }
    try { await serve(key, plan); } catch (error) { console.error("serving " + plan.identifier + " failed: " + (error instanceof Error ? error.message : error)); }
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
let busy = false;
const tick = () => {
  if (busy) return;
  busy = true;
  sweep().catch((error) => console.error("sweep failed: " + (error instanceof Error ? error.message : error))).finally(() => { busy = false; });
};
setInterval(tick, SWEEP_MS);
tick();
`;
