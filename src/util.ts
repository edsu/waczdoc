import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Resolve a path inside an installed package (ESM has no require.resolve).
export function createRequirePath(spec: string): string {
  return require.resolve(spec);
}

// wabac only exports "." and "./swlib", so its sw.js is not directly
// resolvable. Resolve the main entry and find sw.js as a sibling in dist/.
export function resolveWabacSw(): string {
  const main = require.resolve("@webrecorder/wabac"); // .../dist/index.js
  return path.join(path.dirname(main), "sw.js");
}

// Turn a URL into a safe-ish filename for the output PDF.
export function urlToFilename(u: string, index: number): string {
  let name: string;
  try {
    const parsed = new URL(u);
    let p = parsed.pathname;
    if (p === "/" || p === "") p = "/index";
    name = parsed.hostname + p.replace(/\/+$/, "");
    if (parsed.search) name += parsed.search;
  } catch {
    name = u;
  }
  name = name
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 150);
  if (!name) name = "page";
  // Archived PDFs are copied out under their own name, which already ends in
  // .pdf -- don't give them a second one.
  if (!/\.pdf$/i.test(name)) name += ".pdf";
  // Prefix with index to guarantee uniqueness and preserve ordering.
  return `${String(index + 1).padStart(4, "0")}_${name}`;
}
