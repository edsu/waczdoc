import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Absolute path to a bundled test fixture WACZ.
export function fixture(name) {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

export const FIXTURE_1 = fixture("valid_example_1.wacz");
export const FIXTURE_2 = fixture("valid_example_2.wacz");

// Create a throwaway output directory; returns { dir, cleanup }.
export function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-pdf-test-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A copy of a fixture with its page list hidden, to exercise the CDX fallback.
// The replacement name is the same length as the original, so every zip offset
// (and the name length recorded in each header) stays valid.
const PAGES_NAME = "pages/pages.jsonl";
const HIDDEN_NAME = "pages/pages.jsonx"; // same length; no longer matched

export function waczWithoutPageList(src) {
  const buf = fs.readFileSync(src);
  let at = 0;
  for (;;) {
    at = buf.indexOf(PAGES_NAME, at, "latin1");
    if (at === -1) break;
    buf.write(HIDDEN_NAME, at, PAGES_NAME.length, "latin1");
    at += PAGES_NAME.length;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-pdf-nopages-"));
  const out = path.join(dir, "no-pages.wacz");
  fs.writeFileSync(out, buf);
  return { path: out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
