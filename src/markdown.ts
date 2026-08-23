// Turns archived HTML into Markdown, without a browser.
//
// This is the static path: the page's original bytes come straight out of the
// WARC (the same ranged read --extract uses), get parsed by linkedom, and
// defuddle picks the article out of the surrounding navigation and turns it
// into Markdown. No replay server, no Chromium, no rewritten URLs -- the links
// in the output are the links the crawler saw.
//
// linkedom rather than jsdom, for two measured reasons. jsdom retained ~20 MB
// per parsed page here -- enough to exhaust a default heap partway through a
// 761-page archive -- where linkedom stays flat. And because jsdom implements
// the layout API without a layout engine, every element reports zero size, so
// defuddle's visibility heuristics prune content that is really there: on one
// crawl jsdom dropped article subtitles and leaked raw <audio> tags into the
// output that linkedom handled correctly.
//
// The tradeoff is that this sees only what the server sent. A page that builds
// its content in JavaScript archives fine and replays fine, but has nothing in
// its HTML for us to read, so it is reported as having no article content.
import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { openZip, digestIndexer, readJobPayload } from "./payload.js";
import type { PageJob, PageResult } from "./wacz.js";
import { urlToFilename } from "./util.js";

export interface MarkdownArgs {
  outDir: string;
  // Overall job count, for progress display across passes.
  total?: number;
  onProgress?: (r: PageResult) => void;
  // Write YAML front matter above the content (default true).
  frontMatter?: boolean;
}

// Byte signatures worth naming in an error message. A page list that records
// no mime type at all is treated as HTML (see pageKind), which is right for the
// archives that do that -- but it means a binary file can reach us, and an HTML
// parser will accept anything handed to it. Left unchecked, an EPUB becomes
// tens of thousands of "words" of mojibake, which is worse than a failed page.
const MAGIC: [string, Buffer][] = [
  ["a ZIP archive (EPUB, DOCX, ...)", Buffer.from("PK\x03\x04", "latin1")],
  ["a PDF", Buffer.from("%PDF", "latin1")],
  ["a PNG image", Buffer.from("\x89PNG", "latin1")],
  ["a GIF image", Buffer.from("GIF8", "latin1")],
  ["a JPEG image", Buffer.from("\xff\xd8\xff", "latin1")],
  ["gzip-compressed data", Buffer.from("\x1f\x8b", "latin1")],
  ["a RIFF container (WAV, WebP, AVI)", Buffer.from("RIFF", "latin1")],
  ["an OGG stream", Buffer.from("OggS", "latin1")],
  ["an ISO media file (MP4, ...)", Buffer.from("\x00\x00\x00\x18ftyp", "latin1")],
];

const BOMS = [
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from([0xff, 0xfe]),
  Buffer.from([0xfe, 0xff]),
];

// Describe why these bytes can't be HTML, or null if they plausibly are.
function notHtml(buf: Buffer): string | null {
  for (const [what, magic] of MAGIC) {
    if (buf.subarray(0, magic.length).equals(magic)) return what;
  }
  // A byte-order mark means text in a known encoding, including the UTF-16
  // ones whose ASCII characters are full of NUL bytes.
  if (BOMS.some((bom) => buf.subarray(0, bom.length).equals(bom))) return null;
  // Otherwise a NUL in the opening bytes is a reliable tell: no byte-oriented
  // text encoding of HTML contains one.
  if (buf.subarray(0, 1024).includes(0)) return "binary data";
  return null;
}

// Decode archived bytes to a string, resolving the character encoding the way
// browsers do: a byte-order mark wins, then the charset the server declared in
// its Content-Type, then a <meta charset> in the document's own opening bytes,
// and UTF-8 when nothing says otherwise. An unknown or unsupported label falls
// back rather than failing the page.
//
// Getting this from the HTTP header is a small advantage of reading the archive
// directly: the header is the most authoritative source, and a live browser
// loading the same page is the only other thing that ever sees it.
function decodeHtml(bytes: Buffer, declared: string): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return bytes.subarray(3).toString("utf8");
  }
  // TextDecoder strips the BOM itself for the UTF-16 labels.
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return decode(bytes, "utf-16le") ?? bytes.toString("utf8");
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return decode(bytes, "utf-16be") ?? bytes.toString("utf8");
  }

  // <meta charset=...> or <meta http-equiv=content-type content="...charset=...">
  // must appear early to count; browsers only scan the opening bytes.
  const head = bytes.subarray(0, 2048).toString("latin1");
  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_:.-]+)/i.exec(head)?.[1];

  for (const label of [declared, meta]) {
    if (!label) continue;
    const text = decode(bytes, label);
    if (text !== null) return text;
  }
  return bytes.toString("utf8");
}

// TextDecoder covers the legacy encodings (windows-125x, shift_jis, gb18030,
// ...) on any Node built with full ICU, which the official builds are. It
// throws on a label it doesn't know, which is the signal to try the next one.
function decode(bytes: Buffer, label: string): string | null {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return null;
  }
}

// A 14-digit WARC timestamp as an ISO 8601 instant. Returns null rather than
// guessing if it isn't the shape we expect.
function isoTimestamp(ts: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

// YAML 1.2 is a superset of JSON, so a JSON string literal is always a valid
// (and correctly escaped) double-quoted YAML scalar.
function yamlValue(v: string | number): string {
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

function frontMatterBlock(fields: Record<string, string | number | null | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${yamlValue(v as string | number)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

// Defuddle's result, narrowed to the fields we use. Its own types are looser
// than this (most fields are optional strings) and it is still pre-1.0, so we
// treat everything as possibly-absent rather than trusting the shape.
interface Article {
  title?: string | null;
  author?: string | null;
  published?: string | null;
  description?: string | null;
  content?: string | null;
  wordCount?: number | null;
  site?: string | null;
}

// Parse one page's archived HTML into a Markdown document. Throws when there is
// no article to write, so the caller can report it as a failed page instead of
// leaving an empty file behind.
async function toMarkdown(
  { bytes, charset }: { bytes: Buffer; charset: string },
  job: PageJob,
  frontMatter: boolean
): Promise<string> {
  const binary = notHtml(bytes);
  if (binary) throw new Error(`not HTML: looks like ${binary}`);

  const { document } = parseHTML(decodeHtml(bytes, charset), { location: job.url });
  const article = (await Defuddle(document, job.url, { markdown: true })) as Article;

  const content = (article.content || "").trim();
  if (!content) {
    throw new Error("no article content found (page may build its content in JavaScript)");
  }

  const title = article.title || job.title || "";
  if (!frontMatter) return `${content}\n`;

  return (
    frontMatterBlock({
      title,
      url: job.url,
      archived: isoTimestamp(job.timestamp),
      author: article.author,
      published: article.published,
      description: article.description,
      site: article.site,
      words: article.wordCount ?? undefined,
    }) + `${content}\n`
  );
}

// Convert each job's archived HTML to a Markdown file. Browser-free, so this
// runs on its own without the replay server.
export async function markdownPages(
  waczPath: string,
  jobs: PageJob[],
  { outDir, total, onProgress, frontMatter = true }: MarkdownArgs
): Promise<PageResult[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const zip = openZip(waczPath);
  const digestIndex = digestIndexer(zip);

  const results: PageResult[] = [];
  try {
    for (const job of jobs) {
      const file = path.join(outDir, urlToFilename(job.url, job.index, "md"));
      const base = { ...job, file, via: "markdown" as const, total: total ?? jobs.length };
      let result: PageResult;
      try {
        const payload = readJobPayload(zip, job, digestIndex);
        fs.writeFileSync(file, await toMarkdown(payload, job, frontMatter));
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
