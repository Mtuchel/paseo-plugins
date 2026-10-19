import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedUiFiles,
  decide,
  hasBrowserVerification,
  isUiSourceFile,
  nudgeText,
  triggeringUserMessage,
  triggeringUserMessageInfo,
  turnItems,
  type TimelineItem,
  type TurnFacts,
  type TurnOutcome,
} from "../server/decision";

type ToolDetail = Extract<TimelineItem, { type: "tool_call" }>["detail"];

const completed: TurnOutcome = { kind: "completed" };
const user = (text: string, messageId?: string): TimelineItem => ({
  type: "user_message",
  text,
  ...(messageId ? { messageId } : {}),
});
const assistant = (text: string): TimelineItem => ({ type: "assistant_message", text });
const shell = (command: string, output = "", name = "shell"): TimelineItem => ({
  type: "tool_call",
  callId: "call-shell",
  name,
  status: "completed",
  error: null,
  detail: { type: "shell", command, output },
});
const tool = (name: string, detail?: ToolDetail): TimelineItem => ({
  type: "tool_call",
  callId: "call-tool",
  name,
  status: "completed",
  error: null,
  detail: detail ?? { type: "unknown", input: null, output: null },
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

test("reading ui-check.md does not count as running its Playwright command", () => {
  const read = tool("Read", {
    type: "read",
    filePath: "apps/core-web/docs/ui-check.md",
    content: "pnpm exec playwright screenshot --full-page http://localhost:3000/settings /tmp/shot.png",
  });
  const decision = turnaround({
    timeline: [user("Build it"), read, assistant("I read the guide")],
  });
  assert.equal(decision.kind, "nudge");
});

test("a shell output that mentions Playwright does not count as a check", () => {
  const decision = turnaround({
    timeline: [
      user("Build it"),
      shell("cat apps/core-web/docs/ui-check.md", "pnpm exec playwright screenshot --full-page http://localhost:3000 /tmp/shot.png"),
      assistant("Done"),
    ],
  });
  assert.equal(decision.kind, "nudge");
});

test("a grep for the Playwright command does not count as a check", () => {
  assert.equal(
    hasBrowserVerification([
      shell('grep -R "playwright screenshot" apps/core-web/docs'),
    ]),
    false,
  );
});

test("file edits that contain browser tool names do not count as checks", () => {
  const write = tool("Write", {
    type: "write",
    filePath: "apps/core-web/docs/ui-check.md",
    content: "Call browser_screenshot after browser_navigate.",
  });
  assert.equal(hasBrowserVerification([write]), false);
});

test("real provider tool-call shapes for browser checks are recognized", () => {
  const details: ToolDetail = { type: "unknown", input: { browserId: "browser-1" }, output: null };
  assert.equal(hasBrowserVerification([tool("mcp__paseo__browser_screenshot", details)]), true);
  assert.equal(hasBrowserVerification([tool("paseo.browser_snapshot", details)]), true);
  assert.equal(hasBrowserVerification([tool("browser_screenshot", details)]), true);
  assert.equal(
    hasBrowserVerification([
      shell(
        "pnpm exec playwright screenshot --full-page http://localhost:3000/settings /tmp/settings.png",
        "",
        "Bash",
      ),
    ]),
    true,
  );
  assert.equal(
    hasBrowserVerification([shell("pnpm exec playwright test e2e/settings.spec.ts", "", "bash")]),
    true,
  );
});

test("a Playwright run on a later line of a multi-line shell command counts", () => {
  assert.equal(
    hasBrowserVerification([shell("cd apps/core-web\npnpm exec playwright test e2e/settings.spec.ts", "", "bash")]),
    true,
  );
});

test("the triggering user message exposes a stable identity", () => {
  const withId = triggeringUserMessageInfo([
    user("first"),
    assistant("earlier"),
    user("second", "message-2"),
  ]);
  assert.deepEqual(withId, { text: "second", key: "id:message-2" });

  const fallback = triggeringUserMessageInfo([user("only"), assistant("done")]);
  assert.deepEqual(fallback, { text: "only", key: "at:0:only" });
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