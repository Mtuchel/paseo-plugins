import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function githubShimDir(home: string = homedir()): string {
  return join(home, ".local", "bin");
}

export function githubCli(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.LINEAR_TICKETS_GH) return env.LINEAR_TICKETS_GH;
  const shim = join(githubShimDir(home), "gh");
  if (existsSync(shim)) return shim;
  if (existsSync("/opt/homebrew/bin/gh")) return "/opt/homebrew/bin/gh";
  if (existsSync("/usr/local/bin/gh")) return "/usr/local/bin/gh";
  return "gh";
}

// A custom CLI path alone does not imply two-account budgeting.
export function githubRouted(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): boolean {
  if (env.LINEAR_TICKETS_GITHUB_ROUTED === "1") return true;
  if (env.LINEAR_TICKETS_GH) return false;
  const paseo = env.PASEO_HOME?.replace(/^~(?=\/|$)/, home) || join(home, ".paseo");
  return existsSync(join(paseo, "bin", "github-router.mjs")) && existsSync(join(githubShimDir(home), "gh"));
}
