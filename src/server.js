// A tiny local HTTP server that serves everything wabac.js needs to replay a
// WACZ inside Chromium:
//   /            -> a page that registers the wabac service worker
//   /sw.js       -> wabac's service worker (from @webrecorder/wabac/dist/sw.js)
//   /archive.wacz-> the WACZ file, WITH HTTP Range support (wabac reads the
//                   zip via range requests, so this is mandatory)
import http from "node:http";
import fs from "node:fs";
import { resolveWabacSw } from "./util.js";

const SW_PATH = resolveWabacSw();

const INDEX_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8"><title>wacz-pdf loader</title>
<style>
  html, body { margin: 0; padding: 0; }
  /* Replay content lives in an iframe (wabac serves iframe requests as
     rewritten content; top-frame navigations get its replay UI instead). */
  #replay { border: 0; width: 100%; display: block; }
</style>
</head>
<body>
<iframe id="replay" name="replay"></iframe>
<script>
// Register the wabac service worker at the root scope. replayPrefix=w means
// replay URLs live under /w/<coll>/<ts>mp_/<url>.
window.__swReady = navigator.serviceWorker
  .register("./sw.js?replayPrefix=w", { scope: "./" })
  .then(() => navigator.serviceWorker.ready)
  .then(async () => {
    // Ensure this page is controlled before we post messages.
    if (!navigator.serviceWorker.controller) {
      await new Promise((res) => {
        navigator.serviceWorker.addEventListener("controllerchange", res, { once: true });
      });
    }
    return true;
  });

// Load a WACZ into the SW and resolve when collAdded arrives.
window.__loadColl = function (name, sourceUrl) {
  return window.__swReady.then(
    () =>
      new Promise((resolve, reject) => {
        const onMsg = (event) => {
          const d = event.data || {};
          if (d.name && d.name !== name) return;
          if (d.msg_type === "collAdded") {
            navigator.serviceWorker.removeEventListener("message", onMsg);
            resolve(d);
          } else if (d.msg_type === "collProgress" && d.error) {
            navigator.serviceWorker.removeEventListener("message", onMsg);
            reject(new Error("wabac load error: " + d.error));
          }
        };
        navigator.serviceWorker.addEventListener("message", onMsg);
        navigator.serviceWorker.controller.postMessage({
          msg_type: "addColl",
          name: name,
          file: { sourceUrl: sourceUrl },
          skipExisting: true,
        });
      })
  );
};
</script>
</body>
</html>`;

// Parse an HTTP Range header against a known total size. Returns:
//   null                     -> no/blank range header (serve the whole file)
//   { start, end }           -> inclusive byte range to serve (206)
//   { unsatisfiable: true }  -> range can't be satisfied (416)
// Handles "bytes=a-b", open-ended "bytes=a-", and suffix "bytes=-N" (last N
// bytes) — the suffix form is what wabac uses to read the zip's
// end-of-central-directory record, so getting it right is essential.
export function parseRange(rangeHeader, total) {
  if (!rangeHeader) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!m) return null;

  let start, end;
  if (m[1] === "" && m[2] !== "") {
    const suffix = parseInt(m[2], 10);
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = m[1] ? parseInt(m[1], 10) : 0;
    end = m[2] ? parseInt(m[2], 10) : total - 1;
  }
  if (isNaN(start)) start = 0;
  if (isNaN(end) || end >= total) end = total - 1;
  if (start > end || start >= total) return { unsatisfiable: true };
  return { start, end };
}

function serveRange(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": "application/octet-stream",
    "Access-Control-Allow-Origin": "*",
  };
  const r = parseRange(req.headers.range, total);
  if (!r) {
    res.writeHead(200, { ...headers, "Content-Length": total });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  if (r.unsatisfiable) {
    res.writeHead(416, { "Content-Range": `bytes */${total}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    ...headers,
    "Content-Range": `bytes ${r.start}-${r.end}/${total}`,
    "Content-Length": r.end - r.start + 1,
  });
  fs.createReadStream(filePath, { start: r.start, end: r.end }).pipe(res);
}

// Start the server. Returns { port, origin, close() }.
export function startServer(waczPath) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }
    if (path === "/sw.js") {
      // Serve at root scope; Service-Worker-Allowed lets scope be "/".
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
      });
      fs.createReadStream(SW_PATH).pipe(res);
      return;
    }
    if (path === "/archive.wacz") {
      serveRange(req, res, waczPath);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
