import { test } from "node:test";
import assert from "node:assert/strict";
import { openZip } from "../dist/zipread.js";
import { readWarcPayload, normalizeDigest } from "../dist/warc.js";
import { listPages } from "../dist/wacz.js";
import { FIXTURE_1, FIXTURE_2 } from "./helpers.js";

// Pull a record straight out of the WARC by byte range, with no replay.
function payloadOf(wacz) {
  const [page] = listPages(wacz);
  const zip = openZip(wacz);
  try {
    return readWarcPayload(zip, page.locator);
  } finally {
    zip.close();
  }
}

test("reads a record's payload by byte range", () => {
  const rec = payloadOf(FIXTURE_1);
  assert.equal(rec.warcType, "response");
  assert.equal(rec.status, 200);
  assert.equal(rec.contentType, "text/html");
  assert.match(rec.payload.toString(), /<title>Example Domain<\/title>/);
});

// The payload must be cut at the HTTP Content-Length. Without that we keep the
// WARC record's 4-byte separator and the bytes no longer match their digest.
test("the payload matches the digest recorded in the CDX", () => {
  assert.equal(payloadOf(FIXTURE_1).digestOk, true, "bare base32 sha1 digest");
  assert.equal(payloadOf(FIXTURE_2).digestOk, true, "sha1:-prefixed digest");
});

test("payload ends at the body, not the record separator", () => {
  const { payload } = payloadOf(FIXTURE_1);
  assert.ok(!payload.subarray(-4).toString().endsWith("\r\n\r\n"));
  assert.match(payload.toString().trimEnd(), /<\/html>$/);
});

test("normalizeDigest makes prefixed and bare digests comparable", () => {
  assert.equal(normalizeDigest("sha256:ABC123"), normalizeDigest("abc123"));
  assert.equal(normalizeDigest("sha1:WJM2KPM4"), "WJM2KPM4");
});

test("a missing WARC is reported clearly", () => {
  const zip = openZip(FIXTURE_1);
  try {
    assert.throws(
      () => readWarcPayload(zip, { filename: "nope.warc.gz", offset: 0, length: 10 }),
      /WARC not found in WACZ: nope.warc.gz/
    );
  } finally {
    zip.close();
  }
});
