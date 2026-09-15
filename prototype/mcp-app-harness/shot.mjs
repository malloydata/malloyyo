import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 760, height: 420 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
await page.goto("http://127.0.0.1:4181/", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
console.log("host events:", await page.evaluate(() => (window.__events || []).join(" | ")));
for (const f of page.frames()) {
  if (f === page.mainFrame()) continue;
  console.log("panel text:", JSON.stringify(await f.locator("body").innerText().catch(() => "")));
}
await page.screenshot({ path: process.argv[2] });
console.log("errors:", errors.length ? errors : "none");
await browser.close();
