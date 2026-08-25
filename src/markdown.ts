// Extracts the article from a replayed page as Markdown.
//
// The page is replayed exactly as it is for PDF output -- wabac's service
// worker in headless Chromium, subresources served from the archive, scripts
// executed -- and then its rendered DOM is serialized, parsed, and handed to
// defuddle, which picks the article out of the surrounding navigation and
// converts it to Markdown.
//
// Reading the rendered DOM rather than the HTML the server originally sent is
// the whole point: a page that assembles its content in JavaScript archives and
// replays correctly but has nothing in its initial HTML to read. Going through
// replay also means --inject applies here, so a paywall or sign-in overlay can
// be dismissed before the article is extracted.
//
// The cost is that this is as slow as printing: a real browser, a real page
// load, per page.
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { Defuddle } from "defuddle/node";
import { unrewriteHtml } from "./replayurl.js";
import { replayPages, type Capture, type RenderOptions } from "./render.js";
import type { PageJob, PageResult } from "./wacz.js";

export interface MarkdownOptions extends RenderOptions {
  // Write YAML front matter above the content (default true).
  frontMatter?: boolean;
}

// A 14-digit WARC timestamp as an ISO 8601 instant. Returns null rather than
// guessing if it isn't the shape we expect.
function isoTimestamp(ts: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

// Resolve character references in a metadata value.
//
// Some publishers double-encode their own <meta> tags: an archived page reads
// content="... &amp;#8220;quoted&amp;#8221; ..." which decodes, correctly, to
// the literal text "&#8220;quoted&#8221;". Faithful but unreadable, and the
// intent is obvious, so decode once more. This is close to idempotent on
// correctly-encoded input, where the first pass already leaves no references.
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  // "<" is escaped first so that only character references are resolved: a
  // value that really contains markup keeps it as text instead of having it
  // silently stripped by textContent. The full <html><body> form matters --
  // linkedom leaves document.body empty for a bare fragment.
  const safe = s.replace(/</g, "&lt;");
  return parseHTML(`<html><body>${safe}</body></html>`).document.body.textContent ?? s;
}

// YAML 1.2 is a superset of JSON, so a JSON string literal is always a valid
// (and correctly escaped) double-quoted YAML scalar.
function yamlValue(v: string | number): string {
  return typeof v === "number" ? String(v) : JSON.stringify(decodeEntities(v));
}

// pandoc reads a leading ---/--- block as document metadata, so title and
// author flow straight into its templates.
function frontMatterBlock(fields: Record<string, string | number | null | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${yamlValue(v as string | number)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

// Defuddle's result, narrowed to the fields we use. Its own types are looser
// than this and it is still pre-1.0, so treat everything as possibly-absent.
interface Article {
  title?: string | null;
  author?: string | null;
  published?: string | null;
  description?: string | null;
  content?: string | null;
  wordCount?: number | null;
  site?: string | null;
}

// Turn a serialized replayed page into a Markdown document. Exported for tests,
// which can exercise it without a browser.
export async function articleToMarkdown(
  html: string,
  job: Pick<PageJob, "url" | "timestamp" | "title">,
  frontMatter: boolean
): Promise<string> {
  const { document } = parseHTML(html, { location: job.url });
  const article = (await Defuddle(document, job.url, { markdown: true })) as Article;

  const content = (article.content || "").trim();
  if (!content) throw new Error("no article content found");

  if (!frontMatter) return `${content}\n`;
  return (
    frontMatterBlock({
      title: article.title || job.title || "",
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

// Serialize the replayed frame, undo wabac's URL rewriting so the links in the
// output are the ones the crawler saw, and write the article out.
function captureMarkdown(frontMatter: boolean): Capture {
  return async ({ frame, job, file, origin }) => {
    const html = unrewriteHtml(await frame.content(), origin);
    fs.writeFileSync(file, await articleToMarkdown(html, job, frontMatter));
  };
}

export interface MarkdownArgs {
  origin: string;
  outDir: string;
  opts?: MarkdownOptions;
  total?: number;
  onProgress?: (r: PageResult) => void;
}

export function markdownPages(
  pages: PageJob[],
  { origin, outDir, opts = {}, total, onProgress }: MarkdownArgs
): Promise<PageResult[]> {
  const { frontMatter = true, ...replay } = opts;
  return replayPages(pages, {
    origin,
    outDir,
    ext: "md",
    capture: captureMarkdown(frontMatter),
    via: "markdown",
    opts: replay,
    total,
    onProgress,
  });
}
