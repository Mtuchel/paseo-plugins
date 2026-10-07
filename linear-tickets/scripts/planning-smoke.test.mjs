import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkHooks, configuredExtensions, extensionInputs, fingerprint, RETRY_FAILED_MS, sessionVerdict, shouldRun, smokePaths } from "./planning-smoke.mjs";

const lines = (...entries) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const launch = { type: "custom", customType: "linear-tickets.plan-first", data: { reason: "launch", policy: "required" } };
const user = { type: "message", message: { role: "user", content: "Reply OK." } };
const framing = { type: "custom_message", customType: "plannotator-framing", content: "[PLANNOTATOR - PLANNING PHASE]" };
const reply = { type: "message", message: { role: "assistant", content: "OK" } };

test("a session that entered planning with the framing before the first reply passes", () => {
  assert.equal(sessionVerdict(lines({ type: "session" }, launch, user, framing, reply)), null);
});

test("a planning session without the framing fails the framing check", () => {
  assert.deepEqual(sessionVerdict(lines(launch, user, reply)), { check: "framing", detail: "Plannotator planning framing missing before the first reply" });
});

test("a framing delivered only after the first reply counts as missing", () => {
  assert.equal(sessionVerdict(lines(launch, user, reply, framing, reply)).check, "framing");
});

test("a session without the launch marker, or without a reply, is a launch failure", () => {
  assert.deepEqual(sessionVerdict(lines(user, framing, reply)), { check: "launch", detail: "planning not entered (no plan-first launch marker)" });
  // An owner-requested re-entry is not the launch.
  assert.equal(sessionVerdict(lines({ ...launch, data: { reason: "owner" } }, user, framing, reply)).check, "launch");
  assert.deepEqual(sessionVerdict(lines(launch, user, framing)), { check: "launch", detail: "no assistant reply" });
});

test("the extensions list is read from omp's config: block items, quotes, comments, ~ and relative paths", () => {
  const config = [
    "model: x",
    "extensions:",
    "  # the guards",
    "  - ~/.omp/agent/hooks/a.mjs",
    "  - \"/abs/b.mjs\"",
    "  - hooks/c.mjs # relative",
    "",
    "dev:",
    "  - not-an-extension",
  ].join("\n");
  assert.deepEqual(configuredExtensions(config, "/home/u/.omp/agent/config.yml", "/home/u"), ["/home/u/.omp/agent/hooks/a.mjs", "/abs/b.mjs", "/home/u/.omp/agent/hooks/c.mjs"]);
  assert.deepEqual(configuredExtensions("extensions: [~/a.mjs, '/b.mjs']\n", "/home/u/.omp/agent/config.yml", "/home/u"), ["/home/u/a.mjs", "/b.mjs"]);
  assert.deepEqual(configuredExtensions("model: x\n", "/c.yml", "/home/u"), []);
});

function ompHome(t) {
  const home = mkdtempSync(join(tmpdir(), "planning-smoke-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = join(home, ".omp", "agent");
  mkdirSync(join(agent, "hooks"), { recursive: true });
  mkdirSync(join(agent, "extensions"));
  mkdirSync(join(home, ".omp", "plugins", "node_modules", "@plannotator", "pi-extension"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(home, "checkout"));
  const files = {
    config: join(agent, "config.yml"),
    hook: join(agent, "hooks", "guard.mjs"),
    extension: join(agent, "extensions", "own.ts"),
    linked: join(home, "checkout", "plan-first.ts"),
    lock: join(home, ".omp", "plugins", "omp-plugins.lock.json"),
    plannotator: join(home, ".omp", "plugins", "node_modules", "@plannotator", "pi-extension", "package.json"),
    plannotatorConfig: join(home, ".pi", "agent", "plannotator.json"),
  };
  writeFileSync(files.config, "extensions:\n  - ~/.omp/agent/hooks/guard.mjs\n");
  writeFileSync(files.hook, "export default function () {}\n");
  writeFileSync(files.extension, "export default function () {}\n");
  writeFileSync(files.linked, "export default function () {}\n");
  symlinkSync(files.linked, join(agent, "extensions", "plan-first.ts"));
  writeFileSync(files.lock, "{\"plugins\":{}}\n");
  writeFileSync(files.plannotator, "{\"version\":\"0.28.6\"}\n");
  writeFileSync(files.plannotatorConfig, "{}\n");
  const paths = smokePaths({ home, env: {} });
  const print = async (version = "omp/18.7.0") => fingerprint(paths, version, await extensionInputs(paths));
  return { home, files, paths, print };
}

test("the fingerprint is stable, and changes with each input it covers", async (t) => {
  const { files, print } = ompHome(t);
  const base = await print();
  assert.equal(await print(), base);
  assert.notEqual(await print("omp/18.8.0"), base);
  const changes = [
    [files.config, "extensions:\n  - ~/.omp/agent/hooks/guard.mjs\nmodel: y\n"],
    [files.hook, "export default function (pi) { pi.on('x', () => {}); }\n"],
    [files.extension, "export default function (pi) {}\n"],
    // The extensions directory's symlink is hashed by its target's content.
    [files.linked, "export default function (pi) {}\n"],
    [files.lock, "{\"plugins\":{\"a\":{}}}\n"],
    [files.plannotator, "{\"version\":\"0.29.0\"}\n"],
    [files.plannotatorConfig, "{\"template\":\"# Part 1\"}\n"],
  ];
  let previous = base;
  for (const [path, content] of changes) {
    writeFileSync(path, content);
    const next = await print();
    assert.notEqual(next, previous, `${path} must change the fingerprint`);
    previous = next;
  }
});

test("missing inputs hash as absent instead of failing", async (t) => {
  const { files, print } = ompHome(t);
  const base = await print();
  rmSync(files.plannotatorConfig);
  rmSync(files.hook);
  const missing = await print(null);
  assert.match(missing, /^[0-9a-f]{64}$/);
  assert.notEqual(missing, base);
  rmSync(join(files.config, ".."), { recursive: true, force: true });
  assert.match(await print(null), /^[0-9a-f]{64}$/);
});

test("--if-changed runs only for a new fingerprint, and retries a failure at most hourly", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const at = (ms) => new Date(now - ms).toISOString();
  const stored = (ok, age, fingerprint = "a") => ({ version: 1, checkedAt: at(age), fingerprint, ok, failures: [] });
  assert.equal(shouldRun(null, "a", now), true);
  assert.equal(shouldRun(stored(true, 0, "b"), "a", now), true);
  assert.equal(shouldRun(stored(true, 7 * 24 * 3600_000), "a", now), false);
  assert.equal(shouldRun(stored(false, 0), "a", now), false);
  assert.equal(shouldRun(stored(false, RETRY_FAILED_MS - 1), "a", now), false);
  assert.equal(shouldRun(stored(false, RETRY_FAILED_MS), "a", now), true);
  // A failure for another fingerprint does not hold a new one back.
  assert.equal(shouldRun(stored(false, 0, "b"), "a", now), true);
});

test("the hook check flags an extension returning systemPrompt, passes a silent one, and reports an unloadable one as not checked", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "planning-smoke-hooks-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name, source) => { writeFileSync(join(directory, name), source); return join(directory, name); };
  const appends = write("appends.mjs", `export default function (pi) {
    pi.on("before_agent_start", async (event) => ({ systemPrompt: event.systemPrompt + "\\n\\nextra policy" }));
  }`);
  // Registered lazily, from session_start, as omp would run it first.
  const lazy = write("lazy.mjs", `export default function (pi) {
    pi.on("session_start", () => { pi.on("before_agent_start", () => ({ systemPrompt: "replaced" })); });
  }`);
  const silent = write("silent.ts", `type Ctx = { models: { current(): { provider: string } | undefined } };
  export default function (pi: any): void {
    pi.registerTool({ name: "t", parameters: pi.typebox.Type.Object({}) });
    pi.on("before_agent_start", async (_event: unknown, ctx: Ctx) => {
      if (ctx.models.current()?.provider.startsWith("deepseek")) return { systemPrompt: "never here" };
      pi.events.emit("x", {});
      return { message: { customType: "note", content: "hi" } };
    });
  }`);
  const broken = write("broken.mjs", "throw new Error('needs Bun');\n");
  const throwing = write("throwing.mjs", `export default function (pi) {
    pi.on("before_agent_start", () => { throw new Error("needs a real session"); });
  }`);
  const report = await checkHooks([appends, lazy, silent, broken, throwing, join(directory, "gone.mjs")]);
  assert.deepEqual(report.flagged, [appends, lazy]);
  assert.deepEqual(report.checked, [silent]);
  assert.deepEqual(report.notChecked.map((entry) => entry.path), [broken, throwing, join(directory, "gone.mjs")]);
  assert.match(report.notChecked[0].reason, /import failed: needs Bun/);
  assert.match(report.notChecked[1].reason, /1 before_agent_start handler\(s\) failed under the stub: needs a real session/);
});
