// Pulls a single WARC record's HTTP payload out of a WACZ, by byte range.
//
// WACZ stores archive/*.warc(.gz) with zip method "Stored", so a byte range in
// the zip is a byte range in the file, and the CDX records filename/offset/
// length for every resource. Each WARC record is usually its own gzip member.
// Together that means one archived resource can be read out of a multi-
// gigabyte archive with a single ranged read and one gunzip -- no replay, no
// browser.
import zlib from "node:zlib";
import crypto from "node:crypto";
import type { ZipHandle } from "./zipread.js";

// Where a resource's bytes live, as recorded in the CDX index.
export interface WarcLocator {
  filename: string;
  offset: number;
  length: number;
  digest?: string;
}

export interface WarcPayload {
  payload: Buffer;
  warcType: string;
  status: number;
  contentType: string;
  // true/false when the CDX recorded a digest we could check, null otherwise.
  digestOk: boolean | null;
}

const CRLF2 = "\r\n\r\n";

// Resolve a CDX "filename" to a zip entry. WACZ puts WARCs under archive/,
// but match on the basename too so unusual layouts still resolve.
function warcEntryName(zip: ZipHandle, filename: string): string {
  if (zip.has(`archive/${filename}`)) return `archive/${filename}`;
  if (zip.has(filename)) return filename;
  const hit = zip.names().find((n) => n.endsWith(`/${filename}`));
  if (!hit) throw new Error(`WARC not found in WACZ: ${filename}`);
  return hit;
}

// Read a header out of a raw HTTP header block.
function header(headers: string, name: string): string {
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(headers);
  return m ? m[1].trim() : "";
}

// Undo HTTP chunked transfer-encoding.
function dechunk(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let p = 0;
  for (;;) {
    const nl = buf.indexOf("\r\n", p);
    if (nl === -1) break;
    // Chunk header is a hex length, optionally followed by ";extension".
    const size = parseInt(buf.toString("latin1", p, nl).split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break; // 0-length chunk terminates
    out.push(buf.subarray(nl + 2, nl + 2 + size));
    p = nl + 2 + size + 2; // past the chunk and its trailing CRLF
  }
  return Buffer.concat(out);
}

// Reverse Content-Encoding. Best-effort: a body we can't decode is still worth
// more to the caller than an exception.
function decodeBody(buf: Buffer, encoding: string): Buffer {
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(buf);
    if (encoding === "deflate") return zlib.inflateSync(buf);
    if (encoding === "br") return zlib.brotliDecompressSync(buf);
  } catch {
    /* fall through */
  }
  return buf;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// WARC digests are conventionally RFC 4648 base32, unpadded.
function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Strip an "alg:" prefix so digests from different writers compare equal.
export function normalizeDigest(digest: string): string {
  return digest.trim().replace(/^[a-z0-9]+:/i, "").toUpperCase();
}

// Check a payload against a CDX digest. Handles "sha256:<hex>" (browsertrix),
// "sha1:<base32>" and bare values of either shape. Returns null when the
// digest is in a form we don't recognise, so callers can tell "no opinion"
// apart from "mismatch".
function digestMatches(payload: Buffer, digest: string): boolean | null {
  const prefixed = /^(sha1|sha256|md5):(.+)$/i.exec(digest.trim());
  const value = (prefixed ? prefixed[2] : digest).trim();
  let alg = prefixed ? prefixed[1].toLowerCase() : "";
  if (!alg) {
    if (/^[0-9a-f]{64}$/i.test(value)) alg = "sha256";
    else if (/^[A-Z2-7]{32}$/.test(value)) alg = "sha1";
    else return null;
  }
  const hash = crypto.createHash(alg).update(payload).digest();
  if (/^[0-9a-f]+$/i.test(value) && value.length === hash.length * 2) {
    return value.toLowerCase() === hash.toString("hex");
  }
  return base32(hash) === value.toUpperCase();
}

// Some writers leave the record's trailing CRLFCRLF separator attached when
// there is no Content-Length to cut on.
function trimRecordTrailer(buf: Buffer): Buffer {
  return buf.subarray(0, buf.length - (buf.subarray(-4).toString("latin1") === CRLF2 ? 4 : 0));
}

// Plausible readings of the entity body, best guess first.
//
// The stored bytes are not always in the shape the headers describe. Crawlers
// commonly record an already-de-chunked body while keeping the response's
// original "Transfer-Encoding: chunked" header -- and de-chunking such a body
// finds no valid chunk length, so it yields nothing at all. So the headers are
// a hint about how to cut the body, not a fact; the caller lets the recorded
// digest choose between the readings they suggest.
function bodyCandidates(body: Buffer, httpHeaders: string): Buffer[] {
  const out: Buffer[] = [];
  const contentLength = parseInt(header(httpHeaders, "Content-Length"), 10);
  if (header(httpHeaders, "Transfer-Encoding").toLowerCase().includes("chunked")) {
    const dechunked = dechunk(body);
    if (dechunked.length) out.push(dechunked);
  } else if (Number.isFinite(contentLength) && contentLength <= body.length) {
    // Required: without this we keep the 4-byte WARC record separator and the
    // payload no longer matches its recorded digest.
    out.push(body.subarray(0, contentLength));
  }
  out.push(trimRecordTrailer(body));
  return out;
}

// Choose the reading the recorded digest vouches for. With no digest, or one in
// a form we don't recognise, there is nothing to check against -- take the
// first reading and report no opinion rather than a mismatch.
function pickBody(
  candidates: Buffer[],
  digest?: string
): { stored: Buffer; digestOk: boolean | null } {
  if (!digest) return { stored: candidates[0], digestOk: null };
  for (const candidate of candidates) {
    const verdict = digestMatches(candidate, digest);
    if (verdict === true) return { stored: candidate, digestOk: true };
    if (verdict === null) return { stored: candidates[0], digestOk: null };
  }
  return { stored: candidates[0], digestOk: false };
}

// Read the record at `loc` and return its HTTP entity body.
export function readWarcPayload(zip: ZipHandle, loc: WarcLocator): WarcPayload {
  const raw = zip.readRange(warcEntryName(zip, loc.filename), loc.offset, loc.length);
  // Records are normally individually gzipped members, but plain WARCs exist
  // (and a ".warc" name is no guarantee either way) -- so sniff the magic.
  const rec = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;

  const endWarc = rec.indexOf(CRLF2);
  if (endWarc === -1) throw new Error("malformed WARC record (no header break)");
  const warcType = header(rec.toString("latin1", 0, endWarc), "WARC-Type");

  // A revisit record is a pointer to a payload stored elsewhere (crawl-level
  // dedup), so there is nothing to return; the caller resolves it by digest.
  if (warcType === "revisit") {
    return { payload: Buffer.alloc(0), warcType, status: 0, contentType: "", digestOk: null };
  }

  const endHttp = rec.indexOf(CRLF2, endWarc + 4);
  if (endHttp === -1) throw new Error("malformed WARC record (no HTTP header break)");
  const httpHeaders = rec.toString("latin1", endWarc + 4, endHttp);
  const status = parseInt(httpHeaders.split("\r\n")[0].split(/\s+/)[1] ?? "", 10) || 0;

  // The digest covers the body as stored, i.e. before Content-Encoding is
  // reversed -- so choose and verify first, then decode.
  const { stored, digestOk } = pickBody(
    bodyCandidates(rec.subarray(endHttp + 4), httpHeaders),
    loc.digest
  );
  const encoding = header(httpHeaders, "Content-Encoding").toLowerCase();
  const payload = encoding ? decodeBody(stored, encoding) : stored;

  return {
    payload,
    warcType,
    status,
    contentType: header(httpHeaders, "Content-Type").split(";")[0].trim().toLowerCase(),
    digestOk,
  };
}
