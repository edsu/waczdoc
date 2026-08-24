// Copies archived PDFs straight out of the WARC.
//
// A PDF in a web archive is already a PDF. Replaying one would only screenshot
// Chromium's PDF viewer at viewport size -- rasterized, re-paginated, no text
// layer. Reading the original bytes instead is both faster (no browser at all)
// and lossless: fonts, vectors, bookmarks and page count all survive.
import fs from "node:fs";
import path from "node:path";
import { openZip, digestIndexer, readJobPayload } from "./payload.js";
import type { PageJob, PageResult } from "./wacz.js";
import { urlToFilename } from "./util.js";

export interface ExtractArgs {
  outDir: string;
  // Overall job count, for progress display across both passes.
  total?: number;
  onProgress?: (r: PageResult) => void;
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
  const digestIndex = digestIndexer(zip);

  const results: PageResult[] = [];
  try {
    for (const job of jobs) {
      const file = path.join(outDir, urlToFilename(job.url, job.index));
      const base = { ...job, file, via: "extract" as const, total: total ?? jobs.length };
      let result: PageResult;
      try {
        fs.writeFileSync(file, readJobPayload(zip, job, digestIndex));
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
