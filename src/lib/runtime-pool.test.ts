// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { PoolRegistry, PoolWaitTimeoutError, RuntimePool, maxPools, queueWaitMs } from "./runtime-pool";

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

/** Timers that never fire on their own, and say which are still pending. */
function fakeTimers() {
  const live = new Map<number, () => void>();
  let next = 0;
  return {
    live,
    timers: {
      set: (fn: () => void) => {
        live.set(++next, fn);
        return next;
      },
      clear: (h: unknown) => {
        live.delete(h as number);
      },
    },
    fireAll() {
      for (const [h, fn] of [...live]) {
        live.delete(h);
        fn();
      }
    },
  };
}

test("a served waiter's deadline is cleared, not left to fire", async () => {
  const t = fakeTimers();
  const pool = new RuntimePool(entries(), 1, { name: "v1", waitMs: 60_000, timers: t.timers });
  const held = await pool.acquire();
  const waiting = pool.acquire();
  assert.equal(t.live.size, 1, "the waiter has a deadline");
  pool.release(held);
  await waiting;
  assert.equal(t.live.size, 0, "serving it cancelled the deadline");
});

test("onIdle fires when the last lease comes back, and not before", async () => {
  let idle = 0;
  const pool = new RuntimePool(entries(), 2, { ...opts, onIdle: () => idle++ });
  const a = await pool.acquire();
  const b = await pool.acquire();
  pool.release(a);
  assert.equal(idle, 0, "one still leased");
  pool.release(b);
  assert.equal(idle, 1);
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

test("maxPools reads MALLOYYO_MAX_POOLS, defaulting to 64 and never below keepIdle", () => {
  assert.equal(maxPools(16, {}), 64);
  assert.equal(maxPools(16, { MALLOYYO_MAX_POOLS: "200" }), 200);
  assert.equal(maxPools(16, { MALLOYYO_MAX_POOLS: "4" }), 16);
});

// ── PoolRegistry: which pools go, and what waits ─────────────────────────────

/** A registry whose pools are plain RuntimePools over cheap entries. */
function registry(keepIdle: number, max: number, waitMs = 60_000) {
  const reg = new PoolRegistry<Entry>({ keepIdle, maxPools: max, waitMs });
  const make = (key: string) => (onIdle: () => void) =>
    new RuntimePool(entries(), 2, { name: key, waitMs, onIdle });
  return { reg, get: (key: string, dataset?: string) => reg.get(key, make(key), dataset) };
}

test("the registry hands back the same pool for a key", async () => {
  const { get } = registry(4, 8);
  assert.equal(await get("a"), await get("a"));
});

test("past keepIdle, idle pools close least recently used first; busy ones never", async () => {
  const { reg, get } = registry(2, 8);
  const a = await get("a");
  const leased = await a.acquire(); // a is busy
  await get("b");
  await get("c"); // over keepIdle: b is the oldest IDLE pool
  assert.equal(reg.stats().pools, 2);
  assert.equal(await get("a"), a, "the busy pool survived");
  assert.equal(a.stats().draining, false);
  a.release(leased);
});

test("at maxPools with every pool busy, a new pool waits for one to go idle", async () => {
  const { reg, get } = registry(1, 2);
  const a = await get("a");
  const la = await a.acquire(); // busy before b arrives, or b's arrival closes it
  const b = await get("b");
  const lb = await b.acquire();
  const c = get("c");
  assert.equal(await settle(c, 50), "HUNG", "no room yet");
  assert.equal(reg.stats().waitingForRoom, 1);
  a.release(la); // a goes idle: it is closed, and c gets its place
  assert.equal(await settle(c), "resolved");
  assert.equal(a.stats().draining, true);
  assert.deepEqual(reg.stats(), { pools: 2, busy: 1, waitingForRoom: 0 });
  b.release(lb);
});

test("waiting for room has a deadline whose error says the query did not run", async () => {
  const { get } = registry(1, 1, 50);
  const a = await get("a");
  const held = await a.acquire();
  await assert.rejects(get("b", "sales/orders"), (err: unknown) => {
    assert.ok(err instanceof PoolWaitTimeoutError);
    assert.match(err.message, /^Query on dataset 'sales\/orders' waited 0\.1s for the server to open its connections and did not run: 1 other datasets were busy/);
    return true;
  });
  a.release(held);
});

test("two requests waiting for the same new key get one pool, not two", async () => {
  const { reg, get } = registry(1, 1);
  const a = await get("a");
  const held = await a.acquire();
  const c1 = get("c");
  const c2 = get("c");
  a.release(held);
  const [p1, p2] = await Promise.all([c1, c2]);
  assert.equal(p1, p2);
  assert.equal(reg.stats().pools, 1);
});
