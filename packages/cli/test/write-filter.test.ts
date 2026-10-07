import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFilter, filterParses } from "../src/write-filter.js";

test("the server always asks: a string description that parses is still interpreted", async () => {
  let called = 0;
  const r = await writeFilter(
    { field: "state", type: "string", description: "west coast" },
    { callModel: async () => { called++; return "filter: CA, OR, WA\nnote: west coast"; } },
  );
  assert.deepEqual(r, { ok: true, text: "CA, OR, WA", note: "west coast" });
  assert.equal(called, 1);
});

test("tier 2: the model's answer is validated by the parser", async () => {
  const r = await writeFilter(
    { field: "state", type: "string", description: "west coast", values: ["CA", "OR", "WA", "NY"] },
    { callModel: async (system, user) => {
        assert.match(system, /Filter expressions/);
        assert.match(user, /west coast/);
        assert.match(user, /CA, OR, WA, NY/);
        return "filter: CA, OR, WA\nnote: the west-coast states among the values";
      } },
  );
  assert.deepEqual(r, { ok: true, text: "CA, OR, WA", note: "the west-coast states among the values" });
});

test("tier 2: an unparseable answer is a problem, not a filter", async () => {
  const r = await writeFilter(
    { field: "amount", type: "number", description: "bigger than ten" },
    { callModel: async () => "filter: amount > 10\nnote: oops" },
  );
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /doesn't parse/);
  const ok = await writeFilter(
    { field: "amount", type: "number", description: "bigger than ten" },
    { callModel: async () => "filter: > 10\nnote: greater than ten" },
  );
  assert.deepEqual(ok, { ok: true, text: "> 10", note: "greater than ten" });
});

test("tier 2: the model may decline", async () => {
  const r = await writeFilter(
    { field: "ordered_on", type: "date", description: "whenever the moon was full" },
    { callModel: async () => "filter: none\nnote: full-moon dates are not expressible" },
  );
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /full-moon/);
});

test("filterParses mirrors the frame's isValid", () => {
  assert.ok(filterParses("date", "last week"));
  assert.ok(!filterParses("date", "bigger than ten"));
  assert.ok(filterParses("boolean", "=true"));
  assert.ok(filterParses("timestamptz", "7 days"));
});
