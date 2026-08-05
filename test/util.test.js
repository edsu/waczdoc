import { test } from "node:test";
import assert from "node:assert/strict";
import { urlToFilename } from "../dist/util.js";

test("root path becomes host_index with an index prefix", () => {
  assert.equal(urlToFilename("http://www.example.com/", 0), "0001_www.example.com_index.pdf");
});

test("path segments are flattened into the name", () => {
  assert.equal(
    urlToFilename("https://example.com/news/story", 1),
    "0002_example.com_news_story.pdf"
  );
});

test("query strings are preserved but sanitized", () => {
  assert.equal(
    urlToFilename("https://example.com/a?id=5", 2),
    "0003_example.com_a_id_5.pdf"
  );
});

test("index prefix is zero-padded and 1-based", () => {
  assert.match(urlToFilename("http://x/", 0), /^0001_/);
  assert.match(urlToFilename("http://x/", 41), /^0042_/);
});

test("very long names are truncated", () => {
  const long = "http://example.com/" + "a".repeat(500);
  const name = urlToFilename(long, 0);
  // 4-digit index + "_" + <=150 chars + ".pdf"
  assert.ok(name.length <= 5 + 150 + 4, `name too long: ${name.length}`);
});

test("non-URL input still yields a safe filename", () => {
  const name = urlToFilename("not a url", 0);
  assert.match(name, /^0001_.*\.pdf$/);
});
