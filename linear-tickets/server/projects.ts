import { execFile } from "./child-processes";
import type { PaseoApi, PaseoProject } from "@getpaseo/client";

export class ProjectUnavailableError extends Error {}

const PROJECTS_TTL_MS = 60_000;
const projectLists = new WeakMap<PaseoApi, { at: number; flight: Promise<PaseoProject[]> }>();

// One start asks for its project up to six times (mapping, shard pool, shard, launch), and the
// daemon answers every project.list by describing each project through its shared git queue
// (0.5 s and more on server087). One listing per daemon connection therefore serves a minute, and
// a project it does not name is looked up afresh, so a project added since is still found.
export function listProjects(paseo: PaseoApi, options: { fresh?: boolean } = {}): Promise<PaseoProject[]> {
  const kept = projectLists.get(paseo);
  if (kept && !options.fresh && Date.now() - kept.at < PROJECTS_TTL_MS) return kept.flight;
  const entry = { at: Date.now(), flight: paseo.projects.list().then((result) => result.projects) };
  projectLists.set(paseo, entry);
  entry.flight.catch(() => { if (projectLists.get(paseo) === entry) projectLists.delete(paseo); });
  return entry.flight;
}

export async function findProject(paseo: PaseoApi, id: string) {
  const named = (projects: PaseoProject[]) => projects.find((item) => item.projectId === id && item.projectRootPath);
  const project = named(await listProjects(paseo)) ?? named(await listProjects(paseo, { fresh: true }));
  if (!project?.projectRootPath) throw new ProjectUnavailableError("This project is no longer available. Refresh projects and select one again.");
  return project;
}

export async function readBranches(path: string) {
  const git = (args: string[]) => execFile("git", ["-C", path, ...args], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const results = await Promise.allSettled([
    git(["for-each-ref", "--format=%(refname)%09%(refname:short)%09%(symref)", "refs/heads", "refs/remotes"]),
    git(["symbolic-ref", "--quiet", "HEAD"]),
  ]);
  const refs = results[0];
  if (refs.status === "rejected") throw new Error("Could not read this project's Git branches. Check that its checkout is available.");
  const branches = refs.value.stdout.split("\n").filter(Boolean).flatMap((line) => {
    const [id, label, symbolic] = line.split("\t");
    return id && label && !symbolic ? [{ id, label }] : [];
  }).sort((a, b) => a.label.localeCompare(b.label));
  const head = results[1].status === "fulfilled" ? results[1].value.stdout.trim() : "";
  return { branches, defaultBranch: branches.some((branch) => branch.id === head) ? head : null };
}

export async function projectBranches(paseo: PaseoApi, id: string) {
  const project = await findProject(paseo, id);
  if (project.projectKind !== "git") return { branches: [], defaultBranch: null };
  return readBranches(project.projectRootPath);
}
