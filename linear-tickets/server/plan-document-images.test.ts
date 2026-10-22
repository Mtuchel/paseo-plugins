import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { record } from "./context";
import { Credentials } from "./credentials";
import { LinearService, type Post } from "./linear";
import { operationName } from "./linear-usage";

// The plugin uploads only mocks under the host's ~/.plannotator/mocks (os.homedir() reads HOME).
const home = mkdtempSync(join(tmpdir(), "plan-doc-images-"));
const mocks = join(home, ".plannotator", "mocks", "order-plan");
mkdirSync(mocks, { recursive: true });
const order = join(mocks, "order.png");
const phone = join(mocks, "order-phone.webp");
writeFileSync(order, "order-png-bytes");
writeFileSync(phone, "phone-webp-bytes");
const outside = join(home, "elsewhere.png");
writeFileSync(outside, "private-bytes");
const escape = join(mocks, "escape.png");
symlinkSync(outside, escape);

type Put = { url: string; headers: Record<string, string>; body: string };
let puts: Put[] = [];
let putStatus = 200;
const realFetch = globalThis.fetch;
const realHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = home;
  puts = [];
  putStatus = 200;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    puts.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)), body: await new Response(init?.body).text() });
    return new Response(null, { status: putStatus });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.HOME = realHome;
});

function service() {
  const uploads: Record<string, unknown>[] = [];
  const written: string[] = [];
  const post: Post = async (key, query, variables) => {
    assert.equal(key, "env-key");
    const operation = operationName(query);
    if (operation === "issueDocuments") return { issue: { id: "i1", documents: { nodes: [] } } };
    if (operation === "fileUpload") {
      uploads.push(variables);
      const n = uploads.length;
      return { fileUpload: { success: true, uploadFile: { uploadUrl: `https://storage.test/put/${n}`, assetUrl: `https://uploads.linear.app/ws/asset-${n}`, headers: [{ key: "x-goog-meta-test", value: `v${n}` }] } } };
    }
    if (operation === "documentCreate") {
      written.push(String(record(variables.input).content));
      return { documentCreate: { success: true, document: { id: "d1", url: "https://linear.app/ws/document/d1" } } };
    }
    throw new Error(`unexpected ${operation}`);
  };
  return { uploads, written, linear: new LinearService(new Credentials("/unused", "env-key"), post) };
}

test("a plan document's mocks are uploaded once each and linked by their Linear asset URL", async () => {
  const { uploads, written, linear } = service();
  const plan = `# Plan\n\n![Mock: order](${order})\n\n<img src="${phone}" alt="phone">\n\nAgain: ![Mock: order](${order})\n\n\`![code](${order})\`\n`;
  await linear.upsertIssueDocument("i1", "Plan: TUC-1", plan);
  assert.deepEqual(uploads, [
    { contentType: "image/png", filename: "order.png", size: "order-png-bytes".length },
    { contentType: "image/webp", filename: "order-phone.webp", size: "phone-webp-bytes".length },
  ]);
  assert.deepEqual(puts.map((put) => [put.url, put.body]), [["https://storage.test/put/1", "order-png-bytes"], ["https://storage.test/put/2", "phone-webp-bytes"]]);
  assert.equal(puts[0].headers["x-goog-meta-test"], "v1", "the PUT carries the headers Linear returned");
  assert.equal(puts[0].headers["content-type"], "image/png");
  assert.ok(puts.every((put) => !Object.values(put.headers).includes("env-key")), "the storage PUT never sees the API key");
  assert.equal(
    written[0],
    `# Plan\n\n![Mock: order](https://uploads.linear.app/ws/asset-1)\n\n<img src="https://uploads.linear.app/ws/asset-2" alt="phone">\n\nAgain: ![Mock: order](https://uploads.linear.app/ws/asset-1)\n\n\`![code](${order})\`\n`,
  );

  await linear.upsertIssueDocument("i1", "Plan: TUC-1", `# Plan v2\n\n![Mock: order](${order})\n`);
  assert.equal(uploads.length, 2, "a resubmission with the same mock reuses its upload");
  assert.equal(written[1], "# Plan v2\n\n![Mock: order](https://uploads.linear.app/ws/asset-1)\n");
});

test("images outside the mocks folder, missing mocks, and failed uploads keep their local link and never stop the document", async () => {
  const { uploads, written, linear } = service();
  const missing = join(mocks, "gone.png");
  const plan = `![a](${outside})\n![b](${escape})\n![c](${missing})\n![d](/etc/hosts.png)\n`;
  await linear.upsertIssueDocument("i1", "Plan: TUC-1", plan);
  assert.deepEqual(uploads, [], "nothing outside ~/.plannotator/mocks is uploaded, symlinks included");
  assert.equal(written[0], plan);

  putStatus = 500;
  await linear.upsertIssueDocument("i1", "Plan: TUC-1", `![Mock: order](${order})\n`);
  assert.equal(uploads.length, 1);
  assert.equal(written[1], `![Mock: order](${order})\n`, "a failed upload leaves the local link");
  putStatus = 200;
  await linear.upsertIssueDocument("i1", "Plan: TUC-1", `![Mock: order](${order})\n`);
  assert.equal(written[2], "![Mock: order](https://uploads.linear.app/ws/asset-2)\n", "a failed upload is not cached");
});
