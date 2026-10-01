import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { attachmentNote, safeFileName, saveAttachments, uploadReferences } from "./attachments";
import { Credentials } from "./credentials";
import { LinearService } from "./linear";

const exec = promisify(execFile);
const upload = (id: string) => `https://uploads.linear.app/ws/issue/${id}`;
// The shape Linear returns: a file embed in the description with a signed href, a markdown
// image in a comment, a repeat of the same file, and an ordinary external link.
const context = JSON.stringify({
  issue: {
    description: `<linear-embed node-type="file">{"href":"${upload("a")}?signature=abc","name":"example.xlsx"}</linear-embed>\n\nSee https://example.com/doc`,
    attachments: { nodes: [{ url: `${upload("a")}?signature=other` }] },
  },
  comments: [{ body: `![screen shot.png](${upload("b")}?sig=1) and again ${upload("b")}` }, { body: `plain ${upload("c")}` }],
});

test("uploads are found once each across description, comments and attachments, with their real names", () => {
  assert.deepEqual(uploadReferences(context), [
    { url: upload("a"), name: "example.xlsx" },
    { url: upload("b"), name: "screen shot.png" },
    { url: upload("c"), name: "c" },
  ]);
  assert.deepEqual(uploadReferences("not json"), []);
});

test("file names cannot leave the attachment directory", () => {
  assert.equal(safeFileName("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(safeFileName("..."), "file");
  assert.equal(safeFileName("a:b?.txt"), "a_b_.txt");
});

test("attachments are saved under .linear/<ticket>, excluded from git, and failures only warn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-linear-attachments-"));
  try {
    await exec("git", ["init", "-q", cwd]);
    const body = JSON.stringify({ issue: { description: `[report.csv](${upload("a")}) [report.csv](${upload("b")}) [gone.pdf](${upload("x")})` } });
    const download = async (url: string) => {
      if (url.endsWith("/x")) throw new Error("HTTP 404");
      return new TextEncoder().encode(url.slice(-1));
    };
    const saved = await saveAttachments(cwd, "ENG-1", body, download);
    assert.deepEqual(saved.files, [
      { name: "report.csv", path: join(".linear", "ENG-1", "report.csv") },
      { name: "report.csv", path: join(".linear", "ENG-1", "report-2.csv") },
    ]);
    assert.equal(await readFile(join(cwd, ".linear", "ENG-1", "report-2.csv"), "utf8"), "b");
    assert.match(saved.warnings.join("\n"), /Could not download attachment "gone.pdf": HTTP 404/);
    const { stdout } = await exec("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"]);
    assert.equal(stdout, "");
    await saveAttachments(cwd, "ENG-2", body, download);
    assert.equal((await readFile(join(cwd, ".git", "info", "exclude"), "utf8")).split("\n").filter((line) => line === ".linear/").length, 1);
    assert.match(attachmentNote(saved), /- report.csv: \.linear\/ENG-1\/report-2\.csv/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a ticket without uploads writes nothing and adds nothing to the prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-linear-attachments-none-"));
  try {
    const saved = await saveAttachments(cwd, "ENG-1", JSON.stringify({ issue: { description: "no files" } }), async () => { throw new Error("unused"); });
    assert.deepEqual(saved.files, []);
    assert.equal(attachmentNote(saved), "");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("the Linear key is only ever sent to uploads.linear.app, and oversized files are refused", async (t) => {
  const service = new LinearService(new Credentials(join(tmpdir(), `paseo-linear-dl-${process.pid}`), "secret-key"));
  const calls: { url: string; auth: string | null }[] = [];
  t.mock.method(globalThis, "fetch", (async (url: URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(new Uint8Array(10), { status: 200 });
  }) as typeof fetch);
  await assert.rejects(service.downloadUpload("https://evil.example/uploads.linear.app/x"), /Only Linear uploads/);
  assert.equal(calls.length, 0);
  assert.equal((await service.downloadUpload(upload("a"))).byteLength, 10);
  assert.deepEqual(calls, [{ url: upload("a"), auth: "secret-key" }]);
  await assert.rejects(service.downloadUpload(upload("a"), 5), /larger than/);
});
