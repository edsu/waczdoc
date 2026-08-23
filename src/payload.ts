// Reads one page's archived bytes out of a WACZ, following revisit records.
//
// Both output passes that skip the browser need this: --extract copies the
// bytes straight to disk, --markdown parses them. The revisit chase is the
// fiddly part -- a deduped capture stores no payload of its own -- so it lives
// here once rather than in each caller.
import { openZip, type ZipHandle } from "./zipread.js";
import { readWarcPayload, normalizeDigest, type WarcLocator } from "./warc.js";
import { readCdx, type PageJob } from "./wacz.js";

export type { ZipHandle };
export { openZip };

// Resolves a payload digest to a record that actually holds those bytes.
// Building it means a second full CDX parse, so callers get a thunk and only
// pay for it if a revisit actually turns up.
export type DigestIndex = () => Map<string, WarcLocator>;

export function digestIndexer(zip: ZipHandle): DigestIndex {
  let cached: Map<string, WarcLocator> | null = null;
  return () =>
    (cached ??= (() => {
      const byDigest = new Map<string, WarcLocator>();
      for (const rec of readCdx(zip)) {
        if (!rec.locator?.digest || rec.mime === "warc/revisit") continue;
        const key = normalizeDigest(rec.locator.digest);
        if (!byDigest.has(key)) byDigest.set(key, rec.locator);
      }
      return byDigest;
    })());
}

export interface JobPayload {
  bytes: Buffer;
  // Charset the server declared, for callers that have to decode the bytes.
  charset: string;
}

// Return the archived bytes for one page. Throws on anything that would leave
// a bad file behind; callers turn that into a failed result for that page.
export function readJobPayload(
  zip: ZipHandle,
  job: PageJob,
  digestIndex: DigestIndex
): JobPayload {
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
  return { bytes: rec.payload, charset: rec.charset };
}
