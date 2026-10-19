import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";

export type Timeline = PluginLifecycleEvents["agent.turn_ended"]["timeline"];
export type TimelineItem = Timeline[number];
export type TurnOutcome = PluginLifecycleEvents["agent.turn_ended"]["outcome"];

/** Every follow-up this plugin sends starts with this marker, and turns started by one are ignored. */
export const NUDGE_PREFIX = "[ui-verify]";

/** UI source files this plugin watches, relative to the repository root. */
const UI_SOURCE = /^apps\/core-web\/src\/.+\.(?:tsx|css)$/;

/** A browser check or a Playwright run, matched against the turn's serialized tool calls. */
const BROWSER_VERIFICATION =
  /browser_(screenshot|snapshot|navigate|take_screenshot)|playwright test|playwright-test|playwright screenshot/;

/** How many changed files the follow-up names before it summarizes the rest. */
export const FILE_LIMIT = 10;

/**
 * Tests and end-to-end fixtures under the core-web source tree are not UI to look at in a
 * browser. Their changes never trigger a follow-up.
 */
function isTestPath(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.includes("__tests__") ||
    segments.includes("e2e") ||
    /\.(?:test|spec)\.(?:tsx|css)$/.test(path)
  );
}

export function isUiSourceFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return UI_SOURCE.test(normalized) && !isTestPath(normalized);
}

/** The changed core-web UI files, without duplicates, in the order git reported them. */
export function changedUiFiles(paths: readonly string[]): string[] {
  const files = new Set<string>();
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    if (isUiSourceFile(normalized)) files.add(normalized);
  }
  return [...files];
}

/** The last user message in the timeline is the one that started this turn. */
export function triggeringUserMessage(timeline: Timeline): string {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.type === "user_message") return item.text;
  }
  return "";
}

/**
 * The items belonging to this turn: everything after the user message that started it. Paseo
 * hands turn-end hooks the agent's whole timeline, not the turn's slice.
 */
export function turnItems(timeline: Timeline): TimelineItem[] {
  let start = 0;
  timeline.forEach((item, index) => {
    if (item.type === "user_message") start = index + 1;
  });
  return timeline.slice(start);
}

/**
 * Whether the turn's tool calls show a browser check. Tool calls are serialized as JSON so a
 * command, tool name, or argument anywhere in them counts, whichever provider produced them.
 */
export function hasBrowserVerification(items: readonly TimelineItem[]): boolean {
  const toolCalls = items.filter((item) => item.type === "tool_call");
  if (toolCalls.length === 0) return false;
  try {
    return BROWSER_VERIFICATION.test(JSON.stringify(toolCalls));
  } catch {
    return false;
  }
}

export function nudgeText(files: readonly string[]): string {
  const shown = files.slice(0, FILE_LIMIT);
  const hidden = files.length - shown.length;
  const list = shown.map((file) => `- \`${file}\``);
  if (hidden > 0) list.push(`- and ${hidden} more`);

  return [
    `${NUDGE_PREFIX} The previous turn changed core-web UI files but ran no browser check:`,
    "",
    ...list,
    "",
    "Before you finish this follow-up, start the worktree's `core-web` service and check every affected route in a browser, following `apps/core-web/docs/ui-check.md`.",
    "Add the screenshots to the pull request's `## Screenshots and recordings` section and link them in your reply.",
    "If a browser check is impossible here, say why in your reply instead.",
  ].join("\n");
}

export interface TurnFacts {
  /** Whether the agent's working directory belongs to a repository with apps/core-web. */
  coreWeb: boolean;
  outcome: TurnOutcome;
  /** The user message that started the turn. */
  trigger: string;
  timeline: Timeline;
  /** Changed paths between the turn's start and end snapshots, relative to the repository root. */
  changedFiles: readonly string[];
}

export type Decision =
  | { kind: "nudge"; files: string[]; text: string }
  | { kind: "skip"; reason: string };

/** Decide whether a finished turn gets the one browser-check follow-up. Pure and side-effect free. */
export function decide(facts: TurnFacts): Decision {
  if (!facts.coreWeb) return { kind: "skip", reason: "not a core-web repository" };
  if (facts.outcome.kind !== "completed") {
    return { kind: "skip", reason: `turn ${facts.outcome.kind}` };
  }
  if (facts.trigger.trimStart().startsWith(NUDGE_PREFIX)) {
    return { kind: "skip", reason: "turn started by a ui-verify follow-up" };
  }
  const files = changedUiFiles(facts.changedFiles);
  if (files.length === 0) return { kind: "skip", reason: "no core-web UI source changes" };
  if (hasBrowserVerification(turnItems(facts.timeline))) {
    return { kind: "skip", reason: "the turn already ran a browser check" };
  }
  return { kind: "nudge", files, text: nudgeText(files) };
}