// Reads a WACZ archive's page list.
//
// Pages come from pages/pages.jsonl and pages/extraPages.jsonl when present:
// that is the crawler's own record of what it treated as a page (seeds, plus
// pages discovered during the crawl). The CDX index is a poor substitute for
// it, because "every text/html 200 in the archive" also means every iframe,
// ad frame and XHR-fetched fragment -- none of which anyone wants a PDF of.
//
// The CDX is still read, for two reasons: it is the only place recording where
// each resource's bytes live (filename/offset/length), which is what lets us
// pull archived PDFs out directly instead of replaying them; and it is the
// fallback page list for archives written without pages/*.jsonl.
import zlib from "node:zlib";
import { openZip, type ZipHandle } from "./zipread.js";
import type { WarcLocator } from "./warc.js";

export interface Page {
  url: string;
  // 14-digit capture timestamp, as the replay URL wants it.
  timestamp: string;
  mime: string;
  status: string;
  title: string | null;
  // Which source this page was discovered from.
  discoveredIn: "pages" | "cdx";
  // Null when the page list names a URL the CDX doesn't cover.
  locator: WarcLocator | null;
}

// A page plus its position in the overall run, so output filenames stay in
// order across the extract and render passes.
export interface PageJob extends Page {
  index: number;
}

export interface PageResult extends PageJob {
  file: string;
  ok: boolean;
  error?: string;
  total?: number;
  // How the file was produced: replayed in a browser, copied out of a WARC, or
  // parsed out of archived HTML.
  via: "render" | "extract" | "markdown";
}

export interface CdxRecord {
  url: string;
  timestamp: string;
  mime: string;
  status: string;
  locator: WarcLocator | null;
}

export type PageKind = "html" | "pdf" | "other";

// What to do with a page: replay it, copy it out, or leave it alone.
export function pageKind(p: { mime: string }): PageKind {
  const m = p.mime;
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/html") || m === "application/xhtml+xml") return "html";
  // The 2020-era pages.jsonl records no mime at all. Those archives list only
  // HTML pages, so an unknown mime is treated as HTML.
  if (!m) return "html";
  return "other";
}

// WACZ ZipNum indexes concatenate many gzip members (one per CDX cluster).
// Node's gunzipSync decompresses all concatenated members in one call, so a
// plain gunzip covers both single-cluster and ZipNum indexes.
function decompressCdx(buf: Buffer): Buffer {
  return zlib.gunzipSync(buf);
}

// Parse a CDXJ body (one record per line). Every record is kept, not just the
// HTML ones -- the locators for images, PDFs and the rest are the whole point.
function parseCdxj(text: string): CdxRecord[] {
  const out: CdxRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // CDXJ lines are: <searchKey> <timestamp> <json>. Some variants are
    // pure JSON. Grab the JSON object starting at the first '{'.
    const brace = trimmed.indexOf("{");
    if (brace === -1) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed.slice(brace));
    } catch {
      continue;
    }
    const url = (rec.url || rec.uri) as string | undefined;
    if (!url) continue;
    // timestamp is usually the second whitespace-delimited field
    let ts = rec.timestamp as string | undefined;
    if (!ts) {
      const parts = trimmed.slice(0, brace).trim().split(/\s+/);
      ts = parts[parts.length - 1];
    }
    const offset = Number(rec.offset);
    const length = Number(rec.length);
    const filename = rec.filename as string | undefined;
    out.push({
      url,
      timestamp: String(ts || ""),
      mime: String(rec.mime || rec.mime_type || "").toLowerCase(),
      status: String(rec.status ?? rec.status_code ?? ""),
      locator:
        filename && Number.isFinite(offset) && Number.isFinite(length)
          ? { filename, offset, length, digest: rec.digest as string | undefined }
          : null,
    });
  }
  return out;
}

// Read every CDX(J) index in the archive.
export function readCdx(zip: ZipHandle): CdxRecord[] {
  const files = zip.readMatching((name) =>
    /(^|\/)indexes\/.+\.(cdx|cdxj)(\.gz)?$/.test(name)
  );
  const out: CdxRecord[] = [];
  for (const { name, data } of files) {
    const text = name.endsWith(".gz")
      ? decompressCdx(data).toString("utf8")
      : data.toString("utf8");
    out.push(...parseCdxj(text));
  }
  return out;
}

// One entry from pages/*.jsonl. Fields beyond url/ts/title only appear in
// newer (browsertrix) files.
interface PageRecord {
  url: string;
  ts?: string;
  title?: string;
  mime?: string;
  status?: number;
}

// Read pages/pages.jsonl and pages/extraPages.jsonl. The first line of each
// file is a format header rather than a page, and is skipped by the no-url
// check.
function readPagesJsonl(zip: ZipHandle): PageRecord[] {
  const out: PageRecord[] = [];
  const files = zip.readMatching((name) => /(^|\/)pages\/.*\.jsonl$/.test(name));
  for (const { data } of files) {
    for (const line of data.toString("utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as PageRecord;
        if (rec.url) out.push(rec);
      } catch {
        /* malformed line - skip */
      }
    }
  }
  return out;
}

// pages.jsonl timestamps are ISO 8601 ("2025-05-07T07:55:13.401Z"); replay
// wants the 14-digit form.
function toTimestamp(ts: string | undefined): string {
  return ts ? ts.replace(/\D/g, "").slice(0, 14) : "";
}

// Keep the most recent capture per URL.
function latestByUrl<T extends { url: string; timestamp: string }>(recs: T[]): Map<string, T> {
  const byUrl = new Map<string, T>();
  for (const r of recs) {
    const prev = byUrl.get(r.url);
    if (!prev || r.timestamp > prev.timestamp) byUrl.set(r.url, r);
  }
  return byUrl;
}

// Build the page list from pages/*.jsonl, filling in anything it omits (mime,
// status, an exact timestamp, the locator) from the matching CDX record.
function fromPagesJsonl(recs: PageRecord[], cdx: Map<string, CdxRecord>): Page[] {
  const pages = recs.map((r) => {
    const c = cdx.get(r.url);
    return {
      url: r.url,
      timestamp: toTimestamp(r.ts) || c?.timestamp || "",
      mime: (r.mime || c?.mime || "").toLowerCase(),
      status: String(r.status ?? c?.status ?? ""),
      title: r.title || null,
      discoveredIn: "pages" as const,
      locator: c?.locator ?? null,
    };
  });
  // Drop pages the crawler recorded as failures; keep ones with no status,
  // since the older format doesn't record one.
  const ok = pages.filter((p) => p.status === "" || p.status.startsWith("2"));
  return [...latestByUrl(ok).values()];
}

// Fallback for archives with no pages/*.jsonl. Restricted to HTML 200s: in a
// CDX there is nothing to distinguish a PDF the crawler navigated to from one
// it merely happened to fetch, so the conservative list is the right one.
function fromCdx(cdx: Map<string, CdxRecord>): Page[] {
  const pages: Page[] = [];
  for (const c of cdx.values()) {
    if (pageKind(c) !== "html" || !(c.status === "" || c.status === "200")) continue;
    pages.push({ ...c, title: null, discoveredIn: "cdx" });
  }
  return pages;
}

// Enumerate the pages in a WACZ file.
export function listPages(waczPath: string): Page[] {
  const zip = openZip(waczPath);
  try {
    const cdx = latestByUrl(readCdx(zip));
    const listed = readPagesJsonl(zip);
    if (listed.length === 0 && cdx.size === 0) {
      throw new Error(
        "No page list found in the WACZ. (Looked for pages/*.jsonl and " +
          "indexes/*.cdx, *.cdxj, optionally .gz)"
      );
    }

    const titles = new Map(listed.filter((r) => r.title).map((r) => [r.url, r.title!]));
    const pages = listed.length ? fromPagesJsonl(listed, cdx) : fromCdx(cdx);
    for (const p of pages) p.title ??= titles.get(p.url) ?? null;

    // Stable, deterministic order.
    pages.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    return pages;
  } finally {
    zip.close();
  }
}
