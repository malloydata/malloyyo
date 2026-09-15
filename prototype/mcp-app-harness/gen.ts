// Writes the app HTML + a tool result for host.mjs to serve.
import { writeFileSync } from "node:fs";
import { helloAppHtml, callHelloApp, helloAppResource, helloAppTool } from "../../src/lib/mcp-app";

const out = process.argv[2] ?? ".";
writeFileSync(out + "/app.html", helloAppHtml());
writeFileSync(out + "/tool-result.json", JSON.stringify(callHelloApp({ message: "Hello world" }), null, 2));
console.log("resource:", JSON.stringify(helloAppResource("https://example.test"), null, 2));
console.log("tool _meta:", JSON.stringify(helloAppTool("[Staging]")._meta, null, 2));
