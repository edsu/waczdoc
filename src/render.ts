import { chromium, type Page, type Frame, type BrowserContext } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { urlToFilename } from "./util.js";
import type { PageJob, PageResult } from "./wacz.js";

const COLL = "coll";
const VIEWPORT_WIDTH = 1280;

type PdfOptions = NonNullable<Parameters<Page["pdf"]>[0]>;

export interface RenderOptions {
  format?: string;
  landscape?: boolean;
  screenMedia?: boolean;
  timeout?: number;
  scale?: number;
  background?: boolean;
  settleMs?: number;
  singlePage?: boolean;
  concurrency?: number;
  inject?: string;
}

export type RenderResult = PageResult;

// Everything a capture needs: the replayed page's frame, plus the tab it lives
// in (for whole-tab operations like printing) and where to write.
export interface CaptureContext {
  page: Page;
  frame: Frame;
  job: PageJob;
  file: string;
  origin: string;
  opts: RenderOptions;
}

// The part that differs per output format. Runs after the replayed page has
// loaded, settled, and had any --inject script applied.
export type Capture = (ctx: CaptureContext) => Promise<void>;

interface Cfg {
  outDir: string;
  ext: string;
  timeout: number;
  settleMs: number;
  capture: Capture;
  via: PageResult["via"];
  opts: RenderOptions;
  inject?: string;
}

// Loose view of the helpers we inject on the page in server.ts's INDEX_HTML.
type LoaderWindow = { __loadColl(name: string, sourceUrl: string): Promise<unknown> };

// Build a wabac replay URL. "mp_" requests the page in full rewrite mode; the
// content is loaded inside an iframe so wabac serves it as replay content
// rather than its top-frame replay UI. When we have a capture timestamp we
// pin to it, otherwise "2" lets wabac pick the closest.
function replayUrl(origin: string, ts: string, url: string): string {
  return `${origin}/w/${COLL}/${ts || "2"}mp_/${url}`;
}

// Grow the iframe to its content height so the whole page prints, and report
// the height so the caller can size a single-page PDF.
async function fitToContent(page: Page, frame: Frame): Promise<number> {
  const height = await frame
    .evaluate(() =>
      Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      )
    )
    .catch(() => 0);
  if (height) {
    await page.evaluate((h) => {
      (document.getElementById("replay") as HTMLElement).style.height = h + "px";
    }, height);
  }
  return height;
}

// Print the replayed page. Sized to its content with --single-page, otherwise
// paginated onto the chosen paper.
export const capturePdf: Capture = async ({ page, frame, file, opts }) => {
  const height = await fitToContent(page, frame);
  const base: PdfOptions = {
    format: opts.format as PdfOptions["format"],
    landscape: !!opts.landscape,
    scale: opts.scale ?? 1,
    printBackground: opts.background ?? true,
  };
  if (opts.singlePage && height) {
    await page.pdf({
      ...base,
      path: file,
      width: `${VIEWPORT_WIDTH}px`,
      height: `${height + 8}px`,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  } else {
    await page.pdf({
      ...base,
      path: file,
      margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" },
    });
  }
};

// Load one page in the given tab, settle it, and hand it to the capture.
async function replayOne(page: Page, origin: string, p: PageJob, cfg: Cfg): Promise<PageResult> {
  const { outDir, ext, timeout, settleMs, capture, via, opts, inject } = cfg;
  const file = path.join(outDir, urlToFilename(p.url, p.index, ext));
  const base = { ...p, file, via };
  const target = replayUrl(origin, p.timestamp, p.url);
  try {
    // Point the iframe at the replay URL and wait for its load event OR the
    // timeout, whichever comes first, so a hung page can't stall its worker.
    await page.evaluate(
      ({ src, ms }) =>
        new Promise<void>((resolve) => {
          const f = document.getElementById("replay") as HTMLIFrameElement;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          f.onload = finish;
          setTimeout(finish, ms);
          f.src = src;
        }),
      { src: target, ms: timeout }
    );

    const frame = page
      .frames()
      .find((f) => f.name() === "replay" || /\/w\/coll\//.test(f.url()));
    if (!frame) return { ...base, ok: false, error: "replay frame never appeared" };

    await frame.waitForLoadState("networkidle", { timeout }).catch(() => {});
    await page.waitForTimeout(settleMs);

    const notFound = await frame
      .evaluate(() => /Archived Page Not Found/i.test(document.body?.innerText || ""))
      .catch(() => false);
    if (notFound) return { ...base, ok: false, error: "not found in archive during replay" };

    // Run the user's injection script inside the replayed page, before
    // capturing -- e.g. to remove modal overlays or unlock scrolling. Wrapped
    // in an async IIFE and run via Playwright's evaluation channel, which is
    // not subject to the archived page's CSP. Best-effort: a failing script
    // must not fail the capture.
    if (inject) {
      await frame.evaluate(`(async () => { ${inject}\n})()`).catch(() => {});
      await page.waitForTimeout(150); // let any reflow settle
    }

    await capture({ page, frame, job: p, file, origin, opts });
    return { ...base, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, ok: false, error: message };
  }
}

// Open a tab, ensure it's controlled by the wabac service worker, and set up
// screen-media emulation. The collection is already loaded in the shared SW,
// so new tabs don't reload it.
async function openTab(
  context: BrowserContext,
  origin: string,
  screenMedia: boolean
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "load" });
  if (screenMedia) await page.emulateMedia({ media: "screen" });
  return page;
}

export interface ReplayArgs {
  origin: string;
  outDir: string;
  // Output file extension, and how to produce each file.
  ext: string;
  capture: Capture;
  via: PageResult["via"];
  opts?: RenderOptions;
  // Overall job count, for progress display across passes.
  total?: number;
  onProgress?: (r: PageResult) => void;
}

// Drive a pool of tabs over the given pages, replaying each one and handing it
// to `capture`. Everything up to the capture -- the server, the service worker,
// the tab pool, load/settle waiting, injection -- is shared by every output.
export async function replayPages(
  pages: PageJob[],
  { origin, outDir, ext, capture, via, opts = {}, total, onProgress }: ReplayArgs
): Promise<PageResult[]> {
  const {
    screenMedia = true,
    timeout = 30000,
    settleMs = 700,
    concurrency = 1,
    inject,
  } = opts;

  const workers = Math.max(1, Math.min(concurrency, pages.length));
  fs.mkdirSync(outDir, { recursive: true });

  const cfg: Cfg = { outDir, ext, timeout, settleMs, capture, via, opts, inject };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: 1024 },
    deviceScaleFactor: 2,
  });

  const results: PageResult[] = new Array(pages.length);
  try {
    // First tab registers the SW and loads the WACZ into it (paid once).
    const first = await context.newPage();
    await first.goto(`${origin}/`, { waitUntil: "load", timeout });
    await first.evaluate(
      ([name, src]) => (window as unknown as LoaderWindow).__loadColl(name, src),
      [COLL, `${origin}/archive.wacz`]
    );
    if (screenMedia) await first.emulateMedia({ media: "screen" });

    // Remaining tabs reuse the collection already loaded in the shared SW.
    const tabs: Page[] = [first];
    for (let w = 1; w < workers; w++) {
      tabs.push(await openTab(context, origin, screenMedia));
    }

    // Worker pool: each tab pulls the next index off a shared cursor.
    let cursor = 0;
    const runWorker = async (page: Page): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= pages.length) return;
        const r = await replayOne(page, origin, pages[i], cfg);
        r.total = total ?? pages.length;
        results[i] = r;
        if (onProgress) onProgress(r);
      }
    };
    await Promise.all(tabs.map((t) => runWorker(t)));
  } finally {
    await context.close();
    await browser.close();
  }
  return results;
}

export interface RenderArgs {
  origin: string;
  outDir: string;
  opts?: RenderOptions;
  total?: number;
  onProgress?: (r: RenderResult) => void;
}

// Render each page to PDF.
export function renderPages(
  pages: PageJob[],
  { origin, outDir, opts = {}, total, onProgress }: RenderArgs
): Promise<RenderResult[]> {
  return replayPages(pages, {
    origin,
    outDir,
    ext: "pdf",
    capture: capturePdf,
    via: "render",
    opts,
    total,
    onProgress,
  });
}

// Sensible default worker count when the user asks to parallelize without a
// specific number: leave a couple of cores for the OS and the SW/Node process.
export function defaultConcurrency(): number {
  return Math.max(1, (os.cpus()?.length || 4) - 2);
}
