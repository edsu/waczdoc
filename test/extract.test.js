import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extractPages } from "../dist/extract.js";
import { listPages } from "../dist/wacz.js";
import { FIXTURE_1, tmpDir } from "./helpers.js";

// The fixtures hold no PDF, but extraction is mime-agnostic: it copies out
// whatever bytes the locator points at. Running it over the HTML page
// exercises the same path a PDF takes.
function extractFixture(mutate = (j) => j) {
  const jobs = listPages(FIXTURE_1).map((p, index) => mutate({ ...p, index }));
  const { dir, cleanup } = tmpDir();
  try {
    return { results: extractPages(FIXTURE_1, jobs, { outDir: dir }), dir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

test("writes the archived bytes to disk without a browser", () => {
  const { results, cleanup } = extractFixture();
  try {
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.ok, true, r.error);
    assert.equal(r.via, "extract");
    assert.ok(fs.existsSync(r.file), "file was written");
    assert.match(fs.readFileSync(r.file, "utf8"), /<title>Example Domain<\/title>/);
  } finally {
    cleanup();
  }
});

test("output filenames use the job index, not the position in the pass", () => {
  const { results, dir, cleanup } = extractFixture((j) => ({ ...j, index: 41 }));
  try {
    assert.equal(path.basename(results[0].file), "0042_www.example.com_index.pdf");
    assert.deepEqual(fs.readdirSync(dir), ["0042_www.example.com_index.pdf"]);
  } finally {
    cleanup();
  }
});

test("a page with no CDX record fails without writing a file", () => {
  const { results, dir, cleanup } = extractFixture((j) => ({ ...j, locator: null }));
  try {
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /no CDX record/);
    assert.deepEqual(fs.readdirSync(dir), [], "nothing written");
  } finally {
    cleanup();
  }
});

test("a corrupt locator fails that page instead of throwing", () => {
  const { results, cleanup } = extractFixture((j) => ({
    ...j,
    locator: { ...j.locator, offset: 999999 },
  }));
  try {
    assert.equal(results[0].ok, false);
    assert.ok(results[0].error.length > 0);
  } finally {
    cleanup();
  }
});
