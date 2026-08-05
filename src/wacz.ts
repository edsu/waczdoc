// Reads a WACZ archive: enumerates HTML pages from the CDX(J) index,
// and merges in titles from pages/pages.jsonl when available.
import zlib from "node:zlib";
import { openZip, type ZipHandle } from "./zipread.js";

export interface Page {
  url: string;
  timestamp: string;
  mime: string;
  status: string;
  title: string | null;
}

type CdxEntry = Omit<Page, "title">;

// WACZ ZipNum indexes concatenate many gzip members (one per CDX cluster).
// Node's gunzipSync decompresses all concatenated members in one call, so a
// plain gunzip covers both single-cluster and ZipNum indexes.
function decompressCdx(buf: Buffer): Buffer {
  return zlib.gunzipSync(buf);
}

// Parse a CDXJ body (one record per line) into HTML capture entries.
function parseCdxj(text: string): CdxEntry[] {
  const out: CdxEntry[] = [];
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
    const mime = String(rec.mime || rec.mime_type || "").toLowerCase();
    const status = String(rec.status ?? rec.status_code ?? "");
    // timestamp is usually the second whitespace-delimited field
    let ts = rec.timestamp as string | undefined;
    if (!ts) {
      const parts = trimmed.slice(0, brace).trim().split(/\s+/);
      ts = parts[parts.length - 1];
    }
    if (!url) continue;
    const isHtml =
      mime === "text/html" ||
      mime === "application/xhtml+xml" ||
      mime.startsWith("text/html");
    // Only successful captures make sense to render.
    const ok = status === "" || status === "200";
    if (isHtml && ok) {
      out.push({ url, timestamp: String(ts || ""), mime, status });
    }
  }
  return out;
}

// Read pages/pages.jsonl -> Map<url, title>
function readPageTitles(zip: ZipHandle): Map<string, string> {
  const titles = new Map<string, string>();
  const pageFiles = zip.readMatching((name) =>
    /(^|\/)pages\/.*\.jsonl$/.test(name)
  );
  for (const { data } of pageFiles) {
    const text = data.toString("utf8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec.url && rec.title) titles.set(rec.url, rec.title);
      } catch {
        /* header line or malformed - skip */
      }
    }
  }
  return titles;
}

// Enumerate HTML pages from a WACZ file path.
export function listHtmlPages(waczPath: string): Page[] {
  const zip = openZip(waczPath);
  try {
    const cdxEntries = zip.readMatching((name) =>
      /(^|\/)indexes\/.+\.(cdx|cdxj)(\.gz)?$/.test(name)
    );
    if (cdxEntries.length === 0) {
      throw new Error(
        "No CDX index found under indexes/ in the WACZ. " +
          "(Looked for *.cdx, *.cdxj, optionally .gz)"
      );
    }

    const found: CdxEntry[] = [];
    for (const { name, data } of cdxEntries) {
      const text = name.endsWith(".gz")
        ? decompressCdx(data).toString("utf8")
        : data.toString("utf8");
      found.push(...parseCdxj(text));
    }

    // Dedup by URL, keeping the most recent capture (largest timestamp string).
    const byUrl = new Map<string, CdxEntry>();
    for (const rec of found) {
      const prev = byUrl.get(rec.url);
      if (!prev || rec.timestamp > prev.timestamp) byUrl.set(rec.url, rec);
    }

    const titles = readPageTitles(zip);
    const pages: Page[] = [...byUrl.values()].map((p) => ({
      ...p,
      title: titles.get(p.url) || null,
    }));

    // Stable, deterministic order.
    pages.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    return pages;
  } finally {
    zip.close();
  }
}
