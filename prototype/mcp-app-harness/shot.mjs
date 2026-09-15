import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // Where jsdelivr is unreachable, run cdn.mjs and set LOCAL_CDN=1 to point the
  // test browser at it instead. Harness-only, and off by default.
  args: process.env.LOCAL_CDN
    ? [
        "--no-proxy-server",
        "--host-resolver-rules=MAP cdn.jsdelivr.net 127.0.0.1:4182",
        "--ignore-certificate-errors",
      ]
    : [],
});
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto("http://127.0.0.1:4181/", { waitUntil: "networkidle" });

// The app is in a sandboxed srcdoc iframe; the dashboard is one deeper.
await page.waitForTimeout(25000);
console.log("host events:", await page.evaluate(() => (window.__events || []).join(" | ")));

const frames = page.frames().map((f) => f.url().slice(0, 90));
console.log("frames:\n  " + frames.join("\n  "));

// Did the dashboard actually render rows?
for (const f of page.frames()) {
  if (f.url().includes("anagram.html")) {
    const txt = (await f.locator("body").innerText().catch(() => "")).slice(0, 600);
    console.log("--- dashboard text ---\n" + txt);
  }
}
await page.screenshot({ path: process.argv[2], fullPage: true });
console.log("errors:", errors.length ? errors.slice(0, 10).join("\n  ") : "none");
await browser.close();
