// Local images in a plan (README, "Plan-first", visual mocks). Plannotator renders `![alt](src)`
// and raw `<img src>` outside code, and serves a local source only by absolute path with one of
// its image extensions; http(s), data: and blob: sources are not local. The omp extension refuses
// a submission whose local image would not show, and the Linear plan document swaps local images
// for uploaded copies. No imports: Paseo's shared bundle refuses Node modules, and the omp
// extension imports it from outside the plugin's build.

export type PlanImage = { src: string; start: number; end: number };

// Plannotator's /api/image extensions (pi-extension server/handlers.ts), with their content types.
export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp", ico: "image/x-icon", tiff: "image/tiff", tif: "image/tiff", avif: "image/avif",
};
// The content type of an image path by its extension, or null when Plannotator would not show it.
export const imageType = (path: string): string | null => IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? ""] ?? null;
const NOT_LOCAL = /^(https?:|data:|blob:)/i;
const MARKDOWN = /!\[[^\]]*\]\(([^)]+)\)/g;
const HTML = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;

// The plan with fenced code blocks and inline code spans blanked to spaces, so offsets still match.
function withoutCode(plan: string): string {
  let fenced = false;
  return plan
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return " ".repeat(line.length);
      }
      if (fenced) return " ".repeat(line.length);
      return line.replace(/(`+)[\s\S]*?\1/g, (span) => " ".repeat(span.length));
    })
    .join("\n");
}

// The plan's local image sources outside code, in order, with the offsets of each source.
export function localPlanImages(plan: string): PlanImage[] {
  const text = withoutCode(plan);
  const images: PlanImage[] = [];
  for (const match of text.matchAll(MARKDOWN)) {
    const start = (match.index ?? 0) + match[0].length - 1 - match[1].length;
    images.push({ src: match[1], start, end: start + match[1].length });
  }
  for (const match of text.matchAll(HTML)) {
    const start = (match.index ?? 0) + match[0].length - 1 - match[2].length;
    images.push({ src: match[2], start, end: start + match[2].length });
  }
  return images.filter((image) => !NOT_LOCAL.test(image.src.trim())).sort((a, b) => a.start - b.start);
}

// Why some local image would not show in Plannotator, or null when all would.
export function planImageProblem(plan: string, isFile: (path: string) => boolean): string | null {
  const problems = new Set<string>();
  for (const { src } of localPlanImages(plan)) {
    const path = src.trim();
    if (!path.startsWith("/")) problems.add(`"${path}" is not an absolute path`);
    else if (!imageType(path)) problems.add(`"${path}" is not a PNG, JPEG, GIF, WebP, SVG or other image file`);
    else if (!isFile(path)) problems.add(`"${path}" does not exist`);
  }
  if (problems.size === 0) return null;
  return `The plan's images would not show in Plannotator: ${[...problems].join("; ")}. Link each local image by the absolute path of an existing image file (no ~, no relative path).`;
}

// The plan with each local image source found in `urls` replaced by its URL.
export function replacePlanImages(plan: string, urls: ReadonlyMap<string, string>): string {
  let out = plan;
  for (const image of localPlanImages(plan).reverse()) {
    const url = urls.get(image.src.trim());
    if (url) out = out.slice(0, image.start) + url + out.slice(image.end);
  }
  return out;
}
