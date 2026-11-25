// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { PoolWaitTimeoutError, RuntimePool, queueWaitMs } from "./runtime-pool";

type Entry = { id: number; cleanup: () => Promise<void>; cleaned: boolean };

function entries() {
  let n = 0;
  return async (): Promise<Entry> => {
    const e: Entry = {
      id: ++n,
      cleaned: false,
      cleanup: async () => {
        e.cleaned = true;
      },
    };
    return e;
  };
}

/** Settled within `ms`, or "HUNG". The three hang tests below were HUNG before runtime-pool.ts. */
function settle<T>(p: Promise<T>, ms = 500): Promise<"resolved" | "rejected" | "HUNG"> {
  return Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"HUNG">((r) => setTimeout(() => r("HUNG"), ms)),
  ]);
}

const opts = { name: "v1", waitMs: 60_000 };

test("a waiter on a pool drained while saturated is served by the next release", async () => {
  const pool = new RuntimePool(entries(), 2, opts);
  const a = await pool.acquire();
  const b = await pool.acquire();
  const third = pool.acquire();
  await pool.drain();
  pool.release(a);
  pool.release(b);
  assert.equal(await settle(third), "resolved");
  // The entry with no one waiting for it was closed, not kept.
  assert.equal(b.cleaned, true);
  assert.equal(a.cleaned, false, "handed to the waiter, not closed");
});

test("a waiter queued behind a failing build gets a build of its own", async () => {
  let fail = true;
  const make = entries();
  const pool = new RuntimePool(
    async () => {
      await new Promise((r) => setTimeout(r, 10));
      if (fail) {
        fail = false;
        throw new Error("connect failed");
      }
      return make();
    },
    1,
    opts,
  );
  const first = pool.acquire();
  const second = pool.acquire();
  assert.equal(await settle(first), "rejected");
  assert.equal(await settle(second), "resolved");
  assert.equal(pool.stats().size, 1, "no slot leaked by the failure");
});

test("a waiter behind a lease that never returns times out with the reason", async () => {
  const pool = new RuntimePool(entries(), 2, { name: "v1", waitMs: 100 });
  await pool.acquire();
  await pool.acquire(); // two stuck queries
  const ahead = pool.acquire("sales/orders").catch((err: unknown) => err);
  const mine = pool.acquire("sales/orders");
  await assert.rejects(mine, (err: unknown) => {
    assert.ok(err instanceof PoolWaitTimeoutError);
    assert.equal(err.code, "pool-wait-timeout");
    assert.match(err.message, /^Query on dataset 'sales\/orders' waited 0\.1s for a free connection and did not run/);
    assert.match(err.message, /all 2 connections were busy, with 1 query ahead of it/);
    return true;
  });
  assert.ok((await ahead) instanceof PoolWaitTimeoutError);
  assert.equal(pool.stats().waiting, 0, "timed-out waiters leave the queue");
});

test("without a dataset name the error names the model version", async () => {
  const pool = new RuntimePool(entries(), 1, { name: "model-123", waitMs: 20 });
  await pool.acquire();
  await assert.rejects(pool.acquire(), /Query on model version model-123 waited/);
});

test("waiters are served first in, first out", async () => {
  const pool = new RuntimePool(entries(), 1, opts);
  const held = await pool.acquire();
  const order: string[] = [];
  const w1 = pool.acquire().then((e) => {
    order.push("w1");
    return e;
  });
  const w2 = pool.acquire().then((e) => {
    order.push("w2");
    return e;
  });
  pool.release(held);
  pool.release(await w1);
  await w2;
  assert.deepEqual(order, ["w1", "w2"]);
});

test("a served waiter's deadline is cleared", async () => {
  const pool = new RuntimePool(entries(), 1, { name: "v1", waitMs: 30 });
  const held = await pool.acquire();
  const waiting = pool.acquire();
  pool.release(held);
  await waiting;
  await new Promise((r) => setTimeout(r, 60));
  // Had the timer fired, the promise above would have rejected first; this
  // just proves nothing threw late and the entry is still leased once.
  assert.deepEqual(pool.stats(), { size: 1, idle: 0, waiting: 0, draining: false });
});

test("busy() is true while anything is leased, building or queued", async () => {
  const pool = new RuntimePool(entries(), 1, opts);
  assert.equal(pool.busy(), false);
  const e = await pool.acquire();
  assert.equal(pool.busy(), true);
  const waiting = pool.acquire();
  pool.release(e);
  pool.release(await waiting);
  assert.equal(pool.busy(), false);
});

test("queueWaitMs reads MALLOYYO_QUEUE_WAIT_SECONDS, defaulting to 120s", () => {
  assert.equal(queueWaitMs({}), 120_000);
  assert.equal(queueWaitMs({ MALLOYYO_QUEUE_WAIT_SECONDS: "30" }), 30_000);
  assert.equal(queueWaitMs({ MALLOYYO_QUEUE_WAIT_SECONDS: "0" }), 120_000);
  assert.equal(queueWaitMs({ MALLOYYO_QUEUE_WAIT_SECONDS: "nope" }), 120_000);
});
