import assert from "node:assert/strict";
import test from "node:test";
import { linearWriteRefusal } from "../omp/linear-tickets-plan-first";

// A refused owner write names the Paseo tool that does the same thing, whether the agent called the
// Linear tool directly or wrote its arguments to the xd:// device.
const viaDevice = (tool: string, args: Record<string, unknown>) => linearWriteRefusal("write", { path: `xd://mcp__linear_${tool}`, content: JSON.stringify(args) });

test("reads pass, and the plugin's own tools are not owner writes", () => {
  assert.equal(linearWriteRefusal("mcp__linear_get_issue", { id: "TUC-1" }), null);
  assert.equal(viaDevice("list_comments", { issueId: "TUC-1" }), null);
  assert.equal(linearWriteRefusal("mcp__linear_ticket_add_comment", { body: "x" }), null);
  assert.equal(linearWriteRefusal("write", { path: "notes.md", content: "x" }), null);
});

test("each refused owner write names its replacement", () => {
  assert.match(viaDevice("prepare_attachment_upload", { issue: "TUC-1" }) ?? "", /Use linear_ticket_attach_file with the file's absolute path/);
  assert.match(linearWriteRefusal("mcp__linear_create_attachment_from_upload", {}) ?? "", /linear_ticket_attach_file/);
  assert.match(viaDevice("save_comment", { issueId: "TUC-1", body: "x" }) ?? "", /Use linear_ticket_add_comment instead/);
  assert.match(viaDevice("save_comment", { id: "c-1", body: "x" }) ?? "", /Use linear_ticket_edit_comment instead/);
  assert.match(viaDevice("save_issue", { team: "Eng", title: "x" }) ?? "", /Use linear_ticket_create_issue instead/);
  assert.match(viaDevice("save_document", { id: "doc-1", patch: [] }) ?? "", /only a plan review round replaces it.*linear_ticket_add_comment/);
  assert.match(viaDevice("create_issue_label", { name: "x" }) ?? "", /No linear_ticket_\* tool does this: ask the owner/);
});

test("an issue update is routed field by field, and fields agents never set go to the owner", () => {
  const refusal = viaDevice("save_issue", { id: "TUC-1", state: "Done", removeBlocks: ["TUC-2"], priority: 1 }) ?? "";
  assert.match(refusal, /^Stopped by the linear-tickets plugin: mcp__linear_save_issue would write to Linear as the owner\./);
  assert.match(refusal, /linear_ticket_set_status for the status; linear_ticket_remove_relation to remove a relation; ask the owner for priority/);
  assert.doesNotMatch(refusal, /add_relation|update_issue/);
  assert.match(viaDevice("save_issue", { id: "TUC-1", duplicateOf: null }) ?? "", /linear_ticket_remove_relation/);
  assert.match(viaDevice("save_issue", { id: "TUC-1", duplicateOf: "TUC-3", patch: [] }) ?? "", /linear_ticket_update_issue for the title or description.*linear_ticket_add_relation/);
});
