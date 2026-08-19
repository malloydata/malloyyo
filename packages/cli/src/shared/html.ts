// Embedding JSON in an inline <script>, in ONE place.
//
// `JSON.stringify` is NOT sufficient here and the failure is not obvious: a
// script element's content is RAW TEXT terminated by the literal `</script`,
// regardless of the element's `type`. So a value containing
// `</script><script>…` closes the block and the rest is parsed as HTML —
// script execution straight out of a dashboard title, a given label, or a URL
// parameter. JSON.stringify escapes quotes and backslashes; it does not escape
// `<`. The hosted app hit exactly this (src/lib/dashboards/frame-html.ts); the
// three CLI shells emit the same document shape, so they share the same fix.
//
// Dependency-free so the Node dev server and the emitted static site can both
// use it.

/** JSON safe to inline inside a `<script>` element. Escapes `<`/`>` so the
    element cannot be terminated early, plus U+2028/U+2029 — legal raw inside a
    JSON string, but literal line terminators in JS source. Every escape is
    inside a string literal, so `JSON.parse` of the result is unchanged. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
