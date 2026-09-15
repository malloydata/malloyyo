import { writeFileSync } from "node:fs";
import { dashboardAppHtml, callDashboardApp, dashboardAppResource, dashboardAppTool } from "../../src/lib/mcp-app";
const out = process.argv[2];
writeFileSync(out + "/app.html", dashboardAppHtml());
const result = callDashboardApp({ dashboard: "anagram", input: "retinas", dictionary: "enable" });
writeFileSync(out + "/tool-result.json", JSON.stringify(result, null, 2));
console.log("resource:", JSON.stringify(dashboardAppResource(), null, 2));
console.log("tool _meta:", JSON.stringify(dashboardAppTool("[lloydtest]")._meta));
console.log("tool result:", JSON.stringify(result, null, 2));
