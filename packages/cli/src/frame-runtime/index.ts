// @malloyyo/dashboard — the import surface a Dashboard.tsx sees. The bundlers
// alias "@malloyyo/dashboard" to this file (CLI dev server: esbuild alias;
// hosted: shimmed to window.__DASH_RUNTIME__, which IS this module bundled
// into the vendor asset). Everything here also arrives as props on the
// Dashboard component; imports are the readable form.
//
// A CUSTOM dashboard renders itself: hooks + controls + <VegaChart>, drawing
// its own visuals. It does NOT get the Malloy renderer — `Panel` /
// `CompositeDashboard` / `DefaultDashboard` are intentionally NOT exported. The
// renderer runs ONLY in the trusted page for a TAG-ONLY dashboard (no
// Dashboard.tsx), mounted with mountInPage below. "You want custom, render it
// yourself." (Importing Panel from a custom dashboard therefore fails to
// bundle — that's the signal to make it tag-only, or draw it with VegaChart.)

export {
  filters,
  runData,
  useGiven,
  useOptions,
  useQuery,
  mount,
  setHost,
  dashboardInfo,
  givenSpecs,
} from "./runtime";
export {
  Controls,
  Given,
  Select,
  Search,
  MultiSelect,
  Range,
  Checkbox,
  TimeRange,
  DEFAULT_TIME_PRESETS,
  Field,
} from "./ui";
export { VegaChart } from "./vega-chart";

import { mount, setHost } from "./runtime";
import { Controls, Given, Select, Search, MultiSelect, Range, Checkbox, TimeRange, DefaultDashboard } from "./ui";
import { VegaChart } from "./vega-chart";

const WIDGETS = { Controls, Given, Select, Search, MultiSelect, Range, Checkbox, TimeRange, VegaChart };

/** Sandboxed-iframe entry (CUSTOM dashboards): mount a Dashboard with the widget
    components in its props. A null Dashboard falls back to DefaultDashboard, but
    tag-only dashboards no longer reach the iframe — they use mountInPage. */
export function mountDashboard(Dashboard: unknown): void {
  mount(Dashboard ?? DefaultDashboard, WIDGETS);
}

/** Trusted-page entry (TAG-ONLY dashboards, NO iframe): mount DefaultDashboard —
    the Malloy renderer — directly into `root`, wired to a direct-fetch host the
    page supplies (run/navigate/syncGivens). This is how a dashboard with no
    Dashboard.tsx runs full-width, like the VSCode/Composer preview. */
export function mountInPage(opts: {
  root: HTMLElement;
  run: (req: { query?: string; malloy?: string }, givens: Record<string, unknown>) => Promise<unknown>;
  navigate: (dashboard: string, givens: Record<string, unknown>) => void;
  syncGivens: (givens: Record<string, unknown>) => void;
}): { unmount: () => void } {
  setHost({ run: opts.run, navigate: opts.navigate, syncGivens: opts.syncGivens });
  // bodyReset:false — the dashboard is one element in the app shell, so it must
  // not restyle <body> (the iframe host DOES own the whole document, so it keeps
  // the reset). Returns the React root so the caller can unmount() on teardown.
  return mount(DefaultDashboard, WIDGETS, opts.root, { bodyReset: false });
}
