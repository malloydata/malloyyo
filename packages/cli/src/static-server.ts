// A plain static file server, used to preview a bundle locally.
//
// Deliberately sends no COOP/COEP: GitHub Pages cannot set them, so neither do
// we — otherwise a local preview would silently get the multithreaded DuckDB
// build that production can never have, and "works on my machine" would mean
// something different from usual.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  // Must be exact: instantiateStreaming rejects anything else, and the failure
  // shows up as a hang rather than an error.
  ".wasm": "application/wasm",
  ".parquet": "application/octet-stream",
  ".svg": "image/svg+xml",
};

/** Serve the bundle exactly as a static host would. Deliberately sends no
    COOP/COEP: GitHub Pages cannot set them, so neither do we — otherwise local
    testing would silently get the multithreaded DuckDB build that production
    can never have. Range support is here because DuckDB-WASM uses it for any
    remote file that isn't pre-registered. */
export function serveStatic(dir: string, port: number): Promise<void> {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = path.join(dir, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(dir)) return void res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return void res.writeHead(404).end("not found");

    const st = fs.statSync(file);
    const type = MIME[path.extname(file)] ?? "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m?.[1] ? Number(m[1]) : 0;
      const end = m?.[2] ? Number(m[2]) : st.size - 1;
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      return void fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  });
  // Walk forward on EADDRINUSE. A preview server that dies because a stale copy
  // of itself still holds the port is pure friction — the point is to look at
  // the site, not to administer ports.
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (p: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < 10) {
          attempt++;
          tryPort(p + 1);
          return;
        }
        reject(err);
      });
      server.listen(p, () => {
        if (p !== port) console.log(`\n(port ${port} busy — using ${p})`);
        console.log(`\nserving ${path.basename(dir)}/ on http://localhost:${p}  (ctrl-c to stop)`);
        resolve();
      });
    };
    tryPort(port);
  });
}
