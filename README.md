# wacz-pdf

Turn the pages inside a [WACZ](https://specs.webrecorder.net/wacz/1.1.1/)
web archive into PDF files, one PDF per page.

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

## Install

Rendering uses Playwright's Chromium, so download it once (a one-time
~150 MB fetch into Playwright's shared cache):

```sh
npx playwright install chromium
```

Then either run without installing:

```sh
npx wacz-pdf archive.wacz -o pdfs
```

or install globally for a `wacz-pdf` command on your PATH:

```sh
npm install -g wacz-pdf
wacz-pdf archive.wacz -o pdfs
```

Requires Node.js 18+.

## Usage

```sh
# Turn every page in the archive into a PDF under ./pdfs/
wacz-pdf archive.wacz -o pdfs

# Just list the pages found, with what each one is (no output written)
wacz-pdf archive.wacz --list

# Only the archived PDFs, extracted without starting a browser
wacz-pdf archive.wacz -o pdfs --include '\.pdf$'

# A4, landscape, print stylesheet, first 10 pages only
wacz-pdf archive.wacz -o pdfs --format A4 --landscape --print-media --limit 10
```

(With `npx`, prefix each command with `npx `, e.g. `npx wacz-pdf archive.wacz --list`.)

### Options

| Flag | Description |
| --- | --- |
| `-o, --out <dir>` | Output directory (default `pdfs`) |
| `--format <name>` | Paper size: `Letter`, `A4`, `Legal`, … (default `Letter`) |
| `--landscape` | Landscape orientation |
| `--single-page` | One continuous page per article, sized to content (no pagination) |
| `-j, --concurrency <n>` | Render `n` pages in parallel (default `1`; `auto` = cores − 2) |
| `--print-media` | Use print CSS instead of screen CSS (screen is the default) |
| `--include <re>` | Keep only pages whose URL matches this regex (repeatable) |
| `--exclude <re>` | Skip pages whose URL matches this regex (repeatable) |
| `--list` | List the pages found (timestamp, kind, URL, title), write nothing |
| `--limit <n>` | Process at most `n` pages |
| `--no-extract` | Replay archived PDFs in the browser instead of copying them out (rarely what you want) |
| `--inject <js>` | Run JS in each page before printing; `@file` reads from a file (repeatable) |

URL filters use JavaScript regex syntax, matched case-insensitively against the
full URL. `--include` is applied before `--exclude`. Example: only article
pages, minus tag listings: `--include '/\\d{4}/' --exclude '/tag/'`.

## How it works

```
WACZ ─► read page list + CDX                             src/wacz.ts
     ├─ PDF  ─► copy bytes out of the WARC ─► file       src/extract.ts, src/warc.ts
     └─ HTML ─► serve sw.js + WACZ (HTTP Range)          src/server.ts
                headless Chromium + wabac service worker
                └─ replay in an <iframe> ─► page.pdf()   src/render.ts
```

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
wacz-pdf archive.wacz --inject \
  "document.querySelectorAll('.modal,[role=dialog]').forEach(e=>e.remove());\
   document.documentElement.style.overflow='auto'"

# or from a file (repeatable), e.g. a reusable cleanup.js
wacz-pdf archive.wacz --inject @cleanup.js
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

## Development

The source is TypeScript under `src/`, compiled to `dist/` with `tsc`.

```sh
git clone <repo> && cd wacz-pdf
npm install
npx playwright install chromium

npm run build     # compile src/ -> dist/
npm run lint      # eslint
npm test          # build, then unit + end-to-end (renders a fixture to PDF)
npm run test:unit # build, then unit only (no browser needed)
```

Run the local build with `node dist/cli.js <archive.wacz> …` (or `npm link`
once for a global `wacz-pdf` that points at your working copy).

The end-to-end test needs the Playwright Chromium browser
(`npx playwright install chromium`); set `WACZ_PDF_SKIP_E2E=1` to skip it.
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

## Known limitations

- JS-heavy / SPA pages may render partially if not all their requests were
  captured.
- Pages captured multiple times are deduplicated to the most recent capture.
- Pages that are neither HTML nor PDF (Word documents, plain text, …) are
  reported and skipped.
- Pages the crawler recorded with a non-2xx status are dropped. Older
  `pages.jsonl` files record no status, so nothing is dropped for those.
- ZipNum-clustered CDX indexes are read whole (fine for typical archives; very
  large indexes are loaded into memory).
- A `revisit` whose original capture lives in a *different* WACZ of a
  multi-part crawl can't be resolved, and fails that page.
