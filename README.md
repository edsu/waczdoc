# waczdoc

Turn the pages inside a [WACZ](https://specs.webrecorder.net/wacz/1.1.1/)
web archive into documents — one per page, as PDF or Markdown.

```sh
waczdoc pdf       archive.wacz -o pdfs
waczdoc markdown  archive.wacz -o markdown
waczdoc list      archive.wacz
```

Markdown is the gateway to everything else: pipe it through
[pandoc](https://pandoc.org) for EPUB, DOCX, LaTeX, ODT or typeset PDF. See
[Converting further with pandoc](#converting-further-with-pandoc).

Pages come from the crawler's own page list (`pages/pages.jsonl` and
`pages/extraPages.jsonl`), falling back to the **CDX index** for archives
written without one. Each page is then handled according to what it is:

- **HTML** is replayed through
  [wabac.js](https://github.com/webrecorder/wabac.js), Webrecorder's own replay
  engine, running as a service worker inside headless Chromium, so subresources
  (CSS, JS, images, fonts) are served from the archive and the page renders
  faithfully. The replayed page is printed with `page.pdf()`.
- **PDFs are copied straight out of the archive.** An archived PDF is already a
  PDF; replaying one would only screenshot Chromium's PDF viewer. Copying the
  original bytes is lossless — text layer, fonts, vectors, bookmarks and page
  count all survive — and needs no browser at all.

That second path is not a niche case. In one government-site crawl, 758 of the
925 pages were PDFs: they extract in well under a second, against minutes of
Chromium time for a far worse result.

`waczdoc markdown` gives HTML pages a third path: their archived bytes are read
straight out of the WARC and the article is extracted with
[defuddle](https://github.com/kepano/defuddle). No replay, no browser — see
[Markdown output](#markdown-output).

## Install

The `pdf` command uses Playwright's Chromium, so download it once (a one-time
~150 MB fetch into Playwright's shared cache). `markdown` and `list` need no
browser, so you can skip this if PDF isn't what you're after:

```sh
npx playwright install chromium
```

Then either run without installing:

```sh
npx waczdoc markdown archive.wacz
```

or install globally for a `waczdoc` command on your PATH:

```sh
npm install -g waczdoc
waczdoc markdown archive.wacz
```

Requires Node.js 18+.

## Usage

Each output format is its own subcommand, so `waczdoc <command> --help` shows
only the options that apply to it:

```sh
# Turn every page in the archive into a PDF under ./pdfs/
waczdoc pdf archive.wacz

# Extract each page's article as Markdown under ./markdown/ (no browser)
waczdoc markdown archive.wacz

# Just list the pages found, with what each one is (no output written)
waczdoc list archive.wacz

# Only the archived PDFs, extracted without starting a browser
waczdoc pdf archive.wacz --include '\.pdf$'

# A4, landscape, print stylesheet, first 10 pages only
waczdoc pdf archive.wacz --format A4 --landscape --print-media --limit 10
```

(With `npx`, prefix each command with `npx `, e.g. `npx waczdoc list archive.wacz`.)

### Options

Shared by every subcommand:

| Flag | Description |
| --- | --- |
| `-o, --out <dir>` | Output directory (default `pdfs` / `markdown` per subcommand) |
| `--include <re>` | Keep only pages whose URL matches this regex (repeatable) |
| `--exclude <re>` | Skip pages whose URL matches this regex (repeatable) |
| `--limit <n>` | Process at most `n` pages |

`waczdoc pdf` only:

| Flag | Description |
| --- | --- |
| `--format <name>` | Paper size: `Letter`, `A4`, `Legal`, … (default `Letter`) |
| `--landscape` | Landscape orientation |
| `--single-page` | One continuous page per article, sized to content (no pagination) |
| `-j, --concurrency <n>` | Render `n` pages in parallel (default `1`; `auto` = cores − 2) |
| `--print-media` | Use print CSS instead of screen CSS (screen is the default) |
| `--inject <js>` | Run JS in each page before printing; `@file` reads from a file (repeatable) |
| `--no-extract` | Replay archived PDFs in the browser instead of copying them out (rarely what you want) |

`waczdoc markdown` only:

| Flag | Description |
| --- | --- |
| `--no-front-matter` | Omit the YAML front matter |

URL filters use JavaScript regex syntax, matched case-insensitively against the
full URL. `--include` is applied before `--exclude`. Example: only article
pages, minus tag listings: `--include '/\\d{4}/' --exclude '/tag/'`.

## How it works

```
WACZ ─► read page list + CDX                             src/wacz.ts
     ├─ PDF  ─► copy bytes out of the WARC ─► file       src/extract.ts, src/payload.ts
     └─ HTML ─► serve sw.js + WACZ (HTTP Range)          src/server.ts
                headless Chromium + wabac service worker
                └─ replay in an <iframe> ─► page.pdf()   src/render.ts

     waczdoc markdown:
     └─ HTML ─► bytes out of the WARC ─► linkedom        src/markdown.ts
                └─ defuddle ─► article as Markdown
```

Argument parsing turns argv into a single `Plan` object and does nothing else
(`src/cli.ts`), so the whole command surface is testable without touching an
archive or starting a browser.

The two passes share one output sequence, so filenames stay in page order no
matter which pass wrote them. The replay server and browser only start if there
is HTML to print.

Replay content is loaded inside an iframe rather than the top frame: wabac
serves iframe requests as rewritten replay content, whereas a top-frame
navigation returns its interactive replay UI instead.

### Where the page list comes from

`pages/*.jsonl` is the crawler's own record of what it treated as a page. The
CDX is a poor substitute for it: "every `text/html` 200 in the archive" also
means every iframe, ad frame and XHR-fetched fragment, and it cannot tell a PDF
the crawler navigated to from one it merely happened to fetch. So the CDX
fallback is deliberately narrower — HTML 200s only, the conservative list.

The CDX is read either way, because it is the only place that records *where*
each resource's bytes live (`filename`/`offset`/`length`). That is what makes
direct extraction possible.

### Extracting a resource

WACZ requires `archive/*.warc.gz` be **Stored** (uncompressed) inside the zip,
so a byte range in the zip is a byte range in the file, and each WARC record is
its own gzip member. One archived resource therefore costs a single ranged read
plus one gunzip, whatever the archive's size. From there `src/warc.ts` strips
the WARC and HTTP headers and returns the entity body, handling chunked
transfer-encoding, `Content-Encoding`, and `revisit` records (which hold no
payload and are resolved back to the original capture by digest).

Two details matter for correctness:

- **Cut the body at the HTTP `Content-Length`.** Otherwise the WARC record's
  4-byte separator comes along and the bytes no longer match their digest.
- **Verify before decoding.** The recorded digest covers the body as stored,
  i.e. before `Content-Encoding` is reversed.

Every extraction is checked against the digest in the CDX, so a mismatch fails
that page rather than writing a corrupt file.

### Reading the WACZ

All of this rests on a small, self-contained ZIP reader (`src/zipread.ts`) that
parses the archive's central directory and reads entries — or slices of them —
by byte range, so multi-gigabyte archives never have to be loaded whole. This
is deliberately hand-rolled rather than pulled from a library:

- There is no `wacz` package on npm. `@harvard-lil/js-wacz` is for *creating*
  and validating WACZ files, not enumerating pages to render.
- `@webrecorder/wabac` (already a dependency, for replay) exposes a
  `ZipRangeReader`, but its loaders are browser-oriented (`fetch`, `Blob`,
  `FileSystemFileHandle`) with no Node filesystem loader — using it here would
  mean writing an `fs`-backed loader anyway, i.e. re-implementing what
  `zipread.ts` already does, while coupling to an undocumented internal API.

So the reader stays local: a couple hundred lines of synchronous, dependency-
free, Zip64-aware code scoped exactly to the need.

## Injecting JavaScript

Archived pages sometimes capture a modal ("register or sign in") overlaying the
content, with the page scroll-locked behind it. The content is still in the
DOM — the overlay is just painted on top. `--inject` runs a snippet inside the
replayed page, after it loads but before it's printed, so you can clean it up:

```sh
# inline
waczdoc pdf archive.wacz --inject \
  "document.querySelectorAll('.modal,[role=dialog]').forEach(e=>e.remove());\
   document.documentElement.style.overflow='auto'"

# or from a file (repeatable), e.g. a reusable cleanup.js
waczdoc pdf archive.wacz --inject @cleanup.js
```

See `examples/dismiss-modal.js` for a starting-point script that removes a
"register / sign in to keep reading" modal and unlocks page scrolling so the
underlying article prints.

Notes:
- The script runs in the replayed page's own context (the iframe), via
  Playwright's evaluation channel, so it works even when the archived page sets
  a restrictive Content-Security-Policy.
- It's best-effort: a script that throws logs nothing and does not fail the
  page's render, so write defensively (e.g. optional chaining).

## Markdown output

`waczdoc markdown` writes one Markdown file per HTML page:

```sh
waczdoc markdown archive.wacz -o markdown
```

The archived HTML is read straight out of the WARC — the same ranged read used
to extract PDFs — parsed with [linkedom](https://github.com/WebReflection/linkedom), and
handed to [defuddle](https://github.com/kepano/defuddle), which picks the
article out of the surrounding navigation and converts it to Markdown. Each
file gets YAML front matter from the page's metadata and the capture record:

```markdown
---
title: "What Was the Nerd?"
url: "https://reallifemag.com/what-was-the-nerd/"
archived: "2023-01-05T20:20:31Z"
author: "Vicky Osterweil"
published: "2016-11-16T00:00:00+00:00"
description: "The myth of the bullied white outcast loner is helping fuel a fascist resurgence"
site: "Real Life"
words: 3531
---

Fascism is back. Nazi propaganda is appearing [on college campuses](…)
```

Use `--no-front-matter` for bare content.

No browser is involved on this path, which makes it fast: an 854-page magazine
crawl converts in 19 seconds, and a 761-page news crawl in 148 seconds, both
single-threaded. Links and image URLs are the ones the crawler saw, because
nothing goes through replay's URL rewriting.

The character encoding comes from the server's own `Content-Type`, falling back
to a `<meta charset>` and then to UTF-8. Reading the archive directly is the
only way to see that header — a browser replaying the page is the only other
thing that ever does.

The tradeoff is that this sees only what the server sent:

- **A page that builds its content in JavaScript has nothing to extract.** It
  archives and replays fine, but its HTML is an empty shell, so it is reported
  as `no article content found`. Render those to PDF instead.
- **Index and listing pages have no article.** A homepage or `/tag/` listing
  yields a near-empty file rather than an error — check `words` in the front
  matter, or filter them out with `--exclude`.
- **Non-article formats are refused, not converted.** Archives whose page list
  records no mime type are assumed to be HTML (see
  [Where the page list comes from](#where-the-page-list-comes-from)), so a
  binary file can reach the parser, which will happily turn an EPUB into
  thousands of words of mojibake. Byte signatures are checked first and those
  pages fail with `not HTML: looks like …`.

Archived PDFs are still copied out as-is, so a `markdown` output directory can
contain `.pdf` files too.

## Converting further with pandoc

Markdown is a means, not an end. [pandoc](https://pandoc.org) reads a
`---`-delimited YAML block at the top of a Markdown file as document metadata,
which is exactly what `waczdoc markdown` writes — so `title:` and `author:`
flow into pandoc's templates with no massaging:

```sh
waczdoc markdown archive.wacz -o markdown

# one article, several ways
pandoc markdown/0197_example.com_acting-my-age.md -o article.epub
pandoc markdown/0197_example.com_acting-my-age.md -o article.docx
pandoc markdown/0197_example.com_acting-my-age.md -o article.pdf   # via LaTeX

# or bind a whole crawl into one book
pandoc markdown/*.md --toc -o archive.epub
```

That last one is the reason this tool stopped being called `wacz-pdf`: once the
pages are Markdown, EPUB, ODT, LaTeX, MediaWiki, JATS and typeset PDF are all
one command away, and the LaTeX route generally sets better type than a browser
print dialog ever will.

## Development

The source is TypeScript under `src/`, compiled to `dist/` with `tsc`.

```sh
git clone <repo> && cd waczdoc
npm install
npx playwright install chromium

npm run build     # compile src/ -> dist/
npm run lint      # eslint
npm test          # build, then unit + end-to-end (renders a fixture to PDF)
npm run test:unit # build, then unit only (no browser needed)
```

Run the local build with `node dist/cli.js <command> <archive.wacz> …` (or
`npm link` once for a global `waczdoc` that points at your working copy).

The end-to-end test needs the Playwright Chromium browser
(`npx playwright install chromium`); set `WACZDOC_SKIP_E2E=1` to skip it.
CI (GitHub Actions) runs lint, build, and the full test suite on push and PRs.

## Performance

Extracting archived PDFs is essentially free — a ranged read and a gunzip per
file, no browser — so an archive that is mostly PDFs finishes in seconds.

Rendering is the expensive half, and is CPU-bound: each page is a real Chromium
render. By default pages render one at a time. Pass `-j <n>` (or `-j auto`) to render several in
parallel, where each runs in its own tab/renderer process, so it scales roughly
linearly up to your physical core count.

All tabs share a single browser and a single wabac service worker, so the
archive's index is loaded only once no matter how many workers you use. The
trade-off at high concurrency is memory: N tabs accumulate N× the renderer
state over a long run.

Markdown conversion sits between the two: no browser, but each page still has
to be parsed into a DOM. Measured at 46 pages/second on one core for the
magazine crawl and 5 pages/second for a heavier news site, so it is dominated
by page size rather than by page count.

`linkedom` rather than `jsdom` for the DOM, for two measured reasons. jsdom
retained roughly 20 MB per parsed page — enough to exhaust a default heap part
way through a 761-page archive — where linkedom stays flat. And because jsdom
implements the layout API without a layout engine, every element reports zero
size and defuddle's visibility heuristics prune content that is really there:
across 838 articles, jsdom dropped subtitles and leaked raw `<audio>` markup
into 172 files, against 5 for linkedom.

## Known limitations

- JS-heavy / SPA pages may render partially if not all their requests were
  captured, and yield no article at all under `waczdoc markdown`.
- Pages captured multiple times are deduplicated to the most recent capture.
- Pages that are neither HTML nor PDF (Word documents, plain text, …) are
  reported and skipped.
- Pages the crawler recorded with a non-2xx status are dropped. Older
  `pages.jsonl` files record no status, so nothing is dropped for those.
- ZipNum-clustered CDX indexes are read whole (fine for typical archives; very
  large indexes are loaded into memory).
- A `revisit` whose original capture lives in a *different* WACZ of a
  multi-part crawl can't be resolved, and fails that page.
