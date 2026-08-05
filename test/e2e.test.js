import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer } from "../dist/server.js";
import { renderPages } from "../dist/render.js";
import { listHtmlPages } from "../dist/wacz.js";
import { FIXTURE_1, tmpDir } from "./helpers.js";

// Full replay+print path through wabac in headless Chromium. Requires the
// Playwright Chromium browser (npx playwright install chromium). Set
// WACZ_PDF_SKIP_E2E=1 to skip (e.g. where a browser can't be installed).
const skip = !!process.env.WACZ_PDF_SKIP_E2E;

test(
  "renders a fixture page to a real PDF",
  { skip, timeout: 120000 },
  async () => {
    const pages = listHtmlPages(FIXTURE_1);
    const { dir, cleanup } = tmpDir();
    try {
      const server = await startServer(FIXTURE_1);
      try {
        const results = await renderPages(pages, {
          origin: server.origin,
          outDir: dir,
        });
        assert.equal(results.length, 1);
        // ok === true means wabac served real content, not its "not found"
        // page (renderPages flags the not-found page as a failure), so this
        // exercises the whole zip-range + replay + print path end to end.
        assert.equal(results[0].ok, true, results[0].error || "render failed");

        const file = results[0].file;
        assert.ok(fs.existsSync(file), "PDF was written");
        assert.ok(fs.statSync(file).size > 1000, "PDF is non-trivial");
        assert.ok(fs.readFileSync(file).subarray(0, 5).toString() === "%PDF-", "looks like a PDF");
      } finally {
        await server.close();
      }
    } finally {
      cleanup();
    }
  }
);
