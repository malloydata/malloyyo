// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import Link from "next/link";
import { db, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";

export default async function AdminUsersPage() {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/");
    throw err;
  }
  if (!isAdmin(me)) redirect("/");

  const rows = await db.select().from(users).orderBy(desc(users.createdAt));

  return (
    <main className="mx-auto max-w-3xl px-6 py-16 font-mono text-sm space-y-8">
      <header>
        <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">← all datasets</Link>
        <h1 className="text-xl font-bold mt-3">Users</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{rows.length} user{rows.length !== 1 ? "s" : ""}</p>
      </header>

      <div className="border border-gray-200 dark:border-gray-800 rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-900 text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
              <th className="px-4 py-2 font-medium">name</th>
              <th className="px-4 py-2 font-medium">email</th>
              <th className="px-4 py-2 font-medium">slug</th>
              <th className="px-4 py-2 font-medium">admin</th>
              <th className="px-4 py-2 font-medium">joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows.map((u) => (
              <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                <td className="px-4 py-2">{u.name ?? <span className="text-gray-400">—</span>}</td>
                <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{u.email ?? <span className="text-gray-400">—</span>}</td>
                <td className="px-4 py-2 text-gray-500">{u.slug ?? <span className="text-gray-400">—</span>}</td>
                <td className="px-4 py-2">{u.isAdmin ? <span className="text-green-700 dark:text-green-400">yes</span> : <span className="text-gray-400">no</span>}</td>
                <td className="px-4 py-2 text-gray-400">{u.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
