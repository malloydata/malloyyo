// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { TreeDataset } from "@/lib/dashboard-tree";

/**
 * The dashboard menu's contents, cached so opening it is instant.
 *
 * `GET /api/dashboards?tree=1` returns about 4KB and takes ~2s against a remote
 * database, because its cost is round trips rather than work: authentication
 * alone is most of it (an Auth.js database session, then the per-request user
 * re-read that makes revocation instant), and the listing adds three more. None
 * of that is the menu's to fix, and all of it was being paid on every single
 * open — the fetch was gated on `open` with no memory, so the second open of
 * the same page waited exactly as long as the first.
 *
 * So: cache it, serve the cached copy the instant the menu opens, and refresh
 * behind the reader. A menu of dataset and dashboard names is about the most
 * staleness-tolerant thing in the app — a dashboard published ten seconds ago
 * showing up ten seconds late costs nobody anything, and the revalidation makes
 * even that self-correcting.
 *
 * ## Why this cache is in memory and not in `sessionStorage`
 *
 * Deliberate, and please don't "fix" it. The tree is a list of every dataset a
 * particular reader may see, so it is per-user data. `sessionStorage` is keyed
 * by origin and tab, NOT by user, and it outlives a sign-out — so on a shared
 * machine, signing out and signing in as someone else would paint the previous
 * reader's dataset names into the new one's menu for as long as the
 * revalidation took. Module scope cannot do that: it dies with the page.
 *
 * What is left is one uncached open per full page load, and the idle prewarm
 * below is what covers that: by the time anyone reaches for the menu, the
 * request has usually already finished.
 */

const FRESH_MS = 30_000;

/** Module scope, so it survives a component remount and every client-side
    navigation between dashboards — which is how this menu is actually used —
    while still dying with the page. See the note above. */
let cached: TreeDataset[] | null = null;
let cachedAt = 0;
/** The in-flight request, shared: a prewarm and an open landing together, or
    two navs mounted at once, must not become two requests. */
let inFlight: Promise<TreeDataset[]> | null = null;

/**
 * Everyone currently showing the tree, notified whenever the cache changes.
 *
 * This exists because the obvious version is subtly broken, and broken in the
 * COMMON case. Seeding `useState(cached)` reads the cache once, on the mounting
 * render — but the prewarm below fills it a moment LATER, so a component that
 * mounted on an empty cache holds `null` while the cache holds the tree. The
 * freshness check then sees a perfectly good cache and skips the fetch, and the
 * menu reads "loading…" forever with the data sitting right there. The better
 * the prewarm worked, the more reliably it happened.
 *
 * So the cache pushes, rather than being polled at render time: one place
 * writes it, and everyone showing it hears about it.
 */
const subscribers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

/** The snapshot React compares between renders. `cached` is REPLACED on every
    fill, never mutated, so identity equality is the right check and a reader
    re-renders exactly when the tree actually changed. */
function snapshot(): TreeDataset[] | null {
  return cached;
}

/** Nothing on the server, and nothing cached on the client's first render
    either — so hydration matches instead of warning. */
function serverSnapshot(): TreeDataset[] | null {
  return null;
}

function publish(rows: TreeDataset[]) {
  cached = rows;
  cachedAt = Date.now();
  for (const notify of subscribers) notify();
}

async function fetchTree(): Promise<TreeDataset[]> {
  const res = await fetch("/api/dashboards?tree=1");
  if (!res.ok) throw new Error(String(res.status));
  const rows = await res.json();
  return Array.isArray(rows) ? (rows as TreeDataset[]) : [];
}

function load(): Promise<TreeDataset[]> {
  if (inFlight) return inFlight;
  inFlight = fetchTree()
    .then((rows) => {
      publish(rows);
      return rows;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Fetch it now if nothing has, without anybody waiting. Called on mount from
    an idle callback: a dashboard page must not wait on a menu nobody clicked
    (the reason this was lazy to begin with), but it has idle time afterwards
    and the menu is the thing most likely to be clicked next. */
function prewarm() {
  if (cached || inFlight) return;
  void load().catch(() => {
    /* A prewarm that fails is silent: nothing is on screen to tell, and
       opening the menu retries. */
  });
}

export function useDashboardTree(open: boolean): {
  tree: TreeDataset[] | null;
  failed: boolean;
  /** Clears the last attempt's failure — the menu's open handler is also its
      retry, so one blip must not latch "couldn't load" onto the page. */
  clearFailure: () => void;
} {
  // Read straight from the module cache, not copied into state.
  //
  // `useSyncExternalStore` rather than `useState` + an effect, because the cache
  // IS an external store and the copy is where the bug lived: state seeded on
  // the mounting render missed the prewarm that filled the cache a moment
  // later, so the menu sat on "loading…" with the tree already in hand. A
  // snapshot read cannot go stale that way — there is no gap between "the cache
  // has it" and "this component knows".
  const tree = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const idle = window.requestIdleCallback;
    if (idle) {
      // The timeout matters: `requestIdleCallback` on a page that never goes
      // idle would otherwise never fire, and the prewarm's whole point is the
      // open that comes a second later.
      const handle = idle(() => prewarm(), { timeout: 2000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    // Safari has no requestIdleCallback.
    const t = window.setTimeout(prewarm, 500);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    // The cached copy is already on screen — the subscription above put it
    // there. Refresh only if it has had time to go stale; reopening the same
    // menu twice in a row is not a reason to hit the database again.
    if (cached && Date.now() - cachedAt < FRESH_MS) return;
    let live = true;
    load()
      // No setTree here: `publish` notifies every subscriber, this one
      // included. Setting it again from the caller is how the two paths drift.
      .catch(() => {
        // A failed REVALIDATION behind a tree already on screen is not a
        // failure the reader needs: the names they are looking at are still
        // the right names. Only report it when there is nothing to show.
        if (live && !cached) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [open]);

  return { tree, failed, clearFailure: () => setFailed(false) };
}
