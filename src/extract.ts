// Copies archived PDFs straight out of the WARC.
//
// A PDF in a web archive is already a PDF. Replaying one would only screenshot
// Chromium's PDF viewer at viewport size -- rasterized, re-paginated, no text
// layer. Reading the original bytes instead is both faster (no browser at all)
// and lossless: fonts, vectors, bookmarks and page count all survive.
import fs from "node:fs";
import path from "node:path";
import { openZip, type ZipHandle } from "./zipread.js";
import { readWarcPayload, normalizeDigest, type WarcLocator } from "./warc.js";
import { readCdx, type PageJob, type PageResult } from "./wacz.js";
import { urlToFilename } from "./util.js";

export interface ExtractArgs {
  outDir: string;
  // Overall job count, for progress display across both passes.
  total?: number;
  onProgress?: (r: PageResult) => void;
}

// Map payload digest -> a record that actually holds those bytes, so revisit
// records (crawl-level dedup) can be resolved back to the original capture.
function buildDigestIndex(zip: ZipHandle): Map<string, WarcLocator> {
  const byDigest = new Map<string, WarcLocator>();
  for (const rec of readCdx(zip)) {
    if (!rec.locator?.digest || rec.mime === "warc/revisit") continue;
    const key = normalizeDigest(rec.locator.digest);
    if (!byDigest.has(key)) byDigest.set(key, rec.locator);
  }
  return byDigest;
}

// Write one page's archived bytes to outDir. Throws on anything that would
// leave a bad file behind; the caller turns that into a failed result.
function extractOne(
  zip: ZipHandle,
  job: PageJob,
  file: string,
  digestIndex: () => Map<string, WarcLocator>
): void {
  if (!job.locator) throw new Error("no CDX record for this URL");
  let rec = readWarcPayload(zip, job.locator);

  // A revisit holds no payload -- follow its digest to the capture that does.
  if (rec.warcType === "revisit") {
    const original = job.locator.digest
      ? digestIndex().get(normalizeDigest(job.locator.digest))
      : undefined;
    if (!original) throw new Error("revisit record, original payload not in this WACZ");
    rec = readWarcPayload(zip, original);
  }

  if (rec.payload.length === 0) throw new Error("empty payload");
  if (rec.digestOk === false) throw new Error("payload digest mismatch");
  fs.writeFileSync(file, rec.payload);
}

// Extract each job's archived file. Synchronous and browser-free, so this runs
// before (and independently of) the replay pass.
export function extractPages(
  waczPath: string,
  jobs: PageJob[],
  { outDir, total, onProgress }: ExtractArgs
): PageResult[] {
  fs.mkdirSync(outDir, { recursive: true });
  const zip = openZip(waczPath);
  // Only built if a revisit actually turns up; it means a second CDX parse.
  let cached: Map<string, WarcLocator> | null = null;
  const digestIndex = (): Map<string, WarcLocator> => (cached ??= buildDigestIndex(zip));

  const results: PageResult[] = [];
  try {
    for (const job of jobs) {
      const file = path.join(outDir, urlToFilename(job.url, job.index));
      const base = { ...job, file, via: "extract" as const, total: total ?? jobs.length };
      let result: PageResult;
      try {
        extractOne(zip, job, file, digestIndex);
        result = { ...base, ok: true };
      } catch (err) {
        result = { ...base, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      results.push(result);
      if (onProgress) onProgress(result);
    }
  } finally {
    zip.close();
  }
  return results;
}
