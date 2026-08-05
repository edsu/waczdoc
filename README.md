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
