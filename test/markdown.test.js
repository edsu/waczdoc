import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { markdownPages } from "../dist/markdown.js";
import { listPages } from "../dist/wacz.js";
import {
  FIXTURE_1,
  sha256Digest,
  tmpDir,
  warcResponseRecord,
  writeStoredZip,
} from "./helpers.js";

// An article whose text needs a non-UTF-8 byte to survive the round trip: é is
// one byte (0xE9) in ISO-8859-1 and an invalid UTF-8 sequence on its own, so a
// wrong decoding shows up as U+FFFD rather than passing silently.
const LATIN1_ARTICLE =
  "<html><head><title>Café life</title>TITLE_META</head><body><article>" +
  "<h1>Café life</h1>" +
  "<p>The café on the corner opened in 1908 and has not changed since. " +
  "Its façade is unmistakable, and the crème brûlée is still made by hand.</p>" +
  "<p>Every naïve visitor orders a café au lait and a slice of gâteau, " +
  "then lingers over the papers until the afternoon light goes.</p>" +
  "</article></body></html>";

// Build a one-page WACZ whose stored bytes are ISO-8859-1, and convert it.
async function convertLatin1({ httpCharset, metaCharset }) {
  const html = LATIN1_ARTICLE.replace(
    "TITLE_META",
    metaCharset ? `<meta charset="${metaCharset}">` : ""
  );
  // latin1 maps every code point below 0x100 straight to that byte value,
  // which is exactly ISO-8859-1.
  const body = Buffer.from(html, "latin1");
  const contentType = `text/html${httpCharset ? `; charset=${httpCharset}` : ""}`;
  const record = warcResponseRecord({
    url: "https://example.org/cafe",
    httpHeaders: `Content-Type: ${contentType}`,
    body,
  });
  const zip = writeStoredZip([{ name: "archive/test.warc", data: record }]);
  const { dir, cleanup } = tmpDir();
  try {
    const job = {
      url: "https://example.org/cafe",
      timestamp: "20240115120000",
      mime: "text/html",
      status: "200",
      title: null,
      discoveredIn: "pages",
      index: 0,
      locator: {
        filename: "test.warc",
        offset: 0,
        length: record.length,
        digest: sha256Digest(body),
      },
    };
    const [result] = await markdownPages(zip.path, [job], { outDir: dir });
    return { result, text: result.ok ? fs.readFileSync(result.file, "utf8") : "" };
  } finally {
    cleanup();
    zip.cleanup();
  }
}

// The fixture holds one HTML page (example.com), which is enough to exercise
// the whole static path: ranged read, DOM parse, article extraction.
async function convertFixture(mutate = (j) => j, opts = {}) {
  const jobs = listPages(FIXTURE_1).map((p, index) => mutate({ ...p, index }));
  const { dir, cleanup } = tmpDir();
  try {
    const results = await markdownPages(FIXTURE_1, jobs, { outDir: dir, ...opts });
    return { results, dir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

test("converts archived HTML to markdown without a browser", async () => {
  const { results, cleanup } = await convertFixture();
  try {
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.ok, true, r.error);
    assert.equal(r.via, "markdown");
    assert.match(r.file, /\.md$/);
    const text = fs.readFileSync(r.file, "utf8");
    assert.match(text, /This domain is for use in illustrative examples/);
    // The article text, not the raw HTML.
    assert.doesNotMatch(text, /<body|<div/);
  } finally {
    cleanup();
  }
});

test("links in the output point at the original URLs", async () => {
  const { results, cleanup } = await convertFixture();
  try {
    const text = fs.readFileSync(results[0].file, "utf8");
    assert.match(text, /\[More information\.\.\.\]\(https:\/\/www\.iana\.org\/domains\/example\)/);
    // Nothing rewritten for replay leaked in.
    assert.doesNotMatch(text, /\/w\/coll\//);
  } finally {
    cleanup();
  }
});

test("front matter records the title, URL and capture time", async () => {
  const { results, cleanup } = await convertFixture();
  try {
    const text = fs.readFileSync(results[0].file, "utf8");
    const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(block, "starts with a front matter block");
    assert.match(block[1], /^title: "Example Domain"$/m);
    assert.match(block[1], /^url: "http:\/\/www\.example\.com\/"$/m);
    assert.match(block[1], /^archived: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"$/m);
  } finally {
    cleanup();
  }
});

test("--no-front-matter writes just the content", async () => {
  const { results, cleanup } = await convertFixture((j) => j, { frontMatter: false });
  try {
    const text = fs.readFileSync(results[0].file, "utf8");
    assert.doesNotMatch(text, /^---/);
    assert.match(text, /This domain is for use in illustrative examples/);
  } finally {
    cleanup();
  }
});

test("output filenames use the job index and a .md extension", async () => {
  const { results, dir, cleanup } = await convertFixture((j) => ({ ...j, index: 41 }));
  try {
    assert.equal(path.basename(results[0].file), "0042_www.example.com_index.md");
    assert.deepEqual(fs.readdirSync(dir), ["0042_www.example.com_index.md"]);
  } finally {
    cleanup();
  }
});

test("a page with no CDX record fails without writing a file", async () => {
  const { results, dir, cleanup } = await convertFixture((j) => ({ ...j, locator: null }));
  try {
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /no CDX record/);
    assert.deepEqual(fs.readdirSync(dir), [], "nothing written");
  } finally {
    cleanup();
  }
});

// Reading the archive directly means we see the server's own Content-Type,
// which is the most authoritative statement of a page's encoding.
test("the charset from the HTTP header decodes the page", async () => {
  const { result, text } = await convertLatin1({ httpCharset: "iso-8859-1" });
  assert.equal(result.ok, true, result.error);
  assert.match(text, /crème brûlée/);
  assert.doesNotMatch(text, /�/, "no replacement characters");
});

test("a <meta charset> is used when the header is silent", async () => {
  const { result, text } = await convertLatin1({ metaCharset: "iso-8859-1" });
  assert.equal(result.ok, true, result.error);
  assert.match(text, /crème brûlée/);
  assert.doesNotMatch(text, /�/);
});

test("the HTTP header wins over a conflicting <meta charset>", async () => {
  const { result, text } = await convertLatin1({
    httpCharset: "iso-8859-1",
    metaCharset: "utf-8",
  });
  assert.equal(result.ok, true, result.error);
  assert.match(text, /crème brûlée/);
});

test("an unknown charset label falls back instead of failing the page", async () => {
  const { result } = await convertLatin1({ httpCharset: "definitely-not-a-charset" });
  assert.equal(result.ok, true, result.error);
});

// Documents the default: with nothing declaring otherwise, UTF-8 is assumed,
// and bytes that aren't valid UTF-8 become replacement characters.
test("with no charset declared anywhere, UTF-8 is assumed", async () => {
  const { result, text } = await convertLatin1({});
  assert.equal(result.ok, true, result.error);
  assert.match(text, /�/);
});

// A page list that records no mime is treated as HTML, so binary files can
// reach the parser, which will accept anything, so without a guard an EPUB
// becomes thousands of words of mojibake instead of a reported failure.
test("binary content is refused instead of parsed into mojibake", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const [page] = listPages(FIXTURE_1);
    // Point the locator at the zip's own leading bytes ("PK\x03\x04").
    const jobs = [{ ...page, index: 0, locator: { ...page.locator, offset: 0, length: 400 } }];
    const results = await markdownPages(FIXTURE_1, jobs, { outDir: dir });
    assert.equal(results[0].ok, false);
    assert.deepEqual(fs.readdirSync(dir), [], "nothing written");
  } finally {
    cleanup();
  }
});
