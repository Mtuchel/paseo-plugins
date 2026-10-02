import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { paseoHome } from "./ticket-mcp";

// Label groups the plugin keeps current on every issue of some teams: one label per group and issue
// ("Area" → "Quality", "Type" → "Bug"), decided from evidence in a fixed order (see decide). The
// rules live in $PASEO_HOME/linear-tickets/label-rules.json; without that file nothing runs.

export type LabelRule = {
  name: string;
  color?: string;
  description?: string;
  // Globs over "owner/repo/path" of the files the issue's pull requests change.
  paths: RegExp[];
  // Linear project names, compared case-insensitively.
  projects: string[];
  // Matched in the title (weight 3) and the description (weight 1).
  keywords: RegExp[];
  // Matched in the title only (weight 3).
  title: RegExp[];
};
// `inherit`: an issue without pull request evidence takes its parent's label of this group.
export type GroupRule = { name: string; color?: string; inherit: boolean; labels: LabelRule[] };
// `hash`: changes whenever the file's content does, so the groups are checked in Linear again.
export type LabelRules = { teamKeys: string[]; groups: GroupRule[]; hash: string };

export const LABEL_RULES_FILE = "label-rules.json";
const TEAM_KEY = /^[A-Za-z0-9]{1,10}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;

export function labelRulesPath(home = paseoHome()): string {
  return join(home, "linear-tickets", LABEL_RULES_FILE);
}

// "**/" spans any number of directories (none included), "**" anything, "*" and "?" stay inside one
// path segment. Case is ignored: GitHub's owner and repository names are.
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") { index++; source += "(?:.*/)?"; } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${what} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

function strings(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${what} must be a list of non-empty strings.`);
  return value.map((item: string) => item.trim());
}

function patterns(value: unknown, what: string): RegExp[] {
  return strings(value, what).map((source) => {
    try { return new RegExp(source, "i"); } catch { throw new Error(`${what}: "${source}" is not a valid regular expression.`); }
  });
}

function color(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !COLOR.test(value)) throw new Error(`${what} must be a colour like "#4ea7fc".`);
  return value;
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

// The file is edited by hand, so anything off is refused with the reason instead of repaired.
export function parseLabelRules(raw: string): LabelRules {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${LABEL_RULES_FILE} is not valid JSON.`); }
  const file = object(parsed, LABEL_RULES_FILE);
  const teamKeys = strings(file.teamKeys, "teamKeys");
  if (!teamKeys.length || teamKeys.some((key) => !TEAM_KEY.test(key))) throw new Error("teamKeys must list team keys such as \"ENG\".");
  if (!Array.isArray(file.groups) || !file.groups.length) throw new Error("groups must list at least one label group.");
  const seen = new Set<string>();
  const unique = (name: string, what: string) => {
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`${what} "${name}" appears twice; every group and label name must be unique.`);
    seen.add(key);
  };
  const groups = file.groups.map((value: unknown, index: number): GroupRule => {
    const group = object(value, `groups[${index}]`);
    const name = text(group.name, `groups[${index}].name`, MAX_NAME);
    unique(name, "Group");
    if (group.inherit !== undefined && typeof group.inherit !== "boolean") throw new Error(`${name}: inherit must be true or false.`);
    if (!Array.isArray(group.labels) || !group.labels.length) throw new Error(`${name}: labels must list at least one label.`);
    const labels = group.labels.map((item: unknown, position: number): LabelRule => {
      const entry = object(item, `${name}.labels[${position}]`);
      const labelName = text(entry.name, `${name}.labels[${position}].name`, MAX_NAME);
      unique(labelName, "Label");
      const where = `${name}/${labelName}`;
      return {
        name: labelName,
        color: color(entry.color, `${where}: color`),
        description: entry.description === undefined ? undefined : text(entry.description, `${where}: description`, MAX_DESCRIPTION),
        paths: strings(entry.paths, `${where}: paths`).map(globToRegExp),
        projects: strings(entry.projects, `${where}: projects`).map((project) => project.toLowerCase()),
        keywords: patterns(entry.keywords, `${where}: keywords`),
        title: patterns(entry.title, `${where}: title`),
      };
    });
    return { name, color: color(group.color, `${name}: color`), inherit: group.inherit === true, labels };
  });
  return { teamKeys: [...new Set(teamKeys)].sort(), groups, hash: createHash("sha256").update(raw).digest("hex") };
}

// null when the file does not exist (the feature is off); a broken file throws its reason.
export async function readLabelRules(path = labelRulesPath()): Promise<LabelRules | null> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return parseLabelRules(raw);
}

// One issue as the sweep reads it. `pullRequests`: GitHub pull request URLs attached to it.
export type SweptIssue = {
  id: string; identifier: string; title: string; description: string; createdAt: string; updatedAt: string;
  projectName: string | null; parentId: string | null; parentLabelIds: string[]; labelIds: string[]; pullRequests: string[];
};
// A group with the Linear ids of its group label and of each configured label found in it.
// `members`: every label inside the group in Linear, configured or added there by hand.
export type ResolvedGroup = { rule: GroupRule; id: string; labels: { rule: LabelRule; id: string }[]; members: string[] };
export type Reason = "pull requests" | "parent" | "project" | "keywords";
export type Decision = { labelId: string; reason: Reason };
// Changed files of a pull request as "owner/repo/path"; null while unknown (not read, or the read failed).
export type FilesOf = (url: string) => string[] | null;

// Changes to Linear's labels take effect after Linear's 3-minute creation window: changes inside it
// leave no history, so a label the plugin set then would later look as if a person had set it.
export const SETTLE_MS = 3 * 60 * 1000;
const DESCRIPTION_LIMIT = 20_000;

// The single label with the highest positive score; on a tie the current label when it is among the
// best, else none.
function best(scores: Map<string, number>, current: string | null): string | null {
  const top = Math.max(0, ...scores.values());
  if (top <= 0) return null;
  const leaders = [...scores].filter(([, score]) => score === top).map(([id]) => id);
  if (leaders.length === 1) return leaders[0];
  return current && leaders.includes(current) ? current : null;
}

// Evidence in order, the first that decides wins:
// 1. pull requests: the label whose paths match most changed files (each file counts for the first
//    label in the file's order that matches it);
// 2. the parent's current label of the group, when the group inherits;
// 3. the issue's project;
// 4. keywords: title matches weigh 3, description matches 1.
// `undefined`: not decidable yet (a pull request's files are unknown); null: no evidence.
export function decide(issue: SweptIssue, group: ResolvedGroup, filesOf: FilesOf): Decision | null | undefined {
  const ids = new Set(group.labels.map((entry) => entry.id));
  const current = issue.labelIds.find((id) => ids.has(id)) ?? null;
  if (issue.pullRequests.length && group.labels.some((entry) => entry.rule.paths.length)) {
    const scores = new Map<string, number>();
    for (const url of issue.pullRequests) {
      const files = filesOf(url);
      if (!files) return undefined;
      for (const file of files) {
        const match = group.labels.find((entry) => entry.rule.paths.some((path) => path.test(file)));
        if (match) scores.set(match.id, (scores.get(match.id) ?? 0) + 1);
      }
    }
    const chosen = best(scores, current);
    if (chosen) return { labelId: chosen, reason: "pull requests" };
  }
  if (group.rule.inherit && issue.parentId) {
    const inherited = issue.parentLabelIds.find((id) => ids.has(id));
    if (inherited) return { labelId: inherited, reason: "parent" };
  }
  const project = issue.projectName?.toLowerCase();
  const byProject = project ? group.labels.find((entry) => entry.rule.projects.includes(project)) : undefined;
  if (byProject) return { labelId: byProject.id, reason: "project" };
  const description = issue.description.slice(0, DESCRIPTION_LIMIT);
  const scores = new Map<string, number>();
  for (const entry of group.labels) {
    let score = 0;
    for (const pattern of entry.rule.keywords) score += (pattern.test(issue.title) ? 3 : 0) + (pattern.test(description) ? 1 : 0);
    for (const pattern of entry.rule.title) score += pattern.test(issue.title) ? 3 : 0;
    if (score) scores.set(entry.id, score);
  }
  const chosen = best(scores, current);
  return chosen ? { labelId: chosen, reason: "keywords" } : null;
}

// `remove`: the group's labels on the issue now (one, as Linear allows only one per group).
export type LabelChange = { issue: SweptIssue; group: ResolvedGroup; add: string; remove: string[]; reason: Reason };

// What the rules would change. `waiting`: issues that cannot be decided yet, inside Linear's
// creation window or with pull requests whose files are not known yet.
export function planLabelChanges(issues: SweptIssue[], groups: ResolvedGroup[], filesOf: FilesOf, now: number): { changes: LabelChange[]; waiting: number } {
  const changes: LabelChange[] = [];
  let waiting = 0;
  for (const issue of issues) {
    if (now - Date.parse(issue.createdAt) < SETTLE_MS) { waiting++; continue; }
    let undecided = false;
    for (const group of groups) {
      const decision = decide(issue, group, filesOf);
      if (decision === undefined) undecided = true;
      if (!decision) continue;
      const present = issue.labelIds.filter((id) => group.members.includes(id));
      if (present.length === 1 && present[0] === decision.labelId) continue;
      changes.push({ issue, group, add: decision.labelId, remove: present.filter((id) => id !== decision.labelId), reason: decision.reason });
    }
    if (undecided) waiting++;
  }
  return { changes, waiting };
}

// One entry of an issue's history that changed labels. `actorId` is null for integrations and
// Linear's own workflows.
export type LabelEvent = { at: string; actorId: string | null; added: string[]; removed: string[] };

// Whether a person (or an integration) chose the issue's label of this group, which the rules then
// leave alone: the latest change to the group's labels was not the plugin's, or, with no change on
// record, the issue carries a label anyway (set when the issue was created).
export function chosenByHand(events: LabelEvent[], groupLabelIds: ReadonlySet<string>, hasLabel: boolean, pluginUserId: string): boolean {
  const latest = [...events].sort((a, b) => b.at.localeCompare(a.at))
    .find((event) => event.added.some((id) => groupLabelIds.has(id)) || event.removed.some((id) => groupLabelIds.has(id)));
  if (!latest) return hasLabel;
  return latest.actorId !== pluginUserId;
}
