#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { listPages, pageKind, type PageJob, type PageResult } from "./wacz.js";
import { extractPages } from "./extract.js";
import { markdownPages, type MarkdownOptions } from "./markdown.js";
import { startServer } from "./server.js";
import { renderPages, defaultConcurrency, type RenderOptions } from "./render.js";

const NAME = "waczdoc";

// Which pages to work on, independent of what we turn them into.
export interface Filters {
  include: string[];
  exclude: string[];
  limit?: number;
}

// A fully-resolved instruction: what to read, what to write, and where. Parsing
// produces one of these and nothing else, so it can be tested without running
// a browser or touching an archive.
export type Plan =
  | { mode: "list"; input: string; filters: Filters }
  | {
      mode: "pdf";
      input: string;
      out: string;
      filters: Filters;
      extract: boolean;
      render: RenderOptions;
    }
  | {
      mode: "markdown";
      input: string;
      out: string;
      filters: Filters;
      markdown: MarkdownOptions;
    };

const FILTER_HELP = `
Regexes are JavaScript syntax, matched against the full URL, case-insensitively.
--include is applied before --exclude. Example, only article pages minus tag
listings:  --include '/\\d{4}/' --exclude '/tag/'`;

// Repeatable string option.
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function positiveInt(name: string) {
  return (value: string): number => {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1) {
      throw new CommanderError(1, "invalid-argument", `error: ${name} must be a positive integer`);
    }
    return n;
  };
}

function concurrency(value: string): number {
  if (value === "auto") return defaultConcurrency();
  return positiveInt("--concurrency")(value);
}

// Options that mean the same thing whatever we are producing.
function withFilters(cmd: Command): Command {
  return cmd
    .option("--include <re>", "keep only pages whose URL matches this regex (repeatable)", collect, [])
    .option("--exclude <re>", "skip pages whose URL matches this regex (repeatable)", collect, [])
    .option("--limit <n>", "process at most n pages", positiveInt("--limit"));
}

function filtersFrom(opts: { include: string[]; exclude: string[]; limit?: number }): Filters {
  return { include: opts.include, exclude: opts.exclude, limit: opts.limit };
}

// Options belonging to the replay pass, which both outputs go through.
function withReplayOptions(cmd: Command): Command {
  return cmd
    .option(
      "-j, --concurrency <n>",
      'replay n pages in parallel ("auto" = cores-2)',
      concurrency,
      1
    )
    .option(
      "--inject <js>",
      "run JS in each page before capturing; @file reads from a file (repeatable)",
      collect,
      []
    );
}

const INJECT_HELP = `
Injection runs inside the replayed page after it loads, via Playwright's
evaluation channel, so it works even under a restrictive Content-Security-Policy.
It is best-effort: a script that throws does not fail the page. Example, dismiss
a sign-in overlay and unlock scrolling:
  --inject "document.querySelectorAll('.modal,[role=dialog]').forEach(e=>e.remove());document.documentElement.style.overflow='auto'"`;

function buildProgram(onPlan: (plan: Plan) => void, silent: boolean): Command {
  const program = new Command();
  // Both of these have to be set before the subcommands are created: commander
  // copies them to each subcommand as it is added, so setting them afterwards
  // would leave the subcommands calling process.exit() themselves.
  program.exitOverride();
  if (silent) program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .name(NAME)
    .description(
      "Turn the pages inside a WACZ web archive into documents.\n\n" +
        "Pages come from the crawler's own page list (pages/*.jsonl), falling back to\n" +
        "the CDX index."
    )
    .showHelpAfterError();

  withFilters(
    withReplayOptions(
      program
        .command("pdf")
        .description("render each page to PDF")
        .argument("<archive.wacz>", "the archive to read")
        .option("-o, --out <dir>", "output directory", "pdfs")
        .option("--format <name>", "paper size: Letter, A4, Legal, ...", "Letter")
        .option("--landscape", "landscape orientation")
        .option("--single-page", "one continuous page per article, sized to content")
        .option("--print-media", "use print CSS instead of screen CSS")
    ).option(
      "--no-extract",
      "replay archived PDFs in the browser instead of copying them out (rarely what you want)"
    )
  )
    .addHelpText("after", `${FILTER_HELP}\n${INJECT_HELP}\n`)
    .action((archive: string, opts) => {
      onPlan({
        mode: "pdf",
        input: archive,
        out: opts.out,
        filters: filtersFrom(opts),
        extract: opts.extract,
        render: {
          format: opts.format,
          landscape: !!opts.landscape,
          singlePage: !!opts.singlePage,
          concurrency: opts.concurrency,
          screenMedia: !opts.printMedia,
          inject: resolveInjects(opts.inject),
        },
      });
    });

  withFilters(
    withReplayOptions(
      program
        .command("markdown")
        .description("extract each page's article as Markdown")
        .argument("<archive.wacz>", "the archive to read")
        .option("-o, --out <dir>", "output directory", "markdown")
        .option("--no-front-matter", "omit the YAML front matter")
    )
  )
    .addHelpText(
      "after",
      `${FILTER_HELP}
${INJECT_HELP}

Pages are replayed in headless Chromium and their rendered DOM is read, so a
page that assembles its content in JavaScript is extracted correctly -- and
--inject can dismiss a paywall or sign-in overlay first. Archived PDFs are
copied out as-is rather than converted.
`
    )
    .action((archive: string, opts) => {
      onPlan({
        mode: "markdown",
        input: archive,
        out: opts.out,
        filters: filtersFrom(opts),
        markdown: {
          frontMatter: opts.frontMatter,
          concurrency: opts.concurrency,
          inject: resolveInjects(opts.inject),
        },
      });
    });

  withFilters(
    program
      .command("list")
      .description("list the pages found (timestamp, kind, URL, title); write nothing")
      .argument("<archive.wacz>", "the archive to read")
  )
    .addHelpText("after", FILTER_HELP)
    .action((archive: string, opts) => {
      onPlan({ mode: "list", input: archive, filters: filtersFrom(opts) });
    });

  return program;
}

// Resolve --inject values: "@path" reads from a file, anything else is inline
// JavaScript. Combined in order into one script.
function resolveInjects(values: string[]): string | undefined {
  if (!values.length) return undefined;
  const parts = values.map((v) => {
    if (!v.startsWith("@")) return v;
    const file = v.slice(1);
    if (!fs.existsSync(file)) {
      throw new CommanderError(1, "inject-not-found", `error: inject file not found: ${file}`);
    }
    return fs.readFileSync(file, "utf8");
  });
  return parts.join("\n;\n");
}

// Parse argv (without node/script) into a Plan. Throws CommanderError on bad
// input or when commander handled --help itself. `silent` suppresses
// commander's own output, which tests want and the CLI does not.
export function parseArgv(argv: string[], { silent = false } = {}): Plan {
  let plan: Plan | null = null;
  const program = buildProgram((p) => {
    plan = p;
  }, silent);
  program.parse(argv, { from: "user" });
  if (!plan) throw new CommanderError(1, "no-command", "error: no command given");
  return plan;
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

// Read the archive's page list and narrow it to the pages the user asked for.
function selectPages(input: string, filters: Filters): PageJob[] {
  console.error(`Reading page list from ${path.basename(input)} ...`);
  let pages = listPages(input);
  const via = pages[0]?.discoveredIn === "cdx" ? "CDX index" : "pages/*.jsonl";
  console.error(`Found ${pages.length} page(s) in the archive (via ${via}).`);

  const includes = compile(filters.include);
  const excludes = compile(filters.exclude);
  if (includes.length || excludes.length) {
    const before = pages.length;
    pages = pages.filter((p) => {
      if (includes.length && !includes.some((re) => re.test(p.url))) return false;
      if (excludes.some((re) => re.test(p.url))) return false;
      return true;
    });
    console.error(`Filtered to ${pages.length} page(s) (${before - pages.length} removed).`);
  }
  if (filters.limit) pages = pages.slice(0, filters.limit);

  // Index the whole run up front so output filenames stay in one sequence
  // whichever pass writes them.
  return pages.map((p, index) => ({ ...p, index }));
}

const LABEL = { extract: "copied", render: "ok    ", markdown: "wrote " };

// Split jobs into the ones we copy out and the ones we convert, and report what
// we are leaving alone. Anything that is neither HTML nor PDF (Word documents,
// plain text, ...) is not something we can turn into a document.
function split(jobs: PageJob[], extract: boolean) {
  const toExtract = extract ? jobs.filter((j) => pageKind(j) === "pdf" && j.locator) : [];
  const extractable = new Set(toExtract);
  const toConvert = jobs.filter((j) => !extractable.has(j) && pageKind(j) !== "other");
  const skipped = jobs.length - toExtract.length - toConvert.length;
  if (skipped) console.error(`Skipping ${skipped} page(s) that are neither HTML nor PDF.`);
  return { toExtract, toConvert, total: toExtract.length + toConvert.length };
}

// Print each page's outcome as it happens, so long runs show progress. This
// counts pages finished, not each page's index in the archive's page list --
// those differ whenever a page was skipped, and the index would then run past
// the total. The output filename still carries the index.
function progressReporter(total: number): (r: PageResult) => void {
  const width = String(total).length;
  let done = 0;
  return (r) => {
    const n = String(++done).padStart(width, " ");
    if (r.ok) console.error(`  [${n}/${total}] ${LABEL[r.via]} ${path.basename(r.file)}`);
    else console.error(`  [${n}/${total}] FAIL   ${r.url}  (${r.error})`);
  };
}

function summarize(results: PageResult[], made: string): void {
  const ok = results.filter((r) => r.ok);
  const copied = ok.filter((r) => r.via === "extract").length;
  console.error(
    `\nDone: ${ok.length - copied} ${made}, ${copied} copied, ${results.length - ok.length} failed.`
  );
}

async function run(plan: Plan): Promise<void> {
  if (!fs.existsSync(plan.input)) {
    console.error(`Error: file not found: ${plan.input}`);
    process.exit(1);
  }
  const jobs = selectPages(plan.input, plan.filters);

  if (plan.mode === "list") {
    for (const p of jobs) {
      console.log(`${p.timestamp}\t${pageKind(p)}\t${p.url}${p.title ? `\t${p.title}` : ""}`);
    }
    return;
  }

  // Markdown mode always copies archived PDFs out: a PDF's content is the PDF,
  // and there is nothing for the article parser to do with one.
  const { toExtract, toConvert, total } = split(
    jobs,
    plan.mode === "markdown" ? true : plan.extract
  );
  if (total === 0) {
    console.error("Nothing to do.");
    return;
  }

  const onProgress = progressReporter(total);
  const results: PageResult[] = [];

  if (toExtract.length) {
    console.error(`Extracting ${toExtract.length} archived PDF(s) to ${plan.out}/ ...`);
    results.push(...extractPages(plan.input, toExtract, { outDir: plan.out, total, onProgress }));
  }

  // Both outputs replay each page in a browser, so both need the server -- and
  // it only starts if there is actually HTML to work on.
  if (toConvert.length) {
    const opts = plan.mode === "markdown" ? plan.markdown : plan.render;
    const workers = Math.max(1, opts.concurrency || 1);
    const verb = plan.mode === "markdown" ? "Converting" : "Rendering";
    const server = await startServer(plan.input);
    try {
      console.error(
        `${verb} ${toConvert.length} page(s) to ${plan.out}/ ` +
          `(${workers} worker${workers > 1 ? "s" : ""}) ...`
      );
      const args = { origin: server.origin, outDir: plan.out, total, onProgress };
      results.push(
        ...(plan.mode === "markdown"
          ? await markdownPages(toConvert, { ...args, opts: plan.markdown })
          : await renderPages(toConvert, { ...args, opts: plan.render }))
      );
    } finally {
      await server.close();
    }
  }
  summarize(results, plan.mode === "markdown" ? "converted" : "rendered");
}

async function main(): Promise<void> {
  let plan: Plan;
  try {
    plan = parseArgv(process.argv.slice(2));
  } catch (e) {
    // commander has already written its message (including for --help).
    const code = e instanceof CommanderError ? e.exitCode : 1;
    if (!(e instanceof CommanderError)) console.error(e);
    process.exit(code);
  }
  await run(plan);
}

// Only run when invoked as the CLI, so tests can import parseArgv.
if (process.argv[1] && /cli\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
