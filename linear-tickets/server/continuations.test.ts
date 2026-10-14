import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Continuations, continuationMarker, continuationReceipt } from "./continuations";

test("an ambiguous dispatch survives restart and rejects changed operation identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-"));
  try {
    const input = { issueId: "ticket", agentId: "worker", operationId: "claim", text: "continue" };
    let sends = 0;
    const dispatch = async (store: Continuations) => store.run(input, async (record, save) => {
      if (record.status !== "queued") return record;
      await save({ status: "unknown" });
      sends++;
      throw new Error("transport disconnected after send");
    });
    await assert.rejects(dispatch(new Continuations(dir)), /transport disconnected/);
    assert.equal((await dispatch(new Continuations(dir))).status, "unknown");
    assert.equal(sends, 1);
    await assert.rejects(new Continuations(dir).run({ ...input, agentId: "replacement" }, async (record) => record), /different input/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("concurrent same-identity delivery makes only one dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-"));
  try {
    const store = new Continuations(dir);
    const input = { issueId: "ticket", agentId: "worker", operationId: "claim", text: "continue" };
    let sends = 0;
    const send = () => store.run(input, async (record, save) => {
      if (record.status === "queued") { await save({ status: "sent" }); sends++; }
      return { status: "sent" };
    });
    await Promise.all([send(), send(), send()]);
    assert.equal(sends, 1);
    assert.equal((await new Continuations(dir).get("claim"))?.status, "sent");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("receipt requires a current-branch user marker, not an abandoned branch or assistant echo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-"));
  try {
    const file = join(dir, "native.jsonl");
    const marker = continuationMarker("claim");
    const entries = [
      { id: "root", parentId: null, type: "message", message: { role: "user", content: "initial" } },
      { id: "receipt", parentId: "root", type: "message", message: { role: "user", content: marker } },
      { id: "progress", parentId: "receipt", type: "message", message: { role: "assistant", content: "working" } },
    ];
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    assert.equal(await continuationReceipt(file, marker), "started");
    entries.push({ id: "rewound", parentId: "root", type: "message", message: { role: "assistant", content: marker } });
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    assert.equal(await continuationReceipt(file, marker), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("overlapping plugin instances cannot dispatch the same operation concurrently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "continuation-lease-"));
  const input = { issueId: "ticket", agentId: "worker", operationId: "claim", text: "continue" };
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let dispatches = 0;
  try {
    const first = new Continuations(dir).run(input, async (_record, save) => {
      await save({ status: "unknown" });
      entered();
      await blocked;
      dispatches++;
      await save({ status: "sent" });
      return { status: "sent" };
    });
    await started;
    const competing = await new Continuations(dir).run(input, async () => { dispatches++; return { status: "sent" }; });
    assert.equal(competing.status, "unknown");
    assert.equal(dispatches, 0);
    release();
    await first;
    assert.equal(dispatches, 1);
    assert.equal((await new Continuations(dir).get(input.operationId))?.status, "sent");
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});
