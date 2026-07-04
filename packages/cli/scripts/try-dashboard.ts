// Throwaway verify harness: run the babynames over_represented query with a few
// given combinations and print the ranked names, to prove givens drive filters
// through the same run() path the dashboard bridge uses.
//   node --import tsx scripts/try-dashboard.ts <rootDir>
import { makeRunner } from "../src/host.js";

const root = process.argv[2] ?? "../../examples/babynames";

async function main() {
  const runner = await makeRunner(root);
  console.log("entry exists:", runner.entryExists(), "root:", runner.root);

  for (const givens of [
    { STATE: "CA", DECADE: 1980 },
    { STATE: "TX", DECADE: 1980 },
    { STATE: "CA", DECADE: 1990 },
  ]) {
    const res = await runner.run("over_represented", givens);
    console.log("\n== givens:", JSON.stringify(givens), "ok:", res.ok, "==");
    if (!res.ok) {
      console.log("problems:", JSON.stringify(res.problems, null, 2));
      continue;
    }
    for (const r of res.rows as Array<Record<string, unknown>>) {
      console.log(
        `  ${String(r.name).padEnd(8)} idx=${Number(r.pct_in_state).toFixed(2)}` +
          `  state=${r.state_births} nat=${r.national_births}`,
      );
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
