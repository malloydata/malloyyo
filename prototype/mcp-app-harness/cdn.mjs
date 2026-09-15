// Stands in for cdn.jsdelivr.net so the harness browser can boot DuckDB-WASM:
// this container's egress proxy denies the real CDN. Chromium is pointed here
// with --host-resolver-rules; nothing outside this harness is affected.
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
const DIST = process.env.DUCKDB_DIST ?? "node_modules/@duckdb/duckdb-wasm/dist";
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".map": "application/json" };
https
  .createServer(
    { key: fs.readFileSync(process.argv[2] + "/key.pem"), cert: fs.readFileSync(process.argv[2] + "/cert.pem") },
    (req, res) => {
      const name = path.basename(new URL(req.url, "https://x").pathname);
      const file = path.join(DIST, name);
      console.log(fs.existsSync(file) ? "200" : "404", req.url);
      if (!fs.existsSync(file)) return res.writeHead(404, { "Access-Control-Allow-Origin": "*" }).end();
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(name)] ?? "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(file).pipe(res);
    },
  )
  .listen(4182, "127.0.0.1", () => console.log("cdn https://127.0.0.1:4182"));
