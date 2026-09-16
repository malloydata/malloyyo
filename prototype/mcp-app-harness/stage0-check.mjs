// Two runs of the same document:
//  1. a sandboxed opaque-origin iframe WITHOUT a CSP  -> does it assemble?
//  2. the same, plus a CSP that forbids eval          -> does it survive a
//     sandbox like the one an MCP App gets, where 'unsafe-eval' cannot be asked for
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const html = readFileSync("../stage0/panel.html", "utf8");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

for (const [label, csp] of [
  ["no CSP        ", null],
  ["no unsafe-eval", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"],
]) {
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message).slice(0, 120)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 120)); });
  const doc = csp
    ? html.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
    : html;
  await page.setContent(doc, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const text = (await page.locator("#root").innerText().catch(() => "")).replace(/\n/g, " | ").slice(0, 120);
  console.log(`${label}  ->  ${text || "(empty)"}`);
  if (errs.length) console.log(`                  errors: ${errs.slice(0, 2).join(" ;; ")}`);
  await page.close();
}
await browser.close();
