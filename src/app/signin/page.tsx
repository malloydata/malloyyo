// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { signIn } from "@/auth";
import { env } from "@/lib/env";
import { createAnonymousSession, sessionCookie } from "@/lib/anon-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only allow relative, same-origin callback paths — never an absolute URL —
// so this page can't be used as an open redirect. The web bounce (proxy.ts)
// and the MCP OAuth bounce (authorize route) both pass relative paths.
function safePath(cb: unknown): string {
  return typeof cb === "string" && cb.startsWith("/") && !cb.startsWith("//") ? cb : "/";
}

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const callbackUrl = safePath(sp.callbackUrl);
  const allowAnonymous = env.ALLOW_ANONYMOUS;

  async function googleSignIn() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl });
  }

  async function anonymousSignIn() {
    "use server";
    // Enforce the flag here — this is the real entrance. The button is hidden
    // when disabled, but guard the action too so it can't be POSTed directly.
    if (!env.ALLOW_ANONYMOUS) redirect("/signin");
    const { sessionToken, expires } = await createAnonymousSession();
    const proto = (await headers()).get("x-forwarded-proto");
    const secure = proto ? proto === "https" : env.APP_BASE_URL.startsWith("https");
    const c = sessionCookie(sessionToken, expires, secure);
    (await cookies()).set(c.name, c.value, c.options);
    redirect(callbackUrl);
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-24 font-mono text-sm">
      <h1 className="text-2xl font-bold mb-2">{env.INSTANCE_NAME}</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8 leading-relaxed">
        Sign in to explore the Malloy datasets.
      </p>

      <div className="space-y-3">
        <form action={googleSignIn}>
          <button
            type="submit"
            className="w-full rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2.5"
          >
            Sign in with Google
          </button>
        </form>

        {allowAnonymous && (
          <>
            <div className="flex items-center gap-3 text-xs text-gray-400 dark:text-gray-600">
              <span className="flex-1 border-t border-gray-200 dark:border-gray-800" />
              or
              <span className="flex-1 border-t border-gray-200 dark:border-gray-800" />
            </div>
            <form action={anonymousSignIn}>
              <button
                type="submit"
                className="w-full rounded border border-gray-300 dark:border-gray-700 px-4 py-2.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                Continue anonymously
              </button>
            </form>
            <p className="text-xs text-gray-400 dark:text-gray-600 leading-relaxed">
              You&apos;ll get a random name to track your own queries. No account,
              no email — you can sign in with Google later if you want.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
