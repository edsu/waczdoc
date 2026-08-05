import { chromium, type Page, type BrowserContext } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { urlToFilename } from "./util.js";
import type { Page as WaczPage } from "./wacz.js";

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

export interface RenderResult extends WaczPage {
  file: string;
  ok: boolean;
  error?: string;
  index: number;
  total?: number;
}

interface Cfg {
  outDir: string;
  timeout: number;
  settleMs: number;
  singlePage: boolean;
  pdfBase: PdfOptions;
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

// Render one page in the given tab and return a result record. Pure per-page
// work — no shared state — so tabs can run these concurrently.
async function renderOne(
  page: Page,
  origin: string,
  p: WaczPage,
  index: number,
  cfg: Cfg
): Promise<RenderResult> {
  const { outDir, timeout, settleMs, singlePage, pdfBase, inject } = cfg;
  const file = path.join(outDir, urlToFilename(p.url, index));
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
    if (frame) {
      await frame.waitForLoadState("networkidle", { timeout }).catch(() => {});
    }
    await page.waitForTimeout(settleMs);

    const notFound = frame
      ? await frame
          .evaluate(() =>
            /Archived Page Not Found/i.test(document.body?.innerText || "")
          )
          .catch(() => false)
      : true;
    if (notFound) {
      return { ...p, file, ok: false, error: "not found in archive during replay", index };
    }

    // Run the user's injection script inside the replayed page, before
    // measuring/printing — e.g. to remove modal overlays or unlock scrolling.
    // Wrapped in an async IIFE and run via Playwright's evaluation channel,
    // which is not subject to the archived page's CSP. Best-effort: a failing
    // script must not fail the render.
    if (inject && frame) {
      await frame
        .evaluate(`(async () => { ${inject}\n})()`)
        .catch(() => {});
      await page.waitForTimeout(150); // let any reflow settle
    }

    // Grow the iframe to its content height so the whole page prints.
    const height = frame
      ? await frame
          .evaluate(() =>
            Math.max(
              document.body ? document.body.scrollHeight : 0,
              document.documentElement ? document.documentElement.scrollHeight : 0
            )
          )
          .catch(() => 0)
      : 0;
    if (height) {
      await page.evaluate((h) => {
        (document.getElementById("replay") as HTMLElement).style.height = h + "px";
      }, height);
    }

    if (singlePage && height) {
      await page.pdf({
        ...pdfBase,
        path: file,
        width: `${VIEWPORT_WIDTH}px`,
        height: `${height + 8}px`,
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
      });
    } else {
      await page.pdf({
        ...pdfBase,
        path: file,
        margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" },
      });
    }
    return { ...p, file, ok: true, index };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...p, file, ok: false, error: message, index };
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

export interface RenderArgs {
  origin: string;
  outDir: string;
  opts?: RenderOptions;
  onProgress?: (r: RenderResult) => void;
}

export async function renderPages(
  pages: WaczPage[],
  { origin, outDir, opts = {}, onProgress }: RenderArgs
): Promise<RenderResult[]> {
  const {
    format = "Letter",
    landscape = false,
    screenMedia = true,
    timeout = 30000,
    scale = 1,
    background = true,
    settleMs = 700,
    singlePage = false,
    concurrency = 1,
    inject,
  } = opts;

  const workers = Math.max(1, Math.min(concurrency, pages.length));
  fs.mkdirSync(outDir, { recursive: true });

  const cfg: Cfg = {
    outDir,
    timeout,
    settleMs,
    singlePage,
    inject,
    pdfBase: {
      format: format as PdfOptions["format"],
      landscape,
      scale,
      printBackground: background,
    },
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: 1024 },
    deviceScaleFactor: 2,
  });

  const results: RenderResult[] = new Array(pages.length);
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
        const r = await renderOne(page, origin, pages[i], i, cfg);
        r.total = pages.length;
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

// Sensible default worker count when the user asks to parallelize without a
// specific number: leave a couple of cores for the OS and the SW/Node process.
export function defaultConcurrency(): number {
  return Math.max(1, (os.cpus()?.length || 4) - 2);
}
