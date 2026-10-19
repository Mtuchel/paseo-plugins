import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedUiFiles,
  decide,
  hasBrowserVerification,
  isUiSourceFile,
  nudgeText,
  triggeringUserMessage,
  turnItems,
  type TimelineItem,
  type TurnFacts,
  type TurnOutcome,
} from "../server/decision";

const completed: TurnOutcome = { kind: "completed" };
const user = (text: string): TimelineItem => ({ type: "user_message", text });
const assistant = (text: string): TimelineItem => ({ type: "assistant_message", text });
const shell = (command: string): TimelineItem => ({
  type: "tool_call",
  callId: "call-shell",
  name: "shell",
  status: "completed",
  error: null,
  detail: { type: "shell", command, output: "" },
});
const tool = (name: string): TimelineItem => ({
  type: "tool_call",
  callId: "call-tool",
  name,
  status: "completed",
  error: null,
  detail: { type: "plain_text", text: name },
});

function turnaround(overrides: Partial<TurnFacts> = {}) {
  return decide({
    coreWeb: true,
    outcome: completed,
    trigger: "Build the settings page",
    timeline: [user("Build the settings page"), assistant("Done")],
    changedFiles: ["apps/core-web/src/settings/SettingsPage.tsx"],
    ...overrides,
  });
}

test("a changed UI file without a browser check gets one follow-up", () => {
  const decision = turnaround();
  assert.equal(decision.kind, "nudge");
  if (decision.kind !== "nudge") return;
  assert.deepEqual(decision.files, ["apps/core-web/src/settings/SettingsPage.tsx"]);
  assert.ok(decision.text.startsWith("[ui-verify]"));
  assert.match(decision.text, /apps\/core-web\/src\/settings\/SettingsPage\.tsx/);
  assert.match(decision.text, /apps\/core-web\/docs\/ui-check\.md/);
  assert.match(decision.text, /core-web` service/);
  assert.match(decision.text, /## Screenshots and recordings/);
  assert.match(decision.text, /impossible/);
});

test("a browser screenshot in this turn suppresses the follow-up", () => {
  const decision = turnaround({
    timeline: [user("Build it"), tool("browser_screenshot"), assistant("Checked it")],
  });
  assert.equal(decision.kind, "skip");
});

test("a playwright run suppresses the follow-up", () => {
  const decision = turnaround({
    timeline: [user("Build it"), shell("npx playwright test e2e/settings.spec.ts"), assistant("Done")],
  });
  assert.equal(decision.kind, "skip");
});

test("a browser check from an earlier turn does not suppress this turn", () => {
  const decision = turnaround({
    timeline: [
      user("Earlier turn"),
      tool("browser_screenshot"),
      assistant("Earlier reply"),
      user("This turn"),
      shell("pnpm lint"),
      assistant("Done"),
    ],
  });
  assert.equal(decision.kind, "nudge");
});

test("test and fixture files alone never trigger a follow-up", () => {
  const decision = turnaround({
    changedFiles: [
      "apps/core-web/src/settings/SettingsPage.test.tsx",
      "apps/core-web/src/settings/__tests__/SettingsPage.tsx",
      "apps/core-web/src/e2e/settings.tsx",
      "apps/core-web/src/settings/SettingsPage.spec.tsx",
    ],
  });
  assert.equal(decision.kind, "skip");
});

test("CSS changes are UI changes", () => {
  const decision = turnaround({ changedFiles: ["apps/core-web/src/settings/settings.css"] });
  assert.equal(decision.kind, "nudge");
});

test("non-core-web repositories are ignored", () => {
  assert.equal(turnaround({ coreWeb: false }).kind, "skip");
  assert.equal(turnaround({ changedFiles: ["apps/other/src/Page.tsx"], coreWeb: false }).kind, "skip");
});

test("a turn started by [ui-verify] is never nudged again", () => {
  const decision = turnaround({
    trigger: "[ui-verify] The previous turn changed core-web UI files",
    timeline: [user("[ui-verify] The previous turn changed core-web UI files"), assistant("I checked it")],
  });
  assert.equal(decision.kind, "skip");
});

test("canceled and failed turns are ignored", () => {
  assert.equal(turnaround({ outcome: { kind: "canceled", reason: "user" } }).kind, "skip");
  assert.equal(turnaround({ outcome: { kind: "failed", error: { message: "boom" } } }).kind, "skip");
});

test("the file list is capped at ten with a remainder line", () => {
  const files = Array.from({ length: 13 }, (_, index) => `apps/core-web/src/page-${index}.tsx`);
  const decision = turnaround({ changedFiles: files });
  assert.equal(decision.kind, "nudge");
  if (decision.kind !== "nudge") return;
  assert.equal(decision.files.length, 13);
  assert.match(decision.text, /page-9\.tsx/);
  assert.doesNotMatch(decision.text, /page-10\.tsx/);
  assert.match(decision.text, /- and 3 more/);
});

test("the path filter keeps core-web UI sources and drops everything else", () => {
  assert.equal(isUiSourceFile("apps/core-web/src/a.tsx"), true);
  assert.equal(isUiSourceFile("apps/core-web/src/nested/b.css"), true);
  assert.equal(isUiSourceFile("apps/core-web/src/a.ts"), false);
  assert.equal(isUiSourceFile("apps/core-web/e2e/a.tsx"), false);
  assert.equal(isUiSourceFile("apps/other/src/a.tsx"), false);
  assert.deepEqual(
    changedUiFiles(["apps/core-web/src/a.tsx", "apps/core-web/src/a.tsx", "apps/other/src/b.tsx"]),
    ["apps/core-web/src/a.tsx"],
  );
});

test("turn items start after the last user message", () => {
  const timeline = [user("one"), shell("early"), user("two"), tool("browser_snapshot")];
  assert.equal(triggeringUserMessage(timeline), "two");
  assert.deepEqual(turnItems(timeline), [tool("browser_snapshot")]);
  assert.equal(hasBrowserVerification(turnItems(timeline)), true);
});

test("the follow-up text never names more than the changed UI files", () => {
  const text = nudgeText(["apps/core-web/src/a.tsx"]);
  assert.ok(text.startsWith("[ui-verify]"));
  assert.match(text, /^\[ui-verify\] The previous turn changed core-web UI files but ran no browser check:/);
});