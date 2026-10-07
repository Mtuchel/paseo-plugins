import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";

const exec = promisify(execFile);

export class ProjectUnavailableError extends Error {}

export async function findProject(paseo: PaseoApi, id: string) {
  const result = await paseo.projects.list();
  const project = result.projects.find((item) => item.projectId === id);
  if (!project?.projectRootPath) throw new ProjectUnavailableError("This project is no longer available. Refresh projects and select one again.");
  return project;
}

export async function readBranches(path: string) {
  const git = (args: string[]) => exec("git", ["-C", path, ...args], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
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
