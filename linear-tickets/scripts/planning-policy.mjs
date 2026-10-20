#!/usr/bin/env node
// Keep manual Plannotator planning on the same strong model as ticket planning.
// Run explicitly after reviewing the host's configured OMP planning model.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const check = args[0] === "--check";
const path = resolve(args[check ? 1 : 0] ?? "");
if (args.length !== (check ? 2 : 1)) {
  console.error("Usage: node scripts/planning-policy.mjs [--check] /absolute/path/to/plannotator.json");
  process.exit(1);
}
const original = readFileSync(path, "utf8");
const config = JSON.parse(original);
const planning = config?.phases?.planning;
if (!planning || typeof planning !== "object" || Array.isArray(planning)) {
  throw new Error("Expected an existing phases.planning profile; refusing to replace the configuration.");
}
const model = { provider: "anthropic", id: "claude-opus-5-5" };
const matches = planning.model?.provider === model.provider && planning.model?.id === model.id && planning.thinking === "high";
if (check) {
  console.log(JSON.stringify({ path, matches, model: planning.model ?? null, thinking: planning.thinking ?? null }));
  process.exit(matches ? 0 : 2);
}
if (matches) {
  console.log(JSON.stringify({ path, changed: false, model, thinking: "high" }));
} else {
  const backup = `${path}.before-parallel-policy-${new Date().toISOString().replaceAll(":", "-")}.bak`;
  writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
  planning.model = model;
  planning.thinking = "high";
  const temporary = `${path}.parallel-policy-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  console.log(JSON.stringify({ path, changed: true, backup, model, thinking: "high" }));
}
