#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { listPages, pageKind, type PageJob, type PageResult } from "./wacz.js";
import { extractPages } from "./extract.js";
import { startServer } from "./server.js";
import { renderPages, defaultConcurrency, type RenderOptions } from "./render.js";

interface Args {
  out: string;
  format: string;
  opts: RenderOptions;
  exclude: string[];
  include: string[];
  injects: string[];
  help?: boolean;
  list?: boolean;
  limit?: number;
  extract: boolean;
  input?: string;
}

function usage(): void {
  console.log(`wacz-pdf - turn the pages of a WACZ archive into PDFs

Pages come from the crawler's own page list (pages/*.jsonl), falling back to
the CDX index. Archived PDFs are copied straight out of the archive; HTML
pages are replayed in headless Chromium and printed.

Usage:
  wacz-pdf <archive.wacz> [options]

Options:
  -o, --out <dir>       Output directory (default: ./pdfs)
      --format <name>   Paper format: Letter, A4, Legal, ... (default: Letter)
      --landscape       Landscape orientation
      --single-page     One continuous page per article (no pagination)
  -j, --concurrency <n> Render n pages in parallel (default 1; "auto" = cores-2)
      --print-media     Use print CSS instead of screen CSS
      --list            Only list the pages found; do not write anything
      --limit <n>       Process at most n pages
      --no-extract      Replay archived PDFs in the browser instead of
                        copying them out (rarely what you want)
      --exclude <re>    Skip pages whose URL matches this regex (repeatable)
      --include <re>    Keep only pages whose URL matches this regex (repeatable)
      --inject <js>     Run JS in each page before printing; use @file to read
                        from a file. Repeatable. (e.g. remove modal overlays)
  -h, --help            Show this help

Regexes are JavaScript syntax, matched against the full URL, case-insensitive.
Example: --exclude '\\.(png|jpe?g|gif)$' --include '/news/'

Injection runs inside the replayed page after it loads. Example: dismiss a
sign-in overlay and unlock scrolling --
  --inject "document.querySelectorAll('.modal,[role=dialog]').forEach(e=>e.remove());document.documentElement.style.overflow='auto'"
`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: "pdfs",
    format: "Letter",
    opts: {},
    exclude: [],
    include: [],
    injects: [],
    extract: true,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-o" || a === "--out") args.out = argv[++i] ?? args.out;
    else if (a === "--format") args.format = argv[++i] ?? args.format;
    else if (a === "--landscape") args.opts.landscape = true;
    else if (a === "--single-page") args.opts.singlePage = true;
    else if (a === "-j" || a === "--concurrency") {
      const v = argv[++i];
      args.opts.concurrency = v === "auto" ? defaultConcurrency() : parseInt(v ?? "", 10);
    } else if (a === "--print-media") args.opts.screenMedia = false;
    else if (a === "--list") args.list = true;
    else if (a === "--no-extract") args.extract = false;
    else if (a === "--limit") args.limit = parseInt(argv[++i] ?? "", 10);
    else if (a === "--exclude") {
      const v = argv[++i];
      if (v) args.exclude.push(v);
    } else if (a === "--include") {
      const v = argv[++i];
      if (v) args.include.push(v);
    } else if (a === "--inject") {
      const v = argv[++i];
      if (v) args.injects.push(v);
    } else rest.push(a);
  }
  args.input = rest[0];
  args.opts.format = args.format;
  return args;
}

// Compile regex strings, exiting with a clear message on a bad pattern.
function compile(patterns: string[]): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p, "i");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error: invalid regex ${JSON.stringify(p)}: ${message}`);
      process.exit(1);
    }
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    usage();
    process.exit(args.input ? 0 : 1);
  }
  if (!fs.existsSync(args.input)) {
    console.error(`Error: file not found: ${args.input}`);
    process.exit(1);
  }

  // Resolve --inject values: "@path" reads from a file, anything else is
  // treated as inline JavaScript. Combined in order into one script.
  const injectParts = args.injects.map((v) => {
    if (v.startsWith("@")) {
      const file = v.slice(1);
      if (!fs.existsSync(file)) {
        console.error(`Error: inject file not found: ${file}`);
        process.exit(1);
      }
      return fs.readFileSync(file, "utf8");
    }
    return v;
  });
  if (injectParts.length) args.opts.inject = injectParts.join("\n;\n");

  console.error(`Reading page list from ${path.basename(args.input)} ...`);
  let pages = listPages(args.input);
  const via = pages[0]?.discoveredIn === "cdx" ? "CDX index" : "pages/*.jsonl";
  console.error(`Found ${pages.length} page(s) in the archive (via ${via}).`);

  // Apply URL filters: keep pages matching any --include (if any given),
  // then drop pages matching any --exclude.
  const includes = compile(args.include);
  const excludes = compile(args.exclude);
  if (includes.length || excludes.length) {
    const before = pages.length;
    pages = pages.filter((p) => {
      if (includes.length && !includes.some((re) => re.test(p.url))) return false;
      if (excludes.some((re) => re.test(p.url))) return false;
      return true;
    });
    console.error(`Filtered to ${pages.length} page(s) (${before - pages.length} removed).`);
  }

  if (args.limit) pages = pages.slice(0, args.limit);

  if (args.list) {
    for (const p of pages) {
      console.log(
        `${p.timestamp}\t${pageKind(p)}\t${p.url}${p.title ? `\t${p.title}` : ""}`
      );
    }
    return;
  }

  // Index the whole run up front so output filenames stay in one sequence
  // whichever pass writes them.
  const jobs: PageJob[] = pages.map((p, index) => ({ ...p, index }));

  // Archived PDFs are copied out as-is; HTML is replayed and printed. Anything
  // else (Word documents, plain text, ...) is not something we can turn into a
  // meaningful PDF, so it is reported and skipped.
  const toExtract = args.extract
    ? jobs.filter((j) => pageKind(j) === "pdf" && j.locator)
    : [];
  const extractable = new Set(toExtract);
  const toRender = jobs.filter((j) => !extractable.has(j) && pageKind(j) !== "other");
  const skipped = jobs.length - toExtract.length - toRender.length;
  if (skipped) console.error(`Skipping ${skipped} page(s) that are neither HTML nor PDF.`);
  if (toExtract.length + toRender.length === 0) {
    console.error("Nothing to do.");
    return;
  }

  const width = String(jobs.length).length;
  const total = toExtract.length + toRender.length;
  // Print each page's outcome as it happens, so long runs show progress.
  const onProgress = (r: PageResult): void => {
    const n = String(r.index + 1).padStart(width, " ");
    const how = r.via === "extract" ? "copied" : "ok    ";
    if (r.ok) console.error(`  [${n}/${total}] ${how} ${path.basename(r.file)}`);
    else console.error(`  [${n}/${total}] FAIL   ${r.url}  (${r.error})`);
  };

  const results: PageResult[] = [];
  if (toExtract.length) {
    console.error(`Extracting ${toExtract.length} archived PDF(s) to ${args.out}/ ...`);
    results.push(...extractPages(args.input, toExtract, { outDir: args.out, total, onProgress }));
  }

  // The replay server and browser only start if there is HTML to print.
  if (toRender.length) {
    const server = await startServer(args.input);
    try {
      const workers = Math.max(1, args.opts.concurrency || 1);
      console.error(
        `Rendering ${toRender.length} page(s) to ${args.out}/ ` +
          `(${workers} worker${workers > 1 ? "s" : ""}) ...`
      );
      results.push(
        ...(await renderPages(toRender, {
          origin: server.origin,
          outDir: args.out,
          opts: args.opts,
          total,
          onProgress,
        }))
      );
    } finally {
      await server.close();
    }
  }

  const ok = results.filter((r) => r.ok);
  const copied = ok.filter((r) => r.via === "extract").length;
  const failed = results.length - ok.length;
  console.error(
    `\nDone: ${ok.length - copied} rendered, ${copied} copied, ${failed} failed.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
