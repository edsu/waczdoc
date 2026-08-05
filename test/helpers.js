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
