import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { urlToFilename } from "./util.js";

const COLL = "coll";
const VIEWPORT_WIDTH = 1280;

// Build a wabac replay URL. "mp_" requests the page in full rewrite mode; the
// content is loaded inside an iframe so wabac serves it as replay content
// rather than its top-frame replay UI. When we have a capture timestamp we
// pin to it, otherwise "2" lets wabac pick the closest.
function replayUrl(origin, ts, url) {
  return `${origin}/w/${COLL}/${ts || "2"}mp_/${url}`;
}

// Render one page in the given tab and return a result record. Pure per-page
// work — no shared state — so tabs can run these concurrently.
async function renderOne(page, origin, p, index, cfg) {
  const { outDir, timeout, settleMs, singlePage, pdfBase } = cfg;
  const file = path.join(outDir, urlToFilename(p.url, index));
  const target = replayUrl(origin, p.timestamp, p.url);
  try {
    // Point the iframe at the replay URL and wait for its load event OR the
    // timeout, whichever comes first, so a hung page can't stall its worker.
    await page.evaluate(
      ({ src, ms }) =>
        new Promise((resolve) => {
          const f = document.getElementById("replay");
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
        document.getElementById("replay").style.height = h + "px";
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
    return { ...p, file, ok: false, error: err.message, index };
  }
}

// Open a tab, ensure it's controlled by the wabac service worker, and set up
// screen-media emulation. The collection is already loaded in the shared SW,
// so new tabs don't reload it.
async function openTab(context, origin, screenMedia) {
  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "load" });
  if (screenMedia) await page.emulateMedia({ media: "screen" });
  return page;
}

export async function renderPages(pages, { origin, outDir, opts = {}, onProgress }) {
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
  } = opts;

  const workers = Math.max(1, Math.min(concurrency, pages.length));
  fs.mkdirSync(outDir, { recursive: true });

  const cfg = {
    outDir,
    timeout,
    settleMs,
    singlePage,
    pdfBase: { format, landscape, scale, printBackground: background },
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: 1024 },
    deviceScaleFactor: 2,
  });

  const results = new Array(pages.length);
  try {
    // First tab registers the SW and loads the WACZ into it (paid once).
    const first = await context.newPage();
    await first.goto(`${origin}/`, { waitUntil: "load", timeout });
    await first.evaluate(
      ([name, src]) => window.__loadColl(name, src),
      [COLL, `${origin}/archive.wacz`]
    );
    if (screenMedia) await first.emulateMedia({ media: "screen" });

    // Remaining tabs reuse the collection already loaded in the shared SW.
    const tabs = [first];
    for (let w = 1; w < workers; w++) {
      tabs.push(await openTab(context, origin, screenMedia));
    }

    // Worker pool: each tab pulls the next index off a shared cursor.
    let cursor = 0;
    const runWorker = async (page) => {
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
export function defaultConcurrency() {
  return Math.max(1, (os.cpus()?.length || 4) - 2);
}
