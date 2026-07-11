// @malloyyo/dashboard — the import surface a Dashboard.tsx sees. The bundlers
// alias "@malloyyo/dashboard" to this file (CLI dev server: esbuild alias;
// hosted: shimmed to window.__DASH_RUNTIME__, which IS this module bundled
// into the vendor asset). Everything here also arrives as props on the
// Dashboard component; imports are the readable form.

export {
  Panel,
  filters,
  runData,
  useGiven,
  useOptions,
  useQuery,
  mount,
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
  DefaultDashboard,
} from "./ui";
export { VegaChart } from "./vega-chart";

import { mount } from "./runtime";
import { Controls, Given, Select, Search, MultiSelect, Range, Checkbox, TimeRange, DefaultDashboard } from "./ui";
import { VegaChart } from "./vega-chart";

/** Frame entry: mount a Dashboard with the widget components in its props
    (import-free dashboards keep working). */
export function mountDashboard(Dashboard: unknown): void {
  mount(Dashboard ?? DefaultDashboard, {
    Controls,
    Given,
    Select,
    Search,
    MultiSelect,
    Range,
    Checkbox,
    TimeRange,
    VegaChart,
  });
}
