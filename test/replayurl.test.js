import { test } from "node:test";
import assert from "node:assert/strict";
import { unrewriteHtml, unrewriteUrl } from "../dist/replayurl.js";

// Real shapes captured from a wabac replay of a WACZ, including the collection
// hash segment wabac inserts and the per-resource modifiers.
const ORIGIN = "http://127.0.0.1:61743";
const COLL = "/w/coll/:37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f";

test("an image URL loses its replay prefix", () => {
  const src = `${ORIGIN}${COLL}/20230105164613im_/https://reallifemag.com/wp-content/uploads/a.jpeg`;
  assert.equal(
    unrewriteUrl(src, ORIGIN),
    "https://reallifemag.com/wp-content/uploads/a.jpeg"
  );
});

test("every resource modifier is handled", () => {
  for (const mod of ["mp_", "im_", "cs_", "js_", "if_", "oe_", "fr_", "_"]) {
    const u = `${ORIGIN}${COLL}/20230105164613${mod}/https://example.org/x`;
    assert.equal(unrewriteUrl(u, ORIGIN), "https://example.org/x", mod);
  }
});

// Replay is asked for "2" when we have no capture timestamp to pin to.
test("a short timestamp is handled as well as a 14-digit one", () => {
  assert.equal(
    unrewriteUrl(`${ORIGIN}/w/coll/2mp_/https://example.org/x`, ORIGIN),
    "https://example.org/x"
  );
});

test("href, src, srcset and inline url() are all covered", () => {
  const html = `<a href="${ORIGIN}${COLL}/20230105164613mp_/https://example.org/p">p</a>
<img src="${ORIGIN}${COLL}/20230105164613im_/https://example.org/a.png"
     srcset="${ORIGIN}${COLL}/20230105164613im_/https://example.org/a.png 1x, ${ORIGIN}${COLL}/20230105164613im_/https://example.org/b.png 2x">
<div style="background:url(${ORIGIN}${COLL}/20230105164613im_/https://example.org/c.png)"></div>`;
  const out = unrewriteHtml(html, ORIGIN);
  assert.doesNotMatch(out, /127\.0\.0\.1/, "no replay origin survives");
  assert.doesNotMatch(out, /\/w\/coll\//, "no collection path survives");
  assert.match(out, /href="https:\/\/example\.org\/p"/);
  assert.match(out, /src="https:\/\/example\.org\/a\.png"/);
  assert.match(out, /https:\/\/example\.org\/b\.png 2x/);
  assert.match(out, /url\(https:\/\/example\.org\/c\.png\)/);
});

// Only URLs on the replay origin are touched, so an archived page that happens
// to contain a timestamp-shaped path segment is left alone.
test("URLs not on the replay origin are untouched", () => {
  const html = `<a href="https://example.org/w/coll/20230105164613mp_/https://elsewhere/x">keep</a>`;
  assert.equal(unrewriteHtml(html, ORIGIN), html);
});

test("a URL that was never rewritten is returned unchanged", () => {
  assert.equal(
    unrewriteUrl("https://example.org/plain/path", ORIGIN),
    "https://example.org/plain/path"
  );
});

test("the replay origin's own pages are left alone without a timestamp segment", () => {
  // The loader page itself, which carries no timestamp/modifier segment.
  const html = `<iframe src="${ORIGIN}/index.html"></iframe>`;
  assert.equal(unrewriteHtml(html, ORIGIN), html);
});

// wabac also emits prefixes with the origin left off, which an origin-anchored
// pattern cannot see.
test("root-relative replay prefixes are stripped too", () => {
  const html = `<a href="${COLL}/20230105201232mp_/https://reallifemag.com/anxiety-of-influence/">x</a>`;
  assert.equal(
    unrewriteHtml(html, ORIGIN),
    `<a href="https://reallifemag.com/anxiety-of-influence/">x</a>`
  );
});

test("root-relative stripping only fires on whole attribute values", () => {
  // A path that merely contains the shape mid-URL is not ours to touch.
  const html = `<a href="https://example.org/x/w/coll/20230105201232mp_/y">keep</a>`;
  assert.equal(unrewriteHtml(html, ORIGIN), html);
});

test("a different port is not matched", () => {
  const other = `http://127.0.0.1:9999${COLL}/20230105164613im_/https://example.org/x`;
  assert.equal(unrewriteHtml(other, ORIGIN), other, "another server's URL is not ours to rewrite");
});
