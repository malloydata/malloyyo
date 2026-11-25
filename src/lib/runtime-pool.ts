// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A bounded pool of live runtime entries for ONE model version (poolFor in
// ./malloy.ts keys pools and evicts them). Kept free of Malloy and the logger
// so its queueing can be tested on its own (runtime-pool.test.ts).
//
// The invariant every path keeps: a caller queued in `waiters` is always
// settled — handed an entry, handed a build of its own, or rejected with a
// reason. Before this module, three paths broke it and the caller waited
// until the platform killed the request:
//
//   - a pool drained (LRU-evicted) while saturated: release() closed the
//     returned entry and never looked at the queue;
//   - a build that failed while others were queued: the slot was given back,
//     but nobody started a build for the queue;
//   - a lease that never came back (a stuck warehouse query): nothing timed out.
//
// Now a released entry goes to the head of the queue first (a draining pool
// only stops keeping IDLE entries), a failed build pumps the queue, and every
// wait has a deadline whose error says the query never ran.

export type Poolable = { cleanup(): Promise<void> };

/** acquire() gave up: the query did not run. The message is written for the person who asked. */
export class PoolWaitTimeoutError extends Error {
  readonly code = "pool-wait-timeout";
  constructor(message: string) {
    super(message);
    this.name = "PoolWaitTimeoutError";
  }
}

export type RuntimePoolOptions = {
  /** Names the pool in errors when the caller gives no dataset (the pool key). */
  name: string;
  /** How long acquire() may wait for a free entry before rejecting. */
  waitMs: number;
};

type Waiter<E> = {
  resolve: (e: E) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RuntimePool<E extends Poolable> {
  private idle: E[] = [];
  private size = 0; // built or building entries: idle + leased + in flight
  private waiters: Array<Waiter<E>> = [];
  private draining = false;

  constructor(
    private readonly factory: () => Promise<E>,
    private readonly max: number,
    private readonly opts: RuntimePoolOptions,
  ) {}

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
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new PoolWaitTimeoutError(this.timeoutMessage(dataset, ahead)));
        }, this.opts.waitMs),
      };
      // A server shutting down should not wait out a queued request's deadline.
      waiter.timer.unref?.();
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
      return;
    }
    this.idle.push(entry);
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
    if (waiter) clearTimeout(waiter.timer);
    return waiter;
  }

  private timeoutMessage(dataset: string | undefined, ahead: number): string {
    const what = dataset ? `dataset '${dataset}'` : `model version ${this.opts.name}`;
    const secs = Math.round(this.opts.waitMs / 100) / 10;
    const queue = ahead > 0 ? `, with ${ahead} ${ahead === 1 ? "query" : "queries"} ahead of it` : "";
    return (
      `Query on ${what} waited ${secs}s for a free connection and did not run: ` +
      `all ${this.max} connections were busy${queue}. Try again shortly, or raise ` +
      `"poolSize" in the model's malloy-config.json if this keeps happening.`
    );
  }
}

/** The wait limit, from MALLOYYO_QUEUE_WAIT_SECONDS (default 120). */
export function queueWaitMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MALLOYYO_QUEUE_WAIT_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 120_000;
}
