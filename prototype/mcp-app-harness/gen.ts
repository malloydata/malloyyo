// Writes the app HTML + a sample tool result for host.mjs to serve.
import { writeFileSync } from "node:fs";
import { dashboardAppHtml, dashboardAppResource, dashboardAppTool } from "../../src/lib/mcp-app";

const out = process.argv[2] ?? ".";
writeFileSync(out + "/app.html", dashboardAppHtml());
// Shaped like the query tool's result: rows nested in structuredContent.
writeFileSync(
  out + "/tool-result.json",
  JSON.stringify(
    {
      content: [{ type: "text", text: "3 rows" }],
      structuredContent: {
        ok: true,
        result: {
          rows: [
            { name: "Olivia", year: 2020, births: 17535 },
            { name: "Emma", year: 2020, births: 15581 },
            { name: "Ava", year: 2020, births: 13084 },
          ],
        },
      },
    },
    null,
    2,
  ),
);
console.log("resource:", JSON.stringify(dashboardAppResource()));
console.log("tool _meta:", JSON.stringify(dashboardAppTool("[LocalDev]")._meta));
