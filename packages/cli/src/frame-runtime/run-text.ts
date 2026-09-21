/**
 * Dashboard query text → what the server should compile.
 *
 * The three shapes a dashboard may write are the three the MCP `query` tool
 * accepts, and the same text should work in both places:
 *
 *   "flights -> by_carrier"                        a run-expression
 *   "run: flights -> by_carrier"                   a run statement
 *   "source: x is flights extend {…}\nrun: x -> …" a document
 *
 * Only the first needs `run:` put in front of it. Prefixing a document made
 * `run: source: …` — a syntax error that surfaced when the page ran rather
 * than when the query was written. Text that carries a statement of its own
 * goes through untouched, so the compiler's own message comes back (a
 * document with nothing to run included).
 *
 * The keywords are matched as WHOLE statements — `run`, `source` and `query`
 * only when a colon follows, `import` only at a word end. Matching the bare
 * prefix instead meant a model with a source named `runs` or `sources` wrote
 * `runs -> { … }`, that read as a statement, no `run:` was added, and the tile
 * failed at view time (which nothing caught at save: inlineQueries looks for a
 * real `run:`).
 *
 * Its own module, free of browser imports, so it can be tested directly.
 */
const STATEMENT_RE = /(^|\n)[ \t]*(?:(?:run|source|query)[ \t]*:|import\b|##!)/;

export const asRunText = (text: string): string => (STATEMENT_RE.test(text) ? text : `run: ${text}`);
