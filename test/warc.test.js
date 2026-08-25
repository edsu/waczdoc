import { test } from "node:test";
import assert from "node:assert/strict";
import { openZip } from "../dist/zipread.js";
import { readWarcPayload, normalizeDigest } from "../dist/warc.js";
import { listPages } from "../dist/wacz.js";
import {
  FIXTURE_1,
  FIXTURE_2,
  sha256Digest,
  warcResponseRecord,
  writeStoredZip,
} from "./helpers.js";

const WARC = "archive/test.warc";

// Read back a synthetic single-record WARC, as if the CDX pointed at it.
function readSynthetic({ httpHeaders, body, digest }) {
  const record = warcResponseRecord({ httpHeaders, body });
  const { path, cleanup } = writeStoredZip([{ name: WARC, data: record }]);
  const zip = openZip(path);
  try {
    return readWarcPayload(zip, {
      filename: "test.warc",
      offset: 0,
      length: record.length,
      digest,
    });
  } finally {
    zip.close();
    cleanup();
  }
}

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

// Crawlers commonly store an already-de-chunked body but keep the response's
// original Transfer-Encoding header. De-chunking those bytes finds no valid
// chunk length and yields nothing, which used to surface as "empty payload".
test("a chunked header over an already-de-chunked body reads the body", () => {
  const body = Buffer.from("<html><body><p>Hello.</p></body></html>", "latin1");
  const rec = readSynthetic({
    httpHeaders: "Content-Type: text/html\r\nTransfer-Encoding: chunked",
    body,
    digest: sha256Digest(body),
  });
  assert.equal(rec.payload.toString(), body.toString());
  assert.equal(rec.digestOk, true);
});

test("a genuinely chunked body is still de-chunked", () => {
  const content = "<html><body>chunked!</body></html>";
  const chunked = Buffer.from(
    `${content.length.toString(16)}\r\n${content}\r\n0\r\n\r\n`,
    "latin1"
  );
  const rec = readSynthetic({
    httpHeaders: "Content-Type: text/html\r\nTransfer-Encoding: chunked",
    body: chunked,
    digest: sha256Digest(Buffer.from(content, "latin1")),
  });
  assert.equal(rec.payload.toString(), content);
  assert.equal(rec.digestOk, true);
});

// With no digest to arbitrate, the header is all we have to go on.
test("framing is chosen without a digest too", () => {
  const body = Buffer.from("<html><body><p>No digest.</p></body></html>", "latin1");
  const rec = readSynthetic({
    httpHeaders: "Content-Type: text/html\r\nTransfer-Encoding: chunked",
    body,
  });
  assert.equal(rec.payload.toString(), body.toString());
  assert.equal(rec.digestOk, null, "no digest means no opinion, not a mismatch");
});

test("a body matching no reading is reported as a digest mismatch", () => {
  const rec = readSynthetic({
    httpHeaders: "Content-Type: text/html\r\nContent-Length: 10",
    body: Buffer.from("0123456789", "latin1"),
    digest: sha256Digest(Buffer.from("something else entirely", "latin1")),
  });
  assert.equal(rec.digestOk, false);
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
