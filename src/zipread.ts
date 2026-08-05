// Minimal random-access ZIP reader for large (multi-GB) WACZ files.
//
// adm-zip / fs.readFileSync load the whole archive into a Buffer, which fails
// past Node's 2 GiB file-read limit. A WACZ is mostly big WARC payloads we
// never touch here; we only need the tiny index/metadata entries. So we parse
// the central directory (at the end of the file) and read just those entries
// by byte range. Handles Zip64 for archives >4 GiB or with offsets past 4 GiB.
import fs from "node:fs";
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipHandle {
  entries: ZipEntry[];
  names(): string[];
  has(name: string): boolean;
  read(name: string): Buffer;
  readMatching(test: (name: string) => boolean): { name: string; data: Buffer }[];
  close(): void;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) break; // EOF
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

function findEOCD(fd: number, size: number): { buf: Buffer; off: number; tailStart: number } {
  const maxTail = Math.min(size, 22 + U16_MAX); // EOCD + max comment
  const tail = readAt(fd, size - maxTail, maxTail);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      return { buf: tail, off: i, tailStart: size - maxTail };
    }
  }
  throw new Error("Not a zip file (no End Of Central Directory record found)");
}

// Returns { entriesCount, cdOffset, cdSize }, resolving Zip64 when needed.
function readCentralDirInfo(
  fd: number,
  size: number
): { entriesCount: number; cdOffset: number; cdSize: number } {
  const { buf, off, tailStart } = findEOCD(fd, size);
  let entriesCount = buf.readUInt16LE(off + 10);
  let cdSize = buf.readUInt32LE(off + 12);
  let cdOffset = buf.readUInt32LE(off + 16);

  const needs64 =
    entriesCount === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX;
  if (needs64) {
    // The Zip64 EOCD locator sits 20 bytes before the EOCD.
    const locAbs = tailStart + off - 20;
    if (locAbs >= 0) {
      const loc = readAt(fd, locAbs, 20);
      if (loc.length === 20 && loc.readUInt32LE(0) === EOCD64_LOCATOR_SIG) {
        const eocd64Off = Number(loc.readBigUInt64LE(8));
        const rec = readAt(fd, eocd64Off, 56);
        if (rec.readUInt32LE(0) === EOCD64_SIG) {
          entriesCount = Number(rec.readBigUInt64LE(32));
          cdSize = Number(rec.readBigUInt64LE(40));
          cdOffset = Number(rec.readBigUInt64LE(48));
        }
      }
    }
  }
  return { entriesCount, cdOffset, cdSize };
}

// Parse a Zip64 extra field, filling in any values that were 0xFFFFFFFF.
function applyZip64Extra(extra: Buffer, entry: ZipEntry): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const sz = extra.readUInt16LE(p + 2);
    const body = extra.subarray(p + 4, p + 4 + sz);
    if (id === 0x0001) {
      let q = 0;
      if (entry.uncompressedSize === U32_MAX && q + 8 <= body.length) {
        entry.uncompressedSize = Number(body.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.compressedSize === U32_MAX && q + 8 <= body.length) {
        entry.compressedSize = Number(body.readBigUInt64LE(q));
        q += 8;
      }
      if (entry.localHeaderOffset === U32_MAX && q + 8 <= body.length) {
        entry.localHeaderOffset = Number(body.readBigUInt64LE(q));
      }
    }
    p += 4 + sz;
  }
}

// Read and parse all central-directory entries.
function readEntries(fd: number, size: number): ZipEntry[] {
  const { entriesCount, cdOffset, cdSize } = readCentralDirInfo(fd, size);
  const cd = readAt(fd, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < entriesCount && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== CEN_SIG) break;
    const method = cd.readUInt16LE(p + 10);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const entry: ZipEntry = {
      name: cd.toString("utf8", p + 46, p + 46 + nameLen),
      method,
      compressedSize: cd.readUInt32LE(p + 20),
      uncompressedSize: cd.readUInt32LE(p + 24),
      localHeaderOffset: cd.readUInt32LE(p + 42),
    };
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    applyZip64Extra(extra, entry);
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Read a single entry's bytes, decompressing STORE (0) and DEFLATE (8).
function readEntryData(fd: number, entry: ZipEntry): Buffer {
  // The local header repeats the name/extra with possibly different extra
  // length, so read it to find where the data actually starts.
  const loc = readAt(fd, entry.localHeaderOffset, 30);
  if (loc.readUInt32LE(0) !== LOC_SIG) {
    throw new Error(`Bad local header for ${entry.name}`);
  }
  const nameLen = loc.readUInt16LE(26);
  const extraLen = loc.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const raw = readAt(fd, dataStart, entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported zip compression method ${entry.method}`);
}

// Open a WACZ/zip and expose ranged access to its entries.
export function openZip(path: string): ZipHandle {
  const fd = fs.openSync(path, "r");
  const size = fs.fstatSync(fd).size;
  const entries = readEntries(fd, size);
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries,
    names: () => entries.map((e) => e.name),
    has: (name) => byName.has(name),
    read: (name) => {
      const e = byName.get(name);
      if (!e) throw new Error(`Entry not found in zip: ${name}`);
      return readEntryData(fd, e);
    },
    readMatching: (test) =>
      entries
        .filter((e) => test(e.name))
        .map((e) => ({ name: e.name, data: readEntryData(fd, e) })),
    close: () => fs.closeSync(fd),
  };
}
