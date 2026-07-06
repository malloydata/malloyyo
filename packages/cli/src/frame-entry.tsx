// @ts-nocheck
// Browser entry for the SANDBOXED dashboard iframe, bundled on demand by the
// dashboard dev server. All behavior lives in ./frame-runtime (shared with the
// hosted app's vendor bundle); this file just mounts the artifact's component.
// `virtual:dashboard` is aliased by the dev server to the dashboard's
// Dashboard.tsx — or to the runtime's DefaultDashboard when the `# artifact`
// tag ships no component.
import Dashboard from "virtual:dashboard";
import { mountDashboard } from "./frame-runtime/index";

mountDashboard(Dashboard);
