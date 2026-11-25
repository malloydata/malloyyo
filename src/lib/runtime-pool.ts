// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Pools of live runtime entries, one pool per model version (RuntimePool), and
// the process-wide map of them (PoolRegistry). ./malloy.ts builds the entries;
// everything about queueing, deadlines and eviction lives here, free of Malloy
// and the logger, so it can be tested on its own (runtime-pool.test.ts).
//
// The invariant every path keeps: a caller who is waiting — for an entry in a
// pool, or for room for a new pool — is always settled: served, handed a build
// of their own, or rejected with a reason. Before this module, three paths
// broke it and the caller waited until the platform killed the request:
//
//   - a pool drained (LRU-evicted) while saturated: release() closed the
//     returned entry and never looked at the queue;
//   - a build that failed while others were queued: the slot was given back,
//     but nobody started a build for the queue;
//   - a lease that never came back (a stuck warehouse query): nothing timed out.

export type Poolable = { cleanup(): Promise<void> };

/** A wait gave up: the query did not run. The message is written for the person who asked. */
export class PoolWaitTimeoutError extends Error {
  readonly code = "pool-wait-timeout";
  constructor(message: string) {
    super(message);
    this.name = "PoolWaitTimeoutError";
  }
}

/** setTimeout/clearTimeout, injectable so tests can see which deadlines are live. */
export type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // A server shutting down should not wait out a queued request's deadline.
    t.unref?.();
    return t;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type RuntimePoolOptions = {
  /** Names the pool in errors when the caller gives no dataset (the pool key). */
  name: string;
  /** How long acquire() may wait for a free entry before rejecting. */
  waitMs: number;
  /** Called whenever the pool stops being busy (see busy()). */
  onIdle?: () => void;
  timers?: Timers;
};

type Waiter<T> = {
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
  timer: unknown;
};

export class RuntimePool<E extends Poolable> {
  private idle: E[] = [];
  private size = 0; // built or building entries: idle + leased + in flight
  private waiters: Array<Waiter<E>> = [];
  private draining = false;
  private readonly timers: Timers;

  constructor(
    private readonly factory: () => Promise<E>,
    private readonly max: number,
    private readonly opts: RuntimePoolOptions,
  ) {
    this.timers = opts.timers ?? realTimers;
  }

  /** Lease an entry. `dataset` names what the caller is querying, in the timeout error. */
  async acquire(dataset?: string): Promise<E> {
    const reused = this.idle.pop();
    if (reused) return reused;
    if (this.size < this.max) return this.build();
    const ahead = this.waiters.length;
    return new Promise<E>((resolve, reject) => {
      const waiter: Waiter<E> = {
        resolve,
        reject,
        timer: this.timers.set(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new PoolWaitTimeoutError(this.timeoutMessage(dataset, ahead)));
        }, this.opts.waitMs),
      };
      this.waiters.push(waiter);
    });
  }

  release(entry: E): void {
    // The queue comes first, draining or not: a waiter already holds this pool
    // and has nowhere else to be served from.
    const waiter = this.takeWaiter();
    if (waiter) {
      waiter.resolve(entry);
      return;
    }
    if (this.draining) {
      this.size--;
      void entry.cleanup().catch(() => {});
    } else {
      this.idle.push(entry);
    }
    this.notifyIfIdle();
  }

  /**
   * Leased, building or queued for: evicting it now would close connections
   * someone is using and drop the compiled models they are about to need.
   */
  busy(): boolean {
    return this.size > this.idle.length || this.waiters.length > 0;
  }

  // Close every connection we can reach. Idle entries close now; leased ones
  // close on release once nobody is queued for them.
  async drain(): Promise<void> {
    this.draining = true;
    const idle = this.idle.splice(0);
    this.size -= idle.length;
    await Promise.all(idle.map((e) => e.cleanup().catch(() => {})));
  }

  /** For tests and logs. */
  stats(): { size: number; idle: number; waiting: number; draining: boolean } {
    return { size: this.size, idle: this.idle.length, waiting: this.waiters.length, draining: this.draining };
  }

  private async build(): Promise<E> {
    this.size++;
    try {
      return await this.factory();
    } catch (err) {
      this.size--;
      // The slot this build held is free again: whoever is queued gets a build
      // of their own (and, if that fails too, the error a direct caller sees).
      this.pump();
      this.notifyIfIdle();
      throw err;
    }
  }

  private pump(): void {
    while (this.size < this.max) {
      const waiter = this.takeWaiter();
      if (!waiter) return;
      this.build().then(waiter.resolve, waiter.reject);
    }
  }

  private takeWaiter(): Waiter<E> | undefined {
    const waiter = this.waiters.shift();
    if (waiter) this.timers.clear(waiter.timer);
    return waiter;
  }

  private notifyIfIdle(): void {
    if (!this.busy()) this.opts.onIdle?.();
  }

  private timeoutMessage(dataset: string | undefined, ahead: number): string {
    const what = dataset ? `dataset '${dataset}'` : `model version ${this.opts.name}`;
    const queue = ahead > 0 ? `, with ${ahead} ${ahead === 1 ? "query" : "queries"} ahead of it` : "";
    return (
      `Query on ${what} waited ${seconds(this.opts.waitMs)}s for a free connection and did not run: ` +
      `all ${this.max} connections were busy${queue}. Try again shortly, or raise ` +
      `"poolSize" in the model's malloy-config.json if this keeps happening.`
    );
  }
}

export type PoolRegistryOptions = {
  /** Idle pools kept warm. Past this, the least recently used IDLE pool closes. */
  keepIdle: number;
  /**
   * Pools that may exist at once, busy or not: the bound on open connections
   * (about maxPools × poolSize). A request for a new pool past it waits for one
   * to go idle, under the same deadline as a busy pool.
   */
  maxPools: number;
  waitMs: number;
  onDrainError?: (err: unknown) => void;
  timers?: Timers;
};

/**
 * Every model version's pool, keyed by the caller (malloy.ts: model version id
 * plus finalized givens). A busy pool is never evicted — draining it would close
 * connections in use and drop the compiled models its waiters are about to
 * need — so idle pools go first, least recently used first, and when every pool
 * is busy a new one waits for room rather than growing the process without
 * bound.
 */
export class PoolRegistry<E extends Poolable> {
  private pools = new Map<string, RuntimePool<E>>();
  private roomWaiters: Array<Waiter<void>> = [];
  private readonly timers: Timers;

  constructor(private readonly opts: PoolRegistryOptions) {
    this.timers = opts.timers ?? realTimers;
  }

  /**
   * The pool for `key`, creating it with `create` if needed. `create` receives
   * the callback the new pool must call when it goes idle (RuntimePoolOptions.onIdle).
   */
  async get(
    key: string,
    create: (onIdle: () => void) => RuntimePool<E>,
    dataset?: string,
  ): Promise<RuntimePool<E>> {
    const started = Date.now();
    for (;;) {
      const existing = this.pools.get(key);
      if (existing) {
        // LRU bump: re-insert as most recently used.
        this.pools.delete(key);
        this.pools.set(key, existing);
        return existing;
      }
      if (this.pools.size < this.opts.maxPools || this.evictOne(null)) break;
      await this.waitForRoom(this.opts.waitMs - (Date.now() - started), dataset);
    }
    const pool = create(() => this.poolWentIdle());
    this.pools.set(key, pool);
    this.trim(key);
    // Anyone waiting for this same key can have it now.
    this.wakeRoomWaiters();
    return pool;
  }

  /** For tests and logs. */
  stats(): { pools: number; busy: number; waitingForRoom: number } {
    let busy = 0;
    for (const p of this.pools.values()) if (p.busy()) busy++;
    return { pools: this.pools.size, busy, waitingForRoom: this.roomWaiters.length };
  }

  /** Close idle pools, least recently used first, until at most keepIdle remain. */
  private trim(keep: string | null): void {
    for (const [key, pool] of this.pools) {
      if (this.pools.size <= this.opts.keepIdle) return;
      if (key === keep || pool.busy()) continue;
      this.close(key, pool);
    }
  }

  /** Close the least recently used idle pool, if any. */
  private evictOne(keep: string | null): boolean {
    for (const [key, pool] of this.pools) {
      if (key === keep || pool.busy()) continue;
      this.close(key, pool);
      return true;
    }
    return false;
  }

  private close(key: string, pool: RuntimePool<E>): void {
    this.pools.delete(key);
    void pool.drain().catch((err) => this.opts.onDrainError?.(err));
  }

  private poolWentIdle(): void {
    this.trim(null);
    this.wakeRoomWaiters();
  }

  /**
   * Every waiter re-checks: the first takes the room an idle pool leaves, one
   * waiting for a key that now exists takes that pool, and the rest wait again
   * under what is left of their deadline. Waking just one could strand a
   * waiter whose key appeared while it slept.
   */
  private wakeRoomWaiters(): void {
    for (const waiter of this.roomWaiters.splice(0)) {
      this.timers.clear(waiter.timer);
      waiter.resolve();
    }
  }

  private waitForRoom(remainingMs: number, dataset: string | undefined): Promise<void> {
    if (remainingMs <= 0) return Promise.reject(new PoolWaitTimeoutError(this.roomMessage(dataset)));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter<void> = {
        resolve,
        reject,
        timer: this.timers.set(() => {
          const i = this.roomWaiters.indexOf(waiter);
          if (i >= 0) this.roomWaiters.splice(i, 1);
          reject(new PoolWaitTimeoutError(this.roomMessage(dataset)));
        }, remainingMs),
      };
      this.roomWaiters.push(waiter);
    });
  }

  private roomMessage(dataset: string | undefined): string {
    const what = dataset ? `dataset '${dataset}'` : "a dataset";
    return (
      `Query on ${what} waited ${seconds(this.opts.waitMs)}s for the server to open its connections and did ` +
      `not run: ${this.opts.maxPools} other datasets were busy. Try again shortly, or raise ` +
      `MALLOYYO_MAX_POOLS on the server if this keeps happening.`
    );
  }
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

function positiveNumber(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The wait limit, from MALLOYYO_QUEUE_WAIT_SECONDS (default 120). */
export function queueWaitMs(env: Record<string, string | undefined> = process.env): number {
  const n = positiveNumber(env.MALLOYYO_QUEUE_WAIT_SECONDS);
  return n !== undefined ? Math.round(n * 1000) : 120_000;
}

/** The hard cap on pools, from MALLOYYO_MAX_POOLS (default 64, never below `keepIdle`). */
export function maxPools(keepIdle: number, env: Record<string, string | undefined> = process.env): number {
  const n = positiveNumber(env.MALLOYYO_MAX_POOLS);
  return Math.max(keepIdle, n !== undefined ? Math.floor(n) : 64);
}
