// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { getSettings, SETTING_DEFAULTS } from "@/lib/settings";
import { env } from "@/lib/env";
import SettingEditor from "./SettingEditor";

export const runtime = "nodejs";

export default async function AdminPage() {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) redirect("/");
    throw err;
  }
  if (!isAdmin(me)) redirect("/");

  const settings = await getSettings();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16 font-mono text-sm space-y-10">
      <header>
        <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">← all datasets</Link>
        <h1 className="text-xl font-bold mt-3">Admin · {env.INSTANCE_NAME}</h1>
      </header>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Manage</h2>
        <div className="flex gap-3">
          <Link
            href="/datasets/new/github"
            className="inline-block rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-xs"
          >
            + Add Malloy model from GitHub
          </Link>
          <Link
            href="/admin/users"
            className="inline-block rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 px-4 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-900"
          >
            users
          </Link>
        </div>
      </section>

      <section className="space-y-8">
        <SettingEditor
          field="tagline"
          label="Front-page message"
          description="Shown under the instance title on the front page. Leave blank to restore the default."
          initialValue={settings.tagline}
          defaultValue={SETTING_DEFAULTS.tagline}
        />
        <SettingEditor
          field="signinNotice"
          label="Sign-in notice"
          description="Shown next to the sign-in button for signed-out visitors. Leave blank to restore the default."
          initialValue={settings.signinNotice}
          defaultValue={SETTING_DEFAULTS.signinNotice}
        />
      </section>
    </main>
  );
}
