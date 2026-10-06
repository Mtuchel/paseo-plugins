import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";

// Plannotator inlines its whole app into every review page: a ~22 MB module script and a ~2 MB
// stylesheet, the same bytes for every review of one Plannotator version. Each review has its
// own port, so a browser caches nothing from one review to the next and downloads and compiles
// all of it again. The review proxy hands each page over here: its inline app moves to one URL
// per version on the inbox's origin, `<inbox>/plannotator/<sha256>.js` (and `.css`), which the
// inbox serves immutable. The next review's page is then a few hundred bytes plus the cached app.

const compress = promisify(brotliCompress);
// Done once per Plannotator version, so a better ratio than the proxy's on-the-fly level 5.
const BROTLI_QUALITY = 9;
// Below this an inline script or stylesheet stays where it is: not worth a request.
const MIN_BYTES = 64 * 1024;
// Plannotator versions kept (each one script and one stylesheet); hosts update rarely.
const VERSIONS_KEPT = 2;

export type BundleFile = { type: string; raw: Buffer; br: Promise<Buffer> };

// The inline app as vite-plugin-singlefile writes it: one module script, one stylesheet.
const INLINE = [
  { pattern: /<script type="module"( crossorigin)?>([\s\S]*?)<\/script>/, ext: "js", type: "text/javascript; charset=utf-8", tag: (url: string) => `<script type="module" crossorigin src="${url}"></script>` },
  { pattern: /<style rel="stylesheet"( crossorigin)?>([\s\S]*?)<\/style>/, ext: "css", type: "text/css; charset=utf-8", tag: (url: string) => `<link rel="stylesheet" href="${url}">` },
];

export class ReviewBundles {
  private readonly files = new Map<string, BundleFile>();

  // The page with its inline app replaced by references to `${origin}/plannotator/<name>`; a page
  // without one comes back unchanged.
  externalize(page: string, origin: string): string {
    let result = page;
    for (const { pattern, ext, type, tag } of INLINE) {
      const match = pattern.exec(result);
      if (!match || match[2].length < MIN_BYTES) continue;
      const name = `${createHash("sha256").update(match[2]).digest("hex")}.${ext}`;
      if (!this.files.has(name)) this.add(name, type, Buffer.from(match[2]));
      result = result.slice(0, match.index) + tag(`${origin}/plannotator/${name}`) + result.slice(match.index + match[0].length);
    }
    return result;
  }

  file(name: string): BundleFile | undefined {
    return this.files.get(name);
  }

  private add(name: string, type: string, raw: Buffer): void {
    const br = compress(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    br.catch(() => {});
    this.files.set(name, { type, raw, br });
    // Oldest first: a page still open from an older version has its app in the browser's cache.
    for (const old of this.files.keys()) {
      if (this.files.size <= VERSIONS_KEPT * INLINE.length) break;
      this.files.delete(old);
    }
  }
}
