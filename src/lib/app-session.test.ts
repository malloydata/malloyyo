// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, getToken } from "next-auth/jwt";
import {
  mintSessionCookie,
  renewAppSessionInPlace,
  sessionCookieName,
} from "./app-session";
import type { HostedUser } from "./hosted-auth";

const SECRET = "app-session-test-secret-not-a-real-one-0123456789";
const USER: HostedUser = {
  id: "local-user-1",
  email: "member@example.test",
  name: "Example Member",
  image: "https://example.test/avatar.png",
};

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the session cookie name follows Auth.js's protocol contract", async () => {
  await withEnv({ AUTH_URL: "https://tenant.example.test", NEXTAUTH_URL: undefined }, () => {
    assert.equal(
      sessionCookieName(new Request("http://internal.test")),
      "__Secure-authjs.session-token",
    );
  });
  await withEnv({ AUTH_URL: "http://localhost:3000", NEXTAUTH_URL: undefined }, () => {
    assert.equal(sessionCookieName(new Request("https://ignored.test")), "authjs.session-token");
  });
  await withEnv({ AUTH_URL: undefined, NEXTAUTH_URL: undefined }, () => {
    assert.equal(
      sessionCookieName(new Request("http://internal.test")),
      "__Secure-authjs.session-token",
    );
    assert.equal(
      sessionCookieName(
        new Request("https://internal.test", { headers: { "x-forwarded-proto": "http" } }),
      ),
      "authjs.session-token",
    );
  });
});

test("a minted credentials token round-trips with Auth.js's exact claim shape", async () => {
  await withEnv({ AUTH_URL: "https://tenant.example.test", AUTH_SECRET: SECRET }, async () => {
    const request = new Request("https://tenant.example.test/datasets");
    const cookie = await mintSessionCookie(USER, request);
    const claims = await decode({ token: cookie.value, secret: SECRET, salt: cookie.name });

    assert.ok(claims);
    assert.deepEqual(Object.keys(claims).sort(), [
      "email",
      "exp",
      "iat",
      "jti",
      "name",
      "picture",
      "sub",
    ]);
    assert.equal(claims.sub, USER.id);
    assert.equal(claims.picture, USER.image);
    assert.equal("image" in claims, false);
    assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), 60 * 60);
  });
});

test("the session cookie name is the JWT salt", async () => {
  await withEnv({ AUTH_URL: "https://tenant.example.test", AUTH_SECRET: SECRET }, async () => {
    const cookie = await mintSessionCookie(USER, new Request("https://tenant.example.test"));
    await assert.rejects(
      decode({ token: cookie.value, secret: SECRET, salt: "authjs.session-token" }),
      /no matching decryption secret/,
    );
  });
});

test("renewal injects a decodable token and removes stale chunks", async () => {
  await withEnv({ AUTH_URL: "http://localhost:3000", AUTH_SECRET: SECRET }, async () => {
    const request = new Request("http://localhost:3000/datasets", {
      headers: {
        cookie:
          "other=kept; authjs.session-token.0=stale; authjs.session-token.1=fragments; " +
          "my_authjs.session-token.0=also-kept",
      },
    });

    const changed = await renewAppSessionInPlace(request, async () => USER);

    assert.equal(changed, true);
    const header = request.headers.get("cookie") ?? "";
    assert.match(header, /other=kept/);
    assert.match(header, /my_authjs\.session-token\.0=also-kept/);
    assert.doesNotMatch(header, /(?:^|; )authjs\.session-token\.\d+=/);
    const token = await getToken({
      req: request,
      secret: SECRET,
      cookieName: "authjs.session-token",
    });
    assert.equal(token?.sub, USER.id);
    assert.equal(token?.picture, USER.image);
  });
});

test("a request already carrying the base session cookie is untouched", async () => {
  await withEnv({ AUTH_URL: "http://localhost:3000", AUTH_SECRET: SECRET }, async () => {
    const valid = await mintSessionCookie(USER, new Request("http://localhost:3000"));
    const original = `other=kept; ${valid.name}=${valid.value}`;
    const request = new Request("http://localhost:3000/datasets", {
      headers: { cookie: original },
    });
    let calls = 0;

    const changed = await renewAppSessionInPlace(request, async () => {
      calls += 1;
      return USER;
    });

    assert.equal(changed, false);
    assert.equal(calls, 0);
    assert.equal(request.headers.get("cookie"), original);
  });
});
