// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import Link from "next/link";
import { requireAdminPage } from "@/lib/admin";
import { getSettings, SETTING_DEFAULTS } from "@/lib/settings";
import SettingEditor from "./SettingEditor";

export const runtime = "nodejs";

export default async function AdminPage() {
  await requireAdminPage();

  const settings = await getSettings();

  return (
    <>
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Manage</h2>
        <div className="flex gap-3">
          <Link
            href="/datasets/new/github"
            className="inline-block rounded bg-black text-white dark:bg-white dark:text-black px-4 py-2 text-xs"
          >
            + Add Malloy model from GitHub
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
    </>
  );
}
