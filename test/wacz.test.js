import { test } from "node:test";
import assert from "node:assert/strict";
import { listPages, pageKind } from "../dist/wacz.js";
import { FIXTURE_1, FIXTURE_2, waczWithoutPageList } from "./helpers.js";

test("listPages finds the archived page from pages.jsonl", () => {
  const pages = listPages(FIXTURE_1);
  assert.equal(pages.length, 1);
  const p = pages[0];
  assert.equal(p.url, "http://www.example.com/");
  assert.equal(p.discoveredIn, "pages");
  assert.equal(p.title, "Example Domain");
});

test("the ISO timestamp in pages.jsonl becomes a 14-digit replay timestamp", () => {
  const [p] = listPages(FIXTURE_1);
  assert.equal(p.timestamp, "20201007212236");
});

test("mime and status are filled in from the CDX record", () => {
  const [p] = listPages(FIXTURE_1);
  assert.equal(p.mime, "text/html");
  assert.equal(p.status, "200");
  assert.equal(pageKind(p), "html");
});

test("the CDX supplies a locator for the page's bytes", () => {
  const [p] = listPages(FIXTURE_1);
  assert.equal(p.locator.filename, "example-collection.warc");
  assert.equal(p.locator.offset, 845);
  assert.equal(p.locator.length, 1293);
});

test("the gzip-indexed fixture is read the same way", () => {
  const pages = listPages(FIXTURE_2);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, "http://www.example.com/");
  assert.equal(pages[0].title, "Example Domain");
});

test("falls back to the CDX when the archive has no pages/*.jsonl", () => {
  const { path, cleanup } = waczWithoutPageList(FIXTURE_1);
  try {
    const pages = listPages(path);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].discoveredIn, "cdx");
    assert.equal(pages[0].url, "http://www.example.com/");
    // No page list means no titles.
    assert.equal(pages[0].title, null);
    // The locator still comes through, so extraction works either way.
    assert.equal(pages[0].locator.filename, "example-collection.warc");
  } finally {
    cleanup();
  }
});

test("pageKind routes by mime, defaulting to html when unknown", () => {
  assert.equal(pageKind({ mime: "application/pdf" }), "pdf");
  assert.equal(pageKind({ mime: "text/html; charset=utf-8" }), "html");
  assert.equal(pageKind({ mime: "application/xhtml+xml" }), "html");
  // Pre-2021 pages.jsonl records no mime; those files list HTML pages only.
  assert.equal(pageKind({ mime: "" }), "html");
  assert.equal(pageKind({ mime: "application/msword" }), "other");
});
