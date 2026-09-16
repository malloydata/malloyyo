// Writes the app HTML + a tool result for host.mjs to serve.
import { writeFileSync } from "node:fs";
import {
  dashboardAppHtml,
  callDashboardApp,
  dashboardAppResource,
  dashboardAppTool,
} from "../../src/lib/mcp-app";

const out = process.argv[2] ?? ".";
writeFileSync(out + "/app.html", dashboardAppHtml());
writeFileSync(
  out + "/tool-result.json",
  JSON.stringify(callDashboardApp({ dashboard: "anagram", input: "retinas", dictionary: "enable" }), null, 2),
);
console.log("resource:", JSON.stringify(dashboardAppResource(), null, 2));
console.log("tool _meta:", JSON.stringify(dashboardAppTool("[LocalDev]")._meta, null, 2));
