// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Your API tokens — the credential you paste into a CI variable or export as
// MALLOYYO_TOKEN. Not under /admin: every member has their own, and an admin
// has no business seeing anyone else's (they can't — the routes scope by the
// session's user id).

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { listApiTokens, toView } from "@/lib/api-tokens";
import { env } from "@/lib/env";
import { CreateTokenForm, RevokeTokenButton } from "./token-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TH = "px-3 py-2 font-medium";
const TD = "px-3 py-2";

function When({ iso, fallback }: { iso: string | null; fallback: string }) {
  if (!iso) return <span className="text-gray-400">{fallback}</span>;
  return <span title={iso}>{new Date(iso).toISOString().slice(0, 10)}</span>;
}

export default async function TokensPage() {
  let me;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/");
    throw err;
  }

  const tokens = (await listApiTokens(me.id)).map((t) => toView(t));

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 space-y-8 text-sm">
      <header className="space-y-2">
        <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
          ← {env.INSTANCE_NAME}
        </Link>
        <h1 className="text-lg">API tokens</h1>
        <p className="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
          A token lets the <code>malloyyo</code> command line — or a CI job — act as you on
          this instance without a browser sign-in. The CLI reads{" "}
          <code>MALLOYYO_TOKEN</code> from the environment:
        </p>
        <pre className="rounded bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 px-3 py-2 text-xs overflow-x-auto">
          export MALLOYYO_TOKEN=…{"\n"}malloyyo publish
        </pre>
        <p className="text-gray-600 dark:text-gray-400 text-xs leading-relaxed">
          A token never carries more than you do: every request re-checks your account, so
          revoking either the token or the account takes effect immediately.
          {!isAdmin(me) && " Publishing is limited to datasets you own."}
        </p>
      </header>

      <CreateTokenForm />

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Your tokens
        </h2>
        {tokens.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            No tokens yet.
          </p>
        ) : (
          <div className="border border-gray-200 dark:border-gray-800 rounded overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 dark:bg-gray-900 text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                <tr>
                  <th className={TH}>Name</th>
                  <th className={TH}>Token</th>
                  <th className={TH}>Scopes</th>
                  <th className={TH}>Created</th>
                  <th className={TH}>Expires</th>
                  <th className={TH}>Last used</th>
                  <th className={TH}></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {tokens.map((t) => (
                  <tr key={t.id} className={t.expired ? "opacity-60" : undefined}>
                    <td className={TD}>{t.name}</td>
                    <td className={`${TD} font-mono text-gray-500 dark:text-gray-400`}>
                      {t.prefix}…
                    </td>
                    <td className={TD}>{t.scopes.join(", ")}</td>
                    <td className={`${TD} text-gray-600 dark:text-gray-400`}>
                      <When iso={t.createdAt} fallback="—" />
                    </td>
                    <td className={`${TD} text-gray-600 dark:text-gray-400`}>
                      {t.expired ? (
                        <span className="text-amber-600 dark:text-amber-400">expired</span>
                      ) : (
                        <When iso={t.expiresAt} fallback="never" />
                      )}
                    </td>
                    <td className={`${TD} text-gray-600 dark:text-gray-400`}>
                      <When iso={t.lastUsedAt} fallback="never used" />
                    </td>
                    <td className={`${TD} text-right`}>
                      <RevokeTokenButton id={t.id} name={t.name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
