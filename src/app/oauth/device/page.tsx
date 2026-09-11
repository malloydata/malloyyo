// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Where a human approves a device flow (RFC 8628 §3.3). Deliberately parallel to
// /oauth/consent: same shape, same "signed in as / switch account" affordance, so
// approving a CLI looks like approving anything else.
//
// Two things here are security decisions, not styling:
//
//   1. The code field is always present and always editable, even when
//      `?user_code=` prefilled it. Device-flow phishing is someone sending you a
//      link or a code and asking you to approve it (§5.4); the defense is that
//      the person approving has to recognise the code as one THEY are looking at.
//      A page that silently approves a code from a URL removes that check.
//   2. It says plainly what is being granted and to whom, because the thing being
//      authorized is not on screen — it is a terminal somewhere else.

import { redirect } from "next/navigation";
import { getSessionUserOrNull } from "@/lib/user";
import { signInPath, signOutPath } from "@/lib/auth-paths";
import { signDeviceApproval } from "@/lib/oauth/device-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ user_code?: string; error?: string; ok?: string }>;
}

export default async function DevicePage({ searchParams }: PageProps) {
  const { user_code: userCode, error, ok } = await searchParams;

  const user = await getSessionUserOrNull();
  if (!user) {
    const back = userCode
      ? `/oauth/device?user_code=${encodeURIComponent(userCode)}`
      : "/oauth/device";
    redirect(signInPath(back));
  }

  if (ok === "approved") {
    return (
      <Screen title="Approved">
        <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
          You can close this tab. The tool that asked for access will continue on
          its own within a few seconds.
        </p>
      </Screen>
    );
  }
  if (ok === "denied") {
    return (
      <Screen title="Denied">
        <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
          Nothing was authorized. You can close this tab.
        </p>
      </Screen>
    );
  }

  // Bound to this session and verified on POST, so a cross-site form submission
  // cannot approve a code on this user's behalf. See device-csrf.ts.
  const csrf = signDeviceApproval(user.id);

  const switchUrl = signOutPath(
    signInPath(userCode ? `/oauth/device?user_code=${encodeURIComponent(userCode)}` : "/oauth/device"),
  );

  return (
    <Screen title="Authorize a device">
      <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
        A command-line tool is waiting for access to your malloyyo datasets.
        Enter the code it is showing you.
      </p>

      {error ? (
        <p className="rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error === "not_found"
            ? "That code is not valid, has expired, or was already used. Start again from your terminal."
            : error === "rate_limited"
              ? "Too many attempts. Wait a minute and try again."
              : error === "expired"
                ? "This page was open too long, or the form did not come from here. Reload and try again."
                : "Something went wrong. Start again from your terminal."}
        </p>
      ) : null}

      <form action="/api/oauth/device/decide" method="POST" className="space-y-4">
        <input type="hidden" name="t" value={csrf} />
        <label className="block space-y-1">
          <span className="text-xs text-gray-500 dark:text-gray-400">Code from your terminal</span>
          <input
            name="user_code"
            defaultValue={userCode ?? ""}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="BCDF-GHJK"
            className="w-full rounded border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 font-mono tracking-widest uppercase"
          />
        </label>

        <section className="rounded border border-gray-200 dark:border-gray-800 p-4 space-y-2 text-xs">
          <div>
            <span className="text-gray-500 dark:text-gray-400">Grants:</span> read and
            query your datasets through the MCP server, and publish models you
            authorize
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500 dark:text-gray-400">Signed in as:</span>
            <span>{user.email ?? user.name}</span>
            <a href={switchUrl} className="text-blue-600 dark:text-blue-400 underline">
              Switch account
            </a>
          </div>
        </section>

        <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
          Only approve a code you are reading off your own screen. If someone sent
          you this code or link, deny it.
        </p>

        <div className="flex gap-3">
          <button
            type="submit"
            name="action"
            value="deny"
            className="flex-1 rounded border border-gray-300 dark:border-gray-700 px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            Deny
          </button>
          <button
            type="submit"
            name="action"
            value="approve"
            className="flex-1 rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2 hover:opacity-80"
          >
            Approve
          </button>
        </div>
      </form>
    </Screen>
  );
}

function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-md px-6 py-16 font-mono text-sm space-y-6">
      <h1 className="text-xl font-bold">{title}</h1>
      {children}
    </main>
  );
}
