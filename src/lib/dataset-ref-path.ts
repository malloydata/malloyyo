// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A dataset address as ONE URL path segment.
//
// A route's `[id]` param arrives percent-encoded under `next dev` and DECODED
// on Vercel. Interpolating it raw into a URL was harmless while addresses were
// `repo:dataset`, but a branch preview's label is a git branch, and Claude
// Code's branches are `claude/<task>`: the raw `/` split the segment, so the
// frame's bundle request 404'd and the dashboard never drew — on Vercel only.
// Normalize first (decode whatever arrived), then encode, and the result is
// the same on every platform. No imports: client components use it too.

/** Decode `ref` if it is percent-encoded; a malformed escape is left alone. */
export function plainDatasetRef(ref: string): string {
  if (!ref.includes("%")) return ref;
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

/** `ref`, encoded or not, as a single path segment. */
export function datasetRefSegment(ref: string): string {
  return encodeURIComponent(plainDatasetRef(ref));
}
