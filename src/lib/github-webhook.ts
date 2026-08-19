// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Signature verification for GitHub's push webhook.
//
// Lives here rather than in the route because a Next.js route module may only
// export request handlers — and because this is the kind of code that should be
// tested directly rather than through an HTTP handler.

import crypto from "node:crypto";

/** Verify GitHub's `X-Hub-Signature-256` over the RAW request body.

    GitHub signs each delivery with HMAC-SHA256 using the secret configured on
    the webhook and sends `sha256=<hex>`. The signature covers the exact bytes
    it sent, so the caller must pass the raw text — parsing and re-stringifying
    changes them and nothing will ever match.

    **Enforced only when `GITHUB_WEBHOOK_SECRET` is set.** Without it this
    returns true and the dataset UUID in the URL remains the only secret. That
    is weak — URLs leak through logs, proxies, and shoulders — but the impact is
    bounded to forcing a refresh from the repo an admin already configured, and
    failing closed by default would silently break every webhook already
    registered in GitHub. Set the var here and the same value on the webhook to
    turn it on. */
export function verifyGitHubSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || secret.trim() === "") return true; // not configured — see above
  if (!header) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // length of a hex digest is not a secret.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
