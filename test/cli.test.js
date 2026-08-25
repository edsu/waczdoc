import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgv } from "../dist/cli.js";

// parseArgv turns argv into a Plan and does nothing else, so these assert on
// the parse without reading an archive or starting a browser.
// silent: commander would otherwise dump usage to stderr for every case that
// is meant to be rejected.
const plan = (...argv) => parseArgv(argv, { silent: true });

test("each output format is its own subcommand", () => {
  assert.equal(plan("pdf", "a.wacz").mode, "pdf");
  assert.equal(plan("markdown", "a.wacz").mode, "markdown");
  assert.equal(plan("list", "a.wacz").mode, "list");
});

test("the archive path is required", () => {
  assert.throws(() => plan("markdown"), /missing required argument/i);
});

test("an unknown subcommand is rejected", () => {
  assert.throws(() => plan("epub", "a.wacz"), /unknown command/i);
});

test("no subcommand at all is rejected", () => {
  assert.throws(() => plan("a.wacz"), /unknown command|no command/i);
});

test("output directory defaults per format and -o overrides it", () => {
  assert.equal(plan("pdf", "a.wacz").out, "pdfs");
  assert.equal(plan("markdown", "a.wacz").out, "markdown");
  assert.equal(plan("markdown", "a.wacz", "-o", "notes").out, "notes");
  assert.equal(plan("pdf", "a.wacz", "--out", "printed").out, "printed");
});

// The options that only make sense for one format are not accepted by the
// other -- which is the whole reason for using subcommands.
test("paper and PDF-only options are rejected by the markdown subcommand", () => {
  for (const opt of [
    ["--format", "A4"],
    ["--landscape"],
    ["--single-page"],
    ["--print-media"],
    ["--no-extract"],
  ]) {
    assert.throws(
      () => plan("markdown", "a.wacz", ...opt),
      /unknown option/i,
      `markdown should reject ${opt[0]}`
    );
  }
});

// Both outputs replay each page in a browser, so the replay knobs are shared.
test("replay options are accepted by both output subcommands", () => {
  assert.equal(plan("markdown", "a.wacz", "-j", "4").markdown.concurrency, 4);
  assert.equal(plan("pdf", "a.wacz", "-j", "4").render.concurrency, 4);
  assert.match(plan("markdown", "a.wacz", "--inject", "go()").markdown.inject, /go\(\)/);
  assert.match(plan("pdf", "a.wacz", "--inject", "go()").render.inject, /go\(\)/);
});

test("replay options are not offered by list, which writes nothing", () => {
  assert.throws(() => plan("list", "a.wacz", "-j", "4"), /unknown option/i);
  assert.throws(() => plan("list", "a.wacz", "--inject", "x"), /unknown option/i);
});

test("markdown-only options are rejected by the pdf subcommand", () => {
  assert.throws(() => plan("pdf", "a.wacz", "--no-front-matter"), /unknown option/i);
});

test("front matter is on by default and --no-front-matter turns it off", () => {
  assert.equal(plan("markdown", "a.wacz").markdown.frontMatter, true);
  assert.equal(plan("markdown", "a.wacz", "--no-front-matter").markdown.frontMatter, false);
});

test("archived PDFs are extracted unless --no-extract says otherwise", () => {
  assert.equal(plan("pdf", "a.wacz").extract, true);
  assert.equal(plan("pdf", "a.wacz", "--no-extract").extract, false);
});

test("filters are shared by every subcommand and repeat", () => {
  for (const mode of ["pdf", "markdown", "list"]) {
    const p = plan(mode, "a.wacz", "--include", "/a/", "--include", "/b/", "--exclude", "/tag/");
    assert.deepEqual(p.filters.include, ["/a/", "/b/"], mode);
    assert.deepEqual(p.filters.exclude, ["/tag/"], mode);
  }
});

test("--limit must be a positive integer", () => {
  assert.equal(plan("list", "a.wacz", "--limit", "5").filters.limit, 5);
  assert.throws(() => plan("list", "a.wacz", "--limit", "0"), /positive integer/);
  assert.throws(() => plan("list", "a.wacz", "--limit", "-3"), /positive integer/);
  assert.throws(() => plan("list", "a.wacz", "--limit", "abc"), /positive integer/);
});

test("render options map onto the PDF plan", () => {
  const p = plan("pdf", "a.wacz", "--format", "A4", "--landscape", "--single-page", "--print-media");
  assert.equal(p.render.format, "A4");
  assert.equal(p.render.landscape, true);
  assert.equal(p.render.singlePage, true);
  assert.equal(p.render.screenMedia, false, "--print-media turns screen media off");
});

test("screen media is the default", () => {
  assert.equal(plan("pdf", "a.wacz").render.screenMedia, true);
});

test("--concurrency takes a number or auto", () => {
  assert.equal(plan("pdf", "a.wacz").render.concurrency, 1);
  assert.equal(plan("pdf", "a.wacz", "-j", "4").render.concurrency, 4);
  assert.ok(plan("pdf", "a.wacz", "-j", "auto").render.concurrency >= 1, "auto resolves to a count");
  assert.throws(() => plan("pdf", "a.wacz", "-j", "0"), /positive integer/);
});

test("--inject is repeatable and joined in order", () => {
  assert.equal(plan("pdf", "a.wacz").render.inject, undefined);
  const p = plan("pdf", "a.wacz", "--inject", "one()", "--inject", "two()");
  assert.match(p.render.inject, /one\(\)[\s\S]*two\(\)/);
});

test("--inject @file reads the script from disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waczdoc-inject-"));
  try {
    const file = path.join(dir, "cleanup.js");
    fs.writeFileSync(file, "document.body.dataset.x = 1;");
    const p = plan("pdf", "a.wacz", "--inject", `@${file}`);
    assert.match(p.render.inject, /document\.body\.dataset\.x/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing --inject file is reported, not silently ignored", () => {
  assert.throws(() => plan("pdf", "a.wacz", "--inject", "@/nope/missing.js"), /inject file not found/);
});
