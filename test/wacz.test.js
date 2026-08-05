import { test } from "node:test";
import assert from "node:assert/strict";
import { listHtmlPages } from "../src/wacz.js";
import { FIXTURE_1, FIXTURE_2 } from "./helpers.js";

test("listHtmlPages finds the archived HTML page from the CDX index", () => {
  const pages = listHtmlPages(FIXTURE_1);
  assert.equal(pages.length, 1);
  const p = pages[0];
  assert.equal(p.url, "http://www.example.com/");
  assert.equal(p.mime, "text/html");
  assert.equal(p.status, "200");
  assert.match(p.timestamp, /^\d{14}$/);
});

test("titles are merged in from pages.jsonl", () => {
  const [p] = listHtmlPages(FIXTURE_1);
  assert.equal(p.title, "Example Domain");
});

test("the gzip-indexed fixture is read the same way", () => {
  const pages = listHtmlPages(FIXTURE_2);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, "http://www.example.com/");
});
