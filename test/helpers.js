import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// Absolute path to a bundled test fixture WACZ.
export function fixture(name) {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

export const FIXTURE_1 = fixture("valid_example_1.wacz");
export const FIXTURE_2 = fixture("valid_example_2.wacz");

// Create a throwaway output directory; returns { dir, cleanup }.
export function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-pdf-test-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A copy of a fixture with its page list hidden, to exercise the CDX fallback.
// The replacement name is the same length as the original, so every zip offset
// (and the name length recorded in each header) stays valid.
const PAGES_NAME = "pages/pages.jsonl";
const HIDDEN_NAME = "pages/pages.jsonx"; // same length; no longer matched

// Build a ZIP with every entry Stored, which is what WACZ requires of its
// WARCs and what makes a ranged read of one work. Lets tests synthesize
// records the bundled fixtures don't contain (odd framings, bad digests).
// Returns { path, cleanup }.
export function writeStoredZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method 0 = Stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central directory signature
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0, 10); // method 0 = Stored
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42); // local header offset
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const body = Buffer.concat(locals);
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // entries total
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16); // central directory offset

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-pdf-zip-"));
  const out = path.join(dir, "synthetic.wacz");
  fs.writeFileSync(out, Buffer.concat([body, cd, eocd]));
  return { path: out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Assemble one uncompressed WARC response record around a body, so tests can
// control the HTTP framing headers independently of the bytes actually stored.
export function warcResponseRecord({ url = "https://example.org/", httpHeaders, body }) {
  const http = Buffer.concat([
    Buffer.from(`HTTP/1.1 200 OK\r\n${httpHeaders}\r\n\r\n`, "latin1"),
    body,
  ]);
  const warc =
    `WARC/1.0\r\nWARC-Type: response\r\nWARC-Target-URI: ${url}\r\n` +
    `Content-Type: application/http; msgtype=response\r\n` +
    `Content-Length: ${http.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(warc, "latin1"), http, Buffer.from("\r\n\r\n", "latin1")]);
}

// The digest form browsertrix records, over the bytes as stored.
export function sha256Digest(buf) {
  return `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`;
}

export function waczWithoutPageList(src) {
  const buf = fs.readFileSync(src);
  let at = 0;
  for (;;) {
    at = buf.indexOf(PAGES_NAME, at, "latin1");
    if (at === -1) break;
    buf.write(HIDDEN_NAME, at, PAGES_NAME.length, "latin1");
    at += PAGES_NAME.length;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wacz-pdf-nopages-"));
  const out = path.join(dir, "no-pages.wacz");
  fs.writeFileSync(out, buf);
  return { path: out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
