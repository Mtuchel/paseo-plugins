// The four verdicts of Paseo's own plugin build, run through this checkout's tool against
// throwaway fixture plugins: what Paseo refuses and what it builds. The tool uses the Paseo on
// PATH, so these tests fail rather than skip when it is missing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("./paseo-build.mjs", import.meta.url));

function run(pluginDir, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, pluginDir], { env: { ...process.env, ...env } });
    const out = [], err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("close", (code, signal) => resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), code, signal }));
  });
}

let counter = 0;
// A fixture plugin: the manifest plus the entry files, keyed by path relative to the plugin
// directory. No dependencies, no node_modules; the test that asked for it removes it.
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), `paseo-build-${process.pid}-${++counter}-`));
  writeFileSync(join(dir, "paseo-plugin.json"), JSON.stringify({ id: "fixture", requirements: { paseo: ">=0.8.0" } }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

test("a shared module importing a Node module is refused as a shared-bundle violation", async (t) => {
  const dir = fixture({
    "index.server.ts": 'export { read } from "./shared/read.ts";\n',
    "shared/read.ts": 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, stdout, stderr } = await run(dir);
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.ok(stderr.includes("Node module cannot be imported into the plugin shared bundle"), stderr);
});

test("a module outside client/, server/ and shared/ is refused", async (t) => {
  const dir = fixture({
    "index.server.ts": 'import "./scripts/x.mjs";\n',
    "scripts/x.mjs": "export const x = 1;\n",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, stdout, stderr } = await run(dir);
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.ok(stderr.includes("Plugin modules belong in client/, server/, or shared/"), stderr);
});

test("a server entry importing a server module builds", async (t) => {
  const dir = fixture({
    "index.server.ts": 'export { x } from "./server/x.ts";\n',
    "server/x.ts": "export const x = 1;\n",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, stdout, stderr } = await run(dir);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /^Paseo \S+ builds fixture\n$/);
});

test("a Paseo without a plugin build entry is an error, not a pass", async (t) => {
  const dir = fixture({ "index.server.ts": "export const x = 1;\n" });
  const stub = mkdtempSync(join(tmpdir(), `paseo-build-stub-${process.pid}-`));
  writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@getpaseo/server", version: "9.9.9" }));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stub, { recursive: true, force: true });
  });
  const { code, stdout, stderr } = await run(dir, { PASEO_SERVER_DIR: stub });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "Paseo 9.9.9 refuses fixture: Paseo 9.9.9 has no plugin build entry this check knows; update tools/paseo-build.mjs\n");
});
