// The static bundle's landing page: plain React, no Malloy, no query — which is
// exactly why it must not be treated as an orphaned component.
export default function Landing({ dashboards = [] }) {
  return <ul>{dashboards.map((d) => <li key={d.name}>{d.title}</li>)}</ul>;
}
