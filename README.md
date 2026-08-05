# wacz-pdf

Render the HTML pages inside a [WACZ](https://specs.webrecorder.net/wacz/1.1.1/)
web archive to PDF files — one PDF per page.

It finds pages by scanning the archive's **CDX index** for `text/html` captures
(status `200`), then replays each page through
[wabac.js](https://github.com/webrecorder/wabac.js) — Webrecorder's own replay
engine — running as a service worker inside headless Chromium, so subresources
(CSS, JS, images, fonts) are served from the archive and the page renders
faithfully. Each replayed page is then printed with `page.pdf()`.

## Install

```sh
npm install
npx playwright install chromium
```

## Usage

```sh
# Render every HTML page in the archive to ./pdfs/
node src/cli.js archive.wacz -o pdfs

# Just list the HTML pages found (no rendering)
node src/cli.js archive.wacz --list

# A4, landscape, print stylesheet, first 10 pages only
node src/cli.js archive.wacz -o pdfs --format A4 --landscape --print-media --limit 10
```

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
| `--list` | List the HTML pages found, don't render |
| `--limit <n>` | Render at most `n` pages |
| `--inject <js>` | Run JS in each page before printing; `@file` reads from a file (repeatable) |

URL filters use JavaScript regex syntax, matched case-insensitively against the
full URL. `--include` is applied before `--exclude`. Example: only article
pages, minus tag listings — `--include '/\\d{4}/' --exclude '/tag/'`.

## How it works

```
WACZ ─► read CDX index (HTML 200s)           src/wacz.js
     ─► serve sw.js + WACZ (HTTP Range)       src/server.js
     ─► headless Chromium + wabac service worker
        └─ replay each page in an <iframe> ─► page.pdf()   src/render.js
```

Replay content is loaded inside an iframe rather than the top frame: wabac
serves iframe requests as rewritten replay content, whereas a top-frame
navigation returns its interactive replay UI instead.

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

Notes:
- The script runs in the replayed page's own context (the iframe), via
  Playwright's evaluation channel, so it works even when the archived page sets
  a restrictive Content-Security-Policy.
- It's best-effort: a script that throws logs nothing and does not fail the
  page's render, so write defensively (e.g. optional chaining).

## Development

The source is TypeScript under `src/`, compiled to `dist/` with `tsc`.

```sh
npm run build     # compile src/ -> dist/
npm run lint      # eslint
npm test          # build, then unit + end-to-end (renders a fixture to PDF)
npm run test:unit # build, then unit only (no browser needed)
```

The end-to-end test needs the Playwright Chromium browser
(`npx playwright install chromium`); set `WACZ_PDF_SKIP_E2E=1` to skip it.
CI (GitHub Actions) runs lint, build, and the full test suite on push and PRs.

## Performance

Rendering is CPU-bound: each page is a real Chromium render. By default pages
render one at a time. Pass `-j <n>` (or `-j auto`) to render several in
parallel — each runs in its own tab/renderer process, so it scales roughly
linearly up to your physical core count.

All tabs share a single browser and a single wabac service worker, so the
archive's index is loaded only once no matter how many workers you use. The
trade-off at high concurrency is memory: N tabs accumulate N× the renderer
state over a long run.

## Known limitations

- JS-heavy / SPA pages may render partially if not all their requests were
  captured.
- Pages captured multiple times are deduplicated to the most recent capture.
- ZipNum-clustered CDX indexes are read whole (fine for typical archives; very
  large indexes are loaded into memory).
